/** SWE-bench Pro lifecycle on the shared manifest, state, receipt, and report services. */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
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
  canonicalHostPath,
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
  validateTaskId,
  writePrivateFileAtomic,
  writePrivateJsonAtomic,
} from '../../shared/paths.js';
import {
  BenchProcessError,
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
import { BenchRunStateStore, type AttemptRecord, type BenchRunState } from '../../shared/run-state.js';
import {
  createVerifierBinding,
  UNVERIFIED_NATIVE_RESULT,
  VerifierReceiptStore,
  type NativeVerifierResult,
  type VerifierBinding,
} from '../../shared/verifier.js';
import {
  OFFICIAL_SWEBENCH_PRO_EVALUATOR_REPOSITORY,
  OFFICIAL_SWEBENCH_PRO_EVALUATOR_REVISION,
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
  removeTaskImageTargets,
  removeTaskImages,
  type DockerExecutor,
} from './image.js';
import {
  containerPolicySha256,
  dockerNanoCpus,
  loadSwebenchProContainerPolicy,
  reclamationContainerPolicyArgv,
  sessionContainerPolicyArgv,
  sessionTaskIdentity,
  type SwebenchProContainerPolicy,
} from './container-policy.js';
import {
  SwebenchProTransportAttestationError,
  inspectSwebenchProSessionAttachment,
  inspectSwebenchProTransportBoundary,
  loadSwebenchProTransportBindings,
  swebenchProCurrentEndpointIds,
  swebenchProTransportPolicyLockFile,
  swebenchProTransportPolicyLockRoot,
  transportAttestationFailure,
  type SwebenchProSessionAttachment,
  type SwebenchProTransportAttestation,
  type SwebenchProTransportBindings,
} from './model-transport.js';
import {
  ArtifactUnsafeError,
  OwnershipUnsafeCleanupError,
  cleanupActiveReclamationHelpers,
  ownershipUnsafe,
  ownershipUnsafeAggregate,
  releaseActiveReclamationHelper,
  trackActiveReclamationHelper,
  type ActiveReclamationHelper,
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
import {
  classifyPatchArtifact,
  classifyOutcome,
  parseSessionMeta,
  readPatchArtifact,
  readTaskStatus,
  writeTaskStatus,
} from './state.js';
import { indexSwebenchProMetrics } from './telemetry.js';
import {
  loadCurrentPreparedSwebenchProInputs,
  loadPreparedSwebenchProInputs,
  prepareSwebenchProInputs,
} from './toolchain.js';
import type {
  DockerImageAttestation,
  ReclamationContainerInspect,
  ReclamationContainerSpec,
  SessionMeta,
  SwebenchProInstance,
  TaskStatus,
} from './types.js';
import {
  cleanupActiveSwebenchProEvaluators,
  collectPredictions,
  existingEvaluatorContainerIds,
  goldPredictions,
  nullPredictions,
  runOfficialEvaluator,
  type EvaluatorRunResult,
  type EvaluatorImageIdentity,
} from './verifier.js';
import { ARM_B_PREFIX_PATH } from '../../shared/prompt.js';

const SESSION_BACKSTOP_EXTRA_MS = 15 * 60_000;
const SESSION_CLEANUP_RESERVE_MS = 2 * 60_000;
const RECLAMATION_ATTEMPTS = 2;
const TRUSTED_MUSL_LOADER = '/opt/bench/node-musl-runtime/ld-musl-x86_64.so.1';
const TRUSTED_BUSYBOX = '/opt/bench/node-musl-runtime/busybox';
const TRUSTED_SESSION_GATE = '/opt/bench/session-gate.sh';
const TASK_ENTRYPOINT = '/opt/bench/entrypoint.sh';
const RECLAMATION_COMMAND = `owner=$1; shift; ${TRUSTED_MUSL_LOADER} ${TRUSTED_BUSYBOX} chown -R "$owner" "$@"`
  + ` && ${TRUSTED_MUSL_LOADER} ${TRUSTED_BUSYBOX} chmod 0700 "$@"`;
const RECLAMATION_NAME_PREFIX = 'ucbench-reclaim-';
const RECLAMATION_NAME_RE = /^\/ucbench-reclaim-[a-f0-9]{32}$/;
const RECLAMATION_NAMESPACE_LIMIT = 16_384;
const SANITIZED_BOOTSTRAP_ENV = [
  'BASH_ENV=', 'ENV=', 'LD_PRELOAD=', 'LD_AUDIT=', 'LD_LIBRARY_PATH=', 'NODE_OPTIONS=',
] as const;
const RECLAMATION_INSPECT_BATCH_SIZE = 512;
const TERMINAL_PHASES = new Set(['session-done', 'patched', 'evaluated']);
const TOOLCHAIN_CACHE_LOCK = '.locks/toolchain.lock';
const SUITE_CACHE_LOCK = '.locks/swebench-pro.lock';
const SESSION_RUNTIME_MARKER = 'ownership.json';

export const SWEBENCH_PRO_ADAPTER_POLICY_SHA256 = sha256CanonicalJson({
  schemaVersion: 3,
  runLayout: 'suite-run/native/tasks/artifact-key/arm',
  fresh: 'claim-exclusive-directory',
  resume: 'manifest-exists-complete-immutable-projection',
  redo: 'task-arm-exact-helper-absence-before-invalidation',
  verifier: 'strict-partial-native-booleans',
  modelTransport: 'credential-free-task-on-internal-network-via-attested-strict-relay-run-fatal-drift',
  dataset: 'configured-canonical-descriptor-v1-unaudited-local-digest',
  cleanup: 'typed-command-fatal-launch-settlement-exact-name-id-proof-retry-fresh-per-resource-deadlines',
  containers: 'immutable-id-no-healthcheck-sanitized-bootstrap-owned-reclamation-lifecycle-exact-evaluator-ownership',
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
      'src/cli.ts',
      'src/shared/config.ts',
      'src/shared/contracts.ts',
      'src/shared/docker-isolation.ts',
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
      '../src/exec/procinfo.ts',
      '../src/exec/spawn.ts',
      'src/suites/swebench-pro/adapter.ts',
      'src/suites/swebench-pro/analysis.ts',
      'src/suites/swebench-pro/cleanup.ts',
      'src/suites/swebench-pro/config.ts',
      'src/suites/swebench-pro/container-policy.ts',
      'src/suites/swebench-pro/image.ts',
      'src/suites/swebench-pro/instances.ts',
      'src/suites/swebench-pro/model-transport.ts',
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
  evaluatorDependencyTarget: string,
  requirementsSha256: string,
  requirementsProvenanceSha256: string,
  resolvedRequirementsSha256: string,
  ownershipPatchSha256: string,
  evaluatorPolicyHelperSha256: string,
  preparedContainerPolicySha256: string,
  adapterPolicySha256 = currentControlPlaneHashes(roots).adapterPolicySha256,
): SwebenchProManifest['suiteConfig']['policies'] {
  const entrypoint = join(roots.benchRoot, 'suites', 'swebench-pro', 'entrypoint.sh');
  const sessionGate = join(roots.benchRoot, 'suites', 'swebench-pro', 'session-gate.sh');
  const privilegeDropper = join(roots.benchRoot, 'suites', 'swebench-pro', 'drop-privileges.mjs');
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
      sessionGateSha256: sha256File(sessionGate),
      privilegeDropperSha256: sha256File(privilegeDropper),
      gitSanitizerSha256: sha256File(gitSanitizer),
      gitCaptureSha256: sha256File(gitCapture),
      containerPolicySha256: containerPolicySha256(policy),
      setupUser: '0:0',
      taskUser: 'dynamic-host-distinct-nonzero-cleared-capability-sets',
      repositoryPreparation: 'host-sanitized-once-per-task-overlay-copy-on-write-per-arm',
      postTaskGitCapture: 'immutable-helper-as-task-uid',
    }),
    historySha256: sha256CanonicalJson({
      base: 'exact',
      trackedDirty: 'reject',
      preDirty: 'untracked-excluded',
      objectDatabase: 'fresh-base-reachable-closure-only',
      refs: 'base-branch-and-head-only',
      sanitizerExecution: 'host-before-overlay-build',
      audit: 'host-private-detailed-safe-summary-published-post-session',
    }),
    cleanupSha256: sha256CanonicalJson({
      sessionLabels: 'schema-suite-run-task-arm-purpose-ownership-runtime',
      verifierLabels: 'schema-suite-run-task-arm-purpose-ownership-invocation',
      reclamationLabels: 'schema-suite-run-task-arm-purpose-ownership-artifact-owner-optional-runtime',
      reclamationOwnership: 'exact-name-id-image-command-user-policy-resources-mounts',
      verifierOwnership: 'post-baseline-exact-local-image-workspace-mount-invocation-start',
      artifactTree: 'stopped-reclaimed-owned-real-single-link',
      ambiguity: 'requery-exact-identity-retain-until-absent',
      fatality: 'ownership-unsafe-command-fatal',
    }),
    evaluatorSha256: sha256CanonicalJson({
      evaluatorDependencyTarget,
      requirementsSha256,
      requirementsProvenanceSha256,
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
    'suites/swebench-pro/session-gate.sh',
    'suites/swebench-pro/drop-privileges.mjs',
    'suites/swebench-pro/sanitize-git.sh',
    'suites/swebench-pro/capture-git.sh',
    'suites/swebench-pro/container-policy.json',
    'suites/swebench-pro/dataset-pin.json',
    'suites/swebench-pro/evaluator-policy.py',
    'suites/swebench-pro/evaluator-ownership.patch',
    'suites/swebench-pro/evaluator-requirements.lock',
    'suites/swebench-pro/evaluator-requirements.provenance.json',
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
  transport: SwebenchProTransportAttestation,
  createdAt: Date,
): SwebenchProManifest {
  const taskIds = instances.map((instance) => instance.instanceId);
  const orders = taskIds.map((taskId) => ({ taskId, arms: armOrder(config.selection.seed, taskId, config.arm) }));
  const controlPlane = currentControlPlaneHashes(roots);
  const policies = currentPolicies(
    roots,
    prepared.evaluatorDependencyTarget,
    prepared.requirementsSha256,
    prepared.requirementsProvenanceSha256,
    prepared.resolvedRequirementsSha256,
    prepared.ownershipPatchSha256,
    prepared.evaluatorPolicyHelperSha256,
    prepared.containerPolicyFileSha256,
    controlPlane.adapterPolicySha256,
  );
  const nativeAssets = swebenchProNativeAssets(roots);
  return {
    schemaVersion: 3,
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
      modelTransport: { mechanism: 'attested-model-relay', ...transport },
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
      selection: config.selection.taskIds === null ? {
        mode: 'seeded-stratified',
        seed: config.selection.seed,
        count: instances.length,
        stratifyBy: config.selection.stratifyBy,
        requestedTaskIds: [],
      } : {
        mode: 'explicit',
        seed: null,
        count: instances.length,
        stratifyBy: null,
        requestedTaskIds: config.selection.taskIds,
      },
      instances: instances.map((instance) => ({
        taskId: instance.instanceId,
        row: instance.row as Record<string, never>,
        rowSha256: sha256CanonicalJson(instance.row),
      })),
      armOrder: orders,
      modelTransport: { mechanism: 'attested-model-relay', ...transport },
      policies,
      attempts: 1,
      retries: 0,
      evaluator: { workers: config.concurrency.verifier, watchdogMs: config.timeouts.evaluatorWatchdogMs },
      docker: { cpus: config.docker.cpus, memoryBytes: config.docker.memoryBytes },
    },
  };
}

function overrideConfig(config: SwebenchProConfig, options: RunOptions): SwebenchProConfig {
  return resolveSwebenchProConfig({ schemaVersion: 3, toolchain: {
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

export function assertExplicitResumeOptions(options: RunOptions, manifest: SwebenchProManifest): void {
  const checks: Array<[string, unknown, unknown]> = [
    ['model', options.model, manifest.experiment.model],
    ['requested-effort', options.requestedEffort, manifest.experiment.requestedEffort],
    ['arm', options.arm, manifest.experiment.arm],
    ['task-concurrency', options.taskConcurrency, manifest.limits.taskConcurrency],
    ['session-timeout-ms', options.sessionTimeoutMs, manifest.limits.hostTaskTimeoutMs],
    ['count', options.count, manifest.experiment.taskIds.length],
    ['seed', options.seed, manifest.suiteConfig.selection.seed ?? 0],
  ];
  if (options.taskIds !== undefined) checks.push(['task-id', canonicalJson(options.taskIds), canonicalJson(manifest.experiment.taskIds)]);
  for (const [name, actual, expected] of checks) {
    if (actual !== undefined && actual !== expected) throw new Error(`--${name} does not match the immutable manifest`);
  }
}

function resumeConfig(operator: SwebenchProConfig, manifest: SwebenchProManifest): SwebenchProConfig {
  if (manifest.provenance.suiteSource.repository !== OFFICIAL_SWEBENCH_PRO_EVALUATOR_REPOSITORY
    || manifest.provenance.suiteSource.revision !== OFFICIAL_SWEBENCH_PRO_EVALUATOR_REVISION) {
    throw new Error('manifest evaluator source is not the canonical official pin');
  }
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
    modelTransport: { ...operator.modelTransport },
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
    },
    evaluator: {
      ...operator.evaluator,
      repository: OFFICIAL_SWEBENCH_PRO_EVALUATOR_REPOSITORY,
      revision: OFFICIAL_SWEBENCH_PRO_EVALUATOR_REVISION,
    },
    pricing: manifest.pricing === null ? undefined : {
      [manifest.pricing.model]: {
        uncachedInputPerMTokens: manifest.pricing.uncachedInputPerMTokens,
        cachedInputPerMTokens: manifest.pricing.cachedInputPerMTokens,
        outputPerMTokens: manifest.pricing.outputPerMTokens,
      },
    },
  };
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
      prepared.evaluatorDependencyTarget,
      prepared.requirementsSha256,
      prepared.requirementsProvenanceSha256,
      prepared.resolvedRequirementsSha256,
      prepared.ownershipPatchSha256,
      prepared.evaluatorPolicyHelperSha256,
      prepared.containerPolicyFileSha256,
      currentControlPlane.adapterPolicySha256,
    )) !== canonicalJson(manifest.suiteConfig.policies)) {
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
): Promise<{
  manifest: SwebenchProManifest;
  policyLock: BenchLockHandle;
  lease: BenchLockHandle;
  state: BenchRunStateStore;
  receipt: VerifierReceiptStore;
}> {
  const policyLock = await acquireBenchLock(swebenchProTransportPolicyLockRoot(), swebenchProTransportPolicyLockFile(roots), {
    recoverStale: recoverStaleLock,
  });
  let lease: BenchLockHandle | null = null;
  try {
    if (policyLock.path !== swebenchProTransportPolicyLockFile(roots)) {
      throw new Error('SWE-bench Pro recovery requires the exact model-transport policy lock');
    }
    policyLock.assertHeld();
    lease = await acquireBenchLock(roots.resultsRoot, runLeaseFile(roots, 'swebench-pro', runId), {
      recoverStale: recoverStaleLock,
      createParent: false,
    });
    const manifest = loadBenchRunManifest(roots, 'swebench-pro', runId) as SwebenchProManifest;
    const manifestSha256 = sha256File(manifestFile(roots, 'swebench-pro', runId));
    const state = new BenchRunStateStore(roots, 'swebench-pro', runId, manifestSha256, lease);
    state.migrateLegacyIfNeeded();
    await state.recoverPendingLifecycleProcesses(runDir(roots, 'swebench-pro', runId));
    if (state.load().invocations.some((invocation) => invocation.endedAt === null)) {
      await cleanRunContainers(
        roots,
        manifest,
        new Map(state.load().invocations.map((invocation) => [
          invocation.invocationId,
          Date.parse(invocation.startedAt),
        ])),
      );
      await state.closeInterruptedInvocations();
    }
    return {
      manifest,
      policyLock,
      lease,
      state,
      receipt: new VerifierReceiptStore(roots, 'swebench-pro', runId, manifestSha256, lease),
    };
  } catch (error) {
    lease?.release();
    policyLock.release();
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

type ProcessLifecycle = Pick<BenchProcessOptions,
  'workerScope' | 'onLifecycleToken' | 'onLifecycleStarted' | 'onLifecycleRecovered'>;

export interface SessionContainerLaunchContext {
  runtime: string;
  runtimeNonce: string;
  runId: string;
  taskId: string;
  arm: Arm;
  taskDirectory: string;
  artifactOwner: SessionArtifactOwner;
  image: DockerImageAttestation;
  docker: SwebenchProConfig['docker'];
  policy: SwebenchProContainerPolicy;
  attemptDeadline: number;
  lifecycle: ProcessLifecycle;
  executor: SessionDockerExecutor;
}

interface ActiveSessionContainer extends SessionContainerLaunchContext {
  containerId?: string;
  launchSettlement: Promise<void>;
  settleLaunch: () => void;
  cleanupPromise?: Promise<void>;
}

const activeContainers = new Map<string, ActiveSessionContainer>();
let transportAttestationTail = Promise.resolve();

/** Shared fatal signal that stops accepting work and starts exact active-session cleanup. */
export class SwebenchProRunFatalController {
  private readonly abortController = new AbortController();
  private readonly fatalSignal: Promise<SwebenchProTransportAttestationError>;
  private resolveFatal!: (error: SwebenchProTransportAttestationError) => void;
  private fatalError: SwebenchProTransportAttestationError | null = null;
  private cleanupPromise: Promise<unknown> | null = null;

  constructor(
    private readonly cleanup: () => Promise<unknown> = cleanupActiveSessionResources,
  ) {
    this.fatalSignal = new Promise((resolvePromise) => { this.resolveFatal = resolvePromise; });
  }

  get signal(): AbortSignal {
    return this.abortController.signal;
  }

  get failure(): SwebenchProTransportAttestationError | null {
    return this.fatalError;
  }

  abort(error: SwebenchProTransportAttestationError): void {
    if (this.fatalError !== null) return;
    this.fatalError = error;
    this.abortController.abort(error);
    this.resolveFatal(error);
    this.cleanupPromise = Promise.resolve().then(this.cleanup);
    void this.cleanupPromise.catch(() => {});
  }

  throwIfAborted(): void {
    if (this.fatalError !== null) throw this.fatalError;
  }

  async race<T>(operation: Promise<T>): Promise<T> {
    this.throwIfAborted();
    return Promise.race([
      operation,
      this.fatalSignal.then((error) => { throw error; }),
    ]);
  }

  async settleCleanup(): Promise<void> {
    await this.cleanupPromise;
  }
}

async function withTransportAttestationLock<T>(
  operation: () => Promise<T>,
  fatalController?: SwebenchProRunFatalController,
): Promise<T> {
  let release!: () => void;
  const previous = transportAttestationTail;
  transportAttestationTail = new Promise<void>((resolvePromise) => { release = resolvePromise; });
  await previous;
  try {
    fatalController?.throwIfAborted();
    return await operation();
  } finally {
    release();
  }
}

function activeSessionEndpoints(): Map<string, string> {
  return new Map([...activeContainers.entries()].flatMap(([name, container]) =>
    container.containerId === undefined ? [] : [[name, container.containerId]]));
}

function trackContainer(
  name: string,
  context: SessionContainerLaunchContext,
): ActiveSessionContainer {
  if (activeContainers.has(name)) throw new Error(`session container is already tracked: ${name}`);
  let settleLaunch!: () => void;
  const launchSettlement = new Promise<void>((resolvePromise) => { settleLaunch = resolvePromise; });
  const container: ActiveSessionContainer = { ...context, launchSettlement, settleLaunch };
  activeContainers.set(name, container);
  return container;
}

export type SessionDockerExecutor = (
  argv: readonly string[],
  lifecycle?: ProcessLifecycle,
  timeoutMs?: number,
) => Promise<string>;

export const defaultSessionDockerExecutor: SessionDockerExecutor = async (
  argv,
  lifecycle = {},
  timeoutMs,
): Promise<string> => {
  return (await runBenchProcess('docker', argv, {
    cwd: process.cwd(),
    tailBytes: 8 * 1_024 * 1_024,
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
    ...lifecycle,
  })).stdout;
};

/** Register before launch and expose one settlement shared by normal and fatal cleanup. */
export function launchTrackedSessionContainer(
  name: string,
  context: SessionContainerLaunchContext,
  launch: () => Promise<string>,
): Promise<string> {
  const container = trackContainer(name, context);
  const launched = Promise.resolve().then(launch).then((stdout) => {
    const containerId = stdout.trim();
    if (!/^[a-f0-9]{64}$/.test(containerId)) {
      throw transportAttestationFailure(
        'session-inspect',
        new Error('Docker returned an invalid session container id'),
      );
    }
    container.containerId = containerId;
    return containerId;
  });
  void launched.then(container.settleLaunch, container.settleLaunch);
  return launched;
}

export async function attestModelTransport(
  config: SwebenchProConfig,
  bindings: SwebenchProTransportBindings,
  executor: SessionDockerExecutor = defaultSessionDockerExecutor,
  lifecycle: ProcessLifecycle = {},
  timeoutMs?: number,
  allowedSessions: ReadonlyMap<string, string> = new Map(),
  requiredSessionNames: ReadonlySet<string> = new Set(),
): Promise<SwebenchProTransportAttestation> {
  let network: string;
  try {
    network = await executor(['network', 'inspect', bindings.restrictedNetwork], lifecycle, timeoutMs);
  } catch (error) {
    throw transportAttestationFailure('restricted-network-inspect', error);
  }
  try {
    void new URL(bindings.relayBaseUrl);
  } catch (error) {
    throw transportAttestationFailure('model-relay-inspect', error);
  }
  let relay: string;
  try {
    const endpointIds = swebenchProCurrentEndpointIds(
      network,
      bindings,
      allowedSessions,
      requiredSessionNames,
    );
    relay = await executor(['inspect', ...endpointIds], lifecycle, timeoutMs);
  } catch (error) {
    throw transportAttestationFailure('model-relay-inspect', error);
  }
  return inspectSwebenchProTransportBoundary(
    network,
    relay,
    config.modelTransport,
    config.model,
    bindings,
    allowedSessions,
    requiredSessionNames,
  );
}

/** Inspect and bind one launched task attachment to the typed transport proof. */
export async function attestSessionTransportAttachment(
  executor: SessionDockerExecutor,
  expected: SwebenchProSessionAttachment,
  bindings: SwebenchProTransportBindings,
  lifecycle: ProcessLifecycle = {},
  timeoutMs?: number,
): Promise<void> {
  let inspection: string;
  try {
    inspection = await executor(['inspect', expected.id], lifecycle, timeoutMs);
  } catch (error) {
    throw transportAttestationFailure('session-inspect', error);
  }
  inspectSwebenchProSessionAttachment(inspection, expected, bindings);
}

export interface StartAttestedSessionTransportOptions {
  executor: SessionDockerExecutor;
  expected: SwebenchProSessionAttachment;
  bindings: SwebenchProTransportBindings;
  config: SwebenchProConfig;
  manifest: SwebenchProManifest;
  allowedSessions: ReadonlyMap<string, string>;
  runtimeHome: string;
  lifecycle?: ProcessLifecycle;
  timeoutMs: () => number;
}

/** Start only a stopped-attested session and publish its gate after live topology proof. */
export async function startAttestedSessionTransport(
  options: StartAttestedSessionTransportOptions,
): Promise<void> {
  const lifecycle = options.lifecycle ?? {};
  const expected = { ...options.expected, running: false };
  await attestSessionTransportAttachment(
    options.executor,
    expected,
    options.bindings,
    lifecycle,
    options.timeoutMs(),
  );
  const startedId = (await options.executor(
    ['start', expected.id],
    lifecycle,
    options.timeoutMs(),
  )).trim();
  if (startedId !== expected.id) {
    throw transportAttestationFailure(
      'session-inspect',
      new Error('Docker did not start the exact attested session container'),
    );
  }
  await attestSessionTransportAttachment(
    options.executor,
    { ...expected, running: true },
    options.bindings,
    lifecycle,
    options.timeoutMs(),
  );
  const transport = await attestModelTransport(
    options.config,
    options.bindings,
    options.executor,
    lifecycle,
    options.timeoutMs(),
    options.allowedSessions,
    new Set([expected.name]),
  );
  assertModelTransportProvenance(options.manifest, transport);
  writePrivateFileAtomic(
    options.runtimeHome,
    join(options.runtimeHome, '.model-transport-attested'),
    `${expected.runtimeNonce}\n`,
  );
}

export function assertModelTransportProvenance(
  manifest: SwebenchProManifest,
  attestation: SwebenchProTransportAttestation,
): void {
  const frozen = { mechanism: 'attested-model-relay', ...attestation };
  if (canonicalJson(frozen) !== canonicalJson(manifest.provenance.modelTransport)
    || canonicalJson(frozen) !== canonicalJson(manifest.suiteConfig.modelTransport)) {
    throw transportAttestationFailure(
      'manifest-transport',
      new Error('SWE-bench Pro model transport identity, topology, or strict relay policy drifted'),
    );
  }
}

export interface SessionArtifactOwner {
  uid: number;
  gid: number;
}

function hostArtifactOwner(): SessionArtifactOwner {
  const uid = typeof process.getuid === 'function' ? process.getuid() : 0;
  const gid = typeof process.getgid === 'function' ? process.getgid() : 0;
  if (!Number.isSafeInteger(uid) || uid < 0 || !Number.isSafeInteger(gid) || gid < 0) {
    throw new Error('host artifact owner is invalid');
  }
  return { uid, gid };
}

/** Return a positive per-operation timeout from one monotonic attempt deadline. */
export function remainingSessionOperationTimeout(
  deadline: number,
  reserveMs = 0,
  now = performance.now(),
): number {
  if (!Number.isFinite(deadline) || !Number.isFinite(reserveMs) || reserveMs < 0) {
    throw new Error('session Docker deadline is invalid');
  }
  const remaining = Math.ceil(deadline - now - reserveMs);
  if (remaining <= 0) throw new Error('session Docker deadline is exhausted');
  return remaining;
}

/** Give one verified survivor a monotonic deadline shared by all of its operations. */
export function runCleanupOperationTimeout(
  deadline = performance.now() + SESSION_CLEANUP_RESERVE_MS,
  now = performance.now(),
): number {
  return remainingSessionOperationTimeout(deadline, 0, now);
}

/** Create a decreasing timeout source with a fresh bounded deadline for one survivor. */
export function survivorCleanupTimeout(
  clock: () => number = () => performance.now(),
): () => number {
  const deadline = clock() + SESSION_CLEANUP_RESERVE_MS;
  return () => runCleanupOperationTimeout(deadline, clock());
}

/** Race Docker wait against the driver backstop without retaining a timer on either settlement path. */
export async function waitForSessionExit(
  waited: Promise<unknown>,
  timeoutMs: number,
): Promise<'exited' | 'backstop'> {
  let timer: NodeJS.Timeout | undefined;
  try {
    const stopped = new Promise<'backstop'>((resolvePromise) => {
      timer = setTimeout(resolvePromise, timeoutMs, 'backstop');
    });
    return await Promise.race([waited.then(() => 'exited' as const), stopped]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function containerName(runId: string, taskId: string, arm: Arm): string {
  return `ucbench-${createHash('sha256').update(`${runId}\0${taskId}\0${arm}`, 'utf8').digest('hex').slice(0, 32)}`;
}

/** Derive the one validated Docker name shared by all reclamation attempts for a task arm. */
export function reclamationContainerName(runId: string, taskId: string, arm: Arm): string {
  validateRunId(runId);
  validateTaskId(taskId);
  if (arm !== 'a' && arm !== 'b') throw new Error('invalid reclamation helper arm');
  const digest = createHash('sha256')
    .update(`reclamation\0${runId}\0${taskId}\0${arm}`, 'utf8')
    .digest('hex')
    .slice(0, 32);
  return `ucbench-reclaim-${digest}`;
}

async function listExactSessionContainerName(
  name: string,
  lifecycle: ProcessLifecycle,
  executor: SessionDockerExecutor,
  timeoutMs: number,
): Promise<string[]> {
  const listed = (await executor([
    'ps', '-aq', '--no-trunc', '--filter', `name=^/${name}$`,
  ], lifecycle, timeoutMs)).split('\n').map((entry) => entry.trim()).filter(Boolean);
  if (listed.length > 1 || listed.some((id) => !/^[a-f0-9]{64}$/.test(id))) {
    throw new Error(`session container name is not uniquely bound to a valid id: ${name}`);
  }
  return listed;
}

async function proveTrackedSessionContainerAbsent(
  name: string,
  container: ActiveSessionContainer,
  timeout: () => number,
): Promise<void> {
  try {
    const byName = await listExactSessionContainerName(
      name,
      container.lifecycle,
      container.executor,
      timeout(),
    );
    const byId = container.containerId === undefined
      ? []
      : (await container.executor([
        'ps', '-aq', '--no-trunc', '--filter', `id=${container.containerId}`,
      ], container.lifecycle, timeout())).split('\n').map((entry) => entry.trim()).filter(Boolean);
    if (container.containerId !== undefined
      && byId.some((id) => !/^[a-f0-9]{64}$/.test(id) || id !== container.containerId)) {
      throw new Error(`session container id query did not exactly bind ${container.containerId}`);
    }
    if (byName.length > 0 || byId.length > 0) {
      throw new Error(`tracked session container remains present: ${name}`);
    }
  } catch (error) {
    throw ownershipUnsafe(`tracked session container absence was not proven for ${container.taskId}/${container.arm}`, error);
  }
}

export async function stopPersistedSessionContainer(
  name: string,
  runId: string,
  taskId: string,
  arm: Arm,
  lifecycle: ProcessLifecycle = {},
  executor: SessionDockerExecutor = defaultSessionDockerExecutor,
  options: {
    attemptDeadline?: number;
    taskDirectory?: string;
    artifactOwner?: SessionArtifactOwner;
    image?: DockerImageAttestation;
    docker?: SwebenchProConfig['docker'];
    policy?: SwebenchProContainerPolicy;
    runtimeDirectory?: string;
    expectedContainerId?: string;
  } = {},
): Promise<void> {
  const cleanupDeadline = Math.min(
    options.attemptDeadline ?? Number.POSITIVE_INFINITY,
    performance.now() + SESSION_CLEANUP_RESERVE_MS,
  );
  const artifactOwner = options.artifactOwner ?? hostArtifactOwner();
  const taskIdentity = sessionTaskIdentity(artifactOwner);
  const image = options.image;
  const timeout = (): number => remainingSessionOperationTimeout(cleanupDeadline);
  const listExactName = async (): Promise<string[]> =>
    listExactSessionContainerName(name, lifecycle, executor, timeout());
  try {
    const listed = await listExactName();
    if (listed.length === 0) {
      if (options.taskDirectory !== undefined && existsSync(options.taskDirectory)) {
        if (image === undefined) throw new Error('session recovery has no exact overlay image identity');
        if (options.docker === undefined || options.policy === undefined) {
          throw new Error('session recovery has no exact reclamation policy');
        }
        const runtime = options.runtimeDirectory === undefined
          ? findSessionRuntimeDirectory(runId, taskId, arm)
          : trustedSessionRuntimeDirectory(options.runtimeDirectory, runId, taskId, arm);
        const marker = runtime === undefined ? undefined : readPrivateJson(
          runtime,
          join(runtime, SESSION_RUNTIME_MARKER),
        ) as { runtimeNonce: string };
        await reclaimSessionOwnership({
          runId,
          taskId,
          arm,
          taskDirectory: options.taskDirectory,
          runtimeDirectory: runtime,
          runtimeNonce: marker?.runtimeNonce,
          artifactOwner,
          image,
          docker: options.docker,
          policy: options.policy,
        }, lifecycle, executor, timeout);
        reclaimAndAssertArtifactTree(options.taskDirectory);
        if (runtime !== undefined && marker !== undefined) {
          assertSessionRuntimeDirectory(
            runtime,
            join(runtime, 'codex-home'),
            runId,
            taskId,
            arm,
            marker.runtimeNonce,
          );
          removeSessionRuntime(runtime, runId, taskId, arm, marker.runtimeNonce);
        }
      }
      return;
    }
    const parsed = JSON.parse(
      await executor(['inspect', listed[0]!], lifecycle, timeout()),
    ) as ContainerInspect[];
    const inspectedId = parsed.length === 1 ? parsed[0]?.Id : undefined;
    const labels = parsed[0]?.Config?.Labels ?? {};
    const runtimeNonce = labels['ultracode.benchmark.runtime'];
    if (
      typeof inspectedId !== 'string'
      || !/^[a-f0-9]{64}$/.test(inspectedId)
      || inspectedId !== listed[0]
      || parsed[0]?.Name !== `/${name}`
      || (options.expectedContainerId !== undefined && inspectedId !== options.expectedContainerId)
      || labels['ultracode.benchmark.schema'] !== '2'
      || labels['ultracode.benchmark.suite'] !== 'swebench-pro'
      || labels['ultracode.benchmark.run'] !== runId
      || labels['ultracode.benchmark.task'] !== taskId
      || labels['ultracode.benchmark.arm'] !== arm
      || labels['ultracode.benchmark.purpose'] !== 'session'
      || labels['ultracode.benchmark.ownership'] !== '1'
      || labels['ultracode.benchmark.task-uid'] !== String(taskIdentity.uid)
      || labels['ultracode.benchmark.task-gid'] !== String(taskIdentity.gid)
      || labels['ultracode.benchmark.artifact-uid'] !== String(artifactOwner.uid)
      || labels['ultracode.benchmark.artifact-gid'] !== String(artifactOwner.gid)
      || image === undefined
      || parsed[0]?.Config?.Image !== image.overlayLocalId
      || parsed[0]?.Image !== image.overlayLocalId
      || typeof runtimeNonce !== 'string'
      || !/^[a-f0-9]{64}$/.test(runtimeNonce)
    ) {
      throw new Error(`refusing to remove unowned container with session name ${name}`);
    }
    const taskDirectory = sessionTaskDirectory(parsed[0]!, options.taskDirectory);
    const runtime = trustedSessionRuntimeDirectory(
      sessionRuntimePaths(parsed[0]!).runtime,
      runId,
      taskId,
      arm,
      runtimeNonce,
    );
    if (parsed[0]!.State?.Running === true) {
      let stopFailure: unknown;
      try {
        await executor(['stop', '--time', '10', inspectedId], lifecycle, timeout());
      } catch (error) {
        stopFailure = error;
      }
      const stopped = JSON.parse(
        await executor(['inspect', inspectedId], lifecycle, timeout()),
      ) as ContainerInspect[];
      if (stopped.length !== 1 || stopped[0]?.Id !== inspectedId || stopped[0]?.State?.Running !== false) {
        throw ownershipUnsafeAggregate('owned session container could not be proven stopped', [stopFailure]);
      }
    } else if (parsed[0]!.State?.Running !== false) {
      throw new Error('owned session container running state is not proven');
    }
    if (options.docker === undefined || options.policy === undefined) {
      throw new Error('session cleanup has no exact reclamation policy');
    }
    await reclaimSessionOwnership({
      runId,
      taskId,
      arm,
      taskDirectory,
      runtimeDirectory: runtime,
      runtimeNonce,
      artifactOwner,
      image,
      docker: options.docker,
      policy: options.policy,
    }, lifecycle, executor, timeout);
    reclaimAndAssertArtifactTree(taskDirectory);
    sessionRuntimeDirectory(parsed[0]!, runId, taskId, arm, runtimeNonce);
    let removalFailure: unknown;
    try {
      await executor(['rm', '-f', listed[0]!], lifecycle, timeout());
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

async function cleanupTrackedContainer(name: string, freshDeadline = false): Promise<void> {
  const container = activeContainers.get(name);
  if (container === undefined) return;
  container.cleanupPromise ??= (async () => {
    const cleanupDeadline = freshDeadline
      ? performance.now() + SESSION_CLEANUP_RESERVE_MS
      : Math.min(container.attemptDeadline, performance.now() + SESSION_CLEANUP_RESERVE_MS);
    const timeout = (): number => remainingSessionOperationTimeout(cleanupDeadline);
    await listExactSessionContainerName(name, container.lifecycle, container.executor, timeout());
    if (await waitForSessionExit(container.launchSettlement, timeout()) === 'backstop') {
      throw ownershipUnsafe(`session container launch did not settle during cleanup for ${container.taskId}/${container.arm}`);
    }
    const settledIds = await listExactSessionContainerName(
      name,
      container.lifecycle,
      container.executor,
      timeout(),
    );
    if (settledIds.length === 1) {
      if (container.containerId !== undefined && container.containerId !== settledIds[0]) {
        throw ownershipUnsafe(`session launch id does not match its exact tracked name for ${container.taskId}/${container.arm}`);
      }
      container.containerId = settledIds[0];
    }
    await stopPersistedSessionContainer(
      name,
      container.runId,
      container.taskId,
      container.arm,
      container.lifecycle,
      container.executor,
      {
        attemptDeadline: cleanupDeadline,
        taskDirectory: container.taskDirectory,
        artifactOwner: container.artifactOwner,
        image: container.image,
        docker: container.docker,
        policy: container.policy,
        runtimeDirectory: existsSync(container.runtime) ? container.runtime : undefined,
        expectedContainerId: container.containerId,
      },
    );
    await proveTrackedSessionContainerAbsent(name, container, timeout);
    if (existsSync(container.runtime)) removeSessionRuntime(
      container.runtime,
      container.runId,
      container.taskId,
      container.arm,
      container.runtimeNonce,
    );
    if (activeContainers.get(name) === container) activeContainers.delete(name);
  })();
  const cleanup = container.cleanupPromise;
  try {
    await cleanup;
  } finally {
    if (activeContainers.get(name) === container && container.cleanupPromise === cleanup) {
      container.cleanupPromise = undefined;
    }
  }
}

export async function cleanupActiveSwebenchProContainers(): Promise<number> {
  const entries = [...activeContainers.entries()];
  const settled = await Promise.allSettled(entries.map(([name]) => cleanupTrackedContainer(name, true)));
  const failures = settled.flatMap((result) => result.status === 'rejected' ? [result.reason] : []);
  if (failures.length > 0) {
    throw ownershipUnsafeAggregate('active SWE-bench Pro container cleanup failed', failures);
  }
  return entries.length;
}

export interface ReclamationDockerCreateArgvOptions extends ReclamationContainerSpec {
  policy: SwebenchProContainerPolicy;
}

function reclamationLabels(options: ReclamationContainerSpec): Record<string, string> {
  return {
    'ultracode.benchmark.schema': '2',
    'ultracode.benchmark.suite': 'swebench-pro',
    'ultracode.benchmark.run': options.runId,
    'ultracode.benchmark.task': options.taskId,
    'ultracode.benchmark.arm': options.arm,
    'ultracode.benchmark.purpose': 'reclamation',
    'ultracode.benchmark.ownership': '1',
    'ultracode.benchmark.artifact-uid': String(options.artifactOwner.uid),
    'ultracode.benchmark.artifact-gid': String(options.artifactOwner.gid),
    ...(options.runtimeNonce === undefined
      ? {}
      : { 'ultracode.benchmark.runtime': options.runtimeNonce }),
  };
}

function reclamationTargets(options: ReclamationContainerSpec): string[] {
  return options.runtimeDirectory === undefined
    ? ['/bench']
    : ['/bench', '/runtime/home', '/runtime/codex-home'];
}

function reclamationCommandArgv(options: ReclamationContainerSpec): string[] {
  return [
    TRUSTED_BUSYBOX, 'sh', '-c', RECLAMATION_COMMAND,
    'ultracode-reclaim',
    `${options.artifactOwner.uid}:${options.artifactOwner.gid}`,
    ...reclamationTargets(options),
  ];
}

function assertReclamationSpec(options: ReclamationContainerSpec): void {
  if (options.name !== reclamationContainerName(options.runId, options.taskId, options.arm)) {
    throw new Error('reclamation helper name does not match its validated run/task/arm identity');
  }
  if (!Number.isSafeInteger(options.artifactOwner.uid) || options.artifactOwner.uid < 0
    || !Number.isSafeInteger(options.artifactOwner.gid) || options.artifactOwner.gid < 0) {
    throw new Error('reclamation helper host owner ids are invalid');
  }
  const hasRuntime = options.runtimeDirectory !== undefined;
  const hasNonce = options.runtimeNonce !== undefined;
  if (hasRuntime !== hasNonce || (hasNonce && !/^[a-f0-9]{64}$/.test(options.runtimeNonce!))) {
    throw new Error('reclamation helper runtime binding is incomplete');
  }
}

/** Build a stopped, fully attestable root reclamation helper. */
export function reclamationDockerCreateArgv(options: ReclamationDockerCreateArgvOptions): string[] {
  assertReclamationSpec(options);
  const labels = Object.entries(reclamationLabels(options)).flatMap(([key, value]) => [
    '--label', `${key}=${value}`,
  ]);
  const mounts = [
    '--mount', `type=bind,src=${options.taskDirectory},dst=/bench`,
    ...(options.runtimeDirectory === undefined ? [] : [
      '--mount', `type=bind,src=${join(options.runtimeDirectory, 'home')},dst=/runtime/home`,
      '--mount', `type=bind,src=${join(options.runtimeDirectory, 'codex-home')},dst=/runtime/codex-home`,
    ]),
  ];
  return [
    'create', '--rm', '--name', options.name,
    ...labels,
    '--no-healthcheck',
    ...SANITIZED_BOOTSTRAP_ENV.flatMap((value) => ['--env', value]),
    ...reclamationContainerPolicyArgv(options.policy, options.docker),
    ...mounts,
    '--entrypoint', TRUSTED_MUSL_LOADER,
    options.image.overlayLocalId,
    ...reclamationCommandArgv(options),
  ];
}

interface SessionResult {
  status: TaskStatus;
  meta: SessionMeta | null;
}

export interface SessionDockerCreateArgvOptions {
  name: string;
  runId: string;
  taskId: string;
  arm: Arm;
  runtimeNonce: string;
  envFile: string;
  taskDirectory: string;
  runtimeHome: string;
  runtimeCodex: string;
  restrictedNetwork: string;
  artifactOwner: SessionArtifactOwner;
  imageId: string;
  docker: SwebenchProConfig['docker'];
  policy: SwebenchProContainerPolicy;
}

function sessionContainerCommand(): string[] {
  return [
    TRUSTED_BUSYBOX,
    'sh',
    TRUSTED_SESSION_GATE,
    TRUSTED_MUSL_LOADER,
    TRUSTED_BUSYBOX,
    'sh',
    TASK_ENTRYPOINT,
  ];
}

/** Build the complete expected Docker attachment for one production session container. */
export function swebenchProSessionAttachment(
  id: string,
  options: SessionDockerCreateArgvOptions,
  running: boolean,
): SwebenchProSessionAttachment {
  return {
    id,
    name: options.name,
    runId: options.runId,
    taskId: options.taskId,
    arm: options.arm,
    runtimeNonce: options.runtimeNonce,
    imageName: options.imageId,
    imageId: options.imageId,
    running,
    containerPolicy: {
      user: '0:0',
      entrypoint: [TRUSTED_MUSL_LOADER],
      command: sessionContainerCommand(),
      pidsLimit: options.policy.session.pidsLimit,
      securityOpt: options.policy.session.securityOpt,
      capDrop: options.policy.session.capDrop,
      capAdd: options.policy.session.capAdd,
      nanoCpus: dockerNanoCpus(options.docker.cpus),
      memoryBytes: options.docker.memoryBytes,
      mounts: [
        { source: options.taskDirectory, destination: '/bench' },
        { source: options.runtimeHome, destination: '/runtime/home' },
        { source: options.runtimeCodex, destination: '/runtime/codex-home' },
        {
          source: join(options.taskDirectory, 'codex-home', 'sessions'),
          destination: '/runtime/codex-home/sessions',
        },
      ],
    },
  };
}

/** Build a stopped session whose complete policy can be attested before startup. */
export function sessionDockerCreateArgv(options: SessionDockerCreateArgvOptions): string[] {
  const taskIdentity = sessionTaskIdentity(options.artifactOwner);
  const labels = [
    ['schema', '2'], ['suite', 'swebench-pro'], ['run', options.runId], ['task', options.taskId],
    ['arm', options.arm], ['purpose', 'session'], ['ownership', '1'], ['runtime', options.runtimeNonce],
    ['task-uid', String(taskIdentity.uid)], ['task-gid', String(taskIdentity.gid)],
    ['artifact-uid', String(options.artifactOwner.uid)], ['artifact-gid', String(options.artifactOwner.gid)],
  ].flatMap(([key, value]) => ['--label', `ultracode.benchmark.${key}=${value}`]);
  return [
    'create', '--name', options.name, ...labels,
    '--no-healthcheck',
    ...sessionContainerPolicyArgv(options.policy, options.docker),
    '--network', options.restrictedNetwork,
    '--user', '0:0',
    ...SANITIZED_BOOTSTRAP_ENV.flatMap((value) => ['--env', value]),
    '--env-file', options.envFile,
    '--mount', `type=bind,src=${options.taskDirectory},dst=/bench`,
    '--mount', `type=bind,src=${options.runtimeHome},dst=/runtime/home`,
    '--mount', `type=bind,src=${options.runtimeCodex},dst=/runtime/codex-home`,
    '--mount', `type=bind,src=${join(options.taskDirectory, 'codex-home', 'sessions')},dst=/runtime/codex-home/sessions`,
    '--entrypoint', TRUSTED_MUSL_LOADER,
    options.imageId,
    ...sessionContainerCommand(),
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
  transportBindings: SwebenchProTransportBindings,
  processLifecycle: ProcessLifecycle,
  executor: SessionDockerExecutor = defaultSessionDockerExecutor,
  fatalController?: SwebenchProRunFatalController,
): Promise<SessionResult> {
  const startedAt = Date.now();
  const attemptDeadline = performance.now()
    + config.timeouts.sessionMs + SESSION_BACKSTOP_EXTRA_MS + SESSION_CLEANUP_RESERVE_MS;
  const artifactOwner = hostArtifactOwner();
  const taskIdentity = sessionTaskIdentity(artifactOwner);
  const activeTimeout = (): number => remainingSessionOperationTimeout(
    attemptDeadline,
    SESSION_CLEANUP_RESERVE_MS,
  );
  const imageExecutor: DockerExecutor = (argv) => executor(argv, processLifecycle, activeTimeout());
  const policy = loadSwebenchProContainerPolicy(roots);
  fatalController?.throwIfAborted();
  await reattestTaskImage(image, imageExecutor);
  fatalController?.throwIfAborted();
  const name = containerName(manifest.runId, instance.instanceId, arm);
  await stopPersistedSessionContainer(
    name,
    manifest.runId,
    instance.instanceId,
    arm,
    processLifecycle,
    executor,
    {
      attemptDeadline: attemptDeadline - SESSION_CLEANUP_RESERVE_MS,
      taskDirectory,
      artifactOwner,
      image,
      docker: config.docker,
      policy,
    },
  );
  fatalController?.throwIfAborted();
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
    const envLines = [
      `BENCH_ARM=${arm}`,
      `BENCH_TIMEOUT_SECS=${Math.ceil(config.timeouts.sessionMs / 1_000)}`,
      `BENCH_MODEL=${config.model}`,
      `BENCH_EFFORT=${config.requestedEffort}`,
      `BENCH_BASE_COMMIT=${instance.baseCommit}`,
      `BENCH_TASK_UID=${taskIdentity.uid}`,
      `BENCH_TASK_GID=${taskIdentity.gid}`,
      `BENCH_ARTIFACT_OWNER=${artifactOwner.uid}:${artifactOwner.gid}`,
      `BENCH_RUNTIME_NONCE=${runtimeNonce}`,
      'BENCH_REPO_DIR=/app',
      'CODEX_HOME=/runtime/codex-home',
      'ULTRACODE_HOME=/bench/uc',
      'HOME=/runtime/home',
      'PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
      `BENCH_MODEL_RELAY_BASE_URL=${transportBindings.relayBaseUrl}`,
    ];
    writeFileSync(envFile, `${envLines.join('\n')}\n`, { mode: 0o600 });
  } catch (error) {
    rmSync(runtime, { recursive: true, force: true });
    throw error;
  }
  const sessionOptions: SessionDockerCreateArgvOptions = {
    name,
    runId: manifest.runId,
    taskId: instance.instanceId,
    arm,
    runtimeNonce,
    envFile,
    taskDirectory,
    runtimeHome,
    runtimeCodex,
    restrictedNetwork: transportBindings.restrictedNetwork,
    artifactOwner,
    imageId: image.overlayLocalId,
    docker: config.docker,
    policy,
  };
  const args = sessionDockerCreateArgv(sessionOptions);
  let endedAt = startedAt;
  let backstop = false;
  try {
    await withTransportAttestationLock(async () => {
      const launchedId = await launchTrackedSessionContainer(name, {
        runtime,
        runtimeNonce,
        runId: manifest.runId,
        taskId: instance.instanceId,
        arm,
        taskDirectory,
        artifactOwner,
        image,
        docker: config.docker,
        policy,
        attemptDeadline,
        lifecycle: processLifecycle,
        executor,
      }, () => executor(args, processLifecycle, activeTimeout()));
      fatalController?.throwIfAborted();
      await startAttestedSessionTransport({
        executor,
        expected: swebenchProSessionAttachment(launchedId, sessionOptions, false),
        bindings: transportBindings,
        config,
        manifest,
        allowedSessions: activeSessionEndpoints(),
        runtimeHome,
        lifecycle: processLifecycle,
        timeoutMs: activeTimeout,
      });
    }, fatalController);
    unlinkSync(envFile);
    const waited = executor(
      ['wait', name],
      processLifecycle,
      remainingSessionOperationTimeout(attemptDeadline),
    );
    const waiting = waitForSessionExit(waited, activeTimeout());
    const first = fatalController === undefined
      ? await waiting
      : await fatalController.race(waiting);
    endedAt = Date.now();
    if (first === 'backstop') {
      backstop = true;
      await cleanupTrackedContainer(name);
      await waited.catch(() => '');
    } else {
      await withTransportAttestationLock(async () => assertModelTransportProvenance(
        manifest,
        await attestModelTransport(
          config,
          transportBindings,
          executor,
          processLifecycle,
          activeTimeout(),
          activeSessionEndpoints(),
          new Set(),
        ),
      ), fatalController);
    }
  } catch (error) {
    if (error instanceof SwebenchProTransportAttestationError) fatalController?.abort(error);
    throw error;
  } finally {
    await cleanupTrackedContainer(name);
  }
  reclaimAndAssertArtifactTree(taskDirectory);
  let meta: SessionMeta | null = null;
  try {
    meta = parseSessionMeta(JSON.parse(readRegularFileWithinRoot(taskDirectory, 'out/meta.json').toString('utf8')));
  } catch {
    meta = null;
  }
  const patch = readPatchArtifact(taskDirectory);
  const patchEvidence = classifyPatchArtifact(patch);
  const outcome = backstop
    ? classifyOutcome(null, patchEvidence.validation)
    : classifyOutcome(meta, patchEvidence.validation);
  const status: TaskStatus = {
    schemaVersion: 2,
    phase: patchEvidence.phase,
    failure: outcome.failure,
    startedAt: new Date(startedAt).toISOString(),
    endedAt: new Date(endedAt).toISOString(),
    wallClockMs: endedAt - startedAt,
    ...(patchEvidence.patchBytes === undefined ? {} : { patchBytes: patchEvidence.patchBytes }),
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
  if (index < 0) throw new Error('task directory is outside the native task layout');
  return taskDirectory.slice(0, index);
}

function errorCauses(error: unknown): unknown[] {
  const causes: unknown[] = [];
  const seen = new Set<unknown>();
  const pending = [error];
  while (pending.length > 0) {
    const current = pending.shift();
    if (current === null || current === undefined || seen.has(current)) continue;
    causes.push(current);
    seen.add(current);
    if (typeof current !== 'object') continue;
    const record = current as Record<string, unknown>;
    if ('cause' in record) pending.push(record.cause);
    for (const key of ['errors', 'failures'] as const) {
      if (Array.isArray(record[key])) pending.push(...record[key]);
    }
  }
  return causes;
}

export function sessionFailure(error: unknown): FailureCode {
  const causes = errorCauses(error);
  const descendantFailure = causes.find((cause) =>
    cause instanceof BenchProcessError && /descendant cleanup failed/u.test(cause.message));
  if (descendantFailure !== undefined) return 'descendant-cleanup-failed';
  if (error instanceof ArtifactUnsafeError) return 'artifact-unsafe';
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof SwebenchProTransportAttestationError) {
    return error.stage === 'model-relay-inspect' || /model relay identity|model relay.*invalid/iu.test(message)
      ? 'broker-failed'
      : 'network-policy-failed';
  }
  if (/model relay identity|model relay.*invalid/iu.test(message)) return 'broker-failed';
  if (/model transport|restricted network|restricted-network|task endpoint|relay policy|topology/iu.test(message)) {
    return 'network-policy-failed';
  }
  if (/auth file|credential|CODEX_(?:AUTH|API)/i.test(message)) return 'auth-failed';
  if (/image identity drifted/i.test(message)) return 'image-identity-drift';
  if (/toolchain/i.test(message)) return 'toolchain-incompatible';
  if (/owner|ownership/i.test(message)) return 'ownership-unsafe';
  if (/artifact|symlink|multiply-linked|non-file/i.test(message)) return 'artifact-unsafe';
  return 'native-runner-failed';
}

/** Model-transport drift invalidates the run, not only the current task. */
export function isRunFatalTransportFailure(failure: FailureCode): boolean {
  return failure === 'broker-failed' || failure === 'network-policy-failed';
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
  proveExternalAbsence: () => Promise<void>,
): Promise<void> {
  if (targets.size === 0) return;
  await proveExternalAbsence();
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

export async function recordCompletedAttempt(
  state: BenchRunStateStore,
  invocationId: string,
  execution: SwebenchProManifest['artifacts']['executions'][number],
  status: TaskStatus,
  meta: SessionMeta | null,
  nextOrdinal: (taskId: string, arm: Arm, count: number) => number,
): Promise<void> {
  const startedAt = meta?.startedAt ? new Date(meta.startedAt * 1_000).toISOString() : status.startedAt ?? new Date().toISOString();
  const endedAt = meta?.endedAt ? new Date(meta.endedAt * 1_000).toISOString() : status.endedAt ?? startedAt;
  const elapsedMs = meta === null ? status.wallClockMs ?? 0 : Math.max(0, (meta.endedAt - meta.startedAt) * 1_000);
  const recordCount = meta !== null && meta.waitedForTerminalMs > 0 ? 2 : 1;
  const ordinal = nextOrdinal(execution.taskId, execution.arm, recordCount);
  const records: AttemptRecord[] = [{
    attemptId: randomUUID(),
    invocationId,
    taskId: execution.taskId,
    arm: execution.arm,
    ordinal,
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
  }];
  if (meta !== null && meta.waitedForTerminalMs > 0) {
    const waitEnd = new Date(meta.endedAt * 1_000 + meta.waitedForTerminalMs);
    const waitStart = new Date(meta.endedAt * 1_000);
    records.push({
      attemptId: randomUUID(), invocationId, taskId: execution.taskId, arm: execution.arm,
      ordinal: ordinal + 1,
      phase: 'detached-wait', startedAt: waitStart.toISOString(), endedAt: waitEnd.toISOString(),
      elapsedMs: meta.waitedForTerminalMs, nativePath: execution.nativeRoot, exitCode: 0, signal: null,
      status: 'succeeded', failures: [], annotations: [],
    });
  }
  await state.appendAttempts(null, records);
}

export function attemptOrdinalTracker(
  runState: BenchRunState,
): (taskId: string, arm: Arm, count: number) => number {
  const ordinals = new Map<string, number>();
  for (const attempt of runState.attempts) {
    const key = `${attempt.taskId}\0${attempt.arm}`;
    ordinals.set(key, Math.max(ordinals.get(key) ?? 0, attempt.ordinal));
  }
  return (taskId, arm, count) => {
    const key = `${taskId}\0${arm}`;
    const first = (ordinals.get(key) ?? 0) + 1;
    ordinals.set(key, first + count - 1);
    return first;
  };
}

async function cleanupActiveSessionResources(): Promise<void> {
  const failures: unknown[] = [];
  try {
    await cleanupActiveReclamationHelpers();
  } catch (error) {
    failures.push(error);
  }
  if (failures.length === 0) {
    try {
      await cleanupActiveSwebenchProContainers();
    } catch (error) {
      failures.push(error);
    }
  }
  try {
    await cleanupActiveReclamationHelpers();
  } catch (error) {
    failures.push(error);
  }
  if (failures.length > 0) {
    throw ownershipUnsafeAggregate('active SWE-bench Pro session-resource cleanup failed', failures);
  }
}

/** Settle every worker, retry active cleanup once, and retain the original fatal aggregate. */
export async function settleSessionWorkers(
  workers: readonly Promise<void>[],
  cleanupRetry: () => Promise<unknown> = cleanupActiveSessionResources,
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
  const initialState = state.load();
  await cleanRunContainers(
    context.paths,
    manifest,
    new Map(initialState.invocations.map((invocation) => [
      invocation.invocationId,
      Date.parse(invocation.startedAt),
    ])),
  );
  const transportBindings = loadSwebenchProTransportBindings();
  assertModelTransportProvenance(
    manifest,
    await attestModelTransport(config, transportBindings, sessionDocker),
  );
  const byId = new Map(manifestInstances(manifest).map((instance) => [instance.instanceId, instance]));
  const images = imageAttestations(manifest);
  const nextOrdinal = attemptOrdinalTracker(initialState);
  let cursor = 0;
  let ownershipFailure = false;
  const fatalController = new SwebenchProRunFatalController();
  const workers = Array.from({ length: config.concurrency.tasks }, async () => {
    for (;;) {
      if (ownershipFailure || fatalController.signal.aborted) return;
      const execution = manifest.artifacts.executions[cursor++];
      if (!execution) return;
      const taskDirectory = executionDirectory(directory, execution.nativeRoot);
      const previous = existsSync(taskDirectory) ? readTaskStatus(taskDirectory) : null;
      const forced = redo.has(`${execution.taskId}\0${execution.arm}`);
      if (!forced && previous !== null && TERMINAL_PHASES.has(previous.phase)) continue;
      if (previous !== null && !forced && !resume) throw new Error(`unexpected native state for ${execution.taskId}/${execution.arm}`);
      const instance = byId.get(execution.taskId)!;
      const image = images.get(execution.taskId)!;
      let attemptRecordStarted = false;
      try {
        const result = await runSession(
          context.paths,
          config,
          manifest,
          instance,
          execution.arm,
          taskDirectory,
          image,
          transportBindings,
          state.lifecycleHooks(invocationId),
          sessionDocker,
          fatalController,
        );
        fatalController.throwIfAborted();
        attemptRecordStarted = true;
        await recordCompletedAttempt(
          state, invocationId, execution, result.status, result.meta, nextOrdinal,
        );
        fatalController.throwIfAborted();
        output(context, `${execution.taskId} ${execution.arm}: ${result.status.phase}${result.status.failure ? ` (${result.status.failure})` : ''}`);
      } catch (error) {
        if (attemptRecordStarted) throw error;
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
        await recordCompletedAttempt(state, invocationId, execution, status, null, nextOrdinal);
        output(context, `${execution.taskId} ${execution.arm}: pending (${failure})`);
        if (error instanceof SwebenchProTransportAttestationError
          || isRunFatalTransportFailure(failure)) {
          fatalController.abort(error instanceof SwebenchProTransportAttestationError
            ? error
            : transportAttestationFailure('transport-boundary', error));
          return;
        }
      }
    }
  });
  let workerFailure: unknown;
  try {
    await settleSessionWorkers(workers);
  } catch (error) {
    workerFailure = error;
  }
  let fatalCleanupFailure: unknown;
  try {
    await fatalController.settleCleanup();
  } catch (error) {
    fatalCleanupFailure = error;
  }
  if (workerFailure instanceof OwnershipUnsafeCleanupError) throw workerFailure;
  if (fatalCleanupFailure !== undefined) throw fatalCleanupFailure;
  if (fatalController.failure !== null) throw fatalController.failure;
  if (workerFailure !== undefined) throw workerFailure;
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
      const transportBindings = loadSwebenchProTransportBindings();
      inputLocks = await acquirePreparedInputLocks(context.paths, options.recoverStaleLock);
      const prepared = loadPreparedSwebenchProInputs(
        swebenchProPreparedDir(context.paths, stores.manifest.suiteConfig.preparedInputSha256),
        context.paths,
        config,
      );
      assertPreparedProvenance(stores.manifest, config, prepared, context.paths);
      for (const image of imageAttestations(stores.manifest).values()) await reattestTaskImage(image);
      assertModelTransportProvenance(
        stores.manifest,
        await attestModelTransport(config, transportBindings, dependencies.sessionDocker),
      );
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
        async () => {
          await cleanRunContainers(
            context.paths,
            stores.manifest,
            new Map(stores.state.load().invocations.map((invocation) => [
              invocation.invocationId,
              Date.parse(invocation.startedAt),
            ])),
          );
        },
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
      await rethrowAfterRuntimeCleanup(error, stores.policyLock);
    } finally {
      try {
        releaseLocks(inputLocks);
      } finally {
        try { stores.lease.release(); } finally { stores.policyLock.release(); }
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
  let policyLock: BenchLockHandle | null = null;
  let inputLocks: BenchLockHandle[] = [];
  const unpublishedImages: DockerImageAttestation[] = [];
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
    const transportBindings = loadSwebenchProTransportBindings();
    policyLock = await acquireBenchLock(
      swebenchProTransportPolicyLockRoot(),
      swebenchProTransportPolicyLockFile(context.paths),
      { recoverStale: options.recoverStaleLock },
    );
    inputLocks = await acquirePreparedInputLocks(context.paths, options.recoverStaleLock);
    const prepared = loadCurrentPreparedSwebenchProInputs(context.paths, config);
    const snapshot = loadDatasetSnapshot(context.paths);
    const datasetSha256 = datasetDescriptorSha256(context.paths, snapshot);
    const selected = selectInstances(snapshot, config.selection);
    const images = new Map<string, DockerImageAttestation>();
    for (const instance of selected) {
      const image = await prepareTaskImage(instance, {
        roots: context.paths,
        runId: options.runId,
        toolchainDirectory: prepared.toolchain.directory,
        toolchainPayloadSha256: prepared.toolchain.provenance.payloadSha256,
      });
      images.set(instance.instanceId, image);
      unpublishedImages.push(image);
    }
    const transport = await attestModelTransport(config, transportBindings, dependencies.sessionDocker);
    const manifest = buildManifest(
      context.paths,
      options.runId,
      config,
      selected,
      images,
      prepared,
      datasetSha256,
      transport,
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
  } catch (error) {
    let primaryError = error;
    if (initialized === null && unpublishedImages.length > 0) {
      try {
        await removeTaskImageTargets(unpublishedImages.map((image) => image.overlayName));
      } catch (cleanupError) {
        primaryError = ownershipUnsafeAggregate('fresh SWE-bench Pro setup image cleanup failed', [
          error,
          cleanupError,
        ]);
      }
    }
    await rethrowAfterRuntimeCleanup(primaryError, policyLock);
  } finally {
    try { claim.release(); } catch { /* already released after publication */ }
    try {
      releaseLocks(inputLocks);
    } finally {
      try { initialized?.lease.release(); } finally { policyLock?.release(); }
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
  artifactSha256: Readonly<Record<string, string>>,
): VerifierBinding {
  const relativePath = validateRelativeArtifactPath(path);
  const parsedBytesSha256 = artifactSha256[relativePath];
  if (parsedBytesSha256 === undefined) {
    throw new Error(`native verifier artifact was not generated or parsed by the evaluator: ${relativePath}`);
  }
  return createVerifierBinding(runDirectory, {
    invocationId,
    scope,
    role,
    path: relativePath,
    nativeRecordKey,
  }, parsedBytesSha256);
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
      options.result.artifactSha256,
    ),
    verifierBindings(
      options.runDirectory,
      options.invocationId,
      scope ?? { kind: 'suite-check', name: `${options.prefix}-inputs` },
      'predictions',
      options.result.predictionsRelativePath,
      null,
      options.result.artifactSha256,
    ),
    verifierBindings(
      options.runDirectory,
      options.invocationId,
      scope ?? { kind: 'suite-check', name: `${options.prefix}-invocation` },
      'verifier-invocation',
      options.result.invocationRelativePath,
      null,
      options.result.artifactSha256,
    ),
    verifierBindings(
      options.runDirectory,
      options.invocationId,
      scope ?? { kind: 'suite-check', name: `${options.prefix}-policy` },
      'native-config',
      options.result.policyRelativePath,
      null,
      options.result.artifactSha256,
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
      options.result.artifactSha256,
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
        options.result.artifactSha256,
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
  timingGroupId?: string;
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
      ...(options.timingGroupId === undefined ? {} : { timingGroupId: options.timingGroupId }),
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

/** Write task statuses first, then commit all eligible evaluator attempts as one arm revision. */
export async function recordEvaluatorArmAttributions(options: {
  state: BenchRunStateStore;
  executions: readonly SwebenchProManifest['artifacts']['executions'][number][];
  runDirectory: string;
  arm: Arm;
  result: EvaluatorRunResult;
  submitted: ReadonlySet<string>;
  invocationId: string;
  attemptId?: () => string;
}): Promise<number> {
  const eligible = options.executions.flatMap((execution) => {
    if (execution.arm !== options.arm || !options.submitted.has(execution.taskId)) return [];
    const statusDirectory = executionDirectory(options.runDirectory, execution.nativeRoot);
    if (!existsSync(statusDirectory)) return [];
    const status = readTaskStatus(statusDirectory);
    writeTaskStatus(statusDirectory, { ...status, phase: 'evaluated' });
    return [execution];
  });
  if (eligible.length === 0) return 0;
  const attemptId = options.attemptId ?? randomUUID;
  const timingGroupId = randomUUID();
  await options.state.updateCurrent((state) => {
    const ordinals = new Map<string, number>();
    for (const attempt of state.attempts) {
      const key = `${attempt.taskId}\0${attempt.arm}`;
      ordinals.set(key, (ordinals.get(key) ?? 0) + 1);
    }
    const additions = eligible.map((execution) => {
      const key = `${execution.taskId}\0${execution.arm}`;
      const ordinal = (ordinals.get(key) ?? 0) + 1;
      ordinals.set(key, ordinal);
      const attribution = evaluatorTaskAttribution({
        result: options.result,
        execution,
        submitted: options.submitted,
        invocationId: options.invocationId,
        attemptId: attemptId(),
        ordinal,
        timingGroupId,
      });
      if (attribution === null) throw new Error('eligible evaluator attribution was unexpectedly filtered');
      return attribution.attempt;
    });
    return { ...state, attempts: [...state.attempts, ...additions] };
  });
  return eligible.length;
}

/** Persist verifier attempts and timing before publishing any accepted receipt bindings. */
export async function publishEvaluatorModeResult(options: {
  state: BenchRunStateStore;
  receipt: Pick<VerifierReceiptStore, 'load' | 'update'>;
  executions: readonly SwebenchProManifest['artifacts']['executions'][number][];
  runDirectory: string;
  prefix: string;
  arm: Arm | null;
  result: EvaluatorRunResult;
  submitted: ReadonlySet<string>;
  invocationId: string;
  attemptId?: () => string;
}): Promise<number> {
  if (options.arm !== null) {
    const submittedExecutions = options.executions.filter((execution) =>
      execution.arm === options.arm && options.submitted.has(execution.taskId));
    const attributable = new Set(submittedExecutions.map((execution) => execution.taskId));
    const unattributed = [...options.submitted].filter((taskId) => !attributable.has(taskId));
    const missingStatuses = submittedExecutions.filter((execution) =>
      !existsSync(executionDirectory(options.runDirectory, execution.nativeRoot)));
    const unexpectedVerdicts = Object.keys(options.result.verdicts).filter((taskId) =>
      !attributable.has(taskId));
    if (unattributed.length > 0 || missingStatuses.length > 0 || unexpectedVerdicts.length > 0) {
      throw new Error('SWE-bench Pro evaluator receipt lacks complete task attribution state');
    }
  }
  const additions = evaluatorReceiptBindings({
    runDirectory: options.runDirectory,
    invocationId: options.invocationId,
    prefix: options.prefix,
    arm: options.arm,
    result: options.result,
  });
  const recorded = options.arm === null ? 0 : await recordEvaluatorArmAttributions({
    state: options.state,
    executions: options.executions,
    runDirectory: options.runDirectory,
    arm: options.arm,
    result: options.result,
    submitted: options.submitted,
    invocationId: options.invocationId,
    ...(options.attemptId === undefined ? {} : { attemptId: options.attemptId }),
  });
  const receipt = options.receipt.load();
  await options.receipt.update(receipt.revision, (bindings) => [
    ...bindings.filter((binding) => {
      if (options.arm === null) {
        return !(binding.scope.kind === 'suite-check' && binding.scope.name.startsWith(options.prefix));
      }
      return !(binding.scope.kind === 'task-arm' && binding.scope.arm === options.arm)
        && !(binding.scope.kind === 'suite-check' && binding.scope.name.startsWith(options.prefix));
    }),
    ...additions,
  ]);
  return recorded;
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
    const evaluatorImages = new Map(stores.manifest.provenance.tasks.map((task) => {
      if (task.image === null) throw new Error(`task ${task.taskId} has no evaluator image identity`);
      return [task.taskId, {
        localId: task.image.base.localId,
      }] as const;
    }));
    const runDirectory = runDir(context.paths, 'swebench-pro', stores.manifest.runId);
    invocationId = await beginInvocation(stores.state, 'eval', context.clock.now());
    const evaluatorInvocationStarts = new Map(stores.state.load().invocations.map((invocation) => [
      invocation.invocationId,
      Date.parse(invocation.startedAt),
    ]));
    const modes: Array<{ prefix: string; arm: Arm | null }> = options.gold
      ? [{ prefix: 'gold', arm: null }]
      : options.nullCheck
        ? [{ prefix: 'nullcheck', arm: null }]
        : (stores.manifest.experiment.arm === 'both' ? ['a', 'b'] as Arm[] : [stores.manifest.experiment.arm])
          .map((arm) => ({ prefix: arm === 'a' ? 'armA' : 'armB', arm }));
    for (const mode of modes) {
      const predictions = options.gold
        ? goldPredictions(instances)
        : options.nullCheck
          ? nullPredictions(instances)
          : collectPredictions(stores.manifest, runDirectory, mode.arm!, instances);
      const result = await runOfficialEvaluator({
        runDirectory,
        evaluatorDirectory: prepared.evaluatorDirectory,
        evaluatorPythonBinary: prepared.evaluatorPythonBinary,
        config,
        invocationId,
        runId: stores.manifest.runId,
        armLabel: mode.arm ?? (mode.prefix === 'gold' ? 'gold' : 'nullcheck'),
        prefix: mode.prefix,
        predictions,
        instances,
        containerPolicy: loadSwebenchProContainerPolicy(context.paths),
        imageIdentities: evaluatorImages,
        invocationStartedMs: evaluatorInvocationStarts,
        processLifecycle: {
          workerScope: runDirectory,
          ...stores.state.lifecycleHooks(invocationId),
        },
      });
      await publishEvaluatorModeResult({
        state: stores.state,
        receipt: stores.receipt,
        executions: stores.manifest.artifacts.executions,
        runDirectory,
        prefix: mode.prefix,
        arm: mode.arm,
        result,
        submitted: new Set(predictions.map((prediction) => prediction.instance_id)),
        invocationId,
      });
      output(context, `${mode.prefix}: ${Object.values(result.verdicts).filter(Boolean).length}/${predictions.length} verified resolved; ${predictions.length - Object.keys(result.verdicts).length} unverified`);
    }
    await finishInvocation(stores.state, invocationId, startedMs, context.clock.now());
  } catch (error) {
    if (invocationId !== null) await finishInvocation(
      stores.state,
      invocationId,
      startedMs,
      context.clock.now(),
      error instanceof OwnershipUnsafeCleanupError
        ? 'ownership-unsafe'
        : error instanceof ArtifactUnsafeError
          ? 'artifact-unsafe'
          : 'verifier-process-failed',
    );
    await rethrowAfterRuntimeCleanup(error, stores.policyLock);
  } finally {
    try {
      await cleanupActiveSwebenchProEvaluators();
    } finally {
      try {
        releaseLocks(inputLocks);
      } finally {
        try { stores.lease.release(); } finally { stores.policyLock.release(); }
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
  arm?: Arm,
): boolean {
  const invocationBindings = bindings.filter((binding) => binding.invocationId === invocationId);
  if (arm !== undefined) {
    const prefix = arm === 'a' ? 'armA' : 'armB';
    return [
      ['raw-samples', `${prefix}-inputs`],
      ['predictions', `${prefix}-inputs`],
      ['verifier-invocation', `${prefix}-invocation`],
      ['native-config', `${prefix}-policy`],
    ].every(([role, name]) => invocationBindings.some((binding) =>
      binding.role === role && binding.scope.kind === 'suite-check' && binding.scope.name === name));
  }
  const roles = new Set(invocationBindings.map((binding) => binding.role));
  return ['raw-samples', 'predictions', 'verifier-invocation', 'native-config']
    .every((role) => roles.has(role as VerifierBinding['role']));
}

/** Bind report evidence only to the latest task-scoped verifier attempt and its arm receipt. */
export function taskReportInputs(
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
    const failures = new Set<FailureCode>();
    if (status?.failure) failures.add(status.failure);
    const latestSession = [...currentAttempts].reverse().find((entry) => entry.phase === 'session');
    const latestVerifier = [...currentAttempts].reverse().find((entry) => entry.phase === 'verifier');
    const binding = [...receiptBindings].reverse().find((entry) => entry.role === 'native-result'
      && entry.invocationId === latestVerifier?.invocationId
      && entry.scope.kind === 'task-arm' && entry.scope.taskId === execution.taskId && entry.scope.arm === execution.arm);
    latestSession?.failures.forEach((failure) => failures.add(failure));
    latestVerifier?.failures.forEach((failure) => failures.add(failure));
    if (latestVerifier !== undefined && latestVerifier.status !== 'running'
      && !hasCompleteProVerifierReceipt(receiptBindings, latestVerifier.invocationId, execution.arm)) {
      failures.add('receipt-incomplete');
    }
    const evidenceInvocationId = latestVerifier?.invocationId
      ?? latestAttempt?.invocationId
      ?? state.invocations.at(-1)?.invocationId;
    if (evidenceInvocationId === undefined) {
      throw new Error(`SWE-bench Pro report input lacks an invocation for ${execution.taskId}/${execution.arm}`);
    }
    return {
      invocationId: evidenceInvocationId,
      taskId: execution.taskId,
      arm: execution.arm,
      nativeVerifier: nativeResult(runDirectory, binding),
      failures: [...failures].map((code) => failureObservationSchema.parse({
        code,
        scope,
        phase: code.startsWith('verifier-') || code === 'unattributed-verifier-absence'
          || code === 'receipt-incomplete' ? 'verifier' : 'session',
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
    try { stores.lease.release(); } finally { stores.policyLock.release(); }
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
    try { stores.lease.release(); } finally { stores.policyLock.release(); }
  }
}

type ContainerInspect = ReclamationContainerInspect;

function uniqueSessionBindMount(record: ContainerInspect, destination: string): string {
  const mounts = (record.Mounts ?? []).filter((mount) => mount.Type === 'bind'
    && mount.Destination === destination && typeof mount.Source === 'string');
  if (mounts.length !== 1) throw new Error(`owned session container has no unique ${destination} bind mount`);
  return mounts[0]!.Source!;
}

function physicalPath(path: string): string {
  return canonicalHostPath(path);
}

function sessionTaskDirectory(record: ContainerInspect, expected: string | undefined): string {
  if (expected === undefined) throw new Error('owned session cleanup has no trusted task directory');
  const observed = uniqueSessionBindMount(record, '/bench');
  const sessions = uniqueSessionBindMount(record, '/runtime/codex-home/sessions');
  const writableDestinations = new Set([
    '/bench',
    '/runtime/home',
    '/runtime/codex-home',
    '/runtime/codex-home/sessions',
  ]);
  const writableMounts = (record.Mounts ?? []).filter((mount) =>
    typeof mount.Destination === 'string'
    && ['/bench', '/runtime/home', '/runtime/codex-home'].some((root) =>
      mount.Destination === root || mount.Destination!.startsWith(`${root}/`)));
  if (writableMounts.length !== writableDestinations.size
    || writableMounts.some((mount) => mount.Type !== 'bind'
      || !writableDestinations.has(mount.Destination!))
    || physicalPath(observed) !== physicalPath(expected)
    || physicalPath(sessions) !== physicalPath(resolve(expected, 'codex-home', 'sessions'))) {
    throw new Error('owned session task mount does not match the trusted task directory');
  }
  return expected;
}

function sessionRuntimePaths(record: ContainerInspect): {
  runtime: string;
  runtimeHome: string;
  runtimeCodex: string;
} {
  const runtimeHome = physicalPath(uniqueSessionBindMount(record, '/runtime/home'));
  const runtimeCodex = physicalPath(uniqueSessionBindMount(record, '/runtime/codex-home'));
  const runtime = dirname(runtimeCodex);
  const relativeRuntime = relative(physicalPath(tmpdir()), runtime);
  if (!/^uc-bench-pro-runtime-[A-Za-z0-9]+$/.test(relativeRuntime) || relativeRuntime.includes(sep)
    || runtimeHome !== physicalPath(resolve(runtime, 'home'))
    || runtimeCodex !== physicalPath(resolve(runtime, 'codex-home'))) {
    throw new Error('owned session credential mounts are outside the exact temporary namespace');
  }
  return { runtime, runtimeHome, runtimeCodex };
}

function sessionRuntimeDirectory(
  record: ContainerInspect,
  runId: string,
  taskId: string,
  arm: Arm,
  runtimeNonce: string,
): string {
  const { runtime, runtimeHome, runtimeCodex } = sessionRuntimePaths(record);
  const validated = assertSessionRuntimeDirectory(runtime, runtimeCodex, runId, taskId, arm, runtimeNonce);
  const uid = typeof process.getuid === 'function' ? process.getuid() : undefined;
  const homeInfo = lstatSync(runtimeHome);
  if (homeInfo.isSymbolicLink() || !homeInfo.isDirectory() || (homeInfo.mode & 0o777) !== 0o700
    || (uid !== undefined && homeInfo.uid !== uid)) {
    throw new Error('owned session home mount is unsafe');
  }
  return validated;
}

function trustedSessionRuntimeDirectory(
  runtime: string,
  runId: string,
  taskId: string,
  arm: Arm,
  expectedNonce?: string,
): string {
  trustedSessionRuntimeRoot(runtime, runId, taskId, arm, expectedNonce);
  for (const path of [join(runtime, 'home'), join(runtime, 'codex-home')]) {
    const info = lstatSync(path);
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new Error('owned session writable runtime mount is unsafe');
    }
  }
  return runtime;
}

function trustedSessionRuntimeRoot(
  runtime: string,
  runId: string,
  taskId: string,
  arm: Arm,
  expectedNonce?: string,
): string {
  const relativeRuntime = relative(physicalPath(tmpdir()), physicalPath(runtime));
  if (!/^uc-bench-pro-runtime-[A-Za-z0-9]+$/.test(relativeRuntime) || relativeRuntime.includes(sep)) {
    throw new Error('owned session credential runtime is outside the exact temporary namespace');
  }
  const uid = typeof process.getuid === 'function' ? process.getuid() : undefined;
  const runtimeInfo = lstatSync(runtime);
  if (runtimeInfo.isSymbolicLink() || !runtimeInfo.isDirectory() || (runtimeInfo.mode & 0o777) !== 0o700
    || (uid !== undefined && runtimeInfo.uid !== uid)) {
    throw new Error('owned session runtime is unsafe');
  }
  const marker = readPrivateJson(runtime, join(runtime, SESSION_RUNTIME_MARKER));
  const observedNonce = marker !== null && typeof marker === 'object' && !Array.isArray(marker)
    && typeof (marker as Record<string, unknown>).runtimeNonce === 'string'
    ? (marker as Record<string, string>).runtimeNonce ?? ''
    : '';
  if (!/^[a-f0-9]{64}$/.test(observedNonce) || (expectedNonce !== undefined && observedNonce !== expectedNonce)
    || canonicalJson(marker) !== canonicalJson({
      schemaVersion: 2,
      kind: 'ultracode-swebench-pro-session-runtime',
      runId,
      taskId,
      arm,
      runtimeNonce: observedNonce,
    })) {
    throw new Error('owned session credential runtime marker does not match its container');
  }
  return runtime;
}

function findSessionRuntimeDirectory(runId: string, taskId: string, arm: Arm): string | undefined {
  const matches: string[] = [];
  for (const entry of readdirSync(tmpdir(), { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^uc-bench-pro-runtime-[A-Za-z0-9]+$/.test(entry.name)) continue;
    const runtime = join(tmpdir(), entry.name);
    let marker: unknown;
    try {
      marker = readPrivateJson(runtime, join(runtime, SESSION_RUNTIME_MARKER));
    } catch {
      continue;
    }
    if (marker === null || typeof marker !== 'object' || Array.isArray(marker)) continue;
    const value = marker as Record<string, unknown>;
    if (value.runId !== runId || value.taskId !== taskId || value.arm !== arm) continue;
    matches.push(trustedSessionRuntimeDirectory(runtime, runId, taskId, arm));
  }
  if (matches.length > 1) throw new Error('owned session has ambiguous credential runtime directories');
  return matches[0];
}

function sameStrings(actual: readonly string[] | null | undefined, expected: readonly string[]): boolean {
  return canonicalJson([...(actual ?? [])].sort()) === canonicalJson([...expected].sort());
}

function reclamationBindSource(record: ReclamationContainerInspect, destination: string): string {
  const matches = (record.Mounts ?? []).filter((mount) =>
    mount.Type === 'bind' && mount.Destination === destination && typeof mount.Source === 'string');
  if (matches.length !== 1) throw new Error(`reclamation helper has no unique ${destination} bind mount`);
  return matches[0]!.Source!;
}

function compatibleReclamationSpec(
  record: ReclamationContainerInspect,
  base: ReclamationContainerSpec,
): ReclamationContainerSpec {
  const nonce = record.Config?.Labels?.['ultracode.benchmark.runtime'];
  if (nonce === undefined) {
    return { ...base, runtimeDirectory: undefined, runtimeNonce: undefined };
  }
  if (!/^[a-f0-9]{64}$/.test(nonce)) throw new Error('reclamation helper runtime nonce is invalid');
  const runtimeHome = reclamationBindSource(record, '/runtime/home');
  const runtimeCodex = reclamationBindSource(record, '/runtime/codex-home');
  const runtime = dirname(runtimeCodex);
  if (physicalPath(runtimeHome) !== physicalPath(resolve(runtime, 'home'))
    || physicalPath(runtimeCodex) !== physicalPath(resolve(runtime, 'codex-home'))) {
    throw new Error('reclamation helper runtime bind sources are not one exact runtime');
  }
  trustedSessionRuntimeDirectory(runtime, base.runId, base.taskId, base.arm, nonce);
  return { ...base, runtimeDirectory: runtime, runtimeNonce: nonce };
}

function assertExactReclamationHelper(
  record: ReclamationContainerInspect,
  listedId: string,
  options: ReclamationContainerSpec,
  policy: SwebenchProContainerPolicy,
): void {
  assertReclamationSpec(options);
  const expectedLabels = reclamationLabels(options);
  const observedLabels = Object.fromEntries(Object.entries(record.Config?.Labels ?? {})
    .filter(([key]) => key.startsWith('ultracode.benchmark.')));
  const expectedMounts = [
    { Source: options.taskDirectory, Destination: '/bench' },
    ...(options.runtimeDirectory === undefined ? [] : [
      { Source: join(options.runtimeDirectory, 'home'), Destination: '/runtime/home' },
      { Source: join(options.runtimeDirectory, 'codex-home'), Destination: '/runtime/codex-home' },
    ]),
  ];
  const exactMounts = (record.Mounts ?? []).length === expectedMounts.length
    && expectedMounts.every((expected) => (record.Mounts ?? []).filter((mount) =>
      mount.Type === 'bind'
      && mount.RW === true
      && mount.Destination === expected.Destination
      && typeof mount.Source === 'string'
      && physicalPath(mount.Source) === physicalPath(expected.Source)).length === 1);
  const command = reclamationCommandArgv(options);
  const environment = record.Config?.Env;
  const sanitizedEnvironment = Array.isArray(environment)
    && SANITIZED_BOOTSTRAP_ENV.every((expected) => {
      const name = expected.slice(0, -1);
      return environment.filter((entry) => entry === expected).length === 1
        && !environment.some((entry) => entry.startsWith(`${name}=`) && entry !== expected);
    });
  const host = record.HostConfig;
  if (record.Id !== listedId
    || !/^[a-f0-9]{64}$/.test(record.Id)
    || record.Name !== `/${options.name}`
    || record.Config?.Image !== options.image.overlayLocalId
    || record.Image !== options.image.overlayLocalId
    || canonicalJson(observedLabels) !== canonicalJson(expectedLabels)
    || record.Config?.User !== policy.reclamation.user
    || canonicalJson(record.Config?.Entrypoint) !== canonicalJson([TRUSTED_MUSL_LOADER])
    || canonicalJson(record.Config?.Cmd) !== canonicalJson(command)
    || !sanitizedEnvironment
    || canonicalJson(record.Config?.Healthcheck?.Test) !== canonicalJson(['NONE'])
    || record.Path !== TRUSTED_MUSL_LOADER
    || canonicalJson(record.Args) !== canonicalJson(command)
    || host?.AutoRemove !== true
    || host?.NetworkMode !== policy.reclamation.networkMode
    || host.Privileged !== false
    || host.ReadonlyRootfs !== false
    || host.PublishAllPorts !== false
    || !sameStrings((host.Devices ?? []).map((device) => canonicalJson(device)), [])
    || host.PidMode !== ''
    || host.IpcMode !== 'private'
    || canonicalJson(host.RestartPolicy) !== canonicalJson({ Name: 'no', MaximumRetryCount: 0 })
    || host.PidsLimit !== policy.reclamation.pidsLimit
    || !sameStrings(host.SecurityOpt, policy.reclamation.securityOpt)
    || !sameStrings(host.CapDrop, policy.reclamation.capDrop)
    || !sameStrings(host.CapAdd, policy.reclamation.capAdd)
    || host.NanoCpus !== dockerNanoCpus(options.docker.cpus)
    || host.Memory !== options.docker.memoryBytes
    || !exactMounts) {
    throw new Error(`refusing to act on unowned container with reclamation name ${options.name}`);
  }
}

async function inspectExactReclamationName(
  base: ReclamationContainerSpec,
  expected: ReclamationContainerSpec | null,
  policy: SwebenchProContainerPolicy,
  lifecycle: ProcessLifecycle,
  executor: SessionDockerExecutor,
  timeout: () => number,
): Promise<{ record: ReclamationContainerInspect; spec: ReclamationContainerSpec } | null> {
  const listed = (await executor([
    'ps', '-aq', '--no-trunc', '--filter', `name=^/${base.name}$`,
  ], lifecycle, timeout())).split('\n').map((entry) => entry.trim()).filter(Boolean);
  if (listed.length > 1 || listed.some((id) => !/^[a-f0-9]{64}$/.test(id))) {
    throw new Error(`reclamation helper name is not uniquely bound to one exact id: ${base.name}`);
  }
  if (listed.length === 0) return null;
  const parsed = JSON.parse(await executor(['inspect', listed[0]!], lifecycle, timeout())) as unknown;
  if (!Array.isArray(parsed) || parsed.length !== 1 || parsed[0] === null || typeof parsed[0] !== 'object') {
    throw new Error(`Docker inspection did not exactly bind reclamation helper ${base.name}`);
  }
  const record = parsed[0] as ReclamationContainerInspect;
  const observed = compatibleReclamationSpec(record, base);
  if (expected !== null && (observed.runtimeNonce !== expected.runtimeNonce
    || (observed.runtimeDirectory === undefined) !== (expected.runtimeDirectory === undefined)
    || (observed.runtimeDirectory !== undefined && expected.runtimeDirectory !== undefined
      && physicalPath(observed.runtimeDirectory) !== physicalPath(expected.runtimeDirectory)))) {
    throw new Error(`reclamation helper runtime binding changed for ${base.name}`);
  }
  const spec = expected ?? observed;
  assertExactReclamationHelper(record, listed[0]!, spec, policy);
  return { record, spec };
}

async function reconcileReclamationHelper(
  base: ReclamationContainerSpec,
  expected: ReclamationContainerSpec | null,
  policy: SwebenchProContainerPolicy,
  lifecycle: ProcessLifecycle,
  executor: SessionDockerExecutor,
  timeout: () => number,
): Promise<boolean> {
  const existing = await inspectExactReclamationName(base, expected, policy, lifecycle, executor, timeout);
  if (existing === null) return false;
  const id = existing.record.Id!;
  if (existing.record.State?.Running === true) {
    let stopFailure: unknown;
    try {
      await executor(['stop', '--time', '10', id], lifecycle, timeout());
    } catch (error) {
      stopFailure = error;
    }
    const stopped = await inspectExactReclamationName(base, existing.spec, policy, lifecycle, executor, timeout);
    if (stopped === null) return true;
    if (stopped.record.Id !== id || stopped.record.State?.Running !== false) {
      throw ownershipUnsafeAggregate('owned reclamation helper could not be proven stopped', [stopFailure]);
    }
  } else if (existing.record.State?.Running !== false) {
    throw new Error('owned reclamation helper running state is not proven');
  }
  let removalFailure: unknown;
  try {
    await executor(['rm', '-f', id], lifecycle, timeout());
  } catch (error) {
    removalFailure = error;
  }
  let remaining: Awaited<ReturnType<typeof inspectExactReclamationName>>;
  try {
    remaining = await inspectExactReclamationName(base, existing.spec, policy, lifecycle, executor, timeout);
  } catch (error) {
    throw ownershipUnsafeAggregate('reclamation helper removal could not be re-queried exactly', [
      removalFailure,
      error,
    ]);
  }
  if (remaining !== null) {
    throw ownershipUnsafeAggregate('reclamation helper absence was not proven after removal', [
      removalFailure,
      new Error(`reclamation helper name remains present: ${base.name}`),
    ]);
  }
  return true;
}

export interface ReclamationOwnershipOptions {
  runId: string;
  taskId: string;
  arm: Arm;
  taskDirectory: string;
  runtimeDirectory?: string;
  runtimeNonce?: string;
  artifactOwner: SessionArtifactOwner;
  image: DockerImageAttestation;
  docker: SwebenchProConfig['docker'];
  policy: SwebenchProContainerPolicy;
}

/** Reconcile, run, and prove absence of one exact root ownership-reclamation helper. */
export async function reclaimSessionOwnership(
  options: ReclamationOwnershipOptions,
  lifecycle: ProcessLifecycle = {},
  executor: SessionDockerExecutor = defaultSessionDockerExecutor,
  timeout: () => number = () => 30_000,
): Promise<void> {
  const spec: ReclamationContainerSpec = {
    ...options,
    name: reclamationContainerName(options.runId, options.taskId, options.arm),
  };
  try {
    assertReclamationSpec(spec);
    const taskInfo = lstatSync(spec.taskDirectory);
    if (taskInfo.isSymbolicLink() || !taskInfo.isDirectory()) {
      throw new Error('owned session task directory is unsafe before reclamation');
    }
    if (spec.runtimeDirectory !== undefined) {
      trustedSessionRuntimeDirectory(
        spec.runtimeDirectory,
        spec.runId,
        spec.taskId,
        spec.arm,
        spec.runtimeNonce,
      );
    }
    await reconcileReclamationHelper(spec, null, options.policy, lifecycle, executor, timeout);
    let absenceProven = true;
    const active: ActiveReclamationHelper = {
      name: spec.name,
      cleanup: async () => {
        await reconcileReclamationHelper(
          spec,
          spec,
          options.policy,
          lifecycle,
          executor,
          survivorCleanupTimeout(),
        );
      },
    };
    trackActiveReclamationHelper(active);
    try {
      const argv = reclamationDockerCreateArgv({ ...spec, policy: options.policy });
      for (let attempt = 0; attempt < RECLAMATION_ATTEMPTS; attempt += 1) {
        const attemptTimeout = attempt === 0 ? timeout : survivorCleanupTimeout();
        absenceProven = false;
        let createFailure: unknown;
        let createdId = '';
        try {
          createdId = (await executor(argv, lifecycle, attemptTimeout())).trim();
        } catch (error) {
          createFailure = error;
        }
        let created: Awaited<ReturnType<typeof inspectExactReclamationName>>;
        try {
          created = await inspectExactReclamationName(
            spec, spec, options.policy, lifecycle, executor, attemptTimeout,
          );
        } catch (error) {
          throw ownershipUnsafeAggregate('reclamation helper creation could not be attested', [
            createFailure,
            error,
          ]);
        }
        if (created === null) {
          absenceProven = true;
          if (attempt === RECLAMATION_ATTEMPTS - 1) {
            throw ownershipUnsafeAggregate('root ownership reclamation creation failed after an idempotent retry', [
              createFailure,
            ]);
          }
          continue;
        }
        if (created.record.State?.Running !== false
          || (createdId !== '' && createdId !== created.record.Id)) {
          throw new Error('reclamation helper was not created as the exact stopped container');
        }
        let startFailure: unknown;
        try {
          await executor(['start', '-a', created.record.Id!], lifecycle, attemptTimeout());
        } catch (error) {
          startFailure = error;
        }
        try {
          await reconcileReclamationHelper(spec, spec, options.policy, lifecycle, executor, attemptTimeout);
          absenceProven = true;
        } catch (error) {
          throw ownershipUnsafeAggregate('reclamation helper outcome could not be reconciled', [
            startFailure,
            error,
          ]);
        }
        if (startFailure === undefined) return;
        if (attempt === RECLAMATION_ATTEMPTS - 1) {
          throw ownershipUnsafeAggregate('root ownership reclamation failed after an idempotent retry', [
            startFailure,
          ]);
        }
      }
    } finally {
      if (absenceProven) releaseActiveReclamationHelper(active);
    }
  } catch (error) {
    throw ownershipUnsafe(`unsafe SWE-bench Pro ownership reclamation for ${options.taskId}/${options.arm}`, error);
  }
}

function assertSessionRuntimeDirectory(
  runtime: string,
  runtimeCodex: string,
  runId: string,
  taskId: string,
  arm: Arm,
  runtimeNonce: string,
): string {
  trustedSessionRuntimeDirectory(runtime, runId, taskId, arm, runtimeNonce);
  const uid = typeof process.getuid === 'function' ? process.getuid() : undefined;
  for (const [path, description] of [[runtimeCodex, 'credential mount']] as const) {
    const info = lstatSync(path);
    if (info.isSymbolicLink() || !info.isDirectory() || (info.mode & 0o777) !== 0o700
      || (uid !== undefined && info.uid !== uid)) {
      throw new Error(`owned session ${description} is unsafe`);
    }
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

/** Capture one bounded, strictly inspected view of the reserved reclamation-name namespace. */
export async function reclamationNamespaceSnapshot(
  executor: DockerExecutor,
  timeout: () => number,
): Promise<ReadonlyMap<string, ReclamationContainerInspect>> {
  const ids = (await executor([
    'ps', '-aq', '--no-trunc', '--filter', `name=^/${RECLAMATION_NAME_PREFIX}`,
  ], timeout())).split('\n').map((entry) => entry.trim()).filter(Boolean);
  if (ids.length > RECLAMATION_NAMESPACE_LIMIT
    || ids.some((id) => !/^[a-f0-9]{64}$/.test(id))
    || new Set(ids).size !== ids.length) {
    throw new Error('Docker returned an invalid or oversized reclamation namespace snapshot');
  }
  const records: ReclamationContainerInspect[] = [];
  for (let offset = 0; offset < ids.length; offset += RECLAMATION_INSPECT_BATCH_SIZE) {
    const batch = ids.slice(offset, offset + RECLAMATION_INSPECT_BATCH_SIZE);
    let parsed: unknown;
    try {
      parsed = JSON.parse(await executor(['inspect', ...batch], timeout())) as unknown;
    } catch (error) {
      throw new Error('Docker returned malformed reclamation namespace inspection', { cause: error });
    }
    if (!Array.isArray(parsed) || parsed.length !== batch.length) {
      throw new Error('Docker reclamation namespace inspection did not exactly bind the requested ids');
    }
    const requested = new Set(batch);
    const observed = new Set<string>();
    for (const value of parsed) {
      if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error('Docker reclamation namespace inspection returned a non-object record');
      }
      const record = value as ReclamationContainerInspect;
      if (typeof record.Id !== 'string' || !requested.has(record.Id) || observed.has(record.Id)
        || typeof record.Name !== 'string'
        || !RECLAMATION_NAME_RE.test(record.Name)) {
        throw new Error('Docker reclamation namespace inspection did not exactly bind id and name');
      }
      observed.add(record.Id);
      records.push(record);
    }
    if (observed.size !== requested.size) {
      throw new Error('Docker reclamation namespace inspection omitted a requested id');
    }
  }
  const byName = new Map<string, ReclamationContainerInspect>();
  for (const record of records) {
    const name = record.Name!.slice(1);
    if (byName.has(name)) throw new Error(`Docker reclamation namespace name is ambiguous: ${name}`);
    byName.set(name, record);
  }
  return byName;
}

/** Prove every immutable task/arm reclamation name absent before filesystem cleanup. */
export async function proveManifestReclamationNamesAbsent(
  manifest: SwebenchProManifest,
  executor: DockerExecutor,
  timeout: () => number,
): Promise<void> {
  const snapshot = await reclamationNamespaceSnapshot(executor, timeout);
  for (const execution of manifest.artifacts.executions) {
    const name = reclamationContainerName(manifest.runId, execution.taskId, execution.arm);
    if (snapshot.has(name)) {
      throw new Error(`reclamation helper name remains occupied before runtime cleanup: ${name}`);
    }
  }
}

/** Remove exact manifest-owned runtime homes only after every helper name is absent. */
export async function cleanupProRuntimeHomes(
  manifest: SwebenchProManifest,
  executor: DockerExecutor = defaultDockerExecutor,
  timeout: () => number = () => 30_000,
): Promise<number> {
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
        trustedSessionRuntimeRoot(runtime, manifest.runId, taskId, arm, runtimeNonce);
        const uid = typeof process.getuid === 'function' ? process.getuid() : undefined;
        for (const child of [join(runtime, 'home'), join(runtime, 'codex-home')]) {
          if (!existsSync(child)) continue;
          const info = lstatSync(child);
          if (info.isSymbolicLink() || !info.isDirectory()
            || (uid !== undefined && info.uid !== uid)) {
            throw new Error('owned session partial runtime child is unsafe');
          }
        }
        return [{ runtime, taskId, arm, runtimeNonce }];
      } catch (error) {
        if (error !== null && typeof error === 'object' && 'code' in error
          && error.code === 'ENOENT' && !existsSync(runtime)) return [];
        throw new Error(`unsafe SWE-bench Pro runtime namespace entry: ${runtime}`, { cause: error });
      }
    });
  if (new Set(candidates.map((candidate) => candidate.runtimeNonce)).size !== candidates.length) {
    throw new Error('SWE-bench Pro session runtime nonce is not unique');
  }
  await proveManifestReclamationNamesAbsent(manifest, executor, timeout);
  for (const candidate of candidates) {
    trustedSessionRuntimeRoot(
      candidate.runtime,
      manifest.runId,
      candidate.taskId,
      candidate.arm,
      candidate.runtimeNonce,
    );
    rmSync(candidate.runtime, { recursive: true });
  }
  return candidates.length;
}

export interface ReclamationRunOwnershipEvidence {
  taskDirectories: ReadonlyMap<string, string>;
  imageAttestations: ReadonlyMap<string, DockerImageAttestation>;
  artifactOwner: SessionArtifactOwner;
  docker: SwebenchProConfig['docker'];
  policy: SwebenchProContainerPolicy;
}

function exactRunReclamationHelper(
  record: ContainerInspect,
  evidence: ReclamationRunOwnershipEvidence,
): boolean {
  try {
    const labels = record.Config?.Labels ?? {};
    const taskId = labels['ultracode.benchmark.task'] ?? '';
    const arm = labels['ultracode.benchmark.arm'];
    if (arm !== 'a' && arm !== 'b') return false;
    const taskDirectory = evidence.taskDirectories.get(`${taskId}\0${arm}`);
    const image = evidence.imageAttestations.get(taskId);
    if (taskDirectory === undefined || image === undefined || record.Id === undefined) return false;
    const base: ReclamationContainerSpec = {
      name: reclamationContainerName(labels['ultracode.benchmark.run'] ?? '', taskId, arm),
      runId: labels['ultracode.benchmark.run'] ?? '',
      taskId,
      arm,
      taskDirectory,
      artifactOwner: evidence.artifactOwner,
      image,
      docker: evidence.docker,
    };
    const observed = compatibleReclamationSpec(record, base);
    assertExactReclamationHelper(record, record.Id, observed, evidence.policy);
    return true;
  } catch {
    return false;
  }
}

export function ownedRunContainerIds(
  records: readonly ContainerInspect[],
  runId: string,
  taskIds: ReadonlySet<string>,
  invocationIds: ReadonlySet<string>,
  verifierEvidence?: {
    runDirectory: string;
    imageIdentities: ReadonlyMap<string, EvaluatorImageIdentity>;
    invocationStartedMs: ReadonlyMap<string, number>;
  },
  reclamationEvidence?: ReclamationRunOwnershipEvidence,
): string[] {
  return records.flatMap((record) => {
    const labels = record.Config?.Labels ?? {};
    const purpose = labels['ultracode.benchmark.purpose'];
    const arm = labels['ultracode.benchmark.arm'];
    const exactPurpose = purpose === 'session'
      ? (arm === 'a' || arm === 'b') && /^[a-f0-9]{64}$/.test(labels['ultracode.benchmark.runtime'] ?? '')
      : purpose === 'reclamation' && reclamationEvidence !== undefined
        ? exactRunReclamationHelper(record, reclamationEvidence)
        : purpose === 'verifier' && verifierEvidence !== undefined
        && ['a', 'b', 'gold', 'nullcheck'].includes(arm ?? '')
        && invocationIds.has(labels['ultracode.benchmark.invocation'] ?? '')
        && existingEvaluatorContainerIds([record], {
          outputDirectory: join(
            verifierEvidence.runDirectory,
            'native',
            'verifier',
            arm === 'a' ? 'armA' : arm === 'b' ? 'armB' : arm!,
            'output',
          ),
          runId,
          armLabel: arm!,
          taskIds,
          imageIdentities: verifierEvidence.imageIdentities,
          invocationIds,
          invocationStartedMs: verifierEvidence.invocationStartedMs,
        }).length === 1;
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
  roots: BenchPathRoots,
  manifest: SwebenchProManifest,
  invocationStartedMs: ReadonlyMap<string, number>,
  executor: DockerExecutor = defaultDockerExecutor,
): Promise<number> {
  try {
    const runId = manifest.runId;
    const listRunIds = async (
      timeout: () => number = survivorCleanupTimeout(),
    ): Promise<string[]> => {
      const ids = (await executor(
        ['ps', '-aq', '--no-trunc', '--filter', `label=ultracode.benchmark.run=${runId}`],
        timeout(),
      ))
        .split('\n').map((entry) => entry.trim()).filter(Boolean);
      if (ids.some((id) => !/^[a-f0-9]{64}$/.test(id))) {
        throw new Error('Docker returned an invalid run-owned container id');
      }
      return ids;
    };
    const discoveryTimeout = survivorCleanupTimeout();
    const ids = await listRunIds(discoveryTimeout);
    const parsed = ids.length === 0
      ? []
      : JSON.parse(await executor(['inspect', ...ids], discoveryTimeout())) as ContainerInspect[];
    if (parsed.length !== ids.length || parsed.some((record) => typeof record.Id !== 'string'
      || !/^[a-f0-9]{64}$/.test(record.Id)
      || ids.filter((id) => record.Id === id).length !== 1)) {
      throw new Error('Docker inspection did not exactly bind the requested run-owned container ids');
    }
    const invocationIds = new Set(invocationStartedMs.keys());
    const verifierImageIdentities = new Map(manifest.provenance.tasks.map((task) => {
      if (task.image === null) throw new Error(`task ${task.taskId} has no evaluator image identity`);
      return [task.taskId, {
        localId: task.image.base.localId,
      }] as const;
    }));
    const taskDirectories = new Map(manifest.artifacts.executions.map((execution) => [
      `${execution.taskId}\0${execution.arm}`,
      executionDirectory(runDir(roots, 'swebench-pro', runId), execution.nativeRoot),
    ]));
    const taskImages = imageAttestations(manifest);
    const artifactOwner = hostArtifactOwner();
    const policy = loadSwebenchProContainerPolicy(roots);
    const sessionExecutor: SessionDockerExecutor = (argv, _lifecycle, timeoutMs) =>
      executor(argv, timeoutMs);
    const reclamationByName = await reclamationNamespaceSnapshot(executor, survivorCleanupTimeout());
    const occupiedReclamationSpecs: ReclamationContainerSpec[] = [];
    for (const execution of manifest.artifacts.executions) {
      const taskDirectory = taskDirectories.get(`${execution.taskId}\0${execution.arm}`);
      const image = taskImages.get(execution.taskId);
      if (taskDirectory === undefined || image === undefined) {
        throw new Error('manifest reclamation helper has no complete ownership evidence');
      }
      const base: ReclamationContainerSpec = {
        name: reclamationContainerName(runId, execution.taskId, execution.arm),
        runId,
        taskId: execution.taskId,
        arm: execution.arm,
        taskDirectory,
        artifactOwner,
        image,
        docker: manifest.suiteConfig.docker,
      };
      const record = reclamationByName.get(base.name);
      if (record === undefined) continue;
      const observed = compatibleReclamationSpec(record, base);
      assertExactReclamationHelper(record, record.Id!, observed, policy);
      occupiedReclamationSpecs.push(observed);
    }
    for (const observed of occupiedReclamationSpecs) {
      await reclaimSessionOwnership({ ...observed, policy }, {}, sessionExecutor, survivorCleanupTimeout());
    }
    const owned = ownedRunContainerIds(
      parsed,
      runId,
      new Set(manifest.experiment.taskIds),
      invocationIds,
      {
        runDirectory: runDir(roots, 'swebench-pro', runId),
        imageIdentities: verifierImageIdentities,
        invocationStartedMs,
      },
      {
        taskDirectories,
        imageAttestations: taskImages,
        artifactOwner,
        docker: manifest.suiteConfig.docker,
        policy,
      },
    );
    if (owned.length !== parsed.length) {
      throw new Error('run-labelled Docker resources do not have complete manifest ownership');
    }
    const ordered = parsed.filter((record) => owned.includes(record.Id!)).sort((left, right) => {
      const rank = (record: ContainerInspect): number => {
        const purpose = record.Config?.Labels?.['ultracode.benchmark.purpose'];
        return purpose === 'session' ? 0 : purpose === 'reclamation' ? 1 : 2;
      };
      return rank(left) - rank(right);
    });
    for (const record of ordered) {
      const id = record.Id!;
      const labels = record.Config?.Labels ?? {};
      if (labels['ultracode.benchmark.purpose'] === 'session') {
        const taskId = labels['ultracode.benchmark.task']!;
        const arm = labels['ultracode.benchmark.arm'] as Arm;
        const taskDirectory = taskDirectories.get(`${taskId}\0${arm}`);
        const image = taskImages.get(taskId);
        if (taskDirectory === undefined) throw new Error('owned session has no manifest task directory');
        if (image === undefined) throw new Error('owned session has no manifest image identity');
        await stopPersistedSessionContainer(
          containerName(runId, taskId, arm),
          runId,
          taskId,
          arm,
          {},
          sessionExecutor,
          {
            attemptDeadline: performance.now() + SESSION_CLEANUP_RESERVE_MS,
            taskDirectory,
            artifactOwner,
            image,
            docker: manifest.suiteConfig.docker,
            policy,
          },
        );
        continue;
      }
      if (labels['ultracode.benchmark.purpose'] === 'reclamation') {
        const taskId = labels['ultracode.benchmark.task']!;
        const arm = labels['ultracode.benchmark.arm'] as Arm;
        const taskDirectory = taskDirectories.get(`${taskId}\0${arm}`)!;
        const image = taskImages.get(taskId)!;
        const base: ReclamationContainerSpec = {
          name: reclamationContainerName(runId, taskId, arm),
          runId,
          taskId,
          arm,
          taskDirectory,
          artifactOwner,
          image,
          docker: manifest.suiteConfig.docker,
        };
        const survivorTimeout = survivorCleanupTimeout();
        const current = await inspectExactReclamationName(
          base,
          null,
          policy,
          {},
          sessionExecutor,
          survivorTimeout,
        );
        if (current !== null) {
          await reclaimSessionOwnership({
            ...current.spec,
            policy,
          }, {}, sessionExecutor, survivorTimeout);
        }
        continue;
      }
      const survivorTimeout = survivorCleanupTimeout();
      let removalFailure: unknown;
      try {
        await executor(['rm', '-f', id], survivorTimeout());
      } catch (error) {
        removalFailure = error;
      }
      const remaining = await listRunIds(survivorTimeout);
      if (remaining.includes(id)) {
        throw ownershipUnsafeAggregate('run-owned container absence was not proven after removal', [
          removalFailure,
          new Error(`run-owned container remains present: ${id}`),
        ]);
      }
    }
    const remaining = await listRunIds();
    if (remaining.length > 0) {
      throw new Error(`run-owned containers remain after cleanup: ${remaining.join(', ')}`);
    }
    await cleanupProRuntimeHomes(manifest, executor, survivorCleanupTimeout());
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
      context.paths,
      stores.manifest,
      new Map(stores.state.load().invocations.map((invocation) => [
        invocation.invocationId,
        Date.parse(invocation.startedAt),
      ])),
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
    await rethrowAfterRuntimeCleanup(error, stores.policyLock);
  } finally {
    try { stores.lease.release(); } finally { stores.policyLock.release(); }
  }
}

/** Suite cleanup covers every tracked daemon-owned session, evaluator, and reclamation helper. */
export async function cleanupSwebenchProRuntime(): Promise<void> {
  const reclamationBefore = await Promise.allSettled([cleanupActiveReclamationHelpers()]);
  const blocked = reclamationBefore.some((result) => result.status === 'rejected');
  const primary = await Promise.allSettled([
    cleanupActiveSwebenchProEvaluators(),
    ...(blocked ? [] : [cleanupActiveSwebenchProContainers()]),
  ]);
  const reclamationAfter = await Promise.allSettled([cleanupActiveReclamationHelpers()]);
  const failures = [...reclamationBefore, ...primary, ...reclamationAfter]
    .flatMap((result) => result.status === 'rejected' ? [result.reason] : []);
  if (failures.some((error) => error instanceof OwnershipUnsafeCleanupError)) {
    throw ownershipUnsafeAggregate('SWE-bench Pro runtime cleanup failed ownership checks', failures);
  }
  if (failures.length > 0) throw new AggregateError(failures, 'SWE-bench Pro runtime cleanup failed');
}

/** Preserve command failure while settling resources under its still-held host policy lock. */
async function rethrowAfterRuntimeCleanup(
  error: unknown,
  policyLock: BenchLockHandle | null,
): Promise<never> {
  if (policyLock === null) throw error;
  policyLock.assertHeld();
  try {
    await cleanupSwebenchProRuntime();
  } catch (cleanupError) {
    throw ownershipUnsafeAggregate('SWE-bench Pro command and terminal cleanup both failed', [
      error,
      cleanupError,
    ]);
  }
  throw error;
}

export const defaultCommandContext = (paths: BenchPathRoots): CommandContext => ({
  stdout: process.stdout,
  stderr: process.stderr,
  paths,
  clock: SYSTEM_CLOCK,
});
