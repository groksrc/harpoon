/**
 * Agent node execution via Claude CLI.
 *
 * Provides an alternative to the Claude Agent SDK by using the
 * Claude CLI (`claude -p`) for agent execution. This uses your existing
 * Claude subscription instead of API tokens, reducing operational costs.
 *
 * Features:
 * - Real-time telemetry via --output-format stream-json
 * - Tool call visibility during execution
 * - Session resumption support
 */

import { spawn, execSync, spawnSync, type ChildProcess } from "node:child_process";

import { HarpoonError } from "./errors.js";
import type { AgentNode } from "./parser.js";
import { render } from "./template.js";
import { parseJsonResponse } from "./agents.js";
import type { AgentResult } from "./agents.js";

/** Error during CLI-based agent execution. */
export class CLIAgentError extends HarpoonError {
  constructor(message: string) {
    super(message);
    this.name = "CLIAgentError";
  }
}

/** Type alias for telemetry callback. */
export type TelemetryCallback = (
  hookType: string,
  toolName: string,
  data: Record<string, unknown>
) => void;

// Harpoon types -> JSON Schema types
const TYPE_MAP: Record<string, string> = {
  str: "string",
  string: "string",
  int: "integer",
  integer: "integer",
  float: "number",
  number: "number",
  bool: "boolean",
  boolean: "boolean",
  list: "array",
  array: "array",
  dict: "object",
  object: "object",
};

// ─── JSON Schema for CLI ─────────────────────────────────────

function buildJsonSchema(outputSchema: {
  format: string;
  fields: Record<string, [string, string]>;
}): Record<string, unknown> {
  if (!outputSchema.fields || Object.keys(outputSchema.fields).length === 0) {
    return { type: "object", description: "JSON response from agent" };
  }

  const properties: Record<string, Record<string, string>> = {};
  const required: string[] = [];
  for (const [name, [ftype, desc]] of Object.entries(outputSchema.fields)) {
    properties[name] = {
      type: TYPE_MAP[ftype.toLowerCase()] ?? "string",
      description: desc,
    };
    required.push(name);
  }

  return { type: "object", properties, required };
}

// ─── MCP Config ──────────────────────────────────────────────

function buildMcpConfig(
  mcpServers: AgentNode["mcpServers"]
): Record<string, unknown> {
  const config: Record<string, unknown> = { mcpServers: {} };
  const servers = config["mcpServers"] as Record<string, unknown>;

  for (const [serverName, serverConfig] of Object.entries(mcpServers)) {
    // Expand environment variables in server env
    const serverEnv: Record<string, string> = {};
    for (const [key, value] of Object.entries(serverConfig.env)) {
      if (value.startsWith("${") && value.endsWith("}")) {
        const envVar = value.slice(2, -1);
        serverEnv[key] = process.env[envVar] ?? "";
      } else {
        serverEnv[key] = value;
      }
    }

    const serverDict: Record<string, unknown> = {
      command: serverConfig.command,
      args: serverConfig.args,
    };
    if (Object.keys(serverEnv).length > 0) {
      serverDict["env"] = serverEnv;
    }
    servers[serverName] = serverDict;
  }

  return config;
}

// ─── CLI Availability Check ──────────────────────────────────

/** Check if Claude CLI is available and return the path. */
export function checkCliAvailable(): string {
  try {
    const result = execSync("which claude", {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
    if (result) return result;
  } catch {
    // Fall through
  }

  throw new CLIAgentError(
    "Claude CLI not found. Install with: npm install -g @anthropic-ai/claude-code\n" +
      "Or use execution_mode: sdk in your manifest to use the Agent SDK instead."
  );
}

// ─── Token Extraction ────────────────────────────────────────

function extractTokens(cliOutput: Record<string, unknown>): Record<string, number> {
  const tokens: Record<string, number> = {};
  if (cliOutput["usage"]) {
    const usage = cliOutput["usage"] as Record<string, number>;
    if ("input_tokens" in usage) tokens["input"] = usage["input_tokens"];
    else if ("input" in usage) tokens["input"] = usage["input"];
    if ("output_tokens" in usage) tokens["output"] = usage["output_tokens"];
    else if ("output" in usage) tokens["output"] = usage["output"];
  }
  return tokens;
}

// ─── CLI Output Parsing ──────────────────────────────────────

function parseCLIOutput(
  cliOutput: Record<string, unknown>,
  agentNode: AgentNode
): AgentResult {
  const tokens = extractTokens(cliOutput);

  const outputSchema = agentNode.promptNode!.output;
  let output: Record<string, unknown>;

  if (outputSchema.format === "json") {
    if (cliOutput["structured_output"]) {
      output = cliOutput["structured_output"] as Record<string, unknown>;
    } else {
      const responseText = (cliOutput["result"] as string) ?? "";
      try {
        output = parseJsonResponse(responseText);
      } catch (e) {
        throw new CLIAgentError(
          `Agent '${agentNode.id}' returned invalid JSON. ` +
            `CLI output: ${JSON.stringify(cliOutput, null, 2).slice(0, 1000)}`
        );
      }
    }
  } else {
    const responseText = (cliOutput["result"] as string) ?? "";
    output = { text: responseText };
  }

  return {
    output,
    sessionId: cliOutput["session_id"] as string | undefined,
    numTurns: (cliOutput["num_turns"] as number) ?? 0,
    costUsd: cliOutput["total_cost_usd"] as number | undefined,
    tokens,
  };
}

// ─── Process CLI Result ──────────────────────────────────────

function processCliResult(
  stdout: string,
  stderr: string,
  exitCode: number,
  agentNode: AgentNode
): AgentResult {
  if (exitCode !== 0) {
    const errorMsg = stderr.trim() || "Unknown error";
    throw new CLIAgentError(
      `Agent '${agentNode.id}' CLI execution failed (exit ${exitCode}): ${errorMsg}`
    );
  }

  let cliOutput: Record<string, unknown>;
  try {
    cliOutput = JSON.parse(stdout);
  } catch (e) {
    throw new CLIAgentError(
      `Agent '${agentNode.id}' returned invalid JSON. ` +
        `Output preview: ${stdout.slice(0, 500)}`
    );
  }

  if (cliOutput["is_error"]) {
    const errorResult = (cliOutput["result"] as string) ?? "Unknown CLI error";
    throw new CLIAgentError(
      `Agent '${agentNode.id}' CLI reported error: ${errorResult}`
    );
  }

  // Check for error subtypes that indicate incomplete execution
  const subtype = cliOutput["subtype"] as string | undefined;
  if (subtype?.startsWith("error_")) {
    const cost = cliOutput["total_cost_usd"] ?? "unknown";
    throw new CLIAgentError(
      `Agent '${agentNode.id}' stopped: ${subtype} (cost: $${cost}). ` +
        `The agent was terminated before producing a result.`
    );
  }

  return parseCLIOutput(cliOutput, agentNode);
}

// ─── Stream JSON Event Processing ────────────────────────────

/** Extract text content from an assistant message's content field. */
function extractTextContent(content: unknown): string | null {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const texts: string[] = [];
    for (const item of content) {
      if (item && typeof item === "object" && "type" in item) {
        const block = item as Record<string, unknown>;
        if (block.type === "text" && typeof block.text === "string") {
          texts.push(block.text);
        }
      }
    }
    return texts.length > 0 ? texts.join("\n") : null;
  }
  return null;
}

/** Extract tool_use blocks from an assistant message's content field. */
function extractToolUses(
  content: unknown
): Array<{ name: string; input: Record<string, unknown> }> {
  if (!Array.isArray(content)) return [];
  const tools: Array<{ name: string; input: Record<string, unknown> }> = [];
  for (const item of content) {
    if (item && typeof item === "object" && "type" in item) {
      const block = item as Record<string, unknown>;
      if (block.type === "tool_use") {
        tools.push({
          name: (block.name as string) ?? "",
          input: (block.input as Record<string, unknown>) ?? {},
        });
      }
    }
  }
  return tools;
}

/**
 * Process a single stream-json event and dispatch telemetry.
 * Returns the result event data if this is the final result, otherwise null.
 */
function processStreamEvent(
  event: Record<string, unknown>,
  onEvent: TelemetryCallback
): Record<string, unknown> | null {
  const eventType = event["type"] as string;

  if (eventType === "assistant") {
    const message = event["message"] as Record<string, unknown> | undefined;
    if (message?.content) {
      // Dispatch text content as Message events
      const text = extractTextContent(message.content);
      if (text?.trim()) {
        onEvent("Message", "", { message: text });
      }
      // Dispatch tool_use blocks as PreToolUse events
      for (const tool of extractToolUses(message.content)) {
        onEvent("PreToolUse", tool.name, tool.input);
      }
    }
  } else if (eventType === "tool_result") {
    const toolName = (event["tool_name"] as string) ?? "";
    onEvent("PostToolUse", toolName, {});
  } else if (eventType === "result") {
    return event;
  }

  return null;
}

// ─── Main Execution Function ─────────────────────────────────

/**
 * Execute an agent node using the Claude CLI.
 *
 * This provides a cost-effective alternative to the Agent SDK by using
 * your existing Claude subscription via the CLI.
 */
export async function executeAgentViaCli(
  agentNode: AgentNode,
  inputs: Record<string, unknown>,
  projectRoot: string,
  resumeSession?: string,
  onEvent?: TelemetryCallback
): Promise<AgentResult> {
  const claudePath = checkCliAvailable();

  if (!agentNode.promptNode) {
    throw new CLIAgentError(`Agent ${agentNode.id} has no prompt loaded`);
  }

  // Render the prompt with inputs
  const renderedPrompt = render(agentNode.promptNode.body, inputs);

  // Build CLI command
  const cmd: string[] = [
    claudePath,
    "-p",
    renderedPrompt,
    "--output-format",
    // Use stream-json for real-time telemetry, json for standard execution
    onEvent ? "stream-json" : "json",
  ];

  // stream-json requires --verbose
  if (onEvent) {
    cmd.push("--verbose");
  }

  // Add JSON schema for structured outputs
  const outputSchema = agentNode.promptNode.output;
  if (outputSchema.format === "json" && Object.keys(outputSchema.fields).length > 0) {
    const jsonSchema = buildJsonSchema(outputSchema);
    cmd.push("--json-schema", JSON.stringify(jsonSchema));
  }

  // Note: Claude CLI has no --max-turns flag. The max_turns setting from
  // the manifest is ignored for CLI mode. Use allowed_tools and prompt
  // design to keep agents focused. A future max_budget field could map
  // directly to --max-budget-usd.

  // Add permission mode
  if (agentNode.permissionMode) {
    const modeMap: Record<string, string> = {
      acceptEdits: "acceptEdits",
      bypassPermissions: "bypassPermissions",
      default: "default",
      plan: "plan",
    };
    const cliMode = modeMap[agentNode.permissionMode] ?? "default";
    cmd.push("--permission-mode", cliMode);
  }

  // Add effort level (--effort low|medium|high|xhigh|max)
  if (agentNode.effort) {
    cmd.push("--effort", agentNode.effort);
  }

  // Add tools configuration
  // --tools: sets the COMPLETE tool list ("*" for all, "" to disable all)
  // --allowedTools: adds to the default set (doesn't disable anything)
  if (
    agentNode.allowedTools === null ||
    agentNode.allowedTools === "__unset__" ||
    agentNode.allowedTools === "*"
  ) {
    // Allow all tools
    cmd.push("--tools", "*");
  } else if (
    Array.isArray(agentNode.allowedTools) &&
    agentNode.allowedTools.length > 0
  ) {
    cmd.push("--tools", agentNode.allowedTools.join(","));
  } else if (
    Array.isArray(agentNode.allowedTools) &&
    agentNode.allowedTools.length === 0
  ) {
    // Empty list = disable ALL tools
    cmd.push("--tools", '""');
  }

  // Add session resume
  if (resumeSession) {
    cmd.push("--resume", resumeSession);
  }

  // Determine working directory
  const cwd = agentNode.cwd ?? projectRoot;

  // Add MCP servers
  if (
    agentNode.mcpServers &&
    Object.keys(agentNode.mcpServers).length > 0
  ) {
    const mcpConfig = buildMcpConfig(agentNode.mcpServers);
    cmd.push("--mcp-config", JSON.stringify(mcpConfig));
  }

  // Build environment without ANTHROPIC_API_KEY so CLI uses subscription auth,
  // and without CLAUDECODE so nested CLI sessions are allowed
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (k !== "ANTHROPIC_API_KEY" && k !== "CLAUDECODE" && v !== undefined) {
      env[k] = v;
    }
  }

  // If telemetry callback provided, use streaming execution
  if (onEvent) {
    return executeWithStreaming(cmd, cwd, env, agentNode, onEvent);
  }

  // Standard synchronous execution
  return executeStandard(cmd, cwd, env, agentNode);
}

// ─── Standard Execution ──────────────────────────────────────

function executeStandard(
  cmd: string[],
  cwd: string,
  env: Record<string, string>,
  agentNode: AgentNode
): AgentResult {
  const timeout =
    typeof agentNode.timeout === "number" ? agentNode.timeout * 1000 : undefined;

  try {
    // Use spawnSync with args array to avoid shell interpretation of prompt text
    // stdin must be "ignore" — an open pipe blocks the Claude CLI
    const result = spawnSync(cmd[0], cmd.slice(1), {
      cwd,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout,
      env,
    });

    if (result.error) {
      throw new CLIAgentError(
        `Failed to execute Claude CLI: ${result.error.message}`
      );
    }

    return processCliResult(
      result.stdout ?? "",
      result.stderr ?? "",
      result.status ?? 1,
      agentNode
    );
  } catch (e: unknown) {
    if (e instanceof CLIAgentError) throw e;
    const err = e as { message?: string };
    throw new CLIAgentError(
      `Failed to execute Claude CLI: ${err.message ?? String(e)}`
    );
  }
}

// ─── Streaming Execution via stream-json ─────────────────────

/**
 * Execute CLI with --output-format stream-json for real-time telemetry.
 *
 * Parses newline-delimited JSON events from stdout as they arrive,
 * dispatching telemetry for assistant messages and tool calls.
 * The final "result" event is used to build the AgentResult.
 */
function executeWithStreaming(
  cmd: string[],
  cwd: string,
  env: Record<string, string>,
  agentNode: AgentNode,
  onEvent: TelemetryCallback
): Promise<AgentResult> {
  return new Promise<AgentResult>((resolve, reject) => {
    // Start the CLI process asynchronously
    // stdin must be "ignore" (not "pipe") — an open pipe blocks the CLI
    const child: ChildProcess = spawn(cmd[0], cmd.slice(1), {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env,
    });

    let stderr = "";
    let stdoutBuffer = "";
    let resultEvent: Record<string, unknown> | null = null;

    child.stderr?.setEncoding("utf-8");
    child.stderr?.on("data", (data: string) => {
      stderr += data;
    });

    // Parse stream-json events from stdout in real-time
    child.stdout?.setEncoding("utf-8");
    child.stdout?.on("data", (chunk: string) => {
      stdoutBuffer += chunk;

      // Process complete lines
      let newlineIdx: number;
      while ((newlineIdx = stdoutBuffer.indexOf("\n")) !== -1) {
        const line = stdoutBuffer.slice(0, newlineIdx).trim();
        stdoutBuffer = stdoutBuffer.slice(newlineIdx + 1);

        if (!line) continue;
        try {
          const event = JSON.parse(line) as Record<string, unknown>;
          const result = processStreamEvent(event, onEvent);
          if (result) {
            resultEvent = result;
          }
        } catch {
          // Skip malformed JSON lines
        }
      }
    });

    // Set up timeout if configured — SIGTERM first, SIGKILL after 5s grace period
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    let killHandle: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;

    if (typeof agentNode.timeout === "number") {
      timeoutHandle = setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
        killHandle = setTimeout(() => {
          if (!child.killed) {
            child.kill("SIGKILL");
          }
        }, 5_000);
      }, agentNode.timeout * 1000);
    }

    child.on("close", (exitCode: number | null) => {
      if (timeoutHandle) clearTimeout(timeoutHandle);
      if (killHandle) clearTimeout(killHandle);

      // Timeout-specific error — surface before generic exit-code handling
      if (timedOut && !resultEvent) {
        reject(
          new CLIAgentError(
            `Agent '${agentNode.id}' timed out after ${agentNode.timeout}s`
          )
        );
        return;
      }

      // Process any remaining data in buffer
      if (stdoutBuffer.trim()) {
        try {
          const event = JSON.parse(stdoutBuffer.trim()) as Record<string, unknown>;
          const result = processStreamEvent(event, onEvent);
          if (result) resultEvent = result;
        } catch {
          // Skip malformed trailing data
        }
      }

      // stream-json exits with code 1 but includes the result in the stream
      // Only treat as error if we have no result event at all
      if (!resultEvent) {
        if (exitCode !== 0) {
          reject(
            new CLIAgentError(
              `Agent '${agentNode.id}' CLI execution failed (exit ${exitCode}): ${stderr.trim() || "Unknown error"}`
            )
          );
          return;
        }
        reject(
          new CLIAgentError(
            `Agent '${agentNode.id}' produced no result event in stream`
          )
        );
        return;
      }

      // Check for errors in the result event
      if (resultEvent["is_error"]) {
        const errorResult = (resultEvent["result"] as string) ?? "Unknown CLI error";
        reject(
          new CLIAgentError(
            `Agent '${agentNode.id}' CLI reported error: ${errorResult}`
          )
        );
        return;
      }

      const subtype = resultEvent["subtype"] as string | undefined;
      if (subtype?.startsWith("error_")) {
        const cost = resultEvent["total_cost_usd"] ?? "unknown";
        reject(
          new CLIAgentError(
            `Agent '${agentNode.id}' stopped: ${subtype} (cost: $${cost}). ` +
              `The agent was terminated before producing a result.`
          )
        );
        return;
      }

      try {
        resolve(parseCLIOutput(resultEvent, agentNode));
      } catch (e) {
        reject(e);
      }
    });

    child.on("error", (err: Error) => {
      if (timeoutHandle) clearTimeout(timeoutHandle);
      if (killHandle) clearTimeout(killHandle);
      reject(new CLIAgentError(`Failed to execute Claude CLI: ${err.message}`));
    });
  });
}
