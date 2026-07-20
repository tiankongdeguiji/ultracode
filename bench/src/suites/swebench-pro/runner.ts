/** SWE-bench Pro lifecycle on the shared v2 manifest, state, receipt, and report services. */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';
import type { Arm, BenchPathRoots, CommandContext, FailureCode } from '../../shared/contracts.js';
import { assertPrivateRuntimeFile } from '../../shared/config.js';
import { SYSTEM_CLOCK } from '../../shared/contracts.js';
import { FAILURE_POLICY_SHA256, annotationSchema, failureObservationSchema, taskArmScope } from '../../shared/failure.js';
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
  type SwebenchProManifest,
} from '../../shared/manifest.js';
import { DEFAULT_METRICS_POLICY, METRICS_POLICY_SHA256, normalizeBenchMetrics } from '../../shared/metrics.js';
import {
  createPrivateRunDirectory,
  artifactKey,
  ensurePrivateDirectoryWithin,
  manifestFile,
  readPrivateJson,
  readRegularFileWithinRoot,
  reclaimAndAssertArtifactTree,
  reportJsonFile,
  reportMarkdownFile,
  resetArtifactDirectory,
  runClaimFile,
  runDir,
  runLeaseFile,
  validateRelativeArtifactPath,
  validateRunId,
  writePrivateFileAtomic,
  writePrivateJsonAtomic,
} from '../../shared/paths.js';
import {
  cleanupActiveBenchProcesses,
  runBenchProcess,
  type BenchProcessOptions,
} from '../../shared/process.js';
import { canonicalJson, sha256CanonicalJson, sha256File } from '../../shared/provenance.js';
import {
  REPORT_POLICY_SHA256,
  buildBenchReport,
  loadStoredReportEvidence,
  writeBenchReport,
  type TaskReportInput,
} from '../../shared/report.js';
import { BenchRunStateStore, type BenchRunState } from '../../shared/run-state.js';
import {
  createVerifierBinding,
  UNVERIFIED_NATIVE_RESULT,
  VerifierReceiptStore,
  type NativeVerifierResult,
  type VerifierBinding,
} from '../../shared/verifier.js';
import {
  loadRuntimeBindings,
  loadSwebenchProOperatorConfig,
  resolveSwebenchProConfig,
  swebenchProPreparedDir,
  validateRunConfig,
  type SwebenchProConfig,
} from './config.js';
import {
  defaultDockerExecutor,
  prepareTaskImage,
  reattestTaskImage,
  removeTaskImages,
  type DockerExecutor,
} from './image.js';
import {
  containerPolicySha256,
  loadSwebenchProContainerPolicy,
  sessionContainerPolicyArgv,
  type SwebenchProContainerPolicy,
} from './container-policy.js';
import {
  OwnershipUnsafeCleanupError,
  ownershipUnsafe,
  ownershipUnsafeAggregate,
} from './cleanup.js';
import {
  datasetDescriptorSha256,
  fetchInstances,
  instanceFromRow,
  loadDatasetSnapshot,
  selectInstances,
  SWE_BENCH_PRO_DATASET,
  SWE_BENCH_PRO_SPLIT,
} from './instances.js';
import { composePrompt } from './prompt.js';
import { swebenchProAnalysisHook } from './analysis.js';
import { classifyOutcome, parseSessionMeta, readTaskStatus, validatePatch, writeTaskStatus } from './state.js';
import { indexSwebenchProMetrics } from './telemetry.js';
import {
  loadCurrentPreparedSwebenchProInputs,
  loadPreparedSwebenchProInputs,
  prepareSwebenchProInputs,
} from './toolchain.js';
import type { DockerImageAttestation, SessionMeta, SwebenchProInstance, TaskStatus } from './types.js';
import {
  cleanupActiveSwebenchProEvaluators,
  collectPredictions,
  goldPredictions,
  nullPredictions,
  runOfficialEvaluator,
  type EvaluatorRunResult,
} from './verifier.js';
import { ARM_B_PREFIX_PATH } from '../../shared/prompt.js';

const NOFOLLOW = constants.O_NOFOLLOW ?? 0;
const SESSION_BACKSTOP_EXTRA_MS = 15 * 60_000;
const TERMINAL_PHASES = new Set(['session-done', 'patched', 'evaluated']);
const TOOLCHAIN_CACHE_LOCK = '.locks/toolchain.lock';
const SUITE_CACHE_LOCK = '.locks/swebench-pro.lock';
const SESSION_RUNTIME_MARKER = 'ownership.json';

export const SWEBENCH_PRO_ADAPTER_POLICY_SHA256 = sha256CanonicalJson({
  schemaVersion: 2,
  runLayout: 'suite-run/native/tasks/artifact-key/arm',
  fresh: 'claim-exclusive-directory',
  resume: 'manifest-exists-complete-immutable-projection',
  redo: 'task-arm-exact-receipt-first-invalidation',
  verifier: 'strict-partial-native-booleans',
  credentials: 'runtime-only-outside-results',
  dataset: 'audited-canonical-descriptor-v1',
  cleanup: 'typed-command-fatal-after-settlement-retry',
  containers: 'frozen-session-evaluator-policy',
});

export interface RunOptions {
  runId: string;
  resume: boolean;
  redo: readonly string[];
  recoverStaleLock: boolean;
  model?: string;
  requestedEffort?: string;
  arm?: 'a' | 'b' | 'both';
  taskIds?: readonly string[];
  count?: number;
  seed?: number;
  taskConcurrency?: number;
  sessionTimeoutMs?: number;
}

export interface CacheOptions {
  recoverStaleLock: boolean;
}

export interface EvalOptions {
  runId: string;
  resume: boolean;
  recoverStaleLock: boolean;
  gold: boolean;
  nullCheck: boolean;
}

export interface RunIdentityOptions {
  runId: string;
  recoverStaleLock?: boolean;
}

export interface CleanOptions extends RunIdentityOptions {
  images: boolean;
}

export interface SwebenchProRunnerDependencies {
  sessionDocker?: SessionDockerExecutor;
}

function output(context: CommandContext, line: string): void {
  context.stdout.write(`${line}\n`);
}

async function acquirePreparedInputLocks(
  roots: BenchPathRoots,
  recoverStale: boolean,
): Promise<BenchLockHandle[]> {
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
  let releaseError: unknown;
  for (const lock of [...locks].reverse()) {
    try {
      lock.release();
    } catch (error) {
      releaseError ??= error;
    }
  }
  if (releaseError !== undefined) throw releaseError;
}

function sourcePolicyHash(roots: BenchPathRoots, semanticSha256: string, paths: readonly string[]): string {
  return sha256CanonicalJson({
    semanticSha256,
    sources: paths.map((path) => ({ path, sha256: sha256File(join(roots.benchRoot, ...path.split('/'))) })),
  });
}

function currentControlPlaneHashes(roots: BenchPathRoots): SwebenchProManifest['provenance']['controlPlane'] {
  return {
    manifestPolicySha256: sourcePolicyHash(roots, MANIFEST_POLICY_SHA256, ['src/shared/manifest.ts']),
    metricsPolicySha256: sourcePolicyHash(roots, METRICS_POLICY_SHA256, ['src/shared/metrics.ts', 'src/shared/jsonl.ts']),
    failurePolicySha256: sourcePolicyHash(roots, FAILURE_POLICY_SHA256, ['src/shared/failure.ts']),
    reportPolicySha256: sourcePolicyHash(roots, REPORT_POLICY_SHA256, ['src/shared/report.ts']),
    adapterPolicySha256: sourcePolicyHash(roots, SWEBENCH_PRO_ADAPTER_POLICY_SHA256, [
      'src/shared/config.ts',
      'src/shared/contracts.ts',
      'src/shared/locks.ts',
      'src/shared/options.ts',
      'src/shared/paths.ts',
      'src/shared/process.ts',
      'src/shared/prompt.ts',
      'src/shared/provenance.ts',
      'src/shared/run-state-ledger.ts',
      'src/shared/run-state.ts',
      'src/shared/toolchain.ts',
      'src/shared/verifier.ts',
      'src/suites/swebench-pro/adapter.ts',
      'src/suites/swebench-pro/analysis.ts',
      'src/suites/swebench-pro/cleanup.ts',
      'src/suites/swebench-pro/config.ts',
      'src/suites/swebench-pro/container-policy.ts',
      'src/suites/swebench-pro/image.ts',
      'src/suites/swebench-pro/instances.ts',
      'src/suites/swebench-pro/prompt.ts',
      'src/suites/swebench-pro/runner.ts',
      'src/suites/swebench-pro/state.ts',
      'src/suites/swebench-pro/telemetry.ts',
      'src/suites/swebench-pro/toolchain.ts',
      'src/suites/swebench-pro/types.ts',
      'src/suites/swebench-pro/verifier.ts',
    ]),
  };
}

function currentPolicies(
  roots: BenchPathRoots,
  requirementsSha256: string,
  resolvedRequirementsSha256: string,
  ownershipPatchSha256: string,
  evaluatorPolicyHelperSha256: string,
  preparedContainerPolicySha256: string,
  adapterPolicySha256 = currentControlPlaneHashes(roots).adapterPolicySha256,
): SwebenchProManifest['suiteConfig']['policies'] {
  const entrypoint = join(roots.benchRoot, 'suites', 'swebench-pro', 'entrypoint.sh');
  const gitSanitizer = join(roots.benchRoot, 'suites', 'swebench-pro', 'sanitize-git.sh');
  const gitCapture = join(roots.benchRoot, 'suites', 'swebench-pro', 'capture-git.sh');
  const containerPolicyFile = join(roots.benchRoot, 'suites', 'swebench-pro', 'container-policy.json');
  const policy = loadSwebenchProContainerPolicy(roots);
  if (sha256File(containerPolicyFile) !== preparedContainerPolicySha256) {
    throw new Error('prepared evaluator container policy does not match the native policy asset');
  }
  return {
    sessionSha256: sha256CanonicalJson({
      entrypointSha256: sha256File(entrypoint),
      gitSanitizerSha256: sha256File(gitSanitizer),
      gitCaptureSha256: sha256File(gitCapture),
      containerPolicySha256: containerPolicySha256(policy),
      setupUser: '0:0',
      taskUser: 'host-uid-cleared-capability-sets',
      postTaskGitCapture: 'immutable-helper-as-task-uid',
    }),
    historySha256: sha256CanonicalJson({
      base: 'exact',
      trackedDirty: 'reject',
      preDirty: 'untracked-excluded',
      objectDatabase: 'fresh-base-reachable-closure-only',
      refs: 'base-branch-and-head-only',
      audit: 'root-private-until-post-session-safe-summary',
    }),
    cleanupSha256: sha256CanonicalJson({
      sessionLabels: 'schema-suite-run-task-arm-purpose-ownership-runtime',
      verifierLabels: 'schema-suite-run-task-arm-purpose-ownership-invocation',
      verifierOwnership: 'post-baseline-exact-repository-contained-mount',
      artifactTree: 'owned-real-single-link',
      ambiguity: 'requery-exact-identity-retain-until-absent',
      fatality: 'ownership-unsafe-command-fatal',
    }),
    evaluatorSha256: sha256CanonicalJson({
      requirementsSha256,
      resolvedRequirementsSha256,
      ownershipPatchSha256,
      evaluatorPolicyHelperSha256,
      containerPolicySha256: containerPolicySha256(policy),
      hostConfig: 'frozen-policy-plus-manifest-resources',
      booleans: 'strict',
      partial: 'bind-in-finally',
    }),
    adapterSha256: adapterPolicySha256,
  };
}

function swebenchProNativeAssets(roots: BenchPathRoots): SwebenchProManifest['provenance']['nativeAssets'] {
  return [
    'suites/swebench-pro/Dockerfile',
    'suites/swebench-pro/entrypoint.sh',
    'suites/swebench-pro/sanitize-git.sh',
    'suites/swebench-pro/capture-git.sh',
    'suites/swebench-pro/container-policy.json',
    'suites/swebench-pro/dataset-pin.json',
    'suites/swebench-pro/evaluator-policy.py',
    'suites/swebench-pro/evaluator-ownership.patch',
    'suites/swebench-pro/evaluator-requirements.lock',
    relative(roots.benchRoot, ARM_B_PREFIX_PATH).split(sep).join('/'),
  ].map((path) => ({
    path: validateRelativeArtifactPath(path),
    sha256: sha256File(join(roots.benchRoot, ...path.split('/'))),
  }));
}

function armOrder(seed: number, taskId: string, arm: 'a' | 'b' | 'both'): Arm[] {
  if (arm !== 'both') return [arm];
  let hash = 5381 ^ seed;
  for (const character of taskId) hash = ((hash * 33) ^ character.charCodeAt(0)) >>> 0;
  return hash % 2 === 0 ? ['a', 'b'] : ['b', 'a'];
}

function price(config: SwebenchProConfig): SwebenchProManifest['pricing'] {
  const selected = config.pricing?.[config.model];
  return selected === undefined ? null : {
    currency: 'USD',
    model: config.model,
    ...selected,
  };
}

function manifestInstances(manifest: SwebenchProManifest): SwebenchProInstance[] {
  return manifest.suiteConfig.instances.map((entry) => instanceFromRow(entry.row));
}

function imageAttestations(manifest: SwebenchProManifest): Map<string, DockerImageAttestation> {
  return new Map(manifest.provenance.tasks.map((task) => {
    if (task.image === null) throw new Error(`SWE-bench Pro image provenance is missing for ${task.taskId}`);
    return [task.taskId, {
      requested: task.image.requested,
      resolvedDigest: task.image.resolvedDigest,
      baseLocalId: task.image.base.localId,
      basePlatform: task.image.base.platform,
      overlayName: task.image.overlay.name,
      overlayLocalId: task.image.overlay.localId,
      overlayPlatform: task.image.overlay.platform,
    }];
  }));
}

function buildManifest(
  roots: BenchPathRoots,
  runId: string,
  config: SwebenchProConfig,
  instances: readonly SwebenchProInstance[],
  images: ReadonlyMap<string, DockerImageAttestation>,
  prepared: ReturnType<typeof loadPreparedSwebenchProInputs>,
  datasetSha256: string,
  createdAt: Date,
): SwebenchProManifest {
  const taskIds = instances.map((instance) => instance.instanceId);
  const orders = taskIds.map((taskId) => ({ taskId, arms: armOrder(config.selection.seed, taskId, config.arm) }));
  const controlPlane = currentControlPlaneHashes(roots);
  const policies = currentPolicies(
    roots,
    prepared.requirementsSha256,
    prepared.resolvedRequirementsSha256,
    prepared.ownershipPatchSha256,
    prepared.evaluatorPolicyHelperSha256,
    prepared.containerPolicyFileSha256,
    controlPlane.adapterPolicySha256,
  );
  const nativeAssets = swebenchProNativeAssets(roots);
  return {
    schemaVersion: 2,
    kind: 'ultracode-benchmark-run',
    suite: 'swebench-pro',
    runId: validateRunId(runId),
    createdAt: createdAt.toISOString(),
    experiment: { model: config.model, requestedEffort: config.requestedEffort, arm: config.arm, taskIds },
    limits: {
      hostTaskTimeoutMs: config.timeouts.sessionMs,
      hostVerifierTimeoutMs: config.timeouts.verifierMs,
      taskConcurrency: config.concurrency.tasks,
      verifierConcurrency: config.concurrency.verifier,
    },
    metricsPolicy: { ...DEFAULT_METRICS_POLICY, implementationSha256: controlPlane.metricsPolicySha256 },
    pricing: price(config),
    provenance: {
      toolchain: prepared.toolchain.provenance,
      controlPlane,
      suiteSource: prepared.evaluatorSource,
      dataset: {
        identity: SWE_BENCH_PRO_DATASET,
        revision: `canonical-descriptor-v1-sha256:${datasetSha256}`,
        split: SWE_BENCH_PRO_SPLIT,
        snapshotSha256: datasetSha256,
      },
      environment: {
        platform: process.platform,
        architecture: process.arch,
        nodeVersion: process.version,
        pythonVersion: prepared.pythonVersion,
        environmentSha256: prepared.evaluatorEnvironmentSha256,
      },
      nativeAssets,
      tasks: instances.map((instance) => {
        const image = images.get(instance.instanceId);
        if (!image) throw new Error(`prepared image is missing for ${instance.instanceId}`);
        return {
          taskId: instance.instanceId,
          sourceSha256: sha256CanonicalJson(instance.row),
          image: {
            requested: image.requested,
            resolvedDigest: image.resolvedDigest,
            base: { localId: image.baseLocalId, platform: image.basePlatform },
            overlay: { name: image.overlayName, localId: image.overlayLocalId, platform: image.overlayPlatform },
          },
        };
      }),
    },
    artifacts: {
      nativeRoot: 'native',
      runState: 'run-state.json',
      verifierReceipt: 'verifier-receipt.json',
      reportJson: 'report.json',
      reportMarkdown: 'report.md',
      executions: orders.flatMap(({ taskId, arms }) => arms.map((arm) => {
        const key = artifactKey(taskId);
        return {
          taskId,
          arm,
          key,
          nativeRoot: validateRelativeArtifactPath(`native/tasks/${key}/${arm}`),
        };
      })),
    },
    suiteConfig: {
      preparedInputSha256: prepared.preparedInputSha256,
      selection: {
        mode: config.selection.taskIds === null ? 'seeded-stratified' : 'explicit',
        seed: config.selection.taskIds === null ? config.selection.seed : null,
        count: instances.length,
        stratifyBy: config.selection.taskIds === null ? config.selection.stratifyBy : null,
        requestedTaskIds: config.selection.taskIds ?? [],
      },
      instances: instances.map((instance) => ({
        taskId: instance.instanceId,
        row: instance.row as Record<string, never>,
        rowSha256: sha256CanonicalJson(instance.row),
      })),
      armOrder: orders,
      auth: {
        mechanism: config.auth.mechanism,
        publicIdentitySha256: createHash('sha256').update(config.auth.publicIdentity, 'utf8').digest('hex'),
      },
      policies,
      attempts: 1,
      retries: 0,
      evaluator: { workers: config.concurrency.verifier, watchdogMs: config.timeouts.evaluatorWatchdogMs },
      docker: { cpus: config.docker.cpus, memoryBytes: config.docker.memoryBytes, keepImages: config.docker.keepImages },
    },
  };
}

function overrideConfig(config: SwebenchProConfig, options: RunOptions): SwebenchProConfig {
  return resolveSwebenchProConfig({ schemaVersion: 2, toolchain: {
    nodeVersion: '0.0.0', nodeDistribution: 'nodejs', codexBinary: 'unused',
  }, swebenchPro: config }, {
    ...(options.model === undefined ? {} : { model: options.model }),
    ...(options.requestedEffort === undefined ? {} : { requestedEffort: options.requestedEffort }),
    ...(options.arm === undefined ? {} : { arm: options.arm }),
    selection: {
      ...config.selection,
      ...(options.taskIds === undefined ? {} : { taskIds: [...options.taskIds] }),
      ...(options.count === undefined ? {} : { count: options.count }),
      ...(options.seed === undefined ? {} : { seed: options.seed }),
    },
    concurrency: {
      ...config.concurrency,
      ...(options.taskConcurrency === undefined ? {} : { tasks: options.taskConcurrency }),
    },
    timeouts: {
      ...config.timeouts,
      ...(options.sessionTimeoutMs === undefined ? {} : { sessionMs: options.sessionTimeoutMs }),
    },
  });
}

function assertExplicitResumeOptions(options: RunOptions, manifest: SwebenchProManifest): void {
  const checks: Array<[string, unknown, unknown]> = [
    ['model', options.model, manifest.experiment.model],
    ['requested-effort', options.requestedEffort, manifest.experiment.requestedEffort],
    ['arm', options.arm, manifest.experiment.arm],
    ['task-concurrency', options.taskConcurrency, manifest.limits.taskConcurrency],
    ['session-timeout-ms', options.sessionTimeoutMs, manifest.limits.hostTaskTimeoutMs],
  ];
  if (options.taskIds !== undefined) checks.push(['task-id', canonicalJson(options.taskIds), canonicalJson(manifest.experiment.taskIds)]);
  for (const [name, actual, expected] of checks) {
    if (actual !== undefined && actual !== expected) throw new Error(`--${name} does not match the immutable manifest`);
  }
}

function resumeConfig(operator: SwebenchProConfig, manifest: SwebenchProManifest): SwebenchProConfig {
  const config: SwebenchProConfig = {
    ...operator,
    model: manifest.experiment.model,
    requestedEffort: manifest.experiment.requestedEffort,
    arm: manifest.experiment.arm,
    selection: {
      taskIds: [...manifest.experiment.taskIds],
      count: manifest.experiment.taskIds.length,
      seed: manifest.suiteConfig.selection.seed ?? 0,
      stratifyBy: manifest.suiteConfig.selection.stratifyBy ?? 'repo_language',
    },
    auth: { ...operator.auth, mechanism: manifest.suiteConfig.auth.mechanism },
    timeouts: {
      ...operator.timeouts,
      sessionMs: manifest.limits.hostTaskTimeoutMs!,
      verifierMs: manifest.limits.hostVerifierTimeoutMs!,
      evaluatorWatchdogMs: manifest.suiteConfig.evaluator.watchdogMs,
    },
    concurrency: { tasks: manifest.limits.taskConcurrency, verifier: manifest.limits.verifierConcurrency },
    docker: {
      cpus: manifest.suiteConfig.docker.cpus,
      memoryBytes: manifest.suiteConfig.docker.memoryBytes,
      keepImages: manifest.suiteConfig.docker.keepImages,
    },
    evaluator: {
      ...operator.evaluator,
      repository: manifest.provenance.suiteSource.repository,
      revision: manifest.provenance.suiteSource.revision,
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

function assertPreparedProvenance(
  manifest: SwebenchProManifest,
  config: SwebenchProConfig,
  prepared: ReturnType<typeof loadPreparedSwebenchProInputs>,
  roots: BenchPathRoots,
): void {
  const currentControlPlane = currentControlPlaneHashes(roots);
  if (canonicalJson(prepared.toolchain.provenance) !== canonicalJson(manifest.provenance.toolchain)
    || prepared.preparedInputSha256 !== manifest.suiteConfig.preparedInputSha256
    || canonicalJson(prepared.evaluatorSource) !== canonicalJson(manifest.provenance.suiteSource)
    || prepared.evaluatorEnvironmentSha256 !== manifest.provenance.environment.environmentSha256
    || canonicalJson(currentControlPlane) !== canonicalJson(manifest.provenance.controlPlane)
    || canonicalJson(swebenchProNativeAssets(roots)) !== canonicalJson(manifest.provenance.nativeAssets)
    || canonicalJson(currentPolicies(
      roots,
      prepared.requirementsSha256,
      prepared.resolvedRequirementsSha256,
      prepared.ownershipPatchSha256,
      prepared.evaluatorPolicyHelperSha256,
      prepared.containerPolicyFileSha256,
      currentControlPlane.adapterPolicySha256,
    )) !== canonicalJson(manifest.suiteConfig.policies)
    || config.auth.mechanism !== manifest.suiteConfig.auth.mechanism) {
    throw new Error('SWE-bench Pro execution provenance drifted after manifest creation');
  }
}

async function initializeRun(
  roots: BenchPathRoots,
  manifest: SwebenchProManifest,
  recoverStaleLock: boolean,
  claim: BenchLockHandle,
): Promise<{ lease: BenchLockHandle; state: BenchRunStateStore; receipt: VerifierReceiptStore }> {
  const directory = createPrivateRunDirectory(roots, 'swebench-pro', manifest.runId);
  let lease: BenchLockHandle | null = null;
  try {
    markClaimedRunDirectory(directory, claim);
    lease = await acquireBenchLock(roots.resultsRoot, runLeaseFile(roots, 'swebench-pro', manifest.runId), {
      recoverStale: recoverStaleLock,
      createParent: false,
    });
    writeBenchRunManifest(roots, manifest);
    const manifestSha256 = sha256File(manifestFile(roots, 'swebench-pro', manifest.runId));
    const state = new BenchRunStateStore(roots, 'swebench-pro', manifest.runId, manifestSha256, lease);
    const receipt = new VerifierReceiptStore(roots, 'swebench-pro', manifest.runId, manifestSha256, lease);
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
  recoverStaleLock: boolean,
): Promise<{ manifest: SwebenchProManifest; lease: BenchLockHandle; state: BenchRunStateStore; receipt: VerifierReceiptStore }> {
  const lease = await acquireBenchLock(roots.resultsRoot, runLeaseFile(roots, 'swebench-pro', runId), {
    recoverStale: recoverStaleLock,
    createParent: false,
  });
  try {
    const manifest = loadBenchRunManifest(roots, 'swebench-pro', runId) as SwebenchProManifest;
    const manifestSha256 = sha256File(manifestFile(roots, 'swebench-pro', runId));
    const state = new BenchRunStateStore(roots, 'swebench-pro', runId, manifestSha256, lease);
    state.migrateLegacyIfNeeded();
    await state.recoverPendingLifecycleProcesses(runDir(roots, 'swebench-pro', runId));
    if (state.load().invocations.some((invocation) => invocation.endedAt === null)) {
      await cleanRunContainers(
        manifest,
        new Set(state.load().invocations.map((invocation) => invocation.invocationId)),
      );
      await state.closeInterruptedInvocations();
    }
    return {
      manifest,
      lease,
      state,
      receipt: new VerifierReceiptStore(roots, 'swebench-pro', runId, manifestSha256, lease),
    };
  } catch (error) {
    lease.release();
    throw error;
  }
}

async function beginInvocation(store: BenchRunStateStore, command: 'run' | 'eval' | 'report' | 'clean', now: Date): Promise<string> {
  const invocationId = randomUUID();
  await store.updateCurrent((state) => ({
    ...state,
    invocations: [...state.invocations, {
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
  store: BenchRunStateStore,
  invocationId: string,
  startedMs: number,
  now: Date,
  failure: FailureCode | null = null,
): Promise<void> {
  await store.updateCurrent((state) => ({
    ...state,
    invocations: state.invocations.map((invocation) => invocation.invocationId === invocationId ? {
      ...invocation,
      endedAt: now.toISOString(),
      activeElapsedMs: Math.max(0, performance.now() - startedMs),
      exitCode: failure === null ? 0 : 1,
      failure,
    } : invocation),
  }));
}

function executionDirectory(runDirectory: string, nativeRoot: string): string {
  return join(runDirectory, ...nativeRoot.split('/'));
}

function credentialBytes(path: string): Buffer {
  const fd = openSync(path, constants.O_RDONLY | NOFOLLOW);
  try {
    const info = fstatSync(fd);
    const uid = typeof process.getuid === 'function' ? process.getuid() : undefined;
    if (!info.isFile() || info.nlink !== 1 || info.size > 4 * 1_024 * 1_024) throw new Error('auth file is unsafe');
    if (uid !== undefined && info.uid !== uid) throw new Error('auth file must be owned by the current user');
    if ((info.mode & 0o777) !== 0o600) throw new Error('auth file must have mode 0600');
    const bytes = Buffer.alloc(info.size);
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (count === 0) throw new Error('auth file changed while it was being read');
      offset += count;
    }
    const after = fstatSync(fd);
    if (after.dev !== info.dev || after.ino !== info.ino || after.size !== info.size
      || after.mtimeMs !== info.mtimeMs || after.ctimeMs !== info.ctimeMs || after.nlink !== 1) {
      throw new Error('auth file changed while it was being read');
    }
    return bytes;
  } finally {
    closeSync(fd);
  }
}

type ProcessLifecycle = Pick<BenchProcessOptions,
  'workerScope' | 'onLifecycleToken' | 'onLifecycleStarted' | 'onLifecycleRecovered'>;

interface ActiveSessionContainer {
  runtime: string;
  runtimeNonce: string;
  runId: string;
  taskId: string;
  arm: Arm;
  lifecycle: ProcessLifecycle;
  executor: SessionDockerExecutor;
}

const activeContainers = new Map<string, ActiveSessionContainer>();
let relayingSignal = false;

const relaySignal = (signal: NodeJS.Signals): void => {
  if (relayingSignal) return;
  relayingSignal = true;
  void cleanupActiveSwebenchProContainers().finally(() => {
    process.off('SIGINT', onSigint);
    process.off('SIGTERM', onSigterm);
    process.kill(process.pid, signal);
  });
};

const onSigint = (): void => relaySignal('SIGINT');
const onSigterm = (): void => relaySignal('SIGTERM');

function trackContainer(name: string, container: ActiveSessionContainer): void {
  if (activeContainers.has(name)) throw new Error(`session container is already tracked: ${name}`);
  if (activeContainers.size === 0) {
    process.on('SIGINT', onSigint);
    process.on('SIGTERM', onSigterm);
  }
  activeContainers.set(name, container);
}

function untrackContainer(name: string): void {
  activeContainers.delete(name);
  if (activeContainers.size === 0 && !relayingSignal) {
    process.off('SIGINT', onSigint);
    process.off('SIGTERM', onSigterm);
  }
}

export type SessionDockerExecutor = (
  argv: readonly string[],
  lifecycle?: ProcessLifecycle,
) => Promise<string>;

export const defaultSessionDockerExecutor: SessionDockerExecutor = async (
  argv,
  lifecycle = {},
): Promise<string> => {
  return (await runBenchProcess('docker', argv, {
    cwd: process.cwd(),
    tailBytes: 8 * 1_024 * 1_024,
    ...lifecycle,
  })).stdout;
};

function containerName(runId: string, taskId: string, arm: Arm): string {
  return `ucbench-${createHash('sha256').update(`${runId}\0${taskId}\0${arm}`, 'utf8').digest('hex').slice(0, 32)}`;
}

export async function stopPersistedSessionContainer(
  name: string,
  runId: string,
  taskId: string,
  arm: Arm,
  lifecycle: ProcessLifecycle = {},
  executor: SessionDockerExecutor = defaultSessionDockerExecutor,
): Promise<void> {
  const listExactName = async (): Promise<string[]> => {
    const listed = (await executor(['ps', '-aq', '--filter', `name=^/${name}$`], lifecycle))
      .split('\n').map((entry) => entry.trim()).filter(Boolean);
    if (listed.length > 1 || listed.some((id) => !/^[a-f0-9]{12,64}$/.test(id))) {
      throw new Error(`session container name is not uniquely bound to a valid id: ${name}`);
    }
    return listed;
  };
  try {
    const listed = await listExactName();
    if (listed.length === 0) return;
    const parsed = JSON.parse(await executor(['inspect', listed[0]!], lifecycle)) as ContainerInspect[];
    const inspectedId = parsed.length === 1 ? parsed[0]?.Id : undefined;
    const labels = parsed[0]?.Config?.Labels ?? {};
    const runtimeNonce = labels['ultracode.benchmark.runtime'];
    if (
      typeof inspectedId !== 'string'
      || !/^[a-f0-9]{64}$/.test(inspectedId)
      || !inspectedId.startsWith(listed[0]!)
      || labels['ultracode.benchmark.schema'] !== '2'
      || labels['ultracode.benchmark.suite'] !== 'swebench-pro'
      || labels['ultracode.benchmark.run'] !== runId
      || labels['ultracode.benchmark.task'] !== taskId
      || labels['ultracode.benchmark.arm'] !== arm
      || labels['ultracode.benchmark.purpose'] !== 'session'
      || labels['ultracode.benchmark.ownership'] !== '1'
      || typeof runtimeNonce !== 'string'
      || !/^[a-f0-9]{64}$/.test(runtimeNonce)
    ) {
      throw new Error(`refusing to remove unowned container with session name ${name}`);
    }
    const runtime = sessionRuntimeDirectory(parsed[0]!, runId, taskId, arm, runtimeNonce);
    let removalFailure: unknown;
    try {
      await executor(['rm', '-f', listed[0]!], lifecycle);
    } catch (error) {
      removalFailure = error;
    }
    let remaining: string[];
    try {
      remaining = await listExactName();
    } catch (error) {
      throw ownershipUnsafeAggregate('session removal could not be re-queried exactly', [removalFailure, error]);
    }
    if (remaining.length !== 0) {
      throw ownershipUnsafeAggregate('session container absence was not proven after removal', [
        removalFailure,
        new Error(`session container name remains present: ${name}`),
      ]);
    }
    removeSessionRuntime(runtime, runId, taskId, arm, runtimeNonce);
  } catch (error) {
    throw ownershipUnsafe(`unsafe SWE-bench Pro session cleanup for ${taskId}/${arm}`, error);
  }
}

export async function cleanupActiveSwebenchProContainers(): Promise<number> {
  const entries = [...activeContainers.entries()];
  const failures: unknown[] = [];
  await Promise.all(entries.map(async ([name, container]) => {
    try {
      await stopPersistedSessionContainer(
        name,
        container.runId,
        container.taskId,
        container.arm,
        container.lifecycle,
        container.executor,
      );
      if (existsSync(container.runtime)) removeSessionRuntime(
        container.runtime,
        container.runId,
        container.taskId,
        container.arm,
        container.runtimeNonce,
      );
      untrackContainer(name);
    } catch (error) {
      failures.push(error);
    }
  }));
  if (!relayingSignal && activeContainers.size === 0) {
    process.off('SIGINT', onSigint);
    process.off('SIGTERM', onSigterm);
  }
  if (failures.length > 0) {
    throw ownershipUnsafeAggregate('active SWE-bench Pro container cleanup failed', failures);
  }
  return entries.length;
}

interface SessionResult {
  status: TaskStatus;
  meta: SessionMeta | null;
}

export interface SessionDockerRunArgvOptions {
  name: string;
  runId: string;
  taskId: string;
  arm: Arm;
  runtimeNonce: string;
  envFile: string;
  taskDirectory: string;
  runtimeHome: string;
  runtimeCodex: string;
  image: string;
  docker: SwebenchProConfig['docker'];
  policy: SwebenchProContainerPolicy;
}

/** Build the exact session invocation so policy parity is testable without Docker. */
export function sessionDockerRunArgv(options: SessionDockerRunArgvOptions): string[] {
  const labels = [
    ['schema', '2'], ['suite', 'swebench-pro'], ['run', options.runId], ['task', options.taskId],
    ['arm', options.arm], ['purpose', 'session'], ['ownership', '1'], ['runtime', options.runtimeNonce],
  ].flatMap(([key, value]) => ['--label', `ultracode.benchmark.${key}=${value}`]);
  return [
    'run', '-d', '--name', options.name, ...labels,
    ...sessionContainerPolicyArgv(options.policy, options.docker),
    '--user', '0:0',
    '--env-file', options.envFile,
    '--mount', `type=bind,src=${options.taskDirectory},dst=/bench`,
    '--mount', `type=bind,src=${options.runtimeHome},dst=/runtime/home`,
    '--mount', `type=bind,src=${options.runtimeCodex},dst=/runtime/codex-home`,
    '--mount', `type=bind,src=${join(options.taskDirectory, 'codex-home', 'sessions')},dst=/runtime/codex-home/sessions`,
    '--entrypoint', '/bin/bash',
    options.image,
    '/opt/bench/entrypoint.sh',
  ];
}

async function runSession(
  roots: BenchPathRoots,
  config: SwebenchProConfig,
  manifest: SwebenchProManifest,
  instance: SwebenchProInstance,
  arm: Arm,
  taskDirectory: string,
  image: DockerImageAttestation,
  runtimeBindings: ReturnType<typeof loadRuntimeBindings>,
  processLifecycle: ProcessLifecycle,
  executor: SessionDockerExecutor = defaultSessionDockerExecutor,
): Promise<SessionResult> {
  const imageExecutor: DockerExecutor = (argv) => executor(argv, processLifecycle);
  await reattestTaskImage(image, imageExecutor);
  const name = containerName(manifest.runId, instance.instanceId, arm);
  await stopPersistedSessionContainer(
    name,
    manifest.runId,
    instance.instanceId,
    arm,
    processLifecycle,
    executor,
  );
  resetArtifactDirectory(runDirFromTask(taskDirectory), taskDirectory);
  for (const directory of [
    'codex-home', 'codex-home/sessions', 'uc', 'logs', 'out',
  ]) ensurePrivateDirectoryWithin(taskDirectory, join(taskDirectory, ...directory.split('/')));
  writePrivateFileAtomic(taskDirectory, join(taskDirectory, 'prompt.txt'), composePrompt(instance, arm));

  const runtime = mkdtempSync(join(tmpdir(), 'uc-bench-pro-runtime-'));
  const runtimeNonce = randomBytes(32).toString('hex');
  const runtimeHome = join(runtime, 'home');
  const runtimeCodex = join(runtime, 'codex-home');
  const envFile = join(runtime, 'container.env');
  try {
    mkdirSync(runtimeHome, { mode: 0o700 });
    mkdirSync(runtimeCodex, { mode: 0o700 });
    writePrivateJsonAtomic(runtime, join(runtime, SESSION_RUNTIME_MARKER), {
      schemaVersion: 2,
      kind: 'ultracode-swebench-pro-session-runtime',
      runId: manifest.runId,
      taskId: instance.instanceId,
      arm,
      runtimeNonce,
    });
    if (runtimeBindings.authFile) {
      writeFileSync(join(runtimeCodex, 'auth.json'), credentialBytes(runtimeBindings.authFile), { mode: 0o600 });
    }
    const envLines = [
      `BENCH_ARM=${arm}`,
      `BENCH_TIMEOUT_SECS=${Math.ceil(config.timeouts.sessionMs / 1_000)}`,
      `BENCH_MODEL=${config.model}`,
      `BENCH_EFFORT=${config.requestedEffort}`,
      `BENCH_BASE_COMMIT=${instance.baseCommit}`,
      `BENCH_CHOWN=${typeof process.getuid === 'function' ? process.getuid() : 0}:${typeof process.getgid === 'function' ? process.getgid() : 0}`,
      'BENCH_SANITIZE=1',
      'CODEX_HOME=/runtime/codex-home',
      'ULTRACODE_HOME=/bench/uc',
      'HOME=/runtime/home',
      ...(runtimeBindings.apiKey ? [`CODEX_API_KEY=${runtimeBindings.apiKey}`] : []),
    ];
    writeFileSync(envFile, `${envLines.join('\n')}\n`, { mode: 0o600 });
  } catch (error) {
    rmSync(runtime, { recursive: true, force: true });
    throw error;
  }
  const args = sessionDockerRunArgv({
    name,
    runId: manifest.runId,
    taskId: instance.instanceId,
    arm,
    runtimeNonce,
    envFile,
    taskDirectory,
    runtimeHome,
    runtimeCodex,
    image: image.overlayName,
    docker: config.docker,
    policy: loadSwebenchProContainerPolicy(roots),
  });
  const startedAt = Date.now();
  let endedAt = startedAt;
  let backstop = false;
  try {
    trackContainer(name, {
      runtime,
      runtimeNonce,
      runId: manifest.runId,
      taskId: instance.instanceId,
      arm,
      lifecycle: processLifecycle,
      executor,
    });
    const launchedId = (await executor(args, processLifecycle)).trim();
    if (!/^[a-f0-9]{64}$/.test(launchedId)) throw new Error('Docker returned an invalid session container id');
    unlinkSync(envFile);
    const waited = executor(['wait', name], processLifecycle);
    let timer: NodeJS.Timeout | undefined;
    const stopped = new Promise<'backstop'>((resolvePromise) => {
      timer = setTimeout(resolvePromise, config.timeouts.sessionMs + SESSION_BACKSTOP_EXTRA_MS, 'backstop');
    });
    const first = await Promise.race([waited.then(() => 'exited' as const), stopped]);
    if (timer) clearTimeout(timer);
    endedAt = Date.now();
    if (first === 'backstop') {
      backstop = true;
      await stopPersistedSessionContainer(
        name,
        manifest.runId,
        instance.instanceId,
        arm,
        processLifecycle,
        executor,
      );
      await waited.catch(() => '');
    }
  } finally {
    await stopPersistedSessionContainer(
      name,
      manifest.runId,
      instance.instanceId,
      arm,
      processLifecycle,
      executor,
    );
    untrackContainer(name);
    if (existsSync(runtime)) removeSessionRuntime(runtime, manifest.runId, instance.instanceId, arm, runtimeNonce);
  }
  reclaimAndAssertArtifactTree(taskDirectory);
  let meta: SessionMeta | null = null;
  try {
    meta = parseSessionMeta(JSON.parse(readRegularFileWithinRoot(taskDirectory, 'out/meta.json').toString('utf8')));
  } catch {
    meta = null;
  }
  let patch = '';
  try { patch = readRegularFileWithinRoot(taskDirectory, 'out/patch.diff', 10_000_001).toString('utf8'); } catch { /* absent */ }
  const outcome = backstop
    ? { failure: 'driver-watchdog' as const, annotations: ['backstop-kill'] }
    : classifyOutcome(meta, validatePatch(patch));
  const status: TaskStatus = {
    schemaVersion: 2,
    phase: patch.trim() ? 'patched' : 'session-done',
    failure: outcome.failure,
    startedAt: new Date(startedAt).toISOString(),
    endedAt: new Date(endedAt).toISOString(),
    wallClockMs: endedAt - startedAt,
    patchBytes: Buffer.byteLength(patch, 'utf8'),
    applyCheck: meta?.applyCheck ?? null,
    annotations: [...new Set(outcome.annotations)],
    ...(meta === null ? {} : { codexExit: meta.codexExit }),
  };
  writeTaskStatus(taskDirectory, status);
  return { status, meta };
}

function runDirFromTask(taskDirectory: string): string {
  const marker = `${sep}native${sep}tasks${sep}`;
  const index = taskDirectory.indexOf(marker);
  if (index < 0) throw new Error('task directory is outside the v2 native layout');
  return taskDirectory.slice(0, index);
}

function sessionFailure(error: unknown): FailureCode {
  const message = error instanceof Error ? error.message : String(error);
  if (/auth file|credential|CODEX_(?:AUTH|API)/i.test(message)) return 'auth-failed';
  if (/image identity drifted/i.test(message)) return 'image-identity-drift';
  if (/toolchain/i.test(message)) return 'toolchain-incompatible';
  if (/owner|ownership/i.test(message)) return 'ownership-unsafe';
  if (/artifact|symlink|multiply-linked|non-file/i.test(message)) return 'artifact-unsafe';
  return 'native-runner-failed';
}

function parseRedo(values: readonly string[], manifest: SwebenchProManifest): Set<string> {
  const targets = new Set<string>();
  const allowed = new Set(manifest.artifacts.executions.map((entry) => `${entry.taskId}\0${entry.arm}`));
  for (const value of values) {
    const separator = value.lastIndexOf('::');
    if (separator <= 0) throw new Error(`--redo '${value}' must use <task-id>::<arm>`);
    const taskId = value.slice(0, separator);
    const arm = value.slice(separator + 2);
    const key = `${taskId}\0${arm}`;
    if (!allowed.has(key)) throw new Error(`redo target is not in the immutable manifest: ${value}`);
    targets.add(key);
  }
  return targets;
}

async function invalidateRedo(
  manifest: SwebenchProManifest,
  directory: string,
  targets: ReadonlySet<string>,
  receipt: VerifierReceiptStore,
  state: BenchRunStateStore,
  invocationId: string,
  now: Date,
): Promise<void> {
  if (targets.size === 0) return;
  const current = receipt.load();
  await receipt.update(current.revision, (bindings) => retainVerifierBindingsAfterRedo(bindings, targets));
  rmSync(join(directory, 'report.json'), { force: true });
  rmSync(join(directory, 'report.md'), { force: true });
  for (const execution of manifest.artifacts.executions) {
    if (targets.has(`${execution.taskId}\0${execution.arm}`)) {
      resetArtifactDirectory(directory, executionDirectory(directory, execution.nativeRoot));
      await state.updateCurrent((currentState) => ({
        ...currentState,
        attempts: [...currentState.attempts, {
          attemptId: randomUUID(),
          invocationId,
          taskId: execution.taskId,
          arm: execution.arm,
          ordinal: currentState.attempts.filter((entry) =>
            entry.taskId === execution.taskId && entry.arm === execution.arm).length + 1,
          phase: 'cleanup',
          startedAt: now.toISOString(),
          endedAt: now.toISOString(),
          elapsedMs: 0,
          nativePath: execution.nativeRoot,
          exitCode: 0,
          signal: null,
          status: 'succeeded',
          failures: [],
          annotations: ['redo-invalidated'],
        }],
      }));
    }
  }
}

/** Invalidate the complete affected arm aggregate before any redo artifact reset. */
export function retainVerifierBindingsAfterRedo(
  bindings: readonly VerifierBinding[],
  targets: ReadonlySet<string>,
): VerifierBinding[] {
  const affectedArms = new Set<Arm>([...targets].map((target) => target.endsWith('\0a') ? 'a' : 'b'));
  return bindings.filter((binding) => {
    if (binding.scope.kind === 'task-arm') {
      if (binding.role === 'native-result' && affectedArms.has(binding.scope.arm)) return false;
      return !targets.has(`${binding.scope.taskId}\0${binding.scope.arm}`);
    }
    if (binding.scope.kind === 'suite-check') {
      const name = binding.scope.name;
      return ![...affectedArms].some((arm) => name.startsWith(arm === 'a' ? 'armA' : 'armB'));
    }
    return true;
  });
}

async function recordCompletedAttempt(
  state: BenchRunStateStore,
  invocationId: string,
  execution: SwebenchProManifest['artifacts']['executions'][number],
  status: TaskStatus,
  meta: SessionMeta | null,
): Promise<void> {
  const startedAt = meta?.startedAt ? new Date(meta.startedAt * 1_000).toISOString() : status.startedAt ?? new Date().toISOString();
  const endedAt = meta?.endedAt ? new Date(meta.endedAt * 1_000).toISOString() : status.endedAt ?? startedAt;
  const elapsedMs = meta === null ? status.wallClockMs ?? 0 : Math.max(0, (meta.endedAt - meta.startedAt) * 1_000);
  await state.updateCurrent((current) => ({
    ...current,
    attempts: [...current.attempts, {
      attemptId: randomUUID(),
      invocationId,
      taskId: execution.taskId,
      arm: execution.arm,
      ordinal: current.attempts.filter((entry) => entry.taskId === execution.taskId && entry.arm === execution.arm).length + 1,
      phase: 'session',
      startedAt,
      endedAt,
      elapsedMs,
      nativePath: execution.nativeRoot,
      exitCode: meta?.codexExit ?? null,
      signal: null,
      status: status.failure === null ? 'succeeded' : 'failed',
      failures: status.failure === null ? [] : [status.failure],
      annotations: status.annotations,
    }],
  }));
  if (meta !== null && meta.waitedForTerminalMs > 0) {
    const waitEnd = new Date(meta.endedAt * 1_000 + meta.waitedForTerminalMs);
    const waitStart = new Date(meta.endedAt * 1_000);
    await state.updateCurrent((current) => ({
      ...current,
      attempts: [...current.attempts, {
        attemptId: randomUUID(), invocationId, taskId: execution.taskId, arm: execution.arm,
        ordinal: current.attempts.filter((entry) => entry.taskId === execution.taskId && entry.arm === execution.arm).length + 1,
        phase: 'detached-wait', startedAt: waitStart.toISOString(), endedAt: waitEnd.toISOString(),
        elapsedMs: meta.waitedForTerminalMs, nativePath: execution.nativeRoot, exitCode: 0, signal: null,
        status: 'succeeded', failures: [], annotations: [],
      }],
    }));
  }
}

/** Settle every worker, retry active cleanup once, and retain the original fatal aggregate. */
export async function settleSessionWorkers(
  workers: readonly Promise<void>[],
  cleanupRetry: () => Promise<unknown> = cleanupActiveSwebenchProContainers,
): Promise<void> {
  const settled = await Promise.allSettled(workers);
  const rejected = settled.flatMap((result) => result.status === 'rejected' ? [result.reason] : []);
  const ownershipFailures: unknown[] = rejected.filter((error) =>
    error instanceof OwnershipUnsafeCleanupError);
  if (ownershipFailures.length > 0) {
    try {
      await cleanupRetry();
    } catch (error) {
      ownershipFailures.push(error);
    }
    throw ownershipUnsafeAggregate(
      'SWE-bench Pro session cleanup was ownership-unsafe after the mandatory active-container retry',
      ownershipFailures,
    );
  }
  if (rejected.length > 0) throw new AggregateError(rejected, 'SWE-bench Pro session workers failed');
}

async function executeSessions(
  context: CommandContext,
  config: SwebenchProConfig,
  manifest: SwebenchProManifest,
  state: BenchRunStateStore,
  invocationId: string,
  redo: ReadonlySet<string>,
  resume: boolean,
  sessionDocker: SessionDockerExecutor = defaultSessionDockerExecutor,
): Promise<void> {
  const directory = runDir(context.paths, 'swebench-pro', manifest.runId);
  await cleanRunContainers(
    manifest,
    new Set(state.load().invocations.map((invocation) => invocation.invocationId)),
  );
  const byId = new Map(manifestInstances(manifest).map((instance) => [instance.instanceId, instance]));
  const images = imageAttestations(manifest);
  const runtimeBindings = loadRuntimeBindings(config);
  let cursor = 0;
  let ownershipFailure = false;
  const workers = Array.from({ length: config.concurrency.tasks }, async () => {
    for (;;) {
      if (ownershipFailure) return;
      const execution = manifest.artifacts.executions[cursor++];
      if (!execution) return;
      const taskDirectory = executionDirectory(directory, execution.nativeRoot);
      const previous = existsSync(taskDirectory) ? readTaskStatus(taskDirectory) : null;
      const forced = redo.has(`${execution.taskId}\0${execution.arm}`);
      if (!forced && previous !== null && TERMINAL_PHASES.has(previous.phase)) continue;
      if (previous !== null && !forced && !resume) throw new Error(`unexpected native state for ${execution.taskId}/${execution.arm}`);
      const instance = byId.get(execution.taskId)!;
      const image = images.get(execution.taskId)!;
      try {
        const result = await runSession(
          context.paths,
          config,
          manifest,
          instance,
          execution.arm,
          taskDirectory,
          image,
          runtimeBindings,
          state.lifecycleHooks(invocationId),
          sessionDocker,
        );
        await recordCompletedAttempt(state, invocationId, execution, result.status, result.meta);
        output(context, `${execution.taskId} ${execution.arm}: ${result.status.phase}${result.status.failure ? ` (${result.status.failure})` : ''}`);
      } catch (error) {
        if (error instanceof OwnershipUnsafeCleanupError) {
          ownershipFailure = true;
          throw error;
        }
        const timestamp = context.clock.now().toISOString();
        const failure = sessionFailure(error);
        const status: TaskStatus = {
          schemaVersion: 2,
          phase: 'pending',
          failure,
          startedAt: timestamp,
          endedAt: timestamp,
          wallClockMs: 0,
          annotations: [],
        };
        try {
          ensurePrivateDirectoryWithin(directory, taskDirectory);
          writeTaskStatus(taskDirectory, status);
        } catch {
          // Durable shared state below still records the exact scoped failure.
        }
        await recordCompletedAttempt(state, invocationId, execution, status, null);
        output(context, `${execution.taskId} ${execution.arm}: pending (${failure})`);
      }
    }
  });
  await settleSessionWorkers(workers);
}

export async function fetchCommand(options: CacheOptions, context: CommandContext): Promise<void> {
  const lock = await acquireBenchLock(context.paths.cacheRoot, join(context.paths.cacheRoot, SUITE_CACHE_LOCK), {
    recoverStale: options.recoverStaleLock,
  });
  try {
    output(context, `cached ${await fetchInstances(context.paths)} complete SWE-bench Pro rows`);
  } finally {
    lock.release();
  }
}

export async function prepCommand(options: CacheOptions, context: CommandContext): Promise<void> {
  const locks = await acquirePreparedInputLocks(context.paths, options.recoverStaleLock);
  try {
    const operator = loadSwebenchProOperatorConfig(context.paths);
    const runtime = process.env.PIP_CONFIG_FILE === undefined
      ? {}
      : { pipConfigFile: assertPrivateRuntimeFile(process.env.PIP_CONFIG_FILE, 'private pip config') };
    const prepared = await prepareSwebenchProInputs(context.paths, operator.toolchain, operator.swebenchPro, runtime);
    output(context, `prepared toolchain ${prepared.toolchain.provenance.payloadSha256}`);
    output(context, `prepared evaluator ${prepared.evaluatorSource.revision}`);
  } finally {
    releaseLocks(locks);
  }
}

export async function runCommand(
  options: RunOptions,
  context: CommandContext,
  dependencies: SwebenchProRunnerDependencies = {},
): Promise<void> {
  validateRunId(options.runId);
  if (options.redo.length > 0 && !options.resume) throw new Error('--redo requires --resume');
  const operator = loadSwebenchProOperatorConfig(context.paths);
  const baseConfig = operator.swebenchPro;
  if (options.resume) {
    const stores = await loadRunStores(context.paths, options.runId, options.recoverStaleLock);
    const startedMs = performance.now();
    let invocationId: string | null = null;
    let inputLocks: BenchLockHandle[] = [];
    try {
      assertExplicitResumeOptions(options, stores.manifest);
      const config = resumeConfig(baseConfig, stores.manifest);
      validateRunConfig(config);
      loadRuntimeBindings(config);
      inputLocks = await acquirePreparedInputLocks(context.paths, options.recoverStaleLock);
      const prepared = loadPreparedSwebenchProInputs(
        swebenchProPreparedDir(context.paths, stores.manifest.suiteConfig.preparedInputSha256),
        context.paths,
        config,
      );
      assertPreparedProvenance(stores.manifest, config, prepared, context.paths);
      for (const image of imageAttestations(stores.manifest).values()) await reattestTaskImage(image);
      invocationId = await beginInvocation(stores.state, 'run', context.clock.now());
      const redo = parseRedo(options.redo, stores.manifest);
      await invalidateRedo(
        stores.manifest,
        runDir(context.paths, 'swebench-pro', options.runId),
        redo,
        stores.receipt,
        stores.state,
        invocationId,
        context.clock.now(),
      );
      await executeSessions(
        context,
        config,
        stores.manifest,
        stores.state,
        invocationId,
        redo,
        true,
        dependencies.sessionDocker,
      );
      await finishInvocation(stores.state, invocationId, startedMs, context.clock.now());
    } catch (error) {
      if (invocationId !== null) await finishInvocation(
        stores.state,
        invocationId,
        startedMs,
        context.clock.now(),
        error instanceof OwnershipUnsafeCleanupError ? 'ownership-unsafe' : 'unknown-terminal',
      );
      throw error;
    } finally {
      try {
        releaseLocks(inputLocks);
      } finally {
        stores.lease.release();
      }
    }
    return;
  }

  const claim = await acquireBenchLock(
    context.paths.resultsRoot,
    runClaimFile(context.paths, 'swebench-pro', options.runId),
    { recoverStale: options.recoverStaleLock },
  );
  let initialized: Awaited<ReturnType<typeof initializeRun>> | null = null;
  let inputLocks: BenchLockHandle[] = [];
  try {
    const freshDirectory = runDir(context.paths, 'swebench-pro', options.runId);
    if (existsSync(freshDirectory)) {
      if (existsSync(join(freshDirectory, 'manifest.json'))) {
        throw new Error(`run ${options.runId} already exists; use --resume`);
      }
      assertRecoveredClaimOwnsRunDirectory(freshDirectory, claim);
      rmSync(freshDirectory, { recursive: true });
    }
    const config = overrideConfig(baseConfig, options);
    validateRunConfig(config);
    loadRuntimeBindings(config);
    inputLocks = await acquirePreparedInputLocks(context.paths, options.recoverStaleLock);
    const prepared = loadCurrentPreparedSwebenchProInputs(context.paths, config);
    const snapshot = loadDatasetSnapshot(context.paths);
    const datasetSha256 = datasetDescriptorSha256(context.paths, snapshot);
    const selected = selectInstances(snapshot, config.selection);
    const images = new Map<string, DockerImageAttestation>();
    for (const instance of selected) {
      images.set(instance.instanceId, await prepareTaskImage(instance, {
        roots: context.paths,
        toolchainDirectory: prepared.toolchain.directory,
        toolchainPayloadSha256: prepared.toolchain.provenance.payloadSha256,
      }));
    }
    const manifest = buildManifest(
      context.paths,
      options.runId,
      config,
      selected,
      images,
      prepared,
      datasetSha256,
      context.clock.now(),
    );
    initialized = await initializeRun(context.paths, manifest, options.recoverStaleLock, claim);
    claim.release();
    const startedMs = performance.now();
    const invocationId = await beginInvocation(initialized.state, 'run', context.clock.now());
    try {
      await executeSessions(
        context,
        config,
        manifest,
        initialized.state,
        invocationId,
        new Set(),
        false,
        dependencies.sessionDocker,
      );
      await finishInvocation(initialized.state, invocationId, startedMs, context.clock.now());
    } catch (error) {
      await finishInvocation(
        initialized.state,
        invocationId,
        startedMs,
        context.clock.now(),
        error instanceof OwnershipUnsafeCleanupError ? 'ownership-unsafe' : 'unknown-terminal',
      );
      throw error;
    }
  } finally {
    try { claim.release(); } catch { /* already released after publication */ }
    try {
      releaseLocks(inputLocks);
    } finally {
      initialized?.lease.release();
    }
  }
}

function verifierBindings(
  runDirectory: string,
  invocationId: string,
  scope: VerifierBinding['scope'],
  role: VerifierBinding['role'],
  path: string,
  nativeRecordKey: string | null,
): VerifierBinding {
  return createVerifierBinding(runDirectory, {
    invocationId,
    scope,
    role,
    path: validateRelativeArtifactPath(path),
    nativeRecordKey,
  });
}

/** Build exact receipt bindings for one evaluator mode without mutating the receipt store. */
export function evaluatorReceiptBindings(options: {
  runDirectory: string;
  invocationId: string;
  prefix: string;
  arm: Arm | null;
  result: EvaluatorRunResult;
}): VerifierBinding[] {
  const scope = options.arm === null
    ? { kind: 'suite-check' as const, name: options.prefix }
    : null;
  const additions: VerifierBinding[] = [
    verifierBindings(
      options.runDirectory,
      options.invocationId,
      scope ?? { kind: 'suite-check', name: `${options.prefix}-inputs` },
      'raw-samples',
      options.result.rawSamplesRelativePath,
      null,
    ),
    verifierBindings(
      options.runDirectory,
      options.invocationId,
      scope ?? { kind: 'suite-check', name: `${options.prefix}-inputs` },
      'predictions',
      options.result.predictionsRelativePath,
      null,
    ),
    verifierBindings(
      options.runDirectory,
      options.invocationId,
      scope ?? { kind: 'suite-check', name: `${options.prefix}-invocation` },
      'verifier-invocation',
      options.result.invocationRelativePath,
      null,
    ),
    verifierBindings(
      options.runDirectory,
      options.invocationId,
      scope ?? { kind: 'suite-check', name: `${options.prefix}-policy` },
      'native-config',
      options.result.policyRelativePath,
      null,
    ),
  ];
  if (options.result.resultRelativePath === null) return additions;
  if (options.arm === null) {
    additions.push(verifierBindings(
      options.runDirectory,
      options.invocationId,
      scope!,
      'native-result',
      options.result.resultRelativePath,
      options.prefix,
    ));
  } else {
    for (const [taskId] of Object.entries(options.result.verdicts)) {
      additions.push(verifierBindings(
        options.runDirectory,
        options.invocationId,
        { kind: 'task-arm', taskId, arm: options.arm },
        'native-result',
        options.result.resultRelativePath,
        taskId,
      ));
    }
  }
  return additions;
}

export interface EvaluatorTaskAttribution {
  phase: 'evaluated';
  attempt: BenchRunState['attempts'][number];
}

/** Attribute one batch evaluator result only to a task that was actually submitted. */
export function evaluatorTaskAttribution(options: {
  result: EvaluatorRunResult;
  execution: SwebenchProManifest['artifacts']['executions'][number];
  submitted: ReadonlySet<string>;
  invocationId: string;
  attemptId: string;
  ordinal: number;
}): EvaluatorTaskAttribution | null {
  if (!options.submitted.has(options.execution.taskId)) return null;
  const nativePresent = Object.hasOwn(options.result.verdicts, options.execution.taskId);
  const failure = nativePresent ? null
    : options.result.processFailure
      ?? (options.result.malformedTaskIds.includes(options.execution.taskId)
        ? 'verifier-output-malformed'
        : 'unattributed-verifier-absence');
  return {
    phase: 'evaluated',
    attempt: {
      attemptId: options.attemptId,
      invocationId: options.invocationId,
      taskId: options.execution.taskId,
      arm: options.execution.arm,
      ordinal: options.ordinal,
      phase: 'verifier',
      startedAt: options.result.startedAt,
      endedAt: options.result.endedAt,
      elapsedMs: options.result.elapsedMs,
      nativePath: options.result.resultRelativePath === null
        ? null
        : validateRelativeArtifactPath(options.result.resultRelativePath),
      exitCode: failure === null ? 0 : 1,
      signal: null,
      status: failure === null ? 'succeeded' : 'failed',
      failures: failure === null ? [] : [failure],
      annotations: [],
    },
  };
}

export async function evalCommand(options: EvalOptions, context: CommandContext): Promise<void> {
  if (!options.resume) throw new Error('SWE-bench Pro eval requires --resume');
  if (options.gold && options.nullCheck) throw new Error('--gold and --null are mutually exclusive');
  const stores = await loadRunStores(context.paths, options.runId, options.recoverStaleLock);
  const startedMs = performance.now();
  let invocationId: string | null = null;
  let inputLocks: BenchLockHandle[] = [];
  try {
    const operator = loadSwebenchProOperatorConfig(context.paths);
    const config = resumeConfig(operator.swebenchPro, stores.manifest);
    inputLocks = await acquirePreparedInputLocks(context.paths, options.recoverStaleLock);
    const prepared = loadPreparedSwebenchProInputs(
      swebenchProPreparedDir(context.paths, stores.manifest.suiteConfig.preparedInputSha256),
      context.paths,
      config,
    );
    assertPreparedProvenance(stores.manifest, config, prepared, context.paths);
    const instances = manifestInstances(stores.manifest);
    const runDirectory = runDir(context.paths, 'swebench-pro', stores.manifest.runId);
    invocationId = await beginInvocation(stores.state, 'eval', context.clock.now());
    const modes: Array<{ prefix: string; arm: Arm | null; predictions: ReturnType<typeof goldPredictions> }> = options.gold
      ? [{ prefix: 'gold', arm: null, predictions: goldPredictions(instances) }]
      : options.nullCheck
        ? [{ prefix: 'nullcheck', arm: null, predictions: nullPredictions(instances) }]
        : (stores.manifest.experiment.arm === 'both' ? ['a', 'b'] as Arm[] : [stores.manifest.experiment.arm])
          .map((arm) => ({ prefix: arm === 'a' ? 'armA' : 'armB', arm, predictions: collectPredictions(stores.manifest, runDirectory, arm, instances) }));
    for (const mode of modes) {
      const result = await runOfficialEvaluator({
        runDirectory,
        evaluatorDirectory: prepared.evaluatorDirectory,
        evaluatorPythonBinary: prepared.evaluatorPythonBinary,
        config,
        invocationId,
        runId: stores.manifest.runId,
        armLabel: mode.arm ?? (mode.prefix === 'gold' ? 'gold' : 'nullcheck'),
        prefix: mode.prefix,
        predictions: mode.predictions,
        instances,
        containerPolicy: loadSwebenchProContainerPolicy(context.paths),
        processLifecycle: {
          workerScope: runDirectory,
          ...stores.state.lifecycleHooks(invocationId),
        },
      });
      const additions = evaluatorReceiptBindings({
        runDirectory,
        invocationId,
        prefix: mode.prefix,
        arm: mode.arm,
        result,
      });
      const receipt = stores.receipt.load();
      await stores.receipt.update(receipt.revision, (bindings) => [
        ...bindings.filter((binding) => {
          if (mode.arm === null) return !(binding.scope.kind === 'suite-check' && binding.scope.name.startsWith(mode.prefix));
          return !(binding.scope.kind === 'task-arm' && binding.scope.arm === mode.arm)
            && !(binding.scope.kind === 'suite-check' && binding.scope.name.startsWith(mode.prefix));
        }),
        ...additions,
      ]);
      if (mode.arm !== null) {
        const submitted = new Set(mode.predictions.map((prediction) => prediction.instance_id));
        for (const execution of stores.manifest.artifacts.executions.filter((entry) => entry.arm === mode.arm)) {
          const currentState = stores.state.load();
          const attribution = evaluatorTaskAttribution({
            result,
            execution,
            submitted,
            invocationId,
            attemptId: randomUUID(),
            ordinal: currentState.attempts.filter((entry) =>
              entry.taskId === execution.taskId && entry.arm === execution.arm).length + 1,
          });
          if (attribution === null) continue;
          const statusDirectory = executionDirectory(runDirectory, execution.nativeRoot);
          if (!existsSync(statusDirectory)) continue;
          const status = readTaskStatus(statusDirectory);
          writeTaskStatus(statusDirectory, { ...status, phase: attribution.phase });
          await stores.state.updateCurrent((state) => ({
            ...state,
            attempts: [...state.attempts, attribution.attempt],
          }));
        }
      }
      output(context, `${mode.prefix}: ${Object.values(result.verdicts).filter(Boolean).length}/${mode.predictions.length} verified resolved; ${mode.predictions.length - Object.keys(result.verdicts).length} unverified`);
    }
    await finishInvocation(stores.state, invocationId, startedMs, context.clock.now());
  } catch (error) {
    if (invocationId !== null) await finishInvocation(
      stores.state,
      invocationId,
      startedMs,
      context.clock.now(),
      error instanceof OwnershipUnsafeCleanupError ? 'ownership-unsafe' : 'verifier-process-failed',
    );
    throw error;
  } finally {
    try {
      await cleanupActiveSwebenchProEvaluators();
    } finally {
      try {
        releaseLocks(inputLocks);
      } finally {
        stores.lease.release();
      }
    }
  }
}

function nativeResult(
  runDirectory: string,
  binding: VerifierBinding | undefined,
): NativeVerifierResult {
  if (!binding || binding.nativeRecordKey === null) return UNVERIFIED_NATIVE_RESULT;
  let bytes: Buffer;
  try {
    bytes = readRegularFileWithinRoot(runDirectory, binding.path);
  } catch {
    return UNVERIFIED_NATIVE_RESULT;
  }
  if (createHash('sha256').update(bytes).digest('hex') !== binding.sha256) return UNVERIFIED_NATIVE_RESULT;
  let parsed: unknown;
  try { parsed = JSON.parse(bytes.toString('utf8')); } catch { return UNVERIFIED_NATIVE_RESULT; }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return UNVERIFIED_NATIVE_RESULT;
  const verdict = (parsed as Record<string, unknown>)[binding.nativeRecordKey];
  if (typeof verdict !== 'boolean') return UNVERIFIED_NATIVE_RESULT;
  return {
    verification: 'verified',
    score: verdict ? 1 : 0,
    resolved: verdict,
    artifact: { path: binding.path, sha256: binding.sha256, nativeRecordKey: binding.nativeRecordKey },
  };
}

/** A Pro evaluator invocation is complete only with every native input and policy binding. */
export function hasCompleteProVerifierReceipt(
  bindings: readonly VerifierBinding[],
  invocationId: string,
): boolean {
  const roles = new Set(bindings
    .filter((binding) => binding.invocationId === invocationId)
    .map((binding) => binding.role));
  return ['raw-samples', 'predictions', 'verifier-invocation', 'native-config']
    .every((role) => roles.has(role as VerifierBinding['role']));
}

function taskReportInputs(
  manifest: SwebenchProManifest,
  state: BenchRunState,
  receiptBindings: readonly VerifierBinding[],
  runDirectory: string,
): TaskReportInput[] {
  return manifest.artifacts.executions.map((execution) => {
    const scope = taskArmScope(execution.taskId, execution.arm);
    const statusDirectory = executionDirectory(runDirectory, execution.nativeRoot);
    const status = existsSync(statusDirectory) ? readTaskStatus(statusDirectory) : null;
    const scopedAttempts = state.attempts.filter((attempt) =>
      attempt.taskId === execution.taskId && attempt.arm === execution.arm);
    let lastInvalidation = -1;
    scopedAttempts.forEach((attempt, index) => {
      if (attempt.phase === 'cleanup' && attempt.annotations.includes('redo-invalidated')) lastInvalidation = index;
    });
    const currentAttempts = scopedAttempts.slice(lastInvalidation + 1);
    const latestAttempt = currentAttempts.at(-1);
    const binding = [...receiptBindings].reverse().find((entry) => entry.role === 'native-result'
      && entry.scope.kind === 'task-arm' && entry.scope.taskId === execution.taskId && entry.scope.arm === execution.arm);
    const failures = new Set<FailureCode>();
    if (status?.failure) failures.add(status.failure);
    const latestSession = [...currentAttempts].reverse().find((entry) => entry.phase === 'session');
    const latestVerifier = [...currentAttempts].reverse().find((entry) => entry.phase === 'verifier');
    latestSession?.failures.forEach((failure) => failures.add(failure));
    latestVerifier?.failures.forEach((failure) => failures.add(failure));
    if (latestVerifier !== undefined && latestVerifier.status !== 'running'
      && !hasCompleteProVerifierReceipt(receiptBindings, latestVerifier.invocationId)) {
      failures.add('receipt-incomplete');
    }
    return {
      taskId: execution.taskId,
      arm: execution.arm,
      nativeVerifier: nativeResult(runDirectory, binding),
      failures: [...failures].map((code) => failureObservationSchema.parse({
        code, scope, phase: code.startsWith('verifier-') || code === 'unattributed-verifier-absence' ? 'verifier' : 'session',
        terminal: true, evidence: code === 'agent-timeout' ? 'native' : 'driver',
      })),
      annotations: (status?.annotations ?? []).map((code) => annotationSchema.parse({ code, scope })),
      attemptRunning: latestAttempt?.status === 'running',
    };
  });
}

export async function reportCommand(options: RunIdentityOptions, context: CommandContext): Promise<void> {
  const stores = await loadRunStores(context.paths, options.runId, options.recoverStaleLock ?? false);
  const startedMs = performance.now();
  let invocationId: string | null = null;
  try {
    const directory = runDir(context.paths, 'swebench-pro', options.runId);
    const assemble = () => {
      const evidence = loadStoredReportEvidence(context.paths, 'swebench-pro', options.runId);
      const metrics = normalizeBenchMetrics(
        evidence.manifest,
        directory,
        indexSwebenchProMetrics(evidence.manifest, directory),
        evidence.runState,
      );
      return buildBenchReport({
        ...evidence,
        metrics,
        taskResults: taskReportInputs(evidence.manifest, evidence.runState, evidence.verifierReceipt.bindings, directory),
        currentPolicyHashes: currentControlPlaneHashes(context.paths),
        analysisHook: swebenchProAnalysisHook,
        generatedAt: context.clock.now(),
      });
    };
    invocationId = await beginInvocation(stores.state, 'report', context.clock.now());
    assemble();
    await finishInvocation(stores.state, invocationId, startedMs, context.clock.now());
    const report = assemble();
    const written = writeBenchReport(context.paths, report);
    output(context, `wrote ${written.jsonPath}`);
    output(context, `wrote ${written.markdownPath}`);
  } catch (error) {
    rmSync(reportJsonFile(context.paths, 'swebench-pro', options.runId), { force: true });
    rmSync(reportMarkdownFile(context.paths, 'swebench-pro', options.runId), { force: true });
    if (invocationId !== null) {
      await finishInvocation(stores.state, invocationId, startedMs, context.clock.now(), 'unknown-terminal');
    }
    throw error;
  } finally {
    stores.lease.release();
  }
}

export async function statusCommand(options: RunIdentityOptions, context: CommandContext): Promise<void> {
  const stores = await loadRunStores(context.paths, options.runId, options.recoverStaleLock ?? false);
  try {
    const directory = runDir(context.paths, 'swebench-pro', options.runId);
    const state = stores.state.load();
    for (const execution of stores.manifest.artifacts.executions) {
      const taskDirectory = executionDirectory(directory, execution.nativeRoot);
      const status = existsSync(taskDirectory) ? readTaskStatus(taskDirectory) : { phase: 'pending', failure: null };
      const latest = [...state.attempts].reverse().find((attempt) =>
        attempt.taskId === execution.taskId && attempt.arm === execution.arm);
      const failure = status.failure ?? latest?.failures[0] ?? null;
      output(context, `${execution.taskId} ${execution.arm}: ${status.phase}${failure ? ` (${failure})` : ''}`);
    }
  } finally {
    stores.lease.release();
  }
}

interface ContainerInspect {
  Id?: string;
  Config?: { Labels?: Record<string, string> };
  Mounts?: Array<{ Type?: string; Source?: string; Destination?: string }>;
}

function sessionRuntimeDirectory(
  record: ContainerInspect,
  runId: string,
  taskId: string,
  arm: Arm,
  runtimeNonce: string,
): string {
  const mounts = (record.Mounts ?? []).filter((mount) => mount.Type === 'bind'
    && mount.Destination === '/runtime/codex-home' && typeof mount.Source === 'string');
  if (mounts.length !== 1) throw new Error('owned session container has no unique credential runtime mount');
  const runtimeCodex = mounts[0]!.Source!;
  const runtime = dirname(runtimeCodex);
  return assertSessionRuntimeDirectory(runtime, runtimeCodex, runId, taskId, arm, runtimeNonce);
}

function assertSessionRuntimeDirectory(
  runtime: string,
  runtimeCodex: string,
  runId: string,
  taskId: string,
  arm: Arm,
  runtimeNonce: string,
): string {
  const relativeRuntime = relative(tmpdir(), runtime);
  if (!/^uc-bench-pro-runtime-[A-Za-z0-9]+$/.test(relativeRuntime) || relativeRuntime.includes(sep)) {
    throw new Error('owned session credential runtime is outside the exact temporary namespace');
  }
  const uid = typeof process.getuid === 'function' ? process.getuid() : undefined;
  for (const [path, description] of [[runtime, 'runtime'], [runtimeCodex, 'credential mount']] as const) {
    const info = lstatSync(path);
    if (info.isSymbolicLink() || !info.isDirectory() || (info.mode & 0o777) !== 0o700
      || (uid !== undefined && info.uid !== uid)) {
      throw new Error(`owned session ${description} is unsafe`);
    }
  }
  const marker = readPrivateJson(runtime, join(runtime, SESSION_RUNTIME_MARKER));
  const expected = {
    schemaVersion: 2,
    kind: 'ultracode-swebench-pro-session-runtime',
    runId,
    taskId,
    arm,
    runtimeNonce,
  };
  if (canonicalJson(marker) !== canonicalJson(expected)) {
    throw new Error('owned session credential runtime marker does not match its container');
  }
  return runtime;
}

function removeSessionRuntime(
  runtime: string,
  runId: string,
  taskId: string,
  arm: Arm,
  runtimeNonce: string,
): void {
  assertSessionRuntimeDirectory(runtime, join(runtime, 'codex-home'), runId, taskId, arm, runtimeNonce);
  rmSync(runtime, { recursive: true });
}

/** Remove exact manifest-owned runtime homes that survived without a container. */
export function cleanupProRuntimeHomes(manifest: SwebenchProManifest): number {
  const executions = new Set(manifest.artifacts.executions.map((execution) =>
    `${execution.taskId}\0${execution.arm}`));
  const candidates = readdirSync(tmpdir(), { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^uc-bench-pro-runtime-[A-Za-z0-9]+$/.test(entry.name))
    .flatMap((entry) => {
      const runtime = join(tmpdir(), entry.name);
      try {
        const marker = readPrivateJson(runtime, join(runtime, SESSION_RUNTIME_MARKER));
        if (marker === null || typeof marker !== 'object' || Array.isArray(marker)) return [];
        const observed = marker as Record<string, unknown>;
        const taskId = typeof observed.taskId === 'string' ? observed.taskId : '';
        const arm: Arm | null = observed.arm === 'a' || observed.arm === 'b' ? observed.arm : null;
        const runtimeNonce = typeof observed.runtimeNonce === 'string' ? observed.runtimeNonce : '';
        if (arm === null || !executions.has(`${taskId}\0${arm}`) || !/^[a-f0-9]{64}$/.test(runtimeNonce)) return [];
        const expected = {
          schemaVersion: 2,
          kind: 'ultracode-swebench-pro-session-runtime',
          runId: manifest.runId,
          taskId,
          arm,
          runtimeNonce,
        };
        if (canonicalJson(marker) !== canonicalJson(expected)) return [];
        assertSessionRuntimeDirectory(runtime, join(runtime, 'codex-home'), manifest.runId, taskId, arm, runtimeNonce);
        return [{ runtime, taskId, arm, runtimeNonce }];
      } catch (error) {
        throw new Error(`unsafe SWE-bench Pro runtime namespace entry: ${runtime}`, { cause: error });
      }
    });
  if (new Set(candidates.map((candidate) => candidate.runtimeNonce)).size !== candidates.length) {
    throw new Error('SWE-bench Pro session runtime nonce is not unique');
  }
  for (const candidate of candidates) removeSessionRuntime(
    candidate.runtime,
    manifest.runId,
    candidate.taskId,
    candidate.arm,
    candidate.runtimeNonce,
  );
  return candidates.length;
}

export function ownedRunContainerIds(
  records: readonly ContainerInspect[],
  runId: string,
  taskIds: ReadonlySet<string>,
  invocationIds: ReadonlySet<string>,
): string[] {
  return records.flatMap((record) => {
    const labels = record.Config?.Labels ?? {};
    const purpose = labels['ultracode.benchmark.purpose'];
    const arm = labels['ultracode.benchmark.arm'];
    const exactPurpose = purpose === 'session'
      ? (arm === 'a' || arm === 'b') && /^[a-f0-9]{64}$/.test(labels['ultracode.benchmark.runtime'] ?? '')
      : purpose === 'verifier'
        && ['a', 'b', 'gold', 'nullcheck'].includes(arm ?? '')
        && invocationIds.has(labels['ultracode.benchmark.invocation'] ?? '');
    return record.Id
      && /^[a-f0-9]{64}$/.test(record.Id)
      && labels['ultracode.benchmark.schema'] === '2'
      && labels['ultracode.benchmark.suite'] === 'swebench-pro'
      && labels['ultracode.benchmark.run'] === runId
      && taskIds.has(labels['ultracode.benchmark.task'] ?? '')
      && exactPurpose
      && labels['ultracode.benchmark.ownership'] === '1'
      ? [record.Id]
      : [];
  });
}

async function cleanRunContainers(
  manifest: SwebenchProManifest,
  invocationIds: ReadonlySet<string>,
  executor: DockerExecutor = defaultDockerExecutor,
): Promise<number> {
  try {
    const runId = manifest.runId;
    const listRunIds = async (): Promise<string[]> => {
      const ids = (await executor(['ps', '-aq', '--no-trunc', '--filter', `label=ultracode.benchmark.run=${runId}`]))
        .split('\n').map((entry) => entry.trim()).filter(Boolean);
      if (ids.some((id) => !/^[a-f0-9]{64}$/.test(id))) {
        throw new Error('Docker returned an invalid run-owned container id');
      }
      return ids;
    };
    const ids = await listRunIds();
    const parsed = ids.length === 0 ? [] : JSON.parse(await executor(['inspect', ...ids])) as ContainerInspect[];
    if (parsed.length !== ids.length || parsed.some((record) => typeof record.Id !== 'string'
      || !/^[a-f0-9]{64}$/.test(record.Id)
      || ids.filter((id) => record.Id === id).length !== 1)) {
      throw new Error('Docker inspection did not exactly bind the requested run-owned container ids');
    }
    const owned = ownedRunContainerIds(parsed, runId, new Set(manifest.experiment.taskIds), invocationIds);
    if (owned.length !== parsed.length) {
      throw new Error('run-labelled Docker resources do not have complete manifest ownership');
    }
    for (const id of owned) {
      const record = parsed.find((candidate) => candidate.Id === id)!;
      const labels = record.Config?.Labels ?? {};
      const runtime = labels['ultracode.benchmark.purpose'] === 'session'
        ? sessionRuntimeDirectory(
            record,
            runId,
            labels['ultracode.benchmark.task']!,
            labels['ultracode.benchmark.arm'] as Arm,
            labels['ultracode.benchmark.runtime']!,
          )
        : null;
      let removalFailure: unknown;
      try {
        await executor(['rm', '-f', id]);
      } catch (error) {
        removalFailure = error;
      }
      const remaining = await listRunIds();
      if (remaining.includes(id)) {
        throw ownershipUnsafeAggregate('run-owned container absence was not proven after removal', [
          removalFailure,
          new Error(`run-owned container remains present: ${id}`),
        ]);
      }
      if (runtime !== null) removeSessionRuntime(
        runtime,
        runId,
        labels['ultracode.benchmark.task']!,
        labels['ultracode.benchmark.arm'] as Arm,
        labels['ultracode.benchmark.runtime']!,
      );
    }
    const remaining = await listRunIds();
    if (remaining.length > 0) {
      throw new Error(`run-owned containers remain after cleanup: ${remaining.join(', ')}`);
    }
    cleanupProRuntimeHomes(manifest);
    return owned.length;
  } catch (error) {
    throw ownershipUnsafe('unsafe SWE-bench Pro run-owned cleanup', error);
  }
}

export async function cleanCommand(options: CleanOptions, context: CommandContext): Promise<void> {
  const stores = await loadRunStores(context.paths, options.runId, options.recoverStaleLock ?? false);
  const startedMs = performance.now();
  let invocationId: string | null = null;
  try {
    invocationId = await beginInvocation(stores.state, 'clean', context.clock.now());
    const containers = await cleanRunContainers(
      stores.manifest,
      new Set(stores.state.load().invocations.map((invocation) => invocation.invocationId)),
    );
    const attestations = [...imageAttestations(stores.manifest).values()];
    const images = options.images ? await removeTaskImages(attestations) : 0;
    if (options.images && images !== new Set(attestations.map((entry) => entry.overlayLocalId)).size) {
      throw ownershipUnsafe('not every exact run-owned overlay image was removed');
    }
    rmSync(reportJsonFile(context.paths, 'swebench-pro', options.runId), { force: true });
    rmSync(reportMarkdownFile(context.paths, 'swebench-pro', options.runId), { force: true });
    await finishInvocation(stores.state, invocationId, startedMs, context.clock.now());
    output(context, `removed ${containers} owned containers${options.images ? ` and ${images} owned overlay images` : ''}`);
  } catch (error) {
    if (invocationId !== null) await finishInvocation(
      stores.state,
      invocationId,
      startedMs,
      context.clock.now(),
      error instanceof OwnershipUnsafeCleanupError ? 'ownership-unsafe' : 'unknown-terminal',
    );
    throw error;
  } finally {
    stores.lease.release();
  }
}

/** Root fatal/signal cleanup covers native processes and daemon-owned sessions. */
export async function cleanupSwebenchProRuntime(): Promise<void> {
  const failures: unknown[] = [];
  try {
    await cleanupActiveBenchProcesses();
  } catch (error) {
    failures.push(error);
  }
  const settled = await Promise.allSettled([
    cleanupActiveSwebenchProEvaluators(),
    cleanupActiveSwebenchProContainers(),
  ]);
  failures.push(...settled.flatMap((result) => result.status === 'rejected' ? [result.reason] : []));
  if (failures.some((error) => error instanceof OwnershipUnsafeCleanupError)) {
    throw ownershipUnsafeAggregate('SWE-bench Pro runtime cleanup failed ownership checks', failures);
  }
  if (failures.length > 0) throw new AggregateError(failures, 'SWE-bench Pro runtime cleanup failed');
}

export const defaultCommandContext = (paths: BenchPathRoots): CommandContext => ({
  stdout: process.stdout,
  stderr: process.stderr,
  paths,
  clock: SYSTEM_CLOCK,
});
