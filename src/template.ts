/** Minimal {{var}} template rendering per DEC-001. */

/**
 * Get a nested value from an object using dot notation.
 *
 * @example
 * getNested({ a: { b: 1 } }, "a.b") // => 1
 * getNested({ a: 1 }, "a")           // => 1
 * getNested({ a: 1 }, "b")           // => undefined
 */
export function getNested(
  data: Record<string, unknown>,
  path: string
): unknown {
  const parts = path.split(".");
  let current: unknown = data;
  for (const part of parts) {
    if (typeof current !== "object" || current === null) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[part];
    if (current === undefined) {
      return undefined;
    }
  }
  return current;
}

/**
 * Render a template with {{var}} substitution.
 *
 * Supports:
 * - {{var}} - direct variable
 * - {{var.nested.path}} - nested access
 * - {{ var }} - spaces are ignored
 *
 * Unknown variables are left as-is.
 */
export function render(
  template: string,
  variables: Record<string, unknown>
): string {
  return template.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (match, key: string) => {
    const trimmedKey = key.trim();
    let value: unknown;
    if (trimmedKey.includes(".")) {
      value = getNested(variables, trimmedKey);
    } else {
      value = variables[trimmedKey];
    }

    if (value === undefined || value === null) {
      return match; // Leave unknown vars as-is
    }
    return String(value);
  });
}
