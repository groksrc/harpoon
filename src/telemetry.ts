/**
 * Telemetry system for real-time workflow observability.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

/** Types of telemetry events. */
export enum EventType {
  // Lifecycle events
  WORKFLOW_STARTED = 'workflow_started',
  WORKFLOW_COMPLETED = 'workflow_completed',
  WORKFLOW_FAILED = 'workflow_failed',

  // Node events
  NODE_STARTED = 'node_started',
  NODE_COMPLETED = 'node_completed',
  NODE_FAILED = 'node_failed',
  NODE_SKIPPED = 'node_skipped',

  // Execution events
  INPUT_RECEIVED = 'input_received',
  OUTPUT_PRODUCED = 'output_produced',
  CONDITION_EVALUATED = 'condition_evaluated',

  // Resource events
  TOKEN_USAGE = 'token_usage',
  COST_INCURRED = 'cost_incurred',
  TIMING_METRIC = 'timing_metric',

  // State events
  CHECKPOINT_SAVED = 'checkpoint_saved',
  SIGNAL_EMITTED = 'signal_emitted',
  BRANCH_ITERATION = 'branch_iteration',

  // Agent events
  AGENT_TURN_STARTED = 'agent_turn_started',
  AGENT_TURN_COMPLETED = 'agent_turn_completed',
  AGENT_TOOL_CALLED = 'agent_tool_called',
  AGENT_TOOL_RESULT = 'agent_tool_result',
  AGENT_MESSAGE = 'agent_message',
}

/** Severity levels for telemetry events. */
export enum TelemetryLevel {
  DEBUG = 'DEBUG',
  INFO = 'INFO',
  WARNING = 'WARNING',
  ERROR = 'ERROR',
}

/** A single telemetry event. */
export interface TelemetryEvent {
  eventType: EventType;
  runId: string;
  level: TelemetryLevel;
  data: Record<string, unknown>;
  nodeId?: string;
  timestamp: string;
}

/** Convert a TelemetryEvent to a JSON-serializable dict. */
function eventToDict(event: TelemetryEvent): Record<string, unknown> {
  const result: Record<string, unknown> = {
    timestamp: event.timestamp,
    run_id: event.runId,
    event: event.eventType,
    level: event.level,
    data: event.data,
  };
  if (event.nodeId !== undefined) {
    result.node_id = event.nodeId;
  }
  return result;
}

/** Configuration for telemetry system. */
export interface TelemetryConfig {
  enabled: boolean;
  format: 'jsonl' | 'human';
  filePath?: string;
  stdout: boolean;
  level: TelemetryLevel;
  filterEvents?: EventType[];
}

/** Create a default TelemetryConfig. */
export function defaultTelemetryConfig(): TelemetryConfig {
  return {
    enabled: false,
    format: 'jsonl',
    stdout: true,
    level: TelemetryLevel.INFO,
  };
}

/**
 * Central telemetry emission system.
 *
 * Manages formatting and writing of telemetry events to configured destinations.
 */
export class TelemetryEmitter {
  readonly config: TelemetryConfig;
  private outputStream: NodeJS.WritableStream | undefined;
  private fileHandle: fs.WriteStream | undefined;

  constructor(
    config: TelemetryConfig,
    outputStream?: NodeJS.WritableStream,
  ) {
    this.config = config;
    this.outputStream = outputStream;

    // Open file if configured
    if (config.enabled && config.filePath) {
      const dir = path.dirname(config.filePath);
      fs.mkdirSync(dir, { recursive: true });
      this.fileHandle = fs.createWriteStream(config.filePath, { flags: 'a' });
    }
  }

  /** Emit a telemetry event. */
  emit(
    eventType: EventType,
    runId: string,
    data?: Record<string, unknown>,
    nodeId?: string,
    level?: TelemetryLevel,
  ): void {
    if (!this.config.enabled) return;

    // Check event filter
    if (
      this.config.filterEvents &&
      !this.config.filterEvents.includes(eventType)
    ) {
      return;
    }

    const event: TelemetryEvent = {
      eventType,
      runId,
      level: level ?? this.config.level,
      data: data ?? {},
      nodeId,
      timestamp: new Date().toISOString(),
    };

    this.writeEvent(event);
  }

  private writeEvent(event: TelemetryEvent): void {
    const outputLine =
      this.config.format === 'jsonl'
        ? this.formatJsonl(event)
        : this.formatHuman(event);

    // Write to stdout if configured
    if (this.config.stdout && this.outputStream === undefined) {
      process.stdout.write(outputLine + '\n');
    } else if (this.outputStream !== undefined) {
      this.outputStream.write(outputLine + '\n');
    }

    // Write to file if configured
    if (this.fileHandle) {
      this.fileHandle.write(outputLine + '\n');
    }
  }

  private formatJsonl(event: TelemetryEvent): string {
    return JSON.stringify(eventToDict(event));
  }

  private formatHuman(event: TelemetryEvent): string {
    const timestamp = event.timestamp.slice(0, 23); // Truncate microseconds
    const level = event.level;
    const eventName = event.eventType.toUpperCase();

    const parts: string[] = [`run=${event.runId}`];
    if (event.nodeId) {
      parts.push(`node=${event.nodeId}`);
    }

    // Add important data fields
    for (const [key, value] of Object.entries(event.data)) {
      if (
        typeof value === 'string' ||
        typeof value === 'number' ||
        typeof value === 'boolean'
      ) {
        parts.push(`${key}=${value}`);
      }
    }

    const partsStr = parts.join(' ');
    return `[${timestamp}] [${level}] ${eventName} ${partsStr}`;
  }

  /** Close file handles and flush buffers. */
  close(): void {
    if (this.fileHandle) {
      this.fileHandle.end();
      this.fileHandle = undefined;
    }
  }
}

// Global emitter instance (initialized by executor)
let _globalEmitter: TelemetryEmitter | undefined;

/** Get the global telemetry emitter. */
export function getEmitter(): TelemetryEmitter | undefined {
  return _globalEmitter;
}

/** Set the global telemetry emitter. */
export function setEmitter(emitter: TelemetryEmitter | undefined): void {
  _globalEmitter = emitter;
}

/** Emit a telemetry event using the global emitter. */
export function emit(
  eventType: EventType,
  runId: string,
  data?: Record<string, unknown>,
  nodeId?: string,
  level?: TelemetryLevel,
): void {
  const emitter = getEmitter();
  if (emitter) {
    emitter.emit(eventType, runId, data, nodeId, level);
  }
}
