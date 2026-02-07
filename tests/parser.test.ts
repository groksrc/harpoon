/**
 * Tests for .prompt file parser (parser.ts).
 */

import { describe, it, expect } from "vitest";
import * as path from "node:path";
import { parsePromptFile, parseYaml } from "../src/parser.js";
import { ParseError, VersionError } from "../src/errors.js";

const FIXTURES = path.resolve(__dirname, "fixtures");

describe("parseYaml", () => {
  it("parses simple values", () => {
    const result = parseYaml("name: test\ncount: 42\nenabled: true\n");
    expect(result.name).toBe("test");
    expect(result.count).toBe(42);
    expect(result.enabled).toBe(true);
  });

  it("parses nested dicts", () => {
    const result = parseYaml("outer:\n  inner: value\n");
    expect((result.outer as Record<string, unknown>).inner).toBe("value");
  });

  it("returns empty object for empty input", () => {
    const result = parseYaml("");
    expect(result).toEqual({});
  });
});

describe("parsePromptFile", () => {
  it("parses a basic prompt file", () => {
    const node = parsePromptFile(path.join(FIXTURES, "basic.prompt"));
    expect(node.id).toBe("test");
    expect(node.name).toBe("Test Prompt");
    expect(node.model).toBe("anthropic/claude-sonnet-4-20250514");
    expect(node.body).toBe("Hello {{name}}!");
    expect(node.harpoonVersion).toBe("1.0");
  });

  it("parses output schema", () => {
    const node = parsePromptFile(path.join(FIXTURES, "with-schema.prompt"));
    expect(node.output.format).toBe("json");
    expect(node.output.fields).toHaveProperty("intent");
    expect(node.output.fields.intent).toEqual(["string", "The classified intent"]);
    expect(node.output.fields.confidence).toEqual(["number", "Confidence score"]);
  });

  it("parses input fields", () => {
    const node = parsePromptFile(path.join(FIXTURES, "with-inputs.prompt"));
    expect(node.inputs).toHaveProperty("message");
    expect(node.inputs.message.type).toBe("string");
    expect(node.inputs.message.required).toBe(true);
    expect(node.inputs.count.required).toBe(false);
    expect(node.inputs.count.default).toBe(5);
  });

  it("throws ParseError for missing id", () => {
    expect(() => parsePromptFile(path.join(FIXTURES, "no-id.prompt"))).toThrow(
      ParseError
    );
  });

  it("throws ParseError for missing version", () => {
    expect(() =>
      parsePromptFile(path.join(FIXTURES, "no-version.prompt"))
    ).toThrow(ParseError);
  });

  it("throws VersionError for incompatible version", () => {
    expect(() =>
      parsePromptFile(path.join(FIXTURES, "incompatible-version.prompt"))
    ).toThrow(VersionError);
  });

  it("supports trident: version field for backward compat", () => {
    const node = parsePromptFile(path.join(FIXTURES, "trident-compat.prompt"));
    expect(node.id).toBe("legacy");
    expect(node.harpoonVersion).toBe("0.1");
  });

  it("throws ParseError for non-existent file", () => {
    expect(() =>
      parsePromptFile(path.join(FIXTURES, "nonexistent.prompt"))
    ).toThrow(ParseError);
  });

  describe("prompt-first fields", () => {
    it("parses entrypoint: true", () => {
      const node = parsePromptFile(path.join(FIXTURES, "entrypoint.prompt"));
      expect(node.entrypoint).toBe(true);
    });

    it("parses simple next path", () => {
      const node = parsePromptFile(path.join(FIXTURES, "entrypoint.prompt"));
      expect(node.next).toBe("prompts/other.prompt");
    });

    it("parses conditional next with multiple branches", () => {
      const node = parsePromptFile(
        path.join(FIXTURES, "conditional-next.prompt")
      );
      expect(Array.isArray(node.next)).toBe(true);
      const nextArr = node.next as Array<{
        prompt: string;
        condition: string | null;
      }>;
      expect(nextArr).toHaveLength(2);
      expect(nextArr[0].prompt).toBe("prompts/a.prompt");
      expect(nextArr[0].condition).toBe("status == 'ok'");
      expect(nextArr[1].prompt).toBe("prompts/b.prompt");
      expect(nextArr[1].condition).toBeNull();
    });

    it("parses loop configuration", () => {
      const node = parsePromptFile(path.join(FIXTURES, "with-loop.prompt"));
      expect(node.loop).not.toBeNull();
      expect(node.loop!.whileCondition).toBe("quality_score < 8");
      expect(node.loop!.maxIterations).toBe(5);
    });

    it("parses tools from frontmatter", () => {
      const node = parsePromptFile(path.join(FIXTURES, "with-tools.prompt"));
      expect(node.tools).not.toBeNull();
      expect(node.tools!.fetch_data).toBeDefined();
      expect(node.tools!.fetch_data.type).toBe("python");
      expect(node.tools!.fetch_data.module).toBe("tools.queries");
      expect(node.tools!.fetch_data.function).toBe("get_data");
      expect(node.tools!.fetch_data.description).toBe("Fetches data");
    });
  });
});
