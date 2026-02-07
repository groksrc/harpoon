/**
 * Tests for boolean expression evaluator (conditions.ts).
 */

import { describe, it, expect } from "vitest";
import { evaluate } from "../src/conditions.js";
import { ConditionError } from "../src/errors.js";

describe("conditions", () => {
  describe("equality", () => {
    it("returns true for matching values", () => {
      expect(evaluate("x == 1", { x: 1 })).toBe(true);
    });

    it("returns false for non-matching values", () => {
      expect(evaluate("x == 2", { x: 1 })).toBe(false);
    });
  });

  describe("inequality", () => {
    it("returns true when values differ", () => {
      expect(evaluate("x != 1", { x: 2 })).toBe(true);
    });

    it("returns false when values match", () => {
      expect(evaluate("x != 1", { x: 1 })).toBe(false);
    });
  });

  describe("comparison operators", () => {
    it("greater than", () => {
      expect(evaluate("x > 5", { x: 10 })).toBe(true);
      expect(evaluate("x > 5", { x: 3 })).toBe(false);
    });

    it("less than", () => {
      expect(evaluate("x < 5", { x: 3 })).toBe(true);
      expect(evaluate("x < 5", { x: 10 })).toBe(false);
    });

    it("greater than or equal", () => {
      expect(evaluate("x >= 5", { x: 5 })).toBe(true);
      expect(evaluate("x >= 5", { x: 6 })).toBe(true);
      expect(evaluate("x >= 5", { x: 4 })).toBe(false);
    });

    it("less than or equal", () => {
      expect(evaluate("x <= 5", { x: 5 })).toBe(true);
      expect(evaluate("x <= 5", { x: 4 })).toBe(true);
      expect(evaluate("x <= 5", { x: 6 })).toBe(false);
    });
  });

  describe("string equality", () => {
    it("matches single-quoted strings", () => {
      expect(evaluate("intent == 'spam'", { intent: "spam" })).toBe(true);
      expect(evaluate("intent == 'spam'", { intent: "support" })).toBe(false);
    });

    it("matches double-quoted strings", () => {
      expect(evaluate('intent == "spam"', { intent: "spam" })).toBe(true);
    });
  });

  describe("and operator", () => {
    it("returns true when both are true", () => {
      expect(evaluate("a and b", { a: true, b: true })).toBe(true);
    });

    it("returns false when one is false", () => {
      expect(evaluate("a and b", { a: true, b: false })).toBe(false);
    });
  });

  describe("or operator", () => {
    it("returns true when one is true", () => {
      expect(evaluate("a or b", { a: false, b: true })).toBe(true);
    });

    it("returns false when both are false", () => {
      expect(evaluate("a or b", { a: false, b: false })).toBe(false);
    });
  });

  describe("not operator", () => {
    it("negates false to true", () => {
      expect(evaluate("not a", { a: false })).toBe(true);
    });

    it("negates true to false", () => {
      expect(evaluate("not a", { a: true })).toBe(false);
    });
  });

  describe("parentheses", () => {
    it("groups or with and", () => {
      expect(
        evaluate("(a or b) and c", { a: true, b: false, c: true })
      ).toBe(true);
    });

    it("groups and within or", () => {
      expect(
        evaluate("a or (b and c)", { a: false, b: true, c: false })
      ).toBe(false);
    });
  });

  describe("nested field access", () => {
    it("accesses nested properties with dot notation", () => {
      expect(
        evaluate("output.intent == 'support'", {
          output: { intent: "support" },
        })
      ).toBe(true);
    });

    it("evaluates complex nested conditions", () => {
      const ctx = { output: { intent: "support", confidence: 0.9 } };
      expect(
        evaluate("output.intent != 'spam' and output.confidence > 0.5", ctx)
      ).toBe(true);
    });
  });

  describe("boolean literals", () => {
    it("true literal is truthy", () => {
      expect(evaluate("true", {})).toBe(true);
    });

    it("false literal is falsy", () => {
      expect(evaluate("false", {})).toBe(false);
    });

    it("compares context booleans to boolean literals", () => {
      expect(evaluate("x == true", { x: true })).toBe(true);
      expect(evaluate("x == true", { x: false })).toBe(false);
      expect(evaluate("x == false", { x: true })).toBe(false);
      expect(evaluate("x == false", { x: false })).toBe(true);
    });

    it("boolean and string 'true' are not equal", () => {
      // JS true !== string "true"
      expect(evaluate("x == 'true'", { x: true })).toBe(false);
      expect(evaluate("x == 'true'", { x: "true" })).toBe(true);
    });
  });

  describe("truthy evaluation", () => {
    it("truthy boolean field", () => {
      expect(evaluate("needs_refinement", { needs_refinement: true })).toBe(
        true
      );
      expect(evaluate("needs_refinement", { needs_refinement: false })).toBe(
        false
      );
    });

    it("not operator with truthy field", () => {
      expect(
        evaluate("not needs_refinement", { needs_refinement: true })
      ).toBe(false);
      expect(
        evaluate("not needs_refinement", { needs_refinement: false })
      ).toBe(true);
    });

    it("truthy numbers", () => {
      expect(evaluate("x", { x: 1 })).toBe(true);
      expect(evaluate("x", { x: 0 })).toBe(false);
    });
  });

  describe("null literal", () => {
    it("compares with null", () => {
      expect(evaluate("x == null", { x: null })).toBe(true);
      expect(evaluate("x == null", { x: 1 })).toBe(false);
    });
  });

  describe("number literals", () => {
    it("handles integer literals", () => {
      expect(evaluate("x == 42", { x: 42 })).toBe(true);
    });

    it("handles float literals", () => {
      expect(evaluate("x > 0.5", { x: 0.9 })).toBe(true);
    });

    it("handles negative numbers", () => {
      expect(evaluate("x == -1", { x: -1 })).toBe(true);
    });
  });

  describe("empty condition", () => {
    it("returns true for empty string", () => {
      expect(evaluate("", {})).toBe(true);
    });
  });

  describe("error cases", () => {
    it("throws ConditionError for invalid characters", () => {
      expect(() => evaluate("x @@ y", { x: 1, y: 2 })).toThrow(
        ConditionError
      );
    });

    it("throws ConditionError for unexpected end of expression", () => {
      expect(() => evaluate("x ==", { x: 1 })).toThrow(ConditionError);
    });

    it("throws ConditionError for mismatched parentheses", () => {
      expect(() => evaluate("(x == 1", { x: 1 })).toThrow(ConditionError);
    });
  });
});
