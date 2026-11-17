/**
 * Tests for the structured-output schemas the providers send (providers/*.ts).
 */

import { describe, it, expect } from "vitest";
import { AnthropicProvider } from "../src/providers/anthropic.js";
import { OpenAIProvider } from "../src/providers/openai.js";

const FIELDS: Record<string, [string, string]> = {
  title: ["string", "Title"],
  score: ["number", "Score"],
  count: ["integer", "Count"],
  ok: ["boolean", "OK"],
  tags: ["array", "Tags"],
  meta: ["object", "Meta"],
};

const EXPECTED_TYPES = {
  title: "string",
  score: "number",
  count: "integer",
  ok: "boolean",
  tags: "array",
  meta: "object",
};

function propertyTypes(schema: { properties: Record<string, { type: string }> }) {
  return Object.fromEntries(
    Object.entries(schema.properties).map(([name, spec]) => [name, spec.type])
  );
}

describe("provider structured-output schemas", () => {
  // validateSchema() rejects a non-integer for an `integer` field, so the
  // provider must ask the model for an integer, not a string.
  it("Anthropic maps every supported output type, including integer", () => {
    const tool = new AnthropicProvider()["buildSchemaTool"](FIELDS) as {
      input_schema: { properties: Record<string, { type: string }> };
    };
    expect(propertyTypes(tool.input_schema)).toEqual(EXPECTED_TYPES);
  });

  it("OpenAI maps every supported output type, including integer", () => {
    const schema = new OpenAIProvider()["buildJsonSchema"](FIELDS) as {
      properties: Record<string, { type: string }>;
    };
    expect(propertyTypes(schema)).toEqual(EXPECTED_TYPES);
  });
});
