# Harpoon

Lightweight agent orchestration runtime for LLM pipelines.

Harpoon lets you define multi-step AI workflows as directed acyclic graphs (DAGs) using simple YAML manifests and prompt templates. It supports prompt chaining, conditional branching, parallel execution, and Claude Agent SDK integration.

## Installation

```bash
npm install -g harpoon-cli

# Or in your project
npm install harpoon-cli
```

Requires Node.js >=20.0.0

## Quick Start

Create a new project:

```bash
harpoon project init my-project
cd my-project
```

This creates:
```
my-project/
├── agent.tml          # Project manifest (TML format)
└── prompts/
    └── example.prompt # Prompt template
```

Validate and run:

```bash
harpoon project validate
harpoon project run --dry-run -i '{"text": "Hello world"}'
```

## TML - Text Markup Language

Remember HTML? Well, this is just the TML for marking up agents.

Harpoon uses `.tml` files as the conventional manifest format. TML files are valid YAML with a semantic file extension.

**Auto-discovery order** (when given a directory):
1. `agent.tml` (primary)
2. `harpoon.tml` (secondary)
3. `trident.tml` (legacy)
4. `trident.yaml` (legacy)

**Explicit file paths** work with any filename:
```bash
harpoon project run ./my-workflow.tml
harpoon project run ./pipelines/support.tml
```

## Project Structure

### Manifest (`agent.tml`)

```yaml
harpoon: "0.1"
name: my-project
description: Project description

defaults:
  model: anthropic/claude-sonnet-4-20250514
  temperature: 0.7
  max_tokens: 1024

nodes:
  input:
    type: input
    schema:
      text: string, Input text to process

  output:
    type: output
    format: json

edges:
  e1:
    from: input
    to: process
    mapping:
      content: text

  e2:
    from: process
    to: output
    mapping:
      result: output
```

### Prompt Templates (`prompts/*.prompt`)

```yaml
---
id: process
name: Process Text
description: Processes input text

input:
  content:
    type: string
    description: The content to process

output:
  format: json
  schema:
    result: string, The processed result
---
You are a helpful assistant.

Process this: {{content}}

Return JSON with a "result" field.
```

## Node Types

| Type | Description |
|------|-------------|
| `input` | Entry point with schema validation |
| `output` | Exit point, collects final outputs |
| `prompt` | LLM prompt node (from `.prompt` files) |
| `agent` | Claude Agent SDK node with tool access |
| `tool` | TypeScript tool node for imperative code |
| `branch` | Sub-workflow execution with looping |
| `map` | Parallel fan-out over collections |
| `trigger` | Cross-workflow signal emission |

### Agent Nodes

Agent nodes use Claude Agent SDK for autonomous tool use:

```yaml
nodes:
  analyzer:
    type: agent
    prompt: prompts/analyzer.prompt
    model: sonnet
    execution_mode: sdk  # 'sdk' or 'cli' (default: cli)
    allowed_tools:
      - Read
      - Write
      - Bash
    mcp_servers:
      github:
        command: npx
        args: ["@modelcontextprotocol/server-github"]
    max_turns: 50
    permission_mode: acceptEdits
    effort: high  # low | medium | high | xhigh | max (cli mode only)
```

**Execution Modes:**
- `cli` - Uses Claude CLI with existing subscription (default)
- `sdk` - Uses Claude Agent SDK with pay-per-token billing

For CLI agents, `model` is passed to Claude Code with `--model`. You can use a subscription alias such as `sonnet` or an Anthropic model identifier. Agent-node configuration takes precedence over prompt frontmatter and manifest defaults.

**Effort Levels** (CLI mode, passed through as `--effort`):
Resolution order is manifest node > prompt frontmatter > unset. When unset, harpoon omits the flag so the CLI uses whatever the user set via `/effort`.

### Tool Nodes

Tool nodes execute TypeScript code for deterministic operations. Define them in
the top-level `tools:` section. An output schema makes edge validation precise,
produces realistic dry-run values, and validates real tool results:

```yaml
tools:
  processor:
    type: typescript
    module: processor
    function: process_text
    output:
      schema:
        transformed:
          type: string
          description: Processed text
        count:
          type: integer
          description: Number of records processed
        warning:
          type: string
          description: Optional diagnostic
          required: false
```

Supported field types are `string`, `number`, `integer`, `boolean`, `array`,
and `object`. Declared fields are required by default. Tools without an output
schema retain the legacy opaque `{ output: ... }` contract.

### Branch Nodes

Branch nodes execute sub-workflows with optional looping:

```yaml
nodes:
  refine:
    type: branch
    workflow: ./refine-workflow.tml
    condition: "needs_refinement == true"
    loop_while: "quality_score < 0.9"
    max_iterations: 5
```

### Map Nodes

Map nodes parallelize operations over collections:

```yaml
nodes:
  process_items:
    type: map
    source: items  # Input array field
    item_var: item  # Variable name for each item
    prompt: prompts/process-item.prompt
    concurrency: 5  # Max parallel operations

edges:
  e1:
    from: input
    to: process_items
    mapping:
      items: data
```

### Trigger Nodes

Trigger nodes emit signals to coordinate cross-workflow execution:

```yaml
nodes:
  notify_downstream:
    type: trigger
    signal: workflow-ready
    condition: "success == true"
```

## Edges

Edges connect nodes and map outputs to inputs:

```yaml
edges:
  e1:
    from: classify
    to: respond
    mapping:
      intent: intent           # target_var: source_field
      confidence: confidence
    condition: "confidence > 0.5"  # Optional condition
```

## CLI Commands

```bash
# Project management
harpoon project init [path] [-t, --template <name>]  # Create new project (template: minimal, standard)
harpoon project validate [path]                       # Validate project
harpoon project graph [path] [options]                # Visualize DAG
harpoon project runs [path]                           # List past runs
harpoon project signals [path]                        # View/manage signals
harpoon project schedule [path] [options]             # Generate cron/systemd/launchd configs

# Execution
harpoon project run [path] [options]
  -i, --input JSON             # Input data as JSON
  -f, --input-file PATH        # Input from file
  -e, --entrypoint NODE        # Starting node
  -o, --output FORMAT          # json, text, pretty (default: pretty)
  --dry-run                    # Simulate without LLM calls
  --trace                      # Show execution trace
  --resume ID|latest           # Resume from checkpoint
  --start-from NODE            # Start from specific node (requires --resume)
  --run-id ID                  # Custom run identifier
  -v, --verbose                # Verbose output
  --no-artifacts               # Don't save run artifacts
  --artifact-dir PATH          # Custom artifacts directory
  --telemetry/--no-telemetry   # Enable/disable telemetry (default: enabled)
  --telemetry-format FORMAT    # jsonl or human (stdout; default: human)
  --telemetry-file PATH        # Also write telemetry to a JSONL file
  --telemetry-level LEVEL      # debug, info, warning, error

# Orchestration options
  --input-from PATH            # Load inputs from file, alias:name, or run:id
  --emit-signal                # Emit orchestration signals (started/completed/failed/ready)
  --publish-to PATH            # Publish outputs to a well-known path
  --wait-for SIGNAL            # Wait for signal file(s) before starting
  --timeout SECONDS            # Timeout for --wait-for (default: 300)

# DAG visualization
harpoon project graph --format mermaid --open        # Open in mermaid.live
harpoon project graph --direction LR                 # Set diagram direction (LR, TB, etc.)

# Scheduling
harpoon project schedule ./my-project --format cron  # Generate cron expression
harpoon project schedule ./my-project --format systemd  # Generate systemd timer
harpoon project schedule ./my-project --format launchd  # Generate launchd plist
```

## Validation

`harpoon project validate` and `harpoon project run` use the same validator
(`validateProject()`). Validation fails on any error. A run refuses an invalid
project before any node executes, with or without `--dry-run`.

```bash
harpoon project validate ./my-project           # exit 2 on any error
harpoon project validate ./my-project --strict  # exit 2 on any error or warning
```

Branch and map sub-workflows are validated too. Their messages start with the
node that refers to them, such as `Branch 'loop' (./workflows/build.tml): ...`.

### Errors

Structure:
- An edge references a node that does not exist. Every edge endpoint must be
  declared, so a misspelled node name is an error. Harpoon does not create an
  input or output node for an undeclared endpoint.
- The graph has a cycle.
- A manifest node has a `type` other than `input`, `output`, `prompt`, `tool`,
  `agent`, `branch`, `map` or `trigger`.
- An agent's prompt file is missing or does not parse.
- A declared entrypoint, or the `--entrypoint` value, is not a node.
- A branch or map sub-workflow is missing, circular or invalid.

Edge contracts, checked for every edge mapping (`target: source`):
- The source field is not an output of the source node. Only nodes with a fixed
  field list are checked: input nodes with a `schema`, prompts, agents, and
  tools with an `output.schema`. A prompt outputs `text` plus its declared JSON
  fields. A JSON agent outputs only its declared fields, and a text agent
  outputs only `text`. Branch, map and trigger outputs, tools without a schema,
  input nodes without a schema, and JSON prompts or agents that declare no
  output fields are dynamic and not checked.
- The target field is not a declared input of a prompt or agent target. Output,
  branch, map, trigger and tool targets accept any field.
- The source and target types are both known and incompatible (see the table).
- A prompt or agent input is required (the default) and has no `default`, and
  no incoming edge maps it. A mapping on a conditional edge counts.

Fan-out, fan-in and nodes with several parents are all valid.

### Warnings

Warnings pass by default and fail under `--strict`:
- A group of connected nodes has no input node and no entrypoint, so no run
  input reaches it.
- A field declares a type outside the six known types. Harpoon does not check
  it. This covers every declared field (input node schemas, prompt and agent
  inputs and output fields, tool output schemas), whether or not an edge maps
  it, with one warning per node and field.

### Type compatibility

The known types are `string`, `number`, `integer`, `boolean`, `array` and
`object`. A field without a declared type (such as a tool output without a
schema) is always compatible.

| Source → target | Result |
|---|---|
| Same type | Compatible |
| `integer` → `number` | Compatible |
| `object` → `string`, `array` → `string` | Compatible: the value is rendered as JSON |
| `number` → `integer` | Error: a runtime value such as `0.5` is not an integer |
| Any other pair of known types | Error |

### Checks during a run

- Run inputs are type-checked against each input node's `schema` before any
  node runs. Only the fields you pass are checked, and a `null` value counts
  as passed, so it fails a typed field. A missing required field fails at the
  node that needs it.
- Prompt and agent JSON output must contain every field in the prompt's
  `output.schema`, with the declared type. Tool output is checked against the
  tool's `output.schema`. A failed check stops the run before downstream nodes.

### Example Output
```
Project: my-project
  Prompts: 1
  Tools: 0
  Agents: 0
  Branches: 0
  Maps: 0
  Edges: 2
  Nodes in execution order: 3

Validation failed: 2 error(s)
  x Edge 'e1': Type mismatch: 'ratio' (number) from 'input' cannot feed 'limit' (integer) in 'process'
  x Node 'process' (prompt): required input 'style' has no default and no incoming edge maps it
```

### Upgrading from 1.4.1 or earlier (breaking change)

Version 1.4.1 and earlier only warned about type mismatches and missing fields, and
`harpoon project run` never checked them. A workflow that used to run with
those warnings now fails validation. Common fixes:
- `number` → `integer`: declare the target as `number`, or the source as
  `integer`.
- An unmapped required input: map it on an incoming edge, give it a `default`,
  or mark it `required: false`.
- A misspelled source or target field: match the names in the schemas.
- An edge to an undeclared node: declare it under `nodes:`. Version 1.4.1 and
  earlier silently created an input or output node for any undeclared edge
  endpoint, which hid misspelled node names.

### Common Validation Errors

**Tools must be in `tools:` section:**
```yaml
# ❌ Wrong - tool in nodes section
nodes:
  my_tool:
    type: tool
    module: mymodule

# ✅ Correct - tool in the top-level tools section
tools:
  my_tool:
    type: typescript
    module: mymodule
    function: execute
```

## TypeScript API

```typescript
import { loadProject, run } from 'harpoon-cli';

// Load and execute
const project = await loadProject('./my-project');
const result = await run(project, {
  inputs: { text: 'Hello world' },
  dryRun: false,
  verbose: true,
});

// Check results
if (result.success) {
  console.log(result.outputs);
} else {
  console.log(`Failed: ${result.error}`);
}

// Access trace
for (const node of result.trace.nodes) {
  console.log(`${node.id}: ${node.tokens}`);
}
```

## Features

- **DAG Execution**: Automatic topological ordering and dependency resolution
- **Parallel Execution**: Independent nodes run concurrently, map nodes fan out
- **Conditional Edges**: Skip nodes based on runtime conditions
- **Multiple Providers**: Anthropic and OpenAI support
- **Execution Modes**: CLI mode (existing subscription) and SDK mode (pay-per-token)
- **Checkpoints**: Resume interrupted runs from last successful node or specific node
- **Artifacts**: Automatic persistence of runs, traces, and outputs in `.harpoon/`
- **Dry Run**: Test pipelines without LLM calls
- **Typed Tool Outputs**: Validate mappings, dry-run data, and real tool results
- **Mermaid Visualization**: Generate interactive DAG diagrams, open in browser
- **Telemetry**: Configurable telemetry with streaming output and multiple formats
- **Workflow Orchestration**: Chain workflows with signals, wait conditions, and shared outputs
- **Scheduling**: Generate cron, systemd, and launchd configurations

## Workflow Orchestration

Harpoon supports file-based workflow orchestration for chaining workflows, scheduled execution, and event-driven triggers.

### Signal Files

Workflows can emit signal files to indicate state transitions:

```bash
# Emit signals when running
harpoon project run ./my-workflow --emit-signal
```

Creates signal files in `.harpoon/signals/`:
- `{workflow}.started` - Workflow began execution
- `{workflow}.completed` - Workflow finished successfully
- `{workflow}.failed` - Workflow encountered an error
- `{workflow}.ready` - Outputs are available for downstream workflows

### Input Chaining

Load inputs from previous workflow outputs:

```bash
# From a file path
harpoon project run --input-from ../upstream/.harpoon/outputs/latest.json

# From an alias
harpoon project run --input-from alias:upstream-workflow

# From a specific run
harpoon project run --input-from run:abc123
```

### Wait Conditions

Block execution until signals are present:

```bash
# Wait for upstream workflow to complete
harpoon project run ./downstream \
  --wait-for ../upstream/.harpoon/signals/upstream.ready \
  --timeout 600

# Wait for multiple signals
harpoon project run ./final \
  --wait-for ./step1/.harpoon/signals/step1.ready \
  --wait-for ./step2/.harpoon/signals/step2.ready
```

### Publishing Outputs

Publish outputs to well-known paths for downstream consumption:

```bash
harpoon project run ./my-workflow --publish-to ./outputs/latest.json
```

### Manifest Configuration

Configure orchestration in the manifest:

```yaml
orchestration:
  publish:
    path: .harpoon/outputs/latest.json
    alias: my-workflow

  signals:
    enabled: true
```

## Examples

See the `examples/` directory:

- `hello-world/` - The classic get your feet wet demo
- `tools-demo/` - Run TypeScript code to get deterministic outputs
- `branching-demo/` - Evaluate a condition and intelligently choose a path
- `looping-demo/` - Sub-workflows allow repetitive execution without violating the DAG
- `workflows-demo/` - Workflows are composable
- `map-demo/` - Parallelize operations over collections
- `trigger-demo/` - Coordinate workflows with signal emission

## License

MIT
