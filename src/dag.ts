/**
 * DAG construction and validation.
 *
 * Builds a directed acyclic graph from a project's nodes and edges,
 * performs topological sorting, and validates edge mappings.
 */

import * as nodePath from "node:path";
import { existsSync } from "node:fs";

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

/** Result of DAG validation. */
export interface ValidationResult {
  valid: boolean;
  errors: string[];
  warnings: ValidationWarning[];
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
    return { items: "array", count: "number" };
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

/** Check if source type is compatible with target type. */
export function typesCompatible(
  sourceType: string | null,
  targetType: string | null
): boolean {
  if (sourceType === null || targetType === null) return true;
  if (sourceType === targetType) return true;

  const compatiblePairs = new Set([
    "integer:number",
    "number:integer",
    "object:string",
    "array:string",
  ]);
  return compatiblePairs.has(`${sourceType}:${targetType}`);
}

// ─── Edge Mapping Validation ─────────────────────────────────

/** Validate edge mappings against node input/output contracts. */
export function validateEdgeMappings(
  project: Project,
  dag: DAG,
  strict = false
): ValidationResult {
  const result: ValidationResult = { valid: true, errors: [], warnings: [] };

  for (const edge of Object.values(project.edges)) {
    const sourceNode = dag.nodes[edge.fromNode];
    const targetNode = dag.nodes[edge.toNode];
    if (!sourceNode || !targetNode) continue;

    const sourceFields = getNodeOutputFields(
      project,
      edge.fromNode,
      sourceNode.type
    );
    const targetFields = getNodeInputFields(
      project,
      edge.toNode,
      targetNode.type
    );

    const sourceTypes = getNodeOutputTypes(
      project,
      edge.fromNode,
      sourceNode.type
    );
    const targetTypes = getNodeInputTypes(
      project,
      edge.toNode,
      targetNode.type
    );

    for (const mapping of edge.mappings) {
      // Validate source field
      const baseField = mapping.sourceExpr.split(".")[0];
      if (sourceFields.size > 0 && !sourceFields.has(baseField)) {
        result.warnings.push({
          message:
            `Source field '${mapping.sourceExpr}' may not exist in ` +
            `'${edge.fromNode}' (${sourceNode.type}) output. ` +
            `Available fields: ${JSON.stringify([...sourceFields].sort())}`,
          edgeId: edge.id,
          nodeId: edge.fromNode,
        });
      }

      // Validate target field
      if (targetFields.size > 0 && !targetFields.has(mapping.targetVar)) {
        result.warnings.push({
          message:
            `Target field '${mapping.targetVar}' not expected by ` +
            `'${edge.toNode}' (${targetNode.type}). ` +
            `Expected inputs: ${JSON.stringify([...targetFields].sort())}`,
          edgeId: edge.id,
          nodeId: edge.toNode,
        });
      }

      // Type compatibility check
      const sourceType = sourceTypes[baseField] ?? null;
      const targetType = targetTypes[mapping.targetVar] ?? null;
      if (!typesCompatible(sourceType, targetType)) {
        result.warnings.push({
          message:
            `Type mismatch: '${baseField}' (${sourceType}) from ` +
            `'${edge.fromNode}' may not be compatible with ` +
            `'${mapping.targetVar}' (${targetType}) in '${edge.toNode}'`,
          edgeId: edge.id,
          nodeId: edge.fromNode,
        });
      }
    }
  }

  // In strict mode, warnings become errors
  if (strict && result.warnings.length > 0) {
    result.valid = false;
    result.errors = result.warnings.map((w) => w.message);
  }

  return result;
}

// ─── Sub-workflow Validation ─────────────────────────────────

/** Recursively validate all sub-workflows referenced by branch and map nodes. */
export async function validateSubworkflows(
  project: Project,
  visited?: Set<string>,
  strict = false
): Promise<ValidationResult> {
  // Lazy import to break circular dependency
  const { loadProject } = await import("./project.js") as {
    loadProject: (p: string) => Project;
  };

  const result: ValidationResult = { valid: true, errors: [], warnings: [] };

  if (!visited) visited = new Set();

  const currentPath = project.root;
  if (visited.has(currentPath)) {
    result.valid = false;
    result.errors.push(
      `Circular workflow reference detected: ${currentPath}`
    );
    return result;
  }
  visited.add(currentPath);

  // Validate branch sub-workflows
  for (const [branchId, branch] of Object.entries(project.branches)) {
    if (branch.workflowPath === "self") continue;

    const resolvedPath = nodePath.resolve(
      project.root,
      branch.workflowPath
    );

    if (
      !existsSync(resolvedPath)
    ) {
      result.valid = false;
      result.errors.push(
        `Branch '${branchId}': workflow file not found: ${branch.workflowPath}`
      );
      continue;
    }

    if (visited.has(resolvedPath)) {
      result.valid = false;
      result.errors.push(
        `Branch '${branchId}': circular workflow reference to ${branch.workflowPath}`
      );
      continue;
    }

    try {
      const subProject = loadProject(resolvedPath);
      const subDag = buildDag(subProject);
      const subValidation = validateEdgeMappings(subProject, subDag, strict);

      if (!subValidation.valid) {
        result.valid = false;
        for (const error of subValidation.errors) {
          result.errors.push(
            `Branch '${branchId}' (${branch.workflowPath}): ${error}`
          );
        }
      }
      for (const warning of subValidation.warnings) {
        result.warnings.push({
          message: `Branch '${branchId}' (${branch.workflowPath}): ${warning.message}`,
          edgeId: warning.edgeId,
          nodeId: warning.nodeId,
        });
      }

      const subResult = await validateSubworkflows(
        subProject,
        new Set(visited),
        strict
      );
      if (!subResult.valid) {
        result.valid = false;
        result.errors.push(...subResult.errors);
      }
      result.warnings.push(...subResult.warnings);
    } catch (e) {
      result.valid = false;
      result.errors.push(
        `Branch '${branchId}': failed to load workflow ${branch.workflowPath}: ${e}`
      );
    }
  }

  // Validate map sub-workflows
  for (const [mapId, mapNode] of Object.entries(project.maps)) {
    const resolvedPath = nodePath.resolve(
      project.root,
      mapNode.workflowPath
    );

    if (!existsSync(resolvedPath)) {
      result.valid = false;
      result.errors.push(
        `Map '${mapId}': workflow file not found: ${mapNode.workflowPath}`
      );
      continue;
    }

    if (visited.has(resolvedPath)) {
      result.valid = false;
      result.errors.push(
        `Map '${mapId}': circular workflow reference to ${mapNode.workflowPath}`
      );
      continue;
    }

    try {
      const subProject = loadProject(resolvedPath);
      const subDag = buildDag(subProject);
      const subValidation = validateEdgeMappings(subProject, subDag, strict);

      if (!subValidation.valid) {
        result.valid = false;
        for (const error of subValidation.errors) {
          result.errors.push(
            `Map '${mapId}' (${mapNode.workflowPath}): ${error}`
          );
        }
      }
      for (const warning of subValidation.warnings) {
        result.warnings.push({
          message: `Map '${mapId}' (${mapNode.workflowPath}): ${warning.message}`,
          edgeId: warning.edgeId,
          nodeId: warning.nodeId,
        });
      }

      const subResult = await validateSubworkflows(
        subProject,
        new Set(visited),
        strict
      );
      if (!subResult.valid) {
        result.valid = false;
        result.errors.push(...subResult.errors);
      }
      result.warnings.push(...subResult.warnings);
    } catch (e) {
      result.valid = false;
      result.errors.push(
        `Map '${mapId}': failed to load workflow ${mapNode.workflowPath}: ${e}`
      );
    }
  }

  // In strict mode, warnings become errors
  if (strict && result.warnings.length > 0) {
    result.valid = false;
    for (const w of result.warnings) {
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
