import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  CLIAgentError,
  executeAgentViaCli,
  normalizeCliModel,
} from "../src/cli-agents.js";
import type { AgentNode } from "../src/parser.js";

const originalPath = process.env.PATH;
const tempDirectories: string[] = [];

function makeAgentNode(): AgentNode {
  return {
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
        fields: { summary: ["string", "Thread summary"] },
      },
      body: "Summarize the thread.",
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
}

describe("Claude CLI model selection", () => {
  afterEach(() => {
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.HARPOON_ARGS_FILE;
    process.env.PATH = originalPath;
    for (const directory of tempDirectories.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("preserves Claude subscription aliases", () => {
    expect(normalizeCliModel("sonnet")).toBe("sonnet");
  });

  it("removes the Anthropic provider prefix", () => {
    expect(normalizeCliModel("anthropic/claude-sonnet-5")).toBe(
      "claude-sonnet-5"
    );
  });

  it("rejects non-Anthropic provider models", () => {
    expect(() => normalizeCliModel("openai/gpt-5")).toThrow(CLIAgentError);
  });

  it("passes the resolved model to Claude CLI", async () => {
    const directory = mkdtempSync(join(tmpdir(), "harpoon-cli-model-"));
    tempDirectories.push(directory);
    const argsPath = join(directory, "args.txt");
    const claudePath = join(directory, "claude");
    writeFileSync(
      claudePath,
      [
        "#!/bin/sh",
        'printf "%s\\n" "$@" > "$HARPOON_ARGS_FILE"',
        "printf '%s' '{\"structured_output\":{\"summary\":\"ok\"},\"session_id\":\"test\"}'",
      ].join("\n")
    );
    chmodSync(claudePath, 0o755);
    process.env.PATH = `${directory}:${originalPath ?? ""}`;
    process.env.HARPOON_ARGS_FILE = argsPath;

    const agentNode = makeAgentNode();

    const result = await executeAgentViaCli(agentNode, {}, directory);

    expect(result.output).toEqual({ summary: "ok" });
    expect(result.requestedModel).toBe("sonnet");
    const args = readFileSync(argsPath, "utf8").trim().split("\n");
    expect(args).toContain("--model");
    expect(args[args.indexOf("--model") + 1]).toBe("sonnet");
  });

  it("captures the canonical model from streaming assistant events", async () => {
    const directory = mkdtempSync(join(tmpdir(), "harpoon-cli-stream-model-"));
    tempDirectories.push(directory);
    const claudePath = join(directory, "claude");
    writeFileSync(
      claudePath,
      [
        "#!/bin/sh",
        "printf '%s\\n' " +
          "'{\"type\":\"assistant\",\"message\":{\"model\":\"claude-sonnet-5-20260801\",\"content\":[{\"type\":\"text\",\"text\":\"Working\"}]}}' " +
          "'{\"type\":\"result\",\"structured_output\":{\"summary\":\"ok\"},\"session_id\":\"stream-test\"}'",
      ].join("\n"),
    );
    chmodSync(claudePath, 0o755);
    process.env.PATH = `${directory}:${originalPath ?? ""}`;

    const result = await executeAgentViaCli(
      makeAgentNode(),
      {},
      directory,
      undefined,
      () => undefined,
    );

    expect(result.requestedModel).toBe("sonnet");
    expect(result.resolvedModel).toBe("claude-sonnet-5-20260801");
  });
});
