/**
 * `harpoon project validate`: load a project, run validateProject(), print
 * warnings then errors, and return the exit code.
 *
 * Kept apart from src/cli.ts, which parses process.argv when imported, so
 * tests can call the command directly.
 */

import { ExitCode } from "./errors.js";
import { loadProject } from "./project.js";
import { formatDiagnostics, validateProject } from "./validate.js";

/** Options for cmdProjectValidate(). */
export interface ProjectValidateOptions {
  /** Fail on warnings as well as errors. */
  strict: boolean;
}

/**
 * Validate the project at `projectPath`.
 *
 * Returns ExitCode.VALIDATION_ERROR when there is any error, or any warning
 * under `strict`; otherwise ExitCode.SUCCESS. A project that cannot be loaded
 * throws its ParseError or ValidationError, which the CLI's main() reports
 * with the same exit code.
 */
export async function cmdProjectValidate(
  projectPath: string,
  options: ProjectValidateOptions
): Promise<number> {
  const project = loadProject(projectPath);
  const result = await validateProject(project, { strict: options.strict });
  const { errors, warnings, dag } = result;

  process.stdout.write(`Project: ${project.name}\n`);
  process.stdout.write(`  Prompts: ${Object.keys(project.prompts).length}\n`);
  process.stdout.write(`  Tools: ${Object.keys(project.tools).length}\n`);
  process.stdout.write(`  Agents: ${Object.keys(project.agents).length}\n`);
  process.stdout.write(`  Branches: ${Object.keys(project.branches).length}\n`);
  process.stdout.write(`  Maps: ${Object.keys(project.maps).length}\n`);
  process.stdout.write(`  Edges: ${Object.keys(project.edges).length}\n`);
  if (dag) {
    process.stdout.write(`  Nodes in execution order: ${dag.executionOrder.length}\n`);
  }
  process.stdout.write("\n");

  if (warnings.length > 0) {
    process.stdout.write(`Warnings (${warnings.length}):\n`);
    process.stdout.write(`${formatDiagnostics(warnings, "!")}\n\n`);
  }

  if (errors.length > 0) {
    process.stderr.write(`Validation failed: ${errors.length} error(s)\n`);
    process.stderr.write(`${formatDiagnostics(errors, "x")}\n`);
    return ExitCode.VALIDATION_ERROR;
  }

  if (!result.valid) {
    process.stderr.write(
      `Validation failed: ${warnings.length} warning(s) in strict mode\n`
    );
    return ExitCode.VALIDATION_ERROR;
  }

  process.stdout.write("Validation passed\n");
  return ExitCode.SUCCESS;
}
