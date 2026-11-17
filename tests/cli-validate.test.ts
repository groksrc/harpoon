/**
 * Tests for `harpoon project validate` (src/cli-validate.ts): exit codes and
 * what it prints.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { cmdProjectValidate } from "../src/cli-validate.js";
import { ExitCode } from "../src/errors.js";

const EXAMPLES_DIR = path.resolve(__dirname, "..", "examples");

/** Run the command and capture what it writes. */
async function validate(
  projectPath: string,
  strict = false
): Promise<{ code: number; stdout: string; stderr: string }> {
  let stdout = "";
  let stderr = "";
  const out = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    stdout += String(chunk);
    return true;
  });
  const err = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
    stderr += String(chunk);
    return true;
  });
  try {
    const code = await cmdProjectValidate(projectPath, { strict });
    return { code, stdout, stderr };
  } finally {
    out.mockRestore();
    err.mockRestore();
  }
}

function writeProject(manifest: string, prompts: Record<string, string> = {}): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "harpoon-cli-validate-"));
  fs.writeFileSync(path.join(dir, "agent.tml"), manifest);
  if (Object.keys(prompts).length > 0) {
    fs.mkdirSync(path.join(dir, "prompts"));
    for (const [name, text] of Object.entries(prompts)) {
      fs.writeFileSync(path.join(dir, "prompts", `${name}.prompt`), text);
    }
  }
  return dir;
}

describe("harpoon project validate", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  it("exits 0 on every example, in strict mode too", async () => {
    for (const name of fs.readdirSync(EXAMPLES_DIR)) {
      const dir = path.join(EXAMPLES_DIR, name);
      if (!fs.statSync(dir).isDirectory()) continue;
      const result = await validate(dir, true);
      expect(result.stderr, name).toBe("");
      expect(result.code, name).toBe(ExitCode.SUCCESS);
      expect(result.stdout).toContain("Validation passed");
    }
  });

  it("exits 2 on a type mismatch and names the edge", async () => {
    const dir = writeProject(
      `harpoon: "1.0"
name: mismatch
nodes:
  input:
    type: input
    schema:
      ratio: { type: number, description: Ratio }
  output:
    type: output
edges:
  feed: { from: input, to: count, mapping: { n: ratio } }
  done: { from: count, to: output, mapping: { text: text } }
`,
      {
        count: `---
id: count
harpoon: "1.0"
input:
  n: { type: integer }
---
Count to {{n}}.
`,
      }
    );
    dirs.push(dir);

    const result = await validate(dir);
    expect(result.code).toBe(ExitCode.VALIDATION_ERROR);
    expect(result.stderr).toContain("Validation failed: 1 error(s)");
    expect(result.stderr).toContain(
      "x Edge 'feed': Type mismatch: 'ratio' (number) from 'input' cannot feed 'n' (integer) in 'count'"
    );
  });

  it("reports a cycle as a validation error, not an uncaught exception", async () => {
    const dir = writeProject(
      `harpoon: "1.0"
name: cycle
nodes:
  input:
    type: input
  a:
    type: output
  b:
    type: output
edges:
  e0: { from: input, to: a }
  e1: { from: a, to: b }
  e2: { from: b, to: a }
`
    );
    dirs.push(dir);

    const result = await validate(dir);
    expect(result.code).toBe(ExitCode.VALIDATION_ERROR);
    expect(result.stderr).toContain("Cycle detected in DAG");
  });

  it("passes a warning without --strict and fails it with --strict", async () => {
    const dir = writeProject(
      `harpoon: "1.0"
name: disconnected
nodes:
  input:
    type: input
  output:
    type: output
  stray:
    type: output
  stray_sink:
    type: output
edges:
  e1: { from: input, to: output }
  e2: { from: stray, to: stray_sink }
`
    );
    dirs.push(dir);

    const lenient = await validate(dir);
    expect(lenient.code).toBe(ExitCode.SUCCESS);
    expect(lenient.stdout).toContain("Warnings (1):");
    expect(lenient.stdout).toContain('! Nodes ["stray","stray_sink"] are not connected');

    const strict = await validate(dir, true);
    expect(strict.code).toBe(ExitCode.VALIDATION_ERROR);
    expect(strict.stderr).toContain("Validation failed: 1 warning(s) in strict mode");
  });
});
