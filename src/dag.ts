/**
 * DAG construction and validation.
 *
 * Builds a directed acyclic graph from a project's nodes and edges,
 * performs topological sorting, and validates edge mappings.
 */

import { DAGError } from "./errors.js";
import type { PromptNode } from "./parser.js";
import type { Edge, Project } from "./project.js";
import { getToolParameters } from "./tools/typescript.js";

// ─── Data Interfaces ─────────────────────────────────────────

/** A validation warning (non-fatal issue). */
export interface ValidationWarning {
  message: string;
  edgeId?: string;
  nodeId?: string;
}

/**
 * One validation finding, error or warning, with the node and edge it is
 * about. The message names them too, so it reads on its own.
 */
export type ValidationDiagnostic = ValidationWarning;

/** Result of DAG validation (legacy shape: errors are plain messages). */
export interface ValidationResult {
  valid: boolean;
  errors: string[];
  warnings: ValidationWarning[];
}

/** Errors and warnings from a validation pass that collects instead of throwing. */
export interface ValidationDiagnostics {
  errors: ValidationDiagnostic[];
  warnings: ValidationDiagnostic[];
}

/** Node in the execution DAG. */
export interface DAGNode {
  id: string;
  type: string; // "prompt", "input", "output", "tool", "agent", "branch", "map", "trigger"
  incomingEdges: Edge[];
  outgoingEdges: Edge[];
}

/** Directed Acyclic Graph for execution. */
export interface DAG {
  nodes: Record<string, DAGNode>;
  executionOrder: string[]; // Topologically sorted node IDs (flat)
  executionLevels: string[][]; // Nodes grouped by level (parallel within level)
}

// ─── Node Field/Type Helpers ─────────────────────────────────

function extractPromptId(promptPath: string): string {
  return promptPath.replace("prompts/", "").replace(".prompt", "");
}

function hasStructuredOutput(prompt: PromptNode): boolean {
  return (
    prompt.output.format === "json" &&
    Object.keys(prompt.output.fields).length > 0
  );
}

function getPromptForAgent(
  project: Project,
  nodeId: string
): PromptNode | undefined {
  const agent = project.agents[nodeId];
  if (!agent) return undefined;
  // loadProject() parses the agent's own prompt file into promptNode; prefer
  // it, because a prompt outside prompts/ has no entry in project.prompts.
  if (agent.promptNode) return agent.promptNode;
  const promptId = extractPromptId(agent.promptPath);
  return project.prompts[promptId];
}

function getPromptOutputFields(prompt: PromptNode | undefined): Set<string> {
  if (prompt && hasStructuredOutput(prompt)) {
    return new Set(["text", ...Object.keys(prompt.output.fields)]);
  }
  return new Set(["text"]);
}

function getPromptOutputTypes(
  prompt: PromptNode | undefined
): Record<string, string | null> {
  const types: Record<string, string | null> = { text: "string" };
  if (prompt && hasStructuredOutput(prompt)) {
    for (const [name, [ftype]] of Object.entries(prompt.output.fields)) {
      types[name] = ftype;
    }
  }
  return types;
}

// ─── Node Output/Input Field Accessors ───────────────────────

/** Get the fields a node outputs for edge mapping validation. */
export function getNodeOutputFields(
  project: Project,
  nodeId: string,
  nodeType: string
): Set<string> {
  if (nodeType === "input") {
    const node = project.inputNodes[nodeId];
    return node ? new Set(Object.keys(node.schema)) : new Set();
  }
  if (nodeType === "prompt") {
    return getPromptOutputFields(project.prompts[nodeId]);
  }
  if (nodeType === "agent") {
    return getPromptOutputFields(getPromptForAgent(project, nodeId));
  }
  if (nodeType === "tool") {
    const schema = project.tools[nodeId]?.outputSchema;
    return schema && Object.keys(schema).length > 0
      ? new Set(Object.keys(schema))
      : new Set(["output"]);
  }
  if (nodeType === "branch") {
    return new Set(["output", "text"]);
  }
  if (nodeType === "map") {
    return new Set(["items", "count"]);
  }
  if (nodeType === "trigger") {
    return new Set(["triggered", "status", "output"]);
  }
  return new Set(); // output nodes have no downstream
}

/** Get the fields a node expects as input. */
export function getNodeInputFields(
  project: Project,
  nodeId: string,
  nodeType: string
): Set<string> {
  if (nodeType === "prompt") {
    const prompt = project.prompts[nodeId];
    return prompt ? new Set(Object.keys(prompt.inputs)) : new Set();
  }
  if (nodeType === "agent") {
    const prompt = getPromptForAgent(project, nodeId);
    return prompt ? new Set(Object.keys(prompt.inputs)) : new Set();
  }
  if (nodeType === "tool") {
    const toolDef = project.tools[nodeId];
    if (toolDef) {
      // Note: getToolParameters is async but we provide a sync fallback
      // For validation purposes we return empty set
      return new Set();
    }
    return new Set();
  }
  return new Set(); // output, input, branch, map, trigger accept anything
}

/** Get the fields and their types that a node outputs. */
export function getNodeOutputTypes(
  project: Project,
  nodeId: string,
  nodeType: string
): Record<string, string | null> {
  if (nodeType === "input") {
    const node = project.inputNodes[nodeId];
    if (!node) return {};
    const types: Record<string, string | null> = {};
    for (const [name, spec] of Object.entries(node.schema)) {
      types[name] = spec[0];
    }
    return types;
  }
  if (nodeType === "prompt") {
    return getPromptOutputTypes(project.prompts[nodeId]);
  }
  if (nodeType === "agent") {
    return getPromptOutputTypes(getPromptForAgent(project, nodeId));
  }
  if (nodeType === "tool") {
    const schema = project.tools[nodeId]?.outputSchema;
    if (!schema || Object.keys(schema).length === 0) return { output: null };
    return Object.fromEntries(
      Object.entries(schema).map(([name, field]) => [name, field.type]),
    );
  }
  if (nodeType === "branch") {
    return { output: null, text: "string" };
  }
  if (nodeType === "map") {
    // count is items.length, always a whole number.
    return { items: "array", count: "integer" };
  }
  if (nodeType === "trigger") {
    return { triggered: "boolean", status: "string", output: null };
  }
  return {};
}

/** Get the fields and their expected types for a node's inputs. */
export function getNodeInputTypes(
  project: Project,
  nodeId: string,
  nodeType: string
): Record<string, string | null> {
  if (nodeType === "prompt") {
    const prompt = project.prompts[nodeId];
    if (!prompt) return {};
    const types: Record<string, string | null> = {};
    for (const [name, inp] of Object.entries(prompt.inputs)) {
      types[name] = inp.type;
    }
    return types;
  }
  if (nodeType === "agent") {
    const prompt = getPromptForAgent(project, nodeId);
    if (!prompt) return {};
    const types: Record<string, string | null> = {};
    for (const [name, inp] of Object.entries(prompt.inputs)) {
      types[name] = inp.type;
    }
    return types;
  }
  return {}; // output, input, branch, map, trigger accept any types
}

/** The value types the static validator understands. */
export const KNOWN_TYPES: ReadonlySet<string> = new Set([
  "string",
  "number",
  "integer",
  "boolean",
  "array",
  "object",
]);

/**
 * Pairs of different known types that may flow along an edge, as
 * "source:target". integer -> number widens. object/array -> string works
 * because the template renderer serializes them as JSON (src/template.ts).
 * number -> integer is not here: validateSchema() rejects a non-integer.
 */
const COMPATIBLE_TYPE_PAIRS: ReadonlySet<string> = new Set([
  "integer:number",
  "object:string",
  "array:string",
]);

/**
 * Check if source type is compatible with target type.
 *
 * null means undeclared or dynamic and is always compatible. A type outside
 * KNOWN_TYPES is not checked, so it is treated as compatible; the contract
 * checker warns about it separately.
 */
export function typesCompatible(
  sourceType: string | null,
  targetType: string | null
): boolean {
  if (sourceType === null || targetType === null) return true;
  if (sourceType === targetType) return true;
  if (!KNOWN_TYPES.has(sourceType) || !KNOWN_TYPES.has(targetType)) return true;
  return COMPATIBLE_TYPE_PAIRS.has(`${sourceType}:${targetType}`);
}

// ─── Edge Contract Validation ────────────────────────────────

/**
 * Whether a node's output field list is fixed, so a mapping that reads a
 * field outside it is an error. Prompt and agent nodes always have a fixed
 * list; input nodes only when they declare a schema; tools only with an
 * output schema. Branch, map and trigger outputs depend on a sub-workflow.
 */
function hasFixedOutputFields(
  project: Project,
  nodeId: string,
  nodeType: string
): boolean {
  if (nodeType === "prompt") return project.prompts[nodeId] !== undefined;
  if (nodeType === "agent") return getPromptForAgent(project, nodeId) !== undefined;
  if (nodeType === "input") {
    const node = project.inputNodes[nodeId];
    return node !== undefined && Object.keys(node.schema).length > 0;
  }
  if (nodeType === "tool") {
    const schema = project.tools[nodeId]?.outputSchema;
    return schema !== undefined && Object.keys(schema).length > 0;
  }
  return false;
}

/** The prompt that declares a prompt or agent node's inputs, if known. */
function getDeclaringPrompt(
  project: Project,
  nodeId: string,
  nodeType: string
): PromptNode | undefined {
  if (nodeType === "prompt") return project.prompts[nodeId];
  if (nodeType === "agent") return getPromptForAgent(project, nodeId);
  return undefined;
}

/**
 * Resolve the output field a mapping reads. Mirrors gatherInputs() in
 * src/executor.ts: "a.b" reads field "a"; when that misses, an "output."
 * prefix is dropped, so "output.a.b" also reads field "a".
 */
function resolveSourceField(sourceExpr: string, fields: Set<string>): string {
  const parts = sourceExpr.split(".");
  if (!fields.has(parts[0]) && parts[0] === "output" && parts.length > 1) {
    return parts[1];
  }
  return parts[0];
}

/**
 * Check every edge mapping against the declared contracts of the nodes it
 * connects, and every required prompt/agent input against the edges that
 * feed it. Never throws. Edges whose endpoints are not in the DAG are skipped
 * (the structural check reports them).
 *
 * Errors:
 * - a mapping reads a field the source does not output (fixed lists only);
 * - a mapping writes a field the prompt/agent target does not declare;
 * - both types are known and incompatible (see typesCompatible);
 * - a required prompt/agent input with no default has no mapping on any
 *   incoming edge (a conditional edge counts).
 * Warnings:
 * - a declared type outside KNOWN_TYPES, which is not checked.
 */
export function checkEdgeContracts(
  project: Project,
  dag: DAG
): ValidationDiagnostics {
  const result: ValidationDiagnostics = { errors: [], warnings: [] };

  for (const edge of Object.values(project.edges)) {
    const sourceNode = dag.nodes[edge.fromNode];
    const targetNode = dag.nodes[edge.toNode];
    if (!sourceNode || !targetNode) continue;

    const sourceFields = getNodeOutputFields(project, edge.fromNode, sourceNode.type);
    const sourceFixed = hasFixedOutputFields(project, edge.fromNode, sourceNode.type);
    const sourceTypes = getNodeOutputTypes(project, edge.fromNode, sourceNode.type);

    const targetPrompt = getDeclaringPrompt(project, edge.toNode, targetNode.type);
    const targetTypes = getNodeInputTypes(project, edge.toNode, targetNode.type);

    for (const mapping of edge.mappings) {
      const field = resolveSourceField(mapping.sourceExpr, sourceFields);

      if (sourceFixed && !sourceFields.has(field)) {
        result.errors.push({
          message:
            `Edge '${edge.id}': source field '${mapping.sourceExpr}' does not ` +
            `exist in '${edge.fromNode}' (${sourceNode.type}) output. ` +
            `Available fields: ${JSON.stringify([...sourceFields].sort())}`,
          edgeId: edge.id,
          nodeId: edge.fromNode,
        });
      }

      if (targetPrompt && !(mapping.targetVar in targetPrompt.inputs)) {
        result.errors.push({
          message:
            `Edge '${edge.id}': target field '${mapping.targetVar}' is not an ` +
            `input of '${edge.toNode}' (${targetNode.type}). ` +
            `Declared inputs: ${JSON.stringify(Object.keys(targetPrompt.inputs).sort())}`,
          edgeId: edge.id,
          nodeId: edge.toNode,
        });
      }

      const sourceType = sourceTypes[field] ?? null;
      const targetType = targetTypes[mapping.targetVar] ?? null;
      for (const [type, name, nodeId] of [
        [sourceType, field, edge.fromNode],
        [targetType, mapping.targetVar, edge.toNode],
      ] as const) {
        if (type !== null && !KNOWN_TYPES.has(type)) {
          result.warnings.push({
            message:
              `Edge '${edge.id}': type '${type}' of '${name}' in '${nodeId}' ` +
              `is not checked. Known types: ${[...KNOWN_TYPES].join(", ")}`,
            edgeId: edge.id,
            nodeId,
          });
        }
      }
      if (!typesCompatible(sourceType, targetType)) {
        result.errors.push({
          message:
            `Edge '${edge.id}': Type mismatch: '${field}' (${sourceType}) from ` +
            `'${edge.fromNode}' cannot feed '${mapping.targetVar}' ` +
            `(${targetType}) in '${edge.toNode}'`,
          edgeId: edge.id,
          nodeId: edge.fromNode,
        });
      }
    }
  }

  // Required inputs: every prompt/agent input that is required and has no
  // default must be written by a mapping on some incoming edge.
  for (const [nodeId, node] of Object.entries(dag.nodes)) {
    const prompt = getDeclaringPrompt(project, nodeId, node.type);
    if (!prompt) continue;
    const mapped = new Set(
      node.incomingEdges.flatMap((e) => e.mappings.map((m) => m.targetVar))
    );
    for (const [name, input] of Object.entries(prompt.inputs)) {
      if (!input.required || input.default !== undefined) continue;
      if (mapped.has(name)) continue;
      result.errors.push({
        message:
          `Node '${nodeId}' (${node.type}): required input '${name}' has no ` +
          `default and no incoming edge maps it`,
        nodeId,
      });
    }
  }

  return result;
}

/**
 * Validate edge mappings against node input/output contracts.
 *
 * Kept for the public API; validateProject() in src/validate.ts is the full
 * check. Contract errors (see checkEdgeContracts) make the result invalid.
 * In strict mode, warnings are added to the errors as well.
 */
export function validateEdgeMappings(
  project: Project,
  dag: DAG,
  strict = false
): ValidationResult {
  const { errors, warnings } = checkEdgeContracts(project, dag);
  const result: ValidationResult = {
    valid: errors.length === 0,
    errors: errors.map((e) => e.message),
    warnings,
  };

  if (strict && warnings.length > 0) {
    result.valid = false;
    result.errors.push(...warnings.map((w) => w.message));
  }

  return result;
}

// ─── Sub-workflow Validation ─────────────────────────────────

/**
 * Recursively validate all sub-workflows referenced by branch and map nodes.
 *
 * Kept for the public API. Each sub-workflow gets the full validateProject()
 * check from src/validate.ts, with messages prefixed by the referring node.
 */
export async function validateSubworkflows(
  project: Project,
  visited?: Set<string>,
  strict = false
): Promise<ValidationResult> {
  // Lazy import: src/validate.ts imports this module.
  const { collectSubworkflowDiagnostics } = await import("./validate.js");
  const { errors, warnings } = await collectSubworkflowDiagnostics(
    project,
    visited ?? new Set()
  );

  const result: ValidationResult = {
    valid: errors.length === 0,
    errors: errors.map((e) => e.message),
    warnings,
  };

  // In strict mode, warnings become errors
  if (strict && warnings.length > 0) {
    result.valid = false;
    for (const w of warnings) {
      if (!result.errors.includes(w.message)) {
        result.errors.push(w.message);
      }
    }
  }

  return result;
}

// ─── DAG Construction ────────────────────────────────────────

/** Build and validate DAG from project. */
export function buildDag(
  project: Project,
  validateMappingsFlag = false
): DAG {
  const nodes: Record<string, DAGNode> = {};

  // Create nodes for all known entities
  for (const nodeId of Object.keys(project.inputNodes)) {
    nodes[nodeId] = {
      id: nodeId,
      type: "input",
      incomingEdges: [],
      outgoingEdges: [],
    };
  }
  for (const nodeId of Object.keys(project.prompts)) {
    nodes[nodeId] = {
      id: nodeId,
      type: "prompt",
      incomingEdges: [],
      outgoingEdges: [],
    };
  }
  for (const nodeId of Object.keys(project.outputNodes)) {
    nodes[nodeId] = {
      id: nodeId,
      type: "output",
      incomingEdges: [],
      outgoingEdges: [],
    };
  }
  for (const nodeId of Object.keys(project.tools)) {
    nodes[nodeId] = {
      id: nodeId,
      type: "tool",
      incomingEdges: [],
      outgoingEdges: [],
    };
  }
  for (const nodeId of Object.keys(project.agents)) {
    nodes[nodeId] = {
      id: nodeId,
      type: "agent",
      incomingEdges: [],
      outgoingEdges: [],
    };
  }
  for (const nodeId of Object.keys(project.branches)) {
    nodes[nodeId] = {
      id: nodeId,
      type: "branch",
      incomingEdges: [],
      outgoingEdges: [],
    };
  }
  for (const nodeId of Object.keys(project.maps)) {
    nodes[nodeId] = {
      id: nodeId,
      type: "map",
      incomingEdges: [],
      outgoingEdges: [],
    };
  }
  for (const nodeId of Object.keys(project.triggers)) {
    nodes[nodeId] = {
      id: nodeId,
      type: "trigger",
      incomingEdges: [],
      outgoingEdges: [],
    };
  }

  // Wire up edges
  for (const edge of Object.values(project.edges)) {
    if (!nodes[edge.fromNode]) {
      throw new DAGError(
        `Edge ${edge.id} references unknown source node: ${edge.fromNode}`
      );
    }
    if (!nodes[edge.toNode]) {
      throw new DAGError(
        `Edge ${edge.id} references unknown target node: ${edge.toNode}`
      );
    }
    nodes[edge.fromNode].outgoingEdges.push(edge);
    nodes[edge.toNode].incomingEdges.push(edge);
  }

  // Topological sort with level grouping (modified Kahn's algorithm)
  const inDegree: Record<string, number> = {};
  for (const [nodeId, node] of Object.entries(nodes)) {
    inDegree[nodeId] = node.incomingEdges.length;
  }

  let currentLevel = Object.entries(inDegree)
    .filter(([, degree]) => degree === 0)
    .map(([id]) => id);

  const executionLevels: string[][] = [];
  const executionOrder: string[] = [];

  while (currentLevel.length > 0) {
    currentLevel.sort();
    executionLevels.push(currentLevel);
    executionOrder.push(...currentLevel);

    const nextLevel: string[] = [];
    for (const nodeId of currentLevel) {
      for (const edge of nodes[nodeId].outgoingEdges) {
        inDegree[edge.toNode]--;
        if (inDegree[edge.toNode] === 0) {
          nextLevel.push(edge.toNode);
        }
      }
    }
    currentLevel = nextLevel;
  }

  // Check for cycles
  if (executionOrder.length !== Object.keys(nodes).length) {
    const remaining = new Set(Object.keys(nodes));
    for (const id of executionOrder) {
      remaining.delete(id);
    }
    throw new DAGError(
      `Cycle detected in DAG. Nodes involved: ${JSON.stringify([...remaining])}`
    );
  }

  const dag: DAG = { nodes, executionOrder, executionLevels };

  // Optionally validate edge mappings
  if (validateMappingsFlag) {
    const validation = validateEdgeMappings(project, dag);
    if (validation.warnings.length > 0) {
      process.stderr.write("Edge mapping warnings:\n");
      for (const warning of validation.warnings) {
        process.stderr.write(`  Warning: ${warning.message}\n`);
      }
      process.stderr.write("\n");
    }
  }

  return dag;
}

// ─── DAG Traversal Utilities ─────────────────────────────────

/** Get all nodes that feed into a given node. */
export function getUpstreamNodes(dag: DAG, nodeId: string): string[] {
  const node = dag.nodes[nodeId];
  if (!node) return [];
  return node.incomingEdges.map((e) => e.fromNode);
}

/** Get all nodes that a given node feeds into. */
export function getDownstreamNodes(dag: DAG, nodeId: string): string[] {
  const node = dag.nodes[nodeId];
  if (!node) return [];
  return node.outgoingEdges.map((e) => e.toNode);
}

/** Get all ancestor nodes (transitive upstream) of a given node. */
export function getAncestors(dag: DAG, nodeId: string): Set<string> {
  const ancestors = new Set<string>();
  const toVisit = getUpstreamNodes(dag, nodeId);

  while (toVisit.length > 0) {
    const current = toVisit.pop()!;
    if (!ancestors.has(current)) {
      ancestors.add(current);
      toVisit.push(...getUpstreamNodes(dag, current));
    }
  }

  return ancestors;
}

// ─── Visualization ───────────────────────────────────────────

function getNodeSymbol(nodeType: string): string {
  const symbols: Record<string, string> = {
    input: "[I]",
    prompt: "[P]",
    tool: "[T]",
    output: "[O]",
    agent: "[A]",
    branch: "[B]",
    map: "[M]",
    trigger: "[R]",
  };
  return symbols[nodeType] ?? "[?]";
}

/** Generate ASCII visualization of the DAG. */
export function visualizeDag(dag: DAG): string {
  if (Object.keys(dag.nodes).length === 0) return "No nodes found";

  const lines: string[] = [];
  lines.push("DAG Visualization:");
  lines.push("");

  for (let i = 0; i < dag.executionOrder.length; i++) {
    const nodeId = dag.executionOrder[i];
    const node = dag.nodes[nodeId];
    const symbol = getNodeSymbol(node.type);

    lines.push(`${symbol} ${nodeId}`);

    if (node.outgoingEdges.length > 0) {
      for (let j = 0; j < node.outgoingEdges.length; j++) {
        const edge = node.outgoingEdges[j];
        const isLast = j === node.outgoingEdges.length - 1;
        const connector = isLast ? "\\u2514\\u2500\\u2500" : "\\u251c\\u2500\\u2500";
        const targetSymbol = getNodeSymbol(dag.nodes[edge.toNode].type);
        lines.push(`  ${connector}> ${targetSymbol} ${edge.toNode}`);
      }
    }

    if (i < dag.executionOrder.length - 1) {
      lines.push("");
    }
  }

  lines.push("");
  lines.push(
    "Legend: [I] Input, [P] Prompt, [T] Tool, [A] Agent, [B] Branch, [M] Map, [R] Trigger, [O] Output"
  );

  return lines.join("\n");
}

/** Generate Mermaid flowchart visualization of the DAG. */
export function visualizeDagMermaid(
  dag: DAG,
  direction = "TD"
): string {
  if (Object.keys(dag.nodes).length === 0) {
    return "```mermaid\nflowchart TD\n    empty[No nodes]\n```";
  }

  const lines = ["```mermaid", `flowchart ${direction}`, ""];

  const shapeMap: Record<string, [string, string]> = {
    input: ["([", "])"],
    output: ["([", "])"],
    prompt: ["[", "]"],
    tool: ["{{", "}}"],
    agent: ["[[", "]]"],
    branch: ["{", "}"],
    map: ["[/", "/]"],
    trigger: ["((", "))"],
  };

  // Define nodes with shapes
  lines.push("    %% Nodes");
  for (const nodeId of dag.executionOrder) {
    const node = dag.nodes[nodeId];
    const [left, right] = shapeMap[node.type] ?? ["[", "]"];
    const safeId = nodeId.replace(/-/g, "_").replace(/ /g, "_");
    const label =
      node.type !== "input" && node.type !== "output"
        ? `${node.type}: ${nodeId}`
        : nodeId;
    lines.push(`    ${safeId}${left}${label}${right}`);
  }

  lines.push("");
  lines.push("    %% Edges");

  const seenEdges = new Set<string>();
  for (const nodeId of dag.executionOrder) {
    const node = dag.nodes[nodeId];
    for (const edge of node.outgoingEdges) {
      const key = `${edge.fromNode}:${edge.toNode}`;
      if (!seenEdges.has(key)) {
        seenEdges.add(key);
        const safeFrom = edge.fromNode.replace(/-/g, "_").replace(/ /g, "_");
        const safeTo = edge.toNode.replace(/-/g, "_").replace(/ /g, "_");
        lines.push(`    ${safeFrom} --> ${safeTo}`);
      }
    }
  }

  lines.push("```");
  return lines.join("\n");
}
