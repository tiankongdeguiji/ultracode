/** Exact FeatureBench native evidence indexing and official score interpretation. */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Arm } from '../../shared/contracts.js';
import {
  createVerifierBinding,
  UNVERIFIED_NATIVE_RESULT,
  type NativeVerifierResult,
  type VerifierBinding,
} from '../../shared/verifier.js';
import {
  readRegularFileWithinRoot,
  validateRelativeArtifactPath,
} from '../../shared/paths.js';
import { canonicalJson, sha256Buffer } from '../../shared/provenance.js';

const TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}__\d{2}-\d{2}-\d{2}$/;

export interface FeatureBenchAggregate {
  passRate: number;
  resolvedRate: number;
  completedTasks: number;
  requestedTasks: number;
  artifact: { path: string; sha256: string; nativeRecordKey: string };
}

export interface IndexedFeatureBenchEvidence {
  bindings: VerifierBinding[];
  taskResults: Map<string, NativeVerifierResult>;
  aggregate: FeatureBenchAggregate | null;
}

function record(value: unknown, description: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`FeatureBench ${description} must be an object`);
  }
  return value as Record<string, unknown>;
}

function json(
  runDirectory: string,
  path: string,
  description: string,
): { value: Record<string, unknown>; sha256: string } {
  try {
    const bytes = readRegularFileWithinRoot(runDirectory, path);
    return {
      value: record(JSON.parse(bytes.toString('utf8')) as unknown, description),
      sha256: sha256Buffer(bytes),
    };
  } catch (error) {
    throw new Error(`FeatureBench ${description} is malformed: ${path}`, { cause: error });
  }
}

function boundedRate(value: unknown, description: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`FeatureBench ${description} must be a bounded rate`);
  }
  return value;
}

function integer(value: unknown, description: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`FeatureBench ${description} must be a nonnegative integer`);
  }
  return value;
}

function sameSet(actual: readonly string[], expected: readonly string[]): boolean {
  return actual.length === expected.length
    && canonicalJson([...actual].sort()) === canonicalJson([...expected].sort());
}

function taskIdFromNativePath(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  return /(?:^|\/)run_outputs\/([^/]+)\/attempt-1\/infer\.log$/u.exec(value)?.[1] ?? null;
}

/** Require resume identity to remain the original full ordered task inventory. */
export function validateFeatureBenchRunMetadata(
  value: unknown,
  expectedTaskIds: readonly string[],
): void {
  const metadata = record(value, 'run metadata');
  if (!Array.isArray(metadata.task_ids)
    || !metadata.task_ids.every((taskId): taskId is string => typeof taskId === 'string')
    || canonicalJson(metadata.task_ids) !== canonicalJson(expectedTaskIds)) {
    throw new Error('FeatureBench run_metadata.task_ids does not equal the immutable full task order');
  }
}

function taskResult(
  runDirectory: string,
  path: string,
  taskId: string,
  arm: Arm,
  invocationId: string,
  bindings: VerifierBinding[],
): NativeVerifierResult {
  try {
    const observed = json(runDirectory, path, 'task report');
    const report = observed.value;
    if (Object.keys(report).length !== 1 || !Object.hasOwn(report, taskId)) {
      throw new Error('FeatureBench task report identity mismatch');
    }
    const task = record(report[taskId], 'task report record');
    if (task.n_attempt !== 1 || task.featurebench_eval_completed !== true || typeof task.resolved !== 'boolean') {
      throw new Error('FeatureBench task report completion fields are invalid');
    }
    const passRate = boundedRate(task.pass_rate, 'task pass_rate');
    const binding = createVerifierBinding(runDirectory, {
      invocationId,
      scope: { kind: 'task-arm', taskId, arm },
      role: 'task-report',
      path: validateRelativeArtifactPath(path),
      nativeRecordKey: `${taskId}.pass_rate`,
    }, observed.sha256);
    bindings.push(binding, createVerifierBinding(runDirectory, {
      invocationId,
      scope: { kind: 'task-arm', taskId, arm },
      role: 'completion-marker',
      path: validateRelativeArtifactPath(path),
      nativeRecordKey: `${taskId}.featurebench_eval_completed`,
    }, observed.sha256));
    return {
      verification: 'verified',
      score: passRate,
      resolved: task.resolved,
      artifact: { path: binding.path, sha256: binding.sha256, nativeRecordKey: binding.nativeRecordKey },
    };
  } catch {
    return UNVERIFIED_NATIVE_RESULT;
  }
}

function aggregateResult(
  runDirectory: string,
  path: string,
  taskIds: readonly string[],
  arm: Arm,
  taskResults: ReadonlyMap<string, NativeVerifierResult>,
  invocationId: string,
  bindings: VerifierBinding[],
): FeatureBenchAggregate | null {
  try {
    const observed = json(runDirectory, path, 'aggregate report');
    const report = observed.value;
    if (Object.keys(report).length !== 1 || !Object.hasOwn(report, 'attempt_1')) {
      throw new Error('FeatureBench aggregate must contain only attempt_1');
    }
    const aggregate = record(report.attempt_1, 'attempt_1 aggregate');
    const requested = taskIds.length;
    const total = integer(aggregate.total_instances, 'total_instances');
    const submitted = integer(aggregate.submitted_instances, 'submitted_instances');
    const completed = integer(aggregate.completed_instances, 'completed_instances');
    const resolved = integer(aggregate.resolved_instances, 'resolved_instances');
    const unresolved = integer(aggregate.unresolved_instances, 'unresolved_instances');
    const passRate = boundedRate(aggregate.pass_rate, 'aggregate pass_rate');
    const resolvedRate = boundedRate(aggregate.resolved_rate, 'aggregate resolved_rate');
    if (aggregate.n_attempt !== 1 || total !== requested || submitted !== requested || completed !== requested
      || resolved + unresolved !== requested) {
      throw new Error('FeatureBench aggregate counts do not cover the immutable task inventory');
    }
    for (const field of ['submitted_ids', 'completed_ids'] as const) {
      const values = aggregate[field];
      if (!Array.isArray(values)) throw new Error(`FeatureBench aggregate ${field} is missing`);
      const observed = values.map(taskIdFromNativePath);
      if (observed.some((taskId) => taskId === null) || !sameSet(observed as string[], taskIds)) {
        throw new Error(`FeatureBench aggregate ${field} does not match the immutable task inventory`);
      }
    }
    const nativeTasks = taskIds.map((taskId) => taskResults.get(taskId) ?? UNVERIFIED_NATIVE_RESULT);
    if (nativeTasks.some((result) => result.verification !== 'verified')) {
      throw new Error('FeatureBench aggregate has incomplete per-task evidence');
    }
    const resolvedCount = nativeTasks.filter((result) => result.resolved).length;
    const taskMean = nativeTasks.reduce((sum, result) => sum + result.score!, 0) / requested;
    const rounded = (value: number): number => Math.round(value * 10_000) / 10_000;
    if (resolved !== resolvedCount || rounded(resolvedCount / requested) !== rounded(resolvedRate)
      || rounded(taskMean) !== rounded(passRate)) {
      throw new Error('FeatureBench aggregate rates disagree with bound per-task reports');
    }
    const binding = createVerifierBinding(runDirectory, {
      invocationId,
      scope: { kind: 'suite-check', name: `featurebench-attempt-1-${arm}` },
      role: 'aggregate-report',
      path: validateRelativeArtifactPath(path),
      nativeRecordKey: 'attempt_1',
    }, observed.sha256);
    bindings.push(binding);
    return {
      passRate,
      resolvedRate,
      completedTasks: completed,
      requestedTasks: requested,
      artifact: { path: binding.path, sha256: binding.sha256, nativeRecordKey: binding.nativeRecordKey! },
    };
  } catch {
    return null;
  }
}

function timestampRoot(nativeRoot: string): string {
  const components = nativeRoot.split('/');
  if (components.length !== 2 || components[0] !== 'native' || !TIMESTAMP_RE.test(components[1]!)) {
    throw new Error(`FeatureBench native invocation is not an exact timestamped directory: ${nativeRoot}`);
  }
  return validateRelativeArtifactPath(nativeRoot);
}

/** Bind exact metadata, predictions, per-task reports, completion, and aggregate. */
export function indexFeatureBenchEvidence(
  runDirectory: string,
  nativeRoot: string,
  taskIds: readonly string[],
  arm: Arm,
  invocationId: string,
  metadataTaskIds: readonly string[] = taskIds,
): IndexedFeatureBenchEvidence {
  const root = timestampRoot(nativeRoot);
  const bindings: VerifierBinding[] = [];
  const taskResults = new Map<string, NativeVerifierResult>();
  const metadataPath = `${root}/run_metadata.json`;
  try {
    const metadata = json(runDirectory, metadataPath, 'run metadata');
    validateFeatureBenchRunMetadata(metadata.value, metadataTaskIds);
    bindings.push(createVerifierBinding(runDirectory, {
      invocationId,
      scope: { kind: 'suite-check', name: `featurebench-run-metadata-${arm}` },
      role: 'run-metadata',
      path: validateRelativeArtifactPath(metadataPath),
      nativeRecordKey: 'task_ids',
    }, metadata.sha256));
  } catch { /* malformed metadata does not suppress other valid native evidence */ }

  const outputPath = `${root}/output.jsonl`;
  if (existsSync(join(runDirectory, ...outputPath.split('/')))) {
    try {
      bindings.push(createVerifierBinding(runDirectory, {
        invocationId,
        scope: { kind: 'suite-check', name: `featurebench-predictions-${arm}` },
        role: 'rollout-output',
        path: validateRelativeArtifactPath(outputPath),
        nativeRecordKey: 'output-jsonl',
      }));
    } catch { /* unsafe or nonregular output remains unbound */ }
  }
  for (const taskId of taskIds) {
    const reportPath = `${root}/eval_outputs/${taskId}/attempt-1/report.json`;
    taskResults.set(taskId, taskResult(runDirectory, reportPath, taskId, arm, invocationId, bindings));
  }
  const aggregate = aggregateResult(
    runDirectory,
    `${root}/report.json`,
    taskIds,
    arm,
    taskResults,
    invocationId,
    bindings,
  );
  return { bindings, taskResults, aggregate };
}
