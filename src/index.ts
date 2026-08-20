/**
 * Harpoon - Lightweight agent orchestration runtime.
 *
 * Public API for library consumers.
 */

// Version
export { VERSION } from "./version.js";

// Project loading
export { loadProject, loadDotenv } from "./project.js";
export type {
  Project,
  Edge,
  EdgeMapping,
  InputNode,
  OutputNode,
  ToolDef,
  ToolOutputField,
  ModelDefaults,
} from "./project.js";

// DAG construction and validation
export {
  buildDag,
  validateEdgeMappings,
  validateSubworkflows,
  visualizeDag,
  visualizeDagMermaid,
  getNodeOutputFields,
  getNodeInputFields,
  typesCompatible,
} from "./dag.js";
export type {
  DAG,
  DAGNode,
  ValidationResult,
  ValidationWarning,
} from "./dag.js";

// Execution engine
export { run } from "./executor.js";
export type {
  ExecutionResult,
  ExecutionTrace,
  NodeTrace,
  Checkpoint,
  CheckpointNodeData,
  RunOptions,
} from "./executor.js";

// Artifacts
export {
  ArtifactManager,
  getArtifactManager,
  findLatestRun,
  resolveInputSource,
  loadRunManifest,
  saveRunManifest,
  orchestrationConfigFromDict,
} from "./artifacts.js";
export type {
  ArtifactConfig,
  RunEntry,
  RunManifest,
  RunMetadata,
  BranchIterationState,
  MapItemState,
  Signal,
  OrchestrationConfig,
} from "./artifacts.js";

// Errors
export {
  ExitCode,
  HarpoonError,
  ParseError,
  ValidationError,
  DAGError,
  ProviderError,
  SchemaValidationError,
  ConditionError,
  ToolError,
  NodeExecutionError,
  BranchError,
  MapError,
  VersionError,
  checkVersion,
  parseVersion,
} from "./errors.js";

// Parser types
export { parsePromptFile, parseYaml } from "./parser.js";
export type {
  PromptNode,
  InputField,
  OutputSchema,
  LoopConfig,
  NextCondition,
  PromptToolDef,
  AgentNode,
  BranchNode,
  MapNode,
  TriggerNode,
  MCPServerConfig,
} from "./parser.js";

// Provider types
export { ProviderRegistry, getRegistry, registerProvider } from "./providers/base.js";
export type {
  Provider,
  CompletionConfig,
  CompletionResult,
} from "./providers/base.js";

// Orchestration
export {
  waitForSignals,
  waitForSignalFiles,
  checkSignalsReady,
  resolveSignalPath,
  SignalTimeoutError,
} from "./orchestration.js";
export type { WaitConfig } from "./orchestration.js";

// Telemetry
export {
  EventType,
  TelemetryLevel,
  TelemetryEmitter,
  getEmitter,
  setEmitter,
  emit,
  defaultTelemetryConfig,
} from "./telemetry.js";
export type {
  TelemetryConfig,
  TelemetryEvent,
} from "./telemetry.js";
