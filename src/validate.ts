/**
 * Whole-project validation.
 *
 * validateProject() is the one validator behind `harpoon project validate`
 * and run(). It collects every structural and contract problem as a
 * diagnostic instead of throwing, recurses into branch and map
 * sub-workflows, and returns { valid, errors, warnings }.
 */

import * as nodePath from "node:path";
import { existsSync } from "node:fs";

import { DAGError } from "./errors.js";
import { buildDag, checkEdgeContracts } from "./dag.js";
import type {
  DAG,
  ValidationDiagnostic,
  ValidationDiagnostics,
} from "./dag.js";
import { parsePromptFile } from "./parser.js";
import type { AgentNode } from "./parser.js";
import { loadProject, NODE_TYPES } from "./project.js";
import type { Project } from "./project.js";

// ─── Data Interfaces ─────────────────────────────────────────

/** Options for validateProject(). */
export interface ValidateProjectOptions {
  /** Treat warnings as failures: valid is false when any warning exists. */
  strict?: boolean;
  /** An entrypoint requested for a run (run()'s `entrypoint` option). */
  entrypoint?: string;
}

/** Result of validateProject(). */
export interface ProjectValidationResult {
  /** No errors, and no warnings either when `strict` is set. */
  valid: boolean;
  errors: ValidationDiagnostic[];
  warnings: ValidationDiagnostic[];
  /** The execution DAG, when the project's structure allowed building it. */
  dag?: DAG;
}

interface CollectedDiagnostics extends ValidationDiagnostics {
  dag?: DAG;
}

// ─── Public API ──────────────────────────────────────────────

/**
 * Validate a loaded project's structure, edge contracts and sub-workflows.
 *
 * Never throws for a validation problem.
 *
 * Errors:
 * - a manifest node whose type is not a known node type;
 * - an agent whose prompt file is missing or does not parse;
 * - an edge to or from a node that does not exist;
 * - a cycle;
 * - a declared entrypoint, or `options.entrypoint`, that is not a node;
 * - an edge contract error (see checkEdgeContracts() in src/dag.ts);
 * - a branch or map sub-workflow that is missing, circular or invalid.
 * Warnings:
 * - a weakly connected group of nodes with no input node and no entrypoint;
 * - a declared field type the validator does not check.
 */
export async function validateProject(
  project: Project,
  options: ValidateProjectOptions = {}
): Promise<ProjectValidationResult> {
  const { errors, warnings, dag } = await collectProjectDiagnostics(
    project,
    options.entrypoint,
    new Set()
  );
  const valid =
    errors.length === 0 && !(options.strict && warnings.length > 0);
  return { valid, errors, warnings, dag };
}

/** Format diagnostics as an indented list, one per line. */
export function formatDiagnostics(
  diagnostics: ValidationDiagnostic[],
  bullet = "-"
): string {
  return diagnostics.map((d) => `  ${bullet} ${d.message}`).join("\n");
}

// ─── Project Checks ──────────────────────────────────────────

/**
 * Node ID -> node type for every node buildDag() would create, in the same
 * order, so a later kind replaces an earlier one with the same ID.
 */
function declaredNodeTypes(project: Project): Map<string, string> {
  const types = new Map<string, string>();
  const groups: [string, Record<string, unknown>][] = [
    ["input", project.inputNodes],
    ["prompt", project.prompts],
    ["output", project.outputNodes],
    ["tool", project.tools],
    ["agent", project.agents],
    ["branch", project.branches],
    ["map", project.maps],
    ["trigger", project.triggers],
  ];
  for (const [type, nodes] of groups) {
    for (const nodeId of Object.keys(nodes)) types.set(nodeId, type);
  }
  return types;
}

/** Why an agent's prompt is unusable, or null when it is fine. */
function agentPromptProblem(project: Project, agent: AgentNode): string | null {
  if (agent.promptNode) return null;
  const fullPath = nodePath.join(project.root, agent.promptPath);
  if (!existsSync(fullPath)) {
    return `prompt file not found: ${agent.promptPath}`;
  }
  try {
    parsePromptFile(fullPath);
    return null;
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    return `cannot parse prompt file ${agent.promptPath}: ${reason}`;
  }
}

/**
 * Warn about each weakly connected component (edges taken as undirected)
 * that holds no input node and no entrypoint: nothing a run supplies reaches
 * it. Fan-in, fan-out and several input nodes are all fine.
 */
function componentWarnings(
  project: Project,
  nodeTypes: Map<string, string>,
  entrypoint: string | undefined
): ValidationDiagnostic[] {
  const parent = new Map<string, string>();
  for (const nodeId of nodeTypes.keys()) parent.set(nodeId, nodeId);
  const find = (id: string): string => {
    let root = id;
    while (parent.get(root) !== root) root = parent.get(root)!;
    parent.set(id, root);
    return root;
  };
  for (const edge of Object.values(project.edges)) {
    if (!nodeTypes.has(edge.fromNode) || !nodeTypes.has(edge.toNode)) continue;
    parent.set(find(edge.fromNode), find(edge.toNode));
  }

  const components = new Map<string, string[]>();
  for (const nodeId of nodeTypes.keys()) {
    const root = find(nodeId);
    if (!components.has(root)) components.set(root, []);
    components.get(root)!.push(nodeId);
  }

  const starts = new Set(project.entrypoints);
  if (entrypoint) starts.add(entrypoint);

  const warnings: ValidationDiagnostic[] = [];
  for (const members of components.values()) {
    const reachable = members.some(
      (id) => nodeTypes.get(id) === "input" || starts.has(id)
    );
    if (reachable) continue;
    members.sort();
    warnings.push({
      message:
        `Nodes ${JSON.stringify(members)} are not connected to any input ` +
        `node or entrypoint, so no run input reaches them`,
      nodeId: members[0],
    });
  }
  return warnings;
}

async function collectProjectDiagnostics(
  project: Project,
  entrypoint: string | undefined,
  visited: Set<string>,
  selfKey: string = project.root
): Promise<CollectedDiagnostics> {
  const errors: ValidationDiagnostic[] = [];
  const warnings: ValidationDiagnostic[] = [];
  const nodeTypes = declaredNodeTypes(project);
  const unknownTypes = project.unknownTypeNodes ?? {};

  // Nodes loadProject() could not classify.
  for (const [nodeId, type] of Object.entries(unknownTypes)) {
    errors.push({
      message:
        `Node '${nodeId}' has unknown type '${type}'. ` +
        `Valid types: ${NODE_TYPES.join(", ")}`,
      nodeId,
    });
  }

  // Agent prompts.
  for (const [nodeId, agent] of Object.entries(project.agents)) {
    const problem = agentPromptProblem(project, agent);
    if (problem) {
      errors.push({ message: `Agent '${nodeId}': ${problem}`, nodeId });
    }
  }

  // Edges must connect existing nodes.
  let dangling = false;
  for (const edge of Object.values(project.edges)) {
    for (const [end, nodeId] of [
      ["source", edge.fromNode],
      ["target", edge.toNode],
    ] as const) {
      if (nodeTypes.has(nodeId)) continue;
      dangling = true;
      const why =
        nodeId in unknownTypes
          ? ` (its type '${unknownTypes[nodeId]}' is not a known node type)`
          : "";
      errors.push({
        message: `Edge '${edge.id}' references unknown ${end} node '${nodeId}'${why}`,
        edgeId: edge.id,
        nodeId,
      });
    }
  }

  // Entrypoints must be nodes.
  const knownNodes = JSON.stringify([...nodeTypes.keys()].sort());
  for (const ep of project.entrypoints) {
    if (!nodeTypes.has(ep)) {
      errors.push({
        message: `Entrypoint '${ep}' is not a node in this project. Nodes: ${knownNodes}`,
        nodeId: ep,
      });
    }
  }
  if (
    entrypoint !== undefined &&
    !nodeTypes.has(entrypoint) &&
    !project.entrypoints.includes(entrypoint)
  ) {
    errors.push({
      message:
        `Requested entrypoint '${entrypoint}' is not a node in this project. ` +
        `Nodes: ${knownNodes}`,
      nodeId: entrypoint,
    });
  }

  // DAG: cycles. Building needs every edge endpoint to exist.
  let dag: DAG | undefined;
  if (!dangling) {
    try {
      dag = buildDag(project);
    } catch (e) {
      if (!(e instanceof DAGError)) throw e;
      errors.push({ message: e.message });
    }
  }

  // Edge contracts need the DAG's node types.
  if (dag) {
    const contracts = checkEdgeContracts(project, dag);
    errors.push(...contracts.errors);
    warnings.push(...contracts.warnings);
  }

  warnings.push(...componentWarnings(project, nodeTypes, entrypoint));

  const sub = await collectSubworkflowDiagnostics(project, visited, selfKey);
  errors.push(...sub.errors);
  warnings.push(...sub.warnings);

  return { errors, warnings, dag };
}

// ─── Sub-workflows ───────────────────────────────────────────

function prefixed(
  prefix: string,
  diagnostics: ValidationDiagnostic[]
): ValidationDiagnostic[] {
  return diagnostics.map((d) => ({ ...d, message: `${prefix}: ${d.message}` }));
}

/**
 * Validate every branch and map sub-workflow of a project, recursively.
 *
 * `visited` holds the workflows on the current path (project roots, or the
 * resolved workflow path a branch or map named), to catch circular
 * references. `selfKey` is this project's own entry; it defaults to its root.
 */
export async function collectSubworkflowDiagnostics(
  project: Project,
  visited: Set<string>,
  selfKey: string = project.root
): Promise<ValidationDiagnostics> {
  const errors: ValidationDiagnostic[] = [];
  const warnings: ValidationDiagnostic[] = [];

  if (visited.has(selfKey)) {
    errors.push({ message: `Circular workflow reference detected: ${selfKey}` });
    return { errors, warnings };
  }
  visited.add(selfKey);

  const refs: { kind: string; id: string; workflowPath: string }[] = [
    ...Object.entries(project.branches)
      .filter(([, b]) => b.workflowPath !== "self")
      .map(([id, b]) => ({ kind: "Branch", id, workflowPath: b.workflowPath })),
    ...Object.entries(project.maps).map(([id, m]) => ({
      kind: "Map",
      id,
      workflowPath: m.workflowPath,
    })),
  ];

  for (const { kind, id, workflowPath } of refs) {
    const resolved = nodePath.resolve(project.root, workflowPath);
    const label = `${kind} '${id}'`;

    if (!existsSync(resolved)) {
      errors.push({
        message: `${label}: workflow file not found: ${workflowPath}`,
        nodeId: id,
      });
      continue;
    }
    if (visited.has(resolved)) {
      errors.push({
        message: `${label}: circular workflow reference to ${workflowPath}`,
        nodeId: id,
      });
      continue;
    }

    let subProject: Project;
    try {
      subProject = loadProject(resolved);
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      errors.push({
        message: `${label}: failed to load workflow ${workflowPath}: ${reason}`,
        nodeId: id,
      });
      continue;
    }

    const sub = await collectProjectDiagnostics(
      subProject,
      undefined,
      new Set(visited),
      resolved
    );
    const prefix = `${label} (${workflowPath})`;
    errors.push(...prefixed(prefix, sub.errors));
    warnings.push(...prefixed(prefix, sub.warnings));
  }

  return { errors, warnings };
}
