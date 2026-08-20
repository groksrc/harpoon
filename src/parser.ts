/** Parser for .prompt files (frontmatter + body). */

import { readFileSync } from "node:fs";
import * as yaml from "js-yaml";

import { VERSION } from "./version.js";
import { ParseError, checkVersion } from "./errors.js";

/** Input field definition. */
export interface InputField {
  name: string;
  type: string;
  description: string;
  required: boolean;
  default?: unknown;
}

/** Output schema definition. */
export interface OutputSchema {
  format: string; // "text" or "json"
  fields: Record<string, [string, string]>; // name -> [type, description]
}

/** Loop configuration for prompt nodes. */
export interface LoopConfig {
  whileCondition: string;
  maxIterations: number;
}

/** Conditional next prompt configuration. */
export interface NextCondition {
  prompt: string;
  condition: string | null;
}

/** Tool definition in prompt frontmatter. */
export interface PromptToolDef {
  type: string; // "python", "shell", "http"
  module?: string;
  function?: string;
  path?: string;
  description: string;
}

/** Parsed .prompt file. */
export interface PromptNode {
  id: string;
  harpoonVersion: string;
  name: string;
  description: string;
  model: string | null;
  temperature: number | null;
  maxTokens: number | null;
  timeout: number | null;
  inputs: Record<string, InputField>;
  output: OutputSchema;
  body: string;
  filePath: string | null;
  maxTurns: number | null;
  allowedTools: string[] | string | null;
  permissionMode: string | null;
  effort: string | null;
  entrypoint: boolean;
  next: string | NextCondition[] | null;
  loop: LoopConfig | null;
  tools: Record<string, PromptToolDef> | null;
}

/** MCP server configuration for agent nodes. */
export interface MCPServerConfig {
  command: string;
  args: string[];
  env: Record<string, string>;
}

/**
 * Agent node definition - executes via Claude CLI or Agent SDK.
 *
 * The executionMode controls which backend is used:
 * - "cli": Claude CLI (default - uses existing Claude subscription)
 * - "sdk": Claude Agent SDK (requires API key, pay-per-token)
 */
export interface AgentNode {
  id: string;
  promptPath: string;
  /** Claude model or alias to pass to the CLI (for example, "sonnet"). */
  model?: string | null;
  allowedTools: string[] | string | null | "__unset__";
  mcpServers: Record<string, MCPServerConfig>;
  maxTurns: number | string | null | "__unset__";
  permissionMode: string | null;
  effort: string | null;
  cwd: string | null;
  executionMode: string; // "cli" or "sdk"
  timeout: number | string | null;
  promptNode: PromptNode | null;
}

/**
 * Branch node definition - calls sub-workflows with optional looping.
 */
export interface BranchNode {
  id: string;
  workflowPath: string;
  condition: string | null;
  loopWhile: string | null;
  maxIterations: number;
}

/**
 * Map node definition - fans out over a collection in parallel.
 */
export interface MapNode {
  id: string;
  workflowPath: string;
  over: string;
  maxConcurrency: number;
  onError: string; // "fail", "skip", "collect"
  itemCondition: string | null;
}

/**
 * Trigger node definition - runs downstream workflows.
 */
export interface TriggerNode {
  id: string;
  workflowPath: string;
  passOutputs: boolean;
  emitSignal: boolean;
  condition: string | null;
}

/** Parse YAML text into a record. Uses js-yaml safe_load. */
export function parseYaml(text: string): Record<string, unknown> {
  const result = yaml.load(text) as Record<string, unknown> | null;
  return result ?? {};
}

function parseNext(
  nextRaw: unknown,
  path: string
): string | NextCondition[] | null {
  if (nextRaw === undefined || nextRaw === null) {
    return null;
  }

  if (typeof nextRaw === "string") {
    return nextRaw;
  }

  if (Array.isArray(nextRaw)) {
    const conditions: NextCondition[] = [];
    for (const item of nextRaw) {
      if (typeof item === "object" && item !== null && !Array.isArray(item)) {
        const dict = item as Record<string, unknown>;
        if (!("prompt" in dict)) {
          throw new ParseError(
            `Invalid 'next' item in ${path}: missing 'prompt' field`
          );
        }
        conditions.push({
          prompt: dict.prompt as string,
          condition: (dict.condition as string) ?? null,
        });
      } else if (typeof item === "string") {
        conditions.push({ prompt: item, condition: null });
      } else {
        throw new ParseError(
          `Invalid 'next' item in ${path}: expected object or string, ` +
            `got ${typeof item}`
        );
      }
    }
    return conditions;
  }

  throw new ParseError(
    `Invalid 'next' value in ${path}: expected string or array, ` +
      `got ${typeof nextRaw}`
  );
}

function parseLoop(
  loopRaw: unknown,
  path: string
): LoopConfig | null {
  if (loopRaw === undefined || loopRaw === null) {
    return null;
  }

  if (typeof loopRaw !== "object" || Array.isArray(loopRaw)) {
    throw new ParseError(
      `Invalid 'loop' value in ${path}: expected object, got ${typeof loopRaw}`
    );
  }

  const dict = loopRaw as Record<string, unknown>;
  if (!("while" in dict)) {
    throw new ParseError(
      `Invalid 'loop' in ${path}: missing required 'while' condition`
    );
  }

  return {
    whileCondition: String(dict.while),
    maxIterations: Number(dict.max_iterations ?? 10),
  };
}

function parseTools(
  toolsRaw: unknown,
  path: string
): Record<string, PromptToolDef> | null {
  if (toolsRaw === undefined || toolsRaw === null) {
    return null;
  }

  if (typeof toolsRaw !== "object" || Array.isArray(toolsRaw)) {
    throw new ParseError(
      `Invalid 'tools' value in ${path}: expected object, got ${typeof toolsRaw}`
    );
  }

  const dict = toolsRaw as Record<string, unknown>;
  const tools: Record<string, PromptToolDef> = {};

  for (const [toolId, toolSpec] of Object.entries(dict)) {
    if (typeof toolSpec !== "object" || toolSpec === null || Array.isArray(toolSpec)) {
      throw new ParseError(
        `Invalid tool '${toolId}' in ${path}: expected object, ` +
          `got ${typeof toolSpec}`
      );
    }
    const spec = toolSpec as Record<string, unknown>;
    tools[toolId] = {
      type: (spec.type as string) ?? "python",
      module: spec.module as string | undefined,
      function: spec.function as string | undefined,
      path: spec.path as string | undefined,
      description: (spec.description as string) ?? "",
    };
  }

  return tools;
}

/**
 * Parse a .prompt file into a PromptNode.
 *
 * Format:
 *   ---
 *   <frontmatter: YAML>
 *   ---
 *   <body: template text>
 */
export function parsePromptFile(filePath: string): PromptNode {
  let content: string;
  try {
    content = readFileSync(filePath, "utf-8");
  } catch (e) {
    throw new ParseError(
      `Cannot read ${filePath}: ${e instanceof Error ? e.message : String(e)}`
    );
  }

  // Split frontmatter and body
  const parts = content.split(/^---\s*$/m);

  if (parts.length < 3) {
    throw new ParseError(
      `Invalid .prompt format in ${filePath}: missing frontmatter delimiters`
    );
  }

  const frontmatterText = parts[1].trim();
  const body = parts.slice(2).join("---").trim();

  // Parse frontmatter
  let fm: Record<string, unknown>;
  try {
    fm = parseYaml(frontmatterText);
  } catch (e) {
    throw new ParseError(
      `Invalid YAML in ${filePath}: ${e instanceof Error ? e.message : String(e)}`
    );
  }

  if (!("id" in fm)) {
    throw new ParseError(`Missing required 'id' in ${filePath}`);
  }

  // Support both harpoon: and trident: version fields for backward compat
  const requiredVersion = String(fm.harpoon ?? fm.trident ?? "");
  if (!requiredVersion) {
    throw new ParseError(
      `Missing required 'harpoon' (or 'trident') version in ${filePath}`
    );
  }

  // Check version compatibility
  checkVersion(requiredVersion, VERSION, `Prompt '${filePath}'`);

  // Parse workflow fields
  const entrypoint = Boolean(fm.entrypoint ?? false);
  const nextSpec = parseNext(fm.next, filePath);
  const loopConfig = parseLoop(fm.loop, filePath);
  const toolsConfig = parseTools(fm.tools, filePath);

  // Build PromptNode
  const node: PromptNode = {
    id: fm.id as string,
    harpoonVersion: requiredVersion,
    name: (fm.name as string) ?? "",
    description: (fm.description as string) ?? "",
    model: (fm.model as string) ?? null,
    temperature: (fm.temperature as number) ?? null,
    maxTokens: (fm.max_tokens as number) ?? null,
    body,
    filePath,
    timeout: (fm.timeout as number) ?? null,
    maxTurns: (fm.max_turns as number) ?? null,
    allowedTools: (fm.allowed_tools as string[] | string) ?? null,
    permissionMode: (fm.permission_mode as string) ?? null,
    effort: (fm.effort as string) ?? null,
    entrypoint,
    next: nextSpec,
    loop: loopConfig,
    tools: toolsConfig,
    inputs: {},
    output: { format: "text", fields: {} },
  };

  // Parse inputs
  const inputRaw = fm.input;
  if (typeof inputRaw === "object" && inputRaw !== null && !Array.isArray(inputRaw)) {
    for (const [name, spec] of Object.entries(inputRaw as Record<string, unknown>)) {
      if (typeof spec === "object" && spec !== null && !Array.isArray(spec)) {
        const s = spec as Record<string, unknown>;
        node.inputs[name] = {
          name,
          type: (s.type as string) ?? "string",
          description: (s.description as string) ?? "",
          required: (s.required as boolean) ?? true,
          default: s.default,
        };
      } else {
        node.inputs[name] = {
          name,
          type: "string",
          description: "",
          required: true,
        };
      }
    }
  }

  // Parse output
  const outputRaw = fm.output;
  if (typeof outputRaw === "object" && outputRaw !== null && !Array.isArray(outputRaw)) {
    const outSpec = outputRaw as Record<string, unknown>;
    node.output = {
      format: (outSpec.format as string) ?? "text",
      fields: {},
    };
    const schemaRaw = outSpec.schema;
    if (typeof schemaRaw === "object" && schemaRaw !== null && !Array.isArray(schemaRaw)) {
      for (const [fname, fspec] of Object.entries(schemaRaw as Record<string, unknown>)) {
        if (typeof fspec === "object" && fspec !== null && !Array.isArray(fspec)) {
          const fs = fspec as Record<string, unknown>;
          const fieldType = (fs.type as string) ?? "string";
          const fieldDesc = (fs.description as string) ?? "";
          node.output.fields[fname] = [fieldType, fieldDesc];
        } else {
          throw new ParseError(
            `Invalid schema field '${fname}' in ${filePath}: ` +
              `expected object with 'type' and 'description', got ${typeof fspec}`
          );
        }
      }
    }
  }

  return node;
}
