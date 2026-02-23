/**
 * Tests for telemetry system (telemetry.ts).
 */

import { describe, it, expect, afterEach } from "vitest";
import { Writable } from "node:stream";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
  EventType,
  TelemetryLevel,
  TelemetryEmitter,
  defaultTelemetryConfig,
  setEmitter,
  getEmitter,
  emit,
} from "../src/telemetry.js";
import type { TelemetryConfig } from "../src/telemetry.js";

/** Writable stream that captures output to a string. */
class StringStream extends Writable {
  data = "";
  _write(
    chunk: Buffer | string,
    _encoding: string,
    callback: (error?: Error | null) => void
  ): void {
    this.data += chunk.toString();
    callback();
  }
}

describe("EventType", () => {
  it("has lifecycle events", () => {
    expect(EventType.WORKFLOW_STARTED).toBe("workflow_started");
    expect(EventType.WORKFLOW_COMPLETED).toBe("workflow_completed");
    expect(EventType.WORKFLOW_FAILED).toBe("workflow_failed");
  });

  it("has node events", () => {
    expect(EventType.NODE_STARTED).toBe("node_started");
    expect(EventType.NODE_COMPLETED).toBe("node_completed");
    expect(EventType.NODE_FAILED).toBe("node_failed");
    expect(EventType.NODE_SKIPPED).toBe("node_skipped");
  });

  it("has agent events", () => {
    expect(EventType.AGENT_TURN_STARTED).toBe("agent_turn_started");
    expect(EventType.AGENT_TURN_COMPLETED).toBe("agent_turn_completed");
    expect(EventType.AGENT_TOOL_CALLED).toBe("agent_tool_called");
    expect(EventType.AGENT_TOOL_RESULT).toBe("agent_tool_result");
    expect(EventType.AGENT_MESSAGE).toBe("agent_message");
  });
});

describe("TelemetryLevel", () => {
  it("has all levels", () => {
    expect(TelemetryLevel.DEBUG).toBe("DEBUG");
    expect(TelemetryLevel.INFO).toBe("INFO");
    expect(TelemetryLevel.WARNING).toBe("WARNING");
    expect(TelemetryLevel.ERROR).toBe("ERROR");
  });
});

describe("defaultTelemetryConfig", () => {
  it("has sensible defaults", () => {
    const config = defaultTelemetryConfig();
    expect(config.enabled).toBe(false);
    expect(config.format).toBe("human");
    expect(config.level).toBe(TelemetryLevel.INFO);
  });
});

describe("TelemetryEmitter", () => {
  it("does nothing when disabled", () => {
    const stream = new StringStream();
    const config: TelemetryConfig = {
      enabled: false,
      format: "jsonl",
      level: TelemetryLevel.INFO,
    };
    const emitter = new TelemetryEmitter(config, stream);

    emitter.emit(EventType.WORKFLOW_STARTED, "test-run", { name: "test" });
    emitter.close();

    expect(stream.data).toBe("");
  });

  it("outputs JSON Lines format", () => {
    const stream = new StringStream();
    const config: TelemetryConfig = {
      enabled: true,
      format: "jsonl",
      level: TelemetryLevel.INFO,
    };
    const emitter = new TelemetryEmitter(config, stream);

    emitter.emit(EventType.WORKFLOW_STARTED, "test-run-123", {
      name: "my-workflow",
    });
    emitter.close();

    const lines = stream.data.trim().split("\n");
    expect(lines).toHaveLength(1);

    const event = JSON.parse(lines[0]);
    expect(event.event).toBe("workflow_started");
    expect(event.run_id).toBe("test-run-123");
    expect(event.data.name).toBe("my-workflow");
    expect(event.timestamp).toBeDefined();
  });

  it("outputs multiple events", () => {
    const stream = new StringStream();
    const config: TelemetryConfig = {
      enabled: true,
      format: "jsonl",
      level: TelemetryLevel.INFO,
    };
    const emitter = new TelemetryEmitter(config, stream);

    emitter.emit(EventType.WORKFLOW_STARTED, "test-run", { name: "test" });
    emitter.emit(EventType.NODE_STARTED, "test-run", { type: "input" }, "input");
    emitter.emit(EventType.WORKFLOW_COMPLETED, "test-run", {
      duration_ms: 1000,
    });
    emitter.close();

    const lines = stream.data.trim().split("\n");
    expect(lines).toHaveLength(3);

    expect(JSON.parse(lines[0]).event).toBe("workflow_started");
    expect(JSON.parse(lines[1]).event).toBe("node_started");
    expect(JSON.parse(lines[1]).node_id).toBe("input");
    expect(JSON.parse(lines[2]).event).toBe("workflow_completed");
  });

  it("outputs human-readable format", () => {
    const stream = new StringStream();
    const config: TelemetryConfig = {
      enabled: true,
      format: "human",
      level: TelemetryLevel.INFO,
    };
    const emitter = new TelemetryEmitter(config, stream);

    emitter.emit(EventType.WORKFLOW_STARTED, "test-run-123", {
      name: "my-workflow",
    });
    emitter.close();

    expect(stream.data).toContain("WORKFLOW_STARTED");
    expect(stream.data).toContain("test-run-123");
    expect(stream.data).toContain("my-workflow");
  });

  it("writes to file when configured", async () => {
    const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), "harpoon-test-"));
    const logFile = path.join(tmpdir, "telemetry.log");

    const config: TelemetryConfig = {
      enabled: true,
      format: "human",
      filePath: logFile,
      level: TelemetryLevel.INFO,
    };
    const stream = new StringStream();
    const emitter = new TelemetryEmitter(config, stream);

    emitter.emit(EventType.WORKFLOW_STARTED, "test-run", { name: "test" });
    emitter.close();

    // Wait for the write stream to flush
    await new Promise((resolve) => setTimeout(resolve, 50));

    const content = fs.readFileSync(logFile, "utf-8");
    const event = JSON.parse(content.trim());
    expect(event.event).toBe("workflow_started");

    fs.rmSync(tmpdir, { recursive: true, force: true });
  });

  it("file always writes JSONL even when stdout format is human", async () => {
    const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), "harpoon-test-"));
    const logFile = path.join(tmpdir, "telemetry.log");
    const stream = new StringStream();

    const config: TelemetryConfig = {
      enabled: true,
      format: "human",
      filePath: logFile,
      level: TelemetryLevel.INFO,
    };
    const emitter = new TelemetryEmitter(config, stream);

    emitter.emit(EventType.NODE_STARTED, "test-run", {
      type: "prompt",
      input: { topic: "hello" },
    }, "my_node");
    emitter.close();

    await new Promise((resolve) => setTimeout(resolve, 50));

    // stdout should be human format
    expect(stream.data).toContain("NODE_STARTED");
    expect(stream.data).toContain("node=my_node");

    // file should be valid JSONL
    const content = fs.readFileSync(logFile, "utf-8");
    const event = JSON.parse(content.trim());
    expect(event.event).toBe("node_started");
    expect(event.node_id).toBe("my_node");
    expect(event.data.input).toEqual({ topic: "hello" });

    fs.rmSync(tmpdir, { recursive: true, force: true });
  });

  it("includes node_id when provided", () => {
    const stream = new StringStream();
    const config: TelemetryConfig = {
      enabled: true,
      format: "jsonl",
      level: TelemetryLevel.INFO,
    };
    const emitter = new TelemetryEmitter(config, stream);

    emitter.emit(
      EventType.NODE_STARTED,
      "test-run",
      { type: "prompt" },
      "my_node",
      TelemetryLevel.INFO
    );
    emitter.close();

    const event = JSON.parse(stream.data.trim());
    expect(event.node_id).toBe("my_node");
  });

  it("respects event filter", () => {
    const stream = new StringStream();
    const config: TelemetryConfig = {
      enabled: true,
      format: "jsonl",
      level: TelemetryLevel.INFO,
      filterEvents: [EventType.WORKFLOW_STARTED],
    };
    const emitter = new TelemetryEmitter(config, stream);

    emitter.emit(EventType.WORKFLOW_STARTED, "test-run", { name: "test" });
    emitter.emit(EventType.NODE_STARTED, "test-run", { type: "input" });
    emitter.close();

    const lines = stream.data.trim().split("\n").filter((l) => l.length > 0);
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]).event).toBe("workflow_started");
  });

  it("NODE_STARTED includes input data", () => {
    const stream = new StringStream();
    const config: TelemetryConfig = {
      enabled: true,
      format: "jsonl",
      level: TelemetryLevel.INFO,
    };
    const emitter = new TelemetryEmitter(config, stream);

    const nodeInput = { topic: "AI agents", style: "technical" };
    emitter.emit(
      EventType.NODE_STARTED,
      "test-run",
      { type: "prompt", input: nodeInput },
      "writer_node",
      TelemetryLevel.INFO
    );
    emitter.close();

    const event = JSON.parse(stream.data.trim());
    expect(event.event).toBe("node_started");
    expect(event.node_id).toBe("writer_node");
    expect(event.data.input).toEqual(nodeInput);
  });

  it("NODE_COMPLETED includes output data", () => {
    const stream = new StringStream();
    const config: TelemetryConfig = {
      enabled: true,
      format: "jsonl",
      level: TelemetryLevel.INFO,
    };
    const emitter = new TelemetryEmitter(config, stream);

    const nodeOutput = { text: "Generated article about AI agents", word_count: 500 };
    emitter.emit(
      EventType.NODE_COMPLETED,
      "test-run",
      { type: "prompt", output: nodeOutput, input_tokens: 100, output_tokens: 200 },
      "writer_node",
      TelemetryLevel.INFO
    );
    emitter.close();

    const event = JSON.parse(stream.data.trim());
    expect(event.event).toBe("node_completed");
    expect(event.node_id).toBe("writer_node");
    expect(event.data.output).toEqual(nodeOutput);
    expect(event.data.input_tokens).toBe(100);
    expect(event.data.output_tokens).toBe(200);
  });

  it("stdout and file receive the same content when format is jsonl", async () => {
    const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), "harpoon-test-"));
    const logFile = path.join(tmpdir, "telemetry.log");
    const stream = new StringStream();

    const config: TelemetryConfig = {
      enabled: true,
      format: "jsonl",
      filePath: logFile,
      level: TelemetryLevel.INFO,
    };
    const emitter = new TelemetryEmitter(config, stream);

    emitter.emit(EventType.NODE_STARTED, "test-run", {
      type: "prompt",
      input: { key: "value" },
    }, "node1");
    emitter.close();

    await new Promise((resolve) => setTimeout(resolve, 50));

    const fileContent = fs.readFileSync(logFile, "utf-8").trim();
    const stdoutContent = stream.data.trim();

    // Both should be valid JSONL with the same data
    const fileEvent = JSON.parse(fileContent);
    const stdoutEvent = JSON.parse(stdoutContent);
    expect(fileEvent.event).toBe(stdoutEvent.event);
    expect(fileEvent.data).toEqual(stdoutEvent.data);
    expect(fileEvent.node_id).toBe(stdoutEvent.node_id);

    fs.rmSync(tmpdir, { recursive: true, force: true });
  });
});

describe("global emitter", () => {
  afterEach(() => {
    setEmitter(undefined);
  });

  it("emit does nothing when no global emitter", () => {
    // Should not throw
    emit(EventType.WORKFLOW_STARTED, "test-run", { name: "test" });
  });

  it("emit uses global emitter when set", () => {
    const stream = new StringStream();
    const config: TelemetryConfig = {
      enabled: true,
      format: "jsonl",
      level: TelemetryLevel.INFO,
    };
    const emitter = new TelemetryEmitter(config, stream);
    setEmitter(emitter);

    emit(EventType.WORKFLOW_STARTED, "test-run", { name: "test" });

    expect(stream.data).toContain("workflow_started");

    emitter.close();
  });

  it("getEmitter returns undefined by default", () => {
    expect(getEmitter()).toBeUndefined();
  });
});
