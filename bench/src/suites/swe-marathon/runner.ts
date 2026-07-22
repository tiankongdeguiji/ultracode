/** SWE-Marathon lifecycle on shared v2 state, metrics, receipt, and report services. */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { existsSync, lstatSync, realpathSync, renameSync, rmSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import type { Arm, BenchPathRoots, CommandContext, FailureCode } from '../../shared/contracts.js';
import { FAILURE_POLICY_SHA256, failureObservationSchema, taskArmScope } from '../../shared/failure.js';
import {
  acquireBenchLock,
  assertRecoveredClaimOwnsRunDirectory,
  clearClaimedRunDirectory,
  markClaimedRunDirectory,
  type BenchLockHandle,
} from '../../shared/locks.js';
import {
  MANIFEST_POLICY_SHA256,
  loadBenchRunManifest,
  writeBenchRunManifest,
  type SweMarathonManifest,
} from '../../shared/manifest.js';
import { DEFAULT_METRICS_POLICY, METRICS_POLICY_SHA256, normalizeBenchMetrics } from '../../shared/metrics.js';
import {
  artifactKey,
  createPrivateRunDirectory,
  ensurePrivateDirectoryWithin,
  manifestFile,
  reportJsonFile,
  reportMarkdownFile,
  resetArtifactDirectory,
  runClaimFile,
  runDir,
  runLeaseFile,
  validateRelativeArtifactPath,
  validateRunId,
} from '../../shared/paths.js';
import { BenchProcessError, runBenchProcess } from '../../shared/process.js';
import { canonicalJson, sha256CanonicalJson, sha256File } from '../../shared/provenance.js';
import {
  REPORT_POLICY_SHA256,
  buildBenchReport,
  loadStoredReportEvidence,
  writeBenchReport,
  type SuiteAnalysisHook,
  type TaskReportInput,
} from '../../shared/report.js';
import { BenchRunStateStore, type BenchRunState } from '../../shared/run-state.js';
import {
  UNVERIFIED_NATIVE_RESULT,
  VerifierReceiptStore,
  type NativeVerifierResult,
  type VerifierBinding,
} from '../../shared/verifier.js';
import { ARM_B_PREFIX_PATH } from '../../shared/prompt.js';
import {
  assertMarathonRuntimeBinding,
  cleanupMarathonRuntimeHomes,
  createMarathonRuntimeHome,
} from './auth.js';
import {
  EXCLUDED_CUA_TASKS,
  SWE_MARATHON_DATASET,
  SWE_MARATHON_SPLIT,
  SWE_MARATHON_TASKS,
  loadSweMarathonOperatorConfig,
  resolveSweMarathonConfig,
  validateSweMarathonConfig,
  validateMarathonTaskId,
  type SweMarathonConfig,
} from './config.js';
import {
  preflightMarathonPreparation,
  prepareMarathonInputs,
  type MarathonTaskInput,
} from './prepare.js';
import {
  attestMarathonCommon,
  attestMarathonTask,
  type MarathonCommonAttestation,
} from './provenance.js';
import { indexSweMarathonMetrics } from './telemetry.js';
import { indexHarborEvidence, validateHarborResume, type HarborExecutionIdentity } from './verifier.js';

const TOOLCHAIN_CACHE_LOCK = '.locks/toolchain.lock';
const SUITE_CACHE_LOCK = '.locks/swe-marathon.lock';
const BRIDGE_CLASS = 'arm_b_codex:ArmBCodex';
const CLEANUP_DOCKER_TIMEOUT_MS = 30_000;

interface PrepOptions { recoverStaleLock: boolean }
interface RunOptions {
  runId: string;
  resume: boolean;
  redo: readonly string[];
  recoverStaleLock: boolean;
  model?: string;
  requestedEffort?: string;
  arm?: 'a' | 'b';
  taskIds?: readonly string[];
}
interface ReportOptions { runId: string; recoverStaleLock: boolean }

export const SWE_MARATHON_ADAPTER_POLICY_SHA256 = sha256CanonicalJson({
  schemaVersion: 2,
  layout: 'suite-run/native/tasks/artifact-key',
  arm: 'one-per-run',
  jobs: 'one-task-per-native-harbor-job',
  attestation: 'common-once-task-immediate-linear',
  verifier: 'native-harbor-reward-only-exact-direct-child',
  lifecycle: 'owned-process-group-and-exact-container-labels',
  credentials: 'runtime-only-ephemeral-home',
});

export interface HarborRunPlan {
  command: string;
  argv: string[];
  cwd: string;
  jobRelativeRoot: string;
  mounts: Array<{ type: 'bind'; source: string; target: string; read_only: true }>;
}

function output(context: CommandContext, value: string): void {
  context.stdout.write(`${value}\n`);
}

async function acquireInputLocks(roots: BenchPathRoots, recoverStale: boolean): Promise<BenchLockHandle[]> {
  const locks = [await acquireBenchLock(roots.cacheRoot, join(roots.cacheRoot, TOOLCHAIN_CACHE_LOCK), { recoverStale })];
  try {
    locks.push(await acquireBenchLock(roots.cacheRoot, join(roots.cacheRoot, SUITE_CACHE_LOCK), { recoverStale }));
    return locks;
  } catch (error) {
    locks[0]!.release();
    throw error;
  }
}

function releaseLocks(locks: readonly BenchLockHandle[]): void {
  let failure: unknown;
  for (const lock of [...locks].reverse()) {
    try { lock.release(); } catch (error) { failure ??= error; }
  }
  if (failure !== undefined) throw failure;
}

function sourcePolicyHash(roots: BenchPathRoots, semanticSha256: string, paths: readonly string[]): string {
  return sha256CanonicalJson({
    semanticSha256,
    sources: paths.map((path) => ({ path, sha256: sha256File(join(roots.benchRoot, ...path.split('/'))) })),
  });
}

function currentControlPlaneHashes(roots: BenchPathRoots): SweMarathonManifest['provenance']['controlPlane'] {
  return {
    manifestPolicySha256: sourcePolicyHash(roots, MANIFEST_POLICY_SHA256, ['src/shared/manifest.ts']),
    metricsPolicySha256: sourcePolicyHash(roots, METRICS_POLICY_SHA256, ['src/shared/metrics.ts', 'src/shared/jsonl.ts']),
    failurePolicySha256: sourcePolicyHash(roots, FAILURE_POLICY_SHA256, ['src/shared/failure.ts']),
    reportPolicySha256: sourcePolicyHash(roots, REPORT_POLICY_SHA256, ['src/shared/report.ts']),
    adapterPolicySha256: sourcePolicyHash(roots, SWE_MARATHON_ADAPTER_POLICY_SHA256, [
      'src/cli.ts',
      'src/shared/config.ts',
      'src/shared/contracts.ts',
      'src/shared/locks.ts',
      'src/shared/metrics.ts',
      'src/shared/options.ts',
      'src/shared/paths.ts',
      'src/shared/process.ts',
      'src/shared/prompt.ts',
      'src/shared/provenance.ts',
      'src/shared/report.ts',
      'src/shared/run-state-ledger.ts',
      'src/shared/run-state.ts',
      'src/shared/toolchain.ts',
      'src/shared/verifier.ts',
      '../src/exec/procinfo.ts',
      '../src/exec/spawn.ts',
      'src/suites/swe-marathon/adapter.ts',
      'src/suites/swe-marathon/auth.ts',
      'src/suites/swe-marathon/config.ts',
      'src/suites/swe-marathon/prepare.ts',
      'src/suites/swe-marathon/provenance.ts',
      'src/suites/swe-marathon/runner.ts',
      'src/suites/swe-marathon/telemetry.ts',
      'src/suites/swe-marathon/verifier.ts',
    ]),
  };
}

function policies(
  roots: BenchPathRoots,
  tasks: readonly MarathonTaskInput[],
  adapterSha256: string,
): SweMarathonManifest['suiteConfig']['policies'] {
  return {
    excludedTasksSha256: sha256CanonicalJson(EXCLUDED_CUA_TASKS),
    tasksSha256: sha256CanonicalJson(SWE_MARATHON_TASKS),
    resourcesSha256: sha256CanonicalJson(tasks.map((task) => ({
      taskId: task.taskId,
      configSha256: task.configSha256,
      image: task.imageResolvedDigest,
      platform: task.imagePlatform,
    }))),
    bridgeSha256: sha256CanonicalJson({
      bridge: sha256File(join(roots.benchRoot, 'suites', 'swe-marathon', 'arm_b_codex.py')),
      prefix: sha256File(ARM_B_PREFIX_PATH),
      ownership: sha256File(join(roots.benchRoot, 'suites', 'swe-marathon', 'harbor-ownership.patch')),
      class: BRIDGE_CLASS,
    }),
    adapterSha256,
  };
}

function pricing(config: SweMarathonConfig): SweMarathonManifest['pricing'] {
  const selected = config.pricing?.[config.model];
  return selected === undefined ? null : { currency: 'USD', model: config.model, ...selected };
}

function assertPreparedNativeAssets(roots: BenchPathRoots, common: MarathonCommonAttestation): void {
  const suite = join(roots.benchRoot, 'suites', 'swe-marathon');
  if (common.prepared.ownershipPatchSha256 !== sha256File(join(suite, 'harbor-ownership.patch'))
    || common.prepared.bridgeSha256 !== sha256File(join(suite, 'arm_b_codex.py'))) {
    throw new Error('prepared SWE-Marathon native assets are stale; rerun prep');
  }
}

function buildManifest(
  roots: BenchPathRoots,
  runId: string,
  config: SweMarathonConfig,
  common: MarathonCommonAttestation,
  now: Date,
): SweMarathonManifest {
  assertPreparedNativeAssets(roots, common);
  const selected = config.taskIds.map((taskId) => {
    const task = common.prepared.tasks.find((candidate) => candidate.taskId === taskId);
    if (!task) throw new Error(`prepared SWE-Marathon task is missing: ${taskId}`);
    return task;
  });
  const controlPlane = currentControlPlaneHashes(roots);
  const nativeAssets = [
    'suites/swe-marathon/arm_b_codex.py',
    'suites/swe-marathon/harbor-ownership.patch',
    relative(roots.benchRoot, ARM_B_PREFIX_PATH).split(sep).join('/'),
  ].map((path) => ({ path: validateRelativeArtifactPath(path), sha256: sha256File(join(roots.benchRoot, ...path.split('/'))) }));
  return {
    schemaVersion: 2,
    kind: 'ultracode-benchmark-run',
    suite: 'swe-marathon',
    runId: validateRunId(runId),
    createdAt: now.toISOString(),
    experiment: { model: config.model, requestedEffort: config.requestedEffort, arm: config.arm, taskIds: [...config.taskIds] },
    limits: {
      hostTaskTimeoutMs: config.timeouts.taskMs,
      hostVerifierTimeoutMs: null,
      taskConcurrency: 1,
      verifierConcurrency: 1,
    },
    metricsPolicy: { ...DEFAULT_METRICS_POLICY, implementationSha256: controlPlane.metricsPolicySha256 },
    pricing: pricing(config),
    provenance: {
      toolchain: common.prepared.toolchain.provenance,
      controlPlane,
      suiteSource: common.prepared.source,
      dataset: {
        identity: SWE_MARATHON_DATASET,
        revision: `source:${common.prepared.source.revision}`,
        split: SWE_MARATHON_SPLIT,
        snapshotSha256: sha256CanonicalJson(selected.map((task) => ({ taskId: task.taskId, configSha256: task.configSha256 }))),
      },
      environment: {
        platform: process.platform,
        architecture: process.arch,
        nodeVersion: process.version,
        pythonVersion: common.prepared.pythonVersion,
        environmentSha256: common.prepared.environmentSha256,
      },
      nativeAssets,
      tasks: selected.map((task) => ({
        taskId: task.taskId,
        sourceSha256: task.configSha256,
        image: {
          requested: task.imageRequested,
          resolvedDigest: task.imageResolvedDigest,
          base: { localId: task.imageLocalId, platform: task.imagePlatform },
          overlay: { name: task.imageResolvedDigest, localId: task.imageLocalId, platform: task.imagePlatform },
        },
      })),
    },
    artifacts: {
      nativeRoot: 'native',
      runState: 'run-state.json',
      verifierReceipt: 'verifier-receipt.json',
      reportJson: 'report.json',
      reportMarkdown: 'report.md',
      executions: config.taskIds.map((taskId) => {
        const key = artifactKey(taskId);
        return { taskId, arm: config.arm, key, nativeRoot: validateRelativeArtifactPath(`native/tasks/${key}`) };
      }),
    },
    suiteConfig: {
      preparedInputSha256: common.preparedIdentity,
      auth: {
        mechanism: config.auth.mechanism,
        publicIdentitySha256: createHash('sha256').update(config.auth.publicIdentity, 'utf8').digest('hex'),
      },
      workflowWaitMs: config.workflowWaitMs,
      bridgeClass: BRIDGE_CLASS,
      oneTaskPerJob: true,
      attempts: 1,
      retries: 0,
      policies: policies(roots, selected, controlPlane.adapterPolicySha256),
    },
  };
}

function overrideConfig(config: SweMarathonConfig, options: RunOptions): SweMarathonConfig {
  const resolved = {
    ...config,
    ...(options.model === undefined ? {} : { model: options.model }),
    ...(options.requestedEffort === undefined ? {} : { requestedEffort: options.requestedEffort }),
    ...(options.arm === undefined ? {} : { arm: options.arm }),
    ...(options.taskIds === undefined ? {} : { taskIds: [...options.taskIds] }),
  };
  const parsed = resolveSweMarathonConfig({
    schemaVersion: 2,
    toolchain: { nodeVersion: '0.0.0', nodeDistribution: 'nodejs', codexBinary: 'unused' },
    sweMarathon: config,
  }, resolved);
  validateSweMarathonConfig(parsed);
  return parsed;
}

function resumeConfig(operator: SweMarathonConfig, manifest: SweMarathonManifest): SweMarathonConfig {
  const config: SweMarathonConfig = {
    ...operator,
    model: manifest.experiment.model,
    requestedEffort: manifest.experiment.requestedEffort,
    arm: manifest.experiment.arm as Arm,
    taskIds: [...manifest.experiment.taskIds],
    workflowWaitMs: manifest.suiteConfig.workflowWaitMs,
    auth: { ...operator.auth, mechanism: manifest.suiteConfig.auth.mechanism },
    timeouts: {
      taskMs: manifest.limits.hostTaskTimeoutMs!,
    },
    pricing: manifest.pricing === null ? undefined : {
      [manifest.pricing.model]: {
        uncachedInputPerMTokens: manifest.pricing.uncachedInputPerMTokens,
        cachedInputPerMTokens: manifest.pricing.cachedInputPerMTokens,
        outputPerMTokens: manifest.pricing.outputPerMTokens,
      },
    },
  };
  const identity = createHash('sha256').update(config.auth.publicIdentity, 'utf8').digest('hex');
  if (identity !== manifest.suiteConfig.auth.publicIdentitySha256) {
    throw new Error('runtime credential public identity does not match the immutable manifest');
  }
  return config;
}

function assertResumeOptions(options: RunOptions, manifest: SweMarathonManifest): void {
  const checks: Array<[string, unknown, unknown]> = [
    ['model', options.model, manifest.experiment.model],
    ['effort', options.requestedEffort, manifest.experiment.requestedEffort],
    ['arm', options.arm, manifest.experiment.arm],
  ];
  if (options.taskIds !== undefined) checks.push(['task-id', canonicalJson(options.taskIds), canonicalJson(manifest.experiment.taskIds)]);
  for (const [name, actual, expected] of checks) {
    if (actual !== undefined && actual !== expected) throw new Error(`--${name} does not match the immutable manifest`);
  }
}

function assertProvenance(
  roots: BenchPathRoots,
  manifest: SweMarathonManifest,
  common: MarathonCommonAttestation,
): void {
  const selected = manifest.experiment.taskIds.map((taskId) => common.prepared.tasks.find((task) => task.taskId === taskId)!);
  const currentControl = currentControlPlaneHashes(roots);
  assertPreparedNativeAssets(roots, common);
  if (canonicalJson(common.prepared.toolchain.provenance) !== canonicalJson(manifest.provenance.toolchain)
    || common.preparedIdentity !== manifest.suiteConfig.preparedInputSha256
    || canonicalJson(common.prepared.source) !== canonicalJson(manifest.provenance.suiteSource)
    || common.prepared.environmentSha256 !== manifest.provenance.environment.environmentSha256
    || canonicalJson(currentControl) !== canonicalJson(manifest.provenance.controlPlane)
    || canonicalJson(policies(roots, selected, currentControl.adapterPolicySha256)) !== canonicalJson(manifest.suiteConfig.policies)) {
    throw new Error('SWE-Marathon execution provenance drifted after manifest creation');
  }
}

async function initializeRun(
  roots: BenchPathRoots,
  manifest: SweMarathonManifest,
  recoverStale: boolean,
  claim: BenchLockHandle,
): Promise<{ lease: BenchLockHandle; state: BenchRunStateStore; receipt: VerifierReceiptStore }> {
  const directory = createPrivateRunDirectory(roots, 'swe-marathon', manifest.runId);
  let lease: BenchLockHandle | null = null;
  try {
    markClaimedRunDirectory(directory, claim);
    lease = await acquireBenchLock(roots.resultsRoot, runLeaseFile(roots, 'swe-marathon', manifest.runId), {
      recoverStale,
      createParent: false,
    });
    writeBenchRunManifest(roots, manifest);
    const manifestSha256 = sha256File(manifestFile(roots, 'swe-marathon', manifest.runId));
    const state = new BenchRunStateStore(roots, 'swe-marathon', manifest.runId, manifestSha256, lease);
    const receipt = new VerifierReceiptStore(roots, 'swe-marathon', manifest.runId, manifestSha256, lease);
    state.initialize();
    receipt.initialize();
    ensurePrivateDirectoryWithin(directory, join(directory, 'native', 'tasks'));
    clearClaimedRunDirectory(directory, claim);
    return { lease, state, receipt };
  } catch (error) {
    lease?.release();
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}

async function loadRunStores(
  roots: BenchPathRoots,
  runId: string,
  recoverStale: boolean,
): Promise<{ manifest: SweMarathonManifest; lease: BenchLockHandle; state: BenchRunStateStore; receipt: VerifierReceiptStore }> {
  const lease = await acquireBenchLock(roots.resultsRoot, runLeaseFile(roots, 'swe-marathon', runId), {
    recoverStale,
    createParent: false,
  });
  try {
    const manifest = loadBenchRunManifest(roots, 'swe-marathon', runId) as SweMarathonManifest;
    const manifestSha256 = sha256File(manifestFile(roots, 'swe-marathon', runId));
    const state = new BenchRunStateStore(roots, 'swe-marathon', runId, manifestSha256, lease);
    state.migrateLegacyIfNeeded();
    await state.recoverPendingLifecycleProcesses(runDir(roots, 'swe-marathon', runId));
    if (state.load().invocations.some((invocation) => invocation.endedAt === null)) {
      for (const taskId of manifest.experiment.taskIds) {
        await cleanupMarathonContainers(
          marathonRunScope(runDir(roots, 'swe-marathon', runId)),
          manifest.runId,
          taskId,
          manifest.experiment.arm as Arm,
        );
      }
      await state.closeInterruptedInvocations();
    }
    return {
      manifest,
      lease,
      state,
      receipt: new VerifierReceiptStore(roots, 'swe-marathon', runId, manifestSha256, lease),
    };
  } catch (error) {
    lease.release();
    throw error;
  }
}

async function beginInvocation(state: BenchRunStateStore, command: 'run' | 'report', now: Date): Promise<string> {
  const invocationId = randomUUID();
  await state.updateCurrent((current) => ({
    ...current,
    invocations: [...current.invocations, {
      invocationId,
      command,
      startedAt: now.toISOString(),
      endedAt: null,
      activeElapsedMs: null,
      exitCode: null,
      signal: null,
      lifecycleProcesses: [],
      failure: null,
      nativeInvocation: validateRelativeArtifactPath('native'),
    }],
  }));
  return invocationId;
}

async function finishInvocation(
  state: BenchRunStateStore,
  invocationId: string,
  startedMs: number,
  now: Date,
  failure: FailureCode | null = null,
): Promise<void> {
  await state.updateCurrent((current) => ({
    ...current,
    invocations: current.invocations.map((entry) => entry.invocationId === invocationId ? {
      ...entry,
      endedAt: now.toISOString(),
      activeElapsedMs: Math.max(0, performance.now() - startedMs),
      exitCode: failure === null ? 0 : 1,
      failure,
    } : entry),
  }));
}

/** Build one native Harbor invocation; credentials never enter the plan or argv. */
export function planHarborRun(
  _roots: BenchPathRoots,
  runDirectory: string,
  manifest: SweMarathonManifest,
  common: MarathonCommonAttestation,
  taskId: string,
  resume: boolean,
): HarborRunPlan {
  const execution = manifest.artifacts.executions.find((candidate) => candidate.taskId === taskId)!;
  const mounts = [{
    type: 'bind' as const,
    source: join(common.prepared.toolchain.directory, 'codex'),
    target: '/usr/local/bin/codex',
    read_only: true as const,
  }];
  if (manifest.experiment.arm === 'b') {
    for (const name of ['node-sel', 'node', 'node-musl', 'node-musl-runtime', 'ultracode']) {
      mounts.push({
        type: 'bind',
        source: join(common.prepared.toolchain.directory, name),
        target: `/opt/bench/${name}`,
        read_only: true,
      });
    }
  }
  const jobDirectory = join(runDirectory, ...execution.nativeRoot.split('/'));
  const argv = resume ? ['job', 'resume', '--path', jobDirectory] : [
    'run',
    '--path', 'tasks',
    '--include-task-name', taskId,
    '--agent', manifest.experiment.arm === 'a' ? 'codex' : BRIDGE_CLASS,
    '--model', manifest.experiment.model,
    '--agent-kwarg', `reasoning_effort=${manifest.experiment.requestedEffort}`,
    '--agent-kwarg', 'web_search=disabled',
    ...(manifest.experiment.arm === 'b' ? [
      '--agent-kwarg', `workflow_wait_seconds=${Math.ceil(manifest.suiteConfig.workflowWaitMs / 1_000)}`,
      '--skill', join(common.prepared.toolchain.directory, 'agents-home-b', 'skills', 'ultracode'),
    ] : []),
    '--allow-agent-host', 'api.openai.com',
    '--allow-agent-host', 'chatgpt.com',
    '--allow-agent-host', 'auth.openai.com',
    '--env', 'docker',
    '--mounts', JSON.stringify(mounts),
    '--n-concurrent', '1',
    '--n-concurrent-agents', '1',
    '--n-attempts', '1',
    '--max-retries', '0',
    '--jobs-dir', join(runDirectory, 'native', 'tasks'),
    '--job-name', execution.key,
    '--yes',
  ];
  return {
    command: common.prepared.harborBinary,
    argv,
    cwd: common.prepared.sourceDirectory,
    jobRelativeRoot: execution.nativeRoot,
    mounts,
  };
}

/** Hash a canonical run root into a non-secret Docker/runtime ownership namespace. */
export function marathonRunScope(runDirectory: string): string {
  return createHash('sha256').update(realpathSync(runDirectory), 'utf8').digest('hex');
}

function labelEnvironment(
  rootScope: string,
  runId: string,
  taskId: string,
  arm: Arm,
  runtimeNonce: string,
): Record<string, string> {
  return {
    ULTRACODE_BENCHMARK_SCHEMA: '2',
    ULTRACODE_BENCHMARK_SUITE: 'swe-marathon',
    ULTRACODE_BENCHMARK_ROOT: rootScope,
    ULTRACODE_BENCHMARK_RUN: runId,
    ULTRACODE_BENCHMARK_TASK: taskId,
    ULTRACODE_BENCHMARK_ARM: arm,
    ULTRACODE_BENCHMARK_PURPOSE: 'session',
    ULTRACODE_BENCHMARK_OWNERSHIP: '1',
    ULTRACODE_BENCHMARK_RUNTIME: runtimeNonce,
  };
}

interface ContainerInspect {
  Id?: string;
  Config?: { Labels?: Record<string, string> };
}

interface ActiveMarathonExecution {
  rootScope: string;
  runId: string;
  taskId: string;
  arm: Arm;
  cleanupRuntime(): void;
  cleanupPromise?: Promise<void>;
}

const activeExecutions = new Map<string, ActiveMarathonExecution>();

function trackExecution(key: string, execution: ActiveMarathonExecution): void {
  if (activeExecutions.has(key)) throw new Error(`SWE-Marathon execution is already tracked: ${key}`);
  activeExecutions.set(key, execution);
}

async function cleanupTrackedExecution(key: string): Promise<void> {
  const execution = activeExecutions.get(key);
  if (execution === undefined) return;
  execution.cleanupPromise ??= (async () => {
    const failures: unknown[] = [];
    try {
      await cleanupMarathonContainers(execution.rootScope, execution.runId, execution.taskId, execution.arm);
    } catch (error) {
      failures.push(error);
    }
    try {
      execution.cleanupRuntime();
    } catch (error) {
      failures.push(error);
    }
    if (failures.length > 0) throw new AggregateError(failures, 'SWE-Marathon active execution cleanup failed');
    activeExecutions.delete(key);
  })();
  const cleanup = execution.cleanupPromise;
  try {
    await cleanup;
  } finally {
    if (activeExecutions.get(key) === execution && execution.cleanupPromise === cleanup) {
      execution.cleanupPromise = undefined;
    }
  }
}

/** Settle every tracked Harbor container set and exact credential runtime. */
export async function cleanupSweMarathonRuntime(): Promise<void> {
  const keys = [...activeExecutions.keys()];
  const settled = await Promise.allSettled(keys.map(cleanupTrackedExecution));
  const failures = settled.flatMap((result) => result.status === 'rejected' ? [result.reason] : []);
  if (failures.length > 0) throw new AggregateError(failures, 'SWE-Marathon runtime cleanup failed');
}

/** Remove only containers bearing the complete exact ownership label tuple. */
export async function cleanupMarathonContainers(
  rootScope: string,
  runId: string,
  taskId: string,
  arm: Arm,
): Promise<number> {
  if (!/^[a-f0-9]{64}$/.test(rootScope)) throw new Error('invalid SWE-Marathon root scope');
  const expected = {
    ULTRACODE_BENCHMARK_SCHEMA: '2',
    ULTRACODE_BENCHMARK_SUITE: 'swe-marathon',
    ULTRACODE_BENCHMARK_ROOT: rootScope,
    ULTRACODE_BENCHMARK_RUN: runId,
    ULTRACODE_BENCHMARK_TASK: taskId,
    ULTRACODE_BENCHMARK_ARM: arm,
    ULTRACODE_BENCHMARK_PURPOSE: 'session',
    ULTRACODE_BENCHMARK_OWNERSHIP: '1',
  };
  const filters = Object.entries(expected).flatMap(([name, value]) => [
    '--filter', `label=${name.replace(/^ULTRACODE_BENCHMARK_/, 'ultracode.benchmark.').toLowerCase().replaceAll('_', '-')}=${value}`,
  ]);
  const listed = await runBenchProcess('docker', ['ps', '-aq', ...filters], {
    cwd: process.cwd(),
    tailBytes: 8 * 1_024 * 1_024,
    timeoutMs: CLEANUP_DOCKER_TIMEOUT_MS,
  });
  const ids = listed.stdout.split('\n').map((value) => value.trim()).filter(Boolean);
  if (ids.some((id) => !/^[a-f0-9]{12,64}$/.test(id))) {
    throw new Error('Docker returned an invalid Harbor container id');
  }
  let removed = 0;
  for (const id of ids) {
    const inspected = await runBenchProcess('docker', ['inspect', id], {
      cwd: process.cwd(),
      tailBytes: 8 * 1_024 * 1_024,
      timeoutMs: CLEANUP_DOCKER_TIMEOUT_MS,
    });
    const rows = JSON.parse(inspected.stdout) as ContainerInspect[];
    const inspectedId = rows.length === 1 ? rows[0]?.Id : undefined;
    const labels = rows.length === 1 ? rows[0]?.Config?.Labels ?? {} : {};
    if (typeof inspectedId !== 'string' || !/^[a-f0-9]{64}$/.test(inspectedId) || !inspectedId.startsWith(id)) {
      throw new Error(`Docker inspection did not uniquely bind Harbor container ${id}`);
    }
    const exact = {
      schema: labels['ultracode.benchmark.schema'],
      suite: labels['ultracode.benchmark.suite'],
      root: labels['ultracode.benchmark.root'],
      run: labels['ultracode.benchmark.run'],
      task: labels['ultracode.benchmark.task'],
      arm: labels['ultracode.benchmark.arm'],
      purpose: labels['ultracode.benchmark.purpose'],
      ownership: labels['ultracode.benchmark.ownership'],
    };
    if (canonicalJson(exact) !== canonicalJson({
      schema: '2', suite: 'swe-marathon', root: rootScope,
      run: runId, task: taskId, arm, purpose: 'session', ownership: '1',
    })) throw new Error(`refusing to remove unowned Harbor container ${id}`);
    const runtimeNonce = labels['ultracode.benchmark.runtime'] ?? '';
    if (!/^[a-f0-9]{64}$/.test(runtimeNonce)) throw new Error(`Harbor container ${id} has no valid runtime owner`);
    await runBenchProcess('docker', ['rm', '-f', id], {
      cwd: process.cwd(),
      tailBytes: 8 * 1_024 * 1_024,
      timeoutMs: CLEANUP_DOCKER_TIMEOUT_MS,
    });
    removed += 1;
  }
  cleanupMarathonRuntimeHomes(rootScope, runId, taskId, arm);
  return removed;
}

function executionIdentity(manifest: SweMarathonManifest, taskId: string): HarborExecutionIdentity {
  const execution = manifest.artifacts.executions.find((candidate) => candidate.taskId === taskId)!;
  return {
    taskId,
    arm: execution.arm,
    model: manifest.experiment.model,
    requestedEffort: manifest.experiment.requestedEffort,
    jobRelativeRoot: execution.nativeRoot,
  };
}

/** Keep refreshed native evidence attached to the invocation that produced the latest session attempt. */
export function harborEvidenceInvocationId(
  state: Pick<BenchRunState, 'attempts'>,
  taskId: string,
  arm: Arm,
  fallbackInvocationId: string,
): string {
  return state.attempts.filter((attempt) =>
    attempt.taskId === taskId && attempt.arm === arm && attempt.phase === 'session').at(-1)?.invocationId
    ?? fallbackInvocationId;
}

/** Redo resets an artifact tree and must start a new native job even though the empty directory exists. */
export function shouldResumeHarborJob(jobDirectoryExists: boolean, redo: boolean): boolean {
  return jobDirectoryExists && !redo;
}

async function updateReceipt(
  receipt: VerifierReceiptStore,
  identity: HarborExecutionIdentity,
  additions: readonly VerifierBinding[],
): Promise<void> {
  const current = receipt.load();
  await receipt.update(current.revision, (bindings) => [
    ...bindings.filter((binding) => binding.scope.kind !== 'task-arm'
      || binding.scope.taskId !== identity.taskId || binding.scope.arm !== identity.arm),
    ...additions,
  ]);
}

async function recordAttempt(
  state: BenchRunStateStore,
  invocationId: string,
  identity: HarborExecutionIdentity,
  startedAt: Date,
  endedAt: Date,
  elapsedMs: number,
  failure: FailureCode | null,
  nativePath: string,
): Promise<void> {
  await state.updateCurrent((current) => ({
    ...current,
    attempts: [...current.attempts, {
      attemptId: randomUUID(),
      invocationId,
      taskId: identity.taskId,
      arm: identity.arm,
      ordinal: current.attempts.filter((attempt) => attempt.taskId === identity.taskId && attempt.arm === identity.arm).length + 1,
      phase: 'session',
      startedAt: startedAt.toISOString(),
      endedAt: endedAt.toISOString(),
      elapsedMs,
      nativePath: validateRelativeArtifactPath(nativePath),
      exitCode: failure === null ? 0 : 1,
      signal: null,
      status: failure === null ? 'succeeded' : 'failed',
      failures: failure === null ? [] : [failure],
      annotations: [],
    }],
  }));
}

/** Reconcile Harbor terminal evidence without relabeling the outer process watchdog. */
export function marathonTaskFailure(
  processFailure: FailureCode | null,
  evidence: Pick<ReturnType<typeof indexHarborEvidence>, 'nativeResult' | 'terminalFailure'>,
): FailureCode | null {
  if (evidence.terminalFailure !== null && (processFailure === null || processFailure === 'native-runner-failed')) {
    return evidence.terminalFailure;
  }
  if (processFailure === null && evidence.nativeResult.verification === 'unverified') {
    return 'verifier-output-missing';
  }
  return processFailure;
}

async function runTask(
  context: CommandContext,
  config: SweMarathonConfig,
  manifest: SweMarathonManifest,
  common: MarathonCommonAttestation,
  state: BenchRunStateStore,
  receipt: VerifierReceiptStore,
  invocationId: string,
  taskId: string,
  resume: boolean,
  redo: boolean,
): Promise<void> {
  await attestMarathonTask(common, taskId);
  const directory = runDir(context.paths, 'swe-marathon', manifest.runId);
  const rootScope = marathonRunScope(directory);
  const identity = executionIdentity(manifest, taskId);
  await cleanupMarathonContainers(rootScope, manifest.runId, taskId, identity.arm);
  const jobDirectory = join(directory, ...identity.jobRelativeRoot.split('/'));
  const exists = existsSync(jobDirectory);
  if (exists && !resume) throw new Error(`unexpected native Harbor job for fresh task ${taskId}`);
  const resumeNativeJob = shouldResumeHarborJob(exists, redo);
  const plan = planHarborRun(context.paths, directory, manifest, common, taskId, resumeNativeJob);
  if (resumeNativeJob) validateHarborResume(directory, identity, receipt.load().bindings);
  if (resumeNativeJob) {
    const evidenceInvocationId = harborEvidenceInvocationId(
      state.load(),
      identity.taskId,
      identity.arm,
      invocationId,
    );
    const existingEvidence = indexHarborEvidence(directory, identity, evidenceInvocationId);
    if (existingEvidence.nativeResult.verification === 'verified' || existingEvidence.terminalFailure !== null) {
      await updateReceipt(receipt, identity, existingEvidence.bindings);
      output(context, `${taskId} ${identity.arm}: already ${existingEvidence.terminalFailure ?? 'verified'}`);
      return;
    }
  }
  const runtimeNonce = randomBytes(32).toString('hex');
  const labels = labelEnvironment(rootScope, manifest.runId, taskId, identity.arm, runtimeNonce);
  const runtime = createMarathonRuntimeHome(
    config,
    join(context.paths.benchRoot, 'suites', 'swe-marathon'),
    labels,
  );
  runtime.environment.PATH = `${common.prepared.environmentDirectory}/bin${runtime.environment.PATH ? `:${runtime.environment.PATH}` : ''}`;
  const activeKey = `${rootScope}\0${manifest.runId}\0${taskId}\0${identity.arm}\0${runtimeNonce}`;
  const startedAt = context.clock.now();
  const startedMs = performance.now();
  let failure: FailureCode | null = null;
  let tracked = false;
  const lifecycle = state.lifecycleHooks(invocationId);
  try {
    trackExecution(activeKey, {
      rootScope,
      runId: manifest.runId,
      taskId,
      arm: identity.arm,
      cleanupRuntime: runtime.cleanup,
    });
    tracked = true;
    await runBenchProcess(plan.command, plan.argv, {
      cwd: plan.cwd,
      env: runtime.environment,
      stream: true,
      stdout: context.stdout,
      stderr: context.stderr,
      timeoutMs: config.timeouts.taskMs,
      tailBytes: 64 * 1_024 * 1_024,
      workerScope: directory,
      ...lifecycle,
    });
  } catch (error) {
    failure = error instanceof BenchProcessError && /timed out/u.test(error.message)
      ? 'driver-watchdog'
      : error instanceof BenchProcessError && /descendant cleanup failed/u.test(error.message)
        ? 'descendant-cleanup-failed'
      : /auth|credential|unauthorized|forbidden/iu.test(error instanceof Error ? error.message : String(error))
        ? 'auth-failed'
        : 'native-runner-failed';
  } finally {
    let cleanupFailure: unknown;
    try {
      if (tracked) await cleanupTrackedExecution(activeKey);
      else runtime.cleanup();
    }
    catch (error) {
      failure = 'ownership-unsafe';
      cleanupFailure = error;
    }
    const evidence = indexHarborEvidence(directory, identity, invocationId);
    failure = marathonTaskFailure(failure, evidence);
    const endedAt = context.clock.now();
    await recordAttempt(state, invocationId, identity, startedAt, endedAt,
      Math.max(0, performance.now() - startedMs), failure, identity.jobRelativeRoot);
    await updateReceipt(receipt, identity, evidence.bindings);
    output(context, `${taskId} ${identity.arm}: ${evidence.nativeResult.verification}${failure ? ` (${failure})` : ''}`);
    if (cleanupFailure !== undefined) throw cleanupFailure;
  }
}

function redoTargets(values: readonly string[], manifest: SweMarathonManifest): Set<string> {
  const allowed = new Set(manifest.experiment.taskIds);
  const targets = new Set<string>();
  for (const value of values) {
    validateMarathonTaskId(value);
    if (!allowed.has(value)) throw new Error(`redo target is not in the immutable manifest: ${value}`);
    targets.add(value);
  }
  return targets;
}

async function invalidateRedo(
  directory: string,
  manifest: SweMarathonManifest,
  targets: ReadonlySet<string>,
  receipt: VerifierReceiptStore,
  state: BenchRunStateStore,
  invocationId: string,
  now: Date,
): Promise<void> {
  if (targets.size === 0) return;
  const current = receipt.load();
  await receipt.update(current.revision, (bindings) => bindings.filter((binding) =>
    binding.scope.kind !== 'task-arm' || !targets.has(binding.scope.taskId)));
  rmSync(join(directory, 'report.json'), { force: true });
  rmSync(join(directory, 'report.md'), { force: true });
  for (const execution of manifest.artifacts.executions) {
    if (!targets.has(execution.taskId)) continue;
    const source = join(directory, ...execution.nativeRoot.split('/'));
    const archiveRoot = validateRelativeArtifactPath(`native/attempts/${invocationId}/${execution.key}`);
    const archive = join(directory, ...archiveRoot.split('/'));
    let archived = false;
    let sourceInfo: ReturnType<typeof lstatSync> | null = null;
    try { sourceInfo = lstatSync(source); } catch (error) {
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error;
    }
    if (sourceInfo?.isDirectory() && !sourceInfo.isSymbolicLink()) {
      ensurePrivateDirectoryWithin(directory, dirname(archive));
      renameSync(source, archive);
      archived = true;
    }
    resetArtifactDirectory(directory, source);
    await state.updateCurrent((currentState) => {
      let latest = -1;
      currentState.attempts.forEach((attempt, index) => {
        if (attempt.taskId === execution.taskId && attempt.arm === execution.arm
          && attempt.phase === 'session' && attempt.nativePath === execution.nativeRoot) latest = index;
      });
      return {
        ...currentState,
        attempts: [...currentState.attempts.map((attempt, index) =>
          archived && index === latest ? { ...attempt, nativePath: archiveRoot } : attempt), {
        attemptId: randomUUID(),
        invocationId,
        taskId: execution.taskId,
        arm: execution.arm,
        ordinal: currentState.attempts.filter((attempt) =>
          attempt.taskId === execution.taskId && attempt.arm === execution.arm).length + 1,
        phase: 'cleanup',
        startedAt: now.toISOString(),
        endedAt: now.toISOString(),
        elapsedMs: 0,
        nativePath: archived ? archiveRoot : execution.nativeRoot,
        exitCode: 0,
        signal: null,
        status: 'succeeded',
        failures: [],
        annotations: ['redo-invalidated'],
        }],
      };
    });
  }
}

export async function prepCommand(
  options: PrepOptions,
  context: CommandContext,
  preflight = preflightMarathonPreparation,
): Promise<void> {
  await preflight(context.paths.benchRoot);
  const locks = await acquireInputLocks(context.paths, options.recoverStaleLock);
  try {
    const operator = loadSweMarathonOperatorConfig(context.paths);
    const prepared = await prepareMarathonInputs(context.paths, operator.toolchain);
    output(context, `prepared SWE-Marathon ${prepared.source.revision} with Harbor ${prepared.harborVersion}`);
  } finally {
    releaseLocks(locks);
  }
}

export async function runCommand(options: RunOptions, context: CommandContext): Promise<void> {
  validateRunId(options.runId);
  if (options.redo.length > 0 && !options.resume) throw new Error('--redo requires --resume');
  const operator = loadSweMarathonOperatorConfig(context.paths);
  if (options.resume) {
    const stores = await loadRunStores(context.paths, options.runId, options.recoverStaleLock);
    let locks: BenchLockHandle[] = [];
    let invocationId: string | null = null;
    const startedMs = performance.now();
    try {
      assertResumeOptions(options, stores.manifest);
      const config = resumeConfig(operator.sweMarathon, stores.manifest);
      validateSweMarathonConfig(config);
      assertMarathonRuntimeBinding(config);
      locks = await acquireInputLocks(context.paths, options.recoverStaleLock);
      const common = attestMarathonCommon(context.paths, stores.manifest.suiteConfig.preparedInputSha256);
      assertProvenance(context.paths, stores.manifest, common);
      invocationId = await beginInvocation(stores.state, 'run', context.clock.now());
      const targets = redoTargets(options.redo, stores.manifest);
      await invalidateRedo(
        runDir(context.paths, 'swe-marathon', options.runId),
        stores.manifest,
        targets,
        stores.receipt,
        stores.state,
        invocationId,
        context.clock.now(),
      );
      for (const taskId of stores.manifest.experiment.taskIds) {
        await runTask(
          context,
          config,
          stores.manifest,
          common,
          stores.state,
          stores.receipt,
          invocationId,
          taskId,
          true,
          targets.has(taskId),
        );
      }
      await finishInvocation(stores.state, invocationId, startedMs, context.clock.now());
    } catch (error) {
      if (invocationId !== null) await finishInvocation(stores.state, invocationId, startedMs, context.clock.now(), 'unknown-terminal');
      throw error;
    } finally {
      try { releaseLocks(locks); } finally { stores.lease.release(); }
    }
    return;
  }

  const claim = await acquireBenchLock(
    context.paths.resultsRoot,
    runClaimFile(context.paths, 'swe-marathon', options.runId),
    { recoverStale: options.recoverStaleLock },
  );
  let locks: BenchLockHandle[] = [];
  let stores: Awaited<ReturnType<typeof initializeRun>> | null = null;
  try {
    const directory = runDir(context.paths, 'swe-marathon', options.runId);
    if (existsSync(directory)) {
      if (existsSync(join(directory, 'manifest.json'))) {
        throw new Error(`run ${options.runId} already exists; use --resume`);
      }
      assertRecoveredClaimOwnsRunDirectory(directory, claim);
      rmSync(directory, { recursive: true });
    }
    const config = overrideConfig(operator.sweMarathon, options);
    assertMarathonRuntimeBinding(config);
    locks = await acquireInputLocks(context.paths, options.recoverStaleLock);
    const common = attestMarathonCommon(context.paths);
    const manifest = buildManifest(context.paths, options.runId, config, common, context.clock.now());
    stores = await initializeRun(context.paths, manifest, options.recoverStaleLock, claim);
    claim.release();
    const startedMs = performance.now();
    const invocationId = await beginInvocation(stores.state, 'run', context.clock.now());
    try {
      for (const taskId of manifest.experiment.taskIds) {
        await runTask(context, config, manifest, common, stores.state, stores.receipt, invocationId, taskId, false, false);
      }
      await finishInvocation(stores.state, invocationId, startedMs, context.clock.now());
    } catch (error) {
      await finishInvocation(stores.state, invocationId, startedMs, context.clock.now(), 'unknown-terminal');
      throw error;
    }
  } finally {
    try { claim.release(); } catch { /* released after immutable publication */ }
    try { releaseLocks(locks); } finally { stores?.lease.release(); }
  }
}

function receiptBoundHarborEvidence(
  directory: string,
  manifest: SweMarathonManifest,
  taskId: string,
  bindings: readonly VerifierBinding[],
): { nativeResult: NativeVerifierResult; terminalFailure: 'verifier-timeout' | null } {
  const identity = executionIdentity(manifest, taskId);
  const indexed = indexHarborEvidence(directory, identity, randomUUID());
  const isBound = (candidate: Pick<VerifierBinding, 'role' | 'path' | 'sha256' | 'nativeRecordKey'>): boolean =>
    bindings.some((binding) => binding.scope.kind === 'task-arm'
      && binding.scope.taskId === taskId && binding.scope.arm === identity.arm
      && binding.role === candidate.role && binding.path === candidate.path
      && binding.sha256 === candidate.sha256 && binding.nativeRecordKey === candidate.nativeRecordKey);
  const nativeResult = indexed.nativeResult.verification === 'verified'
    && indexed.nativeResult.artifact !== null
    && isBound({ role: 'native-result', ...indexed.nativeResult.artifact })
    ? indexed.nativeResult
    : UNVERIFIED_NATIVE_RESULT;
  const terminalBinding = indexed.terminalFailure === null
    ? undefined
    : indexed.bindings.find((binding) => binding.role === 'native-result'
      && binding.nativeRecordKey?.endsWith('/exception_info.exception_type'));
  return {
    nativeResult,
    terminalFailure: terminalBinding !== undefined && isBound(terminalBinding)
      ? indexed.terminalFailure
      : null,
  };
}

/** Require the exact Harbor job, trial, and terminal result evidence set for one task. */
export function hasCompleteHarborReceipt(
  bindings: readonly VerifierBinding[],
  invocationId: string,
  taskId: string,
  arm: Arm,
): boolean {
  const scoped = bindings.filter((binding) => binding.invocationId === invocationId
    && binding.scope.kind === 'task-arm' && binding.scope.taskId === taskId && binding.scope.arm === arm);
  return scoped.some((binding) => binding.role === 'native-config' && binding.nativeRecordKey === 'job-config')
    && scoped.some((binding) => binding.role === 'run-metadata' && binding.nativeRecordKey === 'job-result')
    && scoped.some((binding) => binding.role === 'native-config'
      && binding.nativeRecordKey?.startsWith('trial-config:'))
    && scoped.some((binding) => binding.role === 'native-result');
}

export function marathonTaskInputs(
  manifest: SweMarathonManifest,
  state: BenchRunState,
  bindings: readonly VerifierBinding[],
  directory: string,
): TaskReportInput[] {
  return manifest.artifacts.executions.map((execution) => {
    const attempts = state.attempts.filter((attempt) => attempt.taskId === execution.taskId && attempt.arm === execution.arm);
    const latest = attempts.at(-1);
    const evidenceInvocationId = latest?.invocationId ?? state.invocations.at(-1)?.invocationId;
    if (evidenceInvocationId === undefined) {
      throw new Error(`SWE-Marathon report input lacks an invocation for ${execution.taskId}/${execution.arm}`);
    }
    const evidence = receiptBoundHarborEvidence(directory, manifest, execution.taskId, bindings);
    const failures = new Set<FailureCode>(latest?.failures ?? []);
    if (latest !== undefined && latest.status !== 'running'
      && !hasCompleteHarborReceipt(bindings, latest.invocationId, execution.taskId, execution.arm)) {
      failures.add('receipt-incomplete');
    }
    if (evidence.terminalFailure !== null) {
      failures.delete('native-runner-failed');
      failures.delete('verifier-output-missing');
      failures.delete('unattributed-verifier-absence');
      failures.add(evidence.terminalFailure);
    }
    if (latest !== undefined && latest.status !== 'running' && evidence.nativeResult.verification === 'unverified'
      && failures.size === 0) failures.add('unattributed-verifier-absence');
    return {
      invocationId: evidenceInvocationId,
      taskId: execution.taskId,
      arm: execution.arm,
      nativeVerifier: evidence.nativeResult,
      failures: [...failures].map((code) => failureObservationSchema.parse({
        code,
        scope: taskArmScope(execution.taskId, execution.arm),
        phase: code.startsWith('verifier-') || code === 'unattributed-verifier-absence' ? 'verifier' : 'session',
        terminal: true,
        evidence: code.startsWith('verifier-') ? 'verifier' : 'driver',
      })),
      annotations: [],
      attemptRunning: latest?.status === 'running',
    };
  });
}

export const sweMarathonAnalysisHook: SuiteAnalysisHook<'swe-marathon'> = {
  suite: 'swe-marathon',
  analyze({ manifest, taskResults }) {
    const verified = taskResults.filter((task) => task.nativeVerifier.verification === 'verified');
    const included = taskResults.filter((task) => task.disposition === 'included-native');
    const mean = (tasks: typeof taskResults): number | null => tasks.length === 0
      ? null
      : tasks.reduce((sum, task) => sum + task.nativeVerifier.score!, 0) / tasks.length;
    return {
      suite: 'swe-marathon',
      native: { meanReward: mean(verified), verifiedTasks: verified.length, requestedTasks: manifest.experiment.taskIds.length },
      policyAdjusted: { meanReward: mean(included), includedTasks: included.length },
    };
  },
};

export async function reportCommand(options: ReportOptions, context: CommandContext): Promise<void> {
  const stores = await loadRunStores(context.paths, options.runId, options.recoverStaleLock);
  const startedMs = performance.now();
  let invocationId: string | null = null;
  try {
    const directory = runDir(context.paths, 'swe-marathon', options.runId);
    const assemble = () => {
      const evidence = loadStoredReportEvidence(context.paths, 'swe-marathon', options.runId);
      const metrics = normalizeBenchMetrics(
        evidence.manifest,
        directory,
        indexSweMarathonMetrics(evidence.manifest, directory, evidence.runState),
        evidence.runState,
      );
      return buildBenchReport({
        ...evidence,
        metrics,
        taskResults: marathonTaskInputs(evidence.manifest, evidence.runState, evidence.verifierReceipt.bindings, directory),
        currentPolicyHashes: currentControlPlaneHashes(context.paths),
        analysisHook: sweMarathonAnalysisHook,
        generatedAt: context.clock.now(),
      });
    };
    invocationId = await beginInvocation(stores.state, 'report', context.clock.now());
    assemble();
    await finishInvocation(stores.state, invocationId, startedMs, context.clock.now());
    const report = assemble();
    const written = writeBenchReport(context.paths, report);
    output(context, `report: ${written.jsonPath}`);
  } catch (error) {
    rmSync(reportJsonFile(context.paths, 'swe-marathon', options.runId), { force: true });
    rmSync(reportMarkdownFile(context.paths, 'swe-marathon', options.runId), { force: true });
    if (invocationId !== null) {
      await finishInvocation(stores.state, invocationId, startedMs, context.clock.now(), 'unknown-terminal');
    }
    throw error;
  } finally {
    stores.lease.release();
  }
}
