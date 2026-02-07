/**
 * Tests for map node validation and behavior.
 *
 * Map nodes fan out over a collection, executing a sub-workflow
 * for each item in parallel with optional concurrency limits.
 */

import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { loadProject } from "../src/project.js";
import { buildDag } from "../src/dag.js";
import { run } from "../src/executor.js";
import { ValidationError } from "../src/errors.js";
import type { Project, Edge } from "../src/project.js";

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "harpoon-map-test-"));
}

function cleanupDir(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

function makeProjectWithMap(overrides?: Record<string, unknown>): Project {
  return {
    name: "test",
    root: ".",
    version: "1.0",
    description: "",
    defaults: {},
    entrypoints: ["input"],
    edges: {
      e1: {
        id: "e1",
        fromNode: "input",
        toNode: "map1",
        mappings: [{ targetVar: "items", sourceExpr: "items" }],
      },
      e2: {
        id: "e2",
        fromNode: "map1",
        toNode: "output",
        mappings: [],
      },
    },
    prompts: {},
    inputNodes: { input: { id: "input", schema: {} } },
    outputNodes: { output: { id: "output", format: "json" } },
    tools: {},
    agents: {},
    branches: {},
    maps: {
      map1: {
        id: "map1",
        workflowPath: "./sub",
        over: "items",
        maxConcurrency: 0,
        onError: "fail",
        itemCondition: null,
        ...overrides,
      },
    },
    triggers: {},
    env: {},
  };
}

describe("map node project loading", () => {
  let tmpdir: string;

  afterEach(() => {
    if (tmpdir) cleanupDir(tmpdir);
  });

  it("parses map node from manifest", () => {
    tmpdir = makeTmpDir();
    fs.writeFileSync(
      path.join(tmpdir, "agent.tml"),
      `harpoon: "1.0"
name: test
nodes:
  processor:
    type: map
    workflow: ./sub_workflow
    over: documents
    max_concurrency: 3
    on_error: skip
    item_condition: "item.length > 0"
`
    );

    const project = loadProject(tmpdir);
    expect(project.maps).toHaveProperty("processor");
    expect(project.maps.processor.over).toBe("documents");
    expect(project.maps.processor.maxConcurrency).toBe(3);
    expect(project.maps.processor.onError).toBe("skip");
    expect(project.maps.processor.itemCondition).toBe("item.length > 0");
  });

  it("defaults max_concurrency to 0 (unlimited)", () => {
    tmpdir = makeTmpDir();
    fs.writeFileSync(
      path.join(tmpdir, "agent.tml"),
      `harpoon: "1.0"
name: test
nodes:
  mapper:
    type: map
    workflow: ./sub
    over: items
`
    );

    const project = loadProject(tmpdir);
    expect(project.maps.mapper.maxConcurrency).toBe(0);
  });

  it("defaults on_error to fail", () => {
    tmpdir = makeTmpDir();
    fs.writeFileSync(
      path.join(tmpdir, "agent.tml"),
      `harpoon: "1.0"
name: test
nodes:
  mapper:
    type: map
    workflow: ./sub
    over: items
`
    );

    const project = loadProject(tmpdir);
    expect(project.maps.mapper.onError).toBe("fail");
  });

  it("rejects invalid on_error value", () => {
    tmpdir = makeTmpDir();
    fs.writeFileSync(
      path.join(tmpdir, "agent.tml"),
      `harpoon: "1.0"
name: test
nodes:
  mapper:
    type: map
    workflow: ./sub
    over: items
    on_error: abort
`
    );

    expect(() => loadProject(tmpdir)).toThrow(ValidationError);
  });

  it("accepts all valid on_error values", () => {
    for (const onError of ["fail", "skip", "collect"]) {
      tmpdir = makeTmpDir();
      fs.writeFileSync(
        path.join(tmpdir, "agent.tml"),
        `harpoon: "1.0"
name: test
nodes:
  mapper:
    type: map
    workflow: ./sub
    over: items
    on_error: ${onError}
`
      );

      const project = loadProject(tmpdir);
      expect(project.maps.mapper.onError).toBe(onError);
      cleanupDir(tmpdir);
    }
    // Prevent afterEach from trying to clean nonexistent dir
    tmpdir = makeTmpDir();
  });

  it("requires workflow field", () => {
    tmpdir = makeTmpDir();
    fs.writeFileSync(
      path.join(tmpdir, "agent.tml"),
      `harpoon: "1.0"
name: test
nodes:
  mapper:
    type: map
    over: items
`
    );

    expect(() => loadProject(tmpdir)).toThrow(ValidationError);
  });

  it("requires over field", () => {
    tmpdir = makeTmpDir();
    fs.writeFileSync(
      path.join(tmpdir, "agent.tml"),
      `harpoon: "1.0"
name: test
nodes:
  mapper:
    type: map
    workflow: ./sub
`
    );

    expect(() => loadProject(tmpdir)).toThrow(ValidationError);
  });
});

describe("map node in DAG", () => {
  it("includes map node in execution order", () => {
    const project = makeProjectWithMap();
    const dag = buildDag(project);

    expect(dag.executionOrder).toContain("map1");
  });

  it("respects edge ordering for map nodes", () => {
    const project = makeProjectWithMap();
    const dag = buildDag(project);

    const inputIdx = dag.executionOrder.indexOf("input");
    const mapIdx = dag.executionOrder.indexOf("map1");
    const outputIdx = dag.executionOrder.indexOf("output");

    expect(inputIdx).toBeLessThan(mapIdx);
    expect(mapIdx).toBeLessThan(outputIdx);
  });

  it("map node has correct type in DAG", () => {
    const project = makeProjectWithMap();
    const dag = buildDag(project);

    expect(dag.nodes.map1.type).toBe("map");
  });
});

describe("map node dry run execution", () => {
  it("dry run produces mock output with items", async () => {
    // Create a project with a map node that has a sub-workflow
    const tmpdir = makeTmpDir();

    // Create sub-workflow
    const subDir = path.join(tmpdir, "sub");
    fs.mkdirSync(subDir);
    fs.writeFileSync(
      path.join(subDir, "agent.tml"),
      `harpoon: "1.0"
name: sub-workflow
nodes:
  input:
    type: input
  output:
    type: output
edges:
  e1:
    from: input
    to: output
`
    );

    const project: Project = {
      name: "test",
      root: tmpdir,
      version: "1.0",
      description: "",
      defaults: {},
      entrypoints: ["input"],
      edges: {
        e1: {
          id: "e1",
          fromNode: "input",
          toNode: "map1",
          mappings: [{ targetVar: "items", sourceExpr: "items" }],
        },
        e2: {
          id: "e2",
          fromNode: "map1",
          toNode: "output",
          mappings: [],
        },
      },
      prompts: {},
      inputNodes: { input: { id: "input", schema: {} } },
      outputNodes: { output: { id: "output", format: "json" } },
      tools: {},
      agents: {},
      branches: {},
      maps: {
        map1: {
          id: "map1",
          workflowPath: "./sub",
          over: "items",
          maxConcurrency: 0,
          onError: "fail",
          itemCondition: null,
        },
      },
      triggers: {},
      env: {},
    };

    const result = await run(project, {
      dryRun: true,
      inputs: { items: ["a", "b", "c"] },
    });

    expect(result.success).toBe(true);

    // Find map node trace
    const mapTrace = result.trace.nodes.find((n) => n.id === "map1");
    expect(mapTrace).toBeDefined();
    expect(mapTrace!.output).toHaveProperty("items");
    expect(mapTrace!.output).toHaveProperty("count");
    expect(mapTrace!.output.count).toBe(3);

    cleanupDir(tmpdir);
  });
});
