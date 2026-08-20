/**
 * Project and manifest loading.
 *
 * Supports three loading modes:
 * 1. Manifest-based: load from agent.tml / harpoon.tml / trident.tml / trident.yaml
 * 2. Prompt-first: build from .prompt files when no manifest exists
 * 3. Augmented: both exist, merge them (prompt frontmatter wins on conflict)
 */

import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import * as path from "node:path";
import yaml from "js-yaml";

import { VERSION } from "./version.js";
import { ParseError, ValidationError, checkVersion } from "./errors.js";
import { orchestrationConfigFromDict } from "./artifacts.js";
import type { OrchestrationConfig } from "./artifacts.js";
import {
  parsePromptFile,
  parseYaml,
} from "./parser.js";
import type {
  AgentNode,
  BranchNode,
  MapNode,
  MCPServerConfig,
  PromptNode,
  TriggerNode,
} from "./parser.js";

// ─── Data Interfaces ─────────────────────────────────────────

/** Field mapping for an edge. */
export interface EdgeMapping {
  targetVar: string;
  sourceExpr: string;
}

/** Edge connecting two nodes. */
export interface Edge {
  id: string;
  fromNode: string;
  toNode: string;
  mappings: EdgeMapping[];
  condition?: string | null;
}

/** Input node definition. */
export interface InputNode {
  id: string;
  schema: Record<string, [string, string]>; // name -> [type, description]
}

/** Output node definition. */
export interface OutputNode {
  id: string;
  format: string;
}

/** Tool definition. */
export interface ToolDef {
  id: string;
  type: string; // "typescript", "shell", "http"
  path?: string;
  module?: string;
  function?: string;
  description: string;
}

/** Model defaults. */
export interface ModelDefaults {
  model?: string;
  temperature?: number;
  maxTokens?: number;
  executionMode?: string;
  [key: string]: unknown;
}

/** Allowed values for the Claude CLI --effort flag. */
const VALID_EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;

/** Loaded Harpoon project. */
export interface Project {
  name: string;
  root: string;
  version: string;
  description: string;
  defaults: ModelDefaults;
  entrypoints: string[];
  edges: Record<string, Edge>;
  prompts: Record<string, PromptNode>;
  inputNodes: Record<string, InputNode>;
  outputNodes: Record<string, OutputNode>;
  tools: Record<string, ToolDef>;
  agents: Record<string, AgentNode>;
  branches: Record<string, BranchNode>;
  maps: Record<string, MapNode>;
  triggers: Record<string, TriggerNode>;
  env: Record<string, Record<string, unknown>>;
  orchestration?: OrchestrationConfig;
}

// ─── .env Loading ────────────────────────────────────────────

/** Load .env file into process.env if it exists. Does not override existing vars. */
export function loadDotenv(envPath: string): void {
  if (!existsSync(envPath)) return;

  let content: string;
  try {
    content = readFileSync(envPath, "utf-8");
  } catch {
    return;
  }

  for (const rawLine of content.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    if (!line.includes("=")) continue;

    const eqIdx = line.indexOf("=");
    const key = line.slice(0, eqIdx).trim();
    let value = line.slice(eqIdx + 1).trim();

    // Strip quotes if present
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    // Don't override existing env vars
    if (!(key in process.env)) {
      process.env[key] = value;
    }
  }
}

// ─── Manifest Discovery ─────────────────────────────────────

function findManifest(root: string): string | null {
  for (const candidate of [
    "agent.tml",
    "harpoon.tml",
    "trident.tml",
    "trident.yaml",
  ]) {
    const candidatePath = path.join(root, candidate);
    if (existsSync(candidatePath)) return candidatePath;
  }
  return null;
}

// ─── Prompt Discovery ────────────────────────────────────────

/** Recursively glob for .prompt files. */
function globPromptFiles(dir: string): string[] {
  const results: string[] = [];
  if (!existsSync(dir)) return results;

  const entries = readdirSync(dir);
  for (const entry of entries) {
    const fullPath = path.join(dir, entry);
    const stat = statSync(fullPath);
    if (stat.isDirectory()) {
      results.push(...globPromptFiles(fullPath));
    } else if (entry.endsWith(".prompt")) {
      results.push(fullPath);
    }
  }
  return results;
}

/** Discover and parse all .prompt files in a project. */
function discoverPrompts(root: string): Record<string, PromptNode> {
  const prompts: Record<string, PromptNode> = {};
  const promptsDir = path.join(root, "prompts");

  if (!existsSync(promptsDir)) return prompts;

  const promptFiles = globPromptFiles(promptsDir);
  for (const promptFile of promptFiles) {
    try {
      const node = parsePromptFile(promptFile);
      prompts[node.id] = node;
    } catch (e) {
      if (e instanceof ParseError) throw e;
      throw new ParseError(
        `Error parsing ${promptFile}: ${e instanceof Error ? e.message : String(e)}`
      );
    }
  }

  return prompts;
}

// ─── Edge Building from Prompts ──────────────────────────────

/** Resolve a next prompt path to a prompt ID. */
function resolvePromptPath(
  nextPath: string,
  currentPrompt: PromptNode,
  root: string
): string {
  // Normalize path - strip prompts/ prefix if present
  if (nextPath.startsWith("prompts/")) {
    nextPath = nextPath.slice(8);
  }

  // Handle relative paths (starting with ./)
  if (nextPath.startsWith("./") && currentPrompt.filePath) {
    const currentDir = path.dirname(currentPrompt.filePath);
    const resolved = path.resolve(currentDir, nextPath.slice(2));
    const promptsDir = path.join(root, "prompts");
    const rel = path.relative(promptsDir, resolved);
    if (!rel.startsWith("..")) {
      nextPath = rel;
    }
  }

  // Extract ID from path (remove .prompt extension)
  if (nextPath.endsWith(".prompt")) {
    nextPath = nextPath.slice(0, -7);
  }

  // Handle subdirectory paths - use filename as ID
  if (nextPath.includes("/")) {
    return nextPath.split("/").pop()!;
  }

  return nextPath;
}

/** Auto-generate field mappings between prompts. */
function autoMapFields(
  sourcePrompt: PromptNode,
  targetPrompt: PromptNode | undefined
): EdgeMapping[] {
  const mappings: EdgeMapping[] = [];
  if (!targetPrompt) return mappings;

  // Get source output fields
  const sourceFields = new Set<string>();
  if (
    sourcePrompt.output.format === "json" &&
    Object.keys(sourcePrompt.output.fields).length > 0
  ) {
    for (const key of Object.keys(sourcePrompt.output.fields)) {
      sourceFields.add(key);
    }
  }
  sourceFields.add("text"); // text is always available

  // Get target input fields
  const targetFields = new Set(Object.keys(targetPrompt.inputs));

  // Map matching fields
  for (const fieldName of sourceFields) {
    if (targetFields.has(fieldName)) {
      mappings.push({ targetVar: fieldName, sourceExpr: fieldName });
    }
  }

  return mappings;
}

/** Build edges from prompt next declarations. */
function buildEdgesFromPrompts(
  prompts: Record<string, PromptNode>,
  root: string
): { edges: Record<string, Edge>; terminalPrompts: Set<string> } {
  const edges: Record<string, Edge> = {};
  let edgeCounter = 0;
  const terminalPrompts = new Set<string>();

  for (const [promptId, prompt] of Object.entries(prompts)) {
    if (prompt.next === null) {
      terminalPrompts.add(promptId);
      continue;
    }

    // Handle simple string next
    if (typeof prompt.next === "string") {
      const targetId = resolvePromptPath(prompt.next, prompt, root);
      const edgeId = `e${edgeCounter}`;
      edgeCounter++;

      const mappings = autoMapFields(prompt, prompts[targetId]);
      edges[edgeId] = {
        id: edgeId,
        fromNode: promptId,
        toNode: targetId,
        mappings,
      };
    }
    // Handle conditional next list
    else if (Array.isArray(prompt.next)) {
      for (const nextCond of prompt.next) {
        const targetId = resolvePromptPath(nextCond.prompt, prompt, root);
        const edgeId = `e${edgeCounter}`;
        edgeCounter++;

        const mappings = autoMapFields(prompt, prompts[targetId]);
        edges[edgeId] = {
          id: edgeId,
          fromNode: promptId,
          toNode: targetId,
          mappings,
          condition: nextCond.condition,
        };
      }
    }
  }

  return { edges, terminalPrompts };
}

// ─── Loop Prompt Transformation ──────────────────────────────

/** Transform prompts with loop config into BranchNodes. */
function transformLoopPrompts(project: Project): void {
  const promptsWithLoops = Object.values(project.prompts).filter(
    (p) => p.loop !== null
  );

  if (promptsWithLoops.length === 0) return;

  for (const prompt of promptsWithLoops) {
    const loopConfig = prompt.loop;
    if (!loopConfig) continue;

    const branchId = `loop_${prompt.id}`;

    project.branches[branchId] = {
      id: branchId,
      workflowPath: "self",
      condition: null,
      loopWhile: loopConfig.whileCondition,
      maxIterations: loopConfig.maxIterations,
    };

    // Rewire incoming edges to point to the branch node
    for (const [edgeId, edge] of Object.entries(project.edges)) {
      if (edge.toNode === prompt.id) {
        project.edges[edgeId] = {
          id: edge.id,
          fromNode: edge.fromNode,
          toNode: branchId,
          mappings: edge.mappings,
          condition: edge.condition,
        };
      }
    }

    // Create edge from branch to prompt (internal execution)
    const internalEdgeId = `e_${branchId}_to_${prompt.id}`;
    const internalMappings: EdgeMapping[] = Object.keys(prompt.inputs).map(
      (name) => ({ targetVar: name, sourceExpr: name })
    );
    project.edges[internalEdgeId] = {
      id: internalEdgeId,
      fromNode: branchId,
      toNode: prompt.id,
      mappings: internalMappings,
    };
  }
}

// ─── Augment from Prompts ────────────────────────────────────

/** Augment manifest-based project with prompt frontmatter overrides. */
function augmentFromPrompts(project: Project): void {
  const promptsWithNext = Object.values(project.prompts).filter(
    (p) => p.next !== null
  );
  if (promptsWithNext.length === 0) return;

  const { edges: promptEdges } = buildEdgesFromPrompts(
    project.prompts,
    project.root
  );

  // Check for conflicts and merge
  for (const [edgeId, edge] of Object.entries(promptEdges)) {
    const existingEdges = Object.entries(project.edges).filter(
      ([, e]) => e.fromNode === edge.fromNode && e.toNode === edge.toNode
    );

    for (const [existingId] of existingEdges) {
      delete project.edges[existingId];
    }

    project.edges[edgeId] = edge;
  }

  // Convert prompt tools to project tools (prompt wins on conflict)
  for (const prompt of Object.values(project.prompts)) {
    if (prompt.tools) {
      for (const [toolId, toolDef] of Object.entries(prompt.tools)) {
        project.tools[toolId] = {
          id: toolId,
          type: toolDef.type,
          module: toolDef.module,
          function: toolDef.function,
          path: toolDef.path,
          description: toolDef.description,
        };
      }
    }
  }
}

// ─── Prompt-first Project Building ───────────────────────────

/** Build a project from prompt files without a manifest. */
function buildProjectFromPrompts(root: string): Project {
  const prompts = discoverPrompts(root);

  if (Object.keys(prompts).length === 0) {
    throw new ParseError(
      `No .prompt files found in ${path.join(root, "prompts")}`
    );
  }

  // Find entrypoint
  const entrypointPrompts = Object.values(prompts).filter(
    (p) => p.entrypoint
  );

  if (entrypointPrompts.length === 0) {
    throw new ValidationError(
      "No entrypoint defined. Add 'entrypoint: true' to one prompt's frontmatter."
    );
  }

  if (entrypointPrompts.length > 1) {
    const names = entrypointPrompts.map((p) => p.id);
    throw new ValidationError(
      `Multiple entrypoints found: ${JSON.stringify(names)}. Only one prompt can have 'entrypoint: true'.`
    );
  }

  const entrypoint = entrypointPrompts[0];

  // Build edges from next declarations
  const { edges, terminalPrompts } = buildEdgesFromPrompts(prompts, root);

  // Create project with directory name
  const project: Project = {
    name: path.basename(root),
    root,
    version: "1.0",
    description: "",
    defaults: {},
    entrypoints: [],
    edges,
    prompts,
    inputNodes: {},
    outputNodes: {},
    tools: {},
    agents: {},
    branches: {},
    maps: {},
    triggers: {},
    env: {},
  };

  // Create input node from entrypoint's inputs
  if (Object.keys(entrypoint.inputs).length > 0) {
    const inputSchema: Record<string, [string, string]> = {};
    for (const [name, inp] of Object.entries(entrypoint.inputs)) {
      inputSchema[name] = [inp.type, inp.description];
    }
    project.inputNodes["input"] = { id: "input", schema: inputSchema };

    // Create edge from input to entrypoint
    const inputEdgeId = `e_input_to_${entrypoint.id}`;
    const inputMappings: EdgeMapping[] = Object.keys(entrypoint.inputs).map(
      (name) => ({ targetVar: name, sourceExpr: name })
    );
    project.edges[inputEdgeId] = {
      id: inputEdgeId,
      fromNode: "input",
      toNode: entrypoint.id,
      mappings: inputMappings,
    };
    project.entrypoints = ["input"];
  } else {
    project.entrypoints = [entrypoint.id];
  }

  // Create output node from terminal prompts
  if (terminalPrompts.size > 0) {
    project.outputNodes["output"] = { id: "output", format: "json" };

    for (const terminalId of terminalPrompts) {
      const terminal = prompts[terminalId];
      const outputEdgeId = `e_${terminalId}_to_output`;

      const mappings: EdgeMapping[] = [];
      if (
        terminal &&
        terminal.output.format === "json" &&
        Object.keys(terminal.output.fields).length > 0
      ) {
        for (const fieldName of Object.keys(terminal.output.fields)) {
          mappings.push({ targetVar: fieldName, sourceExpr: fieldName });
        }
      } else {
        mappings.push({ targetVar: "text", sourceExpr: "text" });
      }

      project.edges[outputEdgeId] = {
        id: outputEdgeId,
        fromNode: terminalId,
        toNode: "output",
        mappings,
      };
    }
  }

  // Convert prompt tools to project tools
  for (const prompt of Object.values(prompts)) {
    if (prompt.tools) {
      for (const [toolId, toolDef] of Object.entries(prompt.tools)) {
        if (!(toolId in project.tools)) {
          project.tools[toolId] = {
            id: toolId,
            type: toolDef.type,
            module: toolDef.module,
            function: toolDef.function,
            path: toolDef.path,
            description: toolDef.description,
          };
        }
      }
    }
  }

  // Transform prompts with loop config into BranchNodes
  transformLoopPrompts(project);

  return project;
}

// ─── Main Loading Function ───────────────────────────────────

/**
 * Load a Harpoon project from a file or directory.
 *
 * Supports three modes:
 * 1. Manifest-based: Load from agent.tml / harpoon.tml / trident.tml / trident.yaml
 * 2. Prompt-first: Build from .prompt files when no manifest exists
 * 3. Augmented: Both exist, merge them
 */
export function loadProject(projectPath: string): Project {
  const resolved = path.resolve(projectPath);

  let manifestPath: string | null;
  let root: string;

  // If path is a file, load it directly
  if (existsSync(resolved) && statSync(resolved).isFile()) {
    manifestPath = resolved;
    root = path.dirname(resolved);
  } else {
    root = resolved;
    manifestPath = findManifest(root);

    // Try prompt-first loading if no manifest found
    if (manifestPath === null) {
      loadDotenv(path.join(root, ".env"));
      return buildProjectFromPrompts(root);
    }
  }

  // Load .env file if present
  loadDotenv(path.join(root, ".env"));

  let manifestText: string;
  try {
    manifestText = readFileSync(manifestPath, "utf-8");
  } catch (e) {
    throw new ParseError(
      `Cannot read ${path.basename(manifestPath)}: ${e instanceof Error ? e.message : String(e)}`
    );
  }

  let manifest: Record<string, unknown>;
  try {
    manifest = parseYaml(manifestText);
  } catch (e) {
    throw new ParseError(
      `Cannot parse ${path.basename(manifestPath)}: ${e instanceof Error ? e.message : String(e)}`
    );
  }

  // Support both harpoon: and trident: version fields
  const versionField = manifest["harpoon"] ?? manifest["trident"];
  if (!versionField) {
    throw new ValidationError(
      "Missing 'harpoon' (or 'trident') version in manifest"
    );
  }
  if (!manifest["name"]) {
    throw new ValidationError("Missing 'name' in manifest");
  }

  // Check version compatibility
  const requiredVersion = String(versionField);
  checkVersion(
    requiredVersion,
    VERSION,
    `Manifest '${path.basename(manifestPath)}'`
  );

  const defaults = (manifest["defaults"] as ModelDefaults) ?? {};

  const project: Project = {
    name: manifest["name"] as string,
    root,
    version: (manifest["version"] as string) ?? "0.1",
    description: (manifest["description"] as string) ?? "",
    defaults,
    entrypoints: (manifest["entrypoints"] as string[]) ?? [],
    edges: {},
    prompts: {},
    inputNodes: {},
    outputNodes: {},
    tools: {},
    agents: {},
    branches: {},
    maps: {},
    triggers: {},
    env: {},
  };

  // Parse orchestration config
  if (manifest["orchestration"]) {
    project.orchestration = orchestrationConfigFromDict(
      manifest["orchestration"] as Record<string, unknown>
    );
  }

  // Parse env declarations
  if (manifest["env"]) {
    project.env = manifest["env"] as Record<string, Record<string, unknown>>;
  }

  // Parse nodes
  if (manifest["nodes"]) {
    const nodes = manifest["nodes"] as Record<string, Record<string, unknown>>;
    for (const [nodeId, nodeSpec] of Object.entries(nodes)) {
      if (typeof nodeSpec !== "object" || nodeSpec === null) continue;
      const nodeType = (nodeSpec["type"] as string) ?? "prompt";

      if (nodeType === "input") {
        const inputNode: InputNode = { id: nodeId, schema: {} };
        if (nodeSpec["schema"]) {
          const schemaSpec = nodeSpec["schema"] as Record<
            string,
            Record<string, unknown>
          >;
          for (const [fname, fspec] of Object.entries(schemaSpec)) {
            if (typeof fspec === "object" && fspec !== null) {
              const ftype = (fspec["type"] as string) ?? "string";
              const fdesc = (fspec["description"] as string) ?? "";
              inputNode.schema[fname] = [ftype, fdesc];
            } else {
              throw new ValidationError(
                `Invalid schema field '${fname}' in node '${nodeId}': ` +
                  `expected dict with 'type' and 'description', got ${typeof fspec}`
              );
            }
          }
        }
        project.inputNodes[nodeId] = inputNode;
      } else if (nodeType === "output") {
        project.outputNodes[nodeId] = {
          id: nodeId,
          format: (nodeSpec["format"] as string) ?? "json",
        };
      } else if (nodeType === "tool") {
        throw new ValidationError(
          `Node '${nodeId}' has type 'tool', but tools must be defined ` +
            `in the 'tools:' section at the bottom of the manifest, not in 'nodes:'.\n` +
            `\n` +
            `Move this definition to the tools section:\n` +
            `\n` +
            `  tools:\n` +
            `    ${nodeId}:\n` +
            `      type: typescript\n` +
            `      module: <module_name>\n` +
            `      function: <function_name>\n` +
            `\n` +
            `Then reference it in edges by using '${nodeId}' as the from/to node.`
        );
      } else if (nodeType === "agent") {
        // Parse agent node
        const mcpServers: Record<string, MCPServerConfig> = {};
        if (nodeSpec["mcp_servers"]) {
          const serversSpec = nodeSpec["mcp_servers"] as Record<
            string,
            Record<string, unknown>
          >;
          for (const [serverName, serverSpec] of Object.entries(serversSpec)) {
            if (typeof serverSpec === "object" && serverSpec !== null) {
              mcpServers[serverName] = {
                command: (serverSpec["command"] as string) ?? "",
                args: (serverSpec["args"] as string[]) ?? [],
                env:
                  (serverSpec["env"] as Record<string, string>) ?? {},
              };
            }
          }
        }

        // Parse allowed_tools
        const allowedToolsRaw = nodeSpec["allowed_tools"] ?? "__unset__";
        let allowedTools: string[] | string | null | "__unset__";
        if (allowedToolsRaw === "__unset__") {
          allowedTools = "__unset__";
        } else if (allowedToolsRaw === "*") {
          allowedTools = null;
        } else if (Array.isArray(allowedToolsRaw)) {
          allowedTools = allowedToolsRaw.length > 0
            ? allowedToolsRaw.map(String)
            : [];
        } else if (typeof allowedToolsRaw === "string") {
          allowedTools = [allowedToolsRaw];
        } else {
          allowedTools = [];
        }

        // Get execution_mode
        const executionMode =
          (nodeSpec["execution_mode"] as string) ??
          (defaults.executionMode as string) ??
          "cli";
        if (executionMode !== "cli" && executionMode !== "sdk") {
          throw new ValidationError(
            `Agent node '${nodeId}' has invalid execution_mode '${executionMode}'. ` +
              `Must be 'cli' or 'sdk'.`
          );
        }

        // Parse max_turns
        const maxTurnsRaw = nodeSpec["max_turns"] ?? "__unset__";
        let maxTurns: number | string | null | "__unset__";
        if (maxTurnsRaw === "__unset__") {
          maxTurns = "__unset__";
        } else if (maxTurnsRaw === "*") {
          maxTurns = null;
        } else {
          maxTurns = maxTurnsRaw ? Number(maxTurnsRaw) : 50;
        }

        // Parse timeout and permission_mode
        let timeoutRaw: number | string | null =
          (nodeSpec["timeout"] as number | string) ?? "__unset__";
        let permissionModeRaw: string | null =
          (nodeSpec["permission_mode"] as string) ?? "__unset__";
        let effortRaw: string | null =
          (nodeSpec["effort"] as string) ?? "__unset__";

        // Load prompt file to resolve defaults
        const promptPathStr =
          (nodeSpec["prompt"] as string) ?? `prompts/${nodeId}.prompt`;
        const promptFullPath = path.join(root, promptPathStr);
        let promptNode: PromptNode | null = null;
        if (existsSync(promptFullPath)) {
          try {
            promptNode = parsePromptFile(promptFullPath);
          } catch {
            // Will be handled at execution time
          }
        }

        // Resolve values: YAML > frontmatter > system default
        if (timeoutRaw === "__unset__") {
          if (promptNode && promptNode.timeout) {
            timeoutRaw = promptNode.timeout;
          } else {
            timeoutRaw = 1200;
          }
        }
        if (permissionModeRaw === "__unset__") {
          if (promptNode && promptNode.permissionMode) {
            permissionModeRaw = promptNode.permissionMode;
          } else {
            permissionModeRaw = "acceptEdits";
          }
        }
        if (effortRaw === "__unset__") {
          effortRaw = promptNode?.effort ?? null;
        }
        if (
          effortRaw !== null &&
          !VALID_EFFORT_LEVELS.includes(
            effortRaw as (typeof VALID_EFFORT_LEVELS)[number]
          )
        ) {
          throw new ValidationError(
            `Agent node '${nodeId}' has invalid effort '${effortRaw}'. ` +
              `Must be one of: ${VALID_EFFORT_LEVELS.join(", ")}.`
          );
        }
        if (maxTurns === "__unset__") {
          if (promptNode && promptNode.maxTurns === null) {
            maxTurns = null;
          } else if (promptNode && promptNode.maxTurns !== null) {
            maxTurns = promptNode.maxTurns;
          } else {
            maxTurns = 50;
          }
        }
        if (allowedTools === "__unset__") {
          if (promptNode && promptNode.allowedTools === null) {
            allowedTools = null;
          } else if (
            promptNode &&
            Array.isArray(promptNode.allowedTools)
          ) {
            allowedTools = promptNode.allowedTools;
          } else if (
            promptNode &&
            typeof promptNode.allowedTools === "string"
          ) {
            allowedTools = [promptNode.allowedTools];
          } else {
            allowedTools = [];
          }
        }

        project.agents[nodeId] = {
          id: nodeId,
          promptPath: promptPathStr,
          model:
            (nodeSpec["model"] as string | undefined) ??
            promptNode?.model ??
            defaults.model ??
            null,
          allowedTools,
          mcpServers,
          maxTurns,
          permissionMode: permissionModeRaw,
          effort: effortRaw,
          cwd: (nodeSpec["cwd"] as string) ?? null,
          executionMode,
          timeout: timeoutRaw,
          promptNode,
        };
      } else if (nodeType === "branch") {
        const workflowPath = (nodeSpec["workflow"] as string) ?? "";
        if (!workflowPath) {
          throw new ValidationError(
            `Branch node '${nodeId}' missing required 'workflow' path`
          );
        }

        project.branches[nodeId] = {
          id: nodeId,
          workflowPath,
          condition: (nodeSpec["condition"] as string) ?? null,
          loopWhile: (nodeSpec["loop_while"] as string) ?? null,
          maxIterations: (nodeSpec["max_iterations"] as number) ?? 10,
        };
      } else if (nodeType === "map") {
        const workflowPath = (nodeSpec["workflow"] as string) ?? "";
        if (!workflowPath) {
          throw new ValidationError(
            `Map node '${nodeId}' missing required 'workflow' path`
          );
        }
        const overField = (nodeSpec["over"] as string) ?? "";
        if (!overField) {
          throw new ValidationError(
            `Map node '${nodeId}' missing required 'over' field`
          );
        }
        const onError = (nodeSpec["on_error"] as string) ?? "fail";
        if (!["fail", "skip", "collect"].includes(onError)) {
          throw new ValidationError(
            `Map node '${nodeId}' has invalid on_error '${onError}'. ` +
              `Must be 'fail', 'skip', or 'collect'.`
          );
        }

        project.maps[nodeId] = {
          id: nodeId,
          workflowPath,
          over: overField,
          maxConcurrency: (nodeSpec["max_concurrency"] as number) ?? 0,
          onError,
          itemCondition: (nodeSpec["item_condition"] as string) ?? null,
        };
      } else if (nodeType === "trigger") {
        const workflowPath = (nodeSpec["workflow"] as string) ?? "";
        if (!workflowPath) {
          throw new ValidationError(
            `Trigger node '${nodeId}' missing required 'workflow' path`
          );
        }

        project.triggers[nodeId] = {
          id: nodeId,
          workflowPath,
          passOutputs: (nodeSpec["pass_outputs"] as boolean) ?? true,
          emitSignal: (nodeSpec["emit_signal"] as boolean) ?? true,
          condition: (nodeSpec["condition"] as string) ?? null,
        };
      }
    }
  }

  // Parse edges
  if (manifest["edges"]) {
    const edgesSpec = manifest["edges"] as Record<
      string,
      Record<string, unknown>
    >;
    for (const [edgeId, edgeSpec] of Object.entries(edgesSpec)) {
      if (typeof edgeSpec !== "object" || edgeSpec === null) continue;
      const edge: Edge = {
        id: edgeId,
        fromNode: (edgeSpec["from"] as string) ?? "",
        toNode: (edgeSpec["to"] as string) ?? "",
        mappings: [],
        condition: (edgeSpec["condition"] as string) ?? null,
      };
      if (edgeSpec["mapping"]) {
        const mapping = edgeSpec["mapping"] as Record<string, unknown>;
        for (const [target, source] of Object.entries(mapping)) {
          edge.mappings.push({
            targetVar: target,
            sourceExpr: String(source),
          });
        }
      }
      project.edges[edgeId] = edge;
    }
  }

  // Parse tools
  if (manifest["tools"]) {
    const toolsSpec = manifest["tools"] as Record<
      string,
      Record<string, unknown>
    >;
    for (const [toolId, toolSpec] of Object.entries(toolsSpec)) {
      if (typeof toolSpec !== "object" || toolSpec === null) continue;
      project.tools[toolId] = {
        id: toolId,
        type: (toolSpec["type"] as string) ?? "typescript",
        path: (toolSpec["path"] as string) ?? undefined,
        module: (toolSpec["module"] as string) ?? undefined,
        function: (toolSpec["function"] as string) ?? undefined,
        description: (toolSpec["description"] as string) ?? "",
      };
    }
  }

  // Discover and parse prompt files
  const promptsDir = path.join(root, "prompts");
  if (existsSync(promptsDir)) {
    const promptFiles = readdirSync(promptsDir).filter((f) =>
      f.endsWith(".prompt")
    );
    for (const promptFile of promptFiles) {
      const fullPath = path.join(promptsDir, promptFile);
      try {
        const node = parsePromptFile(fullPath);
        project.prompts[node.id] = node;
      } catch (e) {
        if (e instanceof ParseError) throw e;
        throw new ParseError(
          `Error parsing ${fullPath}: ${e instanceof Error ? e.message : String(e)}`
        );
      }
    }
  }

  // Augment with prompt frontmatter overrides
  augmentFromPrompts(project);

  // Create implicit input/output nodes if referenced but not defined
  const allFromNodes = new Set<string>();
  const allToNodes = new Set<string>();
  for (const edge of Object.values(project.edges)) {
    allFromNodes.add(edge.fromNode);
    allToNodes.add(edge.toNode);
  }

  const knownNodes = new Set([
    ...Object.keys(project.prompts),
    ...Object.keys(project.inputNodes),
    ...Object.keys(project.outputNodes),
    ...Object.keys(project.tools),
    ...Object.keys(project.agents),
    ...Object.keys(project.branches),
    ...Object.keys(project.maps),
    ...Object.keys(project.triggers),
  ]);

  for (const nodeId of allFromNodes) {
    if (!knownNodes.has(nodeId)) {
      project.inputNodes[nodeId] = { id: nodeId, schema: {} };
      knownNodes.add(nodeId);
    }
  }

  for (const nodeId of allToNodes) {
    if (!knownNodes.has(nodeId)) {
      project.outputNodes[nodeId] = { id: nodeId, format: "json" };
    }
  }

  // Default entrypoint
  if (
    project.entrypoints.length === 0 &&
    Object.keys(project.inputNodes).length > 0
  ) {
    project.entrypoints = [Object.keys(project.inputNodes)[0]];
  }

  return project;
}
