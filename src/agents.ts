/**
 * Agent node execution via Claude Agent SDK.
 *
 * This module provides async execution of agent nodes using the Claude Agent SDK.
 * Agents have access to tools and MCP servers for autonomous multi-turn execution.
 *
 * Requires: npm install @anthropic-ai/claude-agent-sdk (optional dependency)
 */

import { HarpoonError } from "./errors.js";
import type { AgentNode } from "./parser.js";
import { render } from "./template.js";

/** Type alias for message callbacks. */
export type MessageCallback = (messageType: string, content: unknown) => void;

/** Result from agent execution with usage metrics. */
export interface AgentResult {
  output: Record<string, unknown>;
  sessionId?: string;
  numTurns: number;
  costUsd?: number;
  tokens: Record<string, number>;
}

/** Error during agent execution. */
export class AgentExecutionError extends HarpoonError {
  constructor(message: string) {
    super(message);
    this.name = "AgentExecutionError";
  }
}

// SDK availability flag
let SDK_AVAILABLE = false;

// Try to check SDK availability at module load time
try {
  // Dynamic require check - will be resolved at runtime
  require.resolve("@anthropic-ai/claude-agent-sdk");
  SDK_AVAILABLE = true;
} catch {
  SDK_AVAILABLE = false;
}

/** Check if Claude Agent SDK is available. */
export function checkSdkAvailable(): void {
  if (!SDK_AVAILABLE) {
    throw new HarpoonError(
      "Claude Agent SDK not installed. Install with: npm install @anthropic-ai/claude-agent-sdk"
    );
  }
}

/** Check SDK availability status. */
export function isSdkAvailable(): boolean {
  return SDK_AVAILABLE;
}

// ─── JSON Schema Building ────────────────────────────────────

function buildJsonSchema(
  fields: Record<string, [string, string]>
): Record<string, unknown> {
  const typeMapping: Record<string, Record<string, string>> = {
    string: { type: "string" },
    number: { type: "number" },
    integer: { type: "integer" },
    boolean: { type: "boolean" },
    array: { type: "array" },
    object: { type: "object" },
  };

  const properties: Record<string, Record<string, string>> = {};
  for (const [fieldName, [fieldType, description]] of Object.entries(fields)) {
    const prop = { ...(typeMapping[fieldType] ?? { type: "string" }) };
    if (description) {
      prop["description"] = description;
    }
    properties[fieldName] = prop;
  }

  return {
    type: "object",
    properties,
    required: Object.keys(fields),
    additionalProperties: false,
  };
}

// ─── JSON Response Parsing ───────────────────────────────────

/** Parse JSON from agent response, handling markdown code blocks. */
export function parseJsonResponse(text: string): Record<string, unknown> {
  text = text.trim();

  // Try direct parse first
  try {
    const parsed = JSON.parse(text);
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      return parsed;
    }
    return { result: parsed };
  } catch {
    // Fall through
  }

  // Try ```json code block
  if (text.includes("```json")) {
    const start = text.indexOf("```json") + 7;
    const end = text.indexOf("```", start);
    if (end > start) {
      try {
        const parsed = JSON.parse(text.slice(start, end).trim());
        if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
          return parsed;
        }
        return { result: parsed };
      } catch {
        // Fall through
      }
    }
  }

  // Try plain ``` code block
  if (text.includes("```")) {
    let start = text.indexOf("```") + 3;
    const newline = text.indexOf("\n", start);
    if (newline > start && newline - start < 20) {
      start = newline + 1;
    }
    const end = text.indexOf("```", start);
    if (end > start) {
      try {
        const parsed = JSON.parse(text.slice(start, end).trim());
        if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
          return parsed;
        }
        return { result: parsed };
      } catch {
        // Fall through
      }
    }
  }

  // Try to find JSON object embedded in prose
  const braceStart = text.indexOf("{");
  if (braceStart >= 0) {
    let depth = 0;
    let inString = false;
    let escapeNext = false;
    for (let i = braceStart; i < text.length; i++) {
      const char = text[i];
      if (escapeNext) {
        escapeNext = false;
        continue;
      }
      if (char === "\\") {
        escapeNext = true;
        continue;
      }
      if (char === '"' && !escapeNext) {
        inString = !inString;
        continue;
      }
      if (inString) continue;
      if (char === "{") depth++;
      else if (char === "}") {
        depth--;
        if (depth === 0) {
          try {
            const parsed = JSON.parse(text.slice(braceStart, i + 1));
            if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
              return parsed;
            }
            return { result: parsed };
          } catch {
            // Fall through
          }
          break;
        }
      }
    }
  }

  throw new SyntaxError(
    "No valid JSON found in response. Expected raw JSON or markdown code block."
  );
}

// ─── Agent Output Validation ─────────────────────────────────

function validateAgentOutput(
  data: Record<string, unknown>,
  schema: Record<string, [string, string]>,
  agentId: string
): void {
  for (const [fieldName, [fieldType]] of Object.entries(schema)) {
    if (!(fieldName in data)) {
      throw new AgentExecutionError(
        `Agent '${agentId}' output missing required field: '${fieldName}'`
      );
    }

    const value = data[fieldName];
    const expectedTypes: Record<string, string | string[]> = {
      string: "string",
      number: "number",
      integer: "number",
      boolean: "boolean",
      array: "array",
      object: "object",
    };
    const expected = expectedTypes[fieldType];
    if (expected) {
      if (fieldType === "array" && !Array.isArray(value)) {
        throw new AgentExecutionError(
          `Agent '${agentId}' output field '${fieldName}' ` +
            `expected ${fieldType}, got ${typeof value}`
        );
      } else if (fieldType === "object") {
        if (
          typeof value !== "object" ||
          value === null ||
          Array.isArray(value)
        ) {
          throw new AgentExecutionError(
            `Agent '${agentId}' output field '${fieldName}' ` +
              `expected ${fieldType}, got ${typeof value}`
          );
        }
      } else if (
        typeof expected === "string" &&
        fieldType !== "array" &&
        fieldType !== "object"
      ) {
        if (typeof value !== expected) {
          throw new AgentExecutionError(
            `Agent '${agentId}' output field '${fieldName}' ` +
              `expected ${fieldType}, got ${typeof value}`
          );
        }
      }
    }
  }
}

// ─── Execute Agent (SDK) ─────────────────────────────────────

/**
 * Execute an agent node using the Claude Agent SDK.
 *
 * This is a stub that throws if the SDK is not available.
 * When the SDK is available, it will use the SDK for agent execution.
 */
export async function executeAgent(
  agentNode: AgentNode,
  inputs: Record<string, unknown>,
  projectRoot: string,
  resumeSession?: string,
  onMessage?: MessageCallback
): Promise<AgentResult> {
  checkSdkAvailable();

  if (!agentNode.promptNode) {
    throw new AgentExecutionError(
      `Agent ${agentNode.id} has no prompt loaded`
    );
  }

  // Render the prompt with inputs
  const renderedPrompt = render(agentNode.promptNode.body, inputs);

  // When SDK is available, this will use dynamic import
  // For now, throw with helpful message
  throw new AgentExecutionError(
    "Agent SDK execution not yet implemented in Harpoon. " +
      "Use execution_mode: cli in your manifest to use the Claude CLI instead."
  );
}

/**
 * Execute an agent node synchronously.
 *
 * Wrapper for the async executeAgent function.
 */
export function executeAgentSync(
  agentNode: AgentNode,
  inputs: Record<string, unknown>,
  projectRoot: string,
  resumeSession?: string,
  onMessage?: MessageCallback
): AgentResult {
  // Note: This would use a synchronous runner in production
  throw new AgentExecutionError(
    "Synchronous agent execution not available. Use executeAgent() instead."
  );
}
