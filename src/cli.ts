#!/usr/bin/env node
/**
 * CLI entry point for Harpoon.
 */

import { Command } from "commander";
import { readFileSync, existsSync, mkdirSync, writeFileSync, readdirSync, rmSync } from "node:fs";
import { execSync } from "node:child_process";
import * as path from "node:path";
import * as zlib from "node:zlib";
import yaml from "js-yaml";

import { VERSION } from "./version.js";
import { ExitCode, HarpoonError } from "./errors.js";
import { loadProject } from "./project.js";
import {
  buildDag,
  validateEdgeMappings,
  validateSubworkflows,
  visualizeDag,
  visualizeDagMermaid,
} from "./dag.js";
import { run } from "./executor.js";
import type { ExecutionResult } from "./executor.js";
import {
  loadRunManifest,
  resolveInputSource,
  findLatestRun,
  resolveArtifactDirectory,
} from "./artifacts.js";
import type { RunEntry } from "./artifacts.js";
import { waitForSignalFiles, resolveSignalPath } from "./orchestration.js";
import { SignalTimeoutError } from "./orchestration.js";
import { TelemetryLevel } from "./telemetry.js";
import type { TelemetryConfig } from "./telemetry.js";
import { loadSignal } from "./artifacts.js";

// ─── Output Formatting ──────────────────────────────────────

function formatResult(
  result: ExecutionResult,
  outputFormat: string,
  showTrace: boolean,
): void {
  if (outputFormat === "json") {
    const output: Record<string, unknown> = {
      success: result.success,
      outputs: result.outputs,
    };
    if (result.error) {
      output.error = {
        node_id: result.error.nodeId,
        node_type: result.error.nodeType,
        message: result.error.message,
        cause_type: result.error.causeType,
      };
    }
    if (showTrace) {
      output.trace = {
        run_id: result.trace.runId,
        start_time: result.trace.startTime,
        end_time: result.trace.endTime,
        nodes: result.trace.nodes.map((n) => ({
          id: n.id,
          start_time: n.startTime,
          end_time: n.endTime,
          model: n.model,
          resolved_model: n.resolvedModel,
          tokens: n.tokens,
          skipped: n.skipped,
          error: n.error,
          error_type: n.errorType,
        })),
      };
    }
    process.stdout.write(JSON.stringify(output, null, 2) + "\n");
  } else if (outputFormat === "text") {
    if (!result.success) {
      process.stderr.write(`FAILED: ${result.error}\n`);
    } else if (typeof result.outputs === "object" && result.outputs !== null) {
      for (const value of Object.values(result.outputs)) {
        if (typeof value === "object" && value !== null) {
          process.stdout.write(JSON.stringify(value) + "\n");
        } else {
          process.stdout.write(String(value) + "\n");
        }
      }
    } else {
      process.stdout.write(String(result.outputs) + "\n");
    }
  } else {
    // pretty
    process.stdout.write(
      result.success ? "=== Execution Complete ===\n" : "=== Execution FAILED ===\n",
    );
    process.stdout.write("\n");

    if (showTrace || !result.success) {
      process.stdout.write("Trace:\n");
      for (const node of result.trace.nodes) {
        const status = node.error ? "FAILED" : node.skipped ? "SKIPPED" : "OK";
        const tokens =
          node.tokens && (node.tokens.input || node.tokens.output)
            ? ` (${node.tokens.input ?? 0}+${node.tokens.output ?? 0} tokens)`
            : "";
        const errorMsg = node.error ? ` - ${node.error}` : "";
        const model = node.model
          ? ` model=${node.model}${node.resolvedModel ? ` resolved=${node.resolvedModel}` : ""}`
          : "";
        process.stdout.write(`  [${status}] ${node.id}${model}${tokens}${errorMsg}\n`);
      }
      process.stdout.write("\n");
    }

    if (result.error) {
      process.stdout.write(`Error:\n  ${result.error}\n\n`);
    }

    process.stdout.write("Outputs:\n");
    process.stdout.write(JSON.stringify(result.outputs, null, 2) + "\n");
  }
}

// ─── Command Handlers ────────────────────────────────────────

function cmdVersion(): number {
  process.stdout.write(`harpoon ${VERSION}\n`);
  return ExitCode.SUCCESS;
}

function cmdProjectInit(projectPath: string, options: { template: string }): number {
  const resolved = path.resolve(projectPath);

  // Create directory if needed
  mkdirSync(resolved, { recursive: true });

  // Check if already a harpoon/trident project
  for (const existing of ["agent.tml", "harpoon.tml", "trident.tml", "trident.yaml"]) {
    if (existsSync(path.join(resolved, existing))) {
      process.stderr.write(`Error: ${resolved} already contains ${existing}\n`);
      return ExitCode.VALIDATION_ERROR;
    }
  }

  const manifestPath = path.join(resolved, "agent.tml");
  const projectName = path.basename(resolved) === "." ? path.basename(process.cwd()) : path.basename(resolved);

  const manifestContent = `harpoon: "${VERSION}"
name: ${projectName}
description: A Harpoon project

defaults:
  model: anthropic/claude-sonnet-4-20250514
  temperature: 0.7
  max_tokens: 1024

entrypoints:
  - input

nodes:
  input:
    type: input
    schema:
      text:
        type: string
        description: Input text to process

  output:
    type: output
    format: json

edges:
  e1:
    from: input
    to: example
    mapping:
      content: text

  e2:
    from: example
    to: output
    mapping:
      result: output
`;

  writeFileSync(manifestPath, manifestContent);

  // Create prompts directory and example prompt
  const promptsDir = path.join(resolved, "prompts");
  mkdirSync(promptsDir, { recursive: true });

  const examplePrompt = `---
id: example
name: Example Prompt
harpoon: "${VERSION}"
description: An example prompt that echoes input

input:
  content:
    type: string
    description: The content to process

output:
  format: json
  schema:
    result:
      type: string
      description: The processed result
    length:
      type: number
      description: Length of the input
---
You are a helpful assistant. Process the following input and return a result.

Input: {{content}}

Respond with a JSON object containing:
- result: A brief summary or echo of the input
- length: The character count of the input
`;

  writeFileSync(path.join(promptsDir, "example.prompt"), examplePrompt);

  // Create additional files for standard template
  if (options.template === "standard") {
    mkdirSync(path.join(resolved, "tools"), { recursive: true });
    mkdirSync(path.join(resolved, "schemas"), { recursive: true });

    const toolContent = `/**
 * Example tool for Harpoon.
 */
export function process(text: string): Record<string, number> {
  return {
    word_count: text.split(/\\s+/).length,
    char_count: text.length,
  };
}
`;
    writeFileSync(path.join(resolved, "tools", "example_tool.ts"), toolContent);
  }

  process.stdout.write(`Created Harpoon project at ${resolved}\n`);
  process.stdout.write(`  Template: ${options.template}\n`);
  process.stdout.write("  Manifest: agent.tml\n");
  process.stdout.write("  Prompts:  prompts/example.prompt\n");
  if (options.template === "standard") {
    process.stdout.write("  Tools:    tools/\n");
    process.stdout.write("  Schemas:  schemas/\n");
  }
  process.stdout.write("\n");
  process.stdout.write("Next steps:\n");
  process.stdout.write(`  cd ${resolved}\n`);
  process.stdout.write("  harpoon project validate\n");
  process.stdout.write("  harpoon project run --dry-run\n");

  return ExitCode.SUCCESS;
}

async function cmdProjectValidate(projectPath: string, options: { strict: boolean }): Promise<number> {
  const project = loadProject(projectPath);
  const dag = buildDag(project);

  // Validate edge mappings
  const validation = validateEdgeMappings(project, dag, options.strict);

  // Validate sub-workflows (recursive)
  const subworkflowValidation = await validateSubworkflows(project, undefined, options.strict);

  // Merge results
  const allWarnings = [...validation.warnings, ...subworkflowValidation.warnings];
  const allErrors = [...validation.errors, ...subworkflowValidation.errors];
  const allValid = validation.valid && subworkflowValidation.valid;

  process.stdout.write(`Project: ${project.name}\n`);
  process.stdout.write(`  Prompts: ${Object.keys(project.prompts).length}\n`);
  process.stdout.write(`  Tools: ${Object.keys(project.tools).length}\n`);
  process.stdout.write(`  Agents: ${Object.keys(project.agents).length}\n`);
  process.stdout.write(`  Branches: ${Object.keys(project.branches).length}\n`);
  process.stdout.write(`  Maps: ${Object.keys(project.maps).length}\n`);
  process.stdout.write(`  Edges: ${Object.keys(project.edges).length}\n`);
  process.stdout.write(`  Nodes in execution order: ${dag.executionOrder.length}\n`);
  process.stdout.write("\n");

  // Show warnings
  if (allWarnings.length > 0) {
    process.stdout.write("Warnings:\n");
    for (const warning of allWarnings) {
      const edgeInfo = warning.edgeId ? ` (edge: ${warning.edgeId})` : "";
      process.stdout.write(`  ! ${warning.message}${edgeInfo}\n`);
    }
    process.stdout.write("\n");
  }

  // In strict mode, warnings are errors
  if (options.strict && allWarnings.length > 0) {
    process.stderr.write(
      `FAILED: ${allWarnings.length} warning(s) in strict mode\n`,
    );
    return ExitCode.VALIDATION_ERROR;
  }

  if (allValid) {
    process.stdout.write("Validation passed\n");
    return ExitCode.SUCCESS;
  } else {
    process.stderr.write(`Validation failed: ${allErrors.length} error(s)\n`);
    for (const error of allErrors) {
      process.stderr.write(`  x ${error}\n`);
    }
    return ExitCode.VALIDATION_ERROR;
  }
}

function cmdProjectGraph(
  projectPath: string,
  options: { format: string; direction: string; open: boolean },
): number {
  const project = loadProject(projectPath);
  const dag = buildDag(project);

  if (options.format === "mermaid" || options.open) {
    const mermaidOutput = visualizeDagMermaid(dag, options.direction);

    if (options.open) {
      // Extract mermaid code (without ```mermaid wrapper)
      const mermaidCode = mermaidOutput
        .replace("```mermaid\n", "")
        .replace("\n```", "");

      // Encode for mermaid.live URL
      const jsonState = JSON.stringify({
        code: mermaidCode,
        mermaid: { theme: "default" },
        autoSync: true,
        updateDiagram: true,
      });
      const compressed = zlib.deflateSync(Buffer.from(jsonState, "utf-8"), {
        level: 9,
      });
      const encoded = compressed
        .toString("base64url");
      const url = `https://mermaid.live/edit#pako:${encoded}`;

      process.stdout.write("Opening diagram in browser...\n");
      process.stdout.write(`URL: ${url.slice(0, 80)}...\n`);

      // Open in browser
      // execSync imported at top level
      try {
        if (process.platform === "darwin") {
          execSync(`open "${url}"`);
        } else if (process.platform === "linux") {
          execSync(`xdg-open "${url}"`);
        } else if (process.platform === "win32") {
          execSync(`start "" "${url}"`);
        }
      } catch {
        process.stdout.write("Could not open browser. Copy the URL above.\n");
      }
    } else {
      process.stdout.write(mermaidOutput + "\n");
    }
  } else {
    process.stdout.write(visualizeDag(dag) + "\n");
  }

  return ExitCode.SUCCESS;
}

function cmdProjectRuns(projectPath: string, options: { limit: number }): number {
  const resolved = path.resolve(projectPath);
  const manifestPath = path.join(resolved, ".harpoon", "runs", "manifest.json");

  const manifest = loadRunManifest(manifestPath);

  if (manifest.runs.length === 0) {
    process.stdout.write("No runs found.\n");
    process.stdout.write(`  Run a project with: harpoon project run ${projectPath}\n`);
    return ExitCode.SUCCESS;
  }

  // Show most recent runs (reversed, limited)
  const runsToShow = [...manifest.runs].reverse().slice(0, options.limit);

  process.stdout.write(
    `Recent runs (${runsToShow.length} of ${manifest.runs.length}):\n`,
  );
  process.stdout.write("\n");

  for (const runEntry of runsToShow) {
    const statusIcons: Record<string, string> = {
      completed: "+",
      failed: "x",
      running: "~",
      interrupted: "o",
    };
    const statusIcon = statusIcons[runEntry.status] ?? "?";

    let successStr = "";
    if (runEntry.success !== undefined) {
      successStr = runEntry.success ? " (success)" : " (failed)";
    }

    process.stdout.write(`  [${statusIcon}] ${runEntry.runId.slice(0, 8)}...\n`);
    process.stdout.write(`      Status: ${runEntry.status}${successStr}\n`);
    process.stdout.write(`      Started: ${runEntry.startedAt}\n`);
    if (runEntry.endedAt) {
      process.stdout.write(`      Ended: ${runEntry.endedAt}\n`);
    }
    if (runEntry.errorSummary) {
      process.stdout.write(
        `      Error: ${runEntry.errorSummary.slice(0, 60)}...\n`,
      );
    }
    process.stdout.write("\n");
  }

  process.stdout.write(
    `Artifacts directory: ${path.join(resolved, ".harpoon", "runs")}\n`,
  );
  return ExitCode.SUCCESS;
}

async function cmdProjectRun(
  projectPath: string,
  options: {
    input?: string;
    inputFile?: string;
    inputFrom?: string;
    entrypoint?: string;
    output: string;
    trace: boolean;
    dryRun: boolean;
    verbose: boolean;
    artifacts: boolean;
    artifactDir?: string;
    runId?: string;
    resume?: string;
    startFrom?: string;
    emitSignal: boolean;
    publishTo?: string;
    waitFor?: string[];
    timeout: number;
    telemetry: boolean;
    telemetryFormat: string;
    telemetryFile?: string;
    telemetryLevel: string;
  },
): Promise<number> {
  const project = loadProject(projectPath);

  // Parse inputs (priority: --input > --input-file > --input-from)
  let inputs: Record<string, unknown> = {};
  if (options.input) {
    inputs = JSON.parse(options.input);
  } else if (options.inputFile) {
    const fileContent = readFileSync(options.inputFile, "utf-8");
    inputs = JSON.parse(fileContent);
  } else if (options.inputFrom) {
    try {
      inputs = await resolveInputSource(options.inputFrom, project.root);
      if (options.verbose) {
        process.stdout.write(`Loaded inputs from: ${options.inputFrom}\n`);
      }
    } catch (e) {
      process.stderr.write(`Error: ${e instanceof Error ? e.message : String(e)}\n`);
      return ExitCode.VALIDATION_ERROR;
    }
  }

  // Determine artifact directory
  const artifactDir = resolveArtifactDirectory(
    project.root,
    options.artifacts,
    options.artifactDir,
  );

  // Handle resume
  let resumeFrom: string | undefined;
  if (options.resume) {
    if (options.resume === "latest") {
      resumeFrom = findLatestRun(project.root);
      if (!resumeFrom) {
        process.stderr.write("Error: No previous runs found to resume\n");
        return ExitCode.VALIDATION_ERROR;
      }
      if (options.verbose) {
        process.stdout.write(`Resuming from latest run: ${resumeFrom}\n`);
      }
    } else {
      resumeFrom = options.resume;
    }
  }

  // Wait for signals if specified
  if (options.waitFor && options.waitFor.length > 0) {
    if (options.verbose) {
      process.stdout.write(`Waiting for ${options.waitFor.length} signal(s)...\n`);
    }
    try {
      await waitForSignalFiles(
        options.waitFor,
        project.root,
        options.timeout,
        5,
        options.verbose,
      );
      if (options.verbose) {
        process.stdout.write("All signals received, proceeding with execution\n");
      }
    } catch (e) {
      if (e instanceof SignalTimeoutError) {
        process.stderr.write(`Error: ${e.message}\n`);
        return ExitCode.TIMEOUT;
      }
      throw e;
    }
  }

  // Configure telemetry
  let telemetryConfig: TelemetryConfig | undefined;
  if (options.telemetry) {
    const levelMap: Record<string, TelemetryLevel> = {
      debug: TelemetryLevel.DEBUG,
      info: TelemetryLevel.INFO,
      warning: TelemetryLevel.WARNING,
      error: TelemetryLevel.ERROR,
    };
    const telemetryLevel = levelMap[options.telemetryLevel] ?? TelemetryLevel.INFO;

    telemetryConfig = {
      enabled: true,
      format: options.telemetryFormat as "jsonl" | "human",
      filePath: options.telemetryFile,
      level: telemetryLevel,
    };
  }

  // Execute
  const result = await run(project, {
    entrypoint: options.entrypoint,
    inputs,
    dryRun: options.dryRun,
    verbose: options.verbose,
    artifactDir,
    runId: options.runId,
    resumeFrom,
    startFrom: options.startFrom,
    emitSignals: options.emitSignal,
    publishTo: options.publishTo,
    telemetryConfig,
  });

  // Format and print output
  formatResult(result, options.output, options.trace);

  // Return appropriate exit code
  return result.error ? result.error.exitCode : ExitCode.SUCCESS;
}

function cmdProjectSchedule(
  projectPath: string,
  options: { format: string; show: boolean },
): number {
  const project = loadProject(projectPath);

  if (!project.orchestration) {
    if (options.show) {
      process.stdout.write("No orchestration section configured in manifest\n");
      return ExitCode.SUCCESS;
    }
    process.stderr.write(
      "Error: No 'orchestration' section in manifest. " +
        "Add orchestration.schedule.cron to configure a schedule.\n",
    );
    return ExitCode.VALIDATION_ERROR;
  }

  // Read raw manifest for schedule config
  let schedule: Record<string, unknown> = {};
  let dependsOn: Record<string, unknown>[] = [];

  const manifestCandidates = ["agent.tml", "harpoon.tml", "trident.tml", "trident.yaml"];
  for (const candidate of manifestCandidates) {
    const manifestPath = path.join(project.root, candidate);
    if (existsSync(manifestPath)) {
      try {
        const raw = yaml.load(readFileSync(manifestPath, "utf-8")) as Record<string, unknown>;
        const orch = (raw.orchestration as Record<string, unknown>) ?? {};
        schedule = (orch.schedule as Record<string, unknown>) ?? {};
        dependsOn = (orch.depends_on as Record<string, unknown>[]) ?? [];
      } catch {
        // Ignore parse errors
      }
      break;
    }
  }

  if (options.show) {
    process.stdout.write(`Project: ${project.name}\n`);
    process.stdout.write(`Root: ${project.root}\n`);
    process.stdout.write("\n");
    if (Object.keys(schedule).length > 0) {
      process.stdout.write("Schedule Configuration:\n");
      if (schedule.cron) {
        process.stdout.write(`  Cron: ${schedule.cron}\n`);
      }
      if (schedule.description) {
        process.stdout.write(`  Description: ${schedule.description}\n`);
      }
    } else {
      process.stdout.write("No schedule configured\n");
    }
    process.stdout.write("\n");
    if (dependsOn.length > 0) {
      process.stdout.write("Dependencies:\n");
      for (const dep of dependsOn) {
        const workflow = dep.workflow ?? "?";
        const signal = dep.signal ?? "ready";
        process.stdout.write(`  - ${workflow}.${signal}\n`);
      }
    }
    return ExitCode.SUCCESS;
  }

  const cronExpr = schedule.cron as string | undefined;
  if (!cronExpr) {
    process.stderr.write(
      "Error: No cron expression in orchestration.schedule.cron\n",
    );
    return ExitCode.VALIDATION_ERROR;
  }

  const projectRoot = path.resolve(project.root);

  // Build wait-for arguments from dependencies
  let waitArgs = "";
  for (const dep of dependsOn) {
    const workflow = dep.workflow ?? "";
    const signal = dep.signal ?? "ready";
    const depPath = dep.path ?? "";
    if (depPath) {
      waitArgs += ` --wait-for ${depPath}/${workflow}.${signal}`;
    } else {
      waitArgs += ` --wait-for signal:${workflow}.${signal}`;
    }
  }

  if (options.format === "cron") {
    const cmd = `cd ${projectRoot} && npx harpoon project run --emit-signal${waitArgs}`;
    process.stdout.write(`${cronExpr} ${cmd}\n`);
  } else if (options.format === "systemd") {
    const serviceName = `harpoon-${project.name}`;
    process.stdout.write(`# /etc/systemd/system/${serviceName}.service\n`);
    process.stdout.write("[Unit]\n");
    process.stdout.write(`Description=Harpoon workflow: ${project.name}\n`);
    process.stdout.write("\n");
    process.stdout.write("[Service]\n");
    process.stdout.write("Type=oneshot\n");
    process.stdout.write(`WorkingDirectory=${projectRoot}\n`);
    process.stdout.write(
      `ExecStart=/usr/bin/npx harpoon project run --emit-signal${waitArgs}\n`,
    );
    process.stdout.write("\n");
    process.stdout.write("[Install]\n");
    process.stdout.write("WantedBy=multi-user.target\n");
    process.stdout.write("\n");
    process.stdout.write(`# /etc/systemd/system/${serviceName}.timer\n`);
    process.stdout.write("[Unit]\n");
    process.stdout.write(
      `Description=Timer for Harpoon workflow: ${project.name}\n`,
    );
    process.stdout.write("\n");
    process.stdout.write("[Timer]\n");
    process.stdout.write(
      `OnCalendar=*-*-* *:00:00  # Adjust based on: ${cronExpr}\n`,
    );
    process.stdout.write("Persistent=true\n");
    process.stdout.write("\n");
    process.stdout.write("[Install]\n");
    process.stdout.write("WantedBy=timers.target\n");
  } else if (options.format === "launchd") {
    const label = `com.harpoon.${project.name}`;
    process.stdout.write('<?xml version="1.0" encoding="UTF-8"?>\n');
    process.stdout.write(
      '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" ' +
        '"http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n',
    );
    process.stdout.write('<plist version="1.0">\n');
    process.stdout.write("<dict>\n");
    process.stdout.write("    <key>Label</key>\n");
    process.stdout.write(`    <string>${label}</string>\n`);
    process.stdout.write("    <key>WorkingDirectory</key>\n");
    process.stdout.write(`    <string>${projectRoot}</string>\n`);
    process.stdout.write("    <key>ProgramArguments</key>\n");
    process.stdout.write("    <array>\n");
    process.stdout.write("        <string>/usr/bin/npx</string>\n");
    process.stdout.write("        <string>harpoon</string>\n");
    process.stdout.write("        <string>project</string>\n");
    process.stdout.write("        <string>run</string>\n");
    process.stdout.write("        <string>--emit-signal</string>\n");
    process.stdout.write("    </array>\n");
    process.stdout.write("    <key>StartCalendarInterval</key>\n");
    process.stdout.write(`    <!-- Adjust based on cron: ${cronExpr} -->\n`);
    process.stdout.write("    <dict>\n");
    process.stdout.write("        <key>Hour</key>\n");
    process.stdout.write("        <integer>0</integer>\n");
    process.stdout.write("        <key>Minute</key>\n");
    process.stdout.write("        <integer>0</integer>\n");
    process.stdout.write("    </dict>\n");
    process.stdout.write("</dict>\n");
    process.stdout.write("</plist>\n");
  }

  return ExitCode.SUCCESS;
}

async function cmdProjectSignals(
  projectPath: string,
  options: { clear: boolean },
): Promise<number> {
  const project = loadProject(projectPath);
  const signalsDir = path.join(project.root, ".harpoon", "signals");

  if (options.clear) {
    if (existsSync(signalsDir)) {
      rmSync(signalsDir, { recursive: true, force: true });
      process.stdout.write(`Cleared signals directory: ${signalsDir}\n`);
    } else {
      process.stdout.write("No signals directory to clear\n");
    }
    return ExitCode.SUCCESS;
  }

  // List current signals
  process.stdout.write(`Project: ${project.name}\n`);
  process.stdout.write(`Signals directory: ${signalsDir}\n`);
  process.stdout.write("\n");

  if (!existsSync(signalsDir)) {
    process.stdout.write("No signals found\n");
    return ExitCode.SUCCESS;
  }

  let signalFiles: string[];
  try {
    signalFiles = readdirSync(signalsDir).sort();
  } catch {
    process.stdout.write("No signals found\n");
    return ExitCode.SUCCESS;
  }

  if (signalFiles.length === 0) {
    process.stdout.write("No signals found\n");
    return ExitCode.SUCCESS;
  }

  process.stdout.write("Current signals:\n");
  for (const signalFile of signalFiles) {
    const signalPath = path.join(signalsDir, signalFile);
    try {
      const signal = await loadSignal(signalPath);
      process.stdout.write(`  ${signalFile}\n`);
      process.stdout.write(`    Run ID: ${signal.runId}\n`);
      process.stdout.write(`    Timestamp: ${signal.timestamp}\n`);
      if (signal.outputsPath) {
        process.stdout.write(`    Outputs: ${signal.outputsPath}\n`);
      }
    } catch (e) {
      process.stdout.write(`  ${signalFile} (error reading: ${e})\n`);
    }
  }

  return ExitCode.SUCCESS;
}

// ─── CLI Program ─────────────────────────────────────────────

const program = new Command();

program
  .name("harpoon")
  .description("Harpoon - Lightweight agent orchestration runtime")
  .version(`harpoon ${VERSION}`, "--version", "Show version");

// version command
program
  .command("version")
  .description("Show version")
  .action(() => {
    process.exitCode = cmdVersion();
  });

// project command group
const projectCmd = program
  .command("project")
  .description("Project commands");

// project init
projectCmd
  .command("init")
  .description("Create a new Harpoon project")
  .argument("[path]", "Path to create project", ".")
  .option(
    "-t, --template <name>",
    "Project template (minimal or standard)",
    "minimal",
  )
  .action((projectPath: string, opts) => {
    process.exitCode = cmdProjectInit(projectPath, opts);
  });

// project run
projectCmd
  .command("run")
  .description("Execute a Harpoon pipeline")
  .argument("[path]", "Path to project", ".")
  .option("-i, --input <json>", "JSON input data")
  .option("-f, --input-file <path>", "Path to JSON input file")
  .option("--input-from <source>", "Load inputs from file path, alias:name, or run:id")
  .option("-e, --entrypoint <id>", "Starting node ID")
  .option("-o, --output <format>", "Output format (json, text, pretty)", "pretty")
  .option("--trace", "Output execution trace", false)
  .option("--dry-run", "Simulate without LLM calls", false)
  .option("-v, --verbose", "Show node execution progress", false)
  .option("--no-artifacts", "Disable artifact persistence")
  .option("--artifact-dir <path>", "Custom directory for artifacts")
  .option("--run-id <id>", "Custom run ID")
  .option("--resume <id>", 'Resume from a previous run. Use run ID or "latest"')
  .option(
    "--start-from <node>",
    "Start execution from a specific node (requires --resume)",
  )
  .option("--emit-signal", "Emit orchestration signals", false)
  .option("--publish-to <path>", "Path to publish outputs")
  .option(
    "--wait-for <signal>",
    "Wait for signal file(s) before starting (repeatable)",
    (val: string, prev: string[]) => [...prev, val],
    [] as string[],
  )
  .option("--timeout <seconds>", "Timeout in seconds for --wait-for", parseFloat, 300)
  .option("--telemetry", "Enable telemetry (default: true)", true)
  .option("--no-telemetry", "Disable telemetry")
  .option(
    "--telemetry-format <format>",
    "Telemetry output format (jsonl or human)",
    "human",
  )
  .option("--telemetry-file <path>", "Write telemetry to JSONL file")
  .option(
    "--telemetry-level <level>",
    "Minimum telemetry event level (debug, info, warning, error)",
    "info",
  )
  .action(async (projectPath: string, opts) => {
    process.exitCode = await cmdProjectRun(projectPath, opts);
  });

// project validate
projectCmd
  .command("validate")
  .description("Validate a Harpoon project")
  .argument("[path]", "Path to project", ".")
  .option("--strict", "Treat warnings as errors", false)
  .action(async (projectPath: string, opts) => {
    process.exitCode = await cmdProjectValidate(projectPath, opts);
  });

// project graph
projectCmd
  .command("graph")
  .description("Visualize the project DAG")
  .argument("[path]", "Path to project", ".")
  .option(
    "-f, --format <format>",
    "Output format (ascii or mermaid)",
    "ascii",
  )
  .option(
    "-d, --direction <dir>",
    "Mermaid flow direction (TD, LR, BT, RL)",
    "TD",
  )
  .option("--open", "Open Mermaid diagram in browser", false)
  .action((projectPath: string, opts) => {
    process.exitCode = cmdProjectGraph(projectPath, opts);
  });

// project runs
projectCmd
  .command("runs")
  .description("List past runs")
  .argument("[path]", "Path to project", ".")
  .option("-n, --limit <n>", "Number of runs to show", parseInt, 10)
  .action((projectPath: string, opts) => {
    process.exitCode = cmdProjectRuns(projectPath, opts);
  });

// project schedule
projectCmd
  .command("schedule")
  .description("Generate scheduler configuration for workflow")
  .argument("[path]", "Path to project", ".")
  .option(
    "-f, --format <type>",
    "Output format (cron, systemd, launchd)",
    "cron",
  )
  .option("--show", "Show current schedule configuration", false)
  .action((projectPath: string, opts) => {
    process.exitCode = cmdProjectSchedule(projectPath, opts);
  });

// project signals
projectCmd
  .command("signals")
  .description("View and manage orchestration signals")
  .argument("[path]", "Path to project", ".")
  .option("--clear", "Remove all signal files", false)
  .action(async (projectPath: string, opts) => {
    process.exitCode = await cmdProjectSignals(projectPath, opts);
  });

// ─── Main Entry Point ────────────────────────────────────────

async function main(): Promise<void> {
  try {
    await program.parseAsync(process.argv);
  } catch (e) {
    if (e instanceof HarpoonError) {
      process.stderr.write(`Error: ${e.message}\n`);
      process.exitCode = e.exitCode;
    } else {
      process.stderr.write(
        `Unexpected error: ${e instanceof Error ? e.message : String(e)}\n`,
      );
      process.exitCode = ExitCode.RUNTIME_ERROR;
    }
  }
}

main();
