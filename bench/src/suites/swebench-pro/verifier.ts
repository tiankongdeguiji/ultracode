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
  runBenchProcess,
  type BenchProcessOptions,
  type BenchProcessResult,
} from '../../shared/process.js';
import { sha256CanonicalJson } from '../../shared/provenance.js';
import type { SwebenchProConfig } from './config.js';
import {
  containerPolicySha256,
  evaluatorContainerPolicy,
  type SwebenchProContainerPolicy,
} from './container-policy.js';
import { ArtifactUnsafeError, ownershipUnsafe, ownershipUnsafeAggregate } from './cleanup.js';
import { readPatchArtifact } from './state.js';
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
    try {
      assertArtifactTree(taskDirectory);
    } catch (error) {
      throw new ArtifactUnsafeError(`artifact-unsafe patch tree for ${execution.taskId}/${arm}`, error);
    }
    const patch = readPatchArtifact(taskDirectory);
    if (patch.kind === 'unsafe') {
      throw new ArtifactUnsafeError(`artifact-unsafe patch for ${execution.taskId}/${arm}`, patch.failure);
    }
    if (patch.kind === 'patch') {
      predictions.push({
        instance_id: instance.instanceId,
        patch: patch.patch,
        prefix: arm === 'a' ? 'armA' : 'armB',
      });
    }
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
  Image?: string;
  Config?: { Image?: string; Labels?: Record<string, string> };
  State?: { StartedAt?: string };
  Mounts?: Array<{ Type?: string; Source?: string; Destination?: string }>;
}

export interface EvaluatorImageIdentity {
  reference: string;
  localId: string;
}

function exactEvaluatorRuntime(
  record: EvaluatorContainerInspect,
  outputDirectory: string,
  taskId: string,
  identities: ReadonlyMap<string, EvaluatorImageIdentity>,
): boolean {
  const expected = identities.get(taskId);
  if (expected === undefined || record.Config?.Image !== expected.reference || record.Image !== expected.localId) {
    return false;
  }
  const binds = (record.Mounts ?? []).filter((mount) => mount.Type === 'bind');
  return binds.length === 1
    && binds[0]?.Destination === '/workspace'
    && typeof binds[0].Source === 'string'
    && resolve(binds[0].Source) === resolve(outputDirectory, taskId, 'workspace');
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
    imageIdentities: ReadonlyMap<string, EvaluatorImageIdentity>;
    invocationStartedMs: number;
    nowMs: number;
    maximumAgeMs: number | null;
  },
): string[] {
  return records.flatMap((record) => {
    if (!record.Id || !/^[a-f0-9]{64}$/.test(record.Id) || options.baselineIds.has(record.Id)) return [];
    const labels = record.Config?.Labels ?? {};
    const taskId = labels['ultracode.benchmark.task'] ?? '';
    if (labels['ultracode.benchmark.schema'] !== '2'
      || labels['ultracode.benchmark.suite'] !== 'swebench-pro'
      || labels['ultracode.benchmark.run'] !== options.runId
      || labels['ultracode.benchmark.arm'] !== options.armLabel
      || labels['ultracode.benchmark.invocation'] !== options.invocationId
      || labels['ultracode.benchmark.purpose'] !== 'verifier'
      || labels['ultracode.benchmark.ownership'] !== '1'
      || !options.taskIds.has(taskId)
      || !exactEvaluatorRuntime(record, options.outputDirectory, taskId, options.imageIdentities)) return [];
    const startedAt = Date.parse(record.State?.StartedAt ?? '');
    if (!Number.isFinite(startedAt) || startedAt < options.invocationStartedMs) return [];
    if (options.maximumAgeMs !== null && options.nowMs - startedAt <= options.maximumAgeMs) return [];
    return [record.Id];
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
    imageIdentities: ReadonlyMap<string, EvaluatorImageIdentity>;
    invocationIds?: ReadonlySet<string>;
    invocationStartedMs?: ReadonlyMap<string, number>;
  },
): string[] {
  return records.flatMap((record) => {
    if (!record.Id || !/^[a-f0-9]{64}$/.test(record.Id)) return [];
    const labels = record.Config?.Labels ?? {};
    const taskId = labels['ultracode.benchmark.task'] ?? '';
    const invocationId = labels['ultracode.benchmark.invocation'] ?? '';
    if (labels['ultracode.benchmark.schema'] !== '2'
      || labels['ultracode.benchmark.suite'] !== 'swebench-pro'
      || labels['ultracode.benchmark.run'] !== options.runId
      || labels['ultracode.benchmark.arm'] !== options.armLabel
      || labels['ultracode.benchmark.purpose'] !== 'verifier'
      || labels['ultracode.benchmark.ownership'] !== '1'
      || !options.taskIds.has(taskId)
      || (options.invocationIds !== undefined && !options.invocationIds.has(invocationId))
      || !exactEvaluatorRuntime(record, options.outputDirectory, taskId, options.imageIdentities)) return [];
    if (options.invocationStartedMs !== undefined) {
      const invocationStarted = options.invocationStartedMs.get(invocationId);
      const containerStarted = Date.parse(record.State?.StartedAt ?? '');
      if (invocationStarted === undefined || !Number.isFinite(containerStarted)
        || containerStarted < invocationStarted) return [];
    }
    return [record.Id];
  });
}

export type EvaluatorDocker = (argv: readonly string[], timeoutMs?: number) => Promise<string>;

export type EvaluatorProcessExecutor = (
  command: string,
  argv: readonly string[],
  options: BenchProcessOptions,
) => Promise<BenchProcessResult>;

const EVALUATOR_DOCKER_TIMEOUT_MS = 30_000;

const defaultDocker: EvaluatorDocker = async (argv, timeoutMs = EVALUATOR_DOCKER_TIMEOUT_MS) => (await runBenchProcess('docker', argv, {
  cwd: process.cwd(),
  tailBytes: 64 * 1_024 * 1_024,
  timeoutMs,
})).stdout;

const defaultProcessExecutor: EvaluatorProcessExecutor = runBenchProcess;

async function containerIds(docker: EvaluatorDocker): Promise<Set<string>> {
  const output = await docker(['ps', '-aq', '--no-trunc'], EVALUATOR_DOCKER_TIMEOUT_MS);
  const ids = output.split('\n').map((entry) => entry.trim()).filter(Boolean);
  if (ids.some((id) => !/^[a-f0-9]{64}$/.test(id))) {
    throw new Error('Docker returned an invalid evaluator container id');
  }
  return new Set(ids);
}

async function inspectContainers(docker: EvaluatorDocker): Promise<EvaluatorContainerInspect[]> {
  const ids = [...await containerIds(docker)];
  if (ids.length === 0) return [];
  const parsed = JSON.parse(await docker(['inspect', ...ids], EVALUATOR_DOCKER_TIMEOUT_MS)) as unknown;
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
  imageIdentities: ReadonlyMap<string, EvaluatorImageIdentity>,
  invocationStartedMs: number,
  maximumAgeMs: number | null,
): Promise<void> {
  try {
    const ownershipOptions = {
      outputDirectory,
      baselineIds,
      runId,
      armLabel,
      invocationId,
      taskIds,
      imageIdentities,
      invocationStartedMs,
      nowMs: Date.now(),
      maximumAgeMs,
    };
    const records = await inspectContainers(docker);
    for (const id of ownedEvaluatorContainerIds(records, ownershipOptions)) {
      let removalFailure: unknown;
      try {
        await docker(['rm', '-f', id], EVALUATOR_DOCKER_TIMEOUT_MS);
      } catch (error) {
        removalFailure = error;
      }
      const remaining = await inspectContainers(docker);
      if (remaining.some((record) => record.Id === id)) {
        throw ownershipUnsafeAggregate('evaluator container absence was not proven after removal', [
          removalFailure,
          new Error(`evaluator container remains present: ${id}`),
        ]);
      }
    }
    const remainingOwned = ownedEvaluatorContainerIds(
      await inspectContainers(docker),
      { ...ownershipOptions, nowMs: Date.now() },
    );
    if (remainingOwned.length > 0) {
      throw new Error(`owned evaluator containers remain after cleanup: ${remainingOwned.join(', ')}`);
    }
  } catch (error) {
    throw ownershipUnsafe('unsafe SWE-bench Pro evaluator cleanup', error);
  }
}

async function cleanupPreviousOutput(
  docker: EvaluatorDocker,
  options: Parameters<typeof existingEvaluatorContainerIds>[1],
): Promise<void> {
  try {
    const records = await inspectContainers(docker);
    for (const id of existingEvaluatorContainerIds(records, options)) {
      let removalFailure: unknown;
      try {
        await docker(['rm', '-f', id], EVALUATOR_DOCKER_TIMEOUT_MS);
      } catch (error) {
        removalFailure = error;
      }
      if ((await inspectContainers(docker)).some((record) => record.Id === id)) {
        throw ownershipUnsafeAggregate('previous evaluator container absence was not proven', [
          removalFailure,
          new Error(`previous evaluator container remains present: ${id}`),
        ]);
      }
    }
    const remainingOwned = existingEvaluatorContainerIds(await inspectContainers(docker), options);
    if (remainingOwned.length > 0) {
      throw new Error(`previous evaluator containers remain after cleanup: ${remainingOwned.join(', ')}`);
    }
  } catch (error) {
    throw ownershipUnsafe('unsafe previous SWE-bench Pro evaluator cleanup', error);
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
  imageIdentities: ReadonlyMap<string, EvaluatorImageIdentity>;
  invocationStartedMs: number;
  cleanupPromise?: Promise<void>;
}

const ACTIVE_EVALUATORS = new Set<ActiveEvaluator>();

function trackEvaluator(entry: ActiveEvaluator): void {
  ACTIVE_EVALUATORS.add(entry);
}

async function cleanupTrackedEvaluator(entry: ActiveEvaluator): Promise<void> {
  if (!ACTIVE_EVALUATORS.has(entry)) return;
  entry.cleanupPromise ??= cleanupOwned(
    entry.docker,
    entry.outputDirectory,
    entry.baselineIds,
    entry.runId,
    entry.armLabel,
    entry.invocationId,
    entry.taskIds,
    entry.imageIdentities,
    entry.invocationStartedMs,
    null,
  ).then(() => {
    ACTIVE_EVALUATORS.delete(entry);
  });
  const cleanup = entry.cleanupPromise;
  try {
    await cleanup;
  } finally {
    if (ACTIVE_EVALUATORS.has(entry) && entry.cleanupPromise === cleanup) entry.cleanupPromise = undefined;
  }
}

/** Retry exact evaluator-container cleanup during root fatal handling. */
export async function cleanupActiveSwebenchProEvaluators(): Promise<number> {
  const active = [...ACTIVE_EVALUATORS];
  const settled = await Promise.allSettled(active.map(cleanupTrackedEvaluator));
  const failures = settled.flatMap((result) => result.status === 'rejected' ? [result.reason] : []);
  if (failures.length > 0) {
    throw ownershipUnsafeAggregate('active SWE-bench Pro evaluator cleanup failed', failures);
  }
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
  containerPolicy: SwebenchProContainerPolicy;
  imageIdentities: ReadonlyMap<string, EvaluatorImageIdentity>;
  invocationStartedMs: ReadonlyMap<string, number>;
  docker?: EvaluatorDocker;
  processExecutor?: EvaluatorProcessExecutor;
  processLifecycle?: Pick<BenchProcessOptions,
    'workerScope' | 'onLifecycleToken' | 'onLifecycleStarted' | 'onLifecycleCandidates' | 'onLifecycleRecovered'>;
}

export interface EvaluatorProcessArgvOptions {
  rawSamples: string;
  predictions: string;
  outputDirectory: string;
  policy: string;
  policySha256: string;
  workers: number;
  runId: string;
  armLabel: Arm | 'gold' | 'nullcheck';
  invocationId: string;
}

/** Build the exact pinned evaluator invocation without launching a process. */
export function evaluatorProcessArgv(options: EvaluatorProcessArgvOptions): string[] {
  return [
    'swe_bench_pro_eval.py',
    '--use_local_docker',
    '--num_workers', String(options.workers),
    '--raw_sample_path', options.rawSamples,
    '--patch_path', options.predictions,
    '--output_dir', options.outputDirectory,
    '--scripts_dir', 'run_scripts',
    '--dockerhub_username', DOCKERHUB_USERNAME,
    '--benchmark_run_id', options.runId,
    '--benchmark_arm', options.armLabel,
    '--benchmark_invocation_id', options.invocationId,
    '--benchmark_policy_path', options.policy,
    '--benchmark_policy_sha256', options.policySha256,
  ];
}

export interface EvaluatorPolicyDocument {
  schemaVersion: 2;
  kind: 'ultracode-swebench-pro-evaluator-policy';
  evaluatorRepository: string;
  evaluatorRevision: string;
  strictBooleanVerdicts: true;
  emptyPredictions: 'unverified-no-native-output';
  containerPolicySha256: string;
  containerPolicy: ReturnType<typeof evaluatorContainerPolicy>;
}

/** Exact policy artifact consumed by the patched official evaluator. */
export function evaluatorPolicyDocument(
  config: SwebenchProConfig,
  policy: SwebenchProContainerPolicy,
): EvaluatorPolicyDocument {
  return {
    schemaVersion: 2,
    kind: 'ultracode-swebench-pro-evaluator-policy',
    evaluatorRepository: config.evaluator.repository,
    evaluatorRevision: config.evaluator.revision,
    strictBooleanVerdicts: true,
    emptyPredictions: 'unverified-no-native-output',
    containerPolicySha256: containerPolicySha256(policy),
    containerPolicy: evaluatorContainerPolicy(policy, config.docker),
  };
}

/** Trusted host binding for the complete generated evaluator policy. */
export function evaluatorPolicyDocumentSha256(document: EvaluatorPolicyDocument): string {
  return sha256CanonicalJson(document);
}

/** Parse partial output in finally, keeping process failure separate from verdicts. */
export async function runOfficialEvaluator(options: RunEvaluatorOptions): Promise<EvaluatorRunResult> {
  const docker = options.docker ?? defaultDocker;
  const processExecutor = options.processExecutor ?? defaultProcessExecutor;
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
    imageIdentities: options.imageIdentities,
    invocationIds: new Set(options.invocationStartedMs.keys()),
    invocationStartedMs: options.invocationStartedMs,
  });
  const outputDirectory = resetArtifactDirectory(verifierRoot, outputPath);
  const rawSamples = join(verifierRoot, 'raw-samples.jsonl');
  const predictions = join(verifierRoot, 'predictions.json');
  const invocation = join(verifierRoot, 'invocation.json');
  const policy = join(verifierRoot, 'evaluator-policy.json');
  const policyDocument = evaluatorPolicyDocument(options.config, options.containerPolicy);
  const policySha256 = evaluatorPolicyDocumentSha256(policyDocument);
  generateRawSamples(options.instances, rawSamples);
  replaceArtifactFile(predictions, `${JSON.stringify(options.predictions, null, 2)}\n`);
  replaceArtifactFile(policy, `${JSON.stringify(policyDocument, null, 2)}\n`);
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
  const args = evaluatorProcessArgv({
    rawSamples,
    predictions,
    outputDirectory,
    policy,
    policySha256,
    workers: options.config.concurrency.verifier,
    runId: options.runId,
    armLabel: options.armLabel,
    invocationId: options.invocationId,
  });
  const activeEvaluator: ActiveEvaluator = {
    docker,
    outputDirectory,
    baselineIds,
    runId: options.runId,
    armLabel: options.armLabel,
    invocationId: options.invocationId,
    taskIds,
    imageIdentities: options.imageIdentities,
    invocationStartedMs: startedAt,
  };
  trackEvaluator(activeEvaluator);
  let watchdogCleanup: Promise<void> | null = null;
  let retainedCleanupFailure: unknown;
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
      options.imageIdentities,
      startedAt,
      options.config.timeouts.evaluatorWatchdogMs,
    ).catch(() => { /* The mandatory final cleanup retries and records failure. */ })
      .finally(() => { watchdogCleanup = null; });
  }, Math.min(60_000, options.config.timeouts.evaluatorWatchdogMs));
  try {
    await processExecutor(options.evaluatorPythonBinary, args, {
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
      await cleanupTrackedEvaluator(activeEvaluator);
    } catch (error) {
      retainedCleanupFailure = error;
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

  if (retainedCleanupFailure !== undefined) throw retainedCleanupFailure;

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
