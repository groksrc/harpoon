/**
 * DAG execution engine.
 *
 * Executes a Harpoon project by building the DAG, then running nodes
 * level by level with parallel execution within each level.
 */

import * as path from "node:path";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";

import { evaluate } from "./conditions.js";
import {
  buildDag,
  getAncestors,
  validateEdgeMappings,
} from "./dag.js";
import type { DAG } from "./dag.js";
import {
  HarpoonError,
  NodeExecutionError,
  SchemaValidationError,
  BranchError,
  MapError,
} from "./errors.js";
import { parsePromptFile } from "./parser.js";
import type { PromptNode } from "./parser.js";
import type { Edge, Project } from "./project.js";
import { loadProject } from "./project.js";
import { getRegistry } from "./providers/base.js";
import type { CompletionConfig, ProviderRegistry } from "./providers/base.js";
import {
  createWorkflowState,
  setNodeRunning,
  setNodeCompleted,
  setNodeErrored,
  setNodeSkipped,
  updateWorkflowStatus,
  saveState,
  getStatePath,
  WorkflowStatus,
} from "./state.js";
import type { WorkflowStateData } from "./state.js";
import { getNested, render } from "./template.js";
import { TypeScriptToolRunner } from "./tools/typescript.js";
import type { ToolDef as TSToolDef } from "./tools/typescript.js";
import {
  getArtifactManager,
} from "./artifacts.js";
import type {
  ArtifactManager,
  RunMetadata,
  BranchIterationState,
  MapItemState,
} from "./artifacts.js";
import {
  EventType,
  TelemetryLevel,
  TelemetryEmitter,
  setEmitter,
  emit,
} from "./telemetry.js";
import type { TelemetryConfig } from "./telemetry.js";

// Agent execution
import { isSdkAvailable, executeAgent } from "./agents.js";
import type { AgentResult } from "./agents.js";
import { executeAgentViaCli } from "./cli-agents.js";

// ─── Data Interfaces ─────────────────────────────────────────

/** Execution trace for a single node. */
export interface NodeTrace {
  id: string;
  startTime: string;
  endTime?: string;
  input: Record<string, unknown>;
  output: Record<string, unknown>;
  model?: string;
  tokens: Record<string, number>;
  skipped: boolean;
  error?: string;
  errorType?: string;
  costUsd?: number;
  sessionId?: string;
  numTurns: number;
}

/** Full execution trace. */
export interface ExecutionTrace {
  runId: string;
  startTime: string;
  endTime?: string;
  nodes: NodeTrace[];
  error?: string;
}

/** Result of DAG execution. */
export interface ExecutionResult {
  outputs: Record<string, unknown>;
  trace: ExecutionTrace;
  error?: NodeExecutionError;
  success: boolean;
}

/** Data for a completed node in a checkpoint. */
export interface CheckpointNodeData {
  outputs: Record<string, unknown>;
  completedAt: string;
  sessionId?: string;
  costUsd?: number;
  numTurns: number;
}

/** Workflow execution checkpoint for resumption. */
export interface Checkpoint {
  runId: string;
  projectName: string;
  startedAt: string;
  updatedAt: string;
  status: string;
  completedNodes: Record<string, CheckpointNodeData>;
  pendingNodes: string[];
  totalCostUsd: number;
  inputs: Record<string, unknown>;
  entrypoint?: string;
  branchStates: Record<string, number>;
  mapStates: Record<string, number[]>;
}

/** Internal result of executing a single node. */
interface NodeExecutionResult {
  nodeId: string;
  nodeTrace: NodeTrace;
  output?: Record<string, unknown>;
  error?: Error;
  skipped: boolean;
}

/** Options for running a project. */
export interface RunOptions {
  entrypoint?: string;
  inputs?: Record<string, unknown>;
  dryRun?: boolean;
  verbose?: boolean;
  resumeSessions?: Record<string, string>;
  resumeFrom?: string;
  artifactDir?: string;
  runId?: string;
  startFrom?: string;
  emitSignals?: boolean;
  publishTo?: string;
  telemetryConfig?: TelemetryConfig;
  inputFrom?: string;
}

// ─── Utilities ───────────────────────────────────────────────

function nowIso(): string {
  return new Date().toISOString();
}

function validateSchema(
  data: Record<string, unknown>,
  schema: Record<string, [string, string]>
): void {
  for (const [fieldName, [fieldType]] of Object.entries(schema)) {
    if (!(fieldName in data)) {
      throw new SchemaValidationError(
        `Missing required field: ${fieldName}`
      );
    }

    const value = data[fieldName];
    const expectedTypes: Record<string, string> = {
      string: "string",
      number: "number",
      boolean: "boolean",
    };
    const expected = expectedTypes[fieldType];
    if (expected && typeof value !== expected) {
      throw new SchemaValidationError(
        `Field '${fieldName}' expected ${fieldType}, got ${typeof value}`
      );
    }
    if (fieldType === "array" && !Array.isArray(value)) {
      throw new SchemaValidationError(
        `Field '${fieldName}' expected array, got ${typeof value}`
      );
    }
    if (
      fieldType === "object" &&
      (typeof value !== "object" || value === null || Array.isArray(value))
    ) {
      throw new SchemaValidationError(
        `Field '${fieldName}' expected object, got ${typeof value}`
      );
    }
  }
}

function validateRequiredInputs(
  gathered: Record<string, unknown>,
  promptNode: PromptNode
): void {
  const missing: string[] = [];
  for (const [name, inputField] of Object.entries(promptNode.inputs)) {
    if (!inputField.required) continue;
    if (inputField.default !== undefined) continue;
    if (!(name in gathered) || gathered[name] === null || gathered[name] === undefined) {
      missing.push(name);
    }
  }

  if (missing.length > 0) {
    throw new SchemaValidationError(
      `Missing required input(s) for '${promptNode.id}': ${missing.join(", ")}. ` +
        `Check edge mappings to ensure these fields are provided.`
    );
  }
}

function gatherInputs(
  nodeId: string,
  dag: DAG,
  nodeOutputs: Record<string, Record<string, unknown>>
): Record<string, unknown> {
  const inputs: Record<string, unknown> = {};
  const node = dag.nodes[nodeId];

  for (const edge of node.incomingEdges) {
    const sourceOutput = nodeOutputs[edge.fromNode] ?? {};
    if (Object.keys(sourceOutput).length === 0) continue;

    for (const mapping of edge.mappings) {
      let value = getNested(sourceOutput, mapping.sourceExpr);
      if (value === undefined && mapping.sourceExpr.includes(".")) {
        let altExpr = mapping.sourceExpr;
        if (altExpr.startsWith("output.")) {
          altExpr = altExpr.slice(7);
        }
        value = getNested(sourceOutput, altExpr);
      }

      if (value !== undefined || !(mapping.targetVar in inputs)) {
        inputs[mapping.targetVar] = value;
      }
    }
  }

  return inputs;
}

function shouldExecuteEdge(
  edge: Edge,
  sourceOutput: Record<string, unknown>
): boolean {
  if (!edge.condition) return true;

  const context = { output: sourceOutput, ...sourceOutput };
  try {
    return evaluate(edge.condition, context);
  } catch {
    return false;
  }
}

function generateMockOutput(promptNode: PromptNode): Record<string, unknown> {
  if (promptNode.output.format === "text") {
    return { text: "[DRY RUN] Mock text response" };
  }

  const mock: Record<string, unknown> = {};
  const typeDefaults: Record<string, (name: string) => unknown> = {
    string: (name) => `[mock_${name}]`,
    number: () => 0,
    boolean: () => true,
    array: () => [],
    object: () => ({}),
  };

  for (const [fieldName, [fieldType]] of Object.entries(
    promptNode.output.fields
  )) {
    const defaultFn = typeDefaults[fieldType] ?? (() => null);
    mock[fieldName] = defaultFn(fieldName);
  }
  return { text: JSON.stringify(mock), ...mock };
}

function flattenWorkflowOutputs(
  rawOutputs: Record<string, unknown>
): Record<string, unknown> {
  if (Object.keys(rawOutputs).length === 0) return {};
  if (Object.keys(rawOutputs).length === 1) {
    const single = Object.values(rawOutputs)[0];
    if (typeof single === "object" && single !== null && !Array.isArray(single)) {
      return single as Record<string, unknown>;
    }
    return rawOutputs;
  }
  const flat: Record<string, unknown> = {};
  for (const nodeOut of Object.values(rawOutputs)) {
    if (typeof nodeOut === "object" && nodeOut !== null && !Array.isArray(nodeOut)) {
      Object.assign(flat, nodeOut);
    } else {
      return rawOutputs;
    }
  }
  return flat;
}

// ─── Checkpoint Persistence ──────────────────────────────────

function saveCheckpoint(checkpoint: Checkpoint, dir: string): string {
  mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, `${checkpoint.runId}.json`);
  writeFileSync(filePath, JSON.stringify(checkpoint, null, 2));
  return filePath;
}

function loadCheckpoint(filePath: string): Checkpoint {
  const data = JSON.parse(readFileSync(filePath, "utf-8"));
  return data as Checkpoint;
}

function createNodeTrace(nodeId: string): NodeTrace {
  return {
    id: nodeId,
    startTime: nowIso(),
    input: {},
    output: {},
    tokens: {},
    skipped: false,
    numTurns: 0,
  };
}

// ─── Node Executors ──────────────────────────────────────────

function executePromptNode(
  nodeId: string,
  project: Project,
  dag: DAG,
  nodeOutputs: Record<string, Record<string, unknown>>,
  nodeTrace: NodeTrace,
  registry: ProviderRegistry,
  dryRun: boolean
): void {
  const promptNode = project.prompts[nodeId];
  if (!promptNode) {
    throw new HarpoonError("Prompt definition not found in project");
  }

  const gathered = gatherInputs(nodeId, dag, nodeOutputs);
  nodeTrace.input = gathered;

  validateRequiredInputs(gathered, promptNode);

  const model = promptNode.model ?? project.defaults.model;
  if (!model) {
    throw new HarpoonError(
      "No model specified. Set 'model' in prompt or project defaults."
    );
  }
  nodeTrace.model = model;

  if (dryRun) {
    nodeTrace.output = generateMockOutput(promptNode);
    nodeTrace.tokens = { input: 0, output: 0 };
    return;
  }

  const providerResult = registry.getForModel(model);
  if (!providerResult) {
    throw new HarpoonError(
      `No provider found for model '${model}'. ` +
        `Check ANTHROPIC_API_KEY or OPENAI_API_KEY is set.`
    );
  }
  const [provider, modelName] = providerResult;

  const rendered = render(promptNode.body, gathered);

  const config: CompletionConfig = {
    model: modelName,
    temperature: promptNode.temperature ?? project.defaults.temperature,
    maxTokens: promptNode.maxTokens ?? project.defaults.maxTokens,
    outputFormat: promptNode.output.format as "text" | "json",
    outputSchema:
      promptNode.output.format === "json" ? promptNode.output.fields : undefined,
  };

  // Note: provider.complete is sync in the Python port but async in TS
  // For now we call it and handle the promise
  const resultPromise = provider.complete(rendered, config);

  // Since we're called from an async context via Promise, we need to handle this
  // The executor wraps this in an async function
  throw new HarpoonError(
    "Prompt execution requires async context. This is handled by the executor."
  );
}

async function executePromptNodeAsync(
  nodeId: string,
  project: Project,
  dag: DAG,
  nodeOutputs: Record<string, Record<string, unknown>>,
  nodeTrace: NodeTrace,
  registry: ProviderRegistry,
  dryRun: boolean
): Promise<void> {
  const promptNode = project.prompts[nodeId];
  if (!promptNode) {
    throw new HarpoonError("Prompt definition not found in project");
  }

  const gathered = gatherInputs(nodeId, dag, nodeOutputs);
  nodeTrace.input = gathered;

  validateRequiredInputs(gathered, promptNode);

  const model = promptNode.model ?? project.defaults.model;
  if (!model) {
    throw new HarpoonError(
      "No model specified. Set 'model' in prompt or project defaults."
    );
  }
  nodeTrace.model = model;

  if (dryRun) {
    nodeTrace.output = generateMockOutput(promptNode);
    nodeTrace.tokens = { input: 0, output: 0 };
    return;
  }

  const providerResult = registry.getForModel(model);
  if (!providerResult) {
    throw new HarpoonError(
      `No provider found for model '${model}'. ` +
        `Check ANTHROPIC_API_KEY or OPENAI_API_KEY is set.`
    );
  }
  const [provider, modelName] = providerResult;

  const rendered = render(promptNode.body, gathered);

  const config: CompletionConfig = {
    model: modelName,
    temperature: promptNode.temperature ?? project.defaults.temperature,
    maxTokens: promptNode.maxTokens ?? project.defaults.maxTokens,
    outputFormat: promptNode.output.format as "text" | "json",
    outputSchema:
      promptNode.output.format === "json" ? promptNode.output.fields : undefined,
  };

  const result = await provider.complete(rendered, config);
  nodeTrace.tokens = {
    input: result.inputTokens,
    output: result.outputTokens,
  };

  if (promptNode.output.format === "json") {
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(result.content);
    } catch (e) {
      throw new SchemaValidationError(
        `LLM returned invalid JSON. Response started with: ${result.content.slice(0, 100)}`
      );
    }

    if (Object.keys(promptNode.output.fields).length > 0) {
      validateSchema(parsed, promptNode.output.fields);
    }

    nodeTrace.output = { text: result.content, ...parsed };
  } else {
    nodeTrace.output = { text: result.content };
  }
}

async function executeToolNodeAsync(
  nodeId: string,
  project: Project,
  dag: DAG,
  nodeOutputs: Record<string, Record<string, unknown>>,
  nodeTrace: NodeTrace,
  toolRunner: TypeScriptToolRunner
): Promise<void> {
  const toolDef = project.tools[nodeId];
  if (!toolDef) {
    throw new HarpoonError("Tool definition not found in project");
  }

  const gathered = gatherInputs(nodeId, dag, nodeOutputs);
  nodeTrace.input = gathered;

  const tsToolDef: TSToolDef = {
    id: toolDef.id,
    type: toolDef.type,
    path: toolDef.path,
    module: toolDef.module,
    function: toolDef.function,
    description: toolDef.description,
  };

  const result = await toolRunner.execute(tsToolDef, gathered);
  nodeTrace.output = result;
}

async function executeAgentNodeAsync(
  nodeId: string,
  project: Project,
  dag: DAG,
  nodeOutputs: Record<string, Record<string, unknown>>,
  nodeTrace: NodeTrace,
  dryRun: boolean,
  resumeSession?: string,
  runId?: string
): Promise<void> {
  const agentNode = project.agents[nodeId];
  if (!agentNode) {
    throw new HarpoonError("Agent definition not found in project");
  }

  // Load prompt if not already loaded
  if (!agentNode.promptNode) {
    const promptPath = path.join(project.root, agentNode.promptPath);
    if (existsSync(promptPath)) {
      agentNode.promptNode = parsePromptFile(promptPath);
    } else {
      throw new HarpoonError(`Agent prompt not found: ${promptPath}`);
    }
  }

  const gathered = gatherInputs(nodeId, dag, nodeOutputs);
  nodeTrace.input = gathered;

  validateRequiredInputs(gathered, agentNode.promptNode);

  if (dryRun) {
    if (agentNode.promptNode.output.format === "json") {
      const mock: Record<string, unknown> = {};
      for (const [fieldName, [fieldType]] of Object.entries(
        agentNode.promptNode.output.fields
      )) {
        if (fieldType === "string") mock[fieldName] = `[mock_${fieldName}]`;
        else if (fieldType === "array") mock[fieldName] = [];
        else mock[fieldName] = null;
      }
      nodeTrace.output = mock;
    } else {
      nodeTrace.output = { text: "[DRY RUN] Mock agent response" };
    }
    nodeTrace.tokens = { input: 0, output: 0 };
    return;
  }

  let result: AgentResult;

  if (agentNode.executionMode === "cli") {
    // CLI mode
    let telemetryCallback: ((hookType: string, toolName: string, data: Record<string, unknown>) => void) | undefined;
    if (runId) {
      telemetryCallback = (hookType: string, toolName: string, data: Record<string, unknown>) => {
        if (hookType === "PreToolUse") {
          emit(
            EventType.AGENT_TOOL_CALLED,
            runId,
            { tool: toolName, input: data },
            nodeId,
            TelemetryLevel.DEBUG
          );
        } else if (hookType === "PostToolUse") {
          emit(
            EventType.AGENT_TOOL_RESULT,
            runId,
            { tool: toolName },
            nodeId,
            TelemetryLevel.DEBUG
          );
        } else if (hookType === "Message") {
          emit(
            EventType.AGENT_MESSAGE,
            runId,
            { message: (data as Record<string, unknown>)["message"] ?? "" },
            nodeId,
            TelemetryLevel.INFO
          );
        }
      };
    }

    result = executeAgentViaCli(
      agentNode,
      gathered,
      project.root,
      resumeSession,
      telemetryCallback
    );
  } else {
    // SDK mode
    if (!isSdkAvailable()) {
      throw new HarpoonError(
        "Agent SDK not available. Either:\n" +
          "  1. Install with: npm install @anthropic-ai/claude-agent-sdk\n" +
          "  2. Use execution_mode: cli in your manifest"
      );
    }
    result = await executeAgent(
      agentNode,
      gathered,
      project.root,
      resumeSession
    );
  }

  nodeTrace.output = result.output;
  nodeTrace.tokens = result.tokens;
  nodeTrace.costUsd = result.costUsd;
  nodeTrace.sessionId = result.sessionId;
  nodeTrace.numTurns = result.numTurns;
}

async function executeBranchNodeAsync(
  nodeId: string,
  project: Project,
  dag: DAG,
  nodeOutputs: Record<string, Record<string, unknown>>,
  nodeTrace: NodeTrace,
  dryRun: boolean,
  verbose: boolean,
  artifactManager?: ArtifactManager,
  checkpoint?: Checkpoint,
  checkpointDir?: string
): Promise<void> {
  const branchNode = project.branches[nodeId];
  if (!branchNode) {
    throw new HarpoonError(`Branch definition not found: ${nodeId}`);
  }

  const gathered = gatherInputs(nodeId, dag, nodeOutputs);
  nodeTrace.input = gathered;

  // Evaluate pre-condition
  if (branchNode.condition) {
    const context = { output: gathered, ...gathered };
    try {
      const shouldRun = evaluate(branchNode.condition, context);
      if (!shouldRun) {
        nodeTrace.skipped = true;
        nodeTrace.output = gathered;
        if (verbose) {
          process.stdout.write(`  Branch ${nodeId} skipped (condition false)\n`);
        }
        return;
      }
    } catch (e) {
      throw new BranchError(
        `Failed to evaluate branch condition: ${branchNode.condition}`,
        0,
        0,
        e instanceof Error ? e : undefined
      );
    }
  }

  if (dryRun) {
    nodeTrace.output = { dry_run: true, ...gathered };
    return;
  }

  // Resolve workflow
  let subProject: Project;
  if (branchNode.workflowPath === "self") {
    subProject = project;
  } else {
    const workflowPath = path.resolve(project.root, branchNode.workflowPath);
    if (!existsSync(workflowPath)) {
      throw new BranchError(`Sub-workflow not found: ${workflowPath}`);
    }
    subProject = loadProject(workflowPath);
  }

  // Determine starting iteration for resumption
  let startIteration = 0;
  if (checkpoint && nodeId in checkpoint.branchStates) {
    startIteration = checkpoint.branchStates[nodeId] + 1;
  }

  let currentInputs = gathered;
  let iteration = startIteration;
  let finalOutputs: Record<string, unknown> = {};

  while (true) {
    if (verbose) {
      if (branchNode.loopWhile) {
        process.stdout.write(
          `  [${nodeId}] Iteration ${iteration + 1}/${branchNode.maxIterations}\n`
        );
      } else {
        process.stdout.write(
          `  Executing sub-workflow: ${branchNode.workflowPath}\n`
        );
      }
    }

    const iterationStart = nowIso();

    // Determine sub-workflow artifact dir
    let subArtifactDir: string | undefined;
    if (artifactManager) {
      subArtifactDir = path.join(
        artifactManager.branchesDir(nodeId),
        `iter_${iteration}`
      );
    }

    const subResult = await run(subProject, {
      inputs: currentInputs,
      dryRun,
      verbose,
      artifactDir: subArtifactDir,
    });

    const iterationEnd = nowIso();

    // Save iteration state
    if (artifactManager) {
      const iterationState: BranchIterationState = {
        branchId: nodeId,
        iteration,
        inputs: currentInputs,
        outputs: subResult.outputs,
        startedAt: iterationStart,
        endedAt: iterationEnd,
        success: subResult.success,
        error: subResult.error ? String(subResult.error) : undefined,
      };
      await artifactManager.saveBranchIteration(nodeId, iterationState);
    }

    // Update checkpoint
    if (checkpoint) {
      checkpoint.branchStates[nodeId] = iteration;
      checkpoint.updatedAt = nowIso();
    }

    if (!subResult.success) {
      throw new BranchError(
        `Sub-workflow failed at iteration ${iteration + 1}: ${subResult.error}`,
        iteration,
        branchNode.maxIterations,
        subResult.error
      );
    }

    finalOutputs = flattenWorkflowOutputs(subResult.outputs);

    if (!branchNode.loopWhile) break;

    // Evaluate loop condition
    const context = { output: finalOutputs, ...finalOutputs };
    try {
      const shouldContinue = evaluate(branchNode.loopWhile, context);
      if (!shouldContinue) {
        if (verbose) {
          process.stdout.write(
            `  [${nodeId}] Loop condition false, stopping after ${iteration + 1} iterations\n`
          );
        }
        break;
      }
    } catch (e) {
      throw new BranchError(
        `Failed to evaluate loop condition: ${branchNode.loopWhile}`,
        iteration,
        branchNode.maxIterations,
        e instanceof Error ? e : undefined
      );
    }

    iteration++;
    if (iteration >= branchNode.maxIterations) {
      throw new BranchError(
        `Max iterations (${branchNode.maxIterations}) reached`,
        iteration,
        branchNode.maxIterations
      );
    }

    currentInputs = finalOutputs;
  }

  nodeTrace.output = finalOutputs;
}

async function executeMapNodeAsync(
  nodeId: string,
  project: Project,
  dag: DAG,
  nodeOutputs: Record<string, Record<string, unknown>>,
  nodeTrace: NodeTrace,
  dryRun: boolean,
  verbose: boolean,
  artifactManager?: ArtifactManager,
  checkpoint?: Checkpoint
): Promise<void> {
  const mapNode = project.maps[nodeId];
  if (!mapNode) {
    throw new HarpoonError(`Map definition not found: ${nodeId}`);
  }

  const gathered = gatherInputs(nodeId, dag, nodeOutputs);
  nodeTrace.input = gathered;

  const collection = gathered[mapNode.over];
  if (collection === undefined || collection === null) {
    throw new MapError(
      `Map node '${nodeId}': field '${mapNode.over}' not found in inputs`,
      -1,
      0
    );
  }
  if (!Array.isArray(collection)) {
    throw new MapError(
      `Map node '${nodeId}': field '${mapNode.over}' is not a list (got ${typeof collection})`,
      -1,
      0
    );
  }

  if (dryRun) {
    const mockItems = collection.map((_, i) => ({
      dry_run: true,
      index: i,
    }));
    nodeTrace.output = { items: mockItems, count: collection.length };
    return;
  }

  // Filter items via item_condition
  let indexedItems: [number, unknown][] = collection.map((item, i) => [
    i,
    item,
  ]);
  if (mapNode.itemCondition) {
    const filtered: [number, unknown][] = [];
    for (const [idx, item] of indexedItems) {
      const context = { item, index: idx };
      try {
        const shouldInclude = evaluate(
          mapNode.itemCondition,
          context as Record<string, unknown>
        );
        if (shouldInclude) filtered.push([idx, item]);
      } catch (e) {
        throw new MapError(
          `Map node '${nodeId}': failed to evaluate item_condition '${mapNode.itemCondition}' for item ${idx}`,
          idx,
          collection.length,
          e instanceof Error ? e : undefined
        );
      }
    }
    indexedItems = filtered;
  }

  // Load sub-workflow
  const workflowPath = path.resolve(project.root, mapNode.workflowPath);
  if (!existsSync(workflowPath)) {
    throw new MapError(`Map sub-workflow not found: ${workflowPath}`);
  }
  const subProject = loadProject(workflowPath);

  const passThrough = Object.fromEntries(
    Object.entries(gathered).filter(([k]) => k !== mapNode.over)
  );

  // Check checkpoint for already-completed items
  const completedIndices = new Set<number>();
  const completedOutputs: Record<number, Record<string, unknown>> = {};
  if (checkpoint && nodeId in checkpoint.mapStates) {
    for (const idx of checkpoint.mapStates[nodeId]) {
      completedIndices.add(idx);
    }
    if (artifactManager) {
      const savedItems = await artifactManager.loadMapItems(nodeId);
      for (const itemState of savedItems) {
        if (itemState.success) {
          completedOutputs[itemState.index] = itemState.outputs;
        }
      }
    }
  }

  const remainingItems = indexedItems.filter(
    ([idx]) => !completedIndices.has(idx)
  );
  const totalItems = indexedItems.length;

  if (verbose) {
    process.stdout.write(
      `  [${nodeId}] Processing ${remainingItems.length} items ` +
        `(${completedIndices.size} already completed, ${totalItems} total)\n`
    );
  }

  // Execute items with optional concurrency limit
  const concurrency = mapNode.maxConcurrency > 0 ? mapNode.maxConcurrency : remainingItems.length;
  const results: [number, Record<string, unknown> | null, Error | null][] = [];

  // Process in batches respecting concurrency
  for (let i = 0; i < remainingItems.length; i += concurrency) {
    const batch = remainingItems.slice(i, i + concurrency);
    const batchPromises = batch.map(async ([idx, item]) => {
      const itemInputs = { item, index: idx, ...passThrough };

      let subArtifactDir: string | undefined;
      if (artifactManager) {
        subArtifactDir = path.join(
          artifactManager.mapsDir(nodeId),
          `item_${idx}`
        );
      }

      try {
        const subResult = await run(subProject, {
          inputs: itemInputs,
          dryRun,
          verbose: false,
          artifactDir: subArtifactDir,
        });

        if (!subResult.success) {
          return [idx, null, subResult.error ?? new Error("Sub-workflow failed")] as [number, null, Error];
        }

        const flatOutputs = flattenWorkflowOutputs(subResult.outputs);
        return [idx, flatOutputs, null] as [number, Record<string, unknown>, null];
      } catch (e) {
        return [idx, null, e instanceof Error ? e : new Error(String(e))] as [number, null, Error];
      }
    });

    const batchResults = await Promise.all(batchPromises);
    results.push(...batchResults);
  }

  // Process results
  const itemResults: Record<number, Record<string, unknown>> = {
    ...completedOutputs,
  };
  const itemErrors: Record<number, Error> = {};

  for (const [idx, outputs, error] of results) {
    if (error) {
      itemErrors[idx] = error;

      if (artifactManager) {
        const itemState: MapItemState = {
          mapId: nodeId,
          index: idx,
          item: idx < collection.length ? collection[idx] : null,
          outputs: {},
          startedAt: nowIso(),
          endedAt: nowIso(),
          success: false,
          error: String(error),
        };
        await artifactManager.saveMapItem(nodeId, itemState);
      }
    } else {
      itemResults[idx] = outputs ?? {};

      if (artifactManager) {
        const itemState: MapItemState = {
          mapId: nodeId,
          index: idx,
          item: idx < collection.length ? collection[idx] : null,
          outputs: outputs ?? {},
          startedAt: nowIso(),
          endedAt: nowIso(),
          success: true,
        };
        await artifactManager.saveMapItem(nodeId, itemState);
      }
    }

    // Update checkpoint
    if (checkpoint) {
      if (!(nodeId in checkpoint.mapStates)) {
        checkpoint.mapStates[nodeId] = [];
      }
      if (!checkpoint.mapStates[nodeId].includes(idx)) {
        checkpoint.mapStates[nodeId].push(idx);
      }
      checkpoint.updatedAt = nowIso();
    }
  }

  // Handle errors per on_error mode
  if (Object.keys(itemErrors).length > 0) {
    if (mapNode.onError === "fail") {
      const firstIdx = Math.min(...Object.keys(itemErrors).map(Number));
      throw new MapError(
        `Map node '${nodeId}': item ${firstIdx} failed`,
        firstIdx,
        totalItems,
        itemErrors[firstIdx]
      );
    } else if (mapNode.onError === "skip") {
      if (verbose) {
        process.stdout.write(
          `  [${nodeId}] Skipped ${Object.keys(itemErrors).length} failed items\n`
        );
      }
    } else if (mapNode.onError === "collect") {
      for (const [idx, error] of Object.entries(itemErrors)) {
        itemResults[Number(idx)] = { error: String(error), index: Number(idx) };
      }
    }
  }

  const orderedIndices = Object.keys(itemResults)
    .map(Number)
    .sort((a, b) => a - b);
  const itemsList = orderedIndices.map((idx) => itemResults[idx]);

  nodeTrace.output = { items: itemsList, count: itemsList.length };
}

async function executeTriggerNodeAsync(
  nodeId: string,
  project: Project,
  dag: DAG,
  nodeOutputs: Record<string, Record<string, unknown>>,
  nodeTrace: NodeTrace,
  dryRun: boolean,
  verbose: boolean,
  artifactManager?: ArtifactManager
): Promise<void> {
  const triggerNode = project.triggers[nodeId];
  if (!triggerNode) {
    throw new HarpoonError(`Trigger definition not found: ${nodeId}`);
  }

  const gathered = gatherInputs(nodeId, dag, nodeOutputs);
  nodeTrace.input = gathered;

  // Evaluate pre-condition
  if (triggerNode.condition) {
    const context = { output: gathered, ...gathered };
    try {
      const shouldRun = evaluate(triggerNode.condition, context);
      if (!shouldRun) {
        nodeTrace.skipped = true;
        nodeTrace.output = {
          triggered: false,
          status: "skipped",
          output: {},
        };
        if (verbose) {
          process.stdout.write(
            `  Trigger ${nodeId} skipped (condition false)\n`
          );
        }
        return;
      }
    } catch (e) {
      throw new HarpoonError(
        `Failed to evaluate trigger condition: ${triggerNode.condition}`
      );
    }
  }

  if (dryRun) {
    nodeTrace.output = {
      triggered: false,
      status: "dry_run",
      output: {},
    };
    if (verbose) {
      process.stdout.write(
        `  [DRY RUN] Would trigger: ${triggerNode.workflowPath}\n`
      );
    }
    return;
  }

  const workflowPath = path.resolve(project.root, triggerNode.workflowPath);
  if (!existsSync(workflowPath)) {
    throw new HarpoonError(`Trigger workflow not found: ${workflowPath}`);
  }

  if (verbose) {
    process.stdout.write(
      `  Triggering workflow: ${triggerNode.workflowPath}\n`
    );
  }

  try {
    const subProject = loadProject(workflowPath);

    let subArtifactDir: string | undefined;
    if (artifactManager) {
      subArtifactDir = path.join(
        artifactManager.runDir,
        "triggers",
        nodeId
      );
    }

    const subResult = await run(subProject, {
      inputs: triggerNode.passOutputs ? gathered : undefined,
      dryRun,
      verbose,
      artifactDir: subArtifactDir,
      emitSignals: triggerNode.emitSignal,
    });

    if (!subResult.success) {
      throw new HarpoonError(
        `Triggered workflow failed: ${subResult.error}`
      );
    }

    const finalOutputs = flattenWorkflowOutputs(subResult.outputs);
    nodeTrace.output = {
      triggered: true,
      status: "success",
      output: finalOutputs,
    };

    if (verbose) {
      process.stdout.write(
        `  Triggered workflow completed: ${triggerNode.workflowPath}\n`
      );
    }
  } catch (e) {
    throw new HarpoonError(`Triggered workflow failed: ${e}`);
  }
}

// ─── Single Node Executor ────────────────────────────────────

async function executeNodeAsync(
  nodeId: string,
  project: Project,
  dag: DAG,
  nodeOutputs: Record<string, Record<string, unknown>>,
  registry: ProviderRegistry,
  toolRunner: TypeScriptToolRunner,
  dryRun: boolean,
  verbose: boolean,
  resumeSessions: Record<string, string> | undefined,
  artifactManager: ArtifactManager | undefined,
  checkpoint: Checkpoint | undefined,
  effectiveRunId: string,
  state: WorkflowStateData | undefined,
  checkpointDir?: string
): Promise<NodeExecutionResult> {
  const node = dag.nodes[nodeId];
  const nodeTrace = createNodeTrace(nodeId);

  emit(EventType.NODE_STARTED, effectiveRunId, { type: node.type }, nodeId, TelemetryLevel.INFO);

  // Update state: node is starting
  if (state && artifactManager) {
    setNodeRunning(state, nodeId);
    saveState(state, getStatePath(artifactManager.runDir));
  }

  try {
    if (verbose) {
      process.stdout.write(`Executing node: ${nodeId}\n`);
    }

    // Check if any incoming edge condition blocks execution
    let shouldRun = true;
    for (const edge of node.incomingEdges) {
      const sourceOutput = nodeOutputs[edge.fromNode] ?? {};
      if (!shouldExecuteEdge(edge, sourceOutput)) {
        shouldRun = false;
        break;
      }
    }

    if (!shouldRun) {
      nodeTrace.skipped = true;
      nodeTrace.endTime = nowIso();

      if (state && artifactManager) {
        setNodeSkipped(state, nodeId);
        saveState(state, getStatePath(artifactManager.runDir));
      }

      emit(EventType.NODE_SKIPPED, effectiveRunId, { reason: "edge_condition_false" }, nodeId, TelemetryLevel.INFO);

      return { nodeId, nodeTrace, skipped: true };
    }

    // Handle different node types
    if (node.type === "input") {
      nodeTrace.output = nodeOutputs[nodeId] ?? {};
    } else if (node.type === "output") {
      nodeTrace.input = gatherInputs(nodeId, dag, nodeOutputs);
      nodeTrace.output = nodeTrace.input;
    } else if (node.type === "prompt") {
      await executePromptNodeAsync(
        nodeId,
        project,
        dag,
        nodeOutputs,
        nodeTrace,
        registry,
        dryRun
      );
    } else if (node.type === "tool") {
      await executeToolNodeAsync(
        nodeId,
        project,
        dag,
        nodeOutputs,
        nodeTrace,
        toolRunner
      );
    } else if (node.type === "agent") {
      const sessionToResume = resumeSessions?.[nodeId];
      await executeAgentNodeAsync(
        nodeId,
        project,
        dag,
        nodeOutputs,
        nodeTrace,
        dryRun,
        sessionToResume,
        effectiveRunId
      );
    } else if (node.type === "branch") {
      await executeBranchNodeAsync(
        nodeId,
        project,
        dag,
        nodeOutputs,
        nodeTrace,
        dryRun,
        verbose,
        artifactManager,
        checkpoint,
        checkpointDir
      );
    } else if (node.type === "map") {
      await executeMapNodeAsync(
        nodeId,
        project,
        dag,
        nodeOutputs,
        nodeTrace,
        dryRun,
        verbose,
        artifactManager,
        checkpoint
      );
    } else if (node.type === "trigger") {
      await executeTriggerNodeAsync(
        nodeId,
        project,
        dag,
        nodeOutputs,
        nodeTrace,
        dryRun,
        verbose,
        artifactManager
      );
    }

    nodeTrace.endTime = nowIso();

    // Update state: node completed
    if (state && artifactManager) {
      setNodeCompleted(
        state,
        nodeId,
        nodeTrace.output,
        nodeTrace.sessionId,
        nodeTrace.costUsd,
        nodeTrace.numTurns
      );
      saveState(state, getStatePath(artifactManager.runDir));
    }

    emit(
      EventType.NODE_COMPLETED,
      effectiveRunId,
      {
        type: node.type,
        input_tokens: nodeTrace.tokens["input"] ?? 0,
        output_tokens: nodeTrace.tokens["output"] ?? 0,
      },
      nodeId,
      TelemetryLevel.INFO
    );

    return { nodeId, nodeTrace, output: nodeTrace.output, skipped: false };
  } catch (e) {
    nodeTrace.error = String(e);
    nodeTrace.errorType =
      e instanceof Error ? e.constructor.name : "Error";
    nodeTrace.endTime = nowIso();

    if (state && artifactManager) {
      setNodeErrored(state, nodeId, String(e));
      saveState(state, getStatePath(artifactManager.runDir));
    }

    emit(
      EventType.NODE_FAILED,
      effectiveRunId,
      { type: node.type, error: String(e), error_type: nodeTrace.errorType },
      nodeId,
      TelemetryLevel.ERROR
    );

    return {
      nodeId,
      nodeTrace,
      error: e instanceof Error ? e : new Error(String(e)),
      skipped: false,
    };
  }
}

// ─── Main Run Function ───────────────────────────────────────

/**
 * Execute a Harpoon project.
 *
 * Builds the DAG, validates structure, then executes nodes level by level
 * with parallel execution within each level.
 */
export async function run(
  project: Project,
  options: RunOptions = {}
): Promise<ExecutionResult> {
  const {
    dryRun = false,
    verbose = false,
    resumeSessions,
    resumeFrom,
    artifactDir,
    runId,
    startFrom,
    emitSignals = false,
    publishTo,
    telemetryConfig,
  } = options;
  let { entrypoint, inputs } = options;

  const registry = getRegistry();

  // Initialize telemetry
  let telemetryEmitter: TelemetryEmitter | undefined;
  if (telemetryConfig?.enabled) {
    telemetryEmitter = new TelemetryEmitter(telemetryConfig);
    setEmitter(telemetryEmitter);
  }

  // Build DAG
  const dag = buildDag(project);

  // Validate edge mappings in dry-run or verbose mode
  if (dryRun || verbose) {
    const validation = validateEdgeMappings(project, dag);
    if (validation.warnings.length > 0) {
      process.stderr.write("Warning: Edge mapping warnings:\n");
      for (const warning of validation.warnings) {
        process.stderr.write(`  - ${warning.message}\n`);
      }
      process.stderr.write("\n");
    }
  }

  // Validate start_from requires resume_from
  if (startFrom && !resumeFrom) {
    throw new HarpoonError(
      "--start-from requires --resume to specify which run to use cached outputs from"
    );
  }

  // Determine entrypoint
  if (!entrypoint) {
    if (project.entrypoints.length > 0) {
      entrypoint = project.entrypoints[0];
    } else {
      throw new HarpoonError(
        "No entrypoint specified and none defined in project"
      );
    }
  }

  // Handle checkpoint and resume
  let checkpoint: Checkpoint | undefined;
  let sessions = resumeSessions ?? {};

  if (resumeFrom) {
    let resumePath = resumeFrom;
    if (!existsSync(resumePath) && artifactDir) {
      resumePath = path.join(artifactDir, "runs", resumeFrom, "checkpoint.json");
    }
    if (!existsSync(resumePath)) {
      throw new HarpoonError(`Checkpoint not found: ${resumeFrom}`);
    }

    checkpoint = loadCheckpoint(resumePath);
    checkpoint.status = "running";
    checkpoint.updatedAt = nowIso();

    if (startFrom) {
      if (!dag.nodes[startFrom]) {
        throw new HarpoonError(
          `Start-from node not found in DAG: ${startFrom}`
        );
      }
      const ancestors = getAncestors(dag, startFrom);
      const filtered: Record<string, CheckpointNodeData> = {};
      for (const [nid, ndata] of Object.entries(checkpoint.completedNodes)) {
        if (ancestors.has(nid)) {
          filtered[nid] = ndata;
        }
      }
      checkpoint.completedNodes = filtered;
    }

    if (!inputs && checkpoint.inputs) {
      inputs = checkpoint.inputs;
    }

    if (Object.keys(sessions).length === 0) {
      for (const [nid, ndata] of Object.entries(checkpoint.completedNodes)) {
        if (ndata.sessionId) {
          sessions[nid] = ndata.sessionId;
        }
      }
    }
  }

  // Initialize execution state
  const effectiveRunId = runId ?? checkpoint?.runId ?? randomUUID();
  const trace: ExecutionTrace = {
    runId: effectiveRunId,
    startTime: nowIso(),
    nodes: [],
  };

  // Emit workflow started event
  if (telemetryEmitter) {
    telemetryEmitter.emit(
      EventType.WORKFLOW_STARTED,
      effectiveRunId,
      { name: project.name, entrypoint, dry_run: dryRun },
      undefined,
      TelemetryLevel.INFO
    );
  }

  const nodeOutputs: Record<string, Record<string, unknown>> = {};
  const toolRunner = new TypeScriptToolRunner(project.root);
  let executionError: NodeExecutionError | undefined;

  // Initialize artifact manager
  let artifactManager: ArtifactManager | undefined;
  let state: WorkflowStateData | undefined;

  if (artifactDir) {
    artifactManager = getArtifactManager(
      project.root,
      effectiveRunId,
      artifactDir,
      emitSignals,
      project.orchestration
    );
    artifactManager.registerRun(project.name, entrypoint ?? null);

    const metadata: RunMetadata = {
      runId: effectiveRunId,
      projectName: project.name,
      projectRoot: project.root,
      entrypoint: entrypoint ?? null,
      inputs: inputs ?? {},
      startedAt: nowIso(),
      harpoonVersion: "1.1.0",
    };
    await artifactManager.saveMetadata(metadata);

    if (emitSignals) {
      await artifactManager.clearSignals(project.name);
      await artifactManager.emitSignal("started", project.name);
    }

    state = createWorkflowState(
      effectiveRunId,
      project.name,
      Object.keys(dag.nodes),
      entrypoint,
      inputs
    );
    saveState(state, getStatePath(artifactManager.runDir));
  }

  // Seed input nodes
  if (inputs) {
    for (const nodeId of Object.keys(project.inputNodes)) {
      nodeOutputs[nodeId] = { ...inputs };
    }
  }

  // Restore outputs from checkpoint
  if (checkpoint) {
    for (const [nodeId, nodeData] of Object.entries(
      checkpoint.completedNodes
    )) {
      nodeOutputs[nodeId] = nodeData.outputs;
    }
  }

  // Execute nodes level by level
  for (const level of dag.executionLevels) {
    if (executionError) break;

    const nodesToSkip: string[] = [];
    const nodesToExecute: string[] = [];

    for (const nodeId of level) {
      if (checkpoint && nodeId in checkpoint.completedNodes) {
        nodesToSkip.push(nodeId);
      } else {
        nodesToExecute.push(nodeId);
      }
    }

    // Handle skipped nodes (from checkpoint)
    for (const nodeId of nodesToSkip) {
      const nodeData = checkpoint!.completedNodes[nodeId];
      const nodeTrace = createNodeTrace(nodeId);
      nodeTrace.output = nodeData.outputs;
      nodeTrace.sessionId = nodeData.sessionId;
      nodeTrace.costUsd = nodeData.costUsd;
      nodeTrace.numTurns = nodeData.numTurns;
      nodeTrace.endTime = nodeData.completedAt;
      trace.nodes.push(nodeTrace);
      if (verbose) {
        process.stdout.write(`Skipping completed node: ${nodeId}\n`);
      }
    }

    if (nodesToExecute.length === 0) continue;

    if (verbose && nodesToExecute.length > 1) {
      process.stdout.write(
        `Executing ${nodesToExecute.length} nodes in parallel: ${JSON.stringify(nodesToExecute)}\n`
      );
    }

    // Execute all nodes in this level in parallel
    const results = await Promise.all(
      nodesToExecute.map((nodeId) =>
        executeNodeAsync(
          nodeId,
          project,
          dag,
          nodeOutputs,
          registry,
          toolRunner,
          dryRun,
          verbose,
          sessions,
          artifactManager,
          checkpoint,
          effectiveRunId,
          state
        )
      )
    );

    // Process results
    for (const result of results) {
      trace.nodes.push(result.nodeTrace);

      if (result.error) {
        if (!executionError) {
          const node = dag.nodes[result.nodeId];
          executionError = new NodeExecutionError(
            result.nodeId,
            node.type,
            String(result.error),
            result.error,
            result.nodeTrace.input
          );
          trace.error = String(executionError);
        }
      } else if (!result.skipped && result.output) {
        nodeOutputs[result.nodeId] = result.output;

        // Save checkpoint after successful node
        if (checkpoint) {
          checkpoint.completedNodes[result.nodeId] = {
            outputs: result.nodeTrace.output,
            completedAt: result.nodeTrace.endTime ?? nowIso(),
            sessionId: result.nodeTrace.sessionId,
            costUsd: result.nodeTrace.costUsd,
            numTurns: result.nodeTrace.numTurns,
          };
          const idx = checkpoint.pendingNodes.indexOf(result.nodeId);
          if (idx >= 0) checkpoint.pendingNodes.splice(idx, 1);
          if (result.nodeTrace.costUsd) {
            checkpoint.totalCostUsd += result.nodeTrace.costUsd;
          }
          checkpoint.updatedAt = nowIso();

          if (artifactManager) {
            await artifactManager.saveCheckpoint(checkpoint as unknown as Record<string, unknown>);
          }

          emit(
            EventType.CHECKPOINT_SAVED,
            effectiveRunId,
            {
              completed_nodes: Object.keys(checkpoint.completedNodes).length,
              pending_nodes: checkpoint.pendingNodes.length,
              total_cost_usd: checkpoint.totalCostUsd,
            },
            undefined,
            TelemetryLevel.INFO
          );
        }
      }
    }
  }

  // Collect final outputs
  const finalOutputs: Record<string, unknown> = {};
  for (const outNodeId of Object.keys(project.outputNodes)) {
    if (nodeOutputs[outNodeId]) {
      finalOutputs[outNodeId] = nodeOutputs[outNodeId];
    }
  }

  // Fallback: use last successful node's output
  if (
    Object.keys(finalOutputs).length === 0 &&
    dag.executionOrder.length > 0
  ) {
    for (let i = dag.executionOrder.length - 1; i >= 0; i--) {
      const outNodeId = dag.executionOrder[i];
      if (nodeOutputs[outNodeId]) {
        Object.assign(finalOutputs, nodeOutputs[outNodeId]);
        break;
      }
    }
  }

  trace.endTime = nowIso();

  // Emit workflow completion/failure event
  if (telemetryEmitter) {
    if (executionError) {
      telemetryEmitter.emit(
        EventType.WORKFLOW_FAILED,
        effectiveRunId,
        { name: project.name, error: String(executionError) },
        undefined,
        TelemetryLevel.ERROR
      );
    } else {
      telemetryEmitter.emit(
        EventType.WORKFLOW_COMPLETED,
        effectiveRunId,
        { name: project.name },
        undefined,
        TelemetryLevel.INFO
      );
    }
  }

  // Final checkpoint update
  if (checkpoint) {
    checkpoint.status = executionError ? "failed" : "completed";
    checkpoint.updatedAt = nowIso();
  }

  // Final state update
  if (state && artifactManager) {
    if (executionError) {
      updateWorkflowStatus(state, WorkflowStatus.FAILED);
    } else {
      updateWorkflowStatus(state, WorkflowStatus.COMPLETED);
    }
    saveState(state, getStatePath(artifactManager.runDir));
  }

  // Save artifacts
  if (artifactManager) {
    if (checkpoint) {
      await artifactManager.saveCheckpoint(checkpoint as unknown as Record<string, unknown>);
    }

    await artifactManager.saveTrace(trace as unknown as Record<string, unknown>);
    await artifactManager.saveOutputs(finalOutputs, project.name, publishTo);

    artifactManager.updateRunStatus(
      executionError ? "failed" : "completed",
      !executionError,
      executionError ? String(executionError) : undefined
    );

    // Emit signals
    if (emitSignals) {
      if (executionError) {
        await artifactManager.emitSignal("failed", project.name, undefined, {
          error: String(executionError),
        });
      } else {
        await artifactManager.emitSignal(
          "completed",
          project.name,
          artifactManager.outputsPath
        );
        await artifactManager.emitSignal(
          "ready",
          project.name,
          artifactManager.outputsPath
        );
      }
    }

    if (verbose) {
      process.stdout.write(`Artifacts saved to: ${artifactManager.runDir}\n`);
    }
  }

  const success = !executionError && trace.nodes.every(
    (n) => !n.error || n.skipped
  );

  // Close telemetry
  if (telemetryEmitter) {
    telemetryEmitter.close();
    setEmitter(undefined);
  }

  return {
    outputs: finalOutputs,
    trace,
    error: executionError,
    success,
  };
}
