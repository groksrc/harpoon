/**
 * TypeScript tool execution.
 *
 * Equivalent of Trident's Python tool runner, adapted for TypeScript/Node.js.
 * Loads tool modules via dynamic import() and calls exported functions.
 */

import * as path from 'node:path';
import { existsSync } from 'node:fs';
import { ToolError } from '../errors.js';

/** Tool definition (minimal interface matching what the project module provides). */
export interface ToolDef {
  id: string;
  type: string; // "typescript", "shell", "http"
  path?: string;
  module?: string;
  function?: string;
  description?: string;
}

/**
 * Get tool function parameter names via dynamic import and inspection.
 *
 * Returns the set of parameter names, or undefined if introspection fails.
 */
export async function getToolParameters(
  projectRoot: string,
  toolDef: ToolDef,
): Promise<Set<string> | undefined> {
  if (toolDef.type !== 'typescript') return undefined;

  const modulePath = toolDef.module ?? toolDef.path;
  if (!modulePath) return undefined;

  const fullPath = resolveToolPath(projectRoot, modulePath);
  if (!existsSync(fullPath)) return undefined;

  try {
    const mod = await import(fullPath);
    const functionName = toolDef.function ?? 'execute';
    const func = mod[functionName] ?? mod.default;
    if (typeof func !== 'function') return undefined;

    // Attempt to get parameter count; JS doesn't provide named params at runtime
    // without parsing source code. Return undefined to indicate unknown.
    return undefined;
  } catch {
    return undefined;
  }
}

/** Resolve a tool module path to a full filesystem path. */
function resolveToolPath(projectRoot: string, modulePath: string): string {
  // Ensure .ts or .js extension
  let normalized = modulePath;
  if (!normalized.endsWith('.ts') && !normalized.endsWith('.js')) {
    // Try .ts first, then .js
    const tsPath = path.join(projectRoot, 'tools', `${normalized}.ts`);
    if (existsSync(tsPath)) return tsPath;
    const jsPath = path.join(projectRoot, 'tools', `${normalized}.js`);
    if (existsSync(jsPath)) return jsPath;
    normalized = `${normalized}.js`;
  }

  // Support relative paths (e.g., ../shared/browser.ts)
  if (normalized.startsWith('../') || normalized.startsWith('/')) {
    return path.resolve(projectRoot, normalized);
  }

  // Default: look in project tools/ directory
  return path.join(projectRoot, 'tools', normalized);
}

/**
 * Executes TypeScript/JavaScript callable tools.
 *
 * Loads modules via dynamic import() and calls exported functions.
 * Supports both default exports and named exports.
 */
export class TypeScriptToolRunner {
  private projectRoot: string;
  private loadedModules: Map<string, Record<string, unknown>> = new Map();

  constructor(projectRoot: string) {
    this.projectRoot = projectRoot;
  }

  private async loadModule(modulePath: string): Promise<Record<string, unknown>> {
    const cached = this.loadedModules.get(modulePath);
    if (cached) return cached;

    const fullPath = resolveToolPath(this.projectRoot, modulePath);
    if (!existsSync(fullPath)) {
      throw new ToolError(`Tool module not found: ${fullPath}`);
    }

    try {
      // Use file:// URL for dynamic import compatibility
      const fileUrl = `file://${fullPath}`;
      const mod = (await import(fileUrl)) as Record<string, unknown>;
      this.loadedModules.set(modulePath, mod);
      return mod;
    } catch (err) {
      throw new ToolError(`Error loading tool module ${fullPath}: ${err}`);
    }
  }

  /**
   * Execute a TypeScript/JavaScript tool.
   *
   * @param toolDef - Tool definition from project
   * @param inputs - Input values from edge mappings
   * @returns Dictionary of output values
   */
  async execute(
    toolDef: ToolDef,
    inputs: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    if (toolDef.type !== 'typescript') {
      throw new ToolError(
        `TypeScriptToolRunner cannot execute tool type: ${toolDef.type}`,
      );
    }

    const modulePath = toolDef.module ?? toolDef.path;
    if (!modulePath) {
      throw new ToolError(`Tool ${toolDef.id} has no module or path specified`);
    }

    const functionName = toolDef.function ?? 'execute';

    try {
      const mod = await this.loadModule(modulePath);

      // Try named export first, then default export
      let func = mod[functionName];
      if (func === undefined && functionName === 'execute' && mod.default) {
        func = mod.default;
      }

      if (func === undefined) {
        throw new ToolError(
          `Function '${functionName}' not found in ${modulePath}`,
        );
      }
      if (typeof func !== 'function') {
        throw new ToolError(
          `'${functionName}' in ${modulePath} is not callable`,
        );
      }

      let result = await (func as (...args: unknown[]) => unknown)(inputs);

      // Ensure result is a record
      if (result === null || result === undefined || typeof result !== 'object' || Array.isArray(result)) {
        result = { output: result };
      }

      return result as Record<string, unknown>;
    } catch (err) {
      if (err instanceof ToolError) throw err;
      throw new ToolError(`Error executing tool ${toolDef.id}: ${err}`);
    }
  }
}
