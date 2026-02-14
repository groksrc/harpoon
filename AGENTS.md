# Guide for AI Agents Working on Harpoon

This document contains instructions for AI agents (like Claude) contributing to the Harpoon project.

## Documentation Hygiene

When making changes to Harpoon, follow these documentation practices:

### 1. Keep Documentation In Sync

**CRITICAL:** When you modify code, always update relevant documentation in the same commit.

- **Added a new CLI flag?** → Update `SKILL.md` with usage examples
- **Added a new feature?** → Update `README.md` if user-facing, or create feature docs in `docs/`
- **Changed behavior?** → Update all affected documentation
- **Added a new event type?** → Update `docs/TELEMETRY.md` event schema
- **Changed API?** → Update examples and reference docs

### 2. Documentation Structure

```
harpoon/
├── README.md                    # Project overview, quick start, high-level concepts
├── SKILL.md                     # Complete workflow authoring guide
├── AGENTS.md                    # This file - instructions for AI agents
├── docs/
│   ├── TELEMETRY.md            # Telemetry usage and reference
│   ├── TELEMETRY_PLAN.md       # Telemetry implementation plan
│   ├── TELEMETRY_VERIFICATION.md  # Telemetry verification guide
│   └── [feature].md            # Additional feature-specific documentation
├── src/
│   ├── cli.ts                  # CLI entry point
│   ├── index.ts                # Main exports
│   └── [feature]/              # Feature modules
└── package.json                # npm dependencies and scripts
```

### 3. Documentation Update Checklist

Before completing a PR, verify:

- [ ] All modified code has corresponding doc updates
- [ ] New features have usage examples
- [ ] README.md table of contents is updated if structure changed
- [ ] Code examples in docs are tested and working
- [ ] Links between docs are valid (use relative paths)
- [ ] CHANGELOG.md is updated (if it exists)

### 4. Documentation Standards

**Format:**
- Use GitHub-flavored Markdown
- Include code examples with language tags: ```bash, ```typescript, ```json
- Use relative links: `[TELEMETRY.md](./docs/TELEMETRY.md)` not absolute URLs
- Include a table of contents for docs >200 lines

**Style:**
- Write in second person ("You can...") for guides
- Use present tense
- Be concise but complete
- Include "Quick Start" sections
- Provide both simple and advanced examples

**Code Examples:**
- Must be runnable/testable
- Include expected output when relevant
- Show both success and error cases
- Use realistic but simple examples

### 5. Common Documentation Tasks

#### Adding a New Feature

1. Implement the feature with tests
2. Add usage example to `SKILL.md`
3. If complex, create `docs/FEATURE.md`
4. Update `README.md` if user-facing
5. Add to feature list in README

#### Modifying Existing Behavior

1. Update implementation and tests
2. Search docs for references: `grep -r "old-behavior" docs/`
3. Update all affected documentation
4. Verify examples still work
5. Update error messages in docs if they changed

#### Adding CLI Flags

1. Add flag to `src/cli.ts` using Commander.js
2. Add usage to `SKILL.md` "Running Workflows" section
3. Add example command showing the flag
4. Document in relevant feature docs (e.g., `docs/TELEMETRY.md`)

### 6. Testing Documentation

Before committing:

```bash
# Test all bash examples in docs
cd docs
grep -h "^```bash" *.md | grep -v "^#" | bash -n

# Check for broken relative links
find docs -name "*.md" -exec grep -H "\[.*\](\..*)" {} \;

# Run tests
npm run test

# Build the project
npm run build
```

### 7. Writing New Documentation

When creating new documentation:

**Structure:**
```markdown
# Feature Name

Brief one-sentence description.

## Overview

What is this? Why does it exist? What problem does it solve?

## Quick Start

Simplest possible example (3-5 lines).

## Features

Bullet list of key capabilities.

## Usage

### Basic Usage
Common case with example.

### Advanced Usage
More complex scenarios.

## Configuration

All options with descriptions.

## Examples

Multiple real-world examples.

## Troubleshooting

Common issues and solutions.

## Related

Links to related docs.
```

### 8. Verification Artifacts

For major features, consider creating:

1. **Verification Guide** (`docs/FEATURE_VERIFICATION.md`)
   - How to verify the feature works
   - What to look for
   - Expected output
   - Manual testing steps
   - Example commands to test functionality

### 9. Anti-Patterns to Avoid

❌ **Don't:**
- Add code without updating docs
- Create orphaned documentation
- Write docs that are longer than needed
- Include untested code examples
- Use absolute URLs for internal links
- Duplicate information across multiple docs
- Write implementation details in user docs

✅ **Do:**
- Update docs in the same commit as code
- Link related documents
- Keep examples concise and runnable
- Test every code example
- Use relative links
- Reference single source of truth
- Separate user docs from implementation docs

### 10. Documentation Review

When reviewing your own changes:

1. **Completeness:** Did you document everything a user needs?
2. **Accuracy:** Are all examples tested and working?
3. **Clarity:** Can someone unfamiliar understand it?
4. **Navigation:** Are related docs linked?
5. **Maintenance:** Will this be easy to update later?

### 11. Special Cases

#### Breaking Changes
- Add clear "Breaking Changes" section
- Provide migration guide with examples
- Update all affected documentation
- Mark deprecated features

#### Experimental Features
- Mark clearly as "Experimental" or "Beta"
- Document stability expectations
- Provide feedback mechanism

#### Internal Features
- Document in code comments, not user docs
- If exposed, add to advanced section

## Example: Documentation Update for New Feature

Suppose you add a `--parallel-limit` flag:

### Files to Update

1. **`src/cli.ts`** (using Commander.js)
   ```typescript
   program
     .command("run")
     .option(
       "--parallel-limit <number>",
       "Maximum parallel node executions (default: 10)",
       "10"
     )
     .action(async (options) => {
       // Implementation
     });
   ```

2. **`SKILL.md`** (add to "Running Workflows" section)
   ```markdown
   # Limit parallel execution
   harpoon run ./my-project \
     --input '{"date": "2026-01-05"}' \
     --parallel-limit 5
   ```

3. **`README.md`** (add to feature list if significant)
   ```markdown
   - **Configurable parallelism** - Control max parallel node execution
   ```

4. **Commit message:**
   ```
   Add --parallel-limit flag for controlling parallelism

   - Limits maximum concurrent node executions
   - Defaults to 10 (existing behavior)
   - Updated SKILL.md with usage example
   ```

## TypeScript-Specific Guidelines

### Type Safety

- Always update type definitions when changing APIs
- Include JSDoc comments for exported functions and types
- Document breaking changes in type signatures

### Testing

- Use `vitest` for unit tests
- Place tests alongside source files with `.test.ts` suffix
- Run `npm run test` before committing
- Aim for high coverage on modified code

### Building

- Run `npm run build` to compile TypeScript to JavaScript
- Verify the build succeeds before committing
- Check that type errors are resolved: `npm run type-check`

## Questions?

If uncertain about documentation:
- Look at existing docs for patterns
- When in doubt, add more examples
- Better to over-document than under-document
- User-facing changes ALWAYS need docs

## Summary

**The Golden Rule:** Code without documentation is incomplete. Documentation without tested examples is untrustworthy. Always update both together.
