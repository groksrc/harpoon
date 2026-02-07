/**
 * Tests for template rendering (template.ts).
 */

import { describe, it, expect } from "vitest";
import { getNested, render } from "../src/template.js";

describe("getNested", () => {
  it("gets a simple key", () => {
    expect(getNested({ a: 1 }, "a")).toBe(1);
  });

  it("gets a nested key", () => {
    expect(getNested({ a: { b: { c: 3 } } }, "a.b.c")).toBe(3);
  });

  it("returns undefined for missing key", () => {
    expect(getNested({ a: 1 }, "b")).toBeUndefined();
  });

  it("returns undefined for missing nested key", () => {
    expect(getNested({ a: 1 }, "a.b")).toBeUndefined();
  });

  it("returns undefined when intermediate is not an object", () => {
    expect(getNested({ a: "string" }, "a.b")).toBeUndefined();
  });

  it("handles null intermediate values", () => {
    expect(getNested({ a: null } as Record<string, unknown>, "a.b")).toBeUndefined();
  });
});

describe("render", () => {
  it("substitutes a simple variable", () => {
    expect(render("Hello {{name}}", { name: "World" })).toBe("Hello World");
  });

  it("substitutes variables with spaces around braces", () => {
    expect(render("Hello {{ name }}", { name: "World" })).toBe("Hello World");
  });

  it("substitutes nested variables", () => {
    expect(render("Value: {{data.value}}", { data: { value: 42 } })).toBe(
      "Value: 42"
    );
  });

  it("leaves unknown variables as-is", () => {
    expect(render("Hello {{unknown}}", {})).toBe("Hello {{unknown}}");
  });

  it("substitutes multiple variables", () => {
    const result = render("{{greeting}} {{name}}!", {
      greeting: "Hello",
      name: "World",
    });
    expect(result).toBe("Hello World!");
  });

  it("converts numbers to strings", () => {
    expect(render("Count: {{n}}", { n: 42 })).toBe("Count: 42");
  });

  it("handles deeply nested paths", () => {
    const result = render("{{a.b.c.d}}", {
      a: { b: { c: { d: "deep" } } },
    });
    expect(result).toBe("deep");
  });

  it("leaves null values as-is", () => {
    expect(render("Value: {{x}}", { x: null })).toBe("Value: {{x}}");
  });

  it("handles empty template", () => {
    expect(render("", { name: "World" })).toBe("");
  });

  it("handles template with no variables", () => {
    expect(render("Hello World!", {})).toBe("Hello World!");
  });

  it("handles boolean values", () => {
    expect(render("Flag: {{flag}}", { flag: true })).toBe("Flag: true");
    expect(render("Flag: {{flag}}", { flag: false })).toBe("Flag: false");
  });
});
