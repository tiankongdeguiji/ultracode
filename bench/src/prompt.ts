/**
 * Prompt composition for the two arms. The task body is built ONLY from the
 * instance's problem statement, requirements, and interface — goldPatch,
 * testPatch, failToPass, and passToPass must never reach a prompt (the
 * anti-leak guarantee, asserted in test/unit/bench-prompt.test.ts). Arm 'a'
 * gets the bare body; arm 'b' prepends the literal "ultracode" trigger prefix
 * that routes the session through the multi-agent workflow, so the two arms
 * differ by exactly that prefix.
 */
import { CONTAINER_REPO_DIR } from './config.js';
import type { Arm, BenchInstance } from './types.js';

/** Arm-b preamble; must start with the literal keyword "ultracode" to arm the mode. */
export const ARM_B_PREFIX =
  'ultracode: route the task below through a multi-agent workflow. The ultracode MCP tools (workflow_start/workflow_status/workflow_result) are available. Use backend "codex" and permission "danger" (this container is the sandbox).\n\n';

const INSTRUCTIONS = [
  `The repository is at ${CONTAINER_REPO_DIR}, already checked out at the correct commit with its test environment installed.`,
  `Implement the fix in the ${CONTAINER_REPO_DIR} working tree.`,
  'Do NOT commit, branch, or write patch/diff files — leave all changes uncommitted in the working tree.',
  'You may run the repository\'s tests to validate your work.',
]
  .map((line) => `- ${line}`)
  .join('\n');

/** Arm-agnostic task body: statement, optional sections, fixed instructions block. */
export function composeTaskBody(inst: BenchInstance): string {
  let body = inst.problemStatement;
  if (inst.requirements) body += `\n\n## Requirements\n${inst.requirements}`;
  if (inst.interface) body += `\n\n## Interface\n${inst.interface}`;
  return `${body}\n\n## Instructions\n${INSTRUCTIONS}`;
}

/** Arm 'a' = bare task body; arm 'b' = ARM_B_PREFIX + the identical body. */
export function composePrompt(inst: BenchInstance, arm: Arm): string {
  const body = composeTaskBody(inst);
  return arm === 'b' ? ARM_B_PREFIX + body : body;
}
