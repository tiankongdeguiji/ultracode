/** Load the frozen prompt-only cohort and its lightweight prepared task texts. */
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import type { BenchPathRoots } from '../../shared/contracts.js';
import {
  artifactKey,
  readRegularFileWithinRoot,
  validateTaskId,
} from '../../shared/paths.js';
import { canonicalJson } from '../../shared/provenance.js';
import type {
  AuthoringSourceSuite,
  AuthoringTask,
  GoldPatchStats,
} from './types.js';

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);
const sourceSuiteSchema = z.enum(['swebench-pro', 'featurebench', 'swe-marathon']);
const sourcesSchema = z.strictObject({
  swebenchPro: z.strictObject({
    dataset: z.literal('ScaleAI/SWE-bench_Pro'),
    revision: z.literal('7ab5114912baf22bb098818e604c02fe7ad2c11f'),
    parquetSha256: z.literal('c8cd7115496ad4e9a8b21d088cef576a65bf821bb542b24336f13f714cef13f8'),
  }),
  featureBench: z.strictObject({
    dataset: z.literal('LiberCoders/FeatureBench'),
    revision: z.literal('e99d6efdfe511ea832c1b5735c536129561ec96a'),
    parquetSha256: z.literal('e8a704f83d673e1cc78086eefb76bd56461ead8a65ca06fd6972f7363be8a775'),
  }),
  sweMarathon: z.strictObject({
    repository: z.literal('https://github.com/abundant-ai/swe-marathon.git'),
    revision: z.literal('6d6855af390226f6eca607d63818fe076e57ea8c'),
  }),
});

const cohortTaskSchema = z.strictObject({
  suite: sourceSuiteSchema,
  taskId: z.string().transform(validateTaskId),
});

const cohortSchema = z.strictObject({
  schemaVersion: z.literal(2),
  kind: z.literal('ultracode-workflow-authoring-cohort'),
  selection: z.strictObject({
    seed: z.literal('workflow-authoring-v2'),
    swebenchPro: z.literal('proportional-by-repository'),
    featureBench: z.literal('one-task-from-each-of-ten-diverse-repositories'),
    sweMarathon: z.literal('five-distinct-workload-archetypes'),
  }),
  sources: sourcesSchema,
  tasks: z.array(cohortTaskSchema).length(65),
}).superRefine((cohort, context) => {
  const qualified = cohort.tasks.map((task) => `${task.suite}:${task.taskId}`);
  if (new Set(qualified).size !== qualified.length) {
    context.addIssue({ code: 'custom', path: ['tasks'], message: 'authoring cohort task IDs must be unique' });
  }
  const counts = new Map<AuthoringSourceSuite, number>([
    ['swebench-pro', 0],
    ['featurebench', 0],
    ['swe-marathon', 0],
  ]);
  cohort.tasks.forEach((task) => counts.set(task.suite, counts.get(task.suite)! + 1));
  if (counts.get('swebench-pro') !== 50
    || counts.get('featurebench') !== 10
    || counts.get('swe-marathon') !== 5) {
    context.addIssue({
      code: 'custom',
      path: ['tasks'],
      message: 'authoring cohort must contain exactly 50 Pro, 10 FeatureBench, and 5 Marathon tasks',
    });
  }
});

const goldPatchStatsSchema = z.strictObject({
  files: z.number().int().nonnegative(),
  additions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
});

const preparedInputsSchema = z.strictObject({
  schemaVersion: z.literal(2),
  kind: z.literal('ultracode-workflow-authoring-inputs'),
  cohortSha256: sha256Schema,
  sources: sourcesSchema,
  tasks: z.array(z.strictObject({
    sourceSuite: sourceSuiteSchema,
    taskId: z.string().transform(validateTaskId),
    taskBody: z.string().min(1),
    goldPatchStats: goldPatchStatsSchema.nullable(),
  })).length(65),
});

interface CohortTask {
  suite: AuthoringSourceSuite;
  taskId: string;
}

export interface AuthoringCohort {
  bytes: Buffer;
  sha256: string;
  sources: z.infer<typeof sourcesSchema>;
  tasks: CohortTask[];
}

export interface PreparedAuthoringInputs {
  schemaVersion: 2;
  kind: 'ultracode-workflow-authoring-inputs';
  cohortSha256: string;
  sources: AuthoringCohort['sources'];
  tasks: Array<{
    sourceSuite: AuthoringSourceSuite;
    taskId: string;
    taskBody: string;
    goldPatchStats: GoldPatchStats | null;
  }>;
}

function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

export const authoringCacheDirectory = (roots: BenchPathRoots): string =>
  join(roots.cacheRoot, 'workflow-authoring');
export const authoringInputsFile = (roots: BenchPathRoots): string =>
  join(authoringCacheDirectory(roots), 'inputs-v2.json');
export const authoringProParquetFile = (roots: BenchPathRoots): string =>
  join(authoringCacheDirectory(roots), 'swebench-pro.parquet');
export const authoringFeatureParquetFile = (roots: BenchPathRoots): string =>
  join(authoringCacheDirectory(roots), 'featurebench.parquet');

export function loadAuthoringCohort(roots: BenchPathRoots): AuthoringCohort {
  const relativePath = 'suites/workflow-authoring/cohort.json';
  const bytes = readRegularFileWithinRoot(roots.benchRoot, relativePath);
  const parsed = cohortSchema.parse(JSON.parse(bytes.toString('utf8')));
  return {
    bytes,
    sha256: sha256(bytes),
    sources: parsed.sources,
    tasks: parsed.tasks,
  };
}

function selectedCohortTasks(
  cohort: AuthoringCohort,
  requested: readonly string[] | undefined,
): CohortTask[] {
  if (requested === undefined) return cohort.tasks;
  if (new Set(requested).size !== requested.length) throw new Error('duplicate --task-id values');
  const byQualified = new Map(cohort.tasks.map((task) => [`${task.suite}:${task.taskId}`, task]));
  const unknown = requested.filter((taskId) => !byQualified.has(taskId));
  if (unknown.length > 0) {
    throw new Error(`unknown workflow-authoring task IDs: ${unknown.join(', ')}`);
  }
  return requested.map((taskId) => byQualified.get(taskId)!);
}

/** Resolve exact task statements from the lightweight, content-pinned input snapshot. */
export function loadAuthoringTasks(
  roots: BenchPathRoots,
  requested?: readonly string[],
): { cohort: AuthoringCohort; inputsSha256: string; tasks: AuthoringTask[] } {
  const cohort = loadAuthoringCohort(roots);
  const file = authoringInputsFile(roots);
  if (!existsSync(file)) {
    throw new Error('workflow-authoring inputs are missing; run npm run bench -- --suite workflow-authoring prepare');
  }
  const bytes = readRegularFileWithinRoot(
    authoringCacheDirectory(roots),
    'inputs-v2.json',
  );
  const prepared = preparedInputsSchema.parse(
    JSON.parse(bytes.toString('utf8')),
  ) as PreparedAuthoringInputs;
  if (prepared.cohortSha256 !== cohort.sha256
    || canonicalJson(prepared.sources) !== canonicalJson(cohort.sources)) {
    throw new Error('workflow-authoring prepared inputs do not match the tracked cohort');
  }
  const expected = cohort.tasks.map((task) => `${task.suite}:${task.taskId}`);
  const observed = prepared.tasks.map((task) => `${task.sourceSuite}:${task.taskId}`);
  if (canonicalJson(observed) !== canonicalJson(expected)) {
    throw new Error('workflow-authoring prepared task order does not match the tracked cohort');
  }
  const byQualified = new Map(prepared.tasks.map((task) => [
    `${task.sourceSuite}:${task.taskId}`,
    task,
  ]));
  const tasks = selectedCohortTasks(cohort, requested).map((selected) => {
    const qualifiedTaskId = `${selected.suite}:${selected.taskId}`;
    const preparedTask = byQualified.get(qualifiedTaskId);
    if (preparedTask === undefined) throw new Error(`prepared authoring task is missing: ${qualifiedTaskId}`);
    return {
      sourceSuite: selected.suite,
      taskId: selected.taskId,
      qualifiedTaskId,
      key: artifactKey(qualifiedTaskId),
      taskBody: preparedTask.taskBody,
      taskBodySha256: sha256(preparedTask.taskBody),
      goldPatchStats: preparedTask.goldPatchStats,
    };
  });
  return { cohort, inputsSha256: sha256(bytes), tasks };
}
