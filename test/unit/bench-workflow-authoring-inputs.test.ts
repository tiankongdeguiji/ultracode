/** Fixed cohort and host-specific prompt boundary coverage. */
import { describe, expect, it } from 'vitest';
import { loadAuthoringCohort } from '../../bench/src/suites/workflow-authoring/inputs.js';
import {
  composeAuthoringPrompt,
  loadCodexDoctrineSnapshot,
} from '../../bench/src/suites/workflow-authoring/prompt.js';
import { DEFAULT_BENCH_PATH_ROOTS, artifactKey } from '../../bench/src/shared/paths.js';

describe('workflow-authoring inputs', () => {
  it('pins the exact 50 Pro, 10 FeatureBench, and 5 Marathon cohort', () => {
    const cohort = loadAuthoringCohort(DEFAULT_BENCH_PATH_ROOTS);
    expect(cohort.tasks).toHaveLength(65);
    expect(cohort.tasks.filter((task) => task.suite === 'swebench-pro')).toHaveLength(50);
    expect(cohort.tasks.filter((task) => task.suite === 'featurebench')).toHaveLength(10);
    expect(cohort.tasks.filter((task) => task.suite === 'swe-marathon')).toHaveLength(5);
    expect(cohort.sources.featureBench.parquetSha256).toBe(
      'e8a704f83d673e1cc78086eefb76bd56461ead8a65ca06fd6972f7363be8a775',
    );
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
    expect(codex).toContain('These are decision principles, not a workflow template');
    expect(claude).not.toContain('These are decision principles, not a workflow template');
    expect(codex).not.toContain('999');
    expect(claude).not.toContain('999');
    expect(doctrine.sha256).toMatch(/^[a-f0-9]{64}$/u);
  });
});
