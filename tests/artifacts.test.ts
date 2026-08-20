/**
 * Tests for artifact management (artifacts.ts).
 */

import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
  ArtifactManager,
  loadRunManifest,
  saveRunManifest,
  addRunEntry,
  updateRunEntry,
  getLatestRun,
  getRunById,
  getArtifactManager,
  findLatestRun,
  resolveInputSource,
  saveSignal,
  loadSignal,
  saveBranchIterationState,
  loadBranchIterationState,
  saveMapItemState,
  loadMapItemState,
  orchestrationConfigFromDict,
  resolveArtifactDirectory,
} from "../src/artifacts.js";
import type {
  ArtifactConfig,
  RunManifest,
  RunEntry,
  RunMetadata,
  BranchIterationState,
  MapItemState,
  Signal,
} from "../src/artifacts.js";

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "harpoon-test-"));
}

function cleanupDir(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

function makeConfig(baseDir: string, overrides?: Partial<ArtifactConfig>): ArtifactConfig {
  return {
    baseDir,
    persistTrace: true,
    persistOutputs: true,
    persistCheckpoint: true,
    persistBranchState: true,
    emitSignals: false,
    ...overrides,
  };
}

describe("artifact directory resolution", () => {
  it("disables persistence when Commander parses --no-artifacts", () => {
    expect(resolveArtifactDirectory("/project", false, "/custom")).toBeUndefined();
  });

  it("uses the default or custom directory when artifacts are enabled", () => {
    expect(resolveArtifactDirectory("/project", true)).toBe(
      path.join("/project", ".harpoon"),
    );
    expect(resolveArtifactDirectory("/project", true, "/custom")).toBe(
      path.resolve("/custom"),
    );
  });
});

describe("RunManifest helpers", () => {
  let tmpdir: string;

  afterEach(() => {
    if (tmpdir) cleanupDir(tmpdir);
  });

  it("returns empty manifest for missing file", () => {
    tmpdir = makeTmpDir();
    const manifest = loadRunManifest(path.join(tmpdir, "manifest.json"));
    expect(manifest.version).toBe("1");
    expect(manifest.runs).toHaveLength(0);
  });

  it("saves and loads manifest", () => {
    tmpdir = makeTmpDir();
    const manifestPath = path.join(tmpdir, "manifest.json");

    const manifest: RunManifest = {
      version: "1",
      runs: [
        {
          runId: "run-1",
          projectName: "test",
          entrypoint: "input",
          status: "completed",
          startedAt: "2024-01-01T00:00:00Z",
          endedAt: "2024-01-01T00:01:00Z",
          success: true,
        },
      ],
    };
    saveRunManifest(manifestPath, manifest);

    const loaded = loadRunManifest(manifestPath);
    expect(loaded.version).toBe("1");
    expect(loaded.runs).toHaveLength(1);
    expect(loaded.runs[0].runId).toBe("run-1");
    expect(loaded.runs[0].success).toBe(true);
  });

  it("addRunEntry appends new entry", () => {
    const manifest: RunManifest = { version: "1", runs: [] };
    const entry: RunEntry = {
      runId: "run-1",
      projectName: "test",
      entrypoint: null,
      status: "running",
      startedAt: "2024-01-01T00:00:00Z",
    };
    addRunEntry(manifest, entry);
    expect(manifest.runs).toHaveLength(1);
    expect(manifest.runs[0].runId).toBe("run-1");
  });

  it("addRunEntry upserts existing entry", () => {
    const manifest: RunManifest = {
      version: "1",
      runs: [
        {
          runId: "run-1",
          projectName: "test",
          entrypoint: null,
          status: "running",
          startedAt: "2024-01-01T00:00:00Z",
        },
      ],
    };
    const updated: RunEntry = {
      runId: "run-1",
      projectName: "test",
      entrypoint: null,
      status: "completed",
      startedAt: "2024-01-01T00:00:00Z",
      endedAt: "2024-01-01T00:01:00Z",
      success: true,
    };
    addRunEntry(manifest, updated);
    expect(manifest.runs).toHaveLength(1);
    expect(manifest.runs[0].status).toBe("completed");
    expect(manifest.runs[0].success).toBe(true);
  });

  it("updateRunEntry updates partial fields", () => {
    const manifest: RunManifest = {
      version: "1",
      runs: [
        {
          runId: "run-1",
          projectName: "test",
          entrypoint: null,
          status: "running",
          startedAt: "2024-01-01T00:00:00Z",
        },
      ],
    };
    updateRunEntry(manifest, "run-1", { status: "failed", errorSummary: "timeout" });
    expect(manifest.runs[0].status).toBe("failed");
    expect(manifest.runs[0].errorSummary).toBe("timeout");
  });

  it("updateRunEntry ignores missing run", () => {
    const manifest: RunManifest = { version: "1", runs: [] };
    updateRunEntry(manifest, "nonexistent", { status: "completed" });
    expect(manifest.runs).toHaveLength(0);
  });

  it("getLatestRun returns last entry", () => {
    const manifest: RunManifest = {
      version: "1",
      runs: [
        {
          runId: "run-1",
          projectName: "test",
          entrypoint: null,
          status: "completed",
          startedAt: "2024-01-01T00:00:00Z",
        },
        {
          runId: "run-2",
          projectName: "test",
          entrypoint: null,
          status: "running",
          startedAt: "2024-01-01T00:01:00Z",
        },
      ],
    };
    const latest = getLatestRun(manifest);
    expect(latest?.runId).toBe("run-2");
  });

  it("getLatestRun returns undefined for empty manifest", () => {
    const manifest: RunManifest = { version: "1", runs: [] };
    expect(getLatestRun(manifest)).toBeUndefined();
  });

  it("getRunById finds matching run", () => {
    const manifest: RunManifest = {
      version: "1",
      runs: [
        {
          runId: "run-1",
          projectName: "test",
          entrypoint: null,
          status: "completed",
          startedAt: "2024-01-01T00:00:00Z",
        },
      ],
    };
    const run = getRunById(manifest, "run-1");
    expect(run?.runId).toBe("run-1");
  });

  it("getRunById returns undefined for missing run", () => {
    const manifest: RunManifest = { version: "1", runs: [] };
    expect(getRunById(manifest, "nonexistent")).toBeUndefined();
  });
});

describe("Signal helpers", () => {
  let tmpdir: string;

  afterEach(() => {
    if (tmpdir) cleanupDir(tmpdir);
  });

  it("saves and loads signal", async () => {
    tmpdir = makeTmpDir();
    const signal: Signal = {
      signalType: "completed",
      runId: "run-1",
      timestamp: "2024-01-01T00:00:00Z",
      workflow: "my-workflow",
      outputsPath: "/some/path/outputs.json",
      metadata: { key: "value" },
    };

    const filePath = await saveSignal(tmpdir, signal);
    expect(filePath).toContain("my-workflow.completed");

    const loaded = await loadSignal(filePath);
    expect(loaded.signalType).toBe("completed");
    expect(loaded.runId).toBe("run-1");
    expect(loaded.workflow).toBe("my-workflow");
    expect(loaded.metadata.key).toBe("value");
  });
});

describe("BranchIterationState helpers", () => {
  let tmpdir: string;

  afterEach(() => {
    if (tmpdir) cleanupDir(tmpdir);
  });

  it("saves and loads branch iteration state", async () => {
    tmpdir = makeTmpDir();
    const filePath = path.join(tmpdir, "iteration_0.json");
    const state: BranchIterationState = {
      branchId: "branch1",
      iteration: 0,
      inputs: { query: "test" },
      outputs: { result: "done" },
      startedAt: "2024-01-01T00:00:00Z",
      endedAt: "2024-01-01T00:01:00Z",
      success: true,
    };

    await saveBranchIterationState(filePath, state);
    const loaded = await loadBranchIterationState(filePath);
    expect(loaded.branchId).toBe("branch1");
    expect(loaded.iteration).toBe(0);
    expect(loaded.success).toBe(true);
    expect(loaded.outputs.result).toBe("done");
  });
});

describe("MapItemState helpers", () => {
  let tmpdir: string;

  afterEach(() => {
    if (tmpdir) cleanupDir(tmpdir);
  });

  it("saves and loads map item state", async () => {
    tmpdir = makeTmpDir();
    const filePath = path.join(tmpdir, "item_0.json");
    const state: MapItemState = {
      mapId: "map1",
      index: 0,
      item: { name: "test" },
      outputs: { processed: true },
      startedAt: "2024-01-01T00:00:00Z",
      endedAt: "2024-01-01T00:01:00Z",
      success: true,
    };

    await saveMapItemState(filePath, state);
    const loaded = await loadMapItemState(filePath);
    expect(loaded.mapId).toBe("map1");
    expect(loaded.index).toBe(0);
    expect(loaded.success).toBe(true);
    expect(loaded.outputs.processed).toBe(true);
  });

  it("saves failed item state with error", async () => {
    tmpdir = makeTmpDir();
    const filePath = path.join(tmpdir, "item_1.json");
    const state: MapItemState = {
      mapId: "map1",
      index: 1,
      item: "bad-item",
      outputs: {},
      startedAt: "2024-01-01T00:00:00Z",
      endedAt: "2024-01-01T00:00:30Z",
      success: false,
      error: "Processing failed",
    };

    await saveMapItemState(filePath, state);
    const loaded = await loadMapItemState(filePath);
    expect(loaded.success).toBe(false);
    expect(loaded.error).toBe("Processing failed");
  });
});

describe("orchestrationConfigFromDict", () => {
  it("parses full config", () => {
    const config = orchestrationConfigFromDict({
      publish: { path: "/out/results.json", alias: "latest" },
      export: { path: "/shared/outputs.json" },
      signals: { enabled: true, directory: "/signals" },
    });
    expect(config.publishPath).toBe("/out/results.json");
    expect(config.publishAlias).toBe("latest");
    expect(config.exportPath).toBe("/shared/outputs.json");
    expect(config.signalsEnabled).toBe(true);
    expect(config.signalsDir).toBe("/signals");
  });

  it("returns defaults for empty config", () => {
    const config = orchestrationConfigFromDict({});
    expect(config.publishPath).toBeUndefined();
    expect(config.publishAlias).toBeUndefined();
    expect(config.exportPath).toBeUndefined();
    expect(config.signalsDir).toBe(".harpoon/signals");
  });
});

describe("ArtifactManager", () => {
  let tmpdir: string;

  afterEach(() => {
    if (tmpdir) cleanupDir(tmpdir);
  });

  it("has correct path properties", () => {
    tmpdir = makeTmpDir();
    const config = makeConfig(path.join(tmpdir, ".harpoon"));
    const manager = new ArtifactManager(config, "run-123");

    expect(manager.runsDir).toBe(path.join(tmpdir, ".harpoon", "runs"));
    expect(manager.runDir).toBe(path.join(tmpdir, ".harpoon", "runs", "run-123"));
    expect(manager.checkpointPath).toContain("checkpoint.json");
    expect(manager.tracePath).toContain("trace.json");
    expect(manager.outputsPath).toContain("outputs.json");
    expect(manager.metadataPath).toContain("metadata.json");
  });

  it("creates run directory", async () => {
    tmpdir = makeTmpDir();
    const config = makeConfig(path.join(tmpdir, ".harpoon"));
    const manager = new ArtifactManager(config, "run-123");

    await manager.ensureDirs();
    expect(fs.existsSync(manager.runDir)).toBe(true);
  });

  it("registers and updates run in manifest", () => {
    tmpdir = makeTmpDir();
    const config = makeConfig(path.join(tmpdir, ".harpoon"));
    const manager = new ArtifactManager(config, "run-123");

    manager.registerRun("my-project", "input");

    const manifest = loadRunManifest(manager.manifestPath);
    expect(manifest.runs).toHaveLength(1);
    expect(manifest.runs[0].runId).toBe("run-123");
    expect(manifest.runs[0].status).toBe("running");

    manager.updateRunStatus("completed", true);
    const updated = loadRunManifest(manager.manifestPath);
    expect(updated.runs[0].status).toBe("completed");
    expect(updated.runs[0].success).toBe(true);
  });

  it("saves and loads checkpoint", async () => {
    tmpdir = makeTmpDir();
    const config = makeConfig(path.join(tmpdir, ".harpoon"));
    const manager = new ArtifactManager(config, "run-123");

    const checkpoint = {
      runId: "run-123",
      projectName: "test",
      status: "running",
      completedNodes: { input: { outputs: { text: "hello" } } },
    };

    await manager.saveCheckpoint(checkpoint);
    const loaded = await manager.loadCheckpoint();
    expect(loaded).toBeDefined();
    expect(loaded!.runId).toBe("run-123");
    expect((loaded!.completedNodes as Record<string, unknown>).input).toBeDefined();
  });

  it("returns undefined for missing checkpoint", async () => {
    tmpdir = makeTmpDir();
    const config = makeConfig(path.join(tmpdir, ".harpoon"));
    const manager = new ArtifactManager(config, "run-no-checkpoint");

    const loaded = await manager.loadCheckpoint();
    expect(loaded).toBeUndefined();
  });

  it("skips checkpoint save when disabled", async () => {
    tmpdir = makeTmpDir();
    const config = makeConfig(path.join(tmpdir, ".harpoon"), {
      persistCheckpoint: false,
    });
    const manager = new ArtifactManager(config, "run-123");

    await manager.saveCheckpoint({ runId: "run-123" });
    expect(fs.existsSync(manager.checkpointPath)).toBe(false);
  });

  it("saves trace", async () => {
    tmpdir = makeTmpDir();
    const config = makeConfig(path.join(tmpdir, ".harpoon"));
    const manager = new ArtifactManager(config, "run-123");

    await manager.saveTrace({ runId: "run-123", nodes: [] });
    const content = fs.readFileSync(manager.tracePath, "utf-8");
    const parsed = JSON.parse(content);
    expect(parsed.runId).toBe("run-123");
  });

  it("skips trace save when disabled", async () => {
    tmpdir = makeTmpDir();
    const config = makeConfig(path.join(tmpdir, ".harpoon"), {
      persistTrace: false,
    });
    const manager = new ArtifactManager(config, "run-123");

    await manager.saveTrace({ runId: "run-123" });
    expect(fs.existsSync(manager.tracePath)).toBe(false);
  });

  it("saves outputs", async () => {
    tmpdir = makeTmpDir();
    const config = makeConfig(path.join(tmpdir, ".harpoon"));
    const manager = new ArtifactManager(config, "run-123");

    await manager.saveOutputs({ result: "done" });
    const content = fs.readFileSync(manager.outputsPath, "utf-8");
    const parsed = JSON.parse(content);
    expect(parsed.result).toBe("done");
  });

  it("skips outputs save when disabled", async () => {
    tmpdir = makeTmpDir();
    const config = makeConfig(path.join(tmpdir, ".harpoon"), {
      persistOutputs: false,
    });
    const manager = new ArtifactManager(config, "run-123");

    await manager.saveOutputs({ result: "done" });
    expect(fs.existsSync(manager.outputsPath)).toBe(false);
  });

  it("saves metadata", async () => {
    tmpdir = makeTmpDir();
    const config = makeConfig(path.join(tmpdir, ".harpoon"));
    const manager = new ArtifactManager(config, "run-123");

    const metadata: RunMetadata = {
      runId: "run-123",
      projectName: "test",
      projectRoot: tmpdir,
      entrypoint: "input",
      inputs: { text: "hello" },
      startedAt: "2024-01-01T00:00:00Z",
      harpoonVersion: "1.1.0",
    };

    await manager.saveMetadata(metadata);
    const content = fs.readFileSync(manager.metadataPath, "utf-8");
    const parsed = JSON.parse(content);
    expect(parsed.projectName).toBe("test");
    expect(parsed.harpoonVersion).toBe("1.1.0");
  });

  it("branch iteration paths are correct", () => {
    tmpdir = makeTmpDir();
    const config = makeConfig(path.join(tmpdir, ".harpoon"));
    const manager = new ArtifactManager(config, "run-123");

    expect(manager.branchesDir("branch1")).toContain("branches/branch1");
    expect(manager.iterationPath("branch1", 0)).toContain("iteration_0.json");
    expect(manager.iterationPath("branch1", 3)).toContain("iteration_3.json");
  });

  it("saves and loads branch iterations", async () => {
    tmpdir = makeTmpDir();
    const config = makeConfig(path.join(tmpdir, ".harpoon"));
    const manager = new ArtifactManager(config, "run-123");

    const state0: BranchIterationState = {
      branchId: "branch1",
      iteration: 0,
      inputs: { x: 1 },
      outputs: { y: 2 },
      startedAt: "2024-01-01T00:00:00Z",
      endedAt: "2024-01-01T00:00:30Z",
      success: true,
    };
    const state1: BranchIterationState = {
      branchId: "branch1",
      iteration: 1,
      inputs: { x: 2 },
      outputs: { y: 4 },
      startedAt: "2024-01-01T00:00:30Z",
      endedAt: "2024-01-01T00:01:00Z",
      success: true,
    };

    await manager.saveBranchIteration("branch1", state0);
    await manager.saveBranchIteration("branch1", state1);

    const iterations = await manager.loadBranchIterations("branch1");
    expect(iterations).toHaveLength(2);
    expect(iterations[0].iteration).toBe(0);
    expect(iterations[1].iteration).toBe(1);
  });

  it("returns empty for missing branch iterations", async () => {
    tmpdir = makeTmpDir();
    const config = makeConfig(path.join(tmpdir, ".harpoon"));
    const manager = new ArtifactManager(config, "run-123");

    const iterations = await manager.loadBranchIterations("nonexistent");
    expect(iterations).toHaveLength(0);
  });

  it("gets latest iteration", async () => {
    tmpdir = makeTmpDir();
    const config = makeConfig(path.join(tmpdir, ".harpoon"));
    const manager = new ArtifactManager(config, "run-123");

    await manager.saveBranchIteration("branch1", {
      branchId: "branch1",
      iteration: 0,
      inputs: {},
      outputs: { v: 1 },
      startedAt: "2024-01-01T00:00:00Z",
      success: true,
    });
    await manager.saveBranchIteration("branch1", {
      branchId: "branch1",
      iteration: 1,
      inputs: {},
      outputs: { v: 2 },
      startedAt: "2024-01-01T00:00:30Z",
      success: true,
    });

    const latest = await manager.getLatestIteration("branch1");
    expect(latest?.iteration).toBe(1);
    expect(latest?.outputs.v).toBe(2);
  });

  it("returns undefined for no iterations", async () => {
    tmpdir = makeTmpDir();
    const config = makeConfig(path.join(tmpdir, ".harpoon"));
    const manager = new ArtifactManager(config, "run-123");

    const latest = await manager.getLatestIteration("nonexistent");
    expect(latest).toBeUndefined();
  });

  it("map item paths are correct", () => {
    tmpdir = makeTmpDir();
    const config = makeConfig(path.join(tmpdir, ".harpoon"));
    const manager = new ArtifactManager(config, "run-123");

    expect(manager.mapsDir("map1")).toContain("maps/map1");
    expect(manager.mapItemPath("map1", 0)).toContain("item_0.json");
    expect(manager.mapItemPath("map1", 5)).toContain("item_5.json");
  });

  it("saves and loads map items", async () => {
    tmpdir = makeTmpDir();
    const config = makeConfig(path.join(tmpdir, ".harpoon"));
    const manager = new ArtifactManager(config, "run-123");

    const item0: MapItemState = {
      mapId: "map1",
      index: 0,
      item: "a",
      outputs: { result: "processed_a" },
      startedAt: "2024-01-01T00:00:00Z",
      endedAt: "2024-01-01T00:00:10Z",
      success: true,
    };
    const item1: MapItemState = {
      mapId: "map1",
      index: 1,
      item: "b",
      outputs: { result: "processed_b" },
      startedAt: "2024-01-01T00:00:10Z",
      endedAt: "2024-01-01T00:00:20Z",
      success: true,
    };

    await manager.saveMapItem("map1", item0);
    await manager.saveMapItem("map1", item1);

    const items = await manager.loadMapItems("map1");
    expect(items).toHaveLength(2);
    expect(items[0].index).toBe(0);
    expect(items[1].index).toBe(1);
  });

  it("returns empty for missing map items", async () => {
    tmpdir = makeTmpDir();
    const config = makeConfig(path.join(tmpdir, ".harpoon"));
    const manager = new ArtifactManager(config, "run-123");

    const items = await manager.loadMapItems("nonexistent");
    expect(items).toHaveLength(0);
  });

  it("emits signal when enabled", async () => {
    tmpdir = makeTmpDir();
    const signalsDir = path.join(tmpdir, "signals");
    const config = makeConfig(path.join(tmpdir, ".harpoon"), {
      emitSignals: true,
      orchestration: {
        signalsEnabled: true,
        signalsDir,
      },
    });
    const manager = new ArtifactManager(config, "run-123");

    const signalPath = await manager.emitSignal(
      "completed",
      "my-workflow",
      "/outputs.json",
      { key: "val" }
    );
    expect(signalPath).toBeDefined();
    expect(fs.existsSync(signalPath!)).toBe(true);

    const loaded = await loadSignal(signalPath!);
    expect(loaded.signalType).toBe("completed");
    expect(loaded.workflow).toBe("my-workflow");
  });

  it("returns undefined for signal when disabled", async () => {
    tmpdir = makeTmpDir();
    const config = makeConfig(path.join(tmpdir, ".harpoon"), {
      emitSignals: false,
    });
    const manager = new ArtifactManager(config, "run-123");

    const result = await manager.emitSignal("completed", "my-workflow");
    expect(result).toBeUndefined();
  });
});

describe("getArtifactManager", () => {
  it("creates manager with defaults", () => {
    const manager = getArtifactManager("/project/root", "run-1");
    expect(manager.config.baseDir).toBe("/project/root/.harpoon");
    expect(manager.config.persistTrace).toBe(true);
    expect(manager.config.persistOutputs).toBe(true);
    expect(manager.config.persistCheckpoint).toBe(true);
    expect(manager.config.emitSignals).toBe(false);
  });

  it("creates manager with custom artifact dir", () => {
    const manager = getArtifactManager("/project/root", "run-1", "/custom/artifacts");
    expect(manager.config.baseDir).toBe("/custom/artifacts");
  });

  it("creates manager with signals enabled", () => {
    const manager = getArtifactManager("/project/root", "run-1", undefined, true);
    expect(manager.config.emitSignals).toBe(true);
  });
});

describe("findLatestRun", () => {
  let tmpdir: string;

  afterEach(() => {
    if (tmpdir) cleanupDir(tmpdir);
  });

  it("returns undefined for project with no runs", () => {
    tmpdir = makeTmpDir();
    const result = findLatestRun(tmpdir);
    expect(result).toBeUndefined();
  });

  it("returns latest run ID", () => {
    tmpdir = makeTmpDir();
    const manifestPath = path.join(tmpdir, ".harpoon", "runs", "manifest.json");
    const manifest: RunManifest = {
      version: "1",
      runs: [
        {
          runId: "run-old",
          projectName: "test",
          entrypoint: null,
          status: "completed",
          startedAt: "2024-01-01T00:00:00Z",
        },
        {
          runId: "run-new",
          projectName: "test",
          entrypoint: null,
          status: "completed",
          startedAt: "2024-01-02T00:00:00Z",
        },
      ],
    };
    saveRunManifest(manifestPath, manifest);

    const result = findLatestRun(tmpdir);
    expect(result).toBe("run-new");
  });
});

describe("resolveInputSource", () => {
  let tmpdir: string;

  afterEach(() => {
    if (tmpdir) cleanupDir(tmpdir);
  });

  it("resolves file path", async () => {
    tmpdir = makeTmpDir();
    const filePath = path.join(tmpdir, "inputs.json");
    fs.writeFileSync(filePath, JSON.stringify({ key: "value" }));

    const result = await resolveInputSource(filePath, tmpdir);
    expect(result.key).toBe("value");
  });

  it("resolves relative path", async () => {
    tmpdir = makeTmpDir();
    fs.writeFileSync(
      path.join(tmpdir, "data.json"),
      JSON.stringify({ x: 1 })
    );

    const result = await resolveInputSource("data.json", tmpdir);
    expect(result.x).toBe(1);
  });

  it("resolves run: source", async () => {
    tmpdir = makeTmpDir();
    const outputsDir = path.join(tmpdir, ".harpoon", "runs", "run-123");
    fs.mkdirSync(outputsDir, { recursive: true });
    fs.writeFileSync(
      path.join(outputsDir, "outputs.json"),
      JSON.stringify({ result: "done" })
    );

    const result = await resolveInputSource("run:run-123", tmpdir);
    expect(result.result).toBe("done");
  });

  it("resolves alias: source", async () => {
    tmpdir = makeTmpDir();
    const aliasDir = path.join(tmpdir, ".harpoon", "outputs");
    fs.mkdirSync(aliasDir, { recursive: true });
    fs.writeFileSync(
      path.join(aliasDir, "latest.json"),
      JSON.stringify({ from: "alias" })
    );

    const result = await resolveInputSource("alias:latest", tmpdir);
    expect(result.from).toBe("alias");
  });

  it("throws for missing source", async () => {
    tmpdir = makeTmpDir();
    await expect(
      resolveInputSource("nonexistent.json", tmpdir)
    ).rejects.toThrow("Input source not found");
  });
});
