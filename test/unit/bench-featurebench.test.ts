/** Offline FeatureBench pins, trust boundary, native commands, and evidence. */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { taskDisposition } from '../../bench/src/shared/failure.js';
import { acquireBenchLock } from '../../bench/src/shared/locks.js';
import type { FeatureBenchManifest } from '../../bench/src/shared/manifest.js';
import { createBenchPathRoots, writePrivateJsonAtomic } from '../../bench/src/shared/paths.js';
import { sha256Tree } from '../../bench/src/shared/provenance.js';
import type { TaskResult } from '../../bench/src/shared/report.js';
import type { BenchRunState, BenchRunStateStore } from '../../bench/src/shared/run-state.js';
import type { VerifierBinding } from '../../bench/src/shared/verifier.js';
import { featureBenchAdapter } from '../../bench/src/suites/featurebench/adapter.js';
import {
  FEATUREBENCH_DATASET,
  FEATUREBENCH_DATASET_REVISION,
  FEATUREBENCH_NETWORK_POLICY_SHA256,
  FEATUREBENCH_PYTHON_VERSION,
  FEATUREBENCH_SOURCE_REVISION,
  FEATUREBENCH_SPLIT,
  loadFeatureBenchRuntimeBindings,
  type FeatureBenchConfig,
} from '../../bench/src/suites/featurebench/config.js';
import { validateFeatureBenchHost } from '../../bench/src/suites/featurebench/host.js';
import {
  assertNoFeatureBenchPythonCacheArtifacts,
  assertNoFeatureBenchStageReferences,
  FEATUREBENCH_DATASET_DOWNLOAD_SCRIPT,
  FEATUREBENCH_DATASET_MEMBERSHIP_SCRIPT,
  FEATUREBENCH_DATASET_PARQUET,
  featureBenchEnvironmentIdentity,
  makeFeatureBenchEnvironmentRelocatable,
  parseFeatureBenchDatasetMap,
  prepareFeatureBenchInputs,
  preflightFeatureBenchUv,
  removeFeatureBenchPythonCacheArtifacts,
  verifyFeatureBenchDatasetArtifact,
  type PreparedFeatureBenchInputs,
} from '../../bench/src/suites/featurebench/prepare.js';
import {
  archiveFeatureBenchEvaluation,
  assertFeatureBenchInferenceReady,
  cleanupFeatureBenchContainers,
  cleanupFeatureBenchRuntimeHomes,
  consolidateFeatureBenchPredictions,
  createFeatureBenchEvidenceResolver,
  featureBenchEvaluatorLaunched,
  featureBenchInferenceWatchdogMs,
  featureBenchAnalysisHook,
  featureBenchTaskInputs,
  featureBenchPolicyLockFile,
  featureBenchPolicyLockRoot,
  hasCompleteFeatureBenchReceipt,
  hasCompleteFeatureBenchTaskReceipt,
  invalidateFeatureBenchEvaluationReceipt,
  invalidateFeatureBenchRedo,
  inspectFeatureBenchTrustBoundary,
  planFeatureBenchEval,
  planFeatureBenchResume,
  planFeatureBenchRun,
  recordFeatureBenchBatchAttempts,
  resolveFeatureBenchResumeRoot,
} from '../../bench/src/suites/featurebench/runner.js';
import { indexFeatureBenchMetrics } from '../../bench/src/suites/featurebench/telemetry.js';
import { indexFeatureBenchEvidence } from '../../bench/src/suites/featurebench/verifier.js';

const FIXTURE = resolve('test/fixtures/bench/featurebench');
const INVENTORY_FIXTURE = resolve(
  'test/fixtures/bench/featurebench-inventory-e99d6efdfe511ea832c1b5735c536129561ec96a.json',
);
const TIMESTAMP = '2026-07-19__13-00-41';
const TASK_IDS = ['task-alpha', 'task-beta', 'task-gamma', 'task-delta', 'task-epsilon'];
const HASH = 'a'.repeat(64);
const temporaryRoots: string[] = [];

interface PinnedInventoryFixture {
  dataset: string;
  revision: string;
  split: string;
  expectedTaskCount: number;
  sourceParquetSha256: string;
  tasks: Record<string, string>;
}

function temporary(): string {
  const root = mkdtempSync(join(tmpdir(), 'uc-featurebench-test-'));
  temporaryRoots.push(root);
  return root;
}

function pinnedInventory(): PinnedInventoryFixture {
  return JSON.parse(readFileSync(INVENTORY_FIXTURE, 'utf8')) as PinnedInventoryFixture;
}

function projectFeatureBenchRows(rows: readonly unknown[]) {
  const stubDirectory = temporary();
  writeFileSync(join(stubDirectory, 'datasets.py'), `import json
import os

def load_dataset(dataset, *, data_files, split):
    expected = json.loads(os.environ["FEATUREBENCH_STUB_EXPECTED"])
    if {"dataset": dataset, "data_files": data_files, "split": split} != expected:
        raise AssertionError("projection did not use the pinned load_dataset arguments")
    return json.loads(os.environ["FEATUREBENCH_STUB_ROWS"])
`);
  return spawnSync('python3', ['-c', FEATUREBENCH_DATASET_MEMBERSHIP_SCRIPT], {
    encoding: 'utf8',
    env: {
      ...process.env,
      FEATUREBENCH_STUB_EXPECTED: JSON.stringify({
        dataset: 'parquet',
        data_files: '/pinned/featurebench.parquet',
        split: 'train',
      }),
      FEATUREBENCH_DATASET_PARQUET: '/pinned/featurebench.parquet',
      FEATUREBENCH_STUB_ROWS: JSON.stringify(rows),
      PYTHONPATH: stubDirectory,
      PYTHONDONTWRITEBYTECODE: '1',
    },
  });
}

function nativeFixture(): string {
  const runDirectory = temporary();
  const destination = join(runDirectory, 'native', TIMESTAMP);
  mkdirSync(dirname(destination), { recursive: true });
  cpSync(FIXTURE, destination, { recursive: true });
  rmSync(join(destination, 'README.md'));
  return runDirectory;
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function config(): FeatureBenchConfig {
  return {
    model: 'gpt-test',
    requestedEffort: 'high',
    arm: 'b',
    taskIds: TASK_IDS,
    broker: { publicIdentity: 'broker-public-id', publicVersion: 'broker-v1' },
    concurrency: { inference: 4, evaluation: 4 },
    timeouts: { inferenceMs: 60_000, evaluationMs: 60_000 },
    resources: { cpus: 8, memoryBytes: 24_000_000_000, pids: 4_096 },
  };
}

function manifest(): FeatureBenchManifest {
  return {
    experiment: { model: 'gpt-test', requestedEffort: 'high', arm: 'b', taskIds: TASK_IDS },
    limits: { hostTaskTimeoutMs: 60_000 },
    suiteConfig: {
      inference: { concurrency: 4, timeoutMs: 60_000 },
      evaluation: { concurrency: 3, timeoutMs: 120_000 },
      resources: { cpus: 8, memoryBytes: 24_000_000_000, pids: 4_096 },
    },
    provenance: {
      tasks: TASK_IDS.map((taskId) => ({
        taskId,
        image: { resolvedDigest: `example.test/featurebench@sha256:${HASH}` },
      })),
    },
  } as FeatureBenchManifest;
}

function prepared(): PreparedFeatureBenchInputs {
  return {
    fbBinary: '/prepared/.venv/bin/fb',
    sourceDirectory: '/prepared/source',
  } as PreparedFeatureBenchInputs;
}

function stagedFeatureBenchEnvironment(stage: string): { environment: string; fb: string } {
  const environment = join(stage, 'source', '.venv');
  const bin = join(environment, 'bin');
  mkdirSync(bin, { recursive: true });
  const python = join(bin, 'python');
  const systemPython = spawnSync('python3', ['-c', 'import sys; print(sys.executable)'], {
    encoding: 'utf8',
  });
  if (systemPython.status !== 0 || systemPython.stdout.trim().length === 0) {
    throw new Error(systemPython.error?.message ?? systemPython.stderr);
  }
  const systemPythonPath = systemPython.stdout.trim();
  symlinkSync(systemPythonPath, python);
  writeFileSync(join(environment, 'pyvenv.cfg'), `home = ${dirname(systemPythonPath)}\n`);
  const fb = join(bin, 'fb');
  writeFileSync(fb, `#!${python}
import os
import sys
print(f"interpreter={sys.executable}")
print(f"entrypoint={sys.argv[0]}")
print(f"argument={sys.argv[1]}")
print(f"working={os.getcwd()}")
`);
  chmodSync(fb, 0o755);
  return { environment, fb };
}

function predictionRoot(
  runDirectory: string,
  timestamp: string,
  predictions: Readonly<Record<string, unknown>>,
): string {
  const root = `native/${timestamp}`;
  const directory = join(runDirectory, ...root.split('/'));
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, 'output.jsonl'), `${Object.entries(predictions).map(([taskId, prediction]) =>
    JSON.stringify({ instance_id: taskId, model_patch: prediction })).join('\n')}\n`);
  return root;
}

function consolidatedPredictions(runDirectory: string, path: string): Map<string, unknown> {
  return new Map(readFileSync(join(runDirectory, ...path.split('/')), 'utf8').trim().split(/\r?\n/u)
    .map((line) => JSON.parse(line) as { instance_id: string; model_patch: unknown })
    .map((prediction) => [prediction.instance_id, prediction.model_patch]));
}

function acceptedPredictionSnapshot(
  runDirectory: string,
  invocationId: string,
  predictions: Readonly<Record<string, unknown>>,
): { bindings: VerifierBinding[]; state: BenchRunState } {
  const nativeRoot = `native/${TIMESTAMP}`;
  const path = `${nativeRoot}/consolidated-output-${invocationId}.jsonl`;
  const file = join(runDirectory, ...path.split('/'));
  mkdirSync(dirname(file), { recursive: true });
  for (const directory of [
    join(runDirectory, 'native'),
    dirname(file),
  ]) chmodSync(directory, 0o700);
  const contents = `${Object.entries(predictions).map(([taskId, prediction]) =>
    JSON.stringify({ instance_id: taskId, model_patch: prediction })).join('\n')}\n`;
  writeFileSync(file, contents);
  const sha256 = createHash('sha256').update(contents).digest('hex');
  const invocationPath = `native/invocations/${invocationId}/fb-eval.json`;
  const invocationFile = join(runDirectory, ...invocationPath.split('/'));
  mkdirSync(dirname(invocationFile), { recursive: true });
  const invocationContents = `${JSON.stringify({ command: 'eval', predictions: path })}\n`;
  writeFileSync(invocationFile, invocationContents);
  const common = { invocationId, path, sha256 };
  return {
    bindings: [
      {
        ...common,
        scope: { kind: 'suite-check', name: 'featurebench-eval-input-b' },
        role: 'verifier-input',
        nativeRecordKey: 'predictions-jsonl',
      },
      {
        ...common,
        scope: { kind: 'suite-check', name: 'featurebench-accepted-predictions' },
        role: 'completion-marker',
        nativeRecordKey: 'accepted-predictions-jsonl',
      },
      {
        invocationId,
        path: invocationPath,
        sha256: createHash('sha256').update(invocationContents).digest('hex'),
        scope: { kind: 'suite-check', name: 'featurebench-eval-invocation-b' },
        role: 'verifier-invocation',
        nativeRecordKey: 'fb-eval-v2',
      },
    ],
    state: {
      invocations: [{ invocationId }],
      attempts: Object.keys(predictions).map((taskId) => ({
        invocationId,
        taskId,
        phase: 'verifier',
        status: 'succeeded',
        failures: [],
        nativePath: nativeRoot,
      })),
    } as BenchRunState,
  };
}

function completeEvaluationBindings(
  runDirectory: string,
  bindings: readonly VerifierBinding[],
): VerifierBinding[] {
  const template = bindings.find((binding) => binding.role === 'run-metadata');
  if (template === undefined) throw new Error('test evidence is missing run metadata');
  const invocationRoot = `native/invocations/${template.invocationId}`;
  const nativeRoot = dirname(template.path);
  mkdirSync(join(runDirectory, ...invocationRoot.split('/')), { recursive: true });
  const artifacts = [
    {
      path: `${nativeRoot}/consolidated-output-${template.invocationId}.jsonl`,
      contents: '{"instance_id":"accepted"}\n',
      scope: { kind: 'suite-check' as const, name: 'featurebench-eval-input-b' },
      role: 'verifier-input' as const,
      nativeRecordKey: 'predictions-jsonl',
    },
    {
      path: `${invocationRoot}/fb-eval.json`,
      contents: '{"command":"eval"}\n',
      scope: { kind: 'suite-check' as const, name: 'featurebench-eval-invocation-b' },
      role: 'verifier-invocation' as const,
      nativeRecordKey: 'fb-eval-v2',
    },
  ];
  for (const artifact of artifacts) writeFileSync(
    join(runDirectory, ...artifact.path.split('/')),
    artifact.contents,
  );
  return [
    ...bindings,
    ...artifacts.map(({ contents, ...artifact }) => ({
      invocationId: template.invocationId,
      ...artifact,
      sha256: createHash('sha256').update(contents).digest('hex'),
    })),
  ];
}

describe('FeatureBench immutable inputs and host policy', () => {
  it('freezes upstream source, dataset, split, Python, and pinned inventory', () => {
    const inventory = pinnedInventory();
    expect(FEATUREBENCH_SOURCE_REVISION).toBe('445dcbaec0b2e136061b0acb54e753c0a9f1888e');
    expect(FEATUREBENCH_DATASET_REVISION).toBe('e99d6efdfe511ea832c1b5735c536129561ec96a');
    expect(FEATUREBENCH_SPLIT).toBe('fast');
    expect(FEATUREBENCH_PYTHON_VERSION).toBe('3.13.5');
    expect(FEATUREBENCH_DATASET_PARQUET).toBe('.git/ultracode-benchmark-dataset.parquet');
    expect(FEATUREBENCH_DATASET_DOWNLOAD_SCRIPT).toContain(FEATUREBENCH_DATASET_REVISION);
    expect({
      dataset: inventory.dataset,
      revision: inventory.revision,
      split: inventory.split,
    }).toEqual({
      dataset: FEATUREBENCH_DATASET,
      revision: FEATUREBENCH_DATASET_REVISION,
      split: FEATUREBENCH_SPLIT,
    });
    const taskIds = Object.keys(inventory.tasks);
    expect(inventory.expectedTaskCount).toBe(100);
    expect(inventory.sourceParquetSha256).toBe('e8a704f83d673e1cc78086eefb76bd56461ead8a65ca06fd6972f7363be8a775');
    expect(taskIds).toHaveLength(inventory.expectedTaskCount);
    expect(new Set(taskIds).size).toBe(inventory.expectedTaskCount);
    expect(Object.entries(inventory.tasks).every(([taskId, image]) => taskId.length > 0 && image.length > 0)).toBe(true);
    expect(parseFeatureBenchDatasetMap({
      dataset: FEATUREBENCH_DATASET,
      revision: FEATUREBENCH_DATASET_REVISION,
      split: FEATUREBENCH_SPLIT,
      tasks: inventory.tasks,
    }).tasks).toEqual(inventory.tasks);
    expect(() => parseFeatureBenchDatasetMap({
      dataset: FEATUREBENCH_DATASET,
      revision: FEATUREBENCH_DATASET_REVISION,
      split: FEATUREBENCH_SPLIT,
      tasks: { invented: 'invented/image' },
    })).toThrow(/audited inventory pin/);
    expect(() => parseFeatureBenchDatasetMap({
      dataset: FEATUREBENCH_DATASET,
      revision: 'floating',
      split: FEATUREBENCH_SPLIT,
      tasks: { 'task-alpha': 'example.test/image:tag' },
    })).toThrow(/pinned dataset/);
    const wrongArtifact = join(temporary(), 'featurebench.parquet');
    writeFileSync(wrongArtifact, 'wrong bytes');
    expect(() => verifyFeatureBenchDatasetArtifact(wrongArtifact)).toThrow(/audited byte pin/);
  });

  it('preflights uv on PATH before creating preparation state or invoking Docker', async () => {
    const roots = createBenchPathRoots(temporary());
    const commands: string[][] = [];
    const executor = async (command: string, argv: readonly string[]) => {
      commands.push([command, ...argv]);
      throw new Error('spawn uv ENOENT');
    };
    await expect(prepareFeatureBenchInputs(roots, {
      nodeVersion: 'v22.17.0',
      nodeDistribution: 'nodejs',
      codexBinary: '/unused/codex',
    }, executor)).rejects.toThrow('FeatureBench prep requires uv on PATH');
    expect(commands).toEqual([['uv', '--version']]);
    expect(existsSync(join(roots.cacheRoot, 'featurebench'))).toBe(false);
  });

  it('accepts only a successful uv version probe', async () => {
    await expect(preflightFeatureBenchUv(async () => ({ stdout: 'uv 0.8.3\n', stderr: '' }), '/bench'))
      .resolves.toBeUndefined();
    await expect(preflightFeatureBenchUv(async () => ({ stdout: '', stderr: '' }), '/bench'))
      .rejects.toThrow('FeatureBench prep requires uv on PATH');
  });

  it('replaces the broken staged shebang with a launcher executable from its final digest path', () => {
    const root = temporary();
    const oldStage = join(root, 'old-stage');
    const oldEnvironment = stagedFeatureBenchEnvironment(oldStage);
    const beforeMove = spawnSync(oldEnvironment.fb, ['--help'], { cwd: root, encoding: 'utf8' });
    expect(
      beforeMove.status,
      beforeMove.error?.message ?? beforeMove.signal ?? beforeMove.stderr,
    ).toBe(0);
    const oldFinal = join(root, sha256Tree(oldStage));
    renameSync(oldStage, oldFinal);
    const broken = spawnSync(join(oldFinal, 'source', '.venv', 'bin', 'fb'), ['--help'], {
      cwd: root,
      encoding: 'utf8',
    });
    expect((broken.error as NodeJS.ErrnoException | undefined)?.code).toBe('ENOENT');

    const newStage = join(root, 'new-stage');
    const relocated = stagedFeatureBenchEnvironment(newStage);
    const activation = join(relocated.environment, 'bin', 'activate');
    writeFileSync(activation, `VIRTUAL_ENV=${newStage}/source/.venv\n`);
    const distInfo = join(relocated.environment, 'lib', 'python3.13', 'site-packages', 'featurebench.dist-info');
    mkdirSync(distInfo, { recursive: true });
    const directUrl = join(distInfo, 'direct_url.json');
    writeFileSync(directUrl, `${JSON.stringify({ url: `file://${newStage}/source` })}\n`);
    const record = join(distInfo, 'RECORD');
    writeFileSync(record, 'featurebench.dist-info/direct_url.json,sha256=old,1\nfeaturebench/__init__.py,,\n');

    makeFeatureBenchEnvironmentRelocatable(newStage, relocated.environment);
    expect(existsSync(activation)).toBe(false);
    expect(existsSync(directUrl)).toBe(false);
    expect(readFileSync(record, 'utf8')).toBe('featurebench/__init__.py,,\n');
    expect(() => assertNoFeatureBenchStageReferences(newStage, newStage)).not.toThrow();
    const digest = sha256Tree(newStage);
    const final = join(root, digest);
    renameSync(newStage, final);
    const publishedFb = join(final, 'source', '.venv', 'bin', 'fb');
    const result = spawnSync(publishedFb, ['--help'], { cwd: root, encoding: 'utf8' });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain(`interpreter=${join(
      realpathSync(final), 'source', '.venv', 'bin', 'python',
    )}`);
    expect(result.stdout).toContain(`entrypoint=${publishedFb}`);
    expect(result.stdout).toContain('argument=--help');
    expect(result.stdout).toContain(`working=${realpathSync(root)}`);
  });

  it('removes Python bytecode before hashing and rejects it on every load boundary', () => {
    const root = temporary();
    const cache = join(root, 'source', '.venv', 'lib', 'python3.13', 'site-packages', '__pycache__');
    mkdirSync(cache, { recursive: true });
    writeFileSync(join(cache, 'featurebench.cpython-313.pyc'), 'executable bytecode');
    expect(() => assertNoFeatureBenchPythonCacheArtifacts(root)).toThrow(/Python cache artifacts/);
    const before = sha256Tree(root);
    removeFeatureBenchPythonCacheArtifacts(root);
    expect(() => assertNoFeatureBenchPythonCacheArtifacts(root)).not.toThrow();
    expect(sha256Tree(root)).not.toBe(before);
  });

  it('rejects environment links outside the published tree or attested Python runtime', () => {
    const root = temporary();
    const environment = join(root, '.venv');
    const bin = join(environment, 'bin');
    const packages = join(environment, 'lib', 'python3.13', 'site-packages');
    const external = join(root, 'mutable-cache');
    mkdirSync(bin, { recursive: true });
    mkdirSync(packages, { recursive: true });
    mkdirSync(external);
    writeFileSync(join(bin, 'python'), 'mock interpreter');
    symlinkSync(external, join(packages, 'escaped-cache'));
    expect(() => featureBenchEnvironmentIdentity(environment)).toThrow(/unattested external links/);
    rmSync(join(packages, 'escaped-cache'));
    expect(() => featureBenchEnvironmentIdentity(environment)).not.toThrow();
  });

  it('isolates uv configuration and copies package payloads during sync', () => {
    const source = readFileSync(resolve('bench/src/suites/featurebench/prepare.ts'), 'utf8');
    expect(source).toContain("'--no-config'");
    expect(source).toContain("'--link-mode'");
    expect(source).toContain("'copy'");
    expect(source).toContain("'--managed-python'");
  });

  it('projects the exact pinned-shape source inventory from top-level image_name values', () => {
    const inventory = pinnedInventory();
    const rows = Object.entries(inventory.tasks).map(([instanceId, imageName]) => ({
      instance_id: instanceId,
      image_name: imageName,
      repo_settings: JSON.stringify({ image_name: 'wrong/nested-image', docker_image: 'wrong/fallback-image' }),
    }));
    const projected = projectFeatureBenchRows(rows);
    expect(projected.status, projected.stderr).toBe(0);
    expect(JSON.parse(projected.stdout)).toEqual({
      dataset: inventory.dataset,
      revision: inventory.revision,
      split: inventory.split,
      tasks: inventory.tasks,
    });
  });

  it('rejects non-string, empty, and duplicate projection identities before emitting an inventory', () => {
    const failures = [
      [{ instance_id: '', image_name: 'example.test/image:tag' }],
      [{ instance_id: 7, image_name: 'example.test/image:tag' }],
      [{ instance_id: 'task-alpha', image_name: '' }],
      [{ instance_id: 'task-alpha', image_name: 7 }],
      [
        { instance_id: 'task-alpha', image_name: 'example.test/image:one' },
        { instance_id: 'task-alpha', image_name: 'example.test/image:two' },
      ],
    ];
    for (const rows of failures) {
      const projected = projectFeatureBenchRows(rows);
      expect(projected.status).not.toBe(0);
      expect(projected.stdout).toBe('');
    }
  });

  it('requires Linux x64 and runtime-only HTTPS endpoint names', () => {
    expect(() => validateFeatureBenchHost('linux', 'x64')).not.toThrow();
    expect(() => validateFeatureBenchHost('darwin', 'arm64')).toThrow(/Linux x64/);
    expect(loadFeatureBenchRuntimeBindings({
      FEATUREBENCH_CREDENTIAL_BROKER_URL: 'https://broker.test/v1',
      FEATUREBENCH_RESTRICTED_NETWORK: 'featurebench-private',
    })).toEqual({
      brokerUrl: 'https://broker.test/v1',
      restrictedNetwork: 'featurebench-private',
    });
    expect(() => loadFeatureBenchRuntimeBindings({
      FEATUREBENCH_CREDENTIAL_BROKER_URL: 'https://user:secret@broker.test/v1',
      FEATUREBENCH_RESTRICTED_NETWORK: 'featurebench-private',
    })).toThrow(/without userinfo/);
  });

  it('serializes separate worktrees on one host-wide policy lock identity', async () => {
    const roots = createBenchPathRoots(temporary());
    const otherRoots = createBenchPathRoots(temporary());
    const coordinationRoot = temporary();
    const lock = featureBenchPolicyLockFile(roots, coordinationRoot);
    expect(featureBenchPolicyLockFile(otherRoots, coordinationRoot)).toBe(lock);
    expect(lock).toBe(join(
      coordinationRoot,
      '.locks',
      `featurebench-network-${FEATUREBENCH_NETWORK_POLICY_SHA256}.lock`,
    ));
    const held = await acquireBenchLock(coordinationRoot, lock);
    await expect(acquireBenchLock(
      coordinationRoot,
      featureBenchPolicyLockFile(otherRoots, coordinationRoot),
    )).rejects.toThrow(/already held/);
    held.release();
    expect(featureBenchPolicyLockRoot()).toBe(join(
      '/tmp',
      `ultracode-bench-${typeof process.getuid === 'function' ? process.getuid() : 0}`,
    ));
    expect(() => featureBenchPolicyLockRoot('relative-root')).toThrow(/must be absolute/);
  });

  it('removes only an exact run-owned runtime binding orphan', () => {
    const runId = 'feature-runtime-test';
    const directory = mkdtempSync(join(tmpdir(), `uc-featurebench-runtime-${runId}-b-`));
    temporaryRoots.push(directory);
    chmodSync(directory, 0o700);
    writePrivateJsonAtomic(directory, join(directory, '.ultracode-benchmark-runtime.json'), {
      schemaVersion: 2,
      kind: 'ultracode-featurebench-runtime',
      runId,
      arm: 'b',
      nonce: 'a'.repeat(64),
    });
    writeFileSync(join(directory, 'config.toml'), 'FEATUREBENCH_BROKER_BASE_URL = "https://broker.test/v1"\n', {
      mode: 0o600,
    });
    expect(cleanupFeatureBenchRuntimeHomes('foreign-run', 'b')).toBe(0);
    expect(existsSync(directory)).toBe(true);
    expect(cleanupFeatureBenchRuntimeHomes(runId, 'b')).toBe(1);
    expect(existsSync(directory)).toBe(false);
  });
});

describe('FeatureBench credential-broker trust boundary', () => {
  const network = JSON.stringify([{
    Internal: true,
    Labels: { 'ultracode.egress-policy': 'openai-via-credential-broker' },
    Containers: { ['b'.repeat(64)]: { Name: 'broker.test' } },
  }]);
  const broker = JSON.stringify([{
    Id: 'b'.repeat(64),
    Image: `sha256:${HASH}`,
    Path: '/broker',
    Args: ['serve'],
    State: { Running: true },
    Config: { Labels: {
      'ultracode.credential-broker': 'true',
      'ultracode.credential-broker.identity': 'broker-public-id',
      'ultracode.credential-broker.version': 'broker-v1',
    } },
    HostConfig: { Binds: [], Mounts: [], Tmpfs: {} },
    Mounts: [],
    NetworkSettings: { Networks: { 'featurebench-private': {}, upstream: {} } },
  }]);

  it('accepts exactly one broker on an internal network and persists only hashes', () => {
    const result = inspectFeatureBenchTrustBoundary(network, broker, config(), {
      brokerUrl: 'https://broker.test/v1',
      restrictedNetwork: 'featurebench-private',
    });
    expect(result.endpointPolicySha256).toMatch(/^[a-f0-9]{64}$/);
    expect(result.brokerRuntimeSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(result)).not.toMatch(/broker\.test|featurebench-private|https:/);
  });

  it('binds the selected network and complete broker endpoint without persisting either', () => {
    const first = inspectFeatureBenchTrustBoundary(network, broker, config(), {
      brokerUrl: 'https://broker.test/v1',
      restrictedNetwork: 'featurebench-private',
    });
    const pathDrift = inspectFeatureBenchTrustBoundary(network, broker, config(), {
      brokerUrl: 'https://broker.test/v2',
      restrictedNetwork: 'featurebench-private',
    });
    const networkDrift = inspectFeatureBenchTrustBoundary(network, broker, config(), {
      brokerUrl: 'https://broker.test/v1',
      restrictedNetwork: 'upstream',
    });
    expect(pathDrift.endpointPolicySha256).not.toBe(first.endpointPolicySha256);
    expect(networkDrift.endpointPolicySha256).not.toBe(first.endpointPolicySha256);
  });

  it('rejects extra endpoints and broker identity drift', () => {
    const extra = JSON.stringify([{
      Internal: true,
      Labels: { 'ultracode.egress-policy': 'openai-via-credential-broker' },
      Containers: { ['b'.repeat(64)]: { Name: 'broker.test' }, extra: { Name: 'other' } },
    }]);
    expect(() => inspectFeatureBenchTrustBoundary(extra, broker, config(), {
      brokerUrl: 'https://broker.test/v1', restrictedNetwork: 'featurebench-private',
    })).toThrow(/exactly the named credential broker/);
    const drifted = broker.replace('broker-v1', 'broker-v2');
    expect(() => inspectFeatureBenchTrustBoundary(network, drifted, config(), {
      brokerUrl: 'https://broker.test/v1', restrictedNetwork: 'featurebench-private',
    })).toThrow(/public identity, version/);
  });

  it('discovers and validates inference and no-network evaluation containers before removal', async () => {
    const taskIds = Array.from({ length: 100 }, (_, index) => `task-${index}`);
    const candidates = ['a', 'b', 'c', 'd'].map((character) => character.repeat(12));
    const fullIds = ['a', 'b', 'c', 'd'].map((character) => character.repeat(64));
    const commands: string[][] = [];
    const executor = async (command: string, argv: readonly string[]) => {
      commands.push([command, ...argv]);
      if (argv[0] === 'ps') return { stdout: `${candidates.join('\n')}\n`, stderr: '' };
      if (argv[0] === 'inspect') {
        const index = candidates.indexOf(argv[1]!);
        return { stdout: JSON.stringify([{
          Id: fullIds[index],
          Config: { Labels: {
            'ultracode.benchmark.schema': '2',
            'ultracode.benchmark.suite': 'featurebench',
            'ultracode.benchmark.run': 'run-one',
            'ultracode.benchmark.arm': 'b',
            'ultracode.benchmark.ownership': '1',
            'ultracode.benchmark.task': taskIds[index * 25],
            'ultracode.benchmark.purpose': index === 1 ? 'prep' : index === 2 ? 'evaluation' : 'session',
          } },
          HostConfig: { NetworkMode: index === 2 ? 'none' : 'featurebench-private' },
        }]), stderr: '' };
      }
      return { stdout: '', stderr: '' };
    };
    await expect(cleanupFeatureBenchContainers('run-one', 'b', taskIds, executor)).resolves.toBe(4);
    const discoveries = commands.filter((argv) => argv[1] === 'ps');
    expect(discoveries).toEqual([[
      'docker', 'ps', '--all', '--quiet',
      '--filter', 'label=ultracode.benchmark.schema=2',
      '--filter', 'label=ultracode.benchmark.suite=featurebench',
      '--filter', 'label=ultracode.benchmark.run=run-one',
      '--filter', 'label=ultracode.benchmark.arm=b',
      '--filter', 'label=ultracode.benchmark.ownership=1',
    ]]);
    const firstRemoval = commands.findIndex((argv) => argv[1] === 'rm');
    expect(commands.slice(1, firstRemoval).every((argv) => argv[1] === 'inspect')).toBe(true);
    expect(commands.slice(firstRemoval)).toEqual(fullIds.map((id) => ['docker', 'rm', '--force', id]));
    expect(commands.slice(firstRemoval).every((argv) => argv.at(-1)?.length === 64)).toBe(true);
  });

  it('makes unsafe membership, labels, ids, and prefixes fail without partial removals', async () => {
    const prefix = 'a'.repeat(12);
    const fullId = 'a'.repeat(64);
    const labels = {
      'ultracode.benchmark.schema': '2',
      'ultracode.benchmark.suite': 'featurebench',
      'ultracode.benchmark.run': 'run-one',
      'ultracode.benchmark.arm': 'b',
      'ultracode.benchmark.ownership': '1',
      'ultracode.benchmark.task': 'task-alpha',
      'ultracode.benchmark.purpose': 'session',
    };
    const cases = [
      {
        name: 'task membership',
        listed: prefix,
        inspection: { Id: fullId, Config: { Labels: { ...labels, 'ultracode.benchmark.task': 'foreign-task' } } },
      },
      {
        name: 'purpose membership',
        listed: prefix,
        inspection: { Id: fullId, Config: { Labels: { ...labels, 'ultracode.benchmark.purpose': 'foreign' } } },
      },
      {
        name: 'common ownership labels',
        listed: prefix,
        inspection: {
          Id: fullId,
          Config: { Labels: { ...labels, 'ultracode.benchmark.ownership': '0' } },
        },
      },
      {
        name: 'discovered ids',
        listed: 'not-an-id',
        inspection: null,
      },
      {
        name: 'inspected ids',
        listed: prefix,
        inspection: { Id: 'a'.repeat(63), Config: { Labels: labels } },
      },
      {
        name: 'duplicate prefixes',
        listed: `${prefix}\n${prefix}`,
        inspection: null,
      },
      {
        name: 'ambiguous prefixes',
        listed: `${prefix}\n${'a'.repeat(13)}`,
        inspection: null,
      },
    ];
    for (const scenario of cases) {
      const commands: string[][] = [];
      const executor = async (command: string, argv: readonly string[]) => {
        commands.push([command, ...argv]);
        if (argv[0] === 'ps') return { stdout: `${scenario.listed}\n`, stderr: '' };
        if (argv[0] === 'inspect' && scenario.inspection !== null) {
          return { stdout: JSON.stringify([scenario.inspection]), stderr: '' };
        }
        return { stdout: '', stderr: '' };
      };
      await expect(
        cleanupFeatureBenchContainers('run-one', 'b', ['task-alpha'], executor),
        scenario.name,
      ).rejects.toThrow();
      expect(commands.filter((argv) => argv[1] === 'rm'), scenario.name).toHaveLength(0);
    }
  });

  it('removes an exactly owned evaluator before reporting its network-policy violation', async () => {
    const prefix = 'a'.repeat(12);
    const fullId = 'a'.repeat(64);
    const commands: string[][] = [];
    const executor = async (command: string, argv: readonly string[]) => {
      commands.push([command, ...argv]);
      if (argv[0] === 'ps') return { stdout: `${prefix}\n`, stderr: '' };
      if (argv[0] === 'inspect') return { stdout: JSON.stringify([{
        Id: fullId,
        Config: { Labels: {
          'ultracode.benchmark.schema': '2',
          'ultracode.benchmark.suite': 'featurebench',
          'ultracode.benchmark.run': 'run-one',
          'ultracode.benchmark.arm': 'b',
          'ultracode.benchmark.ownership': '1',
          'ultracode.benchmark.task': 'task-alpha',
          'ultracode.benchmark.purpose': 'evaluation',
        } },
        HostConfig: { NetworkMode: 'bridge' },
      }]), stderr: '' };
      return { stdout: '', stderr: '' };
    };

    await expect(cleanupFeatureBenchContainers('run-one', 'b', ['task-alpha'], executor))
      .rejects.toThrow(/removed owned FeatureBench evaluator/);
    expect(commands.filter((argv) => argv[1] === 'rm')).toEqual([['docker', 'rm', '--force', fullId]]);
  });

  it('does not remove an earlier verified container when a later inspection is unsafe', async () => {
    const candidates = ['a', 'b'].map((character) => character.repeat(12));
    const commands: string[][] = [];
    const executor = async (command: string, argv: readonly string[]) => {
      commands.push([command, ...argv]);
      if (argv[0] === 'ps') return { stdout: `${candidates.join('\n')}\n`, stderr: '' };
      if (argv[0] === 'inspect') {
        const character = argv[1]![0]!;
        return { stdout: JSON.stringify([{
          Id: character.repeat(64),
          Config: { Labels: {
            'ultracode.benchmark.schema': '2',
            'ultracode.benchmark.suite': 'featurebench',
            'ultracode.benchmark.run': 'run-one',
            'ultracode.benchmark.arm': 'b',
            'ultracode.benchmark.ownership': character === 'a' ? '1' : '0',
            'ultracode.benchmark.task': 'task-alpha',
            'ultracode.benchmark.purpose': 'session',
          } },
        }]), stderr: '' };
      }
      return { stdout: '', stderr: '' };
    };
    await expect(cleanupFeatureBenchContainers('run-one', 'b', ['task-alpha'], executor)).rejects.toThrow();
    expect(commands.filter((argv) => argv[1] === 'inspect')).toHaveLength(2);
    expect(commands.filter((argv) => argv[1] === 'rm')).toHaveLength(0);
  });

  it('rejects duplicate cleanup task membership before discovery or removal', async () => {
    const commands: string[][] = [];
    const executor = async (command: string, argv: readonly string[]) => {
      commands.push([command, ...argv]);
      return { stdout: '', stderr: '' };
    };
    await expect(cleanupFeatureBenchContainers(
      'run-one',
      'b',
      ['task-alpha', 'task-alpha'],
      executor,
    )).rejects.toThrow(/membership contains duplicates/);
    expect(commands).toHaveLength(0);
  });
});

describe('pinned native fb commands', () => {
  it('scales the outer inference watchdog by bounded concurrency waves', () => {
    expect(featureBenchInferenceWatchdogMs(100, 4, 43_200_000, 'a')).toBe(1_080_030_000);
    expect(featureBenchInferenceWatchdogMs(100, 4, 43_200_000, 'b')).toBe(1_251_030_000);
    expect(featureBenchInferenceWatchdogMs(1, 4, 60_000, 'a')).toBe(90_000);
    expect(featureBenchInferenceWatchdogMs(1, 4, 60_000, 'b')).toBe(450_000);
    expect(() => featureBenchInferenceWatchdogMs(0, 4, 60_000, 'a')).toThrow(/positive safe integers/);
    expect(() => featureBenchInferenceWatchdogMs(100, 4, Number.MAX_SAFE_INTEGER, 'b'))
      .toThrow(/safe range/);
  });

  it('plans upstream infer and eval with CPU policy and the immutable task set', () => {
    const run = planFeatureBenchRun(prepared(), manifest(), {
      brokerUrl: 'https://broker.test/v1', restrictedNetwork: 'featurebench-private',
    }, '/run/native', '/private/config.toml');
    expect(run.infer.command).toBe('/prepared/.venv/bin/fb');
    expect(run.infer.argv).toEqual([
      'infer', '--config-path', '/private/config.toml', '--agent', 'codex', '--model', 'gpt-test',
      '--dataset', FEATUREBENCH_DATASET, '--split', FEATUREBENCH_SPLIT,
      '--task-id', ...TASK_IDS, '--n-attempts', '1', '--n-concurrent', '4',
      '--timeout', '60', '--output-dir', '/run/native',
    ]);
    expect(run.config).toContain('FEATUREBENCH_CPU_ONLY = "1"');
    expect(run.config).toContain('FEATUREBENCH_DATASET_PARQUET = ".git/ultracode-benchmark-dataset.parquet"');
    expect(run.config).toContain('FB_CONTAINER_PIDS = "4096"');
    expect(run.config).toContain('FEATUREBENCH_PROMPT_PREFIX = "ultracode\\n"');
    const armAManifest = structuredClone(manifest());
    armAManifest.experiment.arm = 'a';
    expect(planFeatureBenchRun(prepared(), armAManifest, {
      brokerUrl: 'https://broker.test/v1', restrictedNetwork: 'featurebench-private',
    }, '/run/native').config).not.toContain('FEATUREBENCH_PROMPT_PREFIX');
    const evaluation = planFeatureBenchEval(prepared(), manifest(), '/run/native/output.jsonl', '/private/config.toml');
    expect(evaluation.command).toBe('/prepared/.venv/bin/fb');
    expect(evaluation.argv).toEqual([
      'eval', '--config-path', '/private/config.toml', '--predictions-path', '/run/native/output.jsonl',
      '--dataset', FEATUREBENCH_DATASET, '--split', FEATUREBENCH_SPLIT,
      '--n-concurrent', '3', '--task-id', ...TASK_IDS,
    ]);
  });

  it('keeps native resume on the original complete inference root', () => {
    const resume = planFeatureBenchResume(
      prepared(),
      manifest(),
      '/run/native/2026-07-19__13-00-41',
      '/private/config.toml',
    );
    expect(resume.command).toBe('/prepared/.venv/bin/fb');
    expect(resume.argv).toEqual([
      'infer', '--resume', '/run/native/2026-07-19__13-00-41',
      '--config-path', '/private/config.toml', '--n-concurrent', '4', '--timeout', '60',
    ]);
  });
});

describe('FeatureBench resume and redo assembly', () => {
  it('preserves untouched task receipts while a targeted evaluation is in flight', async () => {
    const runDirectory = nativeFixture();
    let bindings = indexFeatureBenchEvidence(
      runDirectory,
      `native/${TIMESTAMP}`,
      TASK_IDS,
      'b',
      '00000000-0000-4000-8000-000000000040',
    ).bindings;
    let revision = 0;
    const receipt = {
      load() { return { revision, bindings }; },
      async update(
        expectedRevision: number,
        mutate: (current: readonly VerifierBinding[]) => readonly VerifierBinding[],
      ) {
        expect(expectedRevision).toBe(revision);
        bindings = [...mutate(bindings)];
        revision += 1;
      },
    } as never;

    await invalidateFeatureBenchEvaluationReceipt(receipt, manifest(), ['task-alpha']);

    expect(bindings.some((binding) => binding.role === 'aggregate-report')).toBe(false);
    expect(bindings.some((binding) => binding.scope.kind === 'task-arm'
      && binding.scope.taskId === 'task-alpha')).toBe(false);
    expect(bindings.some((binding) => binding.scope.kind === 'task-arm'
      && binding.scope.taskId === 'task-beta')).toBe(true);
  });

  it('retries the full immutable task set fresh after null-only history with no native root', () => {
    const outputDirectory = join(temporary(), 'native');
    mkdirSync(outputDirectory);
    const state = {
      attempts: [
        { phase: 'inference', nativePath: null },
        { phase: 'verifier', nativePath: null },
      ],
    } as BenchRunState;

    expect(resolveFeatureBenchResumeRoot(outputDirectory, state, false)).toBeNull();
    const fresh = planFeatureBenchRun(prepared(), manifest(), {
      brokerUrl: 'https://broker.test/v1', restrictedNetwork: 'featurebench-private',
    }, outputDirectory);
    expect(fresh.infer.argv.slice(fresh.infer.argv.indexOf('--task-id') + 1, fresh.infer.argv.indexOf('--n-attempts')))
      .toEqual(TASK_IDS);
    expect(fresh.infer.argv).not.toContain('--resume');
  });

  it('rejects a timestamp root unbound by null-only inference history', () => {
    const outputDirectory = join(temporary(), 'native');
    mkdirSync(join(outputDirectory, TIMESTAMP), { recursive: true });
    const state = {
      attempts: [{ phase: 'inference', nativePath: null }],
    } as BenchRunState;

    expect(() => resolveFeatureBenchResumeRoot(outputDirectory, state, false))
      .toThrow(/unbound timestamped native state/);
  });

  it('ignores null and non-inference history when resolving a mixed resume baseline', () => {
    const outputDirectory = join(temporary(), 'native');
    mkdirSync(join(outputDirectory, TIMESTAMP), { recursive: true });
    const state = {
      attempts: [
        { phase: 'inference', nativePath: null },
        { phase: 'verifier', nativePath: 'native/2026-07-19__13-00-40' },
        { phase: 'inference', nativePath: `native/${TIMESTAMP}` },
      ],
    } as BenchRunState;

    expect(resolveFeatureBenchResumeRoot(outputDirectory, state, false)).toBe(`native/${TIMESTAMP}`);
  });

  it('preserves the first bound root across later redo inference history', () => {
    const outputDirectory = join(temporary(), 'native');
    const original = 'native/2026-07-19__13-00-41';
    const firstRedo = 'native/2026-07-19__13-00-42';
    const secondRedo = 'native/2026-07-19__13-00-43';
    for (const root of [original, firstRedo, secondRedo]) {
      mkdirSync(join(outputDirectory, root.slice('native/'.length)), { recursive: true });
    }
    const state = {
      attempts: [
        { phase: 'inference', nativePath: null },
        { phase: 'inference', nativePath: original },
        { phase: 'inference', nativePath: firstRedo },
        { phase: 'inference', nativePath: secondRedo },
      ],
    } as BenchRunState;

    expect(resolveFeatureBenchResumeRoot(outputDirectory, state, false)).toBe(original);
    expect(resolveFeatureBenchResumeRoot(outputDirectory, state, true)).toBe(original);
  });

  it('rejects redo before receipt, report, or cleanup-state mutation without a bound baseline', async () => {
    const roots = createBenchPathRoots(temporary());
    const redoManifest = { ...manifest(), runId: 'feature-redo-order' } as FeatureBenchManifest;
    const directory = join(roots.resultsRoot, 'featurebench', redoManifest.runId);
    mkdirSync(directory, { recursive: true });
    const jsonReport = join(directory, 'report.json');
    const markdownReport = join(directory, 'report.md');
    writeFileSync(jsonReport, 'existing report');
    writeFileSync(markdownReport, 'existing report');
    const mutations: string[] = [];
    const receipt = {
      load() {
        mutations.push('receipt-load');
        return { revision: 0, bindings: [] };
      },
      async update() { mutations.push('receipt-update'); },
    } as never;
    const state = {
      async updateCurrent() { mutations.push('state-update'); },
    } as never;

    await expect(invalidateFeatureBenchRedo(
      roots,
      redoManifest,
      new Set(['task-alpha']),
      null,
      receipt,
      state,
      '00000000-0000-4000-8000-000000000012',
      new Date('2026-07-20T00:00:00.000Z'),
    )).rejects.toThrow(/state-bound prior inference with a native root/);
    expect(mutations).toEqual([]);
    expect(readFileSync(jsonReport, 'utf8')).toBe('existing report');
    expect(readFileSync(markdownReport, 'utf8')).toBe('existing report');
  });

  it('keeps untouched accepted tasks included when an alpha-only redo fails before evaluation', async () => {
    const selectedTaskIds = ['task-alpha', 'task-beta', 'task-gamma'];
    const runId = 'feature-target-redo';
    const acceptedInvocation = '00000000-0000-4000-8000-000000000031';
    const redoInvocation = '00000000-0000-4000-8000-000000000032';
    const roots = createBenchPathRoots(temporary());
    const runDirectory = join(roots.resultsRoot, 'featurebench', runId);
    const nativeRoot = `native/${TIMESTAMP}`;
    const nativeDirectory = join(runDirectory, ...nativeRoot.split('/'));
    mkdirSync(dirname(nativeDirectory), { recursive: true });
    cpSync(FIXTURE, nativeDirectory, { recursive: true });
    rmSync(join(nativeDirectory, 'README.md'));
    writeFileSync(join(nativeDirectory, 'run_metadata.json'), JSON.stringify({ task_ids: selectedTaskIds }));
    writeFileSync(join(nativeDirectory, 'output.jsonl'), `${selectedTaskIds.map((taskId) =>
      JSON.stringify({ instance_id: taskId, model_patch: '' })).join('\n')}\n`);
    const aggregateFile = join(nativeDirectory, 'report.json');
    const aggregate = JSON.parse(readFileSync(aggregateFile, 'utf8')) as {
      attempt_1: Record<string, unknown> & { submitted_ids: string[]; completed_ids: string[] };
    };
    Object.assign(aggregate.attempt_1, {
      total_instances: 3,
      submitted_instances: 3,
      completed_instances: 3,
      resolved_instances: 3,
      unresolved_instances: 0,
      resolved_rate: 1,
      pass_rate: 1,
      submitted_ids: aggregate.attempt_1.submitted_ids.slice(0, 3),
      completed_ids: aggregate.attempt_1.completed_ids.slice(0, 3),
    });
    writeFileSync(aggregateFile, JSON.stringify(aggregate));
    const indexed = indexFeatureBenchEvidence(
      runDirectory,
      nativeRoot,
      selectedTaskIds,
      'b',
      acceptedInvocation,
    );
    let receiptBindings = completeEvaluationBindings(runDirectory, indexed.bindings);
    let receiptRevision = 0;
    const receipt = {
      load() { return { revision: receiptRevision, bindings: receiptBindings }; },
      async update(
        expectedRevision: number,
        mutate: (bindings: readonly VerifierBinding[]) => readonly VerifierBinding[],
      ) {
        expect(expectedRevision).toBe(receiptRevision);
        receiptBindings = [...mutate(receiptBindings)];
        receiptRevision += 1;
      },
    } as never;
    const acceptedAt = '2026-07-19T13:00:41.000Z';
    const acceptedAttempt = (taskId: string, phase: 'inference' | 'verifier') => ({
      attemptId: `${phase === 'inference' ? '10000000' : '20000000'}-0000-4000-8000-${taskId.endsWith('alpha')
        ? '000000000001' : taskId.endsWith('beta') ? '000000000002' : '000000000003'}`,
      invocationId: acceptedInvocation,
      taskId,
      arm: 'b' as const,
      ordinal: 1,
      phase,
      startedAt: acceptedAt,
      endedAt: acceptedAt,
      elapsedMs: 0,
      nativePath: nativeRoot,
      exitCode: 0,
      signal: null,
      status: 'succeeded' as const,
      failures: [],
      annotations: [],
    });
    let state = {
      attempts: selectedTaskIds.flatMap((taskId) => [
        acceptedAttempt(taskId, 'inference'),
        acceptedAttempt(taskId, 'verifier'),
      ]),
    } as BenchRunState;
    const stateStore = {
      async updateCurrent(update: (current: BenchRunState) => BenchRunState) {
        state = update(state);
        return state;
      },
    } as unknown as BenchRunStateStore;
    const redoManifest = {
      ...manifest(),
      runId,
      experiment: { ...manifest().experiment, taskIds: selectedTaskIds },
      artifacts: {
        executions: selectedTaskIds.map((taskId) => ({ taskId, arm: 'b', nativeRoot })),
      },
    } as FeatureBenchManifest;
    const acceptedBytes = new Map([...new Set(receiptBindings.map((binding) =>
      join(runDirectory, ...binding.path.split('/'))))]
      .map((path) => [path, readFileSync(path, 'utf8')]));

    await invalidateFeatureBenchRedo(
      roots,
      redoManifest,
      new Set(['task-alpha']),
      nativeRoot,
      receipt,
      stateStore,
      redoInvocation,
      new Date('2026-07-20T00:00:00.000Z'),
    );
    await recordFeatureBenchBatchAttempts(
      stateStore,
      redoInvocation,
      ['task-alpha'],
      'b',
      'inference',
      new Date('2026-07-20T00:00:01.000Z'),
      new Date('2026-07-20T00:00:02.000Z'),
      1_000,
      'native/2026-07-20__00-00-01',
      'native-runner-failed',
    );

    expect(state.attempts.filter((attempt) =>
      attempt.invocationId === redoInvocation && attempt.phase === 'verifier')).toEqual([]);
    expect(receiptBindings.some((binding) => binding.role === 'aggregate-report')).toBe(false);
    expect(receiptBindings.some((binding) => binding.scope.kind === 'task-arm'
      && binding.scope.taskId === 'task-alpha')).toBe(false);
    expect(receiptBindings.some((binding) => binding.scope.kind === 'task-arm'
      && binding.scope.taskId === 'task-beta')).toBe(true);
    for (const [path, bytes] of acceptedBytes) expect(readFileSync(path, 'utf8')).toBe(bytes);

    const resolver = createFeatureBenchEvidenceResolver(
      runDirectory,
      redoManifest,
      state,
      receiptBindings,
    );
    const inputs = featureBenchTaskInputs(redoManifest, state, receiptBindings, resolver);
    expect(new Map(inputs.map((input) => [
      input.taskId,
      taskDisposition(input.nativeVerifier, input.failures, input.attemptRunning),
    ]))).toEqual(new Map([
      ['task-alpha', 'infrastructure-excluded'],
      ['task-beta', 'included-native'],
      ['task-gamma', 'included-native'],
    ]));
    expect(resolver.aggregate).toBeNull();
  });

  it('requires every redo target from the new root while sourcing only untouched tasks from history', () => {
    const runDirectory = temporary();
    const accepted = acceptedPredictionSnapshot(runDirectory, '00000000-0000-4000-8000-000000000021', {
      'task-alpha': 'original-alpha',
      'task-beta': 'original-beta',
      'task-gamma': 'original-gamma',
    });
    const current = predictionRoot(runDirectory, '2026-07-19__13-00-42', {
      'task-alpha': 'redo-alpha',
      'task-beta': 'redo-beta',
    });
    const path = consolidateFeatureBenchPredictions(
      runDirectory,
      accepted.state,
      accepted.bindings,
      current,
      '00000000-0000-4000-8000-000000000022',
      ['task-alpha', 'task-beta', 'task-gamma'],
      new Set(['task-alpha', 'task-beta']),
    );
    expect(dirname(path)).toBe(current);
    expect(consolidatedPredictions(runDirectory, path)).toEqual(new Map([
      ['task-alpha', 'redo-alpha'],
      ['task-beta', 'redo-beta'],
      ['task-gamma', 'original-gamma'],
    ]));
  });

  it.each([
    { name: 'missing file', contents: null, error: /current inference output is missing/ },
    {
      name: 'absent rows',
      contents: '',
      error: /current inference output is partial; missing task-alpha, task-beta/,
    },
    { name: 'malformed row', contents: 'not-json\n', error: /current inference output is malformed at line 1/ },
    {
      name: 'wrong task id',
      contents: [
        { instance_id: 'task-alpha', model_patch: 'redo-alpha' },
        { instance_id: 'task-beta', model_patch: 'redo-beta' },
        { instance_id: 'task-gamma', model_patch: 'wrong-root' },
      ].map((value) => JSON.stringify(value)).join('\n'),
      error: /current inference output has wrong task id at line 3: task-gamma/,
    },
    {
      name: 'partial multi-target output',
      contents: `${JSON.stringify({ instance_id: 'task-alpha', model_patch: 'redo-alpha' })}\n`,
      error: /current inference output is partial; missing task-beta/,
    },
    {
      name: 'prediction without a patch',
      contents: `${JSON.stringify({ instance_id: 'task-alpha' })}\n`,
      error: /current inference output is malformed at line 1/,
    },
  ])('rejects $name before publishing verifier input or invoking the evaluator', async ({ contents, error }) => {
    const runDirectory = temporary();
    const original = predictionRoot(runDirectory, '2026-07-19__13-00-41', {
      'task-alpha': 'original-alpha',
      'task-beta': 'original-beta',
      'task-gamma': 'original-gamma',
    });
    const current = 'native/2026-07-19__13-00-42';
    const currentDirectory = join(runDirectory, ...current.split('/'));
    mkdirSync(currentDirectory, { recursive: true });
    if (contents !== null) writeFileSync(join(currentDirectory, 'output.jsonl'), contents);
    const state = {
      invocations: [],
      attempts: [original, current].map((nativePath) => ({ phase: 'inference', nativePath })),
    } as BenchRunState;
    let verifierReceiptPublications = 0;
    let evaluatorInvocations = 0;
    const evaluate = async (): Promise<void> => {
      consolidateFeatureBenchPredictions(
        runDirectory,
        state,
        [],
        current,
        '00000000-0000-4000-8000-000000000023',
        ['task-alpha', 'task-beta', 'task-gamma'],
        new Set(['task-alpha', 'task-beta']),
      );
      verifierReceiptPublications += 1;
      evaluatorInvocations += 1;
    };

    await expect(evaluate()).rejects.toThrow(error);
    expect(verifierReceiptPublications).toBe(0);
    expect(evaluatorInvocations).toBe(0);
    expect(existsSync(join(currentDirectory,
      'consolidated-output-00000000-0000-4000-8000-000000000023.jsonl'))).toBe(false);
  });

  it.each([
    'native-runner-failed',
    'driver-watchdog',
    'descendant-cleanup-failed',
  ] as const)('blocks verifier preparation after %s even when inference wrote complete output', (failure) => {
    const runDirectory = temporary();
    const current = predictionRoot(runDirectory, '2026-07-19__13-00-45', {
      'task-alpha': 'alpha', 'task-beta': 'beta', 'task-gamma': 'gamma',
    });
    let verifierPreparations = 0;
    expect(() => {
      assertFeatureBenchInferenceReady(current, failure);
      verifierPreparations += 1;
    }).toThrow(`FeatureBench inference failed: ${failure}`);
    expect(verifierPreparations).toBe(0);
  });

  it('does not treat a pid-less spawn callback as evaluator launch', () => {
    expect(featureBenchEvaluatorLaunched(null)).toBe(false);
    expect(featureBenchEvaluatorLaunched(12_345)).toBe(true);
  });

  it('keeps redo predictions on a subsequent ordinary resume', () => {
    const runDirectory = temporary();
    const original = predictionRoot(runDirectory, '2026-07-19__13-00-41', {
      'task-alpha': 'original-alpha',
      'task-beta': 'original-beta',
    });
    const accepted = acceptedPredictionSnapshot(runDirectory, '00000000-0000-4000-8000-000000000024', {
      'task-alpha': 'redo-alpha', 'task-beta': 'original-beta',
    });

    const path = consolidateFeatureBenchPredictions(
      runDirectory,
      accepted.state,
      accepted.bindings,
      original,
      '00000000-0000-4000-8000-000000000025',
      ['task-alpha', 'task-beta'],
    );
    expect(consolidatedPredictions(runDirectory, path)).toEqual(new Map([
      ['task-alpha', 'redo-alpha'],
      ['task-beta', 'original-beta'],
    ]));
  });

  it('sources history only from the newest accepted invocation snapshot', () => {
    const runDirectory = temporary();
    const first = acceptedPredictionSnapshot(runDirectory, '00000000-0000-4000-8000-000000000026', {
      'task-alpha': 'original-alpha', 'task-beta': 'original-beta', 'task-gamma': 'original-gamma',
    });
    const latest = acceptedPredictionSnapshot(runDirectory, '00000000-0000-4000-8000-000000000027', {
      'task-alpha': 'latest-redo-alpha', 'task-beta': 'second-redo-beta', 'task-gamma': 'original-gamma',
    });
    const rejected = predictionRoot(runDirectory, '2026-07-19__13-00-44', {
      'task-alpha': 'rejected-alpha', 'task-delta': 'rejected-delta',
    });
    const state = {
      invocations: [...first.state.invocations, ...latest.state.invocations],
      attempts: [
        ...first.state.attempts,
        { invocationId: '00000000-0000-4000-8000-000000000028', phase: 'inference', nativePath: rejected,
          status: 'failed', failures: ['native-runner-failed'] },
        ...latest.state.attempts,
      ],
    } as BenchRunState;

    const path = consolidateFeatureBenchPredictions(
      runDirectory,
      state,
      [...first.bindings, ...latest.bindings],
      rejected,
      '00000000-0000-4000-8000-000000000029',
      ['task-alpha', 'task-beta', 'task-gamma'],
    );
    expect(consolidatedPredictions(runDirectory, path)).toEqual(new Map([
      ['task-alpha', 'latest-redo-alpha'],
      ['task-beta', 'second-redo-beta'],
      ['task-gamma', 'original-gamma'],
    ]));
  });

  it('rejects an accepted prediction snapshot outside its verifier timestamp root', () => {
    const runDirectory = temporary();
    const accepted = acceptedPredictionSnapshot(runDirectory, '00000000-0000-4000-8000-000000000033', {
      'task-alpha': 'original-alpha', 'task-beta': 'original-beta',
    });
    const input = accepted.bindings.find((binding) => binding.role === 'verifier-input')!;
    const wrongRoot = 'native/2026-07-19__13-00-43';
    const wrongPath = `${wrongRoot}/consolidated-output-${input.invocationId}.jsonl`;
    mkdirSync(join(runDirectory, ...wrongRoot.split('/')), { recursive: true });
    renameSync(
      join(runDirectory, ...input.path.split('/')),
      join(runDirectory, ...wrongPath.split('/')),
    );
    const bindings = accepted.bindings.map((binding) =>
      binding.path === input.path ? { ...binding, path: wrongPath } : binding);
    const current = predictionRoot(runDirectory, '2026-07-19__13-00-42', {
      'task-alpha': 'redo-alpha',
    });

    expect(() => consolidateFeatureBenchPredictions(
      runDirectory,
      accepted.state,
      bindings,
      current,
      '00000000-0000-4000-8000-000000000034',
      ['task-alpha', 'task-beta'],
      new Set(['task-alpha']),
    )).toThrow(/cannot build complete FeatureBench verifier input; missing task-beta/);
  });

  it.each([
    { name: 'prediction input', role: 'verifier-input' },
    { name: 'evaluation invocation', role: 'verifier-invocation' },
  ] as const)('rejects a later-mutated accepted $name', ({ role }) => {
    const runDirectory = temporary();
    const accepted = acceptedPredictionSnapshot(runDirectory, '00000000-0000-4000-8000-000000000035', {
      'task-alpha': 'original-alpha', 'task-beta': 'original-beta',
    });
    const binding = accepted.bindings.find((candidate) => candidate.role === role)!;
    writeFileSync(join(runDirectory, ...binding.path.split('/')), 'mutated\n');

    expect(() => consolidateFeatureBenchPredictions(
      runDirectory,
      accepted.state,
      accepted.bindings,
      `native/${TIMESTAMP}`,
      '00000000-0000-4000-8000-000000000036',
      ['task-alpha', 'task-beta'],
    )).toThrow(/accepted FeatureBench verifier (?:input|invocation) changed after receipt binding/);
  });

  it('does not accept a snapshot backed by only one successful task attempt', () => {
    const runDirectory = temporary();
    const accepted = acceptedPredictionSnapshot(runDirectory, '00000000-0000-4000-8000-000000000037', {
      'task-alpha': 'original-alpha', 'task-beta': 'original-beta',
    });
    accepted.state.attempts.splice(1);
    const current = predictionRoot(runDirectory, '2026-07-19__13-00-42', {
      'task-alpha': 'redo-alpha',
    });

    expect(() => consolidateFeatureBenchPredictions(
      runDirectory,
      accepted.state,
      accepted.bindings,
      current,
      '00000000-0000-4000-8000-000000000038',
      ['task-alpha', 'task-beta'],
      new Set(['task-alpha']),
    )).toThrow(/cannot build complete FeatureBench verifier input; missing task-beta/);
  });

  it('shares one timing group per redo and resume batch process', async () => {
    let state = { attempts: [] } as unknown as BenchRunState;
    const store = {
      async updateCurrent(update: (current: BenchRunState) => BenchRunState) {
        state = update(state);
        return state;
      },
    } as unknown as BenchRunStateStore;
    const started = new Date('2026-07-20T00:00:00.000Z');
    const ended = new Date('2026-07-20T00:00:01.000Z');
    const redoInvocation = '00000000-0000-4000-8000-000000000010';
    const resumeInvocation = '00000000-0000-4000-8000-000000000011';
    await recordFeatureBenchBatchAttempts(
      store, redoInvocation, ['task-alpha', 'task-beta'], 'b', 'inference',
      started, ended, 1_000, 'native/2026-07-19__13-00-42', null,
    );
    await recordFeatureBenchBatchAttempts(
      store, redoInvocation, TASK_IDS, 'b', 'verifier',
      started, ended, 1_000, 'native/2026-07-19__13-00-42', null,
    );
    await recordFeatureBenchBatchAttempts(
      store, resumeInvocation, TASK_IDS, 'b', 'inference',
      started, ended, 1_000, 'native/2026-07-19__13-00-41', null,
    );
    await recordFeatureBenchBatchAttempts(
      store, resumeInvocation, TASK_IDS, 'b', 'verifier',
      started, ended, 1_000, 'native/2026-07-19__13-00-41', null,
    );

    const batches = [
      state.attempts.filter((attempt) => attempt.invocationId === redoInvocation && attempt.phase === 'inference'),
      state.attempts.filter((attempt) => attempt.invocationId === redoInvocation && attempt.phase === 'verifier'),
      state.attempts.filter((attempt) => attempt.invocationId === resumeInvocation && attempt.phase === 'inference'),
      state.attempts.filter((attempt) => attempt.invocationId === resumeInvocation && attempt.phase === 'verifier'),
    ];
    expect(batches.map((batch) => new Set(batch.map((attempt) => attempt.timingGroupId)).size))
      .toEqual([1, 1, 1, 1]);
    expect(new Set(batches.map((batch) => batch[0]!.timingGroupId)).size).toBe(4);
  });
});

describe('FeatureBench CLI configuration boundary', () => {
  it('declares only the four fresh-run configuration overrides', () => {
    expect(featureBenchAdapter.commands.run.options.map(({ name }) => name)).toEqual([
      'run-id', 'model', 'effort', 'arm', 'task-id', 'resume', 'redo', 'recover-stale-lock',
    ]);
    expect(featureBenchAdapter.commands.run.parse([
      '--run-id', 'feature-one', '--model', 'gpt-test', '--effort', 'high', '--arm', 'b',
      '--task-id', 'task-alpha', '--task-id', 'task-beta',
    ])).toMatchObject({
      model: 'gpt-test', requestedEffort: 'high', arm: 'b', taskIds: ['task-alpha', 'task-beta'],
    });
  });

  it.each([
    'broker-public-identity',
    'broker-public-version',
    'inference-concurrency',
    'evaluation-concurrency',
    'inference-timeout-ms',
    'evaluation-timeout-ms',
    'cpus',
    'memory-bytes',
    'pids',
    'pricing',
  ])('rejects config-only --%s', (name) => {
    expect(() => featureBenchAdapter.commands.run.parse([
      '--run-id', 'feature-one', `--${name}`, 'value',
    ])).toThrow(`unknown option '--${name}'`);
  });
});

describe('FeatureBench official verifier evidence', () => {
  it('binds timestamped metadata, predictions, every task report, completion, and aggregate', () => {
    const runDirectory = nativeFixture();
    const evidence = indexFeatureBenchEvidence(
      runDirectory, `native/${TIMESTAMP}`, TASK_IDS, 'b', '00000000-0000-4000-8000-000000000001',
    );
    expect(evidence.bindings.map((binding) => binding.role)).toEqual([
      'run-metadata',
      'rollout-output',
      ...TASK_IDS.flatMap(() => ['task-report', 'completion-marker']),
      'aggregate-report',
    ]);
    expect(evidence.taskResults.get('task-epsilon')).toMatchObject({
      verification: 'verified', score: 0.755, resolved: false,
    });
    expect(evidence.aggregate).toMatchObject({
      passRate: 0.951, resolvedRate: 0.8, completedTasks: 5, requestedTasks: 5,
    });
    const complete = completeEvaluationBindings(runDirectory, evidence.bindings);
    expect(hasCompleteFeatureBenchTaskReceipt(
      complete,
      '00000000-0000-4000-8000-000000000001',
      'task-alpha',
      'b',
    )).toBe(true);
    const withoutAggregate = complete.filter((binding) => binding.role !== 'aggregate-report');
    expect(hasCompleteFeatureBenchTaskReceipt(
      withoutAggregate,
      '00000000-0000-4000-8000-000000000001',
      'task-alpha',
      'b',
    )).toBe(true);
    expect(hasCompleteFeatureBenchReceipt(
      withoutAggregate,
      '00000000-0000-4000-8000-000000000001',
      TASK_IDS,
      'b',
    )).toBe(false);
    expect(hasCompleteFeatureBenchReceipt(
      complete,
      '00000000-0000-4000-8000-000000000001',
      TASK_IDS,
      'b',
    )).toBe(true);
    expect(hasCompleteFeatureBenchReceipt(
      complete.filter((binding) => binding.role !== 'completion-marker'),
      '00000000-0000-4000-8000-000000000001',
      TASK_IDS,
      'b',
    )).toBe(false);
    expect(hasCompleteFeatureBenchTaskReceipt(
      complete.map((binding) => binding.role === 'run-metadata'
        ? { ...binding, path: 'native/2026-07-19__13-00-42/run_metadata.json' }
        : binding),
      '00000000-0000-4000-8000-000000000001',
      'task-alpha',
      'b',
    )).toBe(false);
    expect(hasCompleteFeatureBenchTaskReceipt(
      complete.map((binding) => binding.role === 'verifier-input'
        ? {
            ...binding,
            path: `native/2026-07-19__13-00-42/consolidated-output-${binding.invocationId}.jsonl`,
          }
        : binding),
      '00000000-0000-4000-8000-000000000001',
      'task-alpha',
      'b',
    )).toBe(false);
  });

  it('binds a successful targeted redo through task and aggregate receipt assembly', () => {
    const runDirectory = nativeFixture();
    const nativeRoot = `native/${TIMESTAMP}`;
    const nativeDirectory = join(runDirectory, ...nativeRoot.split('/'));
    const invocationId = '00000000-0000-4000-8000-000000000041';
    writeFileSync(join(nativeDirectory, 'run_metadata.json'), JSON.stringify({ task_ids: ['task-alpha'] }));
    writeFileSync(join(nativeDirectory, 'output.jsonl'), `${JSON.stringify({
      instance_id: 'task-alpha',
      model_patch: 'redo-alpha',
    })}\n`);
    const evidence = indexFeatureBenchEvidence(
      runDirectory,
      nativeRoot,
      TASK_IDS,
      'b',
      invocationId,
      ['task-alpha'],
    );
    const complete = completeEvaluationBindings(runDirectory, evidence.bindings);

    expect(evidence.bindings.some((binding) => binding.role === 'rollout-output')).toBe(true);
    expect(TASK_IDS.every((taskId) => hasCompleteFeatureBenchTaskReceipt(
      complete,
      invocationId,
      taskId,
      'b',
    ))).toBe(true);
    expect(hasCompleteFeatureBenchReceipt(complete, invocationId, TASK_IDS, 'b')).toBe(true);
    expect(() => indexFeatureBenchEvidence(
      runDirectory,
      nativeRoot,
      TASK_IDS,
      'b',
      invocationId,
      ['foreign-task'],
    )).toThrow(/subset is not within the task inventory/);
  });

  it.each([
    { name: 'run metadata', role: 'run-metadata' },
    { name: 'rollout output', role: 'rollout-output' },
    { name: 'evaluation input', role: 'verifier-input' },
    { name: 'evaluation invocation', role: 'verifier-invocation' },
  ] as const)('rejects task and aggregate evidence after $name bytes drift', ({ role }) => {
    const runDirectory = nativeFixture();
    const invocationId = '00000000-0000-4000-8000-000000000006';
    const bindings = completeEvaluationBindings(runDirectory, indexFeatureBenchEvidence(
      runDirectory,
      `native/${TIMESTAMP}`,
      TASK_IDS,
      'b',
      invocationId,
    ).bindings);
    const binding = bindings.find((candidate) => candidate.role === role)!;
    writeFileSync(join(runDirectory, ...binding.path.split('/')), 'mutated\n');
    const state = {
      attempts: TASK_IDS.map((taskId) => ({
        invocationId,
        taskId,
        phase: 'verifier',
        nativePath: `native/${TIMESTAMP}`,
      })),
    } as BenchRunState;

    const resolver = createFeatureBenchEvidenceResolver(runDirectory, manifest(), state, bindings);
    expect(TASK_IDS.map((taskId) => resolver.taskResults.get(taskId)?.verification))
      .toEqual(TASK_IDS.map(() => 'unverified'));
    expect(resolver.aggregate).toBeNull();
  });

  it('keeps valid per-task evidence but rejects an inconsistent run aggregate', () => {
    const runDirectory = nativeFixture();
    const report = join(runDirectory, 'native', TIMESTAMP, 'report.json');
    const value = JSON.parse(readFileSync(report, 'utf8')) as { attempt_1: { pass_rate: number } };
    value.attempt_1.pass_rate = 0.8;
    writeFileSync(report, JSON.stringify(value));
    const evidence = indexFeatureBenchEvidence(
      runDirectory, `native/${TIMESTAMP}`, TASK_IDS, 'a', '00000000-0000-4000-8000-000000000002',
    );
    expect([...evidence.taskResults.values()].every((result) => result.verification === 'verified')).toBe(true);
    expect(evidence.aggregate).toBeNull();
    expect(evidence.bindings.some((binding) => binding.role === 'aggregate-report')).toBe(false);
  });

  it('indexes each unique root once per assembly and preserves receipt-bound fallback', () => {
    const runDirectory = nativeFixture();
    const latestTimestamp = '2026-07-19__13-00-42';
    cpSync(
      join(runDirectory, 'native', TIMESTAMP),
      join(runDirectory, 'native', latestTimestamp),
      { recursive: true },
    );
    const older = completeEvaluationBindings(runDirectory, indexFeatureBenchEvidence(
      runDirectory, `native/${TIMESTAMP}`, TASK_IDS, 'b', '00000000-0000-4000-8000-000000000020',
    ).bindings);
    const latest = completeEvaluationBindings(runDirectory, indexFeatureBenchEvidence(
      runDirectory, `native/${latestTimestamp}`, TASK_IDS, 'b', '00000000-0000-4000-8000-000000000021',
    ).bindings);
    const latestWithoutAlpha = latest.filter((binding) =>
      binding.scope.kind !== 'task-arm' || binding.scope.taskId !== 'task-alpha');
    const state = {
      attempts: [
        ...TASK_IDS.map((taskId) => ({
          taskId, phase: 'verifier', nativePath: `native/${TIMESTAMP}`,
        })),
        ...TASK_IDS.map((taskId) => ({
          taskId, phase: 'verifier', nativePath: `native/${latestTimestamp}`,
        })),
      ],
    } as BenchRunState;
    const indexedRoots: string[] = [];
    const indexer: typeof indexFeatureBenchEvidence = (...args) => {
      indexedRoots.push(args[1]);
      return indexFeatureBenchEvidence(...args);
    };

    const resolver = createFeatureBenchEvidenceResolver(
      runDirectory,
      manifest(),
      state,
      [...older, ...latestWithoutAlpha],
      indexer,
    );
    expect(indexedRoots).toEqual([`native/${latestTimestamp}`, `native/${TIMESTAMP}`]);
    expect(TASK_IDS.map((taskId) => resolver.taskResults.get(taskId)?.verification))
      .toEqual(TASK_IDS.map(() => 'verified'));
    expect(resolver.taskResults.get('task-alpha')?.artifact?.path).toContain(TIMESTAMP);
    expect(resolver.taskResults.get('task-beta')?.artifact?.path).toContain(latestTimestamp);
    expect(resolver.aggregate?.artifact.path).toContain(TIMESTAMP);

    createFeatureBenchEvidenceResolver(
      runDirectory,
      manifest(),
      state,
      [...older, ...latestWithoutAlpha],
      indexer,
    );
    expect(indexedRoots).toHaveLength(4);
  });

  it('rejects unbound or non-timestamp native roots', () => {
    const runDirectory = nativeFixture();
    expect(() => indexFeatureBenchEvidence(
      runDirectory, 'native/latest', TASK_IDS, 'a', '00000000-0000-4000-8000-000000000003',
    )).toThrow(/exact timestamped directory/);
  });

  it('archives stale fixed-path verifier output before an evaluation rerun', () => {
    const runDirectory = nativeFixture();
    const invocationId = '00000000-0000-4000-8000-000000000004';
    chmodSync(join(runDirectory, 'native'), 0o700);
    archiveFeatureBenchEvaluation(runDirectory, `native/${TIMESTAMP}`, TASK_IDS, invocationId);
    expect(existsSync(join(runDirectory, 'native', TIMESTAMP, 'report.json'))).toBe(false);
    expect(existsSync(join(
      runDirectory,
      'native',
      'invocations',
      invocationId,
      'prior-eval',
      'report.json',
    ))).toBe(true);
    expect(existsSync(join(runDirectory, 'native', TIMESTAMP, 'output.jsonl'))).toBe(true);
    expect(existsSync(join(
      runDirectory,
      'native',
      TIMESTAMP,
      'eval_outputs',
      'task-alpha',
      'attempt-1',
      'report.json',
    ))).toBe(false);
  });

  it('leaves prior verifier evidence in place when archival preflight fails', () => {
    const runDirectory = nativeFixture();
    const invocationId = '00000000-0000-4000-8000-000000000005';
    const blocker = join(
      runDirectory,
      'native',
      'invocations',
      invocationId,
      'prior-eval',
      'eval_outputs',
      'task-alpha',
      'attempt-1',
      'report.json',
    );
    mkdirSync(dirname(blocker), { recursive: true });
    let privateDirectory = join(runDirectory, 'native');
    chmodSync(privateDirectory, 0o700);
    for (const component of [
      'invocations', invocationId, 'prior-eval', 'eval_outputs', 'task-alpha', 'attempt-1',
    ]) {
      privateDirectory = join(privateDirectory, component);
      chmodSync(privateDirectory, 0o700);
    }
    writeFileSync(blocker, 'occupied');

    expect(() => archiveFeatureBenchEvaluation(
      runDirectory, `native/${TIMESTAMP}`, TASK_IDS, invocationId,
    )).toThrow(/archive target already exists/);
    expect(existsSync(join(runDirectory, 'native', TIMESTAMP, 'report.json'))).toBe(true);
    expect(existsSync(join(
      runDirectory, 'native', TIMESTAMP, 'eval_outputs', 'task-alpha', 'attempt-1', 'report.json',
    ))).toBe(true);
    expect(existsSync(join(
      runDirectory, 'native', 'invocations', invocationId, 'prior-eval', 'report.json',
    ))).toBe(false);
  });

  it('uses the official aggregate pass rate as the native headline', () => {
    const taskScores = new Map([
      ['task-alpha', 1],
      ['task-beta', 1],
      ['task-gamma', 1],
      ['task-delta', 1],
      ['task-epsilon', 0.755],
    ]);
    const taskResults = TASK_IDS.map((taskId): TaskResult => ({
      taskId,
      arm: 'b',
      nativeVerifier: {
        verification: 'verified', score: taskScores.get(taskId)!, resolved: taskId !== 'task-epsilon',
        artifact: { path: 'native/result.json', sha256: HASH, nativeRecordKey: taskId },
      },
      disposition: 'included-native',
      failures: [],
      annotations: [],
    }));
    const analysis = featureBenchAnalysisHook.analyze({
      suite: 'featurebench',
      manifest: manifest(),
      metrics: {} as never,
      taskResults,
      nativeAnalysisInput: JSON.parse(readFileSync(join(FIXTURE, 'report.json'), 'utf8')) as unknown,
    });
    expect(analysis.native).toMatchObject({ passRate: 0.951, resolvedRate: 0.8 });
    expect(analysis.consistency).toEqual({ taskMeanPassRate: 0.951, matchesAggregate: true });
    expect(analysis.policyAdjusted.passRate).toBe(0.951);
  });
});

describe('FeatureBench state-bound telemetry', () => {
  it('indexes only exact task attempts under timestamp roots', () => {
    const runDirectory = temporary();
    const attempt = join(runDirectory, 'native', TIMESTAMP, 'run_outputs', 'task-alpha', 'attempt-1');
    const hostId = '11111111-1111-4111-8111-111111111111';
    const workerId = '22222222-2222-4222-8222-222222222222';
    mkdirSync(join(attempt, 'codex_sessions'), { recursive: true });
    writeFileSync(join(attempt, 'codex_events.jsonl'), `${JSON.stringify({
      type: 'thread.started', thread_id: hostId,
    })}\n`);
    writeFileSync(join(attempt, 'codex_sessions', `rollout-2026-07-19-${hostId}.jsonl`), '{}\n');
    writeFileSync(join(attempt, 'codex_sessions', `rollout-2026-07-19-${workerId}.jsonl`), '{}\n');
    const workflow = join(attempt, 'ultracode', 'runs', 'wf-one');
    mkdirSync(join(workflow, 'agents', '1-worker'), { recursive: true });
    writeFileSync(join(workflow, 'config.json'), JSON.stringify({ backend: 'codex' }));
    writeFileSync(join(workflow, 'manifest.json'), JSON.stringify({ status: 'completed' }));
    writeFileSync(join(workflow, 'output.json'), JSON.stringify({ agentCount: 1, failures: [], workspaces: [] }));
    writeFileSync(join(workflow, 'agents', '1-worker', 'result.json'), JSON.stringify({
      sessionId: workerId, backend: 'mock',
    }));
    const telemetryManifest = {
      ...manifest(),
      artifacts: { executions: [{ taskId: 'task-alpha', arm: 'b', nativeRoot: 'native' }] },
    } as FeatureBenchManifest;
    const state = {
      attempts: [{
        phase: 'inference',
        nativePath: `native/${TIMESTAMP}`,
        status: 'succeeded',
        taskId: 'task-alpha',
      }],
    } as BenchRunState;
    const indexed = indexFeatureBenchMetrics(telemetryManifest, runDirectory, state);
    expect(indexed.rollouts.map(({ roleHint, backend, billingClass }) => ({ roleHint, backend, billingClass }))).toEqual([
      { roleHint: 'host', backend: 'codex', billingClass: 'billable' },
      { roleHint: 'worker', backend: 'mock', billingClass: 'mock' },
    ]);
    expect(indexed.workflows).toHaveLength(1);
    expect(indexed.workflows[0]).toMatchObject({ workflowId: 'wf-one', status: 'completed', agentCount: 1 });
    expect(() => indexFeatureBenchMetrics(telemetryManifest, runDirectory, {
      ...state,
      attempts: [{ ...state.attempts[0]!, nativePath: 'native/latest' }],
    })).toThrow(/non-timestamp native root/);
  });
});

describe('FeatureBench owned assets', () => {
  it('uses the benchmark label namespace and moved suite layout', () => {
    const patch = readFileSync('bench/suites/featurebench/codex-chatgpt.patch', 'utf8');
    expect(patch).toContain('ultracode.benchmark.{name}');
    expect(patch).toContain('("schema", "suite", "run", "arm", "ownership")');
    expect(patch).toContain('ultracode.benchmark.purpose');
    expect(patch).toContain('FEATUREBENCH_EVALUATOR_NETWORK');
    expect(patch).toContain('No pinned evaluation image digest');
    expect(patch).toContain('pids_limit=pids_limit');
    expect(patch).toContain("const recovery = new Set(['orphaned', 'cleanup-failed'])");
    expect(patch).not.toMatch(/ultracode\.external-run|FEATUREBENCH_RUN_OWNER/);
    expect(readFileSync('bench/suites/featurebench/.gitattributes', 'utf8')).toContain('codex-chatgpt.patch');
  });
});
