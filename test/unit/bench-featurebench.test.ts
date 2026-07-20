/** Offline FeatureBench pins, trust boundary, native commands, and evidence. */
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { acquireBenchLock } from '../../bench/src/shared/locks.js';
import type { FeatureBenchManifest } from '../../bench/src/shared/manifest.js';
import { createBenchPathRoots, writePrivateJsonAtomic } from '../../bench/src/shared/paths.js';
import type { TaskResult } from '../../bench/src/shared/report.js';
import type { BenchRunState } from '../../bench/src/shared/run-state.js';
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
  parseFeatureBenchDatasetMap,
  type PreparedFeatureBenchInputs,
} from '../../bench/src/suites/featurebench/prepare.js';
import {
  archiveFeatureBenchEvaluation,
  cleanupFeatureBenchContainers,
  cleanupFeatureBenchRuntimeHomes,
  featureBenchAnalysisHook,
  featureBenchPolicyLockFile,
  hasCompleteFeatureBenchReceipt,
  inspectFeatureBenchTrustBoundary,
  planFeatureBenchEval,
  planFeatureBenchRun,
} from '../../bench/src/suites/featurebench/runner.js';
import { indexFeatureBenchMetrics } from '../../bench/src/suites/featurebench/telemetry.js';
import { indexFeatureBenchEvidence } from '../../bench/src/suites/featurebench/verifier.js';

const FIXTURE = resolve('test/fixtures/bench/featurebench');
const TIMESTAMP = '2026-07-19__13-00-41';
const TASK_IDS = ['task-alpha', 'task-beta', 'task-gamma', 'task-delta', 'task-epsilon'];
const HASH = 'a'.repeat(64);
const temporaryRoots: string[] = [];

function temporary(): string {
  const root = mkdtempSync(join(tmpdir(), 'uc-featurebench-test-'));
  temporaryRoots.push(root);
  return root;
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

describe('FeatureBench immutable inputs and host policy', () => {
  it('freezes upstream source, dataset, split, Python, and complete membership', () => {
    expect(FEATUREBENCH_SOURCE_REVISION).toBe('445dcbaec0b2e136061b0acb54e753c0a9f1888e');
    expect(FEATUREBENCH_DATASET_REVISION).toBe('e99d6efdfe511ea832c1b5735c536129561ec96a');
    expect(FEATUREBENCH_SPLIT).toBe('fast');
    expect(FEATUREBENCH_PYTHON_VERSION).toBe('3.13.5');
    expect(parseFeatureBenchDatasetMap({
      dataset: FEATUREBENCH_DATASET,
      revision: FEATUREBENCH_DATASET_REVISION,
      split: FEATUREBENCH_SPLIT,
      tasks: { 'task-alpha': 'example.test/image:tag' },
    }).tasks).toEqual({ 'task-alpha': 'example.test/image:tag' });
    expect(() => parseFeatureBenchDatasetMap({
      dataset: FEATUREBENCH_DATASET,
      revision: 'floating',
      split: FEATUREBENCH_SPLIT,
      tasks: { 'task-alpha': 'example.test/image:tag' },
    })).toThrow(/pinned dataset/);
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

  it('discovers and removes only containers with the complete ownership tuple', async () => {
    const commands: string[][] = [];
    const executor = async (command: string, argv: readonly string[]) => {
      commands.push([command, ...argv]);
      if (argv[0] === 'ps') {
        const session = argv.includes('label=ultracode.benchmark.purpose=session');
        return { stdout: session ? `${'c'.repeat(12)}\n` : '', stderr: '' };
      }
      if (argv[0] === 'inspect') return { stdout: JSON.stringify([{
        Id: 'c'.repeat(64),
        Config: { Labels: {
          'ultracode.benchmark.schema': '2',
          'ultracode.benchmark.suite': 'featurebench',
          'ultracode.benchmark.run': 'run-one',
          'ultracode.benchmark.arm': 'b',
          'ultracode.benchmark.ownership': '1',
          'ultracode.benchmark.task': 'task-alpha',
          'ultracode.benchmark.purpose': 'session',
        } },
      }]), stderr: '' };
      return { stdout: '', stderr: '' };
    };
    await expect(cleanupFeatureBenchContainers('run-one', 'b', ['task-alpha'], executor)).resolves.toBe(1);
    expect(commands.at(-1)).toEqual(['docker', 'rm', '--force', 'c'.repeat(12)]);
    expect(commands[0]!.join(' ')).toContain('label=ultracode.benchmark.ownership=1');
    const discoveries = commands.filter((argv) => argv[1] === 'ps').map((argv) => argv.join(' '));
    expect(discoveries).toHaveLength(2);
    expect(discoveries.every((argv) => argv.includes('label=ultracode.benchmark.task=task-alpha'))).toBe(true);
    expect(discoveries.some((argv) => argv.includes('label=ultracode.benchmark.purpose=prep'))).toBe(true);
    expect(discoveries.some((argv) => argv.includes('label=ultracode.benchmark.purpose=session'))).toBe(true);
  });
});

describe('pinned native fb commands', () => {
  it('plans upstream infer and eval with CPU policy and the immutable task set', () => {
    const run = planFeatureBenchRun(prepared(), manifest(), {
      brokerUrl: 'https://broker.test/v1', restrictedNetwork: 'featurebench-private',
    }, '/run/native', '/private/config.toml');
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
    expect(evaluation.argv).toEqual([
      'eval', '--config-path', '/private/config.toml', '--predictions-path', '/run/native/output.jsonl',
      '--dataset', FEATUREBENCH_DATASET, '--split', FEATUREBENCH_SPLIT,
      '--n-concurrent', '3', '--task-id', ...TASK_IDS,
    ]);
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
