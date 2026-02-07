/**
 * Unified artifact management for Harpoon runs.
 *
 * Provides centralized storage for all runtime artifacts:
 * - Checkpoints (execution state for resumption)
 * - Traces (detailed execution metrics)
 * - Outputs (final results)
 * - Metadata (run information)
 * - Branch iteration state (for looping workflows)
 * - Map item state (for parallel fan-out)
 * - Signals (workflow orchestration state)
 *
 * All artifacts are stored in `.harpoon/runs/{run_id}/` by default.
 * Signals are stored in `.harpoon/signals/` for cross-run coordination.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';

// ─── Data Interfaces ─────────────────────────────────────────

/** Configuration for artifact persistence. */
export interface ArtifactConfig {
  baseDir: string; // Usually projectRoot/.harpoon
  projectRoot?: string;
  persistTrace: boolean;
  persistOutputs: boolean;
  persistCheckpoint: boolean;
  persistBranchState: boolean;
  emitSignals: boolean;
  orchestration?: OrchestrationConfig;
}

/** Entry in the run manifest. */
export interface RunEntry {
  runId: string;
  projectName: string;
  entrypoint: string | null;
  status: string; // "running", "completed", "failed", "interrupted"
  startedAt: string;
  endedAt?: string;
  success?: boolean;
  errorSummary?: string;
}

/** Index of all runs in a project. */
export interface RunManifest {
  version: string;
  runs: RunEntry[];
}

/** Metadata about a single run. */
export interface RunMetadata {
  runId: string;
  projectName: string;
  projectRoot: string;
  entrypoint: string | null;
  inputs: Record<string, unknown>;
  startedAt: string;
  endedAt?: string;
  harpoonVersion: string;
}

/** State for a single branch iteration. */
export interface BranchIterationState {
  branchId: string;
  iteration: number;
  inputs: Record<string, unknown>;
  outputs: Record<string, unknown>;
  startedAt: string;
  endedAt?: string;
  success: boolean;
  error?: string;
}

/** State for a single map item execution. */
export interface MapItemState {
  mapId: string;
  index: number;
  item: unknown;
  outputs: Record<string, unknown>;
  startedAt: string;
  endedAt?: string;
  success: boolean;
  error?: string;
}

/** Workflow signal for orchestration. */
export interface Signal {
  signalType: string; // "started", "completed", "failed", "ready"
  runId: string;
  timestamp: string;
  workflow: string;
  outputsPath?: string;
  metadata: Record<string, unknown>;
}

/** Configuration for workflow orchestration. */
export interface OrchestrationConfig {
  publishPath?: string;
  publishAlias?: string;
  exportPath?: string;
  signalsEnabled: boolean;
  signalsDir: string;
}

/** Parse OrchestrationConfig from manifest orchestration section. */
export function orchestrationConfigFromDict(data: Record<string, unknown>): OrchestrationConfig {
  const publish = (data.publish as Record<string, unknown>) ?? {};
  const signals = (data.signals as Record<string, unknown>) ?? {};

  return {
    publishPath: (publish.path as string) ?? undefined,
    publishAlias: (publish.alias as string) ?? undefined,
    exportPath: ((data.export as Record<string, unknown>) ?? {}).path as string | undefined,
    signalsEnabled: (signals.enabled as boolean) ?? true,
    signalsDir: (signals.directory as string) ?? '.harpoon/signals',
  };
}

// ─── RunManifest helpers ─────────────────────────────────────

/** Load a RunManifest from disk. */
export function loadRunManifest(manifestPath: string): RunManifest {
  if (!existsSync(manifestPath)) {
    return { version: '1', runs: [] };
  }
  try {
    const raw = readFileSync(manifestPath, 'utf-8');
    const data = JSON.parse(raw) as Record<string, unknown>;
    const runs = ((data.runs as unknown[]) ?? []).map(runEntryFromDict);
    return { version: (data.version as string) ?? '1', runs };
  } catch {
    return { version: '1', runs: [] };
  }
}

/** Save a RunManifest to disk. */
export function saveRunManifest(manifestPath: string, manifest: RunManifest): void {
  const dir = path.dirname(manifestPath);
  mkdirSync(dir, { recursive: true });
  const data = {
    version: manifest.version,
    runs: manifest.runs.map(runEntryToDict),
  };
  writeFileSync(manifestPath, JSON.stringify(data, null, 2));
}

/** Add or update a run entry in the manifest (upsert). */
export function addRunEntry(manifest: RunManifest, entry: RunEntry): void {
  const idx = manifest.runs.findIndex((r) => r.runId === entry.runId);
  if (idx >= 0) {
    manifest.runs[idx] = entry;
  } else {
    manifest.runs.push(entry);
  }
}

/** Update fields of an existing run entry. */
export function updateRunEntry(
  manifest: RunManifest,
  runId: string,
  updates: Partial<RunEntry>,
): void {
  const entry = manifest.runs.find((r) => r.runId === runId);
  if (entry) {
    Object.assign(entry, updates);
  }
}

/** Get the most recent run. */
export function getLatestRun(manifest: RunManifest): RunEntry | undefined {
  return manifest.runs.length > 0
    ? manifest.runs[manifest.runs.length - 1]
    : undefined;
}

/** Get a run by ID. */
export function getRunById(manifest: RunManifest, runId: string): RunEntry | undefined {
  return manifest.runs.find((r) => r.runId === runId);
}

// ─── Serialization helpers ───────────────────────────────────

function runEntryFromDict(raw: unknown): RunEntry {
  const d = raw as Record<string, unknown>;
  return {
    runId: d.runId as string ?? d.run_id as string,
    projectName: d.projectName as string ?? d.project_name as string,
    entrypoint: (d.entrypoint as string) ?? null,
    status: d.status as string,
    startedAt: d.startedAt as string ?? d.started_at as string,
    endedAt: (d.endedAt as string) ?? (d.ended_at as string) ?? undefined,
    success: d.success as boolean | undefined,
    errorSummary: (d.errorSummary as string) ?? (d.error_summary as string) ?? undefined,
  };
}

function runEntryToDict(e: RunEntry): Record<string, unknown> {
  const result: Record<string, unknown> = {
    runId: e.runId,
    projectName: e.projectName,
    entrypoint: e.entrypoint,
    status: e.status,
    startedAt: e.startedAt,
  };
  if (e.endedAt !== undefined) result.endedAt = e.endedAt;
  if (e.success !== undefined) result.success = e.success;
  if (e.errorSummary !== undefined) result.errorSummary = e.errorSummary;
  return result;
}

// ─── Signal helpers ──────────────────────────────────────────

/** Save a signal to disk. Returns the file path. */
export async function saveSignal(signalsDir: string, signal: Signal): Promise<string> {
  await fs.mkdir(signalsDir, { recursive: true });
  const filePath = path.join(signalsDir, `${signal.workflow}.${signal.signalType}`);
  await fs.writeFile(filePath, JSON.stringify(signal, null, 2));
  return filePath;
}

/** Load a signal from disk. */
export async function loadSignal(filePath: string): Promise<Signal> {
  const raw = await fs.readFile(filePath, 'utf-8');
  return JSON.parse(raw) as Signal;
}

// ─── BranchIterationState helpers ────────────────────────────

export async function saveBranchIterationState(
  filePath: string,
  state: BranchIterationState,
): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(state, null, 2));
}

export async function loadBranchIterationState(
  filePath: string,
): Promise<BranchIterationState> {
  const raw = await fs.readFile(filePath, 'utf-8');
  return JSON.parse(raw) as BranchIterationState;
}

// ─── MapItemState helpers ────────────────────────────────────

export async function saveMapItemState(
  filePath: string,
  state: MapItemState,
): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(state, null, 2));
}

export async function loadMapItemState(filePath: string): Promise<MapItemState> {
  const raw = await fs.readFile(filePath, 'utf-8');
  return JSON.parse(raw) as MapItemState;
}

// ─── Utility ─────────────────────────────────────────────────

function nowIso(): string {
  return new Date().toISOString();
}

// ─── ArtifactManager ─────────────────────────────────────────

/**
 * Manages artifact persistence for a run.
 *
 * Handles saving and loading of all artifacts for a single run:
 * - checkpoint.json - execution state for resumption
 * - trace.json - detailed execution metrics
 * - outputs.json - final outputs
 * - metadata.json - run information
 * - branches/{branch_id}/iteration_{n}.json - loop state
 * - maps/{map_id}/item_{n}.json - map item state
 */
export class ArtifactManager {
  readonly config: ArtifactConfig;
  readonly runId: string;
  private manifest: RunManifest | undefined;

  constructor(config: ArtifactConfig, runId: string) {
    this.config = config;
    this.runId = runId;
  }

  // ─── Path properties ────────────────────────────────────

  get runsDir(): string {
    return path.join(this.config.baseDir, 'runs');
  }

  get runDir(): string {
    return path.join(this.runsDir, this.runId);
  }

  get manifestPath(): string {
    return path.join(this.runsDir, 'manifest.json');
  }

  get checkpointPath(): string {
    return path.join(this.runDir, 'checkpoint.json');
  }

  get tracePath(): string {
    return path.join(this.runDir, 'trace.json');
  }

  get outputsPath(): string {
    return path.join(this.runDir, 'outputs.json');
  }

  get metadataPath(): string {
    return path.join(this.runDir, 'metadata.json');
  }

  get signalsDir(): string {
    let signalsPath = '.harpoon/signals';
    if (this.config.orchestration?.signalsDir) {
      signalsPath = this.config.orchestration.signalsDir;
    }

    if (path.isAbsolute(signalsPath)) {
      return signalsPath;
    }
    const root = this.config.projectRoot ?? path.dirname(this.config.baseDir);
    return path.join(root, signalsPath);
  }

  get outputsPublishDir(): string {
    const root = this.config.projectRoot ?? path.dirname(this.config.baseDir);
    return path.join(root, '.harpoon', 'outputs');
  }

  branchesDir(branchId: string): string {
    return path.join(this.runDir, 'branches', branchId);
  }

  iterationPath(branchId: string, iteration: number): string {
    return path.join(this.branchesDir(branchId), `iteration_${iteration}.json`);
  }

  mapsDir(mapId: string): string {
    return path.join(this.runDir, 'maps', mapId);
  }

  mapItemPath(mapId: string, index: number): string {
    return path.join(this.mapsDir(mapId), `item_${index}.json`);
  }

  // ─── Directory management ───────────────────────────────

  async ensureDirs(): Promise<void> {
    await fs.mkdir(this.runDir, { recursive: true });
  }

  // ─── Manifest management ────────────────────────────────

  private getManifest(): RunManifest {
    if (this.manifest === undefined) {
      this.manifest = loadRunManifest(this.manifestPath);
    }
    return this.manifest;
  }

  private saveManifestSync(): void {
    if (this.manifest !== undefined) {
      saveRunManifest(this.manifestPath, this.manifest);
    }
  }

  /** Register a new run in the manifest. */
  registerRun(projectName: string, entrypoint: string | null): void {
    const manifest = this.getManifest();
    const entry: RunEntry = {
      runId: this.runId,
      projectName,
      entrypoint,
      status: 'running',
      startedAt: nowIso(),
    };
    addRunEntry(manifest, entry);
    this.saveManifestSync();
  }

  /** Update the run status in the manifest. */
  updateRunStatus(
    status: string,
    success?: boolean,
    errorSummary?: string,
  ): void {
    const manifest = this.getManifest();
    updateRunEntry(manifest, this.runId, {
      status,
      endedAt: nowIso(),
      success,
      errorSummary,
    });
    this.saveManifestSync();
  }

  // ─── Checkpoint ─────────────────────────────────────────

  /** Save checkpoint to disk. Returns the path. */
  async saveCheckpoint(checkpoint: Record<string, unknown>): Promise<string> {
    if (!this.config.persistCheckpoint) return this.checkpointPath;
    await this.ensureDirs();
    await fs.writeFile(this.checkpointPath, JSON.stringify(checkpoint, null, 2));
    return this.checkpointPath;
  }

  /** Load checkpoint from disk. */
  async loadCheckpoint(): Promise<Record<string, unknown> | undefined> {
    try {
      const raw = await fs.readFile(this.checkpointPath, 'utf-8');
      return JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return undefined;
    }
  }

  // ─── Trace ──────────────────────────────────────────────

  /** Save execution trace to disk. */
  async saveTrace(trace: Record<string, unknown>): Promise<string> {
    if (!this.config.persistTrace) return this.tracePath;
    await this.ensureDirs();
    await fs.writeFile(this.tracePath, JSON.stringify(trace, null, 2));
    return this.tracePath;
  }

  // ─── Outputs ────────────────────────────────────────────

  /** Save final outputs to disk. */
  async saveOutputs(
    outputs: Record<string, unknown>,
    workflowName?: string,
    publishTo?: string,
  ): Promise<string> {
    if (!this.config.persistOutputs) return this.outputsPath;
    await this.ensureDirs();

    const outputJson = JSON.stringify(outputs, null, 2);
    await fs.writeFile(this.outputsPath, outputJson);

    const root = this.config.projectRoot ?? path.dirname(this.config.baseDir);
    const orch = this.config.orchestration;

    // CLI override takes precedence
    if (publishTo) {
      const publishPath = path.isAbsolute(publishTo) ? publishTo : path.join(root, publishTo);
      await fs.mkdir(path.dirname(publishPath), { recursive: true });
      await fs.writeFile(publishPath, outputJson);
    } else if (orch?.publishPath) {
      const publishPath = path.isAbsolute(orch.publishPath)
        ? orch.publishPath
        : path.join(root, orch.publishPath);
      await fs.mkdir(path.dirname(publishPath), { recursive: true });
      await fs.writeFile(publishPath, outputJson);

      // Create alias symlink if configured
      if (orch.publishAlias && workflowName) {
        const aliasPath = path.join(this.outputsPublishDir, `${orch.publishAlias}.json`);
        await fs.mkdir(path.dirname(aliasPath), { recursive: true });
        try { await fs.unlink(aliasPath); } catch { /* ignore */ }
        await fs.symlink(publishPath, aliasPath);
      }
    }

    // Handle export to absolute path (cross-project sharing)
    if (orch?.exportPath) {
      await fs.mkdir(path.dirname(orch.exportPath), { recursive: true });
      await fs.writeFile(orch.exportPath, outputJson);
    }

    return this.outputsPath;
  }

  // ─── Signals ────────────────────────────────────────────

  /** Emit an orchestration signal. Returns signal file path or undefined. */
  async emitSignal(
    signalType: string,
    workflowName: string,
    outputsPath?: string,
    metadata?: Record<string, unknown>,
  ): Promise<string | undefined> {
    if (!this.config.emitSignals) return undefined;

    const signal: Signal = {
      signalType,
      runId: this.runId,
      timestamp: nowIso(),
      workflow: workflowName,
      outputsPath,
      metadata: metadata ?? {},
    };
    return saveSignal(this.signalsDir, signal);
  }

  /** Clear all signals for a workflow. */
  async clearSignals(workflowName: string): Promise<void> {
    for (const signalType of ['started', 'completed', 'failed', 'ready']) {
      const signalPath = path.join(this.signalsDir, `${workflowName}.${signalType}`);
      try { await fs.unlink(signalPath); } catch { /* ignore */ }
    }
  }

  // ─── Metadata ───────────────────────────────────────────

  /** Save run metadata to disk. */
  async saveMetadata(metadata: RunMetadata): Promise<string> {
    await this.ensureDirs();
    await fs.writeFile(this.metadataPath, JSON.stringify(metadata, null, 2));
    return this.metadataPath;
  }

  // ─── Branch iterations ──────────────────────────────────

  /** Save branch iteration state to disk. */
  async saveBranchIteration(
    branchId: string,
    state: BranchIterationState,
  ): Promise<string> {
    const filePath = this.iterationPath(branchId, state.iteration);
    if (!this.config.persistBranchState) return filePath;
    await saveBranchIterationState(filePath, state);
    return filePath;
  }

  /** Load all iteration states for a branch. */
  async loadBranchIterations(branchId: string): Promise<BranchIterationState[]> {
    const dir = this.branchesDir(branchId);
    try {
      const entries = await fs.readdir(dir);
      const files = entries
        .filter((f) => f.startsWith('iteration_') && f.endsWith('.json'))
        .sort();
      const results: BranchIterationState[] = [];
      for (const file of files) {
        try {
          results.push(await loadBranchIterationState(path.join(dir, file)));
        } catch { /* skip corrupted files */ }
      }
      return results;
    } catch {
      return [];
    }
  }

  /** Get the most recent iteration state for a branch. */
  async getLatestIteration(branchId: string): Promise<BranchIterationState | undefined> {
    const iterations = await this.loadBranchIterations(branchId);
    return iterations.length > 0 ? iterations[iterations.length - 1] : undefined;
  }

  // ─── Map items ──────────────────────────────────────────

  /** Save map item state to disk. */
  async saveMapItem(mapId: string, state: MapItemState): Promise<string> {
    const filePath = this.mapItemPath(mapId, state.index);
    if (!this.config.persistBranchState) return filePath;
    await saveMapItemState(filePath, state);
    return filePath;
  }

  /** Load all item states for a map node. */
  async loadMapItems(mapId: string): Promise<MapItemState[]> {
    const dir = this.mapsDir(mapId);
    try {
      const entries = await fs.readdir(dir);
      const files = entries
        .filter((f) => f.startsWith('item_') && f.endsWith('.json'))
        .sort();
      const results: MapItemState[] = [];
      for (const file of files) {
        try {
          results.push(await loadMapItemState(path.join(dir, file)));
        } catch { /* skip corrupted files */ }
      }
      return results;
    } catch {
      return [];
    }
  }
}

// ─── Factory functions ─────────────────────────────────────

/** Create an ArtifactManager for a run. */
export function getArtifactManager(
  projectRoot: string,
  runId: string,
  artifactDir?: string,
  emitSignals = false,
  orchestration?: OrchestrationConfig,
): ArtifactManager {
  const baseDir = artifactDir ?? path.join(projectRoot, '.harpoon');
  const config: ArtifactConfig = {
    baseDir,
    projectRoot,
    persistTrace: true,
    persistOutputs: true,
    persistCheckpoint: true,
    persistBranchState: true,
    emitSignals,
    orchestration,
  };
  return new ArtifactManager(config, runId);
}

/** Find the most recent run ID for a project. */
export function findLatestRun(projectRoot: string): string | undefined {
  const manifestPath = path.join(projectRoot, '.harpoon', 'runs', 'manifest.json');
  const manifest = loadRunManifest(manifestPath);
  const latest = getLatestRun(manifest);
  return latest?.runId;
}

/** Resolve input data from various sources. */
export async function resolveInputSource(
  source: string,
  projectRoot: string,
): Promise<Record<string, unknown>> {
  let filePath: string;

  if (source.startsWith('alias:')) {
    const alias = source.slice(6);
    filePath = path.join(projectRoot, '.harpoon', 'outputs', `${alias}.json`);
  } else if (source.startsWith('run:')) {
    const runId = source.slice(4);
    filePath = path.join(projectRoot, '.harpoon', 'runs', runId, 'outputs.json');
  } else {
    filePath = path.isAbsolute(source) ? source : path.join(projectRoot, source);
  }

  try {
    const raw = await fs.readFile(filePath, 'utf-8');
    return JSON.parse(raw) as Record<string, unknown>;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`Input source not found: ${filePath}`);
    }
    throw err;
  }
}
