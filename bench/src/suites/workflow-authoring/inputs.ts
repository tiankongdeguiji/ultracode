/** Load the fixed prompt-only cohort without exposing task repositories. */
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { z } from 'zod';
import type { BenchPathRoots } from '../../shared/contracts.js';
import {
  artifactKey,
  readRegularFileWithinRoot,
  validateTaskId,
} from '../../shared/paths.js';
import { loadCurrentPreparedMarathonInputs } from '../swe-marathon/prepare.js';
import { instanceFromRow, loadDatasetSnapshot } from '../swebench-pro/instances.js';
import { composeTaskBody } from '../swebench-pro/prompt.js';
import type {
  AuthoringSourceSuite,
  AuthoringTask,
  GoldPatchStats,
} from './types.js';

const cohortSchema = z.strictObject({
  schemaVersion: z.literal(1),
  kind: z.literal('ultracode-workflow-authoring-cohort'),
  tasks: z.array(z.strictObject({
    suite: z.enum(['swebench-pro', 'swe-marathon']),
    taskId: z.string().transform(validateTaskId),
  })).length(21),
}).superRefine((cohort, context) => {
  const qualified = cohort.tasks.map((task) => `${task.suite}:${task.taskId}`);
  if (new Set(qualified).size !== qualified.length) {
    context.addIssue({ code: 'custom', path: ['tasks'], message: 'authoring cohort task IDs must be unique' });
  }
  const pro = cohort.tasks.filter((task) => task.suite === 'swebench-pro').length;
  const marathon = cohort.tasks.filter((task) => task.suite === 'swe-marathon');
  if (pro !== 20 || marathon.length !== 1 || marathon[0]?.taskId !== 'kubernetes-rust-rewrite') {
    context.addIssue({
      code: 'custom',
      path: ['tasks'],
      message: 'authoring cohort must contain the fixed 20 Pro tasks and kubernetes-rust-rewrite',
    });
  }
});

interface CohortTask {
  suite: AuthoringSourceSuite;
  taskId: string;
}

export interface AuthoringCohort {
  bytes: Buffer;
  sha256: string;
  tasks: CohortTask[];
}

function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

export function loadAuthoringCohort(roots: BenchPathRoots): AuthoringCohort {
  const relativePath = 'suites/workflow-authoring/cohort.json';
  const bytes = readRegularFileWithinRoot(roots.benchRoot, relativePath);
  const parsed = cohortSchema.parse(JSON.parse(bytes.toString('utf8')));
  return { bytes, sha256: sha256(bytes), tasks: parsed.tasks };
}

function patchStats(patch: string): GoldPatchStats {
  const lines = patch.split(/\r?\n/u);
  const diffFiles = lines.filter((line) => line.startsWith('diff --git ')).length;
  const fallbackFiles = lines.filter((line) => line.startsWith('+++ ') && line !== '+++ /dev/null').length;
  return {
    files: diffFiles || fallbackFiles,
    additions: lines.filter((line) => line.startsWith('+') && !line.startsWith('+++')).length,
    deletions: lines.filter((line) => line.startsWith('-') && !line.startsWith('---')).length,
  };
}

function selectedCohortTasks(cohort: AuthoringCohort, requested: readonly string[] | undefined): CohortTask[] {
  if (requested === undefined) return cohort.tasks;
  if (new Set(requested).size !== requested.length) throw new Error('duplicate --task-id values');
  const byQualified = new Map(cohort.tasks.map((task) => [`${task.suite}:${task.taskId}`, task]));
  const unknown = requested.filter((taskId) => !byQualified.has(taskId));
  if (unknown.length > 0) {
    throw new Error(`unknown workflow-authoring task IDs: ${unknown.join(', ')}`);
  }
  return requested.map((taskId) => byQualified.get(taskId)!);
}

/** Resolve exact task statements from already-pinned suite inputs. */
export function loadAuthoringTasks(
  roots: BenchPathRoots,
  requested?: readonly string[],
): { cohort: AuthoringCohort; tasks: AuthoringTask[] } {
  const cohort = loadAuthoringCohort(roots);
  const selected = selectedCohortTasks(cohort, requested);
  const proTasks = selected.filter((task) => task.suite === 'swebench-pro');
  const marathonTasks = selected.filter((task) => task.suite === 'swe-marathon');
  const proById = proTasks.length === 0
    ? new Map<string, ReturnType<typeof instanceFromRow>>()
    : new Map(loadDatasetSnapshot(roots).rows.map((row) => {
        const instance = instanceFromRow(row);
        return [instance.instanceId, instance] as const;
      }));
  const marathon = marathonTasks.length === 0 ? null : loadCurrentPreparedMarathonInputs(roots);

  return {
    cohort,
    tasks: selected.map((task) => {
      const qualifiedTaskId = `${task.suite}:${task.taskId}`;
      let taskBody: string;
      let goldPatchStats: GoldPatchStats | null;
      if (task.suite === 'swebench-pro') {
        const instance = proById.get(task.taskId);
        if (instance === undefined) {
          throw new Error(`fixed SWE-bench Pro authoring task is absent from the pinned descriptor: ${task.taskId}`);
        }
        taskBody = composeTaskBody(instance);
        goldPatchStats = patchStats(instance.goldPatch);
      } else {
        if (marathon === null || !marathon.tasks.some((candidate) => candidate.taskId === task.taskId)) {
          throw new Error(`fixed SWE-Marathon authoring task is absent from prepared inputs: ${task.taskId}`);
        }
        taskBody = readRegularFileWithinRoot(
          marathon.sourceDirectory,
          join('tasks', task.taskId, 'instruction.md'),
        ).toString('utf8');
        goldPatchStats = null;
      }
      return {
        sourceSuite: task.suite,
        taskId: task.taskId,
        qualifiedTaskId,
        key: artifactKey(qualifiedTaskId),
        taskBody,
        taskBodySha256: sha256(taskBody),
        goldPatchStats,
      };
    }),
  };
}
