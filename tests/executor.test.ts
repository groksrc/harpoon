/**
 * Tests for DAG execution engine (executor.ts).
 */

import { describe, it, expect, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { run } from "../src/executor.js";
import { loadProject } from "../src/project.js";
import type { ExecutionResult } from "../src/executor.js";
import { buildDag, validateEdgeMappings } from "../src/dag.js";
import {
  HarpoonError,
  NodeExecutionError,
  ExitCode,
  ProviderError,
  SchemaValidationError,
  ValidationError,
} from "../src/errors.js";
import { executeAgentViaCli } from "../src/cli-agents.js";

// Real agent runs go through the Claude CLI. Stub it so tests can hand the
// executor a chosen agent result. Dry runs never call it.
vi.mock("../src/cli-agents.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/cli-agents.js")>()),
  executeAgentViaCli: vi.fn(),
}));
import { TelemetryLevel } from "../src/telemetry.js";
import type { TelemetryConfig } from "../src/telemetry.js";
import type { Project, Edge, InputNode, OutputNode } from "../src/project.js";
import type { AgentNode, PromptNode } from "../src/parser.js";

function makeSimpleProject(): Project {
  return {
    name: "test",
    root: ".",
    version: "1.0",
    description: "",
    defaults: {},
    entrypoints: ["input"],
    edges: {
      e1: {
        id: "e1",
        fromNode: "input",
        toNode: "output",
        mappings: [],
      },
    },
    prompts: {},
    inputNodes: { input: { id: "input", schema: {} } },
    outputNodes: { output: { id: "output", format: "json" } },
    tools: {},
    agents: {},
    branches: {},
    maps: {},
    triggers: {},
    env: {},
  };
}

function makeParallelProject(): Project {
  return {
    name: "test",
    root: ".",
    version: "1.0",
    description: "",
    defaults: {},
    entrypoints: ["input"],
    edges: {
      e1: {
        id: "e1",
        fromNode: "input",
        toNode: "branch_a",
        mappings: [],
      },
      e2: {
        id: "e2",
        fromNode: "input",
        toNode: "branch_b",
        mappings: [],
      },
      e3: {
        id: "e3",
        fromNode: "branch_a",
        toNode: "output",
        mappings: [],
      },
      e4: {
        id: "e4",
        fromNode: "branch_b",
        toNode: "output",
        mappings: [],
      },
    },
    prompts: {},
    inputNodes: { input: { id: "input", schema: {} } },
    outputNodes: {
      output: { id: "output", format: "json" },
      branch_a: { id: "branch_a", format: "json" },
      branch_b: { id: "branch_b", format: "json" },
    },
    tools: {},
    agents: {},
    branches: {},
    maps: {},
    triggers: {},
    env: {},
  };
}

function makeAgentProject(root: string): Project {
  const agent: AgentNode = {
    id: "summarize",
    promptPath: "prompts/summarize.prompt",
    model: "sonnet",
    allowedTools: [],
    mcpServers: {},
    maxTurns: 1,
    permissionMode: null,
    effort: null,
    cwd: null,
    executionMode: "cli",
    timeout: 5,
    promptNode: {
      id: "summarize",
      harpoonVersion: "1.0",
      name: "Summarize",
      description: "",
      model: null,
      temperature: null,
      maxTokens: null,
      timeout: null,
      inputs: {},
      output: {
        format: "json",
        fields: { summary: ["string", "Summary"] },
      },
      body: "Summarize.",
      filePath: null,
      maxTurns: null,
      allowedTools: null,
      permissionMode: null,
      effort: null,
      entrypoint: false,
      next: null,
      loop: null,
      tools: null,
    },
  };

  return {
    name: "agent-test",
    root,
    version: "1.0",
    description: "",
    defaults: {},
    entrypoints: ["input"],
    edges: {
      e1: { id: "e1", fromNode: "input", toNode: "summarize", mappings: [] },
      e2: { id: "e2", fromNode: "summarize", toNode: "output", mappings: [] },
    },
    prompts: {},
    inputNodes: { input: { id: "input", schema: {} } },
    outputNodes: { output: { id: "output", format: "json" } },
    tools: {},
    agents: { summarize: agent },
    branches: {},
    maps: {},
    triggers: {},
    env: {},
  };
}

describe("dry run execution", () => {
  it("returns successful result", async () => {
    const project = makeSimpleProject();
    const result = await run(project, {
      dryRun: true,
      inputs: { message: "hello" },
    });

    expect(result.success).toBe(true);
    expect(result.error).toBeUndefined();
  });

  it("succeeds with parallel node structure", async () => {
    const project = makeParallelProject();
    const result = await run(project, {
      dryRun: true,
      inputs: { value: 42 },
    });

    expect(result.success).toBe(true);
    const nodeIds = new Set(result.trace.nodes.map((n) => n.id));
    expect(nodeIds.has("input")).toBe(true);
    expect(nodeIds.has("branch_a")).toBe(true);
    expect(nodeIds.has("branch_b")).toBe(true);
    expect(nodeIds.has("output")).toBe(true);
  });

  it("records an agent's requested model in trace and telemetry", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "harpoon-agent-trace-"));
    try {
      const project = makeAgentProject(root);
      const artifactDir = path.join(root, ".harpoon");
      const result = await run(project, {
        dryRun: true,
        artifactDir,
        telemetryConfig: {
          enabled: true,
          format: "jsonl",
          level: TelemetryLevel.INFO,
        },
      });

      const agentTrace = result.trace.nodes.find((node) => node.id === "summarize");
      expect(agentTrace?.model).toBe("sonnet");
      expect(agentTrace?.resolvedModel).toBeUndefined();

      const telemetryPath = path.join(
        artifactDir,
        "runs",
        result.trace.runId,
        "telemetry.jsonl",
      );
      const events = fs.readFileSync(telemetryPath, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      const completed = events.find(
        (event) => event.event === "node_completed" && event.node_id === "summarize",
      );
      expect(completed.data.model).toBe("sonnet");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("routes schema-shaped tool mocks into required agent inputs and outputs", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "harpoon-tool-schema-"));
    try {
      fs.mkdirSync(path.join(root, "prompts"));
      fs.writeFileSync(
        path.join(root, "agent.tml"),
        `harpoon: "1.0"
name: tool-schema-dry-run
nodes:
  input:
    type: input
    schema:
      session_id: { type: string, description: Session }
  summarize:
    type: agent
    prompt: prompts/summarize.prompt
    model: sonnet
    execution_mode: cli
  preview:
    type: output
    format: json
  output:
    type: output
    format: json
tools:
  prepare:
    type: typescript
    module: prepare
    output:
      schema:
        job_id: { type: string, description: Job }
        count: { type: integer, description: Count }
        items: { type: array, description: Items }
edges:
  e1:
    from: input
    to: prepare
    mapping: { session_id: session_id }
  e2:
    from: prepare
    to: summarize
    mapping: { job_id: job_id, count: count, items: items }
  e3:
    from: prepare
    to: preview
    mapping: { job_id: job_id, count: count, items: items }
  e4:
    from: summarize
    to: output
    mapping: { summary: summary }
`,
      );
      fs.writeFileSync(
        path.join(root, "prompts", "summarize.prompt"),
        `---
id: summarize
harpoon: "1.0"
input:
  job_id: { type: string, required: true }
  count: { type: integer, required: true }
  items: { type: array, required: true }
output:
  format: json
  schema:
    summary: { type: string, description: Summary }
---
Summarize {{job_id}}.
`,
      );

      const project = loadProject(root);
      const validation = validateEdgeMappings(project, buildDag(project));
      expect(validation.warnings).toEqual([]);

      const result = await run(project, {
        dryRun: true,
        inputs: { session_id: "session-1" },
      });
      expect(result.success).toBe(true);
      const prepare = result.trace.nodes.find((node) => node.id === "prepare");
      expect(prepare?.output).toEqual({
        job_id: "[mock_job_id]",
        count: 0,
        items: [],
      });
      const summarize = result.trace.nodes.find((node) => node.id === "summarize");
      expect(summarize?.input).toEqual(prepare?.output);
      const preview = result.trace.nodes.find((node) => node.id === "preview");
      expect(preview?.output).toEqual(prepare?.output);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("tool output validation", () => {
  function createToolProject(root: string, moduleName: string): Project {
    return {
      name: "tool-output-validation",
      root,
      version: "1.0",
      description: "",
      defaults: {},
      entrypoints: ["input"],
      edges: {
        e1: {
          id: "e1",
          fromNode: "input",
          toNode: "worker",
          mappings: [{ targetVar: "value", sourceExpr: "value" }],
        },
        e2: {
          id: "e2",
          fromNode: "worker",
          toNode: "output",
          mappings: [{ targetVar: "result", sourceExpr: "result" }],
        },
      },
      prompts: {},
      inputNodes: { input: { id: "input", schema: { value: ["string", ""] } } },
      outputNodes: { output: { id: "output", format: "json" } },
      tools: {
        worker: {
          id: "worker",
          type: "typescript",
          module: moduleName,
          function: "execute",
          description: "",
          outputSchema: {
            result: { type: "string", description: "", required: true },
            warning: { type: "string", description: "", required: false },
          },
        },
      },
      agents: {},
      branches: {},
      maps: {},
      triggers: {},
      env: {},
    };
  }

  it("accepts valid results with omitted optional fields", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "harpoon-tool-valid-"));
    try {
      fs.mkdirSync(path.join(root, "tools"));
      fs.writeFileSync(
        path.join(root, "tools", "valid.js"),
        "export async function execute({ value }) { return { result: value }; }\n",
      );
      const result = await run(createToolProject(root, "valid"), {
        inputs: { value: "ok" },
      });
      expect(result.success).toBe(true);
      expect(result.outputs.output).toEqual({ result: "ok" });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("runs a tool whose output field has a type outside the known types", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "harpoon-tool-uuid-"));
    try {
      fs.mkdirSync(path.join(root, "tools"));
      fs.writeFileSync(
        path.join(root, "tools", "uuid.js"),
        "export async function execute() { return { result: 'a1b2-c3d4' }; }\n",
      );
      const project = createToolProject(root, "uuid");
      project.tools.worker.outputSchema = {
        result: { type: "uuid", description: "", required: true },
      };
      // The unchecked type warns (passing validation) and the field is
      // still required to be present at runtime.
      const result = await run(project, { inputs: { value: "ok" } });
      expect(result.success).toBe(true);
      expect(result.outputs.output).toEqual({ result: "a1b2-c3d4" });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects real tool results missing required schema fields", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "harpoon-tool-invalid-"));
    try {
      fs.mkdirSync(path.join(root, "tools"));
      fs.writeFileSync(
        path.join(root, "tools", "invalid.js"),
        "export async function execute() { return { warning: 'missing' }; }\n",
      );
      const result = await run(createToolProject(root, "invalid"), {
        inputs: { value: "ok" },
      });
      expect(result.success).toBe(false);
      expect(result.error?.message).toContain("Missing required field: result");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("parallel execution", () => {
  it("groups parallel nodes in same level", () => {
    const project = makeParallelProject();
    const dag = buildDag(project);

    expect(dag.executionLevels).toHaveLength(3);
    expect(dag.executionLevels[0]).toEqual(["input"]);
    expect(dag.executionLevels[1].sort()).toEqual(["branch_a", "branch_b"]);
    expect(dag.executionLevels[2]).toEqual(["output"]);
  });
});

describe("NodeExecutionError", () => {
  it("includes node context", () => {
    const error = new NodeExecutionError(
      "analyze_code",
      "prompt",
      "Model returned invalid JSON"
    );

    expect(error.nodeId).toBe("analyze_code");
    expect(error.nodeType).toBe("prompt");
    expect(error.toString()).toContain("analyze_code");
    expect(error.toString()).toContain("prompt");
  });

  it("preserves and displays cause", () => {
    const cause = new Error("Invalid model name");
    const error = new NodeExecutionError(
      "test_node",
      "prompt",
      "Provider error",
      cause
    );

    expect(error.cause).toBe(cause);
    expect(error.causeType).toBe("Error");
    expect(error.toString()).toContain("Error");
  });

  it("shows input context", () => {
    const error = new NodeExecutionError(
      "test_node",
      "prompt",
      "Template error",
      undefined,
      { code: "def foo(): pass", lang: "python" }
    );

    expect(error.toString()).toContain("Inputs:");
  });

  it("inherits exit code from HarpoonError causes", () => {
    const cause = new ProviderError("Rate limited", true);
    const error = new NodeExecutionError(
      "test",
      "prompt",
      "API error",
      cause
    );

    expect(error.exitCode).toBe(ExitCode.PROVIDER_ERROR);
  });
});

describe("start-from", () => {
  it("requires resume_from", async () => {
    const project = makeSimpleProject();

    await expect(
      run(project, { dryRun: true, startFrom: "output" })
    ).rejects.toThrow(HarpoonError);
  });

  it("rejects invalid start-from node", async () => {
    const project = makeSimpleProject();
    const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), "harpoon-test-"));
    const checkpointPath = path.join(tmpdir, "checkpoint.json");

    fs.writeFileSync(
      checkpointPath,
      JSON.stringify({
        run_id: "test-run",
        project_name: "test",
        started_at: "2024-01-01T00:00:00Z",
        updated_at: "2024-01-01T00:00:00Z",
        status: "completed",
        completed_nodes: {},
        pending_nodes: [],
        inputs: {},
      })
    );

    try {
      await expect(
        run(project, {
          dryRun: true,
          resumeFrom: checkpointPath,
          startFrom: "nonexistent_node",
        })
      ).rejects.toThrow(HarpoonError);
    } finally {
      fs.rmSync(tmpdir, { recursive: true, force: true });
    }
  });
});

describe("execution trace", () => {
  it("trace has runId and timestamps", async () => {
    const project = makeSimpleProject();
    const result = await run(project, {
      dryRun: true,
      inputs: { text: "hello" },
    });

    expect(result.trace.runId).toBeDefined();
    expect(result.trace.startTime).toBeDefined();
    expect(result.trace.endTime).toBeDefined();
  });

  it("trace includes all executed nodes", async () => {
    const project = makeSimpleProject();
    const result = await run(project, {
      dryRun: true,
      inputs: { text: "hello" },
    });

    const nodeIds = result.trace.nodes.map((n) => n.id);
    expect(nodeIds).toContain("input");
    expect(nodeIds).toContain("output");
  });
});

describe("telemetry file output", () => {
  it("writes telemetry.jsonl to default run dir when no file path specified", async () => {
    const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), "harpoon-test-"));
    const project = makeSimpleProject();
    project.root = tmpdir;

    const telemetryConfig: TelemetryConfig = {
      enabled: true,
      format: "human",
      level: TelemetryLevel.INFO,
    };

    const result = await run(project, {
      dryRun: true,
      inputs: { message: "hello" },
      artifactDir: path.join(tmpdir, ".harpoon"),
      telemetryConfig,
    });

    const runId = result.trace.runId;
    const telemetryFile = path.join(tmpdir, ".harpoon", "runs", runId, "telemetry.jsonl");
    expect(fs.existsSync(telemetryFile)).toBe(true);

    const lines = fs.readFileSync(telemetryFile, "utf-8").trim().split("\n");
    expect(lines.length).toBeGreaterThanOrEqual(1);

    // Each line should be valid JSON
    for (const line of lines) {
      const event = JSON.parse(line);
      expect(event.run_id).toBe(runId);
      expect(event.event).toBeDefined();
    }

    // Should include workflow_started and node events
    const events = lines.map((l) => JSON.parse(l));
    const eventTypes = events.map((e) => e.event);
    expect(eventTypes).toContain("workflow_started");
    expect(eventTypes).toContain("node_started");
    expect(eventTypes).toContain("node_completed");

    // NODE_STARTED should include input
    const nodeStarted = events.find((e) => e.event === "node_started" && e.node_id === "output");
    expect(nodeStarted).toBeDefined();
    expect(nodeStarted.data).toHaveProperty("input");

    // NODE_COMPLETED should include output
    const nodeCompleted = events.find((e) => e.event === "node_completed" && e.node_id === "output");
    expect(nodeCompleted).toBeDefined();
    expect(nodeCompleted.data).toHaveProperty("output");

    fs.rmSync(tmpdir, { recursive: true, force: true });
  });

  it("uses --telemetry-file path when specified", async () => {
    const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), "harpoon-test-"));
    const customFile = path.join(tmpdir, "custom.jsonl");
    const project = makeSimpleProject();
    project.root = tmpdir;

    const telemetryConfig: TelemetryConfig = {
      enabled: true,
      format: "human",
      filePath: customFile,
      level: TelemetryLevel.INFO,
    };

    const result = await run(project, {
      dryRun: true,
      inputs: { message: "hello" },
      telemetryConfig,
    });

    // Wait for flush
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(fs.existsSync(customFile)).toBe(true);
    const lines = fs.readFileSync(customFile, "utf-8").trim().split("\n");
    const events = lines.map((l) => JSON.parse(l));
    expect(events[0].event).toBe("workflow_started");

    fs.rmSync(tmpdir, { recursive: true, force: true });
  });
});

describe("conditional edge evaluation", () => {
  it("skips nodes when edge condition is false", async () => {
    const project: Project = {
      name: "test",
      root: ".",
      version: "1.0",
      description: "",
      defaults: {},
      entrypoints: ["input"],
      edges: {
        e1: {
          id: "e1",
          fromNode: "input",
          toNode: "output",
          mappings: [{ targetVar: "data", sourceExpr: "value" }],
          condition: "value > 100",
        },
      },
      prompts: {},
      inputNodes: { input: { id: "input", schema: {} } },
      outputNodes: { output: { id: "output", format: "json" } },
      tools: {},
      agents: {},
      branches: {},
      maps: {},
      triggers: {},
      env: {},
    };

    const result = await run(project, {
      dryRun: true,
      inputs: { value: 5 },
    });

    // The output node should be skipped since condition is false
    const outputTrace = result.trace.nodes.find((n) => n.id === "output");
    expect(outputTrace).toBeDefined();
    expect(outputTrace!.skipped).toBe(true);
  });
});

// ─── Validation before and during a run ──────────────────────

/**
 * input -> mark (a tool that writes a marker file when it runs) -> output.
 * The marker proves whether any node executed.
 */
function makeMarkerProject(root: string): Project {
  fs.mkdirSync(path.join(root, "tools"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "tools", "mark.js"),
    "import { writeFileSync } from 'node:fs';\n" +
      "import { join } from 'node:path';\n" +
      "export async function execute() {\n" +
      `  writeFileSync(join(${JSON.stringify(root)}, 'ran.txt'), 'yes');\n` +
      "  return { done: true };\n" +
      "}\n",
  );
  return {
    name: "marker",
    root,
    version: "1.0",
    description: "",
    defaults: {},
    entrypoints: ["input"],
    edges: {
      e1: { id: "e1", fromNode: "input", toNode: "mark", mappings: [] },
      e2: {
        id: "e2",
        fromNode: "mark",
        toNode: "output",
        mappings: [{ targetVar: "done", sourceExpr: "done" }],
      },
    },
    prompts: {},
    inputNodes: {
      input: { id: "input", schema: { count: ["integer", "How many"] } },
    },
    outputNodes: { output: { id: "output", format: "json" } },
    tools: {
      mark: {
        id: "mark",
        type: "typescript",
        module: "mark",
        function: "execute",
        description: "",
        outputSchema: { done: { type: "boolean", description: "", required: true } },
      },
    },
    agents: {},
    branches: {},
    maps: {},
    triggers: {},
    env: {},
  };
}

function makePromptNode(
  id: string,
  inputs: PromptNode["inputs"],
  fields: Record<string, [string, string]>,
): PromptNode {
  return {
    id,
    harpoonVersion: "1.0",
    name: id,
    description: "",
    model: null,
    temperature: null,
    maxTokens: null,
    timeout: null,
    inputs,
    output: { format: Object.keys(fields).length ? "json" : "text", fields },
    body: "Do it.",
    filePath: null,
    maxTurns: null,
    allowedTools: null,
    permissionMode: null,
    effort: null,
    entrypoint: false,
    next: null,
    loop: null,
    tools: null,
  };
}

describe("run() validation", () => {
  it("throws a ValidationError before any node runs for a hard-invalid project", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "harpoon-invalid-run-"));
    try {
      const project = makeMarkerProject(root);
      // number -> integer is a known type mismatch: a hard error.
      project.prompts.consume = makePromptNode(
        "consume",
        { n: { name: "n", type: "integer", description: "", required: true } },
        {},
      );
      project.inputNodes.input.schema.ratio = ["number", "Ratio"];
      project.edges.e3 = {
        id: "e3",
        fromNode: "input",
        toNode: "consume",
        mappings: [{ targetVar: "n", sourceExpr: "ratio" }],
      };
      project.edges.e4 = { id: "e4", fromNode: "consume", toNode: "output", mappings: [] };
      const artifactDir = path.join(root, ".harpoon");

      const attempt = run(project, { inputs: { count: 1, ratio: 0.5 }, artifactDir });
      await expect(attempt).rejects.toThrow(ValidationError);
      await expect(attempt).rejects.toThrow(
        /Edge 'e3': Type mismatch: 'ratio' \(number\) from 'input' cannot feed 'n' \(integer\)/,
      );

      expect(fs.existsSync(path.join(root, "ran.txt"))).toBe(false);
      expect(fs.existsSync(path.join(artifactDir, "runs"))).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects a requested entrypoint that is not a node", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "harpoon-bad-entry-"));
    try {
      const project = makeMarkerProject(root);
      await expect(
        run(project, { entrypoint: "nowhere", inputs: { count: 1 } }),
      ).rejects.toThrow(/Requested entrypoint 'nowhere' is not a node/);
      expect(fs.existsSync(path.join(root, "ran.txt"))).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("runs a valid project, so the marker shows nodes do run", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "harpoon-valid-run-"));
    try {
      const result = await run(makeMarkerProject(root), { inputs: { count: 3 } });
      expect(result.success).toBe(true);
      expect(fs.existsSync(path.join(root, "ran.txt"))).toBe(true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("run input type check", () => {
  it("rejects a wrongly typed run input before any node runs", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "harpoon-input-type-"));
    try {
      const attempt = run(makeMarkerProject(root), { inputs: { count: "three" } });
      await expect(attempt).rejects.toThrow(ValidationError);
      await expect(attempt).rejects.toThrow(
        "Run input rejected by input node 'input': Field 'count' expected integer, got string",
      );
      expect(fs.existsSync(path.join(root, "ran.txt"))).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects a non-integer for an integer field", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "harpoon-input-int-"));
    try {
      await expect(
        run(makeMarkerProject(root), { inputs: { count: 2.5 } }),
      ).rejects.toThrow("Field 'count' expected integer, got 2.5");
      expect(fs.existsSync(path.join(root, "ran.txt"))).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects a supplied null before any node runs", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "harpoon-input-null-"));
    try {
      const attempt = run(makeMarkerProject(root), { inputs: { count: null } });
      await expect(attempt).rejects.toThrow(ValidationError);
      await expect(attempt).rejects.toThrow(
        "Run input rejected by input node 'input': Field 'count' expected integer, got null",
      );
      expect(fs.existsSync(path.join(root, "ran.txt"))).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not reject a missing input field", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "harpoon-input-missing-"));
    try {
      const result = await run(makeMarkerProject(root), { inputs: {} });
      expect(result.success).toBe(true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("runs a prompt-first project that omits an optional entrypoint input", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "harpoon-prompt-first-"));
    try {
      fs.mkdirSync(path.join(root, "prompts"));
      fs.writeFileSync(
        path.join(root, "prompts", "reply.prompt"),
        `---
id: reply
harpoon: "1.0"
model: anthropic/claude-sonnet-4-20250514
entrypoint: true
input:
  message: { type: string, required: true }
  tone: { type: string, required: false }
  length: { type: integer, default: 50 }
---
Reply to {{message}}.
`,
      );
      const project = loadProject(root);
      // The prompt-first input node lists optional inputs too.
      expect(Object.keys(project.inputNodes.input.schema).sort()).toEqual([
        "length",
        "message",
        "tone",
      ]);

      const result = await run(project, { dryRun: true, inputs: { message: "hi" } });
      expect(result.success).toBe(true);
      const reply = result.trace.nodes.find((n) => n.id === "reply");
      expect(reply?.error).toBeUndefined();
      expect(reply?.skipped).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("agent output check", () => {
  function makeAgentChain(root: string): Project {
    const project = makeAgentProject(root);
    project.agents.summarize.promptNode!.output.fields = {
      summary: ["string", "Summary"],
      count: ["integer", "Count"],
    };
    project.edges.e2 = {
      id: "e2",
      fromNode: "summarize",
      toNode: "output",
      mappings: [
        { targetVar: "summary", sourceExpr: "summary" },
        { targetVar: "count", sourceExpr: "count" },
      ],
    };
    return project;
  }

  function agentResult(output: Record<string, unknown>) {
    return {
      output,
      tokens: { input: 1, output: 1 },
      costUsd: 0,
      sessionId: "session-1",
      numTurns: 1,
    };
  }

  it("fails the agent node when its JSON output lacks a declared field", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "harpoon-agent-missing-"));
    try {
      vi.mocked(executeAgentViaCli).mockResolvedValueOnce(
        agentResult({ summary: "short" }),
      );
      const result = await run(makeAgentChain(root), {});
      expect(result.success).toBe(false);
      expect(result.error?.nodeId).toBe("summarize");
      expect(result.error?.message).toContain("Missing required field: count");
      expect(result.trace.nodes.map((n) => n.id)).not.toContain("output");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("fails the agent node when a declared field has the wrong type", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "harpoon-agent-type-"));
    try {
      vi.mocked(executeAgentViaCli).mockResolvedValueOnce(
        agentResult({ summary: "short", count: "two" }),
      );
      const result = await run(makeAgentChain(root), {});
      expect(result.success).toBe(false);
      expect(result.error?.message).toContain("Field 'count' expected integer, got string");
      expect(result.trace.nodes.map((n) => n.id)).not.toContain("output");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("passes valid agent output downstream", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "harpoon-agent-ok-"));
    try {
      vi.mocked(executeAgentViaCli).mockResolvedValueOnce(
        agentResult({ summary: "short", count: 2 }),
      );
      const result = await run(makeAgentChain(root), {});
      expect(result.success).toBe(true);
      expect(result.outputs.output).toEqual({ summary: "short", count: 2 });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects mapping `text` from a JSON agent before the agent runs", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "harpoon-agent-text-"));
    try {
      vi.mocked(executeAgentViaCli).mockClear();
      const project = makeAgentProject(root);
      // summarize is a JSON agent declaring only `summary`. At runtime it
      // returns only its parsed JSON, so `text` would never arrive.
      project.edges.e2 = {
        id: "e2",
        fromNode: "summarize",
        toNode: "output",
        mappings: [{ targetVar: "draft", sourceExpr: "text" }],
      };
      const attempt = run(project, {});
      await expect(attempt).rejects.toThrow(ValidationError);
      await expect(attempt).rejects.toThrow(
        /Edge 'e2': source field 'text' does not exist in 'summarize' \(agent\) output/,
      );
      expect(executeAgentViaCli).not.toHaveBeenCalled();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
