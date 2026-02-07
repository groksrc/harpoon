/**
 * Tests for prompt-first project loading.
 *
 * When no manifest (agent.tml) exists, Harpoon builds a project
 * from .prompt files with entrypoint, next, and loop declarations.
 */

import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { loadProject } from "../src/project.js";
import { ParseError, ValidationError } from "../src/errors.js";

const PROMPT_FIRST_FIXTURES = path.resolve(
  __dirname,
  "fixtures",
  "prompt-first"
);

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "harpoon-pf-test-"));
}

function cleanupDir(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

function writePromptFile(
  dir: string,
  filename: string,
  frontmatter: string,
  body: string
): void {
  const promptsDir = path.join(dir, "prompts");
  fs.mkdirSync(promptsDir, { recursive: true });
  fs.writeFileSync(
    path.join(promptsDir, filename),
    `---\n${frontmatter}\n---\n${body}\n`
  );
}

describe("prompt-first loading", () => {
  let tmpdir: string;

  afterEach(() => {
    if (tmpdir) cleanupDir(tmpdir);
  });

  it("loads project from fixture directory", () => {
    const project = loadProject(PROMPT_FIRST_FIXTURES);

    // Should discover both prompts
    expect(project.prompts).toHaveProperty("classify");
    expect(project.prompts).toHaveProperty("respond");

    // Should set project name from directory
    expect(project.name).toBe("prompt-first");
  });

  it("detects entrypoint from prompt frontmatter", () => {
    const project = loadProject(PROMPT_FIRST_FIXTURES);

    // classify has entrypoint: true
    expect(project.prompts.classify.entrypoint).toBe(true);
    expect(project.prompts.respond.entrypoint).toBe(false);
  });

  it("creates input node from entrypoint inputs", () => {
    const project = loadProject(PROMPT_FIRST_FIXTURES);

    // classify has input fields, so an input node should be created
    expect(project.inputNodes).toHaveProperty("input");
    expect(project.inputNodes.input.schema).toHaveProperty("message");
  });

  it("builds edges from next declarations", () => {
    const project = loadProject(PROMPT_FIRST_FIXTURES);

    // Should have edge from classify -> respond (from next field)
    const edgeValues = Object.values(project.edges);
    const classifyToRespond = edgeValues.find(
      (e) => e.fromNode === "classify" && e.toNode === "respond"
    );
    expect(classifyToRespond).toBeDefined();
  });

  it("auto-maps matching fields between prompts", () => {
    const project = loadProject(PROMPT_FIRST_FIXTURES);

    // classify outputs intent+confidence, respond inputs intent+confidence
    const edgeValues = Object.values(project.edges);
    const classifyToRespond = edgeValues.find(
      (e) => e.fromNode === "classify" && e.toNode === "respond"
    );
    expect(classifyToRespond).toBeDefined();

    const mappedTargets = classifyToRespond!.mappings.map((m) => m.targetVar);
    expect(mappedTargets).toContain("intent");
    expect(mappedTargets).toContain("confidence");
  });

  it("creates output node for terminal prompts", () => {
    const project = loadProject(PROMPT_FIRST_FIXTURES);

    // respond has no next, so it's terminal -> output node created
    expect(project.outputNodes).toHaveProperty("output");

    // Edge from respond -> output should exist
    const edgeValues = Object.values(project.edges);
    const respondToOutput = edgeValues.find(
      (e) => e.fromNode === "respond" && e.toNode === "output"
    );
    expect(respondToOutput).toBeDefined();
  });

  it("creates input-to-entrypoint edge", () => {
    const project = loadProject(PROMPT_FIRST_FIXTURES);

    const edgeValues = Object.values(project.edges);
    const inputToClassify = edgeValues.find(
      (e) => e.fromNode === "input" && e.toNode === "classify"
    );
    expect(inputToClassify).toBeDefined();

    // Input mapping should map the message field
    const mappedTargets = inputToClassify!.mappings.map((m) => m.targetVar);
    expect(mappedTargets).toContain("message");
  });

  it("throws ParseError when no prompts found", () => {
    tmpdir = makeTmpDir();
    // No prompts/ directory and no manifest
    fs.mkdirSync(path.join(tmpdir, "prompts"), { recursive: true });
    // Empty prompts dir - ParseError for no prompt files
    expect(() => loadProject(tmpdir)).toThrow(ParseError);
  });

  it("throws ValidationError when no entrypoint defined", () => {
    tmpdir = makeTmpDir();
    writePromptFile(
      tmpdir,
      "step.prompt",
      'id: step\nharpoon: "1.0"',
      "Do something."
    );

    expect(() => loadProject(tmpdir)).toThrow(ValidationError);
  });

  it("throws ValidationError for multiple entrypoints", () => {
    tmpdir = makeTmpDir();
    writePromptFile(
      tmpdir,
      "a.prompt",
      'id: a\nharpoon: "1.0"\nentrypoint: true',
      "Step A."
    );
    writePromptFile(
      tmpdir,
      "b.prompt",
      'id: b\nharpoon: "1.0"\nentrypoint: true',
      "Step B."
    );

    expect(() => loadProject(tmpdir)).toThrow(ValidationError);
  });

  it("single-prompt project with no next", () => {
    tmpdir = makeTmpDir();
    writePromptFile(
      tmpdir,
      "solo.prompt",
      'id: solo\nharpoon: "1.0"\nentrypoint: true\ninput:\n  query:\n    type: string\n    required: true',
      "Answer: {{query}}"
    );

    const project = loadProject(tmpdir);
    expect(project.prompts).toHaveProperty("solo");
    expect(project.entrypoints.length).toBeGreaterThan(0);

    // Terminal prompt should get an output edge
    const edgeValues = Object.values(project.edges);
    const toOutput = edgeValues.find((e) => e.toNode === "output");
    expect(toOutput).toBeDefined();
  });

  it("converts prompt tools to project tools", () => {
    tmpdir = makeTmpDir();
    writePromptFile(
      tmpdir,
      "with-tools.prompt",
      `id: with_tools
harpoon: "1.0"
entrypoint: true
tools:
  fetch_data:
    type: typescript
    module: tools
    function: getData
    description: Fetches data from API`,
      "Use fetch_data to get data."
    );

    const project = loadProject(tmpdir);
    expect(project.tools).toHaveProperty("fetch_data");
    expect(project.tools.fetch_data.type).toBe("typescript");
    expect(project.tools.fetch_data.description).toBe(
      "Fetches data from API"
    );
  });
});

describe("prompt-first with conditional next", () => {
  let tmpdir: string;

  afterEach(() => {
    if (tmpdir) cleanupDir(tmpdir);
  });

  it("builds conditional edges from array next", () => {
    tmpdir = makeTmpDir();
    writePromptFile(
      tmpdir,
      "router.prompt",
      `id: router
harpoon: "1.0"
entrypoint: true
output:
  format: json
  schema:
    status:
      type: string
      description: Result status
next:
  - prompt: prompts/success.prompt
    condition: "status == 'ok'"
  - prompt: prompts/fallback.prompt`,
      "Route based on status."
    );
    writePromptFile(
      tmpdir,
      "success.prompt",
      'id: success\nharpoon: "1.0"',
      "Success path."
    );
    writePromptFile(
      tmpdir,
      "fallback.prompt",
      'id: fallback\nharpoon: "1.0"',
      "Fallback path."
    );

    const project = loadProject(tmpdir);
    const edgeValues = Object.values(project.edges);

    const toSuccess = edgeValues.find(
      (e) => e.fromNode === "router" && e.toNode === "success"
    );
    expect(toSuccess).toBeDefined();
    expect(toSuccess!.condition).toBe("status == 'ok'");

    const toFallback = edgeValues.find(
      (e) => e.fromNode === "router" && e.toNode === "fallback"
    );
    expect(toFallback).toBeDefined();
    expect(toFallback!.condition).toBeNull();
  });
});

describe("prompt-first with loop", () => {
  let tmpdir: string;

  afterEach(() => {
    if (tmpdir) cleanupDir(tmpdir);
  });

  it("transforms loop prompts into branch nodes", () => {
    tmpdir = makeTmpDir();
    writePromptFile(
      tmpdir,
      "refine.prompt",
      `id: refine
harpoon: "1.0"
entrypoint: true
input:
  text:
    type: string
    required: true
output:
  format: json
  schema:
    quality_score:
      type: number
      description: Quality score
loop:
  while: "quality_score < 8"
  max_iterations: 5`,
      "Refine: {{text}}"
    );

    const project = loadProject(tmpdir);

    // A branch node should be created for the loop
    expect(Object.keys(project.branches).length).toBeGreaterThan(0);

    const branchKey = Object.keys(project.branches)[0];
    const branch = project.branches[branchKey];
    expect(branch.loopWhile).toBe("quality_score < 8");
    expect(branch.maxIterations).toBe(5);
    expect(branch.workflowPath).toBe("self");
  });
});

describe("augmented mode", () => {
  let tmpdir: string;

  afterEach(() => {
    if (tmpdir) cleanupDir(tmpdir);
  });

  it("merges prompt next into manifest edges", () => {
    tmpdir = makeTmpDir();

    // Write manifest
    fs.writeFileSync(
      path.join(tmpdir, "agent.tml"),
      `harpoon: "1.0"
name: augmented-test
edges:
  e1:
    from: input
    to: step1
`
    );

    // Write prompts with next declarations
    fs.mkdirSync(path.join(tmpdir, "prompts"));
    fs.writeFileSync(
      path.join(tmpdir, "prompts", "step1.prompt"),
      `---
id: step1
harpoon: "1.0"
next: prompts/step2.prompt
---
Step 1.
`
    );
    fs.writeFileSync(
      path.join(tmpdir, "prompts", "step2.prompt"),
      `---
id: step2
harpoon: "1.0"
---
Step 2.
`
    );

    const project = loadProject(tmpdir);

    // Should have edge from step1 -> step2 from prompt frontmatter
    const edgeValues = Object.values(project.edges);
    const step1ToStep2 = edgeValues.find(
      (e) => e.fromNode === "step1" && e.toNode === "step2"
    );
    expect(step1ToStep2).toBeDefined();
  });
});
