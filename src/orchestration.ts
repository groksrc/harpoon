/**
 * Workflow orchestration utilities.
 *
 * Provides functionality for coordinating multiple workflow runs:
 * - Signal waiting (wait for other workflows to complete)
 * - Signal file resolution
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { Signal } from './artifacts.js';
import { loadSignal } from './artifacts.js';

/** Configuration for signal waiting. */
export interface WaitConfig {
  signals: string[];
  timeoutSeconds: number;
  pollInterval: number;
}

/** Raised when waiting for signals times out. */
export class SignalTimeoutError extends Error {
  readonly missingSignals: string[];
  readonly timeout: number;

  constructor(missingSignals: string[], timeout: number) {
    super(
      `Timed out after ${timeout}s waiting for signals: ${missingSignals.join(', ')}`,
    );
    this.name = 'SignalTimeoutError';
    this.missingSignals = missingSignals;
    this.timeout = timeout;
  }
}

/**
 * Resolve a signal specification to a file path.
 *
 * Supports:
 * - signal:<workflow>.<type> - Look in .harpoon/signals/<workflow>.<type>
 * - Relative paths - Resolved against project root
 * - Absolute paths - Used as-is
 */
export function resolveSignalPath(signalSpec: string, projectRoot: string): string {
  if (signalSpec.startsWith('signal:')) {
    const signalName = signalSpec.slice(7);
    return path.join(projectRoot, '.harpoon', 'signals', signalName);
  }
  if (path.isAbsolute(signalSpec)) {
    return signalSpec;
  }
  return path.join(projectRoot, signalSpec);
}

/**
 * Poll for all signals to be present.
 *
 * Blocks until all specified signal files exist, or timeout is reached.
 */
export async function waitForSignals(
  config: WaitConfig,
  verbose = false,
): Promise<Record<string, Signal>> {
  if (config.signals.length === 0) return {};

  const start = Date.now();
  const results: Record<string, Signal> = {};

  while (true) {
    const elapsed = (Date.now() - start) / 1000;
    if (elapsed > config.timeoutSeconds) {
      const missing = config.signals.filter((s) => !(s in results));
      throw new SignalTimeoutError(missing, config.timeoutSeconds);
    }

    for (const signalPath of config.signals) {
      if (signalPath in results) continue;
      try {
        await fs.access(signalPath);
        results[signalPath] = await loadSignal(signalPath);
        if (verbose) {
          process.stdout.write(`Signal found: ${signalPath}\n`);
        }
      } catch {
        // Signal file doesn't exist yet or couldn't be parsed
      }
    }

    if (Object.keys(results).length === config.signals.length) {
      return results;
    }

    if (verbose) {
      const remaining = config.signals.length - Object.keys(results).length;
      const elapsed = ((Date.now() - start) / 1000).toFixed(1);
      process.stdout.write(
        `Waiting for ${remaining} signal(s)... (${elapsed}s elapsed)\n`,
      );
    }

    await sleep(config.pollInterval * 1000);
  }
}

/**
 * Convenience function to wait for multiple signals.
 */
export async function waitForSignalFiles(
  signalPaths: Array<string>,
  projectRoot: string,
  timeout = 300,
  pollInterval = 5,
  verbose = false,
): Promise<Record<string, Signal>> {
  const resolvedPaths = signalPaths.map((spec) => resolveSignalPath(spec, projectRoot));

  const config: WaitConfig = {
    signals: resolvedPaths,
    timeoutSeconds: timeout,
    pollInterval,
  };
  return waitForSignals(config, verbose);
}

/**
 * Check if all signals are ready without blocking.
 *
 * Returns [allReady, missingSIgnals].
 */
export async function checkSignalsReady(
  signalPaths: string[],
  projectRoot: string,
): Promise<[boolean, string[]]> {
  const missing: string[] = [];
  for (const spec of signalPaths) {
    const resolvedPath = resolveSignalPath(spec, projectRoot);
    try {
      await fs.access(resolvedPath);
    } catch {
      missing.push(spec);
    }
  }
  return [missing.length === 0, missing];
}

/**
 * Get information from a signal file if it exists.
 */
export async function getSignalInfo(
  signalPath: string,
): Promise<Signal | undefined> {
  try {
    return await loadSignal(signalPath);
  } catch {
    return undefined;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
