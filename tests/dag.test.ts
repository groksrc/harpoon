/**
 * Tests for DAG construction and validation (dag.ts).
 */

import { describe, it, expect } from "vitest";
import {
  buildDag,
  getUpstreamNodes,
  getDownstreamNodes,
  getAncestors,
  getNodeOutputFields,
  getNodeOutputTypes,
  getNodeInputTypes,
  typesCompatible,
  validateEdgeMappings,
} from "../src/dag.js";
import type { Project, Edge, EdgeMapping, InputNode, OutputNode } from "../src/project.js";
import type { PromptNode, InputField, BranchNode, AgentNode } from "../src/parser.js";
import { DAGError } from "../src/errors.js";
import { validateProject } from "../src/validate.js";
import { loadProject } from "../src/project.js";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

/** Create a minimal Project for testing. */
function makeProject(
  edges: [string, string][],
  prompts?: string[]
): Project {
  const project: Project = {
    name: "test",
    root: ".",
    version: "1.0",
    description: "",
    defaults: {},
    entrypoints: [],
    edges: {},
    prompts: {},
    inputNodes: {},
    outputNodes: {},
    tools: {},
    agents: {},
    branches: {},
    maps: {},
    triggers: {},
    env: {},
  };

  // Add edges
  for (let i = 0; i < edges.length; i++) {
    const [from, to] = edges[i];
    project.edges[`e${i}`] = {
      id: `e${i}`,
      fromNode: from,
      toNode: to,
      mappings: [],
    };
  }

  // Add prompt nodes
  if (prompts) {
    for (const p of prompts) {
      project.prompts[p] = {
        id: p,
        harpoonVersion: "1.0",
        name: p,
        description: "",
        model: null,
        temperature: null,
        maxTokens: null,
        timeout: null,
        inputs: {},
        output: { format: "text", fields: {} },
        body: "",
        filePath: null,
        maxTurns: null,
        allowedTools: null,
        permissionMode: null,
        effort: null,
        entrypoint: false,
        next: null,
        loop: null,
        tools: null,
      };
    }
  }

  // Add implicit input/output nodes based on edges
  const allFrom = new Set(edges.map(([f]) => f));
  const allTo = new Set(edges.map(([, t]) => t));
  const promptSet = new Set(prompts ?? []);

  for (const nodeId of allFrom) {
    if (!promptSet.has(nodeId)) {
      project.inputNodes[nodeId] = { id: nodeId, schema: {} };
    }
  }

  for (const nodeId of allTo) {
    if (!promptSet.has(nodeId) && !(nodeId in project.inputNodes)) {
      project.outputNodes[nodeId] = { id: nodeId, format: "json" };
    }
  }

  return project;
}

describe("buildDag", () => {
  it("builds a simple linear DAG", () => {
    const project = makeProject(
      [
        ["a", "b"],
        ["b", "c"],
      ],
      ["b"]
    );
    const dag = buildDag(project);

    expect(dag.nodes).toHaveProperty("a");
    expect(dag.nodes).toHaveProperty("b");
    expect(dag.nodes).toHaveProperty("c");
    expect(dag.executionOrder).toEqual(["a", "b", "c"]);
  });

  it("builds a branching DAG", () => {
    const project = makeProject(
      [
        ["input", "a"],
        ["input", "b"],
        ["a", "output"],
        ["b", "output"],
      ],
      ["a", "b"]
    );
    const dag = buildDag(project);

    expect(dag.executionOrder[0]).toBe("input");
    expect(dag.executionOrder[dag.executionOrder.length - 1]).toBe("output");
  });

  it("groups parallel nodes in same execution level", () => {
    const project = makeProject(
      [
        ["input", "a"],
        ["input", "b"],
        ["a", "output"],
        ["b", "output"],
      ],
      ["a", "b"]
    );
    const dag = buildDag(project);

    expect(dag.executionLevels).toHaveLength(3);
    expect(dag.executionLevels[0]).toEqual(["input"]);
    expect(dag.executionLevels[1].sort()).toEqual(["a", "b"]);
    expect(dag.executionLevels[2]).toEqual(["output"]);
  });

  it("puts sequential nodes in separate levels", () => {
    const project = makeProject(
      [
        ["a", "b"],
        ["b", "c"],
      ],
      ["b"]
    );
    const dag = buildDag(project);

    expect(dag.executionLevels).toHaveLength(3);
    expect(dag.executionLevels[0]).toEqual(["a"]);
    expect(dag.executionLevels[1]).toEqual(["b"]);
    expect(dag.executionLevels[2]).toEqual(["c"]);
  });

  it("detects cycles", () => {
    const project = makeProject(
      [
        ["a", "b"],
        ["b", "c"],
        ["c", "a"],
      ],
      ["a", "b", "c"]
    );

    expect(() => buildDag(project)).toThrow(DAGError);
  });

  it("detects self-loops", () => {
    const project = makeProject([["a", "a"]], ["a"]);
    expect(() => buildDag(project)).toThrow(DAGError);
  });

  it("throws for edges referencing unknown nodes", () => {
    const project: Project = {
      name: "test",
      root: ".",
      version: "1.0",
      description: "",
      defaults: {},
      entrypoints: [],
      edges: {
        e0: {
          id: "e0",
          fromNode: "nonexistent",
          toNode: "also_nonexistent",
          mappings: [],
        },
      },
      prompts: {},
      inputNodes: {},
      outputNodes: {},
      tools: {},
      agents: {},
      branches: {},
      maps: {},
      triggers: {},
      env: {},
    };

    expect(() => buildDag(project)).toThrow(DAGError);
  });

  it("includes branch nodes in DAG", () => {
    const project = makeProject(
      [
        ["input", "branch1"],
        ["branch1", "output"],
      ],
      []
    );
    project.branches["branch1"] = {
      id: "branch1",
      workflowPath: "./sub_workflow",
      condition: null,
      loopWhile: null,
      maxIterations: 10,
    };
    delete project.inputNodes["branch1"];
    delete project.outputNodes["branch1"];

    const dag = buildDag(project);

    expect(dag.nodes).toHaveProperty("branch1");
    expect(dag.nodes.branch1.type).toBe("branch");
    expect(dag.executionOrder).toEqual(["input", "branch1", "output"]);
  });

  it("assigns correct node types", () => {
    const project = makeProject(
      [
        ["input", "prompt1"],
        ["prompt1", "output"],
      ],
      ["prompt1"]
    );
    const dag = buildDag(project);

    expect(dag.nodes.input.type).toBe("input");
    expect(dag.nodes.prompt1.type).toBe("prompt");
    expect(dag.nodes.output.type).toBe("output");
  });
});

describe("getAncestors", () => {
  it("gets ancestors of linear DAG", () => {
    const project = makeProject(
      [
        ["a", "b"],
        ["b", "c"],
      ],
      ["b"]
    );
    const dag = buildDag(project);

    expect(getAncestors(dag, "c")).toEqual(new Set(["a", "b"]));
    expect(getAncestors(dag, "b")).toEqual(new Set(["a"]));
    expect(getAncestors(dag, "a")).toEqual(new Set());
  });

  it("gets ancestors of diamond DAG", () => {
    const project = makeProject(
      [
        ["input", "a"],
        ["input", "b"],
        ["a", "output"],
        ["b", "output"],
      ],
      ["a", "b"]
    );
    const dag = buildDag(project);

    expect(getAncestors(dag, "output")).toEqual(
      new Set(["input", "a", "b"])
    );
    expect(getAncestors(dag, "a")).toEqual(new Set(["input"]));
  });

  it("returns empty for nonexistent node", () => {
    const project = makeProject([["a", "b"]], ["b"]);
    const dag = buildDag(project);

    expect(getAncestors(dag, "nonexistent")).toEqual(new Set());
  });
});

describe("getUpstreamNodes / getDownstreamNodes", () => {
  it("returns upstream and downstream nodes", () => {
    const project = makeProject(
      [
        ["a", "b"],
        ["b", "c"],
      ],
      ["b"]
    );
    const dag = buildDag(project);

    expect(getUpstreamNodes(dag, "b")).toEqual(["a"]);
    expect(getDownstreamNodes(dag, "b")).toEqual(["c"]);
    expect(getUpstreamNodes(dag, "a")).toEqual([]);
    expect(getDownstreamNodes(dag, "c")).toEqual([]);
  });
});

describe("typesCompatible", () => {
  it("exact match is compatible", () => {
    expect(typesCompatible("string", "string")).toBe(true);
    expect(typesCompatible("number", "number")).toBe(true);
    expect(typesCompatible("boolean", "boolean")).toBe(true);
    expect(typesCompatible("array", "array")).toBe(true);
    expect(typesCompatible("object", "object")).toBe(true);
  });

  it("null source is compatible with any target", () => {
    expect(typesCompatible(null, "string")).toBe(true);
    expect(typesCompatible(null, "number")).toBe(true);
  });

  it("any source is compatible with null target", () => {
    expect(typesCompatible("string", null)).toBe(true);
    expect(typesCompatible("number", null)).toBe(true);
  });

  it("both null is compatible", () => {
    expect(typesCompatible(null, null)).toBe(true);
  });

  it("integer to number is compatible", () => {
    expect(typesCompatible("integer", "number")).toBe(true);
  });

  it("number to integer is not compatible", () => {
    // validateSchema() rejects a non-integer at runtime, so the static check
    // must reject the mapping too.
    expect(typesCompatible("number", "integer")).toBe(false);
  });

  it("every other pair of different known types is incompatible", () => {
    const known = ["string", "number", "integer", "boolean", "array", "object"];
    const allowed = new Set(["integer:number", "object:string", "array:string"]);
    for (const source of known) {
      for (const target of known) {
        const expected = source === target || allowed.has(`${source}:${target}`);
        expect(typesCompatible(source, target), `${source} -> ${target}`).toBe(expected);
      }
    }
  });

  it("types outside the known set are not checked", () => {
    expect(typesCompatible("date", "string")).toBe(true);
    expect(typesCompatible("number", "uuid")).toBe(true);
  });

  it("object to string is compatible", () => {
    expect(typesCompatible("object", "string")).toBe(true);
  });

  it("array to string is compatible", () => {
    expect(typesCompatible("array", "string")).toBe(true);
  });

  it("incompatible types return false", () => {
    expect(typesCompatible("string", "number")).toBe(false);
    expect(typesCompatible("string", "boolean")).toBe(false);
    expect(typesCompatible("boolean", "string")).toBe(false);
    expect(typesCompatible("number", "boolean")).toBe(false);
    expect(typesCompatible("array", "object")).toBe(false);
  });
});

describe("getNodeOutputFields", () => {
  it("input node returns schema fields", () => {
    const project = makeProject([], []);
    project.inputNodes["input"] = {
      id: "input",
      schema: { query: ["string", "The query"] },
    };

    const fields = getNodeOutputFields(project, "input", "input");
    expect(fields.has("query")).toBe(true);
  });

  it("prompt node returns text by default", () => {
    const project = makeProject([], ["p1"]);
    const fields = getNodeOutputFields(project, "p1", "prompt");
    expect(fields.has("text")).toBe(true);
  });

  it("tool node returns output", () => {
    const project = makeProject([], []);
    const fields = getNodeOutputFields(project, "tool1", "tool");
    expect(fields.has("output")).toBe(true);
  });

  it("tool node returns declared output schema fields", () => {
    const project = makeProject([], []);
    project.tools["tool1"] = {
      id: "tool1",
      type: "typescript",
      module: "tool1",
      description: "",
      outputSchema: {
        result: { type: "string", description: "", required: true },
        count: { type: "integer", description: "", required: true },
      },
    };
    const fields = getNodeOutputFields(project, "tool1", "tool");
    expect(fields).toEqual(new Set(["result", "count"]));
  });

  it("branch node returns output and text", () => {
    const project = makeProject([], []);
    const fields = getNodeOutputFields(project, "branch1", "branch");
    expect(fields.has("output")).toBe(true);
    expect(fields.has("text")).toBe(true);
  });

  it("map node returns items and count", () => {
    const project = makeProject([], []);
    const fields = getNodeOutputFields(project, "map1", "map");
    expect(fields.has("items")).toBe(true);
    expect(fields.has("count")).toBe(true);
  });

  it("trigger node returns triggered, status, output", () => {
    const project = makeProject([], []);
    const fields = getNodeOutputFields(project, "t1", "trigger");
    expect(fields.has("triggered")).toBe(true);
    expect(fields.has("status")).toBe(true);
    expect(fields.has("output")).toBe(true);
  });
});

describe("getNodeOutputTypes", () => {
  it("prompt text output returns text: string", () => {
    const project = makeProject([], ["p1"]);
    const types = getNodeOutputTypes(project, "p1", "prompt");
    expect(types).toEqual({ text: "string" });
  });

  it("prompt json output returns text plus field types", () => {
    const project = makeProject([], []);
    project.prompts["p1"] = {
      id: "p1",
      harpoonVersion: "1.0",
      name: "",
      description: "",
      model: null,
      temperature: null,
      maxTokens: null,
      timeout: null,
      inputs: {},
      output: {
        format: "json",
        fields: {
          status: ["string", "Status"],
          count: ["integer", "Count"],
        },
      },
      body: "",
      filePath: null,
      maxTurns: null,
      allowedTools: null,
      permissionMode: null,
      effort: null,
      entrypoint: false,
      next: null,
      loop: null,
      tools: null,
    };

    const types = getNodeOutputTypes(project, "p1", "prompt");
    expect(types.text).toBe("string");
    expect(types.status).toBe("string");
    expect(types.count).toBe("integer");
  });

  it("tool output type is unknown (null)", () => {
    const project = makeProject([], []);
    const types = getNodeOutputTypes(project, "tool1", "tool");
    expect(types).toEqual({ output: null });
  });

  it("tool output schema supplies field types", () => {
    const project = makeProject([], []);
    project.tools["tool1"] = {
      id: "tool1",
      type: "typescript",
      module: "tool1",
      description: "",
      outputSchema: {
        result: { type: "string", description: "", required: true },
        count: { type: "integer", description: "", required: true },
      },
    };
    expect(getNodeOutputTypes(project, "tool1", "tool")).toEqual({
      result: "string",
      count: "integer",
    });
  });

  it("branch output types", () => {
    const project = makeProject([], []);
    const types = getNodeOutputTypes(project, "b1", "branch");
    expect(types).toEqual({ output: null, text: "string" });
  });

  it("map output types", () => {
    const project = makeProject([], []);
    const types = getNodeOutputTypes(project, "m1", "map");
    expect(types).toEqual({ items: "array", count: "integer" });
  });
});

describe("getNodeInputTypes", () => {
  it("prompt returns input field types", () => {
    const project = makeProject([], []);
    project.prompts["p1"] = {
      id: "p1",
      harpoonVersion: "1.0",
      name: "",
      description: "",
      model: null,
      temperature: null,
      maxTokens: null,
      timeout: null,
      inputs: {
        code: { name: "code", type: "string", description: "", required: true },
        count: {
          name: "count",
          type: "integer",
          description: "",
          required: true,
        },
      },
      output: { format: "text", fields: {} },
      body: "",
      filePath: null,
      maxTurns: null,
      allowedTools: null,
      permissionMode: null,
      effort: null,
      entrypoint: false,
      next: null,
      loop: null,
      tools: null,
    };

    const types = getNodeInputTypes(project, "p1", "prompt");
    expect(types.code).toBe("string");
    expect(types.count).toBe("integer");
  });

  it("output node returns empty (accepts any)", () => {
    const project = makeProject([], []);
    const types = getNodeInputTypes(project, "output", "output");
    expect(types).toEqual({});
  });
});

describe("validateEdgeMappings", () => {
  function makeProjectWithEdge(
    sourceType: string,
    targetType: string
  ): Project {
    const project = makeProject([], []);

    project.inputNodes["input"] = {
      id: "input",
      schema: { value: [sourceType, "Test value"] },
    };
    project.prompts["process"] = {
      id: "process",
      harpoonVersion: "1.0",
      name: "",
      description: "",
      model: null,
      temperature: null,
      maxTokens: null,
      timeout: null,
      inputs: {
        data: { name: "data", type: targetType, description: "", required: true },
      },
      output: { format: "text", fields: {} },
      body: "",
      filePath: null,
      maxTurns: null,
      allowedTools: null,
      permissionMode: null,
      effort: null,
      entrypoint: false,
      next: null,
      loop: null,
      tools: null,
    };
    project.outputNodes["output"] = { id: "output", format: "json" };

    project.edges["e1"] = {
      id: "e1",
      fromNode: "input",
      toNode: "process",
      mappings: [{ targetVar: "data", sourceExpr: "value" }],
    };
    project.edges["e2"] = {
      id: "e2",
      fromNode: "process",
      toNode: "output",
      mappings: [],
    };
    project.entrypoints = ["input"];

    return project;
  }

  it("compatible types produce no type mismatch warnings", () => {
    const project = makeProjectWithEdge("string", "string");
    const dag = buildDag(project);
    const result = validateEdgeMappings(project, dag);

    expect(result.valid).toBe(true);
    const typeWarnings = result.warnings.filter((w) =>
      w.message.includes("Type mismatch")
    );
    expect(typeWarnings).toHaveLength(0);
  });

  it("integer to number is compatible", () => {
    const project = makeProjectWithEdge("integer", "number");
    const dag = buildDag(project);
    const result = validateEdgeMappings(project, dag);

    const typeWarnings = result.warnings.filter((w) =>
      w.message.includes("Type mismatch")
    );
    expect(typeWarnings).toHaveLength(0);
  });

  it("incompatible types produce an error", () => {
    const project = makeProjectWithEdge("string", "number");
    const dag = buildDag(project);
    const result = validateEdgeMappings(project, dag);

    expect(result.valid).toBe(false);
    const typeErrors = result.errors.filter((e) => e.includes("Type mismatch"));
    expect(typeErrors).toHaveLength(1);
    expect(typeErrors[0]).toContain("'e1'");
    expect(typeErrors[0]).toContain("string");
    expect(typeErrors[0]).toContain("number");
  });

  it("strict mode turns warnings into errors", () => {
    const project = makeProjectWithEdge("string", "boolean");
    const dag = buildDag(project);
    const result = validateEdgeMappings(project, dag, true);

    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0]).toContain("Type mismatch");
  });

  it("object to string is compatible", () => {
    const project = makeProjectWithEdge("object", "string");
    const dag = buildDag(project);
    const result = validateEdgeMappings(project, dag);

    const typeWarnings = result.warnings.filter((w) =>
      w.message.includes("Type mismatch")
    );
    expect(typeWarnings).toHaveLength(0);
  });

  it("validates tool mappings against declared fields and types", () => {
    const project = makeProject([], []);
    project.tools["prepare"] = {
      id: "prepare",
      type: "typescript",
      module: "prepare",
      description: "",
      outputSchema: {
        job_id: { type: "string", description: "", required: true },
        count: { type: "integer", description: "", required: true },
      },
    };
    project.prompts["consume"] = {
      id: "consume",
      harpoonVersion: "1.0",
      name: "",
      description: "",
      model: null,
      temperature: null,
      maxTokens: null,
      timeout: null,
      inputs: {
        job_id: { name: "job_id", type: "string", description: "", required: true },
        count: { name: "count", type: "integer", description: "", required: true },
      },
      output: { format: "text", fields: {} },
      body: "",
      filePath: null,
      maxTurns: null,
      allowedTools: null,
      permissionMode: null,
      effort: null,
      entrypoint: false,
      next: null,
      loop: null,
      tools: null,
    };
    project.outputNodes["output"] = { id: "output", format: "json" };
    project.edges = {
      e1: {
        id: "e1",
        fromNode: "prepare",
        toNode: "consume",
        mappings: [
          { targetVar: "job_id", sourceExpr: "job_id" },
          { targetVar: "count", sourceExpr: "count" },
        ],
      },
      e2: {
        id: "e2",
        fromNode: "consume",
        toNode: "output",
        mappings: [],
      },
    };
    project.entrypoints = ["prepare"];

    const result = validateEdgeMappings(project, buildDag(project));
    expect(result.warnings).toEqual([]);
  });
});

// ─── validateProject ─────────────────────────────────────────

/** A prompt node with the given inputs and output schema. */
function makePrompt(
  id: string,
  inputs: Record<string, Partial<InputField> & { type: string }> = {},
  outputFields: Record<string, string> = {}
): PromptNode {
  const promptInputs: Record<string, InputField> = {};
  for (const [name, spec] of Object.entries(inputs)) {
    promptInputs[name] = {
      name,
      description: "",
      required: true,
      ...spec,
    };
  }
  const fields: Record<string, [string, string]> = {};
  for (const [name, type] of Object.entries(outputFields)) {
    fields[name] = [type, ""];
  }
  return {
    id,
    harpoonVersion: "1.0",
    name: id,
    description: "",
    model: null,
    temperature: null,
    maxTokens: null,
    timeout: null,
    inputs: promptInputs,
    output: {
      format: Object.keys(fields).length > 0 ? "json" : "text",
      fields,
    },
    body: "",
    filePath: null,
    maxTurns: null,
    allowedTools: null,
    permissionMode: null,
    effort: null,
    entrypoint: false,
    next: null,
    loop: null,
    tools: null,
  };
}

function edge(
  id: string,
  fromNode: string,
  toNode: string,
  mapping: Record<string, string> = {},
  condition?: string
): Edge {
  return {
    id,
    fromNode,
    toNode,
    mappings: Object.entries(mapping).map(([targetVar, sourceExpr]) => ({
      targetVar,
      sourceExpr,
    })),
    condition: condition ?? null,
  };
}

/** An empty project with an input node "input" and an output node "output". */
function makeContractProject(
  inputSchema: Record<string, string> = {}
): Project {
  const project = makeProject([], []);
  project.inputNodes.input = {
    id: "input",
    schema: Object.fromEntries(
      Object.entries(inputSchema).map(([name, type]) => [name, [type, ""]])
    ),
  };
  project.outputNodes.output = { id: "output", format: "json" };
  project.entrypoints = ["input"];
  return project;
}

/**
 * A diamond with fan-in: input feeds left and right, both feed join, and
 * join feeds output. join needs one input from each parent.
 */
function makeDiamondProject(): Project {
  const project = makeContractProject({ text: "string" });
  project.prompts.left = makePrompt("left", { text: { type: "string" } }, { a: "string" });
  project.prompts.right = makePrompt("right", { text: { type: "string" } }, { b: "integer" });
  project.prompts.join = makePrompt(
    "join",
    { a: { type: "string" }, b: { type: "number" } },
    { result: "string" }
  );
  for (const e of [
    edge("in_left", "input", "left", { text: "text" }),
    edge("in_right", "input", "right", { text: "text" }),
    edge("left_join", "left", "join", { a: "a" }),
    edge("right_join", "right", "join", { b: "b" }),
    edge("join_out", "join", "output", { result: "result" }),
  ]) {
    project.edges[e.id] = e;
  }
  return project;
}

const EXAMPLES_DIR = path.resolve(__dirname, "..", "examples");

describe("validateProject", () => {
  describe("valid workflows", () => {
    const examples = fs
      .readdirSync(EXAMPLES_DIR)
      .filter((name) => fs.statSync(path.join(EXAMPLES_DIR, name)).isDirectory());

    it("finds the examples", () => {
      expect(examples.length).toBeGreaterThanOrEqual(7);
    });

    for (const name of examples) {
      it(`accepts examples/${name} in strict mode`, async () => {
        const project = loadProject(path.join(EXAMPLES_DIR, name));
        const result = await validateProject(project, { strict: true });
        expect(result.errors).toEqual([]);
        expect(result.warnings).toEqual([]);
        expect(result.valid).toBe(true);
      });
    }

    it("accepts a diamond with fan-in and several parents", async () => {
      const result = await validateProject(makeDiamondProject(), { strict: true });
      expect(result.errors).toEqual([]);
      expect(result.warnings).toEqual([]);
      expect(result.valid).toBe(true);
      expect(result.dag?.executionLevels).toEqual([
        ["input"],
        ["left", "right"],
        ["join"],
        ["output"],
      ]);
    });

    it("accepts several input nodes feeding one node", async () => {
      const project = makeContractProject({ a: "string" });
      project.inputNodes.second = { id: "second", schema: { b: ["string", ""] } };
      project.prompts.p = makePrompt("p", { a: { type: "string" }, b: { type: "string" } });
      project.edges.e1 = edge("e1", "input", "p", { a: "a" });
      project.edges.e2 = edge("e2", "second", "p", { b: "b" });
      project.edges.e3 = edge("e3", "p", "output", { text: "text" });
      const result = await validateProject(project, { strict: true });
      expect(result.errors).toEqual([]);
      expect(result.valid).toBe(true);
    });

    it("does not check dynamic sources: tools without a schema, branch, trigger and empty input schemas", async () => {
      const project = makeContractProject();
      project.tools.fetch = { id: "fetch", type: "typescript", module: "fetch", description: "" };
      project.branches.loop = {
        id: "loop",
        workflowPath: "self",
        condition: null,
        loopWhile: null,
        maxIterations: 1,
      };
      project.prompts.p = makePrompt("p", {
        a: { type: "string" },
        b: { type: "string" },
        c: { type: "string" },
      });
      project.edges.e1 = edge("e1", "input", "fetch", { anything: "whatever" });
      project.edges.e2 = edge("e2", "fetch", "loop", { x: "unknown_field" });
      project.edges.e3 = edge("e3", "loop", "p", { a: "is_complete", b: "output.text" });
      project.edges.e4 = edge("e4", "fetch", "p", { c: "data.nested" });
      project.edges.e5 = edge("e5", "p", "output", { text: "text" });
      const result = await validateProject(project);
      expect(result.errors).toEqual([]);
    });

    it("resolves an 'output.' prefix the way the executor does", async () => {
      const project = makeContractProject({ text: "string" });
      project.prompts.a = makePrompt("a", { text: { type: "string" } }, { summary: "string" });
      project.prompts.b = makePrompt("b", { summary: { type: "string" } });
      project.edges.e1 = edge("e1", "input", "a", { text: "text" });
      project.edges.e2 = edge("e2", "a", "b", { summary: "output.summary" });
      project.edges.e3 = edge("e3", "b", "output", { text: "text" });
      const result = await validateProject(project);
      expect(result.errors).toEqual([]);
    });
  });

  describe("structural errors", () => {
    it("reports an edge to an unknown node, naming the edge and node", async () => {
      const project = makeContractProject();
      project.edges.e1 = edge("e1", "input", "output");
      project.edges.to_ghost = edge("to_ghost", "input", "ghost");
      const result = await validateProject(project);
      expect(result.valid).toBe(false);
      expect(result.errors).toContainEqual({
        message: "Edge 'to_ghost' references unknown target node 'ghost'",
        edgeId: "to_ghost",
        nodeId: "ghost",
      });
    });

    it("reports an edge from an unknown node", async () => {
      const project = makeContractProject();
      project.edges.from_ghost = edge("from_ghost", "ghost", "output");
      const result = await validateProject(project);
      expect(result.valid).toBe(false);
      expect(result.errors.map((e) => e.message)).toContain(
        "Edge 'from_ghost' references unknown source node 'ghost'"
      );
    });

    it("reports a cycle as an error naming its nodes, without throwing", async () => {
      const project = makeContractProject();
      project.prompts.a = makePrompt("a");
      project.prompts.b = makePrompt("b");
      project.edges.e0 = edge("e0", "input", "a");
      project.edges.e1 = edge("e1", "a", "b");
      project.edges.e2 = edge("e2", "b", "a");
      const result = await validateProject(project);
      expect(result.valid).toBe(false);
      expect(result.dag).toBeUndefined();
      const cycle = result.errors.find((e) => e.message.includes("Cycle detected"));
      expect(cycle?.message).toContain('"a"');
      expect(cycle?.message).toContain('"b"');
    });

    it("reports a declared entrypoint that is not a node", async () => {
      const project = makeContractProject();
      project.edges.e1 = edge("e1", "input", "output");
      project.entrypoints = ["input", "start_here"];
      const result = await validateProject(project);
      expect(result.valid).toBe(false);
      const error = result.errors.find((e) => e.nodeId === "start_here");
      expect(error?.message).toContain("Entrypoint 'start_here' is not a node");
    });

    it("reports a requested entrypoint that is not a node", async () => {
      const project = makeContractProject();
      project.edges.e1 = edge("e1", "input", "output");
      const result = await validateProject(project, { entrypoint: "nope" });
      expect(result.valid).toBe(false);
      expect(result.errors[0].message).toContain(
        "Requested entrypoint 'nope' is not a node"
      );

      const ok = await validateProject(project, { entrypoint: "input" });
      expect(ok.valid).toBe(true);
    });

    it("reports a node with an unknown type", async () => {
      const project = makeContractProject();
      project.edges.e1 = edge("e1", "input", "output");
      project.unknownTypeNodes = { summarizer: "promt" };
      const result = await validateProject(project);
      expect(result.valid).toBe(false);
      expect(result.errors[0]).toMatchObject({ nodeId: "summarizer" });
      expect(result.errors[0].message).toContain(
        "Node 'summarizer' has unknown type 'promt'"
      );
    });

    it("keeps reporting missing sub-workflows", async () => {
      const project = makeContractProject();
      project.maps.fan = {
        id: "fan",
        workflowPath: "./does-not-exist",
        over: "items",
        maxConcurrency: 0,
        onError: "fail",
        itemCondition: null,
      };
      project.edges.e1 = edge("e1", "input", "fan");
      project.edges.e2 = edge("e2", "fan", "output");
      const result = await validateProject(project);
      expect(result.valid).toBe(false);
      expect(result.errors.map((e) => e.message)).toContain(
        "Map 'fan': workflow file not found: ./does-not-exist"
      );
    });

    it("reports contract errors inside a sub-workflow with the referring node", async () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "harpoon-subwf-"));
      try {
        fs.mkdirSync(path.join(root, "child"));
        fs.writeFileSync(
          path.join(root, "child", "agent.tml"),
          `harpoon: "1.0"
name: child
nodes:
  input:
    type: input
    schema:
      n: { type: number, description: N }
  output:
    type: output
tools:
  t:
    type: typescript
    module: t
    output:
      schema:
        out: { type: string, description: Out }
edges:
  e1: { from: input, to: t, mapping: { n: n } }
  bad: { from: t, to: output, mapping: { x: missing } }
`
        );
        const project = makeContractProject();
        project.root = root;
        project.branches.sub = {
          id: "sub",
          workflowPath: "./child",
          condition: null,
          loopWhile: null,
          maxIterations: 1,
        };
        project.edges.e1 = edge("e1", "input", "sub");
        project.edges.e2 = edge("e2", "sub", "output");
        const result = await validateProject(project);
        expect(result.valid).toBe(false);
        expect(result.errors[0].message).toMatch(
          /^Branch 'sub' \(\.\/child\): Edge 'bad': source field 'missing' does not exist in 't'/
        );
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    });
  });

  describe("contract errors", () => {
    it("reports a source field the source does not output", async () => {
      const project = makeContractProject({ text: "string" });
      project.prompts.p = makePrompt("p", { text: { type: "string" } });
      project.edges.e1 = edge("e1", "input", "p", { text: "txt" });
      project.edges.e2 = edge("e2", "p", "output", { text: "text" });
      const result = await validateProject(project);
      expect(result.valid).toBe(false);
      expect(result.errors.map((e) => e.edgeId)).toContain("e1");
      expect(result.errors[0].message).toContain("source field 'txt' does not exist in 'input'");
    });

    it("reports a target field the prompt does not declare", async () => {
      const project = makeContractProject({ text: "string" });
      project.prompts.p = makePrompt("p", { text: { type: "string" } });
      project.edges.e1 = edge("e1", "input", "p", { text: "text", extra: "text" });
      project.edges.e2 = edge("e2", "p", "output", { anything: "text" });
      const result = await validateProject(project);
      expect(result.valid).toBe(false);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toMatchObject({ edgeId: "e1", nodeId: "p" });
      expect(result.errors[0].message).toContain("target field 'extra' is not an input of 'p'");
    });

    it("reports a known type mismatch naming the edge", async () => {
      const project = makeContractProject({ flag: "boolean" });
      project.prompts.p = makePrompt("p", { label: { type: "string" } });
      project.edges.feed = edge("feed", "input", "p", { label: "flag" });
      project.edges.e2 = edge("e2", "p", "output", { text: "text" });
      const result = await validateProject(project);
      expect(result.valid).toBe(false);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].edgeId).toBe("feed");
      expect(result.errors[0].message).toContain("Type mismatch");
      expect(result.errors[0].message).toContain("'flag' (boolean)");
      expect(result.errors[0].message).toContain("'label' (string)");
    });

    const typeCases: [string, string, boolean][] = [
      ["integer", "number", true],
      ["number", "integer", false],
      ["object", "string", true],
      ["array", "string", true],
      ["string", "number", false],
      ["boolean", "string", false],
    ];
    for (const [source, target, ok] of typeCases) {
      it(`${ok ? "accepts" : "rejects"} ${source} -> ${target} end to end`, async () => {
        const project = makeContractProject({ v: source });
        project.prompts.p = makePrompt("p", { v: { type: target } });
        project.edges.e1 = edge("e1", "input", "p", { v: "v" });
        project.edges.e2 = edge("e2", "p", "output", { text: "text" });
        const result = await validateProject(project);
        expect(result.valid).toBe(ok);
      });
    }

    it("warns about a declared type it does not check", async () => {
      const project = makeContractProject({ when: "date" });
      project.prompts.p = makePrompt("p", { when: { type: "string" } });
      project.edges.e1 = edge("e1", "input", "p", { when: "when" });
      project.edges.e2 = edge("e2", "p", "output", { text: "text" });
      const result = await validateProject(project);
      expect(result.errors).toEqual([]);
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings[0].message).toContain("type 'date' of 'when' in 'input' is not checked");
      expect(result.valid).toBe(true);
      expect((await validateProject(project, { strict: true })).valid).toBe(false);
    });

    it("reports a required input that no edge maps", async () => {
      const project = makeContractProject({ text: "string" });
      project.prompts.p = makePrompt("p", {
        text: { type: "string" },
        tone: { type: "string" },
        style: { type: "string", default: "plain" },
        note: { type: "string", required: false },
      });
      project.edges.e1 = edge("e1", "input", "p", { text: "text" });
      project.edges.e2 = edge("e2", "p", "output", { text: "text" });
      const result = await validateProject(project);
      expect(result.valid).toBe(false);
      expect(result.errors).toEqual([
        {
          message: "Node 'p' (prompt): required input 'tone' has no default and no incoming edge maps it",
          nodeId: "p",
        },
      ]);
    });

    it("counts a mapping on a conditional edge as supplying a required input", async () => {
      const project = makeContractProject({ text: "string" });
      project.prompts.classify = makePrompt(
        "classify",
        { text: { type: "string" } },
        { sentiment: "string", text: "string" }
      );
      project.prompts.positive = makePrompt("positive", { text: { type: "string" } });
      project.prompts.negative = makePrompt("negative", { text: { type: "string" } });
      project.edges.e1 = edge("e1", "input", "classify", { text: "text" });
      project.edges.pos = edge("pos", "classify", "positive", { text: "text" }, "sentiment == 'positive'");
      project.edges.neg = edge("neg", "classify", "negative", { text: "text" }, "sentiment == 'negative'");
      project.edges.pos_out = edge("pos_out", "positive", "output", { reply: "text" });
      project.edges.neg_out = edge("neg_out", "negative", "output", { reply: "text" });
      const result = await validateProject(project, { strict: true });
      expect(result.errors).toEqual([]);
      expect(result.valid).toBe(true);
    });
  });

  describe("agent and undeclared JSON outputs", () => {
    function makeAgent(id: string, promptNode: PromptNode): AgentNode {
      return {
        id,
        promptPath: `prompts/${id}.prompt`,
        model: null,
        allowedTools: [],
        mcpServers: {},
        maxTurns: 1,
        permissionMode: null,
        effort: null,
        cwd: null,
        executionMode: "cli",
        timeout: null,
        promptNode,
      };
    }

    /** input -> writer (agent) -> review (prompt needing `draft`) -> output */
    function makeAgentReviewProject(
      writerPrompt: PromptNode,
      draftSource: string
    ): Project {
      const project = makeContractProject({ topic: "string" });
      project.agents.writer = makeAgent("writer", writerPrompt);
      project.prompts.review = makePrompt("review", { draft: { type: "string" } });
      project.edges.e1 = edge("e1", "input", "writer", { topic: "topic" });
      project.edges.e2 = edge("e2", "writer", "review", { draft: draftSource });
      project.edges.e3 = edge("e3", "review", "output", { text: "text" });
      return project;
    }

    it("rejects `text` from a JSON agent, which outputs only its declared fields", async () => {
      const writer = makePrompt("writer", { topic: { type: "string" } }, { summary: "string" });
      const project = makeAgentReviewProject(writer, "text");
      const result = await validateProject(project, { strict: true });
      expect(result.valid).toBe(false);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toMatchObject({ edgeId: "e2", nodeId: "writer" });
      expect(result.errors[0].message).toContain(
        `source field 'text' does not exist in 'writer' (agent) output. Available fields: ["summary"]`
      );
    });

    it("accepts a declared field from a JSON agent", async () => {
      const writer = makePrompt("writer", { topic: { type: "string" } }, { summary: "string" });
      const result = await validateProject(makeAgentReviewProject(writer, "summary"), { strict: true });
      expect(result.errors).toEqual([]);
      expect(result.valid).toBe(true);
    });

    it("accepts `text` from a text agent and rejects any other field", async () => {
      const writer = makePrompt("writer", { topic: { type: "string" } });
      expect(writer.output.format).toBe("text");
      expect((await validateProject(makeAgentReviewProject(writer, "text"), { strict: true })).valid).toBe(true);
      const bad = await validateProject(makeAgentReviewProject(writer, "summary"));
      expect(bad.valid).toBe(false);
      expect(bad.errors[0].message).toContain(`Available fields: ["text"]`);
    });

    it("still offers `text` from a JSON prompt, which returns the raw response too", async () => {
      const project = makeContractProject({ topic: "string" });
      project.prompts.writer = makePrompt("writer", { topic: { type: "string" } }, { summary: "string" });
      project.prompts.review = makePrompt("review", { draft: { type: "string" } });
      project.edges.e1 = edge("e1", "input", "writer", { topic: "topic" });
      project.edges.e2 = edge("e2", "writer", "review", { draft: "text" });
      project.edges.e3 = edge("e3", "review", "output", { text: "text" });
      const result = await validateProject(project, { strict: true });
      expect(result.errors).toEqual([]);
      expect(result.valid).toBe(true);
    });

    it("does not check fields from a JSON agent or prompt that declares no output fields", async () => {
      const writer = makePrompt("writer", { topic: { type: "string" } });
      writer.output.format = "json";
      const agentResult = await validateProject(makeAgentReviewProject(writer, "anything"), { strict: true });
      expect(agentResult.errors).toEqual([]);
      expect(agentResult.valid).toBe(true);

      const project = makeContractProject({ topic: "string" });
      project.prompts.writer = writer;
      project.prompts.review = makePrompt("review", { draft: { type: "string" } });
      project.edges.e1 = edge("e1", "input", "writer", { topic: "topic" });
      project.edges.e2 = edge("e2", "writer", "review", { draft: "anything" });
      project.edges.e3 = edge("e3", "review", "output", { text: "text" });
      const promptResult = await validateProject(project, { strict: true });
      expect(promptResult.errors).toEqual([]);
      expect(promptResult.valid).toBe(true);
    });

    it("reports JSON agent field types without a `text` entry", () => {
      const project = makeContractProject();
      project.agents.writer = makeAgent(
        "writer",
        makePrompt("writer", {}, { summary: "string", count: "integer" })
      );
      expect(getNodeOutputFields(project, "writer", "agent")).toEqual(new Set(["summary", "count"]));
      expect(getNodeOutputTypes(project, "writer", "agent")).toEqual({
        summary: "string",
        count: "integer",
      });
    });
  });

  describe("disconnected components", () => {
    function makeDisconnectedProject(): Project {
      const project = makeContractProject({ text: "string" });
      project.prompts.p = makePrompt("p", { text: { type: "string" } });
      project.prompts.orphan = makePrompt("orphan");
      project.outputNodes.orphan_out = { id: "orphan_out", format: "json" };
      project.edges.e1 = edge("e1", "input", "p", { text: "text" });
      project.edges.e2 = edge("e2", "p", "output", { text: "text" });
      project.edges.e3 = edge("e3", "orphan", "orphan_out", { text: "text" });
      return project;
    }

    it("warns about a component with no input node or entrypoint, and passes", async () => {
      const result = await validateProject(makeDisconnectedProject());
      expect(result.errors).toEqual([]);
      expect(result.warnings).toEqual([
        {
          message:
            'Nodes ["orphan","orphan_out"] are not connected to any input node ' +
            "or entrypoint, so no run input reaches them",
          nodeId: "orphan",
        },
      ]);
      expect(result.valid).toBe(true);
    });

    it("fails the same project in strict mode", async () => {
      const result = await validateProject(makeDisconnectedProject(), { strict: true });
      expect(result.valid).toBe(false);
      expect(result.errors).toEqual([]);
      expect(result.warnings).toHaveLength(1);
    });

    it("accepts the component when it holds a declared entrypoint", async () => {
      const project = makeDisconnectedProject();
      project.entrypoints = ["input", "orphan"];
      const result = await validateProject(project, { strict: true });
      expect(result.valid).toBe(true);
    });
  });
});
