/** Harpoon error types and exit codes. */

/** Exit codes per SPEC-1 Section 4.5.2. */
export enum ExitCode {
  SUCCESS = 0,
  RUNTIME_ERROR = 1,
  VALIDATION_ERROR = 2,
  PROVIDER_ERROR = 3,
  TIMEOUT = 4,
}

/** Base error for all Harpoon errors. */
export class HarpoonError extends Error {
  exitCode: ExitCode = ExitCode.RUNTIME_ERROR;

  constructor(message: string) {
    super(message);
    this.name = "HarpoonError";
  }
}

/** Error parsing project files. */
export class ParseError extends HarpoonError {
  override exitCode = ExitCode.VALIDATION_ERROR;

  constructor(message: string) {
    super(message);
    this.name = "ParseError";
  }
}

/** Runtime version incompatible with required version. */
export class VersionError extends HarpoonError {
  override exitCode = ExitCode.VALIDATION_ERROR;
  required: string;
  current: string;
  source: string;

  constructor(required: string, current: string, source: string = "manifest") {
    super(
      `${source} requires Harpoon ${required}, but running ${current}. ` +
        `Please upgrade: npm install --upgrade harpoon-cli`
    );
    this.name = "VersionError";
    this.required = required;
    this.current = current;
    this.source = source;
  }
}

/** Parse version string into array of ints for comparison. */
export function parseVersion(version: string): number[] {
  try {
    return version.split(".").map((p) => {
      const n = parseInt(p, 10);
      return isNaN(n) ? 0 : n;
    });
  } catch {
    return [0];
  }
}

/**
 * Check if current version satisfies required minimum version.
 *
 * @throws {VersionError} If current version is less than required version
 */
export function checkVersion(
  required: string,
  current: string,
  source: string
): void {
  const requiredParts = parseVersion(required);
  const currentParts = parseVersion(current);

  const maxLen = Math.max(requiredParts.length, currentParts.length);
  const reqPadded = [
    ...requiredParts,
    ...Array(maxLen - requiredParts.length).fill(0),
  ];
  const curPadded = [
    ...currentParts,
    ...Array(maxLen - currentParts.length).fill(0),
  ];

  for (let i = 0; i < maxLen; i++) {
    if (curPadded[i] < reqPadded[i]) {
      throw new VersionError(required, current, source);
    }
    if (curPadded[i] > reqPadded[i]) {
      return;
    }
  }
}

/** Error validating project structure or data. */
export class ValidationError extends HarpoonError {
  override exitCode = ExitCode.VALIDATION_ERROR;

  constructor(message: string) {
    super(message);
    this.name = "ValidationError";
  }
}

/** Error in DAG structure (cycles, missing nodes). */
export class DAGError extends ValidationError {
  constructor(message: string) {
    super(message);
    this.name = "DAGError";
  }
}

/** Error from model provider. */
export class ProviderError extends HarpoonError {
  override exitCode = ExitCode.PROVIDER_ERROR;
  retryable: boolean;

  constructor(message: string, retryable: boolean = false) {
    super(message);
    this.name = "ProviderError";
    this.retryable = retryable;
  }
}

/** Output doesn't match declared schema. */
export class SchemaValidationError extends HarpoonError {
  override exitCode = ExitCode.RUNTIME_ERROR;

  constructor(message: string) {
    super(message);
    this.name = "SchemaValidationError";
  }
}

/** Error evaluating edge condition. */
export class ConditionError extends HarpoonError {
  override exitCode = ExitCode.RUNTIME_ERROR;

  constructor(message: string) {
    super(message);
    this.name = "ConditionError";
  }
}

/** Error executing a tool. */
export class ToolError extends HarpoonError {
  override exitCode = ExitCode.RUNTIME_ERROR;

  constructor(message: string) {
    super(message);
    this.name = "ToolError";
  }
}

function truncate(value: unknown, maxLen: number = 100): unknown {
  if (typeof value === "string" && value.length > maxLen) {
    return value.slice(0, maxLen) + "...";
  }
  if (Array.isArray(value) && JSON.stringify(value).length > maxLen) {
    return `<Array with ${value.length} items>`;
  }
  if (
    typeof value === "object" &&
    value !== null &&
    JSON.stringify(value).length > maxLen
  ) {
    return `<Object with ${Object.keys(value).length} keys>`;
  }
  return value;
}

/** Error during node execution with full context. */
export class NodeExecutionError extends HarpoonError {
  override exitCode = ExitCode.RUNTIME_ERROR;
  nodeId: string;
  nodeType: string;
  cause: Error | undefined;
  inputs: Record<string, unknown>;
  causeType: string | undefined;

  constructor(
    nodeId: string,
    nodeType: string,
    message: string,
    cause?: Error,
    inputs?: Record<string, unknown>
  ) {
    super(message);
    this.name = "NodeExecutionError";
    this.nodeId = nodeId;
    this.nodeType = nodeType;
    this.cause = cause;
    this.inputs = inputs ?? {};
    this.causeType = cause?.constructor.name;

    if (cause instanceof HarpoonError) {
      this.exitCode = cause.exitCode;
    }
  }

  override toString(): string {
    const parts = [
      `Node '${this.nodeId}' (${this.nodeType}) failed: ${this.message}`,
    ];
    if (this.cause) {
      parts.push(`  Caused by ${this.causeType}: ${this.cause.message}`);
    }
    if (Object.keys(this.inputs).length > 0) {
      const summary: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(this.inputs)) {
        summary[k] = truncate(v);
      }
      parts.push(`  Inputs: ${JSON.stringify(summary)}`);
    }
    return parts.join("\n");
  }
}

/**
 * Error executing a branch node (sub-workflow call).
 *
 * Raised when a branch node fails due to sub-workflow execution failure,
 * max iterations exceeded, or condition evaluation error.
 */
export class BranchError extends HarpoonError {
  override exitCode = ExitCode.RUNTIME_ERROR;
  iteration: number;
  maxIterations: number;
  cause: Error | undefined;

  constructor(
    message: string,
    iteration: number = 0,
    maxIterations: number = 0,
    cause?: Error
  ) {
    super(message);
    this.name = "BranchError";
    this.iteration = iteration;
    this.maxIterations = maxIterations;
    this.cause = cause;
  }

  override toString(): string {
    const parts = [this.message];
    if (this.iteration > 0) {
      parts.push(`  Iteration: ${this.iteration}/${this.maxIterations}`);
    }
    if (this.cause) {
      parts.push(
        `  Caused by: ${this.cause.constructor.name}: ${this.cause.message}`
      );
    }
    return parts.join("\n");
  }
}

/**
 * Error executing a map node (parallel fan-out).
 *
 * Raised when a map node fails due to sub-workflow execution failure,
 * collection field missing or not a list, or item condition evaluation error.
 */
export class MapError extends HarpoonError {
  override exitCode = ExitCode.RUNTIME_ERROR;
  itemIndex: number;
  totalItems: number;
  cause: Error | undefined;

  constructor(
    message: string,
    itemIndex: number = -1,
    totalItems: number = 0,
    cause?: Error
  ) {
    super(message);
    this.name = "MapError";
    this.itemIndex = itemIndex;
    this.totalItems = totalItems;
    this.cause = cause;
  }

  override toString(): string {
    const parts = [this.message];
    if (this.itemIndex >= 0) {
      parts.push(`  Item: ${this.itemIndex}/${this.totalItems}`);
    }
    if (this.cause) {
      parts.push(
        `  Caused by: ${this.cause.constructor.name}: ${this.cause.message}`
      );
    }
    return parts.join("\n");
  }
}
