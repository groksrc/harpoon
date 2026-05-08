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
import type { PromptNode, InputField, BranchNode } from "../src/parser.js";
import { DAGError } from "../src/errors.js";

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

  it("integer and number are compatible both ways", () => {
    expect(typesCompatible("integer", "number")).toBe(true);
    expect(typesCompatible("number", "integer")).toBe(true);
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

  it("branch output types", () => {
    const project = makeProject([], []);
    const types = getNodeOutputTypes(project, "b1", "branch");
    expect(types).toEqual({ output: null, text: "string" });
  });

  it("map output types", () => {
    const project = makeProject([], []);
    const types = getNodeOutputTypes(project, "m1", "map");
    expect(types).toEqual({ items: "array", count: "number" });
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

  it("incompatible types produce a warning", () => {
    const project = makeProjectWithEdge("string", "number");
    const dag = buildDag(project);
    const result = validateEdgeMappings(project, dag);

    const typeWarnings = result.warnings.filter((w) =>
      w.message.includes("Type mismatch")
    );
    expect(typeWarnings).toHaveLength(1);
    expect(typeWarnings[0].message).toContain("string");
    expect(typeWarnings[0].message).toContain("number");
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
});
