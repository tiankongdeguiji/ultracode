/** Official Pro evaluator execution and strict partial-evidence interpretation. */
import { existsSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import type { Arm, FailureCode } from '../../shared/contracts.js';
import type { SwebenchProManifest } from '../../shared/manifest.js';
import {
  assertArtifactTree,
  ensurePrivateDirectoryWithin,
  readRegularFileWithinRoot,
  replaceArtifactFile,
  resetArtifactDirectory,
} from '../../shared/paths.js';
import {
  BenchProcessError,
  cleanupActiveBenchProcesses,
  runBenchProcess,
  type BenchProcessOptions,
} from '../../shared/process.js';
import type { SwebenchProConfig } from './config.js';
import { BASE_IMAGE_REPOSITORY } from './image.js';
import { readTaskStatus } from './state.js';
import type { EvalPrediction, SwebenchProInstance } from './types.js';

const DOCKERHUB_USERNAME = 'jefzda';

export interface ParsedEvaluatorResults {
  verdicts: Record<string, boolean>;
  malformedTaskIds: string[];
}

/** Accept only explicit native booleans; malformed records are not losses. */
export function parseEvaluatorResults(value: unknown): ParsedEvaluatorResults {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('official evaluator result must be an object');
  }
  const verdicts: Record<string, boolean> = {};
  const malformedTaskIds: string[] = [];
  for (const [taskId, verdict] of Object.entries(value)) {
    if (typeof verdict === 'boolean') verdicts[taskId] = verdict;
    else malformedTaskIds.push(taskId);
  }
  return { verdicts, malformedTaskIds };
}

export function generateRawSamples(instances: readonly SwebenchProInstance[], file: string): void {
  const lines = instances.map((instance) => JSON.stringify({
    instance_id: instance.instanceId,
    repo: instance.repo,
    base_commit: instance.baseCommit,
    before_repo_set_cmd: instance.beforeRepoSetCmd,
    selected_test_files_to_run: instance.selectedTestFilesToRun,
    fail_to_pass: instance.failToPass,
    pass_to_pass: instance.passToPass,
  }));
  replaceArtifactFile(file, `${lines.join('\n')}\n`);
}

/** Collect only safe, manifest-declared non-empty patches. */
export function collectPredictions(
  manifest: SwebenchProManifest,
  runDirectory: string,
  arm: Arm,
  instances: readonly SwebenchProInstance[],
): EvalPrediction[] {
  const byId = new Map(instances.map((instance) => [instance.instanceId, instance]));
  const predictions: EvalPrediction[] = [];
  for (const execution of manifest.artifacts.executions.filter((entry) => entry.arm === arm)) {
    const instance = byId.get(execution.taskId);
    if (!instance) throw new Error(`manifest has no frozen row for ${execution.taskId}`);
    const taskDirectory = join(runDirectory, ...execution.nativeRoot.split('/'));
    if (!existsSync(taskDirectory)) continue;
    assertArtifactTree(taskDirectory);
    const status = readTaskStatus(taskDirectory);
    if (status.failure === 'patch-too-large') continue;
    let patch: string;
    try {
      patch = readRegularFileWithinRoot(taskDirectory, 'out/patch.diff', 10_000_001).toString('utf8');
    } catch {
      continue;
    }
    if (patch.trim()) predictions.push({
      instance_id: instance.instanceId,
      patch,
      prefix: arm === 'a' ? 'armA' : 'armB',
    });
  }
  return predictions;
}

export const goldPredictions = (instances: readonly SwebenchProInstance[]): EvalPrediction[] =>
  instances.map((instance) => ({ instance_id: instance.instanceId, patch: instance.goldPatch, prefix: 'gold' }));

const NULL_PATCH = [
  'diff --git a/ultracode-benchmark-null-check.txt b/ultracode-benchmark-null-check.txt',
  'new file mode 100644',
  '--- /dev/null',
  '+++ b/ultracode-benchmark-null-check.txt',
  '@@ -0,0 +1 @@',
  '+ultracode benchmark null check',
  '',
].join('\n');

export const nullPredictions = (instances: readonly SwebenchProInstance[]): EvalPrediction[] =>
  instances.map((instance) => ({ instance_id: instance.instanceId, patch: NULL_PATCH, prefix: 'nullcheck' }));

export interface EvaluatorContainerInspect {
  Id?: string;
  Config?: { Image?: string; Labels?: Record<string, string> };
  State?: { StartedAt?: string };
  Mounts?: Array<{ Type?: string; Source?: string }>;
}

function exactRepository(image: string): string {
  const withoutDigest = image.split('@')[0]!;
  const slash = withoutDigest.lastIndexOf('/');
  const colon = withoutDigest.lastIndexOf(':');
  return colon > slash ? withoutDigest.slice(0, colon) : withoutDigest;
}

/** Own only post-baseline evaluator containers with an exact contained mount. */
export function ownedEvaluatorContainerIds(
  records: readonly EvaluatorContainerInspect[],
  options: {
    outputDirectory: string;
    baselineIds: ReadonlySet<string>;
    runId: string;
    armLabel: string;
    invocationId: string;
    taskIds: ReadonlySet<string>;
    invocationStartedMs: number;
    nowMs: number;
    maximumAgeMs: number | null;
  },
): string[] {
  const root = resolve(options.outputDirectory);
  return records.flatMap((record) => {
    if (!record.Id || !/^[a-f0-9]{64}$/.test(record.Id) || options.baselineIds.has(record.Id)) return [];
    const image = record.Config?.Image;
    if (!image || exactRepository(image) !== BASE_IMAGE_REPOSITORY) return [];
    const labels = record.Config?.Labels ?? {};
    if (labels['ultracode.benchmark.schema'] !== '2'
      || labels['ultracode.benchmark.suite'] !== 'swebench-pro'
      || labels['ultracode.benchmark.run'] !== options.runId
      || labels['ultracode.benchmark.arm'] !== options.armLabel
      || labels['ultracode.benchmark.invocation'] !== options.invocationId
      || labels['ultracode.benchmark.purpose'] !== 'verifier'
      || labels['ultracode.benchmark.ownership'] !== '1'
      || !options.taskIds.has(labels['ultracode.benchmark.task'] ?? '')) return [];
    const startedAt = Date.parse(record.State?.StartedAt ?? '');
    if (!Number.isFinite(startedAt) || startedAt < options.invocationStartedMs) return [];
    if (options.maximumAgeMs !== null && options.nowMs - startedAt <= options.maximumAgeMs) return [];
    const mountOwned = record.Mounts?.some((mount) => {
      if (mount.Type !== 'bind' || typeof mount.Source !== 'string') return false;
      const fromRoot = relative(root, resolve(mount.Source));
      return fromRoot === '' || (fromRoot !== '..' && !fromRoot.startsWith(`..${sep}`));
    }) ?? false;
    return mountOwned ? [record.Id] : [];
  });
}

/** Recover a previous exact-output evaluator only while the run lease is held. */
export function existingEvaluatorContainerIds(
  records: readonly EvaluatorContainerInspect[],
  options: {
    outputDirectory: string;
    runId: string;
    armLabel: string;
    taskIds: ReadonlySet<string>;
  },
): string[] {
  const root = resolve(options.outputDirectory);
  return records.flatMap((record) => {
    const image = record.Config?.Image;
    if (!record.Id || !/^[a-f0-9]{64}$/.test(record.Id)
      || !image || exactRepository(image) !== BASE_IMAGE_REPOSITORY) return [];
    const labels = record.Config?.Labels ?? {};
    if (labels['ultracode.benchmark.schema'] !== '2'
      || labels['ultracode.benchmark.suite'] !== 'swebench-pro'
      || labels['ultracode.benchmark.run'] !== options.runId
      || labels['ultracode.benchmark.arm'] !== options.armLabel
      || labels['ultracode.benchmark.purpose'] !== 'verifier'
      || labels['ultracode.benchmark.ownership'] !== '1'
      || !options.taskIds.has(labels['ultracode.benchmark.task'] ?? '')) return [];
    const ownsMount = record.Mounts?.some((mount) => {
      if (mount.Type !== 'bind' || typeof mount.Source !== 'string') return false;
      const fromRoot = relative(root, resolve(mount.Source));
      return fromRoot === '' || (fromRoot !== '..' && !fromRoot.startsWith(`..${sep}`));
    }) ?? false;
    return ownsMount ? [record.Id] : [];
  });
}

export type EvaluatorDocker = (argv: readonly string[]) => Promise<string>;

const defaultDocker: EvaluatorDocker = async (argv) => (await runBenchProcess('docker', argv, {
  cwd: process.cwd(),
  tailBytes: 64 * 1_024 * 1_024,
})).stdout;

async function containerIds(docker: EvaluatorDocker): Promise<Set<string>> {
  const output = await docker(['ps', '-aq', '--no-trunc']);
  const ids = output.split('\n').map((entry) => entry.trim()).filter(Boolean);
  if (ids.some((id) => !/^[a-f0-9]{64}$/.test(id))) {
    throw new Error('Docker returned an invalid evaluator container id');
  }
  return new Set(ids);
}

async function inspectContainers(docker: EvaluatorDocker): Promise<EvaluatorContainerInspect[]> {
  const ids = [...await containerIds(docker)];
  if (ids.length === 0) return [];
  const parsed = JSON.parse(await docker(['inspect', ...ids])) as unknown;
  if (!Array.isArray(parsed) || parsed.length !== ids.length
    || parsed.some((record) => record === null || typeof record !== 'object'
      || typeof (record as EvaluatorContainerInspect).Id !== 'string'
      || !/^[a-f0-9]{64}$/.test((record as EvaluatorContainerInspect).Id!)
      || ids.filter((id) => (record as EvaluatorContainerInspect).Id!.startsWith(id)).length !== 1)) {
    throw new Error('Docker inspection did not exactly bind requested evaluator container ids');
  }
  return parsed as EvaluatorContainerInspect[];
}

async function cleanupOwned(
  docker: EvaluatorDocker,
  outputDirectory: string,
  baselineIds: ReadonlySet<string>,
  runId: string,
  armLabel: string,
  invocationId: string,
  taskIds: ReadonlySet<string>,
  invocationStartedMs: number,
  maximumAgeMs: number | null,
): Promise<void> {
  const records = await inspectContainers(docker);
  for (const id of ownedEvaluatorContainerIds(records, {
    outputDirectory,
    baselineIds,
    runId,
    armLabel,
    invocationId,
    taskIds,
    invocationStartedMs,
    nowMs: Date.now(),
    maximumAgeMs,
  })) {
    await docker(['rm', '-f', id]);
  }
}

async function cleanupPreviousOutput(
  docker: EvaluatorDocker,
  options: Parameters<typeof existingEvaluatorContainerIds>[1],
): Promise<void> {
  const records = await inspectContainers(docker);
  for (const id of existingEvaluatorContainerIds(records, options)) {
    await docker(['rm', '-f', id]);
  }
}

interface ActiveEvaluator {
  docker: EvaluatorDocker;
  outputDirectory: string;
  baselineIds: ReadonlySet<string>;
  runId: string;
  armLabel: string;
  invocationId: string;
  taskIds: ReadonlySet<string>;
  invocationStartedMs: number;
}

const ACTIVE_EVALUATORS = new Set<ActiveEvaluator>();
let relayingSignal = false;

const relaySignal = (signal: NodeJS.Signals): void => {
  if (relayingSignal) return;
  relayingSignal = true;
  void cleanupActiveBenchProcesses()
    .then(async () => cleanupActiveSwebenchProEvaluators())
    .finally(() => {
      process.off('SIGINT', onSigint);
      process.off('SIGTERM', onSigterm);
      process.kill(process.pid, signal);
    });
};

const onSigint = (): void => relaySignal('SIGINT');
const onSigterm = (): void => relaySignal('SIGTERM');

function trackEvaluator(entry: ActiveEvaluator): void {
  if (ACTIVE_EVALUATORS.size === 0) {
    process.on('SIGINT', onSigint);
    process.on('SIGTERM', onSigterm);
  }
  ACTIVE_EVALUATORS.add(entry);
}

function untrackEvaluator(entry: ActiveEvaluator): void {
  ACTIVE_EVALUATORS.delete(entry);
  if (ACTIVE_EVALUATORS.size === 0 && !relayingSignal) {
    process.off('SIGINT', onSigint);
    process.off('SIGTERM', onSigterm);
  }
}

/** Retry exact evaluator-container cleanup during root fatal handling. */
export async function cleanupActiveSwebenchProEvaluators(): Promise<number> {
  const active = [...ACTIVE_EVALUATORS];
  let failure: unknown;
  for (const entry of active) {
    try {
      await cleanupOwned(
        entry.docker,
        entry.outputDirectory,
        entry.baselineIds,
        entry.runId,
        entry.armLabel,
        entry.invocationId,
        entry.taskIds,
        entry.invocationStartedMs,
        null,
      );
      untrackEvaluator(entry);
    } catch (error) {
      failure ??= error;
    }
  }
  if (failure !== undefined) throw failure;
  return active.length;
}

export interface EvaluatorRunResult extends ParsedEvaluatorResults {
  resultRelativePath: string | null;
  rawSamplesRelativePath: string;
  predictionsRelativePath: string;
  invocationRelativePath: string;
  policyRelativePath: string;
  processFailure: FailureCode | null;
  startedAt: string;
  endedAt: string;
  elapsedMs: number;
}

export interface RunEvaluatorOptions {
  runDirectory: string;
  evaluatorDirectory: string;
  evaluatorPythonBinary: string;
  config: SwebenchProConfig;
  invocationId: string;
  runId: string;
  armLabel: Arm | 'gold' | 'nullcheck';
  prefix: string;
  predictions: readonly EvalPrediction[];
  instances: readonly SwebenchProInstance[];
  docker?: EvaluatorDocker;
  processLifecycle?: Pick<BenchProcessOptions,
    'workerScope' | 'onLifecycleToken' | 'onLifecycleStarted' | 'onLifecycleRecovered'>;
}

/** Parse partial output in finally, keeping process failure separate from verdicts. */
export async function runOfficialEvaluator(options: RunEvaluatorOptions): Promise<EvaluatorRunResult> {
  const docker = options.docker ?? defaultDocker;
  const verifierRoot = ensurePrivateDirectoryWithin(
    options.runDirectory,
    join(options.runDirectory, 'native', 'verifier', options.prefix),
  );
  const outputPath = join(verifierRoot, 'output');
  const taskIds = new Set(options.instances.map((instance) => instance.instanceId));
  if (existsSync(outputPath)) await cleanupPreviousOutput(docker, {
    outputDirectory: outputPath,
    runId: options.runId,
    armLabel: options.armLabel,
    taskIds,
  });
  const outputDirectory = resetArtifactDirectory(verifierRoot, outputPath);
  const rawSamples = join(verifierRoot, 'raw-samples.jsonl');
  const predictions = join(verifierRoot, 'predictions.json');
  const invocation = join(verifierRoot, 'invocation.json');
  const policy = join(verifierRoot, 'evaluator-policy.json');
  generateRawSamples(options.instances, rawSamples);
  replaceArtifactFile(predictions, `${JSON.stringify(options.predictions, null, 2)}\n`);
  replaceArtifactFile(policy, `${JSON.stringify({
    schemaVersion: 2,
    evaluatorRepository: options.config.evaluator.repository,
    evaluatorRevision: options.config.evaluator.revision,
    strictBooleanVerdicts: true,
    emptyPredictions: 'unverified-no-native-output',
  }, null, 2)}\n`);
  const relativePath = (path: string): string => relative(options.runDirectory, path).split(sep).join('/');
  const initialTime = new Date().toISOString();
  const baseResult = {
    verdicts: {},
    malformedTaskIds: [],
    resultRelativePath: null,
    rawSamplesRelativePath: relativePath(rawSamples),
    predictionsRelativePath: relativePath(predictions),
    invocationRelativePath: relativePath(invocation),
    policyRelativePath: relativePath(policy),
    processFailure: null,
    startedAt: initialTime,
    endedAt: initialTime,
    elapsedMs: 0,
  } satisfies EvaluatorRunResult;
  if (options.predictions.length === 0) {
    replaceArtifactFile(invocation, `${JSON.stringify({
      schemaVersion: 2,
      invocationId: options.invocationId,
      launched: false,
      reason: 'empty-predictions',
    }, null, 2)}\n`);
    return baseResult;
  }

  const baselineIds = await containerIds(docker);
  const startedAt = Date.now();
  let processFailure: FailureCode | null = null;
  let exitCode = 0;
  const args = [
    'swe_bench_pro_eval.py',
    '--use_local_docker',
    '--num_workers', String(options.config.concurrency.verifier),
    '--raw_sample_path', rawSamples,
    '--patch_path', predictions,
    '--output_dir', outputDirectory,
    '--scripts_dir', 'run_scripts',
    '--dockerhub_username', DOCKERHUB_USERNAME,
    '--benchmark_run_id', options.runId,
    '--benchmark_arm', options.armLabel,
    '--benchmark_invocation_id', options.invocationId,
  ];
  const activeEvaluator: ActiveEvaluator = {
    docker,
    outputDirectory,
    baselineIds,
    runId: options.runId,
    armLabel: options.armLabel,
    invocationId: options.invocationId,
    taskIds,
    invocationStartedMs: startedAt,
  };
  trackEvaluator(activeEvaluator);
  let watchdogCleanup: Promise<void> | null = null;
  const watchdog = setInterval(() => {
    if (watchdogCleanup !== null) return;
    watchdogCleanup = cleanupOwned(
      docker,
      outputDirectory,
      baselineIds,
      options.runId,
      options.armLabel,
      options.invocationId,
      taskIds,
      startedAt,
      options.config.timeouts.evaluatorWatchdogMs,
    ).catch(() => { /* The mandatory final cleanup retries and records failure. */ })
      .finally(() => { watchdogCleanup = null; });
  }, Math.min(60_000, options.config.timeouts.evaluatorWatchdogMs));
  try {
    await runBenchProcess(options.evaluatorPythonBinary, args, {
      cwd: options.evaluatorDirectory,
      stream: true,
      timeoutMs: options.config.timeouts.verifierMs,
      tailBytes: 64 * 1_024,
      ...options.processLifecycle,
    });
  } catch (error) {
    exitCode = error instanceof BenchProcessError ? error.result.exitCode ?? -1 : -1;
    processFailure = error instanceof BenchProcessError && /timed out/.test(error.message)
      ? 'verifier-timeout'
      : error instanceof BenchProcessError && /descendant cleanup failed/.test(error.message)
        ? 'descendant-cleanup-failed'
      : 'verifier-process-failed';
  } finally {
    clearInterval(watchdog);
    await watchdogCleanup;
    try {
      await cleanupOwned(
        docker,
        outputDirectory,
        baselineIds,
        options.runId,
        options.armLabel,
        options.invocationId,
        taskIds,
        startedAt,
        null,
      );
      untrackEvaluator(activeEvaluator);
    } catch {
      processFailure ??= 'verifier-process-failed';
    }
    replaceArtifactFile(invocation, `${JSON.stringify({
      schemaVersion: 2,
      invocationId: options.invocationId,
      launched: true,
      startedAt: new Date(startedAt).toISOString(),
      endedAt: new Date().toISOString(),
      exitCode,
      baselineContainerIds: [...baselineIds].sort(),
    }, null, 2)}\n`);
  }

  const resultFile = join(outputDirectory, 'eval_results.json');
  const endedAt = Date.now();
  const timing = {
    startedAt: new Date(startedAt).toISOString(),
    endedAt: new Date(endedAt).toISOString(),
    elapsedMs: Math.max(0, endedAt - startedAt),
  };
  if (!existsSync(resultFile)) return { ...baseResult, ...timing, processFailure };
  let parsed: ParsedEvaluatorResults;
  try {
    parsed = parseEvaluatorResults(JSON.parse(readRegularFileWithinRoot(outputDirectory, 'eval_results.json').toString('utf8')));
  } catch {
    return { ...baseResult, ...timing, processFailure: processFailure ?? 'verifier-output-malformed' };
  }
  const submitted = new Set(options.predictions.map((prediction) => prediction.instance_id));
  const verdicts = Object.fromEntries(Object.entries(parsed.verdicts).filter(([taskId]) => submitted.has(taskId)));
  return {
    ...baseResult,
    ...timing,
    verdicts,
    malformedTaskIds: parsed.malformedTaskIds.filter((taskId) => submitted.has(taskId)),
    resultRelativePath: relativePath(resultFile),
    processFailure,
  };
}
