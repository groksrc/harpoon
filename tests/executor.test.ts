/**
 * Tests for DAG execution engine (executor.ts).
 */

import { describe, it, expect, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { run } from "../src/executor.js";
import type { ExecutionResult } from "../src/executor.js";
import { buildDag } from "../src/dag.js";
import {
  HarpoonError,
  NodeExecutionError,
  ExitCode,
  ProviderError,
  SchemaValidationError,
} from "../src/errors.js";
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
