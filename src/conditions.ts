/**
 * Boolean expression evaluator for edge conditions.
 *
 * Supports:
 *   - Comparison: ==, !=, <, >, <=, >=
 *   - Boolean: and, or, not
 *   - Parentheses
 *   - Field access: output.field.subfield
 *   - Literals: strings, numbers, true, false, null
 */

import { ConditionError } from "./errors.js";
import { getNested } from "./template.js";

type TokenType =
  | "OP"
  | "AND"
  | "OR"
  | "NOT"
  | "TRUE"
  | "FALSE"
  | "NULL"
  | "STRING"
  | "NUMBER"
  | "IDENT"
  | "LPAREN"
  | "RPAREN";

interface Token {
  type: TokenType;
  value: string;
}

const TOKEN_PATTERNS: [RegExp, TokenType | null][] = [
  [/\s+/, null], // Skip whitespace
  [/==|!=|<=|>=|<|>/, "OP"],
  [/\band\b/, "AND"],
  [/\bor\b/, "OR"],
  [/\bnot\b/, "NOT"],
  [/\btrue\b/, "TRUE"],
  [/\bfalse\b/, "FALSE"],
  [/\bnull\b/, "NULL"],
  [/'[^']*'/, "STRING"],
  [/"[^"]*"/, "STRING"],
  [/-?\d+\.?\d*/, "NUMBER"],
  [/[a-zA-Z_][a-zA-Z0-9_.]*/, "IDENT"],
  [/\(/, "LPAREN"],
  [/\)/, "RPAREN"],
];

function tokenize(expr: string): Token[] {
  const tokens: Token[] = [];
  let pos = 0;
  while (pos < expr.length) {
    let matched = false;
    for (const [pattern, tokenType] of TOKEN_PATTERNS) {
      // Create a sticky version of the regex starting at pos
      const regex = new RegExp(pattern.source, "y");
      regex.lastIndex = pos;
      const match = regex.exec(expr);
      if (match) {
        if (tokenType !== null) {
          tokens.push({ type: tokenType, value: match[0] });
        }
        pos = regex.lastIndex;
        matched = true;
        break;
      }
    }
    if (!matched) {
      throw new ConditionError(
        `Invalid character at position ${pos}: '${expr[pos]}'`
      );
    }
  }
  return tokens;
}

class Parser {
  private tokens: Token[];
  private context: Record<string, unknown>;
  private pos: number;

  constructor(tokens: Token[], context: Record<string, unknown>) {
    this.tokens = tokens;
    this.context = context;
    this.pos = 0;
  }

  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }

  private consume(expectedType?: TokenType): Token {
    const token = this.peek();
    if (!token) {
      throw new ConditionError("Unexpected end of expression");
    }
    if (expectedType && token.type !== expectedType) {
      throw new ConditionError(`Expected ${expectedType}, got ${token.type}`);
    }
    this.pos++;
    return token;
  }

  parse(): boolean {
    const result = this.parseOr();
    if (this.peek() !== undefined) {
      throw new ConditionError(`Unexpected token: ${JSON.stringify(this.peek())}`);
    }
    return result;
  }

  private parseOr(): boolean {
    let left = this.parseAnd();
    while (this.peek()?.type === "OR") {
      this.consume("OR");
      const right = this.parseAnd();
      left = left || right;
    }
    return left;
  }

  private parseAnd(): boolean {
    let left = this.parseNot();
    while (this.peek()?.type === "AND") {
      this.consume("AND");
      const right = this.parseNot();
      left = left && right;
    }
    return left;
  }

  private parseNot(): boolean {
    if (this.peek()?.type === "NOT") {
      this.consume("NOT");
      return !this.parseNot();
    }
    return this.parseComparison();
  }

  private parseComparison(): boolean {
    const left = this.parseTerm();
    if (this.peek()?.type === "OP") {
      const op = this.consume("OP").value;
      const right = this.parseTerm();
      return this.compare(left, op, right);
    }
    // Truthy check for standalone values
    return Boolean(left);
  }

  private compare(left: unknown, op: string, right: unknown): boolean {
    switch (op) {
      case "==":
        return left === right;
      case "!=":
        return left !== right;
      case "<":
        return (left as number) < (right as number);
      case ">":
        return (left as number) > (right as number);
      case "<=":
        return (left as number) <= (right as number);
      case ">=":
        return (left as number) >= (right as number);
      default:
        throw new ConditionError(`Unknown operator: ${op}`);
    }
  }

  private parseTerm(): unknown {
    const token = this.peek();
    if (!token) {
      throw new ConditionError("Unexpected end of expression");
    }

    switch (token.type) {
      case "LPAREN": {
        this.consume("LPAREN");
        const result = this.parseOr();
        this.consume("RPAREN");
        return result;
      }
      case "STRING": {
        const val = this.consume("STRING").value;
        return val.slice(1, -1); // Strip quotes
      }
      case "NUMBER": {
        const val = this.consume("NUMBER").value;
        return val.includes(".") ? parseFloat(val) : parseInt(val, 10);
      }
      case "TRUE":
        this.consume("TRUE");
        return true;
      case "FALSE":
        this.consume("FALSE");
        return false;
      case "NULL":
        this.consume("NULL");
        return null;
      case "IDENT": {
        const name = this.consume("IDENT").value;
        return getNested(this.context, name);
      }
      default:
        throw new ConditionError(`Unexpected token: ${JSON.stringify(token)}`);
    }
  }
}

/**
 * Evaluate a condition expression against a context.
 *
 * @param expr - Condition expression (e.g., "output.intent != 'spam'")
 * @param context - Variable context for field access
 * @returns Boolean result of evaluation
 * @throws {ConditionError} If expression is invalid
 */
export function evaluate(
  expr: string,
  context: Record<string, unknown>
): boolean {
  try {
    const tokens = tokenize(expr);
    if (tokens.length === 0) {
      return true; // Empty condition is truthy
    }
    const parser = new Parser(tokens, context);
    return parser.parse();
  } catch (e) {
    if (e instanceof ConditionError) {
      throw e;
    }
    throw new ConditionError(
      `Error evaluating condition: ${e instanceof Error ? e.message : String(e)}`
    );
  }
}
