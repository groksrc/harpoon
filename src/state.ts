/**
 * Workflow state tracking.
 *
 * Provides a single state.json file per run that tracks:
 * - Workflow status and metadata
 * - All node states with explicit status enum
 * - Execution costs and timing
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

/** Status of a node in the workflow. */
export enum NodeStatus {
  PENDING = "pending",
  WAITING = "waiting",
  RUNNING = "running",
  COMPLETED = "completed",
  ERRORED = "errored",
  SKIPPED = "skipped",
}

/** Status of the overall workflow. */
export enum WorkflowStatus {
  RUNNING = "running",
  COMPLETED = "completed",
  FAILED = "failed",
  INTERRUPTED = "interrupted",
}

/** Tracks the main workflow process. */
export interface WorkflowProcess {
  pid: number | null;
  status: string;
  startedAt: string;
  updatedAt: string;
  endedAt: string | null;
}

/** Process associated with a node (e.g., CLI agent). */
export interface NodeProcess {
  pid: number;
  type: string; // "agent_cli", "agent_sdk"
  startedAt: string;
}

/** State of a single node. */
export interface NodeState {
  status: string;
  startedAt: string | null;
  endedAt: string | null;
  outputs: Record<string, unknown>;
  process: NodeProcess | null;
  error: string | null;
  sessionId: string | null;
  costUsd: number | null;
  numTurns: number;
}

/** Workflow execution state. */
export interface WorkflowStateData {
  version: string;
  runId: string;
  projectName: string;
  workflow: WorkflowProcess | null;
  nodes: Record<string, NodeState>;
  inputs: Record<string, unknown>;
  entrypoint: string | null;
  totalCostUsd: number;
  branchStates: Record<string, number>;
}

function nowIso(): string {
  return new Date().toISOString();
}

function createNodeState(status: string = NodeStatus.PENDING): NodeState {
  return {
    status,
    startedAt: null,
    endedAt: null,
    outputs: {},
    process: null,
    error: null,
    sessionId: null,
    costUsd: null,
    numTurns: 0,
  };
}

// -- Serialization helpers (camelCase <-> snake_case for JSON compat) --

function workflowProcessToJson(wp: WorkflowProcess): Record<string, unknown> {
  return {
    pid: wp.pid,
    status: wp.status,
    started_at: wp.startedAt,
    updated_at: wp.updatedAt,
    ended_at: wp.endedAt,
  };
}

function workflowProcessFromJson(data: Record<string, unknown>): WorkflowProcess {
  return {
    pid: data.pid as number | null,
    status: data.status as string,
    startedAt: data.started_at as string,
    updatedAt: data.updated_at as string,
    endedAt: (data.ended_at as string) ?? null,
  };
}

function nodeProcessToJson(np: NodeProcess): Record<string, unknown> {
  return {
    pid: np.pid,
    type: np.type,
    started_at: np.startedAt,
  };
}

function nodeProcessFromJson(data: Record<string, unknown>): NodeProcess {
  return {
    pid: data.pid as number,
    type: data.type as string,
    startedAt: data.started_at as string,
  };
}

function nodeStateToJson(ns: NodeState): Record<string, unknown> {
  return {
    status: ns.status,
    started_at: ns.startedAt,
    ended_at: ns.endedAt,
    outputs: ns.outputs,
    process: ns.process ? nodeProcessToJson(ns.process) : null,
    error: ns.error,
    session_id: ns.sessionId,
    cost_usd: ns.costUsd,
    num_turns: ns.numTurns,
  };
}

function nodeStateFromJson(data: Record<string, unknown>): NodeState {
  const processData = data.process as Record<string, unknown> | null;
  return {
    status: data.status as string,
    startedAt: (data.started_at as string) ?? null,
    endedAt: (data.ended_at as string) ?? null,
    outputs: (data.outputs as Record<string, unknown>) ?? {},
    process: processData ? nodeProcessFromJson(processData) : null,
    error: (data.error as string) ?? null,
    sessionId: (data.session_id as string) ?? null,
    costUsd: (data.cost_usd as number) ?? null,
    numTurns: (data.num_turns as number) ?? 0,
  };
}

function stateToJson(state: WorkflowStateData): Record<string, unknown> {
  const nodes: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(state.nodes)) {
    nodes[k] = nodeStateToJson(v);
  }
  return {
    version: state.version,
    run_id: state.runId,
    project_name: state.projectName,
    workflow: state.workflow ? workflowProcessToJson(state.workflow) : null,
    nodes,
    inputs: state.inputs,
    entrypoint: state.entrypoint,
    total_cost_usd: state.totalCostUsd,
    branch_states: state.branchStates,
  };
}

function stateFromJson(data: Record<string, unknown>): WorkflowStateData {
  const workflowData = data.workflow as Record<string, unknown> | null;
  const nodesData = (data.nodes as Record<string, Record<string, unknown>>) ?? {};

  const nodes: Record<string, NodeState> = {};
  for (const [k, v] of Object.entries(nodesData)) {
    nodes[k] = nodeStateFromJson(v);
  }

  return {
    version: (data.version as string) ?? "2",
    runId: (data.run_id as string) ?? "",
    projectName: (data.project_name as string) ?? "",
    workflow: workflowData ? workflowProcessFromJson(workflowData) : null,
    nodes,
    inputs: (data.inputs as Record<string, unknown>) ?? {},
    entrypoint: (data.entrypoint as string) ?? null,
    totalCostUsd: (data.total_cost_usd as number) ?? 0.0,
    branchStates: (data.branch_states as Record<string, number>) ?? {},
  };
}

/** Create a new workflow state with all nodes initialized as pending. */
export function createWorkflowState(
  runId: string,
  projectName: string,
  nodeIds: string[],
  entrypoint?: string,
  inputs?: Record<string, unknown>
): WorkflowStateData {
  const now = nowIso();
  const nodes: Record<string, NodeState> = {};
  for (const nodeId of nodeIds) {
    nodes[nodeId] = createNodeState();
  }
  return {
    version: "2",
    runId,
    projectName,
    workflow: {
      pid: process.pid,
      status: WorkflowStatus.RUNNING,
      startedAt: now,
      updatedAt: now,
      endedAt: null,
    },
    nodes,
    inputs: inputs ?? {},
    entrypoint: entrypoint ?? null,
    totalCostUsd: 0.0,
    branchStates: {},
  };
}

/** Load state from a JSON file. Returns null if file doesn't exist or is invalid. */
export function loadState(path: string): WorkflowStateData | null {
  if (!existsSync(path)) {
    return null;
  }
  try {
    const content = readFileSync(path, "utf-8");
    const data = JSON.parse(content);
    return stateFromJson(data);
  } catch {
    return null;
  }
}

/** Save state to a JSON file. */
export function saveState(state: WorkflowStateData, path: string): void {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true });
  const json = JSON.stringify(stateToJson(state), null, 2);
  writeFileSync(path, json, "utf-8");
}

/** Update the workflow status. */
export function updateWorkflowStatus(
  state: WorkflowStateData,
  status: WorkflowStatus,
): void {
  if (state.workflow) {
    const now = nowIso();
    state.workflow.status = status;
    state.workflow.updatedAt = now;
    if (
      status === WorkflowStatus.COMPLETED ||
      status === WorkflowStatus.FAILED ||
      status === WorkflowStatus.INTERRUPTED
    ) {
      state.workflow.endedAt = now;
    }
  }
}

/** Update the workflow heartbeat timestamp. */
export function updateHeartbeat(state: WorkflowStateData): void {
  if (state.workflow) {
    state.workflow.updatedAt = nowIso();
  }
}

/** Mark a node as running. */
export function setNodeRunning(
  state: WorkflowStateData,
  nodeId: string,
  nodeProcess?: NodeProcess
): void {
  const now = nowIso();
  if (!state.nodes[nodeId]) {
    state.nodes[nodeId] = createNodeState(NodeStatus.RUNNING);
    state.nodes[nodeId].startedAt = now;
  } else {
    state.nodes[nodeId].status = NodeStatus.RUNNING;
    state.nodes[nodeId].startedAt = now;
  }
  if (nodeProcess) {
    state.nodes[nodeId].process = nodeProcess;
  }
}

/** Mark a node as completed. */
export function setNodeCompleted(
  state: WorkflowStateData,
  nodeId: string,
  outputs: Record<string, unknown>,
  sessionId?: string,
  costUsd?: number,
  numTurns: number = 0
): void {
  const now = nowIso();
  if (!state.nodes[nodeId]) {
    state.nodes[nodeId] = createNodeState(NodeStatus.COMPLETED);
  }
  const node = state.nodes[nodeId];
  node.status = NodeStatus.COMPLETED;
  node.endedAt = now;
  node.outputs = outputs;
  node.sessionId = sessionId ?? null;
  node.costUsd = costUsd ?? null;
  node.numTurns = numTurns;
  node.process = null;

  if (costUsd) {
    state.totalCostUsd += costUsd;
  }
}

/** Mark a node as errored. */
export function setNodeErrored(
  state: WorkflowStateData,
  nodeId: string,
  error: string
): void {
  const now = nowIso();
  if (!state.nodes[nodeId]) {
    state.nodes[nodeId] = createNodeState(NodeStatus.ERRORED);
  }
  const node = state.nodes[nodeId];
  node.status = NodeStatus.ERRORED;
  node.endedAt = now;
  node.error = error;
  node.process = null;
}

/** Mark a node as skipped. */
export function setNodeSkipped(
  state: WorkflowStateData,
  nodeId: string
): void {
  const now = nowIso();
  if (!state.nodes[nodeId]) {
    state.nodes[nodeId] = createNodeState(NodeStatus.SKIPPED);
  } else {
    state.nodes[nodeId].status = NodeStatus.SKIPPED;
    state.nodes[nodeId].endedAt = now;
  }
}

/** Get the state.json path for a run directory. */
export function getStatePath(runDir: string): string {
  return join(runDir, "state.json");
}
