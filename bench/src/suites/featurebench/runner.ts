/** FeatureBench lifecycle on shared v2 state, receipts, metrics, and reports. */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
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
  type FeatureBenchManifest,
} from '../../shared/manifest.js';
import { DEFAULT_METRICS_POLICY, METRICS_POLICY_SHA256, normalizeBenchMetrics } from '../../shared/metrics.js';
import {
  createPrivateRunDirectory,
  artifactKey,
  ensurePrivateDirectoryWithin,
  manifestFile,
  nativeDir,
  readPrivateJson,
  readRegularFileWithinRoot,
  reclaimAndAssertArtifactTree,
  reportJsonFile,
  reportMarkdownFile,
  resolveRegularFileWithinRoot,
  runClaimFile,
  runDir,
  runLeaseFile,
  validateFeatureBenchTaskId,
  validateRelativeArtifactPath,
  validateRunId,
  writePrivateFileAtomic,
  writePrivateJsonAtomic,
} from '../../shared/paths.js';
import {
  BenchProcessError,
  allowlistedEnvironment,
  runBenchProcess,
  type BenchProcessOptions,
} from '../../shared/process.js';
import { ARM_B_PREFIX_PATH, armBPrefixBytes } from '../../shared/prompt.js';
import { canonicalJson, sha256Buffer, sha256CanonicalJson, sha256File } from '../../shared/provenance.js';
import {
  REPORT_POLICY_SHA256,
  buildBenchReport,
  loadStoredReportEvidence,
  writeBenchReport,
  type SuiteAnalysisHook,
  type NativeAnalysisArtifactInput,
  type TaskReportInput,
} from '../../shared/report.js';
import { BenchRunStateStore, type BenchRunState } from '../../shared/run-state.js';
import { oneDockerInspectRow } from '../../shared/docker-isolation.js';
import {
  UNVERIFIED_NATIVE_RESULT,
  VerifierReceiptStore,
  createVerifierBinding,
  type NativeVerifierResult,
  type VerifierBinding,
} from '../../shared/verifier.js';
import {
  FEATUREBENCH_DATASET,
  FEATUREBENCH_DATASET_REVISION,
  FEATUREBENCH_NETWORK_POLICY,
  FEATUREBENCH_NETWORK_POLICY_SHA256,
  FEATUREBENCH_SPLIT,
  featureBenchPreparedDir,
  loadFeatureBenchOperatorConfig,
  loadFeatureBenchRuntimeBindings,
  validateFeatureBenchConfig,
  type FeatureBenchConfig,
  type FeatureBenchRuntimeBindings,
} from './config.js';
import { requireFeatureBenchHost } from './host.js';
import {
  loadCurrentPreparedFeatureBenchInputs,
  loadPreparedFeatureBenchInputs,
  prepareFeatureBenchInputs,
  reattestPreparedFeatureBench,
  type FeatureBenchExecOptions,
  type FeatureBenchExecutor,
  type FeatureBenchTaskInput,
  type PreparedFeatureBenchInputs,
} from './prepare.js';
import { indexFeatureBenchMetrics } from './telemetry.js';
import {
  indexFeatureBenchEvidence,
  parseFeatureBenchAggregateReport,
  validateFeatureBenchRunMetadata,
  type FeatureBenchAggregate,
} from './verifier.js';

const TOOLCHAIN_CACHE_LOCK = '.locks/toolchain.lock';
const SUITE_CACHE_LOCK = '.locks/featurebench.lock';
const TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}__\d{2}-\d{2}-\d{2}$/;
const FEATUREBENCH_RUNTIME_MARKER = '.ultracode-benchmark-runtime.json';

function featureBenchRuntimePrefix(runId: string, arm: Arm): string {
  return `uc-featurebench-runtime-${runId}-${arm}-`;
}

function assertFeatureBenchRuntimeDirectory(directory: string, runId: string, arm: Arm, nonce: string): void {
  const name = relative(tmpdir(), directory);
  const prefix = featureBenchRuntimePrefix(runId, arm);
  if (name.includes(sep) || !name.startsWith(prefix) || !/^[A-Za-z0-9]+$/.test(name.slice(prefix.length))) {
    throw new Error('FeatureBench runtime home is outside its exact temporary namespace');
  }
  const info = lstatSync(directory);
  const uid = typeof process.getuid === 'function' ? process.getuid() : undefined;
  if (info.isSymbolicLink() || !info.isDirectory() || (info.mode & 0o777) !== 0o700
    || (uid !== undefined && info.uid !== uid)) {
    throw new Error('FeatureBench runtime home is unsafe');
  }
  const expected = {
    schemaVersion: 2,
    kind: 'ultracode-featurebench-runtime',
    runId,
    arm,
    nonce,
  };
  if (canonicalJson(readPrivateJson(directory, join(directory, FEATUREBENCH_RUNTIME_MARKER))) !== canonicalJson(expected)) {
    throw new Error('FeatureBench runtime marker does not match its run');
  }
}

function createFeatureBenchRuntimeHome(runId: string, arm: Arm): { directory: string; nonce: string } {
  const nonce = randomBytes(32).toString('hex');
  const directory = mkdtempSync(join(tmpdir(), featureBenchRuntimePrefix(runId, arm)));
  chmodSync(directory, 0o700);
  try {
    writePrivateJsonAtomic(directory, join(directory, FEATUREBENCH_RUNTIME_MARKER), {
      schemaVersion: 2,
      kind: 'ultracode-featurebench-runtime',
      runId,
      arm,
      nonce,
    });
    assertFeatureBenchRuntimeDirectory(directory, runId, arm, nonce);
    return { directory, nonce };
  } catch (error) {
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}

/** Remove exact run-owned FeatureBench runtime bindings orphaned by a hard crash. */
export function cleanupFeatureBenchRuntimeHomes(runId: string, arm: Arm): number {
  validateRunId(runId);
  const prefix = featureBenchRuntimePrefix(runId, arm);
  const candidates = readdirSync(tmpdir(), { withFileTypes: true })
    .filter((entry) => entry.name.startsWith(prefix));
  for (const entry of candidates) {
    const directory = join(tmpdir(), entry.name);
    if (!entry.isDirectory()) throw new Error(`unsafe FeatureBench runtime namespace entry: ${directory}`);
    if (readdirSync(directory).length === 0) {
      const info = lstatSync(directory);
      const uid = typeof process.getuid === 'function' ? process.getuid() : undefined;
      if ((info.mode & 0o777) !== 0o700 || (uid !== undefined && info.uid !== uid)) {
        throw new Error(`unsafe FeatureBench runtime namespace entry: ${directory}`);
      }
      rmSync(directory);
      continue;
    }
    const marker = readPrivateJson(directory, join(directory, FEATUREBENCH_RUNTIME_MARKER));
    if (marker === null || typeof marker !== 'object' || Array.isArray(marker)
      || typeof (marker as Record<string, unknown>).nonce !== 'string') {
      throw new Error(`unsafe FeatureBench runtime namespace entry: ${directory}`);
    }
    const nonce = (marker as { nonce: string }).nonce;
    if (!/^[a-f0-9]{64}$/.test(nonce)) throw new Error(`unsafe FeatureBench runtime nonce: ${directory}`);
    assertFeatureBenchRuntimeDirectory(directory, runId, arm, nonce);
    rmSync(directory, { recursive: true });
  }
  return candidates.length;
}

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

export const FEATUREBENCH_ADAPTER_POLICY_SHA256 = sha256CanonicalJson({
  schemaVersion: 2,
  layout: 'suite-run/native/timestamp',
  arm: 'one-per-run',
  runner: 'pinned-fb-infer-and-fb-eval',
  runtime: 'cpu-only',
  credentials: 'broker-outside-task-containers',
  network: FEATUREBENCH_NETWORK_POLICY,
  ownership: 'ultracode-benchmark-label-namespace',
  verifier: 'task-pass-rate-plus-run-attempt-1-aggregate',
  timestamps: 'accepted-invocation-snapshots-bound-in-run-state-and-receipt',
});

export interface FeatureBenchCommand {
  command: string;
  argv: string[];
  cwd: string;
}

export interface FeatureBenchRunPlan {
  config: string;
  infer: FeatureBenchCommand;
}

interface RuntimeAttestation {
  endpointPolicySha256: string;
  brokerRuntimeSha256: string;
  selectedTasks: FeatureBenchTaskInput[];
}

function output(context: CommandContext, value: string): void {
  context.stdout.write(`${value}\n`);
}

function sha256Text(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export function featureBenchPolicyLockFile(roots: BenchPathRoots): string {
  return join(roots.cacheRoot, '.locks', `featurebench-network-${FEATUREBENCH_NETWORK_POLICY_SHA256}.lock`);
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

function currentControlPlaneHashes(roots: BenchPathRoots): FeatureBenchManifest['provenance']['controlPlane'] {
  return {
    manifestPolicySha256: sourcePolicyHash(roots, MANIFEST_POLICY_SHA256, ['src/shared/manifest.ts']),
    metricsPolicySha256: sourcePolicyHash(roots, METRICS_POLICY_SHA256, ['src/shared/metrics.ts', 'src/shared/jsonl.ts']),
    failurePolicySha256: sourcePolicyHash(roots, FAILURE_POLICY_SHA256, ['src/shared/failure.ts']),
    reportPolicySha256: sourcePolicyHash(roots, REPORT_POLICY_SHA256, ['src/shared/report.ts']),
    adapterPolicySha256: sourcePolicyHash(roots, FEATUREBENCH_ADAPTER_POLICY_SHA256, [
      'src/cli.ts',
      'src/shared/config.ts',
      'src/shared/contracts.ts',
      'src/shared/docker-isolation.ts',
      'src/shared/locks.ts',
      'src/shared/manifest.ts',
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
      'src/suites/featurebench/adapter.ts',
      'src/suites/featurebench/config.ts',
      'src/suites/featurebench/host.ts',
      'src/suites/featurebench/prepare.ts',
      'src/suites/featurebench/runner.ts',
      'src/suites/featurebench/telemetry.ts',
      'src/suites/featurebench/verifier.ts',
    ]),
  };
}

function pricing(config: FeatureBenchConfig): FeatureBenchManifest['pricing'] {
  const selected = config.pricing?.[config.model];
  return selected === undefined ? null : { currency: 'USD', model: config.model, ...selected };
}

function promptPolicySha256(): string {
  return sha256CanonicalJson({
    composition: 'arm-a-verbatim-arm-b-prefix-bytes',
    prefixSha256: sha256File(ARM_B_PREFIX_PATH),
  });
}

function featureBenchNativeAssets(roots: BenchPathRoots): FeatureBenchManifest['provenance']['nativeAssets'] {
  return [
    'suites/featurebench/.gitattributes',
    'suites/featurebench/codex-chatgpt.patch',
    'suites/featurebench/dataset-pin.json',
    relative(roots.benchRoot, ARM_B_PREFIX_PATH).split(sep).join('/'),
  ].map((path) => ({
    path: validateRelativeArtifactPath(path),
    sha256: sha256File(join(roots.benchRoot, ...path.split('/'))),
  }));
}

function buildManifest(
  roots: BenchPathRoots,
  runId: string,
  config: FeatureBenchConfig,
  prepared: PreparedFeatureBenchInputs,
  runtime: RuntimeAttestation,
  now: Date,
): FeatureBenchManifest {
  const controlPlane = currentControlPlaneHashes(roots);
  const selected = config.taskIds.map((taskId) => {
    const task = runtime.selectedTasks.find((candidate) => candidate.taskId === taskId);
    if (!task) throw new Error(`prepared FeatureBench task is missing: ${taskId}`);
    return task;
  });
  const assets = featureBenchNativeAssets(roots);
  return {
    schemaVersion: 2,
    kind: 'ultracode-benchmark-run',
    suite: 'featurebench',
    runId: validateRunId(runId),
    createdAt: now.toISOString(),
    experiment: {
      model: config.model,
      requestedEffort: config.requestedEffort,
      arm: config.arm,
      taskIds: [...config.taskIds],
    },
    limits: {
      hostTaskTimeoutMs: config.timeouts.inferenceMs,
      hostVerifierTimeoutMs: config.timeouts.evaluationMs,
      taskConcurrency: config.concurrency.inference,
      verifierConcurrency: config.concurrency.evaluation,
    },
    metricsPolicy: { ...DEFAULT_METRICS_POLICY, implementationSha256: controlPlane.metricsPolicySha256 },
    pricing: pricing(config),
    provenance: {
      toolchain: prepared.toolchain.provenance,
      controlPlane,
      suiteSource: prepared.source,
      dataset: {
        identity: FEATUREBENCH_DATASET,
        revision: FEATUREBENCH_DATASET_REVISION,
        split: FEATUREBENCH_SPLIT,
        snapshotSha256: sha256CanonicalJson(selected.map((task) => ({ taskId: task.taskId, sourceSha256: task.sourceSha256 }))),
      },
      environment: {
        platform: process.platform,
        architecture: process.arch,
        nodeVersion: process.version,
        pythonVersion: prepared.pythonVersion,
        environmentSha256: prepared.environmentSha256,
      },
      nativeAssets: assets,
      tasks: selected.map((task) => ({
        taskId: task.taskId,
        sourceSha256: task.sourceSha256,
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
      executions: config.taskIds.map((taskId) => ({
        taskId,
        arm: config.arm,
        key: artifactKey(taskId),
        nativeRoot: validateRelativeArtifactPath('native'),
      })),
    },
    suiteConfig: {
      preparedInputSha256: prepared.directory.split('/').at(-1)!,
      authMechanism: 'credential-broker',
      runtime: 'cpu',
      publicBrokerIdentitySha256: sha256Text(config.broker.publicIdentity),
      publicBrokerVersionSha256: sha256Text(config.broker.publicVersion),
      restrictedNetworkPolicySha256: runtime.endpointPolicySha256,
      attempts: 1,
      retries: 0,
      inference: { concurrency: config.concurrency.inference, timeoutMs: config.timeouts.inferenceMs },
      evaluation: { concurrency: config.concurrency.evaluation, timeoutMs: config.timeouts.evaluationMs },
      resources: { ...config.resources },
      policies: {
        promptSha256: promptPolicySha256(),
        patchSha256: prepared.patchSha256,
        datasetMapSha256: prepared.datasetMapSha256,
        adapterSha256: controlPlane.adapterPolicySha256,
      },
    },
  };
}

function overrideConfig(config: FeatureBenchConfig, options: RunOptions): FeatureBenchConfig {
  const resolved: FeatureBenchConfig = {
    ...config,
    ...(options.model === undefined ? {} : { model: options.model }),
    ...(options.requestedEffort === undefined ? {} : { requestedEffort: options.requestedEffort }),
    ...(options.arm === undefined ? {} : { arm: options.arm }),
    ...(options.taskIds === undefined ? {} : { taskIds: [...options.taskIds] }),
  };
  validateFeatureBenchConfig(resolved);
  return resolved;
}

function resumeConfig(operator: FeatureBenchConfig, manifest: FeatureBenchManifest): FeatureBenchConfig {
  const config: FeatureBenchConfig = {
    ...operator,
    model: manifest.experiment.model,
    requestedEffort: manifest.experiment.requestedEffort,
    arm: manifest.experiment.arm as Arm,
    taskIds: [...manifest.experiment.taskIds],
    concurrency: {
      inference: manifest.suiteConfig.inference.concurrency,
      evaluation: manifest.suiteConfig.evaluation.concurrency,
    },
    timeouts: {
      inferenceMs: manifest.suiteConfig.inference.timeoutMs,
      evaluationMs: manifest.suiteConfig.evaluation.timeoutMs,
    },
    resources: { ...manifest.suiteConfig.resources },
    pricing: manifest.pricing === null ? undefined : {
      [manifest.pricing.model]: {
        uncachedInputPerMTokens: manifest.pricing.uncachedInputPerMTokens,
        cachedInputPerMTokens: manifest.pricing.cachedInputPerMTokens,
        outputPerMTokens: manifest.pricing.outputPerMTokens,
      },
    },
  };
  if (sha256Text(config.broker.publicIdentity) !== manifest.suiteConfig.publicBrokerIdentitySha256
    || sha256Text(config.broker.publicVersion) !== manifest.suiteConfig.publicBrokerVersionSha256) {
    throw new Error('runtime broker public identity or version does not match the immutable manifest');
  }
  return config;
}

function assertResumeOptions(options: RunOptions, manifest: FeatureBenchManifest): void {
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

interface DockerNetworkInspect {
  Internal?: unknown;
  Driver?: unknown;
  Scope?: unknown;
  Attachable?: unknown;
  Ingress?: unknown;
  Labels?: unknown;
  Options?: unknown;
  IPAM?: unknown;
  Containers?: unknown;
}

interface DockerContainerInspect {
  Id?: unknown;
  Image?: unknown;
  Path?: unknown;
  Args?: unknown;
  State?: { Running?: unknown };
  Config?: { Labels?: unknown };
  HostConfig?: { Binds?: unknown; Mounts?: unknown; Tmpfs?: unknown };
  Mounts?: unknown;
  NetworkSettings?: { Networks?: unknown };
}

/** Validate the broker-only internal-network boundary without persisting runtime names. */
export function inspectFeatureBenchTrustBoundary(
  networkStdout: string,
  brokerStdout: string,
  config: FeatureBenchConfig,
  bindings: FeatureBenchRuntimeBindings,
): Pick<RuntimeAttestation, 'endpointPolicySha256' | 'brokerRuntimeSha256'> {
  const network = oneDockerInspectRow<DockerNetworkInspect>(networkStdout, 'FeatureBench network');
  const labels = network.Labels !== null && typeof network.Labels === 'object' && !Array.isArray(network.Labels)
    ? network.Labels as Record<string, unknown>
    : {};
  const containers = network.Containers !== null && typeof network.Containers === 'object' && !Array.isArray(network.Containers)
    ? Object.entries(network.Containers as Record<string, unknown>)
    : [];
  const brokerEndpoint = new URL(bindings.brokerUrl);
  const brokerHost = brokerEndpoint.hostname;
  if (network.Internal !== true || labels['ultracode.egress-policy'] !== FEATUREBENCH_NETWORK_POLICY.policyLabel
    || containers.length !== 1 || !containers.every(([, value]) => value !== null && typeof value === 'object'
      && !Array.isArray(value) && (value as Record<string, unknown>).Name === brokerHost)) {
    throw new Error('restricted FeatureBench network must be internal and contain exactly the named credential broker');
  }
  const broker = oneDockerInspectRow<DockerContainerInspect>(brokerStdout, 'FeatureBench broker');
  const brokerLabels = broker.Config?.Labels !== null && typeof broker.Config?.Labels === 'object'
    && !Array.isArray(broker.Config.Labels) ? broker.Config.Labels as Record<string, unknown> : {};
  const brokerNetworks = broker.NetworkSettings?.Networks !== null
    && typeof broker.NetworkSettings?.Networks === 'object'
    && !Array.isArray(broker.NetworkSettings.Networks)
    ? Object.keys(broker.NetworkSettings.Networks as Record<string, unknown>).sort()
    : [];
  if (broker.State?.Running !== true || typeof broker.Id !== 'string' || !/^[a-f0-9]{64}$/.test(broker.Id)
    || broker.Id !== containers[0]![0]
    || typeof broker.Image !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(broker.Image)
    || brokerLabels['ultracode.credential-broker'] !== 'true'
    || brokerLabels['ultracode.credential-broker.identity'] !== config.broker.publicIdentity
    || brokerLabels['ultracode.credential-broker.version'] !== config.broker.publicVersion
    || !brokerNetworks.includes(bindings.restrictedNetwork)) {
    throw new Error('credential broker public identity, version, label, state, or immutable image is invalid');
  }
  const brokerRuntimeSha256 = sha256CanonicalJson({
    image: broker.Image,
    path: broker.Path,
    args: broker.Args,
    binds: broker.HostConfig?.Binds,
    configuredMounts: broker.HostConfig?.Mounts,
    runtimeMounts: broker.Mounts,
    tmpfs: broker.HostConfig?.Tmpfs,
    networksSha256: sha256CanonicalJson(brokerNetworks),
    publicLabels: {
      broker: brokerLabels['ultracode.credential-broker'],
      identity: brokerLabels['ultracode.credential-broker.identity'],
      version: brokerLabels['ultracode.credential-broker.version'],
    },
  });
  return {
    brokerRuntimeSha256,
    endpointPolicySha256: sha256CanonicalJson({
      policySha256: FEATUREBENCH_NETWORK_POLICY_SHA256,
      networkRuntimeSha256: sha256CanonicalJson({
        internal: network.Internal ?? null,
        driver: network.Driver ?? null,
        scope: network.Scope ?? null,
        attachable: network.Attachable ?? null,
        ingress: network.Ingress ?? null,
        options: network.Options ?? null,
        ipam: network.IPAM ?? null,
        policyLabel: labels['ultracode.egress-policy'] ?? null,
      }),
      selectedNetworkSha256: sha256Text(bindings.restrictedNetwork),
      brokerEndpointSha256: sha256CanonicalJson({
        protocol: brokerEndpoint.protocol,
        hostname: brokerEndpoint.hostname,
        port: brokerEndpoint.port,
        pathname: brokerEndpoint.pathname,
      }),
      brokerRuntimeSha256,
      publicBrokerIdentitySha256: sha256Text(config.broker.publicIdentity),
      publicBrokerVersionSha256: sha256Text(config.broker.publicVersion),
    }),
  };
}

interface DockerImageInspect {
  Id?: unknown;
  Os?: unknown;
  Architecture?: unknown;
  RepoDigests?: unknown;
}

function assertImageInspection(stdout: string, expected: FeatureBenchTaskInput): void {
  const image = oneDockerInspectRow<DockerImageInspect>(stdout, `FeatureBench image ${expected.taskId}`);
  const digests = Array.isArray(image.RepoDigests) ? image.RepoDigests : [];
  if (image.Id !== expected.imageLocalId || `${String(image.Os)}/${String(image.Architecture)}` !== expected.imagePlatform
    || !digests.includes(expected.imageResolvedDigest)) {
    throw new Error(`FeatureBench image identity drifted for ${expected.taskId}`);
  }
}

async function nativeExecute(
  command: string,
  argv: readonly string[],
  options: FeatureBenchExecOptions = {},
): Promise<{ stdout: string; stderr: string }> {
  const processOptions: BenchProcessOptions = {
    cwd: options.cwd ?? process.cwd(),
    tailBytes: 64 * 1_024 * 1_024,
  };
  if (options.env !== undefined) processOptions.env = options.env;
  if (options.stream !== undefined) processOptions.stream = options.stream;
  if (options.timeoutMs !== undefined) processOptions.timeoutMs = options.timeoutMs;
  if (options.workerScope !== undefined) processOptions.workerScope = options.workerScope;
  if (options.onLifecycleToken !== undefined) processOptions.onLifecycleToken = options.onLifecycleToken;
  if (options.onLifecycleStarted !== undefined) processOptions.onLifecycleStarted = options.onLifecycleStarted;
  if (options.onLifecycleRecovered !== undefined) processOptions.onLifecycleRecovered = options.onLifecycleRecovered;
  const result = await runBenchProcess(command, argv, processOptions);
  return { stdout: result.stdout, stderr: result.stderr };
}

function ownershipLabels(runId: string, arm: Arm): Record<string, string> {
  return {
    'ultracode.benchmark.schema': '2',
    'ultracode.benchmark.suite': 'featurebench',
    'ultracode.benchmark.run': runId,
    'ultracode.benchmark.arm': arm,
    'ultracode.benchmark.ownership': '1',
  };
}

const FEATUREBENCH_CLEANUP_DOCKER_TIMEOUT_MS = 30_000;

/** Remove only exact run-owned FeatureBench session/prep containers. */
export async function cleanupFeatureBenchContainers(
  runId: string,
  arm: Arm,
  taskIds: readonly string[],
  executor: FeatureBenchExecutor = nativeExecute,
): Promise<number> {
  validateRunId(runId);
  taskIds.forEach(validateFeatureBenchTaskId);
  const taskMembership = new Set(taskIds);
  if (taskMembership.size !== taskIds.length) {
    throw new Error('FeatureBench cleanup task membership contains duplicates');
  }
  const labels = ownershipLabels(runId, arm);
  const filters = Object.entries(labels).flatMap(([name, value]) => ['--filter', `label=${name}=${value}`]);
  const listed = await executor('docker', ['ps', '--all', '--quiet', ...filters], {
    env: allowlistedEnvironment(process.env),
    timeoutMs: FEATUREBENCH_CLEANUP_DOCKER_TIMEOUT_MS,
  });
  const candidates = listed.stdout.split(/\s+/u).filter(Boolean);
  if (candidates.some((id) => !/^[a-f0-9]{12,64}$/.test(id))) {
    throw new Error('Docker returned an invalid owned container id');
  }
  const orderedCandidates = [...candidates].sort((left, right) => left.length - right.length || left.localeCompare(right));
  for (let index = 0; index < orderedCandidates.length; index += 1) {
    const prefix = orderedCandidates[index]!;
    if (orderedCandidates.some((candidate, candidateIndex) => candidateIndex !== index && candidate.startsWith(prefix))) {
      throw new Error(`Docker returned duplicate or ambiguous FeatureBench container prefix ${prefix}`);
    }
  }

  const verified = new Set<string>();
  for (const candidate of candidates) {
    const inspected = oneDockerInspectRow<DockerContainerInspect>((await executor('docker', ['inspect', candidate], {
      env: allowlistedEnvironment(process.env),
      timeoutMs: FEATUREBENCH_CLEANUP_DOCKER_TIMEOUT_MS,
    })).stdout, 'owned FeatureBench container');
    const observed = inspected.Config?.Labels !== null && typeof inspected.Config?.Labels === 'object'
      && !Array.isArray(inspected.Config.Labels) ? inspected.Config.Labels as Record<string, unknown> : {};
    if (typeof inspected.Id !== 'string' || !/^[a-f0-9]{64}$/.test(inspected.Id) || !inspected.Id.startsWith(candidate)
      || Object.entries(labels).some(([name, value]) => observed[name] !== value)
      || typeof observed['ultracode.benchmark.task'] !== 'string'
      || !taskMembership.has(observed['ultracode.benchmark.task'])
      || (observed['ultracode.benchmark.purpose'] !== 'prep'
        && observed['ultracode.benchmark.purpose'] !== 'session')) {
      throw new Error(`refusing to remove unowned FeatureBench container ${candidate}`);
    }
    if (verified.has(inspected.Id)) {
      throw new Error(`Docker returned ambiguous ownership for FeatureBench container ${inspected.Id}`);
    }
    verified.add(inspected.Id);
  }
  for (const id of verified) {
    await executor('docker', ['rm', '--force', id], {
      env: allowlistedEnvironment(process.env),
      stream: true,
      timeoutMs: FEATUREBENCH_CLEANUP_DOCKER_TIMEOUT_MS,
    });
  }
  return verified.size;
}

interface ActiveFeatureBenchExecution {
  runId: string;
  arm: Arm;
  taskIds: readonly string[];
  executor: FeatureBenchExecutor;
  cleanupRuntime(): void;
  cleanupPromise?: Promise<void>;
}

const ACTIVE_FEATUREBENCH_EXECUTIONS = new Map<string, ActiveFeatureBenchExecution>();

function trackFeatureBenchExecution(key: string, execution: ActiveFeatureBenchExecution): void {
  if (ACTIVE_FEATUREBENCH_EXECUTIONS.has(key)) {
    throw new Error(`FeatureBench execution is already tracked: ${execution.runId}/${execution.arm}`);
  }
  ACTIVE_FEATUREBENCH_EXECUTIONS.set(key, execution);
}

async function cleanupTrackedFeatureBenchExecution(key: string): Promise<void> {
  const execution = ACTIVE_FEATUREBENCH_EXECUTIONS.get(key);
  if (execution === undefined) return;
  execution.cleanupPromise ??= (async () => {
    const failures: unknown[] = [];
    try {
      await cleanupFeatureBenchContainers(execution.runId, execution.arm, execution.taskIds, execution.executor);
    } catch (error) {
      failures.push(error);
    }
    try {
      execution.cleanupRuntime();
    } catch (error) {
      failures.push(error);
    }
    if (failures.length > 0) throw new AggregateError(failures, 'FeatureBench active execution cleanup failed');
    ACTIVE_FEATUREBENCH_EXECUTIONS.delete(key);
  })();
  const cleanup = execution.cleanupPromise;
  try {
    await cleanup;
  } finally {
    if (ACTIVE_FEATUREBENCH_EXECUTIONS.get(key) === execution && execution.cleanupPromise === cleanup) {
      execution.cleanupPromise = undefined;
    }
  }
}

/** Settle every tracked container set and exact ephemeral runtime binding. */
export async function cleanupFeatureBenchRuntime(): Promise<void> {
  const keys = [...ACTIVE_FEATUREBENCH_EXECUTIONS.keys()];
  const settled = await Promise.allSettled(keys.map(cleanupTrackedFeatureBenchExecution));
  const failures = settled.flatMap((result) => result.status === 'rejected' ? [result.reason] : []);
  if (failures.length > 0) throw new AggregateError(failures, 'FeatureBench runtime cleanup failed');
}

async function attestRuntime(
  roots: BenchPathRoots,
  runId: string,
  config: FeatureBenchConfig,
  bindings: FeatureBenchRuntimeBindings,
  prepared: PreparedFeatureBenchInputs,
  executor: FeatureBenchExecutor = nativeExecute,
): Promise<RuntimeAttestation> {
  requireFeatureBenchHost();
  await reattestPreparedFeatureBench(prepared, roots, executor);
  await cleanupFeatureBenchContainers(runId, config.arm, config.taskIds, executor);
  const network = await executor('docker', ['network', 'inspect', bindings.restrictedNetwork], {
    env: allowlistedEnvironment(process.env),
  });
  const brokerHost = new URL(bindings.brokerUrl).hostname;
  const broker = await executor('docker', ['inspect', brokerHost], { env: allowlistedEnvironment(process.env) });
  const trust = inspectFeatureBenchTrustBoundary(network.stdout, broker.stdout, config, bindings);
  const selectedTasks = config.taskIds.map((taskId) => {
    const task = prepared.tasks.find((candidate) => candidate.taskId === taskId);
    if (!task) throw new Error(`FeatureBench task is absent from the pinned dataset: ${taskId}`);
    return task;
  });
  for (const task of selectedTasks) {
    const inspection = await executor('docker', ['image', 'inspect', task.imageResolvedDigest], {
      env: allowlistedEnvironment(process.env),
    });
    assertImageInspection(inspection.stdout, task);
  }
  return { ...trust, selectedTasks };
}

function assertProvenance(
  roots: BenchPathRoots,
  manifest: FeatureBenchManifest,
  prepared: PreparedFeatureBenchInputs,
  runtime: RuntimeAttestation,
): void {
  const control = currentControlPlaneHashes(roots);
  if (canonicalJson(prepared.toolchain.provenance) !== canonicalJson(manifest.provenance.toolchain)
    || prepared.directory.split('/').at(-1) !== manifest.suiteConfig.preparedInputSha256
    || canonicalJson(prepared.source) !== canonicalJson(manifest.provenance.suiteSource)
    || prepared.environmentSha256 !== manifest.provenance.environment.environmentSha256
    || prepared.patchSha256 !== manifest.suiteConfig.policies.patchSha256
    || prepared.datasetMapSha256 !== manifest.suiteConfig.policies.datasetMapSha256
    || runtime.endpointPolicySha256 !== manifest.suiteConfig.restrictedNetworkPolicySha256
    || canonicalJson(control) !== canonicalJson(manifest.provenance.controlPlane)
    || canonicalJson(featureBenchNativeAssets(roots)) !== canonicalJson(manifest.provenance.nativeAssets)
    || promptPolicySha256() !== manifest.suiteConfig.policies.promptSha256) {
    throw new Error('FeatureBench execution provenance drifted after manifest creation');
  }
}

function tomlString(value: string): string {
  return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('\b', '\\b')
    .replaceAll('\t', '\\t').replaceAll('\n', '\\n').replaceAll('\f', '\\f').replaceAll('\r', '\\r')}"`;
}

/** Secret-free except for runtime endpoint names; this file is private and ephemeral. */
export function featureBenchRuntimeConfig(
  manifest: FeatureBenchManifest,
  runtime: FeatureBenchRuntimeBindings,
): string {
  const imageDigests = Object.fromEntries(manifest.provenance.tasks.map((task) => [task.taskId, task.image!.resolvedDigest]));
  const lines = [
    '[env_vars]',
    `FEATUREBENCH_DATASET_REVISION = ${tomlString(FEATUREBENCH_DATASET_REVISION)}`,
    '',
    '[infer_config.codex]',
    `CODEX_REASONING_EFFORT = ${tomlString(manifest.experiment.requestedEffort)}`,
    `FB_CONTAINER_CPUS = ${tomlString(String(manifest.suiteConfig.resources.cpus))}`,
    `FB_CONTAINER_MEMORY = ${tomlString(String(manifest.suiteConfig.resources.memoryBytes))}`,
    'FEATUREBENCH_BROKER_AUTH = "1"',
    `FEATUREBENCH_BROKER_BASE_URL = ${tomlString(runtime.brokerUrl)}`,
    `FEATUREBENCH_RESTRICTED_NETWORK = ${tomlString(runtime.restrictedNetwork)}`,
    'FEATUREBENCH_CPU_ONLY = "1"',
    `FEATUREBENCH_ARM = ${tomlString(manifest.experiment.arm)}`,
    `FEATUREBENCH_WORKFLOW_WAIT_SECONDS = ${tomlString(String(Math.min(Math.ceil(manifest.limits.hostTaskTimeoutMs! / 1_000), 3_300)))}`,
    `FEATUREBENCH_IMAGE_DIGESTS = ${tomlString(JSON.stringify(imageDigests))}`,
  ];
  if (manifest.experiment.arm === 'b') lines.push(`FEATUREBENCH_PROMPT_PREFIX = ${tomlString(armBPrefixBytes().toString('utf8'))}`);
  return `${lines.join('\n')}\n`;
}

/** Build exact upstream fb infer argv without performing I/O. */
export function planFeatureBenchRun(
  prepared: PreparedFeatureBenchInputs,
  manifest: FeatureBenchManifest,
  runtime: FeatureBenchRuntimeBindings,
  outputDirectory: string,
  configPath = '<runtime-config>',
  taskIds: readonly string[] = manifest.experiment.taskIds,
): FeatureBenchRunPlan {
  return {
    config: featureBenchRuntimeConfig(manifest, runtime),
    infer: {
      command: prepared.fbBinary,
      cwd: prepared.sourceDirectory,
      argv: [
        'infer',
        '--config-path', configPath,
        '--agent', 'codex',
        '--model', manifest.experiment.model,
        '--dataset', FEATUREBENCH_DATASET,
        '--split', FEATUREBENCH_SPLIT,
        '--task-id', ...taskIds,
        '--n-attempts', '1',
        '--n-concurrent', String(manifest.suiteConfig.inference.concurrency),
        '--timeout', String(Math.ceil(manifest.suiteConfig.inference.timeoutMs / 1_000)),
        '--output-dir', outputDirectory,
      ],
    },
  };
}

export function planFeatureBenchResume(
  prepared: PreparedFeatureBenchInputs,
  manifest: FeatureBenchManifest,
  nativeDirectory: string,
  configPath: string,
): FeatureBenchCommand {
  return {
    command: prepared.fbBinary,
    cwd: prepared.sourceDirectory,
    argv: [
      'infer',
      '--resume', nativeDirectory,
      '--config-path', configPath,
      '--n-concurrent', String(manifest.suiteConfig.inference.concurrency),
      '--timeout', String(Math.ceil(manifest.suiteConfig.inference.timeoutMs / 1_000)),
    ],
  };
}

export function planFeatureBenchEval(
  prepared: PreparedFeatureBenchInputs,
  manifest: FeatureBenchManifest,
  predictionsPath: string,
  configPath: string,
): FeatureBenchCommand {
  return {
    command: prepared.fbBinary,
    cwd: prepared.sourceDirectory,
    argv: [
      'eval',
      '--config-path', configPath,
      '--predictions-path', predictionsPath,
      '--dataset', FEATUREBENCH_DATASET,
      '--split', FEATUREBENCH_SPLIT,
      '--n-concurrent', String(manifest.suiteConfig.evaluation.concurrency),
      '--task-id', ...manifest.experiment.taskIds,
    ],
  };
}

function childEnvironment(
  prepared: PreparedFeatureBenchInputs,
  manifest: FeatureBenchManifest,
  runtime: FeatureBenchRuntimeBindings,
  runtimeHome: string,
): NodeJS.ProcessEnv {
  const env = allowlistedEnvironment(process.env);
  Object.assign(env, {
    PYTHONDONTWRITEBYTECODE: '1',
    HOME: runtimeHome,
    XDG_CONFIG_HOME: join(runtimeHome, '.config'),
    FEATUREBENCH_CODEX_BIN_HOST_PATH: join(prepared.toolchain.directory, 'codex'),
    FEATUREBENCH_CREDENTIAL_BROKER_URL: runtime.brokerUrl,
    FEATUREBENCH_RESTRICTED_NETWORK: runtime.restrictedNetwork,
    ULTRACODE_BENCHMARK_SCHEMA: '2',
    ULTRACODE_BENCHMARK_SUITE: 'featurebench',
    ULTRACODE_BENCHMARK_RUN: manifest.runId,
    ULTRACODE_BENCHMARK_ARM: manifest.experiment.arm,
    ULTRACODE_BENCHMARK_OWNERSHIP: '1',
  });
  if (manifest.experiment.arm === 'b') env.FEATUREBENCH_TOOLCHAIN_HOST_PATH = prepared.toolchain.directory;
  return env;
}

async function initializeRun(
  roots: BenchPathRoots,
  manifest: FeatureBenchManifest,
  recoverStale: boolean,
  claim: BenchLockHandle,
): Promise<{ lease: BenchLockHandle; state: BenchRunStateStore; receipt: VerifierReceiptStore }> {
  const directory = createPrivateRunDirectory(roots, 'featurebench', manifest.runId);
  let lease: BenchLockHandle | null = null;
  try {
    markClaimedRunDirectory(directory, claim);
    lease = await acquireBenchLock(roots.resultsRoot, runLeaseFile(roots, 'featurebench', manifest.runId), {
      recoverStale,
      createParent: false,
    });
    writeBenchRunManifest(roots, manifest);
    const manifestSha256 = sha256File(manifestFile(roots, 'featurebench', manifest.runId));
    const state = new BenchRunStateStore(roots, 'featurebench', manifest.runId, manifestSha256, lease);
    const receipt = new VerifierReceiptStore(roots, 'featurebench', manifest.runId, manifestSha256, lease);
    state.initialize();
    receipt.initialize();
    ensurePrivateDirectoryWithin(directory, nativeDir(roots, 'featurebench', manifest.runId));
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
  policyLock: BenchLockHandle,
): Promise<{ manifest: FeatureBenchManifest; lease: BenchLockHandle; state: BenchRunStateStore; receipt: VerifierReceiptStore }> {
  if (policyLock.path !== featureBenchPolicyLockFile(roots)) {
    throw new Error('FeatureBench recovery requires the exact restricted-network policy lock');
  }
  policyLock.assertHeld();
  const lease = await acquireBenchLock(roots.resultsRoot, runLeaseFile(roots, 'featurebench', runId), {
    recoverStale,
    createParent: false,
  });
  try {
    const manifest = loadBenchRunManifest(roots, 'featurebench', runId) as FeatureBenchManifest;
    const manifestSha256 = sha256File(manifestFile(roots, 'featurebench', runId));
    const state = new BenchRunStateStore(roots, 'featurebench', runId, manifestSha256, lease);
    state.migrateLegacyIfNeeded();
    await state.recoverPendingLifecycleProcesses(runDir(roots, 'featurebench', runId));
    if (state.load().invocations.some((invocation) => invocation.endedAt === null)) {
      await cleanupFeatureBenchContainers(
        manifest.runId,
        manifest.experiment.arm as Arm,
        manifest.experiment.taskIds,
      );
      cleanupFeatureBenchRuntimeHomes(manifest.runId, manifest.experiment.arm as Arm);
      await state.closeInterruptedInvocations();
    }
    return {
      manifest,
      lease,
      state,
      receipt: new VerifierReceiptStore(roots, 'featurebench', runId, manifestSha256, lease),
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

function timestampDirectories(directory: string): Set<string> {
  return new Set(readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && TIMESTAMP_RE.test(entry.name))
    .map((entry) => entry.name));
}

function locateTimestamp(directory: string, before: ReadonlySet<string>): string {
  const candidates = readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && TIMESTAMP_RE.test(entry.name) && !before.has(entry.name));
  if (candidates.length !== 1) throw new Error(`expected one new FeatureBench timestamped run, found ${candidates.length}`);
  return validateRelativeArtifactPath(`native/${candidates[0]!.name}`);
}

/** Resolve the first state-bound inference root while rejecting native roots absent from state. */
export function resolveFeatureBenchResumeRoot(
  outputDirectory: string,
  state: Pick<BenchRunState, 'attempts'>,
  requireBaseline: boolean,
): string | null {
  const boundRoots = state.attempts
    .filter((attempt) => attempt.phase === 'inference' && attempt.nativePath !== null)
    .map((attempt) => attempt.nativePath!);
  for (const root of boundRoots) {
    const timestamp = root.startsWith('native/') ? root.slice('native/'.length) : '';
    if (!TIMESTAMP_RE.test(timestamp)) {
      throw new Error(`FeatureBench state contains a non-timestamp inference root: ${root}`);
    }
  }
  const bound = new Set<string>(boundRoots);
  const unbound = [...timestampDirectories(outputDirectory)]
    .map((timestamp) => `native/${timestamp}`)
    .filter((root) => !bound.has(root));
  if (unbound.length > 0) {
    throw new Error(`FeatureBench resume contains unbound timestamped native state: ${unbound.join(', ')}`);
  }
  const originalRoot = boundRoots[0] ?? null;
  if (requireBaseline && originalRoot === null) {
    throw new Error('FeatureBench redo requires a state-bound prior inference with a native root');
  }
  return originalRoot;
}

function predictionTaskId(value: unknown): string | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && typeof (value as Record<string, unknown>).instance_id === 'string'
    ? (value as Record<string, string>).instance_id ?? null
    : null;
}

function currentInferencePredictions(
  directory: string,
  currentRoot: string,
  requiredTaskIds: ReadonlySet<string>,
): Map<string, unknown> {
  const path = `${currentRoot}/output.jsonl`;
  if (!existsSync(join(directory, ...path.split('/')))) {
    throw new Error(`FeatureBench current inference output is missing: ${path}`);
  }
  const predictions = new Map<string, unknown>();
  const raw = readRegularFileWithinRoot(directory, path).toString('utf8');
  const lines = raw.split(/\r?\n/u);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (!line) continue;
    let value: unknown;
    try { value = JSON.parse(line) as unknown; } catch {
      throw new Error(`FeatureBench current inference output is malformed at line ${index + 1}: ${path}`);
    }
    const taskId = predictionTaskId(value);
    if (taskId === null || typeof (value as Record<string, unknown>).model_patch !== 'string') {
      throw new Error(`FeatureBench current inference output is malformed at line ${index + 1}: ${path}`);
    }
    if (!requiredTaskIds.has(taskId)) {
      throw new Error(`FeatureBench current inference output has wrong task id at line ${index + 1}: ${taskId}`);
    }
    if (predictions.has(taskId)) {
      throw new Error(`FeatureBench current inference output has duplicate task id: ${taskId}`);
    }
    predictions.set(taskId, value);
  }
  const missing = [...requiredTaskIds].filter((taskId) => !predictions.has(taskId));
  if (missing.length > 0) {
    throw new Error(`FeatureBench current inference output is partial; missing ${missing.join(', ')}`);
  }
  return predictions;
}

function consolidatedPredictionsPath(nativeRoot: string, invocationId: string): string {
  const components = nativeRoot.split('/');
  if (components.length !== 2 || components[0] !== 'native' || !TIMESTAMP_RE.test(components[1]!)) {
    throw new Error(`FeatureBench prediction input root is not an exact timestamped directory: ${nativeRoot}`);
  }
  return validateRelativeArtifactPath(`${nativeRoot}/consolidated-output-${invocationId}.jsonl`);
}

function successfulFeatureBenchVerifierRoot(
  state: BenchRunState,
  invocationId: string,
  taskIds: readonly string[],
): string | null {
  const taskMembership = new Set(taskIds);
  const attempts = state.attempts.filter((attempt) =>
    attempt.invocationId === invocationId && attempt.phase === 'verifier');
  if (attempts.length !== taskMembership.size
    || attempts.some((attempt) => !taskMembership.has(attempt.taskId)
      || attempt.status !== 'succeeded'
      || attempt.failures.length > 0
      || attempt.nativePath === null)
    || new Set(attempts.map((attempt) => attempt.taskId)).size !== taskMembership.size) return null;
  const roots = new Set(attempts.map((attempt) => attempt.nativePath!));
  if (roots.size !== 1) return null;
  const root = [...roots][0]!;
  const components = root.split('/');
  return components.length === 2 && components[0] === 'native' && TIMESTAMP_RE.test(components[1]!)
    ? root
    : null;
}

/** Assemble verifier input while requiring redone tasks to come from the current root. */
export function consolidateFeatureBenchPredictions(
  directory: string,
  state: BenchRunState,
  bindings: readonly VerifierBinding[],
  currentRoot: string,
  invocationId: string,
  taskIds: readonly string[],
  redoTaskIds: ReadonlySet<string> = new Set(),
): string {
  const taskMembership = new Set(taskIds);
  const invalidRedo = [...redoTaskIds].filter((taskId) => !taskMembership.has(taskId));
  if (invalidRedo.length > 0) {
    throw new Error(`FeatureBench redo target is outside the immutable task set: ${invalidRedo.join(', ')}`);
  }
  const latest = new Map<string, unknown>();
  for (const invocation of state.invocations) {
    const acceptedRoot = successfulFeatureBenchVerifierRoot(
      state,
      invocation.invocationId,
      taskIds,
    );
    if (acceptedRoot === null) continue;
    const acceptedPath = consolidatedPredictionsPath(acceptedRoot, invocation.invocationId);
    const marker = bindings.find((binding) => binding.invocationId === invocation.invocationId
      && binding.role === 'completion-marker'
      && binding.scope.kind === 'suite-check'
      && binding.scope.name === 'featurebench-accepted-predictions'
      && binding.path === acceptedPath
      && binding.nativeRecordKey === 'accepted-predictions-jsonl');
    const input = bindings.find((binding) => binding.invocationId === invocation.invocationId
      && binding.role === 'verifier-input'
      && binding.path === acceptedPath
      && binding.nativeRecordKey === 'predictions-jsonl'
      && marker !== undefined
      && binding.path === marker.path
      && binding.sha256 === marker.sha256);
    const invocationBinding = bindings.find((binding) => binding.invocationId === invocation.invocationId
      && binding.role === 'verifier-invocation'
      && binding.path === `native/invocations/${invocation.invocationId}/fb-eval.json`
      && binding.nativeRecordKey === 'fb-eval-v2');
    if (input === undefined || invocationBinding === undefined) continue;
    const path = input.path;
    const bytes = readRegularFileWithinRoot(directory, path);
    if (sha256Buffer(bytes) !== input.sha256) {
      throw new Error(`accepted FeatureBench verifier input changed after receipt binding: ${path}`);
    }
    const invocationBytes = readRegularFileWithinRoot(directory, invocationBinding.path);
    if (sha256Buffer(invocationBytes) !== invocationBinding.sha256) {
      throw new Error(`accepted FeatureBench verifier invocation changed after receipt binding: ${invocationBinding.path}`);
    }
    const raw = bytes.toString('utf8');
    const snapshot = new Map<string, unknown>();
    for (const line of raw.split(/\r?\n/u)) {
      if (!line) continue;
      let value: unknown;
      try { value = JSON.parse(line) as unknown; } catch {
        throw new Error(`accepted FeatureBench verifier input is malformed: ${path}`);
      }
      const taskId = predictionTaskId(value);
      if (taskId === null || !taskMembership.has(taskId) || snapshot.has(taskId)) {
        throw new Error(`accepted FeatureBench verifier input has invalid task membership: ${path}`);
      }
      snapshot.set(taskId, value);
    }
    if (taskIds.some((taskId) => !snapshot.has(taskId))) {
      throw new Error(`accepted FeatureBench verifier input is partial: ${path}`);
    }
    for (const [taskId, prediction] of snapshot) latest.set(taskId, prediction);
  }
  if (redoTaskIds.size > 0 || latest.size === 0) {
    const requiredCurrentTasks = redoTaskIds.size > 0 ? redoTaskIds : taskMembership;
    const currentPredictions = currentInferencePredictions(directory, currentRoot, requiredCurrentTasks);
    for (const [taskId, prediction] of currentPredictions) latest.set(taskId, prediction);
  }
  const missing = taskIds.filter((taskId) => !latest.has(taskId));
  if (missing.length > 0) throw new Error(`cannot build complete FeatureBench verifier input; missing ${missing.join(', ')}`);
  const path = consolidatedPredictionsPath(currentRoot, invocationId);
  writePrivateFileAtomic(directory, join(directory, ...path.split('/')),
    `${taskIds.map((taskId) => JSON.stringify(latest.get(taskId))).join('\n')}\n`);
  return path;
}

/** Project one physical FeatureBench batch process onto its task-scoped attempts. */
export async function recordFeatureBenchBatchAttempts(
  state: BenchRunStateStore,
  invocationId: string,
  taskIds: readonly string[],
  arm: Arm,
  phase: 'inference' | 'verifier',
  startedAt: Date,
  endedAt: Date,
  elapsedMs: number,
  nativePath: string | null,
  failure: FailureCode | null,
): Promise<void> {
  const timingGroupId = randomUUID();
  await state.updateCurrent((current) => ({
    ...current,
    attempts: [...current.attempts, ...taskIds.map((taskId) => ({
      attemptId: randomUUID(),
      invocationId,
      timingGroupId,
      taskId,
      arm,
      ordinal: current.attempts.filter((attempt) => attempt.taskId === taskId && attempt.arm === arm && attempt.phase === phase).length + 1,
      phase,
      startedAt: startedAt.toISOString(),
      endedAt: endedAt.toISOString(),
      elapsedMs,
      nativePath: nativePath === null ? null : validateRelativeArtifactPath(nativePath),
      exitCode: failure === null ? 0 : 1,
      signal: null,
      status: failure === null ? 'succeeded' as const : 'failed' as const,
      failures: failure === null ? [] : [failure],
      annotations: [],
    }))],
  }));
}

async function updateReceipt(
  store: VerifierReceiptStore,
  additions: readonly VerifierBinding[],
): Promise<void> {
  const identity = (binding: VerifierBinding): string => canonicalJson({
    invocationId: binding.invocationId,
    role: binding.role,
    scope: binding.scope,
    nativeRecordKey: binding.nativeRecordKey,
  });
  const additionIdentities = new Set(additions.map(identity));
  const additionPathHashes = new Map(additions.map((binding) => [binding.path, binding.sha256]));
  const taskScopes = new Set(additions.flatMap((binding) => binding.scope.kind === 'task-arm'
    && binding.role === 'task-report' ? [`${binding.scope.taskId}\0${binding.scope.arm}`] : []));
  const hasAggregate = additions.some((binding) => binding.role === 'aggregate-report');
  const current = store.load();
  await store.update(current.revision, (bindings) => [
    ...bindings.filter((binding) => {
      if (additionIdentities.has(identity(binding))) return false;
      const replacementHash = additionPathHashes.get(binding.path);
      if (replacementHash !== undefined && replacementHash !== binding.sha256) return false;
      if (binding.scope.kind === 'task-arm'
        && taskScopes.has(`${binding.scope.taskId}\0${binding.scope.arm}`)) return false;
      if (hasAggregate && binding.role === 'aggregate-report') return false;
      return true;
    }),
    ...additions,
  ]);
}

async function replaceReceiptBindings(
  store: VerifierReceiptStore,
  bindings: readonly VerifierBinding[],
): Promise<void> {
  const current = store.load();
  await store.update(current.revision, () => bindings);
}

async function invalidateEvaluationReceipt(
  store: VerifierReceiptStore,
  manifest: FeatureBenchManifest,
): Promise<void> {
  const tasks = new Set(manifest.experiment.taskIds);
  const current = store.load();
  await store.update(current.revision, (bindings) => bindings.filter((binding) => {
    if (binding.scope.kind === 'task-arm' && binding.scope.arm === manifest.experiment.arm
      && tasks.has(binding.scope.taskId)) return false;
    return binding.role !== 'aggregate-report';
  }));
}

interface FeatureBenchEvaluationMove {
  source: string;
  destination: string;
}

function archiveFeatureBenchEvaluationMoves(
  directory: string,
  nativeRoot: string,
  taskIds: readonly string[],
  invocationId: string,
): readonly FeatureBenchEvaluationMove[] {
  const paths = [
    `${nativeRoot}/report.json`,
    ...taskIds.map((taskId) => `${nativeRoot}/eval_outputs/${taskId}/attempt-1/report.json`),
  ];
  const moves: FeatureBenchEvaluationMove[] = [];
  for (const path of paths) {
    const candidate = join(directory, ...path.split('/'));
    try { lstatSync(candidate); } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') continue;
      throw error;
    }
    const source = resolveRegularFileWithinRoot(directory, path, 'prior FeatureBench evaluation');
    const suffix = path.slice(`${nativeRoot}/`.length);
    const destination = join(directory, 'native', 'invocations', invocationId, 'prior-eval', ...suffix.split('/'));
    ensurePrivateDirectoryWithin(directory, dirname(destination));
    try {
      lstatSync(destination);
      throw new Error(`FeatureBench evaluation archive target already exists: ${destination}`);
    } catch (error) {
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error;
    }
    moves.push({ source, destination });
  }
  const completed: Array<{ source: string; destination: string }> = [];
  try {
    for (const move of moves) {
      renameSync(move.source, move.destination);
      completed.push(move);
    }
  } catch (error) {
    for (const move of completed.reverse()) renameSync(move.destination, move.source);
    throw error;
  }
  return moves;
}

/** Preserve prior native verifier bytes while clearing fixed paths before rerun. */
export function archiveFeatureBenchEvaluation(
  directory: string,
  nativeRoot: string,
  taskIds: readonly string[],
  invocationId: string,
): void {
  archiveFeatureBenchEvaluationMoves(directory, nativeRoot, taskIds, invocationId);
}

function restoreFeatureBenchEvaluationArchive(
  directory: string,
  moves: readonly FeatureBenchEvaluationMove[],
): void {
  const restores = [...moves].reverse().map((move) => {
    const destinationPath = relative(directory, move.destination).split(sep).join('/');
    const destination = resolveRegularFileWithinRoot(
      directory,
      validateRelativeArtifactPath(destinationPath),
      'pre-launch FeatureBench evaluation archive',
    );
    try {
      lstatSync(move.source);
      throw new Error(`FeatureBench evaluation restore target already exists: ${move.source}`);
    } catch (error) {
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error;
    }
    return { source: move.source, destination };
  });
  const completed: typeof restores = [];
  try {
    for (const restore of restores) {
      renameSync(restore.destination, restore.source);
      completed.push(restore);
    }
  } catch (error) {
    for (const restore of completed.reverse()) renameSync(restore.source, restore.destination);
    throw error;
  }
}

function acceptedPredictionsBinding(
  input: VerifierBinding,
): VerifierBinding {
  return {
    ...input,
    scope: { kind: 'suite-check', name: 'featurebench-accepted-predictions' },
    role: 'completion-marker',
    nativeRecordKey: 'accepted-predictions-jsonl',
  };
}

function verifierInvocationBinding(
  directory: string,
  invocationId: string,
  manifest: FeatureBenchManifest,
  predictions: string,
): VerifierBinding {
  const root = `native/invocations/${invocationId}`;
  ensurePrivateDirectoryWithin(directory, join(directory, ...root.split('/')));
  const path = `${root}/fb-eval.json`;
  writePrivateJsonAtomic(directory, join(directory, ...path.split('/')), {
    schemaVersion: 2,
    runner: 'fb',
    command: 'eval',
    dataset: FEATUREBENCH_DATASET,
    datasetRevision: FEATUREBENCH_DATASET_REVISION,
    split: FEATUREBENCH_SPLIT,
    predictions,
    taskIds: manifest.experiment.taskIds,
    concurrency: manifest.suiteConfig.evaluation.concurrency,
  });
  return createVerifierBinding(directory, {
    invocationId,
    scope: { kind: 'suite-check', name: `featurebench-eval-invocation-${manifest.experiment.arm}` },
    role: 'verifier-invocation',
    path: validateRelativeArtifactPath(path),
    nativeRecordKey: 'fb-eval-v2',
  }, sha256File(join(directory, ...path.split('/'))));
}

function classifyProcessFailure(error: unknown, phase: 'inference' | 'verifier'): FailureCode {
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof BenchProcessError && /timed out/u.test(message)) return phase === 'verifier' ? 'verifier-timeout' : 'driver-watchdog';
  if (error instanceof BenchProcessError && /descendant cleanup failed/u.test(message)) return 'descendant-cleanup-failed';
  if (/auth|credential|unauthorized|forbidden/iu.test(message)) return 'auth-failed';
  if (/ownership|unowned|ambiguous ownership/iu.test(message)) return 'ownership-unsafe';
  if (/restricted.*network|network.*policy|exactly the named credential broker/iu.test(message)) return 'network-policy-failed';
  if (/broker/iu.test(message)) return 'broker-failed';
  if (/provenance|drifted/iu.test(message)) return 'provenance-drift';
  if (/image identity/iu.test(message)) return 'image-identity-drift';
  if (/artifact|symlink|multiply-linked/iu.test(message)) return 'artifact-unsafe';
  if (/toolchain/iu.test(message)) return 'toolchain-incompatible';
  return phase === 'verifier' ? 'verifier-process-failed' : 'native-runner-failed';
}

/** Reject every failed inference before verifier preparation mutates evidence. */
export function assertFeatureBenchInferenceReady(
  nativeRoot: string | null,
  inferenceFailure: FailureCode | null,
): asserts nativeRoot is string {
  if (nativeRoot === null) throw new Error('FeatureBench inference produced no timestamped native directory');
  if (inferenceFailure !== null) throw new Error(`FeatureBench inference failed: ${inferenceFailure}`);
}

/** A lifecycle callback proves evaluator launch only when spawn assigned a child PID. */
export function featureBenchEvaluatorLaunched(pid: number | null): pid is number {
  return pid !== null;
}

async function executeNativeRun(
  context: CommandContext,
  config: FeatureBenchConfig,
  runtime: FeatureBenchRuntimeBindings,
  manifest: FeatureBenchManifest,
  prepared: PreparedFeatureBenchInputs,
  stores: { state: BenchRunStateStore; receipt: VerifierReceiptStore },
  invocationId: string,
  redo: ReadonlySet<string>,
  originalRoot: string | null,
  executor: FeatureBenchExecutor = nativeExecute,
): Promise<void> {
  if (redo.size > 0 && originalRoot === null) {
    throw new Error('FeatureBench redo requires a state-bound prior inference with a native root');
  }
  const arm = manifest.experiment.arm as Arm;
  await cleanupFeatureBenchContainers(manifest.runId, arm, manifest.experiment.taskIds, executor);
  cleanupFeatureBenchRuntimeHomes(manifest.runId, arm);
  const runtimeBindingHome = createFeatureBenchRuntimeHome(manifest.runId, arm);
  const runtimeHome = runtimeBindingHome.directory;
  const activeKey = runtimeHome;
  let failure: unknown;
  try {
    trackFeatureBenchExecution(activeKey, {
      runId: manifest.runId,
      arm,
      taskIds: manifest.experiment.taskIds,
      executor,
      cleanupRuntime() {
        if (!existsSync(runtimeHome)) return;
        assertFeatureBenchRuntimeDirectory(runtimeHome, manifest.runId, arm, runtimeBindingHome.nonce);
        rmSync(runtimeHome, { recursive: true });
      },
    });
    await executeNativeRunWithHome(
      context,
      config,
      runtime,
      manifest,
      prepared,
      stores,
      invocationId,
      redo,
      originalRoot,
      runtimeHome,
      executor,
    );
  } catch (error) {
    failure = error;
  } finally {
    try {
      await cleanupTrackedFeatureBenchExecution(activeKey);
    } catch (error) {
      failure ??= new Error('FeatureBench final resource cleanup failed', { cause: error });
    }
  }
  if (failure !== undefined) throw failure;
}

async function executeNativeRunWithHome(
  context: CommandContext,
  config: FeatureBenchConfig,
  runtime: FeatureBenchRuntimeBindings,
  manifest: FeatureBenchManifest,
  prepared: PreparedFeatureBenchInputs,
  stores: { state: BenchRunStateStore; receipt: VerifierReceiptStore },
  invocationId: string,
  redo: ReadonlySet<string>,
  originalRoot: string | null,
  runtimeHome: string,
  executor: FeatureBenchExecutor,
): Promise<void> {
  const directory = runDir(context.paths, 'featurebench', manifest.runId);
  const outputDirectory = nativeDir(context.paths, 'featurebench', manifest.runId);
  const configPath = join(runtimeHome, 'config.toml');
  const inferTasks = redo.size > 0 ? manifest.experiment.taskIds.filter((taskId) => redo.has(taskId)) : manifest.experiment.taskIds;
  const plan = planFeatureBenchRun(prepared, manifest, runtime, outputDirectory, configPath, inferTasks);
  writePrivateFileAtomic(runtimeHome, configPath, plan.config);
  if ((statSync(configPath).mode & 0o777) !== 0o600) throw new Error('FeatureBench runtime config is not private');
  let nativeRoot: string | null = null;
  let inferenceFailure: FailureCode | null = null;
  const inferenceStarted = context.clock.now();
  const inferenceMs = performance.now();
  const before = timestampDirectories(outputDirectory);
  const lifecycle = stores.state.lifecycleHooks(invocationId);
  try {
    let infer = plan.infer;
    if (redo.size === 0 && originalRoot !== null) {
      nativeRoot = originalRoot;
      const metadataPath = `${nativeRoot}/run_metadata.json`;
      validateFeatureBenchRunMetadata(
        JSON.parse(readRegularFileWithinRoot(directory, metadataPath).toString('utf8')) as unknown,
        manifest.experiment.taskIds,
      );
      infer = planFeatureBenchResume(prepared, manifest, join(directory, ...nativeRoot.split('/')), configPath);
    }
    const attestation = await attestRuntime(context.paths, manifest.runId, config, runtime, prepared, executor);
    assertProvenance(context.paths, manifest, prepared, attestation);
    await executor(infer.command, infer.argv, {
      cwd: infer.cwd,
      env: childEnvironment(prepared, manifest, runtime, runtimeHome),
      stream: true,
      timeoutMs: manifest.suiteConfig.inference.timeoutMs,
      workerScope: directory,
      ...lifecycle,
    });
    nativeRoot ??= locateTimestamp(outputDirectory, before);
  } catch (error) {
    inferenceFailure = classifyProcessFailure(error, 'inference');
    if (nativeRoot === null) {
      const candidates = [...timestampDirectories(outputDirectory)].filter((entry) => !before.has(entry));
      if (candidates.length === 1) nativeRoot = validateRelativeArtifactPath(`native/${candidates[0]!}`);
    }
  }
  if (nativeRoot !== null) {
    try { reclaimAndAssertArtifactTree(join(directory, ...nativeRoot.split('/'))); }
    catch { inferenceFailure = 'artifact-unsafe'; }
  }
  const inferenceEnded = context.clock.now();
  await recordFeatureBenchBatchAttempts(
    stores.state,
    invocationId,
    inferTasks,
    manifest.experiment.arm as Arm,
    'inference',
    inferenceStarted,
    inferenceEnded,
    Math.max(0, performance.now() - inferenceMs),
    nativeRoot,
    inferenceFailure,
  );

  let verifierFailure: FailureCode | null = inferenceFailure === null ? null : 'verifier-output-missing';
  let evaluatorStarted = false;
  let receiptBeforeEvaluation: readonly VerifierBinding[] | null = null;
  let evaluationArchive: readonly FeatureBenchEvaluationMove[] = [];
  const verifierStarted = context.clock.now();
  const verifierMs = performance.now();
  try {
    assertFeatureBenchInferenceReady(nativeRoot, inferenceFailure);
    const predictions = consolidateFeatureBenchPredictions(
      directory,
      stores.state.load(),
      stores.receipt.load().bindings,
      nativeRoot,
      invocationId,
      manifest.experiment.taskIds,
      redo,
    );
    const evalPlan = planFeatureBenchEval(prepared, manifest, join(directory, ...predictions.split('/')), configPath);
    const attestation = await attestRuntime(context.paths, manifest.runId, config, runtime, prepared, executor);
    assertProvenance(context.paths, manifest, prepared, attestation);
    receiptBeforeEvaluation = stores.receipt.load().bindings;
    const inputBinding = createVerifierBinding(directory, {
      invocationId,
      scope: { kind: 'suite-check', name: `featurebench-eval-input-${manifest.experiment.arm}` },
      role: 'verifier-input',
      path: validateRelativeArtifactPath(predictions),
      nativeRecordKey: 'predictions-jsonl',
    }, sha256File(join(directory, ...predictions.split('/'))));
    await updateReceipt(stores.receipt, [
      inputBinding,
      verifierInvocationBinding(directory, invocationId, manifest, predictions),
    ]);
    evaluationArchive = archiveFeatureBenchEvaluationMoves(
      directory,
      nativeRoot,
      manifest.experiment.taskIds,
      invocationId,
    );
    await invalidateEvaluationReceipt(stores.receipt, manifest);
    const evaluationLifecycle = {
      ...lifecycle,
      onLifecycleStarted(token: string, pid: number | null, processStartIdentity: string | null): void {
        if (featureBenchEvaluatorLaunched(pid)) evaluatorStarted = true;
        lifecycle.onLifecycleStarted(token, pid, processStartIdentity);
      },
    };
    await executor(evalPlan.command, evalPlan.argv, {
      cwd: evalPlan.cwd,
      env: childEnvironment(prepared, manifest, runtime, runtimeHome),
      stream: true,
      timeoutMs: manifest.suiteConfig.evaluation.timeoutMs,
      workerScope: directory,
      ...evaluationLifecycle,
    });
    evaluatorStarted = true;
    reclaimAndAssertArtifactTree(join(directory, ...nativeRoot.split('/')));
    verifierFailure = null;
    const evidence = indexFeatureBenchEvidence(
      directory,
      nativeRoot,
      manifest.experiment.taskIds,
      manifest.experiment.arm as Arm,
      invocationId,
      inferTasks,
    );
    await updateReceipt(stores.receipt, evidence.bindings);
    if (evidence.aggregate === null) {
      verifierFailure = 'verifier-output-malformed';
    } else {
      await updateReceipt(stores.receipt, [acceptedPredictionsBinding(inputBinding)]);
    }
  } catch (error) {
    let failure = error;
    if (!evaluatorStarted && receiptBeforeEvaluation !== null) {
      try {
        restoreFeatureBenchEvaluationArchive(directory, evaluationArchive);
        await replaceReceiptBindings(stores.receipt, receiptBeforeEvaluation);
      } catch (rollbackError) {
        failure = new AggregateError(
          [error, rollbackError],
          'FeatureBench pre-launch evaluation rollback failed',
        );
      }
    }
    verifierFailure = classifyProcessFailure(failure, 'verifier');
  } finally {
    try {
      if (nativeRoot !== null && evaluatorStarted) {
        const evidence = indexFeatureBenchEvidence(
          directory,
          nativeRoot,
          manifest.experiment.taskIds,
          manifest.experiment.arm as Arm,
          invocationId,
          inferTasks,
        );
        await updateReceipt(stores.receipt, evidence.bindings);
      }
    } catch { verifierFailure ??= 'verifier-output-malformed'; }
    try { await cleanupFeatureBenchContainers(manifest.runId, manifest.experiment.arm as Arm, manifest.experiment.taskIds, executor); }
    catch { verifierFailure = 'ownership-unsafe'; }
    if (evaluatorStarted) {
      const verifierEnded = context.clock.now();
      await recordFeatureBenchBatchAttempts(
        stores.state,
        invocationId,
        manifest.experiment.taskIds,
        manifest.experiment.arm as Arm,
        'verifier',
        verifierStarted,
        verifierEnded,
        Math.max(0, performance.now() - verifierMs),
        nativeRoot,
        verifierFailure,
      );
    }
  }
  if (inferenceFailure !== null) throw new Error(`FeatureBench inference failed: ${inferenceFailure}`);
  if (verifierFailure !== null) throw new Error(`FeatureBench verifier failed: ${verifierFailure}`);
}

function redoTargets(values: readonly string[], manifest: FeatureBenchManifest): Set<string> {
  const allowed = new Set(manifest.experiment.taskIds);
  const targets = new Set<string>();
  for (const value of values) {
    validateFeatureBenchTaskId(value);
    if (!allowed.has(value)) throw new Error(`redo target is not in the immutable manifest: ${value}`);
    targets.add(value);
  }
  return targets;
}

export async function invalidateFeatureBenchRedo(
  roots: BenchPathRoots,
  manifest: FeatureBenchManifest,
  targets: ReadonlySet<string>,
  originalRoot: string | null,
  receipt: VerifierReceiptStore,
  state: BenchRunStateStore,
  invocationId: string,
  now: Date,
): Promise<void> {
  if (targets.size === 0) return;
  if (originalRoot === null) {
    throw new Error('FeatureBench redo requires a state-bound prior inference with a native root');
  }
  const current = receipt.load();
  await receipt.update(current.revision, (bindings) => bindings.filter((binding) => {
    if (binding.scope.kind === 'task-arm' && binding.scope.arm === manifest.experiment.arm
      && targets.has(binding.scope.taskId)) return false;
    return binding.role !== 'aggregate-report';
  }));
  rmSync(reportJsonFile(roots, 'featurebench', manifest.runId), { force: true });
  rmSync(reportMarkdownFile(roots, 'featurebench', manifest.runId), { force: true });
  const timestamp = now.toISOString();
  await state.updateCurrent((currentState) => ({
    ...currentState,
    attempts: [...currentState.attempts, ...[...targets].map((taskId) => ({
      attemptId: randomUUID(),
      invocationId,
      taskId,
      arm: manifest.experiment.arm as Arm,
      ordinal: currentState.attempts.filter((attempt) => attempt.taskId === taskId
        && attempt.arm === manifest.experiment.arm && attempt.phase === 'cleanup').length + 1,
      phase: 'cleanup' as const,
      startedAt: timestamp,
      endedAt: timestamp,
      elapsedMs: 0,
      nativePath: null,
      exitCode: 0,
      signal: null,
      status: 'succeeded' as const,
      failures: [],
      annotations: ['redo-invalidated'],
    }))],
  }));
}

export async function prepCommand(options: PrepOptions, context: CommandContext): Promise<void> {
  const locks = await acquireInputLocks(context.paths, options.recoverStaleLock);
  try {
    const operator = loadFeatureBenchOperatorConfig(context.paths);
    const prepared = await prepareFeatureBenchInputs(context.paths, operator.toolchain);
    output(context, `prepared FeatureBench ${prepared.source.revision} with Python ${prepared.pythonVersion}`);
  } finally {
    releaseLocks(locks);
  }
}

export async function runCommand(options: RunOptions, context: CommandContext): Promise<void> {
  validateRunId(options.runId);
  if (options.redo.length > 0 && !options.resume) throw new Error('--redo requires --resume');
  const operator = loadFeatureBenchOperatorConfig(context.paths);
  const runtime = loadFeatureBenchRuntimeBindings();
  if (options.resume) {
    let locks: BenchLockHandle[] = [];
    let policyLock: BenchLockHandle | null = null;
    let stores: Awaited<ReturnType<typeof loadRunStores>> | null = null;
    let invocationId: string | null = null;
    const startedMs = performance.now();
    try {
      policyLock = await acquireBenchLock(context.paths.cacheRoot, featureBenchPolicyLockFile(context.paths), {
        recoverStale: options.recoverStaleLock,
      });
      stores = await loadRunStores(
        context.paths,
        options.runId,
        options.recoverStaleLock,
        policyLock,
      );
      assertResumeOptions(options, stores.manifest);
      const targets = redoTargets(options.redo, stores.manifest);
      const originalRoot = resolveFeatureBenchResumeRoot(
        nativeDir(context.paths, 'featurebench', options.runId),
        stores.state.load(),
        targets.size > 0,
      );
      const config = resumeConfig(operator.featureBench, stores.manifest);
      locks = await acquireInputLocks(context.paths, options.recoverStaleLock);
      const prepared = loadPreparedFeatureBenchInputs(featureBenchPreparedDir(
        context.paths,
        stores.manifest.suiteConfig.preparedInputSha256,
      ));
      const attestation = await attestRuntime(context.paths, options.runId, config, runtime, prepared);
      assertProvenance(context.paths, stores.manifest, prepared, attestation);
      invocationId = await beginInvocation(stores.state, 'run', context.clock.now());
      await invalidateFeatureBenchRedo(
        context.paths,
        stores.manifest,
        targets,
        originalRoot,
        stores.receipt,
        stores.state,
        invocationId,
        context.clock.now(),
      );
      await executeNativeRun(
        context,
        config,
        runtime,
        stores.manifest,
        prepared,
        stores,
        invocationId,
        targets,
        originalRoot,
      );
      await finishInvocation(stores.state, invocationId, startedMs, context.clock.now());
    } catch (error) {
      if (invocationId !== null && stores !== null) {
        await finishInvocation(stores.state, invocationId, startedMs, context.clock.now(), 'unknown-terminal');
      }
      throw error;
    } finally {
      try { releaseLocks(locks); } finally {
        try { stores?.lease.release(); } finally { policyLock?.release(); }
      }
    }
    return;
  }

  const claim = await acquireBenchLock(
    context.paths.resultsRoot,
    runClaimFile(context.paths, 'featurebench', options.runId),
    { recoverStale: options.recoverStaleLock },
  );
  let locks: BenchLockHandle[] = [];
  let policyLock: BenchLockHandle | null = null;
  let stores: Awaited<ReturnType<typeof initializeRun>> | null = null;
  try {
    const directory = runDir(context.paths, 'featurebench', options.runId);
    if (existsSync(directory)) {
      if (existsSync(join(directory, 'manifest.json'))) {
        throw new Error(`run ${options.runId} already exists; use --resume`);
      }
      assertRecoveredClaimOwnsRunDirectory(directory, claim);
      rmSync(directory, { recursive: true });
    }
    const config = overrideConfig(operator.featureBench, options);
    policyLock = await acquireBenchLock(context.paths.cacheRoot, featureBenchPolicyLockFile(context.paths), {
      recoverStale: options.recoverStaleLock,
    });
    locks = await acquireInputLocks(context.paths, options.recoverStaleLock);
    const prepared = loadCurrentPreparedFeatureBenchInputs(context.paths);
    const attestation = await attestRuntime(context.paths, options.runId, config, runtime, prepared);
    const manifest = buildManifest(context.paths, options.runId, config, prepared, attestation, context.clock.now());
    stores = await initializeRun(context.paths, manifest, options.recoverStaleLock, claim);
    claim.release();
    const startedMs = performance.now();
    const invocationId = await beginInvocation(stores.state, 'run', context.clock.now());
    try {
      await executeNativeRun(context, config, runtime, manifest, prepared, stores, invocationId, new Set(), null);
      await finishInvocation(stores.state, invocationId, startedMs, context.clock.now());
    } catch (error) {
      await finishInvocation(stores.state, invocationId, startedMs, context.clock.now(), 'unknown-terminal');
      throw error;
    }
  } finally {
    try { stores?.lease.release(); } finally {
      try { releaseLocks(locks); } finally {
        try { policyLock?.release(); } finally {
          try { claim.release(); } catch { /* released after immutable publication */ }
        }
      }
    }
  }
}

type FeatureBenchEvidenceIndexer = typeof indexFeatureBenchEvidence;

export interface FeatureBenchEvidenceResolver {
  taskResults: ReadonlyMap<string, NativeVerifierResult>;
  aggregate: FeatureBenchAggregate | null;
}

function artifactIdentity(artifact: { path: string; sha256: string; nativeRecordKey: string }): string {
  return `${artifact.path}\0${artifact.sha256}\0${artifact.nativeRecordKey}`;
}

function taskReportRoot(path: string, taskId: string): string | null {
  const suffix = `/eval_outputs/${taskId}/attempt-1/report.json`;
  if (!path.endsWith(suffix)) return null;
  const root = path.slice(0, -suffix.length);
  const components = root.split('/');
  return components.length === 2 && components[0] === 'native' && TIMESTAMP_RE.test(components[1]!)
    ? root
    : null;
}

function aggregateReportRoot(path: string): string | null {
  const suffix = '/report.json';
  if (!path.endsWith(suffix)) return null;
  const root = path.slice(0, -suffix.length);
  const components = root.split('/');
  return components.length === 2 && components[0] === 'native' && TIMESTAMP_RE.test(components[1]!)
    ? root
    : null;
}

function completeTaskReceiptRoot(
  bindings: readonly VerifierBinding[],
  invocationId: string,
  taskId: string,
  arm: Arm,
): string | null {
  const invocation = bindings.filter((binding) => binding.invocationId === invocationId);
  const taskReports = invocation.filter((binding) => binding.role === 'task-report'
    && binding.scope.kind === 'task-arm'
    && binding.scope.taskId === taskId
    && binding.scope.arm === arm
    && binding.nativeRecordKey === `${taskId}.pass_rate`);
  for (const taskReport of taskReports) {
    const root = taskReportRoot(taskReport.path, taskId);
    if (root === null) continue;
    const invocationRoot = `native/invocations/${invocationId}`;
    const predictionsPath = consolidatedPredictionsPath(root, invocationId);
    const complete = invocation.some((binding) => binding.role === 'completion-marker'
      && binding.scope.kind === 'task-arm'
      && binding.scope.taskId === taskId
      && binding.scope.arm === arm
      && binding.path === taskReport.path
      && binding.sha256 === taskReport.sha256
      && binding.nativeRecordKey === `${taskId}.featurebench_eval_completed`)
      && invocation.some((binding) => binding.role === 'verifier-input'
        && binding.scope.kind === 'suite-check'
        && binding.scope.name === `featurebench-eval-input-${arm}`
        && binding.path === predictionsPath
        && binding.nativeRecordKey === 'predictions-jsonl')
      && invocation.some((binding) => binding.role === 'verifier-invocation'
        && binding.scope.kind === 'suite-check'
        && binding.scope.name === `featurebench-eval-invocation-${arm}`
        && binding.path === `${invocationRoot}/fb-eval.json`
        && binding.nativeRecordKey === 'fb-eval-v2')
      && invocation.some((binding) => binding.role === 'run-metadata'
        && binding.scope.kind === 'suite-check'
        && binding.scope.name === `featurebench-run-metadata-${arm}`
        && binding.path === `${root}/run_metadata.json`
        && binding.nativeRecordKey === 'task_ids')
      && invocation.some((binding) => binding.role === 'rollout-output'
        && binding.scope.kind === 'suite-check'
        && binding.scope.name === `featurebench-predictions-${arm}`
        && binding.path === `${root}/output.jsonl`
        && binding.nativeRecordKey === 'output-jsonl');
    if (complete) return root;
  }
  return null;
}

/** Require accepted upstream and native evidence for one task, independent of the run aggregate. */
export function hasCompleteFeatureBenchTaskReceipt(
  bindings: readonly VerifierBinding[],
  invocationId: string,
  taskId: string,
  arm: Arm,
): boolean {
  return completeTaskReceiptRoot(bindings, invocationId, taskId, arm) !== null;
}

/** Index each latest-first verifier root once for one report assembly. */
export function createFeatureBenchEvidenceResolver(
  directory: string,
  manifest: FeatureBenchManifest,
  state: BenchRunState,
  bindings: readonly VerifierBinding[],
  indexEvidence: FeatureBenchEvidenceIndexer = indexFeatureBenchEvidence,
): FeatureBenchEvidenceResolver {
  const currentBindings = bindings.filter((binding) => {
    try {
      return sha256Buffer(readRegularFileWithinRoot(directory, binding.path)) === binding.sha256;
    } catch {
      return false;
    }
  });
  const roots = [...state.attempts].reverse()
    .filter((attempt) => attempt.phase === 'verifier' && attempt.nativePath !== null)
    .map((attempt) => attempt.nativePath!);
  const indexed = [...new Set(roots)].map((root) => indexEvidence(
    directory,
    root,
    manifest.experiment.taskIds,
    manifest.experiment.arm as Arm,
    randomUUID(),
  ));
  const isTaskBound = (
    taskId: string,
    result: NativeVerifierResult,
    invocationId?: string,
  ): boolean => {
    const artifact = result.artifact;
    if (result.verification !== 'verified' || artifact === null || artifact.nativeRecordKey === null) return false;
    const root = taskReportRoot(artifact.path, taskId);
    if (root === null) return false;
    return bindings.some((binding) => binding.role === 'task-report'
      && binding.scope.kind === 'task-arm'
      && binding.scope.taskId === taskId
      && binding.scope.arm === manifest.experiment.arm
      && (invocationId === undefined || binding.invocationId === invocationId)
      && binding.path === artifact.path
      && binding.sha256 === artifact.sha256
      && binding.nativeRecordKey === artifact.nativeRecordKey
      && completeTaskReceiptRoot(
        currentBindings,
        binding.invocationId,
        taskId,
        manifest.experiment.arm as Arm,
      ) === root);
  };
  const taskResults = new Map<string, NativeVerifierResult>();
  for (const taskId of manifest.experiment.taskIds) {
    let resolved = UNVERIFIED_NATIVE_RESULT;
    for (const evidence of indexed) {
      const result = evidence.taskResults.get(taskId) ?? UNVERIFIED_NATIVE_RESULT;
      if (!isTaskBound(taskId, result)) continue;
      resolved = result;
      break;
    }
    taskResults.set(taskId, resolved);
  }
  let aggregate: FeatureBenchAggregate | null = null;
  for (const evidence of indexed) {
    const candidate = evidence.aggregate;
    if (candidate === null) continue;
    const root = aggregateReportRoot(candidate.artifact.path);
    if (root === null) continue;
    const aggregateBinding = bindings.find((binding) => binding.role === 'aggregate-report'
      && binding.nativeRecordKey !== null
      && artifactIdentity({
        path: binding.path,
        sha256: binding.sha256,
        nativeRecordKey: binding.nativeRecordKey,
      }) === artifactIdentity(candidate.artifact)
      && hasCompleteFeatureBenchReceipt(
        currentBindings,
        binding.invocationId,
        manifest.experiment.taskIds,
        manifest.experiment.arm as Arm,
      ));
    if (aggregateBinding === undefined || !manifest.experiment.taskIds.every((taskId) =>
      completeTaskReceiptRoot(
        currentBindings,
        aggregateBinding.invocationId,
        taskId,
        manifest.experiment.arm as Arm,
      ) === root
      && isTaskBound(
        taskId,
        evidence.taskResults.get(taskId) ?? UNVERIFIED_NATIVE_RESULT,
        aggregateBinding.invocationId,
      ))) continue;
    aggregate = candidate;
    break;
  }
  return { taskResults, aggregate };
}

function boundNativeResult(
  resolver: FeatureBenchEvidenceResolver,
  taskId: string,
): NativeVerifierResult {
  return resolver.taskResults.get(taskId) ?? UNVERIFIED_NATIVE_RESULT;
}

/** Require the all-task receipt only when publishing the upstream run aggregate. */
export function hasCompleteFeatureBenchReceipt(
  bindings: readonly VerifierBinding[],
  invocationId: string,
  taskIds: readonly string[],
  arm: Arm,
): boolean {
  const invocation = bindings.filter((binding) => binding.invocationId === invocationId);
  const aggregate = invocation.find((binding) => binding.role === 'aggregate-report'
    && binding.scope.kind === 'suite-check'
    && binding.scope.name === `featurebench-attempt-1-${arm}`
    && binding.nativeRecordKey === 'attempt_1');
  if (aggregate === undefined) return false;
  const root = aggregateReportRoot(aggregate.path);
  return root !== null && taskIds.every((taskId) =>
    completeTaskReceiptRoot(bindings, invocationId, taskId, arm) === root);
}

export function featureBenchTaskInputs(
  manifest: FeatureBenchManifest,
  state: BenchRunState,
  bindings: readonly VerifierBinding[],
  resolver: FeatureBenchEvidenceResolver,
): TaskReportInput[] {
  return manifest.artifacts.executions.map((execution) => {
    const attempts = state.attempts.filter((attempt) =>
      attempt.taskId === execution.taskId && attempt.arm === execution.arm);
    let lastInvalidation = -1;
    attempts.forEach((attempt, index) => {
      if (attempt.phase === 'cleanup' && attempt.annotations.includes('redo-invalidated')) lastInvalidation = index;
    });
    const currentAttempts = attempts.slice(lastInvalidation + 1);
    const latestInference = currentAttempts.filter((attempt) => attempt.phase === 'inference').at(-1);
    const latestVerifier = currentAttempts.filter((attempt) => attempt.phase === 'verifier').at(-1);
    const nativeVerifier = boundNativeResult(resolver, execution.taskId);
    const latestAttempts = [latestInference, latestVerifier].filter((attempt) => attempt !== undefined);
    const evidenceBinding = nativeVerifier.artifact === null ? undefined : bindings.find((binding) =>
      binding.role === 'task-report'
      && binding.scope.kind === 'task-arm'
      && binding.scope.taskId === execution.taskId
      && binding.scope.arm === execution.arm
      && binding.path === nativeVerifier.artifact!.path
      && binding.sha256 === nativeVerifier.artifact!.sha256
      && binding.nativeRecordKey === nativeVerifier.artifact!.nativeRecordKey);
    const evidenceInvocationId = evidenceBinding?.invocationId
      ?? latestVerifier?.invocationId
      ?? latestInference?.invocationId
      ?? state.invocations.at(-1)?.invocationId;
    if (evidenceInvocationId === undefined) {
      throw new Error(`FeatureBench report input lacks an invocation for ${execution.taskId}/${execution.arm}`);
    }
    const failures = new Set<FailureCode>(latestAttempts.flatMap((attempt) => attempt.failures));
    if (latestVerifier !== undefined && latestVerifier.status !== 'running'
      && !hasCompleteFeatureBenchTaskReceipt(
        bindings,
        latestVerifier.invocationId,
        execution.taskId,
        execution.arm,
      )) failures.add('receipt-incomplete');
    if (latestAttempts.length > 0 && latestAttempts.every((attempt) => attempt.status !== 'running')
      && nativeVerifier.verification === 'unverified' && failures.size === 0) {
      failures.add('unattributed-verifier-absence');
    }
    return {
      invocationId: evidenceInvocationId,
      taskId: execution.taskId,
      arm: execution.arm,
      nativeVerifier,
      failures: [...failures].map((code) => failureObservationSchema.parse({
        code,
        scope: taskArmScope(execution.taskId, execution.arm),
        phase: code.startsWith('verifier-') || code === 'receipt-incomplete'
          || code === 'unattributed-verifier-absence' ? 'verifier' : 'inference',
        terminal: true,
        evidence: code.startsWith('verifier-') ? 'verifier' : 'driver',
      })),
      annotations: [],
      attemptRunning: latestAttempts.some((attempt) => attempt.status === 'running'),
    };
  });
}

export const featureBenchAnalysisHook: SuiteAnalysisHook<'featurebench'> = {
  suite: 'featurebench',
  analyze({ manifest, taskResults, nativeAnalysisInput }) {
    const aggregate = nativeAnalysisInput === null ? null : parseFeatureBenchAggregateReport(
      nativeAnalysisInput,
      manifest.experiment.taskIds,
      new Map(taskResults.map((task) => [task.taskId, task.nativeVerifier])),
    );
    const verified = taskResults.filter((task) => task.nativeVerifier.verification === 'verified');
    const taskMean = verified.length === taskResults.length && verified.length > 0
      ? verified.reduce((sum, task) => sum + task.nativeVerifier.score!, 0) / verified.length
      : null;
    const included = taskResults.filter((task) => task.disposition === 'included-native');
    return {
      suite: 'featurebench',
      native: {
        passRate: aggregate?.passRate ?? null,
        resolvedRate: aggregate?.resolvedRate ?? null,
        completedTasks: aggregate?.completedTasks ?? 0,
        requestedTasks: manifest.experiment.taskIds.length,
      },
      consistency: {
        taskMeanPassRate: taskMean,
        matchesAggregate: aggregate === null || taskMean === null
          ? null
          : Math.round(taskMean * 10_000) === Math.round(aggregate.passRate * 10_000),
      },
      policyAdjusted: {
        passRate: included.length === 0 ? null : included.reduce((sum, task) => sum + task.nativeVerifier.score!, 0) / included.length,
        includedTasks: included.length,
      },
    };
  },
};

function featureBenchNativeAnalysisArtifact(
  directory: string,
  aggregate: FeatureBenchAggregate | null,
  bindings: readonly VerifierBinding[],
): NativeAnalysisArtifactInput | undefined {
  if (aggregate === null) return undefined;
  const binding = bindings.find((candidate) => candidate.role === 'aggregate-report'
    && candidate.scope.kind === 'suite-check'
    && candidate.path === aggregate.artifact.path
    && candidate.sha256 === aggregate.artifact.sha256
    && candidate.nativeRecordKey === aggregate.artifact.nativeRecordKey);
  if (binding === undefined || binding.scope.kind !== 'suite-check') {
    throw new Error('FeatureBench aggregate analysis lacks an exact receipt binding');
  }
  return {
    invocationId: binding.invocationId,
    scope: binding.scope,
    nativeRecordKey: binding.nativeRecordKey,
    path: binding.path,
    bytes: readRegularFileWithinRoot(directory, binding.path),
  };
}

export async function reportCommand(options: ReportOptions, context: CommandContext): Promise<void> {
  let policyLock: BenchLockHandle | null = null;
  let stores: Awaited<ReturnType<typeof loadRunStores>> | null = null;
  const startedMs = performance.now();
  let invocationId: string | null = null;
  try {
    policyLock = await acquireBenchLock(context.paths.cacheRoot, featureBenchPolicyLockFile(context.paths), {
      recoverStale: options.recoverStaleLock,
    });
    stores = await loadRunStores(
      context.paths,
      options.runId,
      options.recoverStaleLock,
      policyLock,
    );
    const directory = runDir(context.paths, 'featurebench', options.runId);
    const assemble = () => {
      const evidence = loadStoredReportEvidence(context.paths, 'featurebench', options.runId);
      const metrics = normalizeBenchMetrics(
        evidence.manifest,
        directory,
        indexFeatureBenchMetrics(evidence.manifest, directory, evidence.runState),
        evidence.runState,
      );
      const resolver = createFeatureBenchEvidenceResolver(
        directory,
        evidence.manifest,
        evidence.runState,
        evidence.verifierReceipt.bindings,
      );
      return buildBenchReport({
        ...evidence,
        metrics,
        taskResults: featureBenchTaskInputs(
          evidence.manifest,
          evidence.runState,
          evidence.verifierReceipt.bindings,
          resolver,
        ),
        currentPolicyHashes: currentControlPlaneHashes(context.paths),
        analysisHook: featureBenchAnalysisHook,
        nativeAnalysisArtifact: featureBenchNativeAnalysisArtifact(
          directory,
          resolver.aggregate,
          evidence.verifierReceipt.bindings,
        ),
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
    rmSync(reportJsonFile(context.paths, 'featurebench', options.runId), { force: true });
    rmSync(reportMarkdownFile(context.paths, 'featurebench', options.runId), { force: true });
    if (invocationId !== null && stores !== null) {
      await finishInvocation(stores.state, invocationId, startedMs, context.clock.now(), 'unknown-terminal');
    }
    throw error;
  } finally {
    try { stores?.lease.release(); } finally { policyLock?.release(); }
  }
}
