/** Offline FeatureBench pins, trust boundary, native commands, and evidence. */
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { acquireBenchLock } from '../../bench/src/shared/locks.js';
import type { FeatureBenchManifest } from '../../bench/src/shared/manifest.js';
import { createBenchPathRoots, writePrivateJsonAtomic } from '../../bench/src/shared/paths.js';
import { sha256Tree } from '../../bench/src/shared/provenance.js';
import type { TaskResult } from '../../bench/src/shared/report.js';
import type { BenchRunState, BenchRunStateStore } from '../../bench/src/shared/run-state.js';
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
  FEATUREBENCH_DATASET_MEMBERSHIP_SCRIPT,
  featureBenchEnvironmentIdentity,
  makeFeatureBenchEnvironmentRelocatable,
  parseFeatureBenchDatasetMap,
  prepareFeatureBenchInputs,
  preflightFeatureBenchUv,
  removeFeatureBenchPythonCacheArtifacts,
  type PreparedFeatureBenchInputs,
} from '../../bench/src/suites/featurebench/prepare.js';
import {
  archiveFeatureBenchEvaluation,
  cleanupFeatureBenchContainers,
  cleanupFeatureBenchRuntimeHomes,
  consolidateFeatureBenchPredictions,
  createFeatureBenchEvidenceResolver,
  featureBenchAnalysisHook,
  featureBenchPolicyLockFile,
  hasCompleteFeatureBenchReceipt,
  inspectFeatureBenchTrustBoundary,
  planFeatureBenchEval,
  planFeatureBenchResume,
  planFeatureBenchRun,
  recordFeatureBenchBatchAttempts,
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

def load_dataset(dataset, *, split, revision):
    expected = json.loads(os.environ["FEATUREBENCH_STUB_EXPECTED"])
    if {"dataset": dataset, "split": split, "revision": revision} != expected:
        raise AssertionError("projection did not use the pinned load_dataset arguments")
    return json.loads(os.environ["FEATUREBENCH_STUB_ROWS"])
`);
  return spawnSync('python3', ['-c', FEATUREBENCH_DATASET_MEMBERSHIP_SCRIPT], {
    encoding: 'utf8',
    env: {
      ...process.env,
      FEATUREBENCH_STUB_EXPECTED: JSON.stringify({
        dataset: FEATUREBENCH_DATASET,
        revision: FEATUREBENCH_DATASET_REVISION,
        split: FEATUREBENCH_SPLIT,
      }),
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
    resources: { cpus: 8, memoryBytes: 24_000_000_000 },
  };
}

function manifest(): FeatureBenchManifest {
  return {
    experiment: { model: 'gpt-test', requestedEffort: 'high', arm: 'b', taskIds: TASK_IDS },
    limits: { hostTaskTimeoutMs: 60_000 },
    suiteConfig: {
      inference: { concurrency: 4, timeoutMs: 60_000 },
      evaluation: { concurrency: 3, timeoutMs: 120_000 },
      resources: { cpus: 8, memoryBytes: 24_000_000_000 },
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
  writeFileSync(python, `#!/bin/sh
MOCK_ADJACENT_PYTHON="$0" exec python3 "$@"
`);
  chmodSync(python, 0o755);
  const fb = join(bin, 'fb');
  writeFileSync(fb, `#!${python}
import os
import sys
print(f"interpreter={os.environ['MOCK_ADJACENT_PYTHON']}")
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
    JSON.stringify({ instance_id: taskId, prediction })).join('\n')}\n`);
  return root;
}

function consolidatedPredictions(runDirectory: string, path: string): Map<string, unknown> {
  return new Map(readFileSync(join(runDirectory, ...path.split('/')), 'utf8').trim().split(/\r?\n/u)
    .map((line) => JSON.parse(line) as { instance_id: string; prediction: unknown })
    .map((prediction) => [prediction.instance_id, prediction.prediction]));
}

describe('FeatureBench immutable inputs and host policy', () => {
  it('freezes upstream source, dataset, split, Python, and pinned inventory', () => {
    const inventory = pinnedInventory();
    expect(FEATUREBENCH_SOURCE_REVISION).toBe('445dcbaec0b2e136061b0acb54e753c0a9f1888e');
    expect(FEATUREBENCH_DATASET_REVISION).toBe('e99d6efdfe511ea832c1b5735c536129561ec96a');
    expect(FEATUREBENCH_SPLIT).toBe('fast');
    expect(FEATUREBENCH_PYTHON_VERSION).toBe('3.13.5');
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
    expect(beforeMove.status, beforeMove.stderr).toBe(0);
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
    expect(result.stdout).toContain(`interpreter=${join(final, 'source', '.venv', 'bin', 'python')}`);
    expect(result.stdout).toContain(`entrypoint=${publishedFb}`);
    expect(result.stdout).toContain('argument=--help');
    expect(result.stdout).toContain(`working=${root}`);
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

  it('serializes every run on one host-wide policy lock identity', async () => {
    const roots = createBenchPathRoots(temporary());
    const lock = featureBenchPolicyLockFile(roots);
    expect(lock).toBe(join(roots.cacheRoot, '.locks', `featurebench-network-${FEATUREBENCH_NETWORK_POLICY_SHA256}.lock`));
    expect(lock).not.toContain('run-one');
    const held = await acquireBenchLock(roots.cacheRoot, lock);
    await expect(acquireBenchLock(roots.cacheRoot, featureBenchPolicyLockFile(roots))).rejects.toThrow(/already held/);
    held.release();
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

  it('uses one common-label discovery for 100 tasks and validates every container before removal', async () => {
    const taskIds = Array.from({ length: 100 }, (_, index) => `task-${index}`);
    const candidates = ['a', 'b', 'c'].map((character) => character.repeat(12));
    const fullIds = ['a', 'b', 'c'].map((character) => character.repeat(64));
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
            'ultracode.benchmark.task': taskIds[index * 40],
            'ultracode.benchmark.purpose': index === 1 ? 'prep' : 'session',
          } },
        }]), stderr: '' };
      }
      return { stdout: '', stderr: '' };
    };
    await expect(cleanupFeatureBenchContainers('run-one', 'b', taskIds, executor)).resolves.toBe(3);
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
    expect(run.config).toContain('FEATUREBENCH_PROMPT_PREFIX = "ultracode\\n\\n"');
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
  it('keeps redo predictions on a subsequent ordinary resume', () => {
    const runDirectory = temporary();
    const original = predictionRoot(runDirectory, '2026-07-19__13-00-41', {
      'task-alpha': 'original-alpha',
      'task-beta': 'original-beta',
    });
    const redo = predictionRoot(runDirectory, '2026-07-19__13-00-42', {
      'task-alpha': 'redo-alpha',
    });
    const state = {
      attempts: [
        { phase: 'inference', nativePath: original },
        { phase: 'inference', nativePath: redo },
        { phase: 'inference', nativePath: original },
      ],
    } as BenchRunState;

    const path = consolidateFeatureBenchPredictions(
      runDirectory,
      state,
      original,
      ['task-alpha', 'task-beta'],
    );
    expect(consolidatedPredictions(runDirectory, path)).toEqual(new Map([
      ['task-alpha', 'redo-alpha'],
      ['task-beta', 'original-beta'],
    ]));
  });

  it('uses the newest persisted prediction across multiple redo roots', () => {
    const runDirectory = temporary();
    const original = predictionRoot(runDirectory, '2026-07-19__13-00-41', {
      'task-alpha': 'original-alpha',
      'task-beta': 'original-beta',
      'task-gamma': 'original-gamma',
    });
    const firstRedo = predictionRoot(runDirectory, '2026-07-19__13-00-42', {
      'task-alpha': 'first-redo-alpha',
    });
    const secondRedo = predictionRoot(runDirectory, '2026-07-19__13-00-43', {
      'task-beta': 'second-redo-beta',
    });
    const latestRedo = predictionRoot(runDirectory, '2026-07-19__13-00-44', {
      'task-alpha': 'latest-redo-alpha',
    });
    const state = {
      attempts: [original, firstRedo, secondRedo, latestRedo].map((nativePath) => ({
        phase: 'inference',
        nativePath,
      })),
    } as BenchRunState;

    const path = consolidateFeatureBenchPredictions(
      runDirectory,
      state,
      latestRedo,
      ['task-alpha', 'task-beta', 'task-gamma'],
    );
    expect(consolidatedPredictions(runDirectory, path)).toEqual(new Map([
      ['task-alpha', 'latest-redo-alpha'],
      ['task-beta', 'second-redo-beta'],
      ['task-gamma', 'original-gamma'],
    ]));
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
    const template = evidence.bindings[0]!;
    const complete = [...evidence.bindings, ...['verifier-input', 'verifier-invocation'].map((role) => ({
      ...template,
      role,
      scope: { kind: 'suite-check', name: role },
      nativeRecordKey: role,
    }))];
    expect(hasCompleteFeatureBenchReceipt(
      complete as never,
      '00000000-0000-4000-8000-000000000001',
      TASK_IDS,
      'b',
    )).toBe(true);
    expect(hasCompleteFeatureBenchReceipt(
      complete.filter((binding) => binding.role !== 'completion-marker') as never,
      '00000000-0000-4000-8000-000000000001',
      TASK_IDS,
      'b',
    )).toBe(false);
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
    const older = indexFeatureBenchEvidence(
      runDirectory, `native/${TIMESTAMP}`, TASK_IDS, 'b', '00000000-0000-4000-8000-000000000020',
    );
    const latest = indexFeatureBenchEvidence(
      runDirectory, `native/${latestTimestamp}`, TASK_IDS, 'b', '00000000-0000-4000-8000-000000000021',
    );
    const latestWithoutAlpha = latest.bindings.filter((binding) =>
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
      [...older.bindings, ...latestWithoutAlpha],
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
      [...older.bindings, ...latestWithoutAlpha],
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

  it('uses the official aggregate pass rate as the native headline', () => {
    const taskResults = TASK_IDS.map((taskId): TaskResult => ({
      taskId,
      arm: 'b',
      nativeVerifier: {
        verification: 'verified', score: 0.8, resolved: true,
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
      nativeAnalysisInput: {
        passRate: 0.951,
        resolvedRate: 0.8,
        completedTasks: 5,
        requestedTasks: 5,
        artifact: { path: 'native/report.json', sha256: HASH, nativeRecordKey: 'attempt_1' },
      },
    });
    expect(analysis.native).toMatchObject({ passRate: 0.951, resolvedRate: 0.8 });
    expect(analysis.consistency.taskMeanPassRate).toBe(0.8);
    expect(analysis.policyAdjusted.passRate).toBe(0.8);
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
    expect(patch).not.toMatch(/ultracode\.external-run|FEATUREBENCH_RUN_OWNER/);
    expect(readFileSync('bench/suites/featurebench/.gitattributes', 'utf8')).toContain('codex-chatgpt.patch');
  });
});
