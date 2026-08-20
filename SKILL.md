# Harpoon 1.0 Workflow Authoring Guide

## Overview

Harpoon is a TypeScript-based LLM orchestration runtime. Workflows are defined as DAGs of nodes that automatically pass data between each other.

**Prefer agent nodes.** Most workflow steps should use `type: agent` nodes, which run via the Claude CLI (existing subscription, `execution_mode: cli`) or the Agent SDK (pay-per-token, `execution_mode: sdk`). Agent nodes support multi-turn reasoning, tool use, and MCP servers — they're what you want for real work.

Use `type: prompt` nodes only when you specifically need single-shot structured inference (e.g., classification, extraction, scoring). Prompt nodes require an `ANTHROPIC_API_KEY` and make direct API calls with no tool use or multi-turn capability.

**Requirements:** Node.js >= 20.0.0

## Quick Start

A minimal Harpoon workflow uses an `agent.tml` manifest with agent nodes:

```
my-workflow/
  agent.tml               # DAG manifest
  prompts/
    research.prompt        # Agent prompt (instructions + context)
    summarize.prompt       # Next agent step
```

### Agent Workflow

```yaml
# agent.tml
harpoon: "1.0"
name: research-and-summarize
description: Research a topic and produce a summary

entrypoints:
  - input

nodes:
  input:
    type: input
    schema:
      topic: { type: string, required: true }

  research:
    type: agent
    prompt: prompts/research.prompt
    execution_mode: cli           # Uses Claude CLI (existing subscription)
    max_turns: 15
    allowed_tools: "*"

  summarize:
    type: agent
    prompt: prompts/summarize.prompt
    execution_mode: cli
    max_turns: 10

  output:
    type: output
    format: json

edges:
  e1:
    from: input
    to: research
  e2:
    from: research
    to: summarize
  e3:
    from: summarize
    to: output
```

```yaml
# prompts/research.prompt
---
id: research
harpoon: "1.0"

input:
  topic: { type: string, required: true }

output:
  format: json
  schema:
    findings: { type: string, description: Research findings }
    topic: { type: string, description: Original topic (pass through) }
---
Research the following topic thoroughly:

{{topic}}

Gather key facts, perspectives, and relevant details.
```

```yaml
# prompts/summarize.prompt
---
id: summarize
harpoon: "1.0"

input:
  findings: { type: string, required: true }
  topic: { type: string, required: true }

output:
  format: json
  schema:
    summary: { type: string, description: Final summary }
---
Summarize the following research on "{{topic}}":

{{findings}}

Produce a clear, concise summary.
```

### Run It

```bash
harpoon run ./my-workflow --input '{"topic": "renewable energy trends"}'
```

### Simple Prompt Chains (Single-Shot Inference)

For cases where you only need single-shot structured inference (classification, extraction, scoring) and don't need tool use or multi-turn reasoning, you can use prompt-first workflows without a manifest. These require an `ANTHROPIC_API_KEY`:

```
my-classifier/
  .env                    # ANTHROPIC_API_KEY=sk-ant-...
  prompts/
    classify.prompt       # Entry point (has entrypoint: true)
    respond.prompt        # Next step (linked via next:)
```

Prompt-first workflows chain `.prompt` files using the `next:` field in frontmatter. Output fields from one prompt automatically become inputs to the next. See [Prompt Frontmatter Reference](#prompt-frontmatter-reference) for the full schema.

## How Data Flows Between Nodes

Data flows between nodes via **edges** defined in `agent.tml`. Use `mapping:` to route fields between nodes:

```yaml
edges:
  e1:
    from: research
    to: summarize
    mapping:
      findings: results       # summarize.findings ← research.results
      topic: topic             # same-name passthrough
```

**Auto-mapping:** When field names match between upstream output and downstream input, they connect automatically — no explicit `mapping:` needed.

**Prompt-first auto-mapping:** In prompt chains (using `next:`), output fields automatically become input fields for the next prompt when names match.

## Project Structure

```
my-workflow/
  .env                    # Environment variables (API keys)
  prompts/
    entry.prompt          # Has entrypoint: true
    step2.prompt          # Linked via next:
    step3.prompt          # Terminal (no next:)
  tools/                  # Optional: TypeScript tools
    helpers.ts
```

### Environment Variables (.env)

```bash
# .env
ANTHROPIC_API_KEY=sk-ant-...
```

Harpoon loads `.env` automatically. Keys are available to the runtime but don't override existing environment variables.

## Prompt Frontmatter Reference

```yaml
---
# Identity
id: my_prompt                     # Unique identifier (required)
harpoon: "1.0"                    # Minimum Harpoon version (required)
name: My Prompt                   # Human-readable name
description: What this does       # Documentation

# Workflow connection
entrypoint: true                  # Marks this as the workflow start (one per workflow)
next: prompts/next.prompt         # Simple: flow to single prompt
# OR conditional branching:
next:
  - prompt: prompts/positive.prompt
    condition: "sentiment == 'positive'"
  - prompt: prompts/negative.prompt
    condition: "sentiment == 'negative'"
  - prompt: prompts/default.prompt    # No condition = fallback

# Looping (re-execute until condition is false)
loop:
  while: "quality_score < 8"
  max_iterations: 5

# Input schema
input:
  field_name:
    type: string                  # string, number, boolean, array, object
    required: true                # Fails if not provided
    default: "value"              # Used when not mapped
    description: What this is

# Output schema
output:
  format: json                    # json or text
  schema:
    field_name:
      type: string
      description: What this returns

# Model configuration
model: anthropic/claude-sonnet-4-20250514
temperature: 0.7
max_tokens: 4096

# Tools available to this prompt
tools:
  tool_name:
    type: typescript
    module: tools.helpers
    function: my_function

# Agent configuration (for agent nodes)
timeout: 1800                     # Seconds
max_turns: 25                     # Iteration limit
allowed_tools: "*"                # "*"=all, [list]=specific, omit=none
permission_mode: acceptEdits
execution_mode: cli               # "cli" (Claude CLI, existing subscription) or "sdk" (pay-per-token)
effort: high                      # CLI mode only: low | medium | high | xhigh | max — omit to inherit the user's /effort default
cwd: /path/to/workdir             # Working directory for agent execution
---
Your prompt body here with {{variables}}
```

## Workflow Patterns

### Linear Chain

```yaml
# entry.prompt
entrypoint: true
next: prompts/process.prompt

# process.prompt
next: prompts/finalize.prompt

# finalize.prompt
# (no next = terminal)
```

### Conditional Branching

```yaml
# classify.prompt
entrypoint: true
output:
  format: json
  schema:
    category: { type: string }

next:
  - prompt: prompts/handle_a.prompt
    condition: "category == 'A'"
  - prompt: prompts/handle_b.prompt
    condition: "category == 'B'"
  - prompt: prompts/handle_default.prompt
```

Conditions have access to all output fields. Syntax:
- `field` - truthy check
- `field == 'value'` - equality
- `field != 'value'` - inequality
- `field < 10` - comparison
- `a and b`, `a or b` - logical operators

### Iterative Refinement (Loops)

```yaml
# refine.prompt
loop:
  while: "needs_improvement"
  max_iterations: 5

output:
  format: json
  schema:
    text: { type: string }
    needs_improvement: { type: boolean }

next: prompts/finalize.prompt
```

Each iteration receives the previous iteration's output as input. Loop exits when:
- Condition becomes false, OR
- `max_iterations` is reached (raises error)

### Tools in Prompts

```yaml
# research.prompt
tools:
  fetch_data:
    type: typescript
    module: tools.queries
    function: get_data

---
Research the topic: {{topic}}

Use the fetch_data tool to gather information.
```

## When to Use agent.tml

You can always run prompt-first workflows without a manifest — just name your `.prompt` files so the execution order is obvious (e.g., `01_classify.prompt`, `02_respond.prompt`) and ensure the frontmatter is correct (`entrypoint`, `next`, input/output schemas).

Use `agent.tml` when you need features beyond simple chaining:

| Feature | Prompt-First | agent.tml |
|---------|--------------|-----------|
| Linear chains | Yes | Yes |
| Branching | Yes | Yes |
| Multiple entry points | No | Yes |
| Custom field mapping | Auto only | Full control |
| Parallel map over collection | No | Yes (map node) |
| Fan-out (1→many parallel) | No | Yes |
| Fan-in (many→1) | No | Yes |
| Tool nodes (not in prompts) | No | Yes |
| Complex DAGs | Limited | Yes |

### agent.tml Structure

```yaml
harpoon: "1.0"
name: my-workflow
description: A complex workflow

defaults:
  model: anthropic/claude-sonnet-4-20250514

entrypoints:
  - input

nodes:
  input:
    type: input
    schema:
      message: { type: string }

  analyze:
    type: agent
    prompt: prompts/analyze.prompt
    execution_mode: cli
    max_turns: 15

  output:
    type: output
    format: json

edges:
  e1:
    from: input
    to: analyze
    mapping:
      content: message    # Custom field mapping

  e2:
    from: analyze
    to: output
    mapping:
      result: text
```

### Manifest Discovery

Harpoon automatically discovers manifests in this order:
1. `agent.tml` (primary)
2. `harpoon.tml` (secondary)
3. `trident.tml` (legacy compatibility)
4. `trident.yaml` (legacy compatibility)

### Conflict Resolution

If both `agent.tml` and prompt frontmatter define connections, **prompt frontmatter wins** (with a warning). This allows gradual migration.

## Output Schemas and Structured Output

When you define `output.format: json` with a schema, Harpoon uses Claude's tool_use feature to enforce structure:

```yaml
output:
  format: json
  schema:
    status:
      type: string
      description: One of "success", "failure", "pending"
    score:
      type: number
      description: Quality score 0-100
```

This is converted to a Claude tool definition and forced via `tool_choice`. Much more reliable than asking for JSON in the prompt.

**Supported types:** `string`, `number`, `boolean`, `array`, `object`

## Agent Nodes (Preferred)

Agent nodes are the recommended node type for most workflow steps. They support multi-turn reasoning, tool use, and MCP servers. No `ANTHROPIC_API_KEY` required when using `execution_mode: cli`.

### execution_mode: cli (Claude CLI)

Uses your existing Claude subscription. Recommended for most use cases:

```yaml
# In agent.tml
nodes:
  assistant:
    type: agent
    prompt: prompts/assistant.prompt
    model: sonnet              # Passed to Claude CLI as --model sonnet
    execution_mode: cli       # Use Claude CLI
    max_turns: 20
    allowed_tools: "*"        # Enable all available tools
    permission_mode: acceptEdits
    effort: high              # Optional reasoning effort
```

**Effort levels** (CLI mode only): `low`, `medium`, `high`, `xhigh`, `max`. Set on the agent node or in the prompt frontmatter — manifest wins over frontmatter. When unset, harpoon does not pass `--effort`, so the CLI uses whatever the user configured via `/effort`. Ignored under `execution_mode: sdk`.

**Model selection** (CLI mode): set `model` on the agent node, in the prompt frontmatter, or under manifest `defaults`. Resolution order is agent node, prompt, then defaults. Harpoon passes the resolved value to Claude Code with `--model`; aliases such as `sonnet` use the latest Sonnet available to the signed-in Claude subscription. Provider-qualified Anthropic names such as `anthropic/claude-sonnet-4-20250514` are accepted and normalized for the CLI.

### execution_mode: sdk (Agent SDK)

Pay-per-token via the Agent SDK. Use when you need programmatic control or don't have a CLI subscription:

```yaml
# In agent.tml
nodes:
  browser_agent:
    type: agent
    prompt: prompts/browse.prompt
    execution_mode: sdk       # Pay-per-token
    max_turns: 20
    allowed_tools:
      - file_search
      - web_search
      - code_execution
```

## Prompt Nodes (Single-Shot Inference)

Prompt nodes make a single direct API call — no tool use, no multi-turn reasoning. Use them only when you need simple structured extraction, classification, or scoring. **Requires `ANTHROPIC_API_KEY`.**

```yaml
# In agent.tml
nodes:
  classify:
    type: prompt
    prompt: prompts/classify.prompt
```

## Branch Nodes (Sub-Workflows)

For complex looping or calling external workflows:

```yaml
# In agent.tml
nodes:
  refine_loop:
    type: branch
    workflow: ./workflows/refine.tml
    loop_while: "quality < 8"
    max_iterations: 3
```

Branch nodes:
- Execute a separate workflow
- Can loop until a condition is false
- Pass outputs back to the main workflow

**Important:** Sub-workflows must be in separate directories with their own `prompts/` folder to avoid conflicts.

## Map Nodes (Parallel Fan-Out)

Map nodes iterate over a runtime-determined collection, execute a sub-workflow per item in parallel, and collect results into a list. Use map when you have a list of items that need the same processing applied independently.

```yaml
# In agent.tml
nodes:
  process_chunks:
    type: map
    workflow: ./analyze_chunk       # Sub-workflow per item
    over: chunks                    # Field containing the list
    max_concurrency: 5              # 0 = unlimited (default)
    on_error: skip                  # "fail" (default), "skip", "collect"
    item_condition: "item.length > 0"  # Optional per-item filter
```

### Per-Item Input Shape

Each sub-workflow invocation receives:
```json
{"item": "<the_item>", "index": 0, "...pass_through_fields": "..."}
```

All gathered inputs except the collection field are forwarded as pass-through fields to every item invocation, providing shared context without extra wiring.

### Output Shape

```json
{"items": ["...results..."], "count": 3}
```

Map `items` and `count` to downstream nodes via edge mappings.

### Error Handling Modes

| Mode | Behavior |
|------|----------|
| `fail` (default) | Raise error on first item failure |
| `skip` | Exclude failed items from results |
| `collect` | Include `{"error": "...", "index": N}` in results |

### Example: Document Chunking Pipeline

```yaml
nodes:
  chunk_text:
    type: tool
  process_chunks:
    type: map
    workflow: ./analyze_chunk
    over: chunks
    max_concurrency: 5
edges:
  e1:
    from: chunk_text
    to: process_chunks
    mapping:
      chunks: chunks
  e2:
    from: process_chunks
    to: output
    mapping:
      results: items
      total: count
```

**Important:** Map sub-workflows must be in separate directories, same as branch sub-workflows.

## Trigger Nodes (Cross-Workflow Signals)

Trigger nodes enable one workflow to emit signals that other workflows can listen for:

```yaml
# In agent.tml
nodes:
  emit_signal:
    type: trigger
    signal: my_signal
    payload:
      data: "some value"
      timestamp: "{{now}}"
```

Listener workflows can react to signals using trigger conditions in their entrypoint edges.

## Tool Nodes

Tool nodes execute TypeScript functions directly without LLM prompting. Define
them in the manifest's top-level `tools:` section:

```yaml
# In agent.tml
tools:
  transform_data:
    type: typescript
    module: processors
    function: transform_records
    output:
      schema:
        transformed:
          type: boolean
          description: Whether the transformation completed
        count:
          type: integer
          description: Number of transformed records
```

Tools must export their functions as TypeScript modules:

```typescript
// tools/processors.ts
export async function transform_records({ records }: { records: unknown[] }) {
  return { transformed: true, count: records.length };
}
```

Tool output schemas support `string`, `number`, `integer`, `boolean`, `array`,
and `object`. Fields are required by default; add `required: false` only when a
successful tool result may legitimately omit a field. Harpoon uses the schema
to validate mappings, synthesize dry-run results, and validate real tool output.
Legacy tools without a schema continue to expose an opaque `output` field.

## Running Workflows

```bash
# Validate
harpoon validate ./my-workflow

# Dry run (no LLM calls)
harpoon run ./my-workflow --dry-run --input '{"message": "test"}'

# Execute
harpoon run ./my-workflow --input '{"message": "hello"}'

# With telemetry
harpoon run ./my-workflow --input '{"message": "hello"}' --telemetry

# Resume interrupted run
harpoon run ./my-workflow --resume latest

# Replay from specific node
harpoon run ./my-workflow --resume latest --start-from refine

# Visualize DAG
harpoon graph ./my-workflow --open
```

## Installation and Upgrade

```bash
# Install globally
npm install -g harpoon-cli

# Upgrade to latest
npm update -g harpoon-cli

# Check version
harpoon --version

# Use with npx (Node.js 20+)
npx harpoon-cli@latest run ./my-workflow
```

## Template Syntax

Harpoon supports flexible variable interpolation in prompts:

```yaml
---
input:
  user:
    type: object
    schema:
      name: { type: string }
      age: { type: number }
  items: { type: array }
---

Simple variable: {{user}}
Nested access: {{user.name}}
Array index: {{items.0}}
Deep nesting: {{user.profile.email}}
```

## Troubleshooting

### Missing Required Input

```
SchemaValidationError: Missing required input(s) for 'node': field_name
```

**Cause:** Field not provided via upstream prompt or input.
**Fix:** Ensure the upstream prompt outputs the field, or mark it `required: false`.

### Output Field Not Flowing

**Cause:** Field names don't match between prompts.
**Fix:** Ensure output schema field names match input field names exactly.

### Loop Never Terminates

**Cause:** Condition never becomes false.
**Fix:** Check that your prompt actually outputs the condition field with the right value. Add explicit instructions.

### Version Error

```
HarpoonError: Prompt 'X' requires Harpoon 1.0, but running 0.X
```

**Fix:** Upgrade Harpoon: `npm update -g harpoon-cli`

### No Entrypoint

```
HarpoonError: No entrypoint specified and none defined in project
```

**Fix:** Add `entrypoint: true` to one prompt, or create an `agent.tml` with `entrypoints:`.

### Module Not Found (Tools)

```
Error: Cannot find module 'tools.helpers'
```

**Cause:** Tools module path is incorrect or file doesn't exist.
**Fix:** Ensure tool files are in the `tools/` directory and exported correctly as TypeScript functions.

## Complete Example: Sentiment Classification (Prompt-First)

This is a good use case for prompt nodes — simple single-shot classification and response with no tool use needed. Requires `ANTHROPIC_API_KEY` in `.env`.

```
sentiment-workflow/
  .env
  prompts/
    01_classify.prompt
    02_respond.prompt
```

**prompts/01_classify.prompt:**
```yaml
---
id: classify
harpoon: "1.0"
entrypoint: true
model: anthropic/claude-sonnet-4-20250514

input:
  message:
    type: string
    required: true

output:
  format: json
  schema:
    sentiment:
      type: string
      description: positive, negative, or neutral
    confidence:
      type: number
      description: Confidence score 0-100
    message:
      type: string
      description: Original message (pass through)

next: prompts/02_respond.prompt
---
Analyze the sentiment of this message:

{{message}}

Return the sentiment (positive/negative/neutral), your confidence (0-100), and include the original message.
```

**prompts/02_respond.prompt:**
```yaml
---
id: respond
harpoon: "1.0"
model: anthropic/claude-sonnet-4-20250514

input:
  sentiment:
    type: string
    required: true
  confidence:
    type: number
    required: true
  message:
    type: string
    required: true

output:
  format: json
  schema:
    response:
      type: string
      description: Appropriate response to the user
    tone:
      type: string
      description: Tone used in response
---
The user said: "{{message}}"

Analysis:
- Sentiment: {{sentiment}}
- Confidence: {{confidence}}%

Generate an appropriate response. Match their energy if positive, be empathetic if negative.
```

**Run:**
```bash
harpoon run ./sentiment-workflow \
  --input '{"message": "This product exceeded my expectations!"}' \
  --verbose
```

## Advanced: TypeScript Tools Example

```typescript
// tools/helpers.ts
export async function fetch_data(query: string): Promise<Record<string, unknown>> {
  // Fetch data from external source
  return {
    results: ["item1", "item2"],
    count: 2,
  };
}

export async function transform_records(
  items: Record<string, unknown>[],
  threshold: number
): Promise<Record<string, unknown>[]> {
  return items.filter((item: Record<string, unknown>) =>
    (item.score as number) > threshold
  );
}
```

**Using tools in an agent node** (declare in `agent.tml`, reference in prompt):
```yaml
# agent.tml (relevant section)
nodes:
  research:
    type: agent
    prompt: prompts/research.prompt
    execution_mode: cli
    max_turns: 10

tools:
  fetch_data:
    type: typescript
    module: tools.helpers
    function: fetch_data
```

```yaml
# prompts/research.prompt
---
id: research
harpoon: "1.0"

input:
  topic: { type: string, required: true }

output:
  format: json
  schema:
    findings: { type: array }
    count: { type: number }
---
Research findings for: {{topic}}

Use the fetch_data tool to gather information.
```

## References

- Source: `src/`
- Examples: `examples/` (see `agent-json-demo/`, `map-demo/`, `tools-demo/`, `workflows-demo/`, `looping-demo/`)
- Package: `harpoon-cli` (npm)
- Node.js requirement: >= 20.0.0
