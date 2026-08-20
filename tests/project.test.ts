/**
 * Tests for project loading (project.ts).
 */

import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { loadProject, loadDotenv } from "../src/project.js";
import { ParseError, ValidationError } from "../src/errors.js";

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "harpoon-test-"));
}

function cleanupDir(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

describe("loadProject", () => {
  let tmpdir: string;

  afterEach(() => {
    if (tmpdir) cleanupDir(tmpdir);
  });

  it("loads a minimal manifest-based project", () => {
    tmpdir = makeTmpDir();
    fs.writeFileSync(
      path.join(tmpdir, "agent.tml"),
      `harpoon: "1.0"\nname: test-project\n`
    );
    fs.mkdirSync(path.join(tmpdir, "prompts"));
    fs.writeFileSync(
      path.join(tmpdir, "prompts", "hello.prompt"),
      `---\nid: hello\nharpoon: "1.0"\n---\nHello!\n`
    );

    const project = loadProject(tmpdir);
    expect(project.name).toBe("test-project");
    expect(project.prompts).toHaveProperty("hello");
  });

  it("loads edges with mappings and conditions", () => {
    tmpdir = makeTmpDir();
    fs.writeFileSync(
      path.join(tmpdir, "agent.tml"),
      `harpoon: "1.0"
name: test
edges:
  e1:
    from: input
    to: process
    mapping:
      data: text
    condition: "x > 0"
`
    );
    fs.mkdirSync(path.join(tmpdir, "prompts"));
    fs.writeFileSync(
      path.join(tmpdir, "prompts", "process.prompt"),
      `---\nid: process\nharpoon: "1.0"\n---\nProcess {{data}}\n`
    );

    const project = loadProject(tmpdir);
    expect(project.edges).toHaveProperty("e1");
    expect(project.edges.e1.fromNode).toBe("input");
    expect(project.edges.e1.toNode).toBe("process");
    expect(project.edges.e1.condition).toBe("x > 0");
    expect(project.edges.e1.mappings).toHaveLength(1);
    expect(project.edges.e1.mappings[0].targetVar).toBe("data");
    expect(project.edges.e1.mappings[0].sourceExpr).toBe("text");
  });

  it("discovers agent.tml before harpoon.tml", () => {
    tmpdir = makeTmpDir();
    fs.writeFileSync(
      path.join(tmpdir, "agent.tml"),
      `harpoon: "1.0"\nname: from-agent\n`
    );
    fs.writeFileSync(
      path.join(tmpdir, "harpoon.tml"),
      `harpoon: "1.0"\nname: from-harpoon\n`
    );

    const project = loadProject(tmpdir);
    expect(project.name).toBe("from-agent");
  });

  it("falls back to harpoon.tml when no agent.tml", () => {
    tmpdir = makeTmpDir();
    fs.writeFileSync(
      path.join(tmpdir, "harpoon.tml"),
      `harpoon: "1.0"\nname: from-harpoon\n`
    );

    const project = loadProject(tmpdir);
    expect(project.name).toBe("from-harpoon");
  });

  it("throws ValidationError when missing version in manifest", () => {
    tmpdir = makeTmpDir();
    fs.writeFileSync(path.join(tmpdir, "agent.tml"), `name: no-version\n`);

    expect(() => loadProject(tmpdir)).toThrow(ValidationError);
  });

  it("throws ValidationError when missing name in manifest", () => {
    tmpdir = makeTmpDir();
    fs.writeFileSync(path.join(tmpdir, "agent.tml"), `harpoon: "1.0"\n`);

    expect(() => loadProject(tmpdir)).toThrow(ValidationError);
  });

  describe("node types", () => {
    it("parses input nodes with schema", () => {
      tmpdir = makeTmpDir();
      fs.writeFileSync(
        path.join(tmpdir, "agent.tml"),
        `harpoon: "1.0"
name: test-nodes
nodes:
  input:
    type: input
    schema:
      query:
        type: string
        description: Search query
`
      );

      const project = loadProject(tmpdir);
      expect(project.inputNodes).toHaveProperty("input");
      expect(project.inputNodes.input.schema.query).toEqual([
        "string",
        "Search query",
      ]);
    });

    it("parses output nodes", () => {
      tmpdir = makeTmpDir();
      fs.writeFileSync(
        path.join(tmpdir, "agent.tml"),
        `harpoon: "1.0"
name: test
nodes:
  output:
    type: output
    format: json
`
      );

      const project = loadProject(tmpdir);
      expect(project.outputNodes).toHaveProperty("output");
      expect(project.outputNodes.output.format).toBe("json");
    });

    it("parses agent nodes", () => {
      tmpdir = makeTmpDir();
      fs.writeFileSync(
        path.join(tmpdir, "agent.tml"),
        `harpoon: "1.0"
name: test-agents
nodes:
  tester:
    type: agent
    prompt: prompts/tester.prompt
    allowed_tools:
      - Read
      - Glob
    mcp_servers:
      playwright:
        command: npx
        args:
          - "@playwright/mcp@latest"
    max_turns: 25
`
      );
      fs.mkdirSync(path.join(tmpdir, "prompts"));
      fs.writeFileSync(
        path.join(tmpdir, "prompts", "tester.prompt"),
        `---
id: tester
harpoon: "1.0"
output:
  format: json
  schema:
    status:
      type: string
      description: Test status
---
Test the app.
`
      );

      const project = loadProject(tmpdir);
      expect(project.agents).toHaveProperty("tester");
      const agent = project.agents.tester;
      expect(agent.allowedTools).toEqual(["Read", "Glob"]);
      expect(agent.maxTurns).toBe(25);
      expect(agent.mcpServers).toHaveProperty("playwright");
      expect(agent.mcpServers.playwright.command).toBe("npx");
    });

    it("agent defaults timeout to 1200", () => {
      tmpdir = makeTmpDir();
      fs.writeFileSync(
        path.join(tmpdir, "agent.tml"),
        `harpoon: "1.0"
name: test
nodes:
  worker:
    type: agent
    prompt: prompts/worker.prompt
`
      );
      fs.mkdirSync(path.join(tmpdir, "prompts"));
      fs.writeFileSync(
        path.join(tmpdir, "prompts", "worker.prompt"),
        `---\nid: worker\nharpoon: "1.0"\n---\nDo the work.\n`
      );

      const project = loadProject(tmpdir);
      expect(project.agents.worker.timeout).toBe(1200);
    });

    it("agent allowed_tools wildcard means null", () => {
      tmpdir = makeTmpDir();
      fs.writeFileSync(
        path.join(tmpdir, "agent.tml"),
        `harpoon: "1.0"
name: test
nodes:
  worker:
    type: agent
    prompt: prompts/worker.prompt
    allowed_tools: "*"
`
      );
      fs.mkdirSync(path.join(tmpdir, "prompts"));
      fs.writeFileSync(
        path.join(tmpdir, "prompts", "worker.prompt"),
        `---\nid: worker\nharpoon: "1.0"\n---\nDo the work.\n`
      );

      const project = loadProject(tmpdir);
      expect(project.agents.worker.allowedTools).toBeNull();
    });

    it("agent max_turns wildcard means null (unlimited)", () => {
      tmpdir = makeTmpDir();
      fs.writeFileSync(
        path.join(tmpdir, "agent.tml"),
        `harpoon: "1.0"
name: test
nodes:
  worker:
    type: agent
    prompt: prompts/worker.prompt
    max_turns: "*"
`
      );
      fs.mkdirSync(path.join(tmpdir, "prompts"));
      fs.writeFileSync(
        path.join(tmpdir, "prompts", "worker.prompt"),
        `---\nid: worker\nharpoon: "1.0"\n---\nDo the work.\n`
      );

      const project = loadProject(tmpdir);
      expect(project.agents.worker.maxTurns).toBeNull();
    });

    it("agent effort: manifest value wins", () => {
      tmpdir = makeTmpDir();
      fs.writeFileSync(
        path.join(tmpdir, "agent.tml"),
        `harpoon: "1.0"
name: test
nodes:
  worker:
    type: agent
    prompt: prompts/worker.prompt
    effort: high
`
      );
      fs.mkdirSync(path.join(tmpdir, "prompts"));
      fs.writeFileSync(
        path.join(tmpdir, "prompts", "worker.prompt"),
        `---\nid: worker\nharpoon: "1.0"\neffort: low\n---\nDo the work.\n`
      );

      const project = loadProject(tmpdir);
      expect(project.agents.worker.effort).toBe("high");
    });

    it("agent effort: falls back to prompt frontmatter", () => {
      tmpdir = makeTmpDir();
      fs.writeFileSync(
        path.join(tmpdir, "agent.tml"),
        `harpoon: "1.0"
name: test
nodes:
  worker:
    type: agent
    prompt: prompts/worker.prompt
`
      );
      fs.mkdirSync(path.join(tmpdir, "prompts"));
      fs.writeFileSync(
        path.join(tmpdir, "prompts", "worker.prompt"),
        `---\nid: worker\nharpoon: "1.0"\neffort: medium\n---\nDo the work.\n`
      );

      const project = loadProject(tmpdir);
      expect(project.agents.worker.effort).toBe("medium");
    });

    it("agent effort: defaults to null when unset", () => {
      tmpdir = makeTmpDir();
      fs.writeFileSync(
        path.join(tmpdir, "agent.tml"),
        `harpoon: "1.0"
name: test
nodes:
  worker:
    type: agent
    prompt: prompts/worker.prompt
`
      );
      fs.mkdirSync(path.join(tmpdir, "prompts"));
      fs.writeFileSync(
        path.join(tmpdir, "prompts", "worker.prompt"),
        `---\nid: worker\nharpoon: "1.0"\n---\nDo the work.\n`
      );

      const project = loadProject(tmpdir);
      expect(project.agents.worker.effort).toBeNull();
    });

    it("agent effort: rejects invalid value", () => {
      tmpdir = makeTmpDir();
      fs.writeFileSync(
        path.join(tmpdir, "agent.tml"),
        `harpoon: "1.0"
name: test
nodes:
  worker:
    type: agent
    prompt: prompts/worker.prompt
    effort: turbo
`
      );
      fs.mkdirSync(path.join(tmpdir, "prompts"));
      fs.writeFileSync(
        path.join(tmpdir, "prompts", "worker.prompt"),
        `---\nid: worker\nharpoon: "1.0"\n---\nDo the work.\n`
      );

      expect(() => loadProject(tmpdir)).toThrow(/invalid effort/);
    });

    it("parses branch nodes", () => {
      tmpdir = makeTmpDir();
      fs.writeFileSync(
        path.join(tmpdir, "agent.tml"),
        `harpoon: "1.0"
name: test
nodes:
  branch1:
    type: branch
    workflow: ./sub_workflow
    condition: "x > 0"
    loop_while: "count < 5"
    max_iterations: 3
`
      );

      const project = loadProject(tmpdir);
      expect(project.branches).toHaveProperty("branch1");
      expect(project.branches.branch1.workflowPath).toBe("./sub_workflow");
      expect(project.branches.branch1.condition).toBe("x > 0");
      expect(project.branches.branch1.loopWhile).toBe("count < 5");
      expect(project.branches.branch1.maxIterations).toBe(3);
    });

    it("parses map nodes", () => {
      tmpdir = makeTmpDir();
      fs.writeFileSync(
        path.join(tmpdir, "agent.tml"),
        `harpoon: "1.0"
name: test
nodes:
  map1:
    type: map
    workflow: ./sub_workflow
    over: items
    max_concurrency: 5
    on_error: skip
    item_condition: "item > 0"
`
      );

      const project = loadProject(tmpdir);
      expect(project.maps).toHaveProperty("map1");
      expect(project.maps.map1.over).toBe("items");
      expect(project.maps.map1.maxConcurrency).toBe(5);
      expect(project.maps.map1.onError).toBe("skip");
      expect(project.maps.map1.itemCondition).toBe("item > 0");
    });

    it("throws for map node with invalid on_error", () => {
      tmpdir = makeTmpDir();
      fs.writeFileSync(
        path.join(tmpdir, "agent.tml"),
        `harpoon: "1.0"
name: test
nodes:
  map1:
    type: map
    workflow: ./sub
    over: items
    on_error: invalid
`
      );

      expect(() => loadProject(tmpdir)).toThrow(ValidationError);
    });

    it("parses trigger nodes", () => {
      tmpdir = makeTmpDir();
      fs.writeFileSync(
        path.join(tmpdir, "agent.tml"),
        `harpoon: "1.0"
name: test
nodes:
  trigger1:
    type: trigger
    workflow: ./downstream
    pass_outputs: true
    emit_signal: true
    condition: "status == 'ok'"
`
      );

      const project = loadProject(tmpdir);
      expect(project.triggers).toHaveProperty("trigger1");
      expect(project.triggers.trigger1.passOutputs).toBe(true);
      expect(project.triggers.trigger1.emitSignal).toBe(true);
      expect(project.triggers.trigger1.condition).toBe("status == 'ok'");
    });

    it("throws for tool nodes in nodes section", () => {
      tmpdir = makeTmpDir();
      fs.writeFileSync(
        path.join(tmpdir, "agent.tml"),
        `harpoon: "1.0"
name: test
nodes:
  my_tool:
    type: tool
`
      );

      expect(() => loadProject(tmpdir)).toThrow(ValidationError);
    });
  });

  it("parses tools section", () => {
    tmpdir = makeTmpDir();
    fs.writeFileSync(
      path.join(tmpdir, "agent.tml"),
      `harpoon: "1.0"
name: test
tools:
  my_tool:
    type: typescript
    module: tools
    function: helper
    description: A helper tool
    output:
      schema:
        result:
          type: string
          description: Processed result
        warning:
          type: string
          description: Optional warning
          required: false
`
    );

    const project = loadProject(tmpdir);
    expect(project.tools).toHaveProperty("my_tool");
    expect(project.tools.my_tool.type).toBe("typescript");
    expect(project.tools.my_tool.description).toBe("A helper tool");
    expect(project.tools.my_tool.outputSchema).toEqual({
      result: {
        type: "string",
        description: "Processed result",
        required: true,
      },
      warning: {
        type: "string",
        description: "Optional warning",
        required: false,
      },
    });
  });

  it("rejects invalid tool output schemas", () => {
    tmpdir = makeTmpDir();
    fs.writeFileSync(
      path.join(tmpdir, "agent.tml"),
      `harpoon: "1.0"
name: test
tools:
  my_tool:
    type: typescript
    module: tools
    output:
      schema:
        result:
          type: mystery
`
    );

    expect(() => loadProject(tmpdir)).toThrow(/invalid type 'mystery'/);
  });
});

describe("loadDotenv", () => {
  const envVarsSet: string[] = [];

  afterEach(() => {
    for (const key of envVarsSet) {
      delete process.env[key];
    }
    envVarsSet.length = 0;
  });

  function trackEnv(key: string): void {
    envVarsSet.push(key);
  }

  it("loads KEY=VALUE pairs", () => {
    const tmpdir = makeTmpDir();
    fs.writeFileSync(path.join(tmpdir, ".env"), "TEST_HARPOON_KEY=test_value\n");
    trackEnv("TEST_HARPOON_KEY");

    loadDotenv(path.join(tmpdir, ".env"));
    expect(process.env.TEST_HARPOON_KEY).toBe("test_value");
    cleanupDir(tmpdir);
  });

  it("strips double quotes from values", () => {
    const tmpdir = makeTmpDir();
    fs.writeFileSync(
      path.join(tmpdir, ".env"),
      'TEST_HARPOON_DQ="value with spaces"\n'
    );
    trackEnv("TEST_HARPOON_DQ");

    loadDotenv(path.join(tmpdir, ".env"));
    expect(process.env.TEST_HARPOON_DQ).toBe("value with spaces");
    cleanupDir(tmpdir);
  });

  it("strips single quotes from values", () => {
    const tmpdir = makeTmpDir();
    fs.writeFileSync(
      path.join(tmpdir, ".env"),
      "TEST_HARPOON_SQ='quoted value'\n"
    );
    trackEnv("TEST_HARPOON_SQ");

    loadDotenv(path.join(tmpdir, ".env"));
    expect(process.env.TEST_HARPOON_SQ).toBe("quoted value");
    cleanupDir(tmpdir);
  });

  it("skips comments and empty lines", () => {
    const tmpdir = makeTmpDir();
    fs.writeFileSync(
      path.join(tmpdir, ".env"),
      "# Comment\n\nTEST_HARPOON_SKIP=value\n# Another\n"
    );
    trackEnv("TEST_HARPOON_SKIP");

    loadDotenv(path.join(tmpdir, ".env"));
    expect(process.env.TEST_HARPOON_SKIP).toBe("value");
    cleanupDir(tmpdir);
  });

  it("does not override existing env vars", () => {
    process.env.TEST_HARPOON_EXISTING = "original";
    trackEnv("TEST_HARPOON_EXISTING");

    const tmpdir = makeTmpDir();
    fs.writeFileSync(
      path.join(tmpdir, ".env"),
      "TEST_HARPOON_EXISTING=new_value\n"
    );

    loadDotenv(path.join(tmpdir, ".env"));
    expect(process.env.TEST_HARPOON_EXISTING).toBe("original");
    cleanupDir(tmpdir);
  });

  it("handles missing .env file gracefully", () => {
    const tmpdir = makeTmpDir();
    // No .env file created
    loadDotenv(path.join(tmpdir, ".env")); // Should not throw
    cleanupDir(tmpdir);
  });

  it("skips malformed lines", () => {
    const tmpdir = makeTmpDir();
    fs.writeFileSync(
      path.join(tmpdir, ".env"),
      "MALFORMED\nTEST_HARPOON_VALID=works\n"
    );
    trackEnv("TEST_HARPOON_VALID");

    loadDotenv(path.join(tmpdir, ".env"));
    expect(process.env.TEST_HARPOON_VALID).toBe("works");
    expect(process.env.MALFORMED).toBeUndefined();
    cleanupDir(tmpdir);
  });
});
