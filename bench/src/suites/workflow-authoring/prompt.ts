/** Host-specific authoring prompts with an identical benchmark task body. */
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import type { BenchPathRoots } from '../../shared/contracts.js';
import { readRegularFileWithinRoot } from '../../shared/paths.js';
import type { AuthoringHost, AuthoringTask } from './types.js';

const CODEX_DOCTRINE_FILES = [
  'skill/ultracode/SKILL.md',
  'skill/ultracode/references/dialect.md',
  'skill/ultracode/references/patterns.md',
  'skill/ultracode/references/coding.md',
  'skill/ultracode/references/portability.md',
] as const;

export interface CodexDoctrineSnapshot {
  sha256: string;
  text: string;
}

export function loadCodexDoctrineSnapshot(roots: BenchPathRoots): CodexDoctrineSnapshot {
  const repositoryRoot = resolve(roots.benchRoot, '..');
  const parts = CODEX_DOCTRINE_FILES.map((path) => {
    const contents = readRegularFileWithinRoot(repositoryRoot, path).toString('utf8');
    return `\n--- ${path} ---\n${contents}`;
  });
  const text = parts.join('');
  return {
    sha256: createHash('sha256').update(text, 'utf8').digest('hex'),
    text,
  };
}

const STATIC_AUTHORING_CONTRACT = `STATIC WORKFLOW AUTHORING EVALUATION.
Do not invoke Workflow, any other tool, a shell, a subagent, or the filesystem.
Do not execute, validate, dry-run, or rehearse the workflow.
Author a workflow.js that would solve the task below if it were executed later.
Return only JavaScript source: no Markdown fence, preface, explanation, or trailing commentary.
Use the host's native portable workflow dialect with a pure-literal export const meta first.
Keep all worker prompts self-contained and preserve every task constraint.
Use bounded, result-driven control flow and fail closed when critical verification is unresolved.
Do not invent token, time, sampling, or coverage caps that the user did not request.`;

export function composeAuthoringPrompt(
  host: AuthoringHost,
  task: AuthoringTask,
  doctrine: CodexDoctrineSnapshot,
): string {
  const doctrineSection = host === 'codex'
    ? `\n\nThe following tracked Codex Ultracode doctrine is authoritative for this authoring run:${doctrine.text}`
    : '';
  return `ultracode

${STATIC_AUTHORING_CONTRACT}

Source suite: ${task.sourceSuite}
Task identity: ${task.taskId}

<task>
${task.taskBody.trim()}
</task>${doctrineSection}
`;
}
