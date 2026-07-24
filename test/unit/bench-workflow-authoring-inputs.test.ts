/** Fixed cohort and host-specific prompt boundary coverage. */
import { describe, expect, it } from 'vitest';
import { loadAuthoringCohort } from '../../bench/src/suites/workflow-authoring/inputs.js';
import {
  composeAuthoringPrompt,
  loadCodexDoctrineSnapshot,
} from '../../bench/src/suites/workflow-authoring/prompt.js';
import { DEFAULT_BENCH_PATH_ROOTS, artifactKey } from '../../bench/src/shared/paths.js';

describe('workflow-authoring inputs', () => {
  it('pins the exact 20 Pro plus one Marathon cohort', () => {
    const cohort = loadAuthoringCohort(DEFAULT_BENCH_PATH_ROOTS);
    expect(cohort.tasks).toHaveLength(21);
    expect(cohort.tasks.filter((task) => task.suite === 'swebench-pro')).toHaveLength(20);
    expect(cohort.tasks.filter((task) => task.suite === 'swe-marathon')).toEqual([
      { suite: 'swe-marathon', taskId: 'kubernetes-rust-rewrite' },
    ]);
    expect(cohort.sha256).toMatch(/^[a-f0-9]{64}$/u);
  });

  it('shares task bytes while injecting tracked doctrine only for Codex', () => {
    const doctrine = loadCodexDoctrineSnapshot(DEFAULT_BENCH_PATH_ROOTS);
    const qualifiedTaskId = 'swebench-pro:fixture';
    const task = {
      sourceSuite: 'swebench-pro' as const,
      taskId: 'fixture',
      qualifiedTaskId,
      key: artifactKey(qualifiedTaskId),
      taskBody: 'Requirements:\n- Keep public interfaces stable.\n',
      taskBodySha256: 'a'.repeat(64),
      goldPatchStats: { files: 99, additions: 999, deletions: 999 },
    };
    const codex = composeAuthoringPrompt('codex', task, doctrine);
    const claude = composeAuthoringPrompt('claude', task, doctrine);
    expect(codex.startsWith('ultracode\n')).toBe(true);
    expect(claude.startsWith('ultracode\n')).toBe(true);
    expect(codex).toContain(task.taskBody.trim());
    expect(claude).toContain(task.taskBody.trim());
    expect(codex).toContain('This guidance is deliberately not a template');
    expect(claude).not.toContain('This guidance is deliberately not a template');
    expect(codex).not.toContain('999');
    expect(claude).not.toContain('999');
    expect(doctrine.sha256).toMatch(/^[a-f0-9]{64}$/u);
  });
});
