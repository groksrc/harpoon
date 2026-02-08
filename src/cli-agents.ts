/**
 * Agent node execution via Claude CLI.
 *
 * Provides an alternative to the Claude Agent SDK by using the
 * Claude CLI (`claude -p`) for agent execution. This uses your existing
 * Claude subscription instead of API tokens, reducing operational costs.
 *
 * Features:
 * - Real-time telemetry streaming via Claude hooks
 * - Tool call visibility during execution
 * - Session resumption support
 */

import { spawn, execSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

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
          `Agent '${agentNode.id}' returned invalid JSON in response. ` +
            `Response preview: ${responseText.slice(0, 200)}`
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

  return parseCLIOutput(cliOutput, agentNode);
}

// ─── Dispatch Event ──────────────────────────────────────────

function dispatchEvent(
  eventData: Record<string, unknown>,
  onEvent: TelemetryCallback
): void {
  const hookType = (eventData["hook"] as string) ?? "";
  if (hookType === "Message") {
    onEvent(hookType, "", eventData);
  } else {
    onEvent(
      hookType,
      (eventData["tool"] as string) ?? "",
      (eventData["input"] as Record<string, unknown>) ?? {}
    );
  }
}

// ─── Hook Script Creation ────────────────────────────────────

function createHookScript(
  eventLogPath: string,
  stateFilePath: string
): string {
  return `#!/usr/bin/env node
// Harpoon telemetry hook - logs tool calls and messages for real-time monitoring
const fs = require('fs');
const path = require('path');

function getProcessedCount() {
  try {
    return parseInt(fs.readFileSync('${stateFilePath}', 'utf-8').trim() || '0', 10);
  } catch { return 0; }
}

function setProcessedCount(count) {
  fs.writeFileSync('${stateFilePath}', String(count));
}

try {
  let input = '';
  process.stdin.setEncoding('utf-8');
  process.stdin.on('data', (d) => { input += d; });
  process.stdin.on('end', () => {
    try {
      const data = JSON.parse(input);
      const hookEvent = data.hook_event_name || '';
      if (hookEvent === 'PreToolUse' || hookEvent === 'PostToolUse') {
        const event = {
          hook: hookEvent,
          tool: data.tool_name || '',
          input: data.tool_input || {}
        };
        fs.appendFileSync('${eventLogPath}', JSON.stringify(event) + '\\n');
      }
    } catch {}
    process.exit(0);
  });
} catch { process.exit(0); }
`;
}

function createHookSettings(hookScriptPath: string): Record<string, unknown> {
  const hookConfig = { type: "command", command: hookScriptPath };
  return {
    hooks: {
      PreToolUse: [{ matcher: ".*", hooks: [hookConfig] }],
      PostToolUse: [{ matcher: ".*", hooks: [hookConfig] }],
      Stop: [{ hooks: [hookConfig] }],
    },
  };
}

// ─── Main Execution Function ─────────────────────────────────

/**
 * Execute an agent node using the Claude CLI.
 *
 * This provides a cost-effective alternative to the Agent SDK by using
 * your existing Claude subscription via the CLI.
 */
export function executeAgentViaCli(
  agentNode: AgentNode,
  inputs: Record<string, unknown>,
  projectRoot: string,
  resumeSession?: string,
  onEvent?: TelemetryCallback
): AgentResult {
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
    "json",
  ];

  // Note: Claude CLI does not support --json-schema.
  // JSON output is handled by the prompt instructions and parsed from the response text.

  // Add max turns limit
  if (agentNode.maxTurns !== null && agentNode.maxTurns !== "__unset__") {
    cmd.push("--max-turns", String(agentNode.maxTurns));
  }

  // Add permission mode
  if (agentNode.permissionMode) {
    const modeMap: Record<string, string> = {
      acceptEdits: "default",
      bypassPermissions: "bypassPermissions",
      default: "default",
      plan: "plan",
    };
    const cliMode = modeMap[agentNode.permissionMode] ?? "default";
    cmd.push("--permission-mode", cliMode);
  }

  // Add allowed tools
  if (
    agentNode.allowedTools === null ||
    agentNode.allowedTools === "__unset__"
  ) {
    // Allow all tools
  } else if (
    Array.isArray(agentNode.allowedTools) &&
    agentNode.allowedTools.length > 0
  ) {
    cmd.push("--allowedTools", agentNode.allowedTools.join(","));
  } else if (
    Array.isArray(agentNode.allowedTools) &&
    agentNode.allowedTools.length === 0
  ) {
    cmd.push("--allowedTools", "");
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

  // Build environment without ANTHROPIC_API_KEY so CLI uses subscription auth
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (k !== "ANTHROPIC_API_KEY" && v !== undefined) {
      env[k] = v;
    }
  }

  // If telemetry callback provided, use streaming execution with hooks
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
    const result = spawnSync(cmd[0], cmd.slice(1), {
      cwd,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
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

// ─── Streaming Execution with Hooks ──────────────────────────

function executeWithStreaming(
  cmd: string[],
  cwd: string,
  env: Record<string, string>,
  agentNode: AgentNode,
  onEvent: TelemetryCallback
): AgentResult {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "harpoon_hooks_"));
  const eventLogPath = path.join(tempDir, "events.jsonl");
  const stateFilePath = path.join(tempDir, "transcript_state.txt");

  // Create event log and state files
  fs.writeFileSync(eventLogPath, "");
  fs.writeFileSync(stateFilePath, "0");

  // Create hook script
  const hookScriptPath = path.join(tempDir, "telemetry-hook.js");
  fs.writeFileSync(hookScriptPath, createHookScript(eventLogPath, stateFilePath));
  fs.chmodSync(hookScriptPath, 0o755);

  // Set up settings.local.json in cwd
  const claudeDir = path.join(cwd, ".claude");
  fs.mkdirSync(claudeDir, { recursive: true });
  const settingsPath = path.join(claudeDir, "settings.local.json");

  let originalSettings: string | null = null;
  if (fs.existsSync(settingsPath)) {
    originalSettings = fs.readFileSync(settingsPath, "utf-8");
  }

  const settings = createHookSettings(hookScriptPath);
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));

  try {
    const timeout =
      typeof agentNode.timeout === "number"
        ? agentNode.timeout * 1000
        : undefined;

    // Run CLI process synchronously
    let stdout = "";
    let stderr = "";
    let exitCode = 0;

    try {
      // Use spawnSync with args array to avoid shell interpretation of prompt text
      const spawnResult = spawnSync(cmd[0], cmd.slice(1), {
        cwd,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
        timeout,
        env,
      });

      if (spawnResult.error) {
        throw spawnResult.error;
      }

      stdout = spawnResult.stdout ?? "";
      stderr = spawnResult.stderr ?? "";
      exitCode = spawnResult.status ?? 1;
    } catch (e: unknown) {
      const err = e as { message?: string };
      stderr = err.message ?? String(e);
      exitCode = 1;
    }

    // Process remaining events from the log
    if (fs.existsSync(eventLogPath)) {
      const lines = fs.readFileSync(eventLogPath, "utf-8").split("\n");
      for (const line of lines) {
        if (line.trim()) {
          try {
            dispatchEvent(JSON.parse(line), onEvent);
          } catch {
            // Skip malformed events
          }
        }
      }
    }

    return processCliResult(stdout, stderr, exitCode, agentNode);
  } finally {
    // Restore original settings or remove
    try {
      if (originalSettings !== null) {
        fs.writeFileSync(settingsPath, originalSettings);
      } else if (fs.existsSync(settingsPath)) {
        fs.unlinkSync(settingsPath);
      }
    } catch {
      // Best effort cleanup
    }

    // Clean up temp directory
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // Best effort cleanup
    }
  }
}
