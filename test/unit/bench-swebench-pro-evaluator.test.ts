/** Offline evaluator invocation, artifact, filtering, and attribution coverage. */
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { acquireBenchLock, type BenchLockHandle } from '../../bench/src/shared/locks.js';
import {
  DEFAULT_METRICS_POLICY,
  emptyMetricsArtifactIndex,
  normalizeBenchMetrics,
} from '../../bench/src/shared/metrics.js';
import {
  createBenchPathRoots,
  createPrivateRunDirectory,
  runLeaseFile,
  runStateLedgerDir,
} from '../../bench/src/shared/paths.js';
import { BenchProcessError, type BenchProcessOptions } from '../../bench/src/shared/process.js';
import {
  MAX_RUN_STATE_LEDGER_RECORD_BYTES,
  type RunStateCrashPoint,
} from '../../bench/src/shared/run-state-ledger.js';
import { BenchRunStateStore } from '../../bench/src/shared/run-state.js';
import type { SwebenchProConfig } from '../../bench/src/suites/swebench-pro/config.js';
import type { SwebenchProContainerPolicy } from '../../bench/src/suites/swebench-pro/container-policy.js';
import { instanceFromRow } from '../../bench/src/suites/swebench-pro/instances.js';
import {
  evaluatorReceiptBindings,
  evaluatorTaskAttribution,
  hasCompleteProVerifierReceipt,
  publishEvaluatorModeResult,
  recordEvaluatorArmAttributions,
  taskReportInputs,
} from '../../bench/src/suites/swebench-pro/runner.js';
import { readTaskStatus, writeTaskStatus } from '../../bench/src/suites/swebench-pro/state.js';
import {
  evaluatorProcessArgv,
  evaluatorPolicyDocument,
  evaluatorPolicyDocumentSha256,
  runOfficialEvaluator,
  type EvaluatorRunResult,
  type EvaluatorProcessExecutor,
} from '../../bench/src/suites/swebench-pro/verifier.js';

const temporaryRoots: string[] = [];
const temporaryLeases: BenchLockHandle[] = [];

afterEach(() => {
  for (const lease of temporaryLeases.splice(0)) lease.release();
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function row(id: string): Record<string, unknown> {
  return {
    instance_id: id,
    repo: 'owner/repo',
    repo_language: 'ts',
    base_commit: 'a'.repeat(40),
    problem_statement: `problem ${id}`,
    requirements: null,
    interface: null,
    fail_to_pass: '[]',
    pass_to_pass: '[]',
    dockerhub_tag: 'owner.repo-task',
    before_repo_set_cmd: 'prepare',
    selected_test_files_to_run: 'test.ts',
    patch: 'gold',
    test_patch: '',
  };
}

const config: SwebenchProConfig = {
  model: 'gpt-test',
  requestedEffort: 'high',
  arm: 'a',
  selection: { taskIds: ['task-a'], count: 1, seed: 7, stratifyBy: 'repo_language' },
  modelTransport: {
    relayIdentity: 'relay-test', relayVersion: 'v1', fixedDestination: 'https://api.openai.com/v1',
  },
  timeouts: { sessionMs: 60_000, verifierMs: 60_000, evaluatorWatchdogMs: 60_000 },
  concurrency: { tasks: 1, verifier: 3 },
  docker: { cpus: 1.5, memoryBytes: 2_000_000, keepImages: false },
  evaluator: {
    repository: 'https://github.com/scaleapi/SWE-bench_Pro-os',
    revision: 'ca10a60a5fcae51e6948ffe1485d4153d421e6c5',
    pipIndex: 'https://pypi.org/simple',
  },
  sanitizeGitHistory: true,
};

const containerPolicy: SwebenchProContainerPolicy = {
  schemaVersion: 1,
  kind: 'ultracode-swebench-pro-container-policy',
  session: {
    pidsLimit: 1_024,
    securityOpt: ['no-new-privileges'],
    capDrop: ['ALL'],
    capAdd: ['CHOWN', 'DAC_OVERRIDE', 'SETGID', 'SETPCAP', 'SETUID'],
    resources: 'manifest-docker',
  },
  evaluator: {
    pidsLimit: 1_024,
    securityOpt: ['no-new-privileges'],
    capDrop: ['ALL'],
    capAdd: [],
    resources: 'manifest-docker',
  },
  reclamation: {
    pidsLimit: 64,
    securityOpt: ['no-new-privileges'],
    capDrop: ['ALL'],
    capAdd: ['CHOWN', 'DAC_OVERRIDE', 'FOWNER'],
    resources: 'manifest-docker',
    networkMode: 'none',
    user: '0:0',
  },
};

function evaluatorFixture() {
  const root = mkdtempSync(join(tmpdir(), 'uc-pro-evaluator-'));
  temporaryRoots.push(root);
  const runDirectory = join(root, 'run');
  const evaluatorDirectory = join(root, 'evaluator');
  mkdirSync(runDirectory, { recursive: true, mode: 0o700 });
  mkdirSync(evaluatorDirectory, { mode: 0o700 });
  return { root, runDirectory, evaluatorDirectory };
}

function outputArgument(argv: readonly string[]): string {
  const index = argv.indexOf('--output_dir');
  if (index < 0 || argv[index + 1] === undefined) throw new Error('missing evaluator output argument');
  return argv[index + 1]!;
}

const emptyDocker = async (argv: readonly string[]): Promise<string> => {
  if (argv[0] === 'ps') return '';
  throw new Error(`unexpected Docker invocation: ${argv.join(' ')}`);
};

const evaluatorImages = new Map(['task-a', 'task-b'].map((taskId) => [taskId, {
  reference: 'jefzda/sweap-images:owner.repo-task',
  localId: `sha256:${'c'.repeat(64)}`,
}]));
const evaluatorInvocationStarts = new Map([
  ['11111111-1111-4111-8111-111111111111', 0],
]);

describe('official SWE-bench Pro evaluator seam', () => {
  it('records exact non-empty invocation and artifacts while filtering native output', async () => {
    const { runDirectory, evaluatorDirectory } = evaluatorFixture();
    const dockerTimeouts: number[] = [];
    const boundedDocker = async (argv: readonly string[], timeoutMs?: number): Promise<string> => {
      dockerTimeouts.push(timeoutMs!);
      return emptyDocker(argv);
    };
    const calls: Array<{ command: string; argv: readonly string[]; options: BenchProcessOptions }> = [];
    const processExecutor: EvaluatorProcessExecutor = async (command, argv, options) => {
      calls.push({ command, argv, options });
      writeFileSync(join(outputArgument(argv), 'eval_results.json'), JSON.stringify({
        'task-a': true,
        'task-b': 'malformed',
        'not-submitted': true,
      }));
      return { stdout: 'ok', stderr: '', exitCode: 0, signal: null, elapsedMs: 4 };
    };
    const prediction = { instance_id: 'task-a', patch: 'diff', prefix: 'armA' };
    const result = await runOfficialEvaluator({
      runDirectory,
      evaluatorDirectory,
      evaluatorPythonBinary: '/test/python',
      config,
      invocationId: '11111111-1111-4111-8111-111111111111',
      runId: 'pilot1',
      armLabel: 'a',
      prefix: 'armA',
      predictions: [prediction],
      instances: [instanceFromRow(row('task-a')), instanceFromRow(row('task-b'))],
      containerPolicy,
      imageIdentities: evaluatorImages,
      invocationStartedMs: evaluatorInvocationStarts,
      docker: boundedDocker,
      processExecutor,
    });
    const verifierRoot = join(runDirectory, 'native/verifier/armA');
    const rawSamples = join(verifierRoot, 'raw-samples.jsonl');
    const predictions = join(verifierRoot, 'predictions.json');
    const output = join(verifierRoot, 'output');
    const policy = join(verifierRoot, 'evaluator-policy.json');
    const policyDocument = evaluatorPolicyDocument(config, containerPolicy);
    expect(calls).toEqual([{
      command: '/test/python',
      argv: evaluatorProcessArgv({
        rawSamples,
        predictions,
        outputDirectory: output,
        policy,
        policySha256: evaluatorPolicyDocumentSha256(policyDocument),
        workers: 3,
        runId: 'pilot1',
        armLabel: 'a',
        invocationId: '11111111-1111-4111-8111-111111111111',
      }),
      options: expect.objectContaining({ cwd: evaluatorDirectory, timeoutMs: 60_000, stream: true }),
    }]);
    expect(result.verdicts).toEqual({ 'task-a': true });
    expect(result.malformedTaskIds).toEqual([]);
    expect(result.processFailure).toBeNull();
    expect(dockerTimeouts.length).toBeGreaterThan(0);
    expect(dockerTimeouts.every((timeoutMs) => Number.isSafeInteger(timeoutMs) && timeoutMs > 0)).toBe(true);
    expect(result.resultRelativePath).toBe('native/verifier/armA/output/eval_results.json');
    expect(readFileSync(rawSamples, 'utf8').trim().split('\n').map((line) => JSON.parse(line))).toEqual([
      expect.objectContaining({ instance_id: 'task-a', before_repo_set_cmd: 'prepare' }),
      expect.objectContaining({ instance_id: 'task-b', selected_test_files_to_run: 'test.ts' }),
    ]);
    expect(JSON.parse(readFileSync(predictions, 'utf8'))).toEqual([prediction]);
    expect(JSON.parse(readFileSync(policy, 'utf8'))).toEqual(policyDocument);
    expect(JSON.parse(readFileSync(join(verifierRoot, 'invocation.json'), 'utf8'))).toMatchObject({
      launched: true,
      exitCode: 0,
      baselineContainerIds: [],
    });
    const bindings = evaluatorReceiptBindings({
      runDirectory,
      invocationId: '11111111-1111-4111-8111-111111111111',
      prefix: 'armA',
      arm: 'a',
      result,
    });
    expect(bindings.map((binding) => [binding.role, binding.scope, binding.nativeRecordKey])).toEqual([
      ['raw-samples', { kind: 'suite-check', name: 'armA-inputs' }, null],
      ['predictions', { kind: 'suite-check', name: 'armA-inputs' }, null],
      ['verifier-invocation', { kind: 'suite-check', name: 'armA-invocation' }, null],
      ['native-config', { kind: 'suite-check', name: 'armA-policy' }, null],
      ['native-result', { kind: 'task-arm', taskId: 'task-a', arm: 'a' }, 'task-a'],
    ]);
    expect(hasCompleteProVerifierReceipt(
      bindings,
      '11111111-1111-4111-8111-111111111111',
    )).toBe(true);
    expect(hasCompleteProVerifierReceipt(
      bindings,
      '11111111-1111-4111-8111-111111111111',
      'a',
    )).toBe(true);
    expect(hasCompleteProVerifierReceipt(
      bindings,
      '11111111-1111-4111-8111-111111111111',
      'b',
    )).toBe(false);
  });

  it('keeps partial native booleans separate from a process failure', async () => {
    const { runDirectory, evaluatorDirectory } = evaluatorFixture();
    const processExecutor: EvaluatorProcessExecutor = async (_command, argv) => {
      writeFileSync(join(outputArgument(argv), 'eval_results.json'), JSON.stringify({ 'task-a': false }));
      throw new BenchProcessError('python exited 7', {
        stdout: '', stderr: 'failure', exitCode: 7, signal: null, elapsedMs: 9,
      });
    };
    const result = await runOfficialEvaluator({
      runDirectory,
      evaluatorDirectory,
      evaluatorPythonBinary: '/test/python',
      config,
      invocationId: '11111111-1111-4111-8111-111111111111',
      runId: 'pilot1',
      armLabel: 'a',
      prefix: 'armA',
      predictions: [{ instance_id: 'task-a', patch: 'diff', prefix: 'armA' }],
      instances: [instanceFromRow(row('task-a'))],
      containerPolicy,
      imageIdentities: evaluatorImages,
      invocationStartedMs: evaluatorInvocationStarts,
      docker: emptyDocker,
      processExecutor,
    });
    expect(result.verdicts).toEqual({ 'task-a': false });
    expect(result.processFailure).toBe('verifier-process-failed');
    expect(JSON.parse(readFileSync(join(runDirectory, 'native/verifier/armA/invocation.json'), 'utf8')))
      .toMatchObject({ exitCode: 7, launched: true });
  });

  it('attributes phase, receipt path, ordinal, and failure per submitted task', () => {
    const result = {
      verdicts: { 'task-a': true },
      malformedTaskIds: ['task-b'],
      resultRelativePath: 'native/verifier/armA/output/eval_results.json',
      rawSamplesRelativePath: 'native/verifier/armA/raw-samples.jsonl',
      predictionsRelativePath: 'native/verifier/armA/predictions.json',
      invocationRelativePath: 'native/verifier/armA/invocation.json',
      policyRelativePath: 'native/verifier/armA/evaluator-policy.json',
      processFailure: null,
      startedAt: '2026-07-20T00:00:00.000Z',
      endedAt: '2026-07-20T00:00:01.000Z',
      elapsedMs: 1_000,
      artifactSha256: {},
    } as const;
    const execution = (taskId: string) => ({
      taskId,
      arm: 'a' as const,
      key: `${taskId}-${'a'.repeat(64)}`,
      nativeRoot: `native/tasks/${taskId}/a`,
    });
    expect(evaluatorTaskAttribution({
      result,
      execution: execution('not-submitted') as never,
      submitted: new Set(['task-a', 'task-b']),
      invocationId: 'invocation',
      attemptId: 'attempt-none',
      ordinal: 1,
    })).toBeNull();
    expect(evaluatorTaskAttribution({
      result,
      execution: execution('task-a') as never,
      submitted: new Set(['task-a', 'task-b']),
      invocationId: 'invocation',
      attemptId: 'attempt-a',
      ordinal: 4,
    })).toEqual({
      phase: 'evaluated',
      attempt: expect.objectContaining({
        attemptId: 'attempt-a', taskId: 'task-a', arm: 'a', ordinal: 4,
        phase: 'verifier', status: 'succeeded', failures: [], exitCode: 0,
        nativePath: 'native/verifier/armA/output/eval_results.json',
      }),
    });
    expect(evaluatorTaskAttribution({
      result,
      execution: execution('task-b') as never,
      submitted: new Set(['task-a', 'task-b']),
      invocationId: 'invocation',
      attemptId: 'attempt-b',
      ordinal: 2,
    })?.attempt).toMatchObject({
      taskId: 'task-b', status: 'failed', failures: ['verifier-output-malformed'], exitCode: 1,
    });
  });

  it('does not reuse an old arm result when the latest arm receipt was not published', () => {
    const { runDirectory } = evaluatorFixture();
    const taskDirectory = join(runDirectory, 'native/tasks/task-a/a');
    mkdirSync(taskDirectory, { recursive: true, mode: 0o700 });
    writeTaskStatus(taskDirectory, {
      schemaVersion: 2,
      phase: 'evaluated',
      failure: null,
      annotations: [],
    });
    const oldResultPath = 'native/verifier/old/output/eval_results.json';
    mkdirSync(join(runDirectory, 'native/verifier/old/output'), { recursive: true, mode: 0o700 });
    const oldResult = '{"task-a":true}\n';
    writeFileSync(join(runDirectory, oldResultPath), oldResult);
    const oldInvocation = '11111111-1111-4111-8111-111111111111';
    const latestInvocation = '22222222-2222-4222-8222-222222222222';
    const armBReceipt = [
      ['raw-samples', 'armB-inputs'],
      ['predictions', 'armB-inputs'],
      ['verifier-invocation', 'armB-invocation'],
      ['native-config', 'armB-policy'],
    ].map(([role, name]) => ({
      invocationId: latestInvocation,
      scope: { kind: 'suite-check', name },
      role,
      path: `native/verifier/armB/${role}.json`,
      sha256: 'b'.repeat(64),
      nativeRecordKey: null,
    }));
    const inputs = taskReportInputs({
      artifacts: {
        executions: [{ taskId: 'task-a', arm: 'a', nativeRoot: 'native/tasks/task-a/a' }],
      },
    } as never, {
      attempts: [oldInvocation, latestInvocation].map((invocationId, index) => ({
        invocationId,
        taskId: 'task-a',
        arm: 'a',
        phase: 'verifier',
        status: 'succeeded',
        failures: [],
        annotations: [],
        ordinal: index + 1,
      })),
    } as never, [{
      invocationId: oldInvocation,
      scope: { kind: 'task-arm', taskId: 'task-a', arm: 'a' },
      role: 'native-result',
      path: oldResultPath,
      sha256: createHash('sha256').update(oldResult).digest('hex'),
      nativeRecordKey: 'task-a',
    }, ...armBReceipt] as never, runDirectory);
    expect(inputs[0]!.nativeVerifier).toMatchObject({ verification: 'unverified', score: null });
    expect(inputs[0]!.failures).toEqual([
      expect.objectContaining({ code: 'receipt-incomplete', phase: 'verifier' }),
    ]);
  });

  it('commits a full 731-task arm in one bounded crash-replay-safe revision', async () => {
    const root = mkdtempSync(join(tmpdir(), 'uc-pro-attribution-'));
    temporaryRoots.push(root);
    const paths = createBenchPathRoots(root);
    const runId = 'full731';
    const manifestSha256 = 'a'.repeat(64);
    const invocationId = '11111111-1111-4111-8111-111111111111';
    createPrivateRunDirectory(paths, 'swebench-pro', runId);
    const lease = await acquireBenchLock(
      paths.resultsRoot,
      runLeaseFile(paths, 'swebench-pro', runId),
    );
    temporaryLeases.push(lease);
    let crashPoint: RunStateCrashPoint | null = null;
    const store = new BenchRunStateStore(paths, 'swebench-pro', runId, manifestSha256, lease, {
      onCrashPoint(point) {
        if (point === crashPoint) {
          crashPoint = null;
          throw new Error(`simulated ${point}`);
        }
      },
    });
    store.initialize();
    await store.updateCurrent((state) => ({
      ...state,
      invocations: [...state.invocations, {
        invocationId,
        command: 'eval',
        startedAt: '2026-07-20T00:00:00.000Z',
        endedAt: null,
        activeElapsedMs: null,
        exitCode: null,
        signal: null,
        lifecycleProcesses: [],
        failure: null,
        nativeInvocation: 'native',
      }],
      attempts: [...state.attempts, {
        attemptId: '00000000-0000-4000-8000-000000009999',
        invocationId,
        taskId: 'task-000',
        arm: 'a',
        ordinal: 1,
        phase: 'session',
        startedAt: '2026-07-20T00:00:00.000Z',
        endedAt: '2026-07-20T00:00:01.000Z',
        elapsedMs: 1_000,
        nativePath: 'native/tasks/task-000/a',
        exitCode: 0,
        signal: null,
        status: 'succeeded',
        failures: [],
        annotations: [],
      }],
    }));
    const taskIds = Array.from({ length: 731 }, (_, index) =>
      `task-${index.toString().padStart(3, '0')}`);
    const executions = taskIds.map((taskId) => ({
      taskId,
      arm: 'a' as const,
      key: `${taskId}-a`,
      nativeRoot: `native/tasks/${taskId}/a`,
    }));
    for (const execution of executions) {
      mkdirSync(join(paths.resultsRoot, 'swebench-pro', runId, execution.nativeRoot), {
        recursive: true,
        mode: 0o700,
      });
    }
    const runDirectory = join(paths.resultsRoot, 'swebench-pro', runId);
    const result: EvaluatorRunResult = {
      verdicts: Object.fromEntries(taskIds.map((taskId, index) => [taskId, index % 2 === 0])),
      malformedTaskIds: [],
      resultRelativePath: 'native/verifier/armA/output/eval_results.json',
      rawSamplesRelativePath: 'native/verifier/armA/raw-samples.jsonl',
      predictionsRelativePath: 'native/verifier/armA/predictions.json',
      invocationRelativePath: 'native/verifier/armA/invocation.json',
      policyRelativePath: 'native/verifier/armA/evaluator-policy.json',
      processFailure: null,
      startedAt: '2026-07-20T00:00:00.000Z',
      endedAt: '2026-07-20T00:00:01.000Z',
      elapsedMs: 1_000,
      artifactSha256: {},
    };
    let attemptIndex = 0;
    const record = (state: BenchRunStateStore) => recordEvaluatorArmAttributions({
      state,
      executions: [
        ...executions,
        { taskId: 'wrong-arm', arm: 'b', key: 'wrong-arm-b', nativeRoot: 'native/tasks/wrong-arm/b' },
        { taskId: 'not-submitted', arm: 'a', key: 'not-submitted-a', nativeRoot: 'native/tasks/not-submitted/a' },
        { taskId: 'missing-directory', arm: 'a', key: 'missing-a', nativeRoot: 'native/tasks/missing/a' },
      ] as never,
      runDirectory,
      arm: 'a',
      result,
      submitted: new Set([...taskIds, 'missing-directory']),
      invocationId,
      attemptId: () => `00000000-0000-4000-8000-${(++attemptIndex).toString(16).padStart(12, '0')}`,
    });

    crashPoint = 'after-ledger-fsync';
    await expect(record(store)).rejects.toThrow(/simulated after-ledger-fsync/);
    const replay = new BenchRunStateStore(paths, 'swebench-pro', runId, manifestSha256, lease);
    expect(replay.load().attempts).toHaveLength(1);
    const revision = replay.load().revision;
    await expect(record(replay)).resolves.toBe(731);
    const committed = replay.load();
    expect(committed.revision).toBe(revision + 1);
    expect(committed.attempts.slice(1).map((attempt) => attempt.taskId)).toEqual(taskIds);
    expect(committed.attempts[1]).toMatchObject({ taskId: 'task-000', ordinal: 2 });
    expect(committed.attempts.at(-1)).toMatchObject({ taskId: 'task-730', ordinal: 1 });
    expect(new Set(committed.attempts.slice(1).map((attempt) => attempt.timingGroupId)).size).toBe(1);
    expect(normalizeBenchMetrics({
      experiment: { model: 'gpt-test', requestedEffort: 'high' },
      metricsPolicy: { ...DEFAULT_METRICS_POLICY, implementationSha256: manifestSha256 },
      pricing: null,
      artifacts: { executions },
    } as never, runDirectory, emptyMetricsArtifactIndex(), committed).timing).toMatchObject({
      verifierMs: 1_000,
      summedTaskMs: 2_000,
    });
    expect(readTaskStatus(join(runDirectory, executions[0]!.nativeRoot)).phase).toBe('evaluated');
    expect(readTaskStatus(join(runDirectory, executions.at(-1)!.nativeRoot)).phase).toBe('evaluated');

    const records = readdirSync(runStateLedgerDir(paths, 'swebench-pro', runId)).flatMap((name) =>
      readFileSync(join(runStateLedgerDir(paths, 'swebench-pro', runId), name), 'utf8')
        .trim().split('\n').filter(Boolean));
    const batchRecord = records.find((line) => {
      const parsed = JSON.parse(line) as { revision: number };
      return parsed.revision === committed.revision;
    });
    expect(batchRecord).toBeDefined();
    expect(Buffer.byteLength(batchRecord!, 'utf8')).toBeLessThan(MAX_RUN_STATE_LEDGER_RECORD_BYTES);
    expect((JSON.parse(batchRecord!) as { payload: { changes: unknown[] } }).payload.changes).toHaveLength(731);
  });

  it('fails closed across both sides of the state-to-receipt publication window', async () => {
    const root = mkdtempSync(join(tmpdir(), 'uc-pro-receipt-window-'));
    temporaryRoots.push(root);
    const paths = createBenchPathRoots(root);
    const runId = 'receiptwindow';
    const manifestSha256 = 'b'.repeat(64);
    const invocationId = '22222222-2222-4222-8222-222222222222';
    createPrivateRunDirectory(paths, 'swebench-pro', runId);
    const lease = await acquireBenchLock(
      paths.resultsRoot,
      runLeaseFile(paths, 'swebench-pro', runId),
    );
    temporaryLeases.push(lease);
    let crash = false;
    const state = new BenchRunStateStore(paths, 'swebench-pro', runId, manifestSha256, lease, {
      onCrashPoint(point) {
        if (crash && point === 'after-ledger-fsync') {
          crash = false;
          throw new Error('simulated verifier-attempt persistence crash');
        }
      },
    });
    state.initialize();
    await state.updateCurrent((current) => ({
      ...current,
      invocations: [...current.invocations, {
        invocationId,
        command: 'eval',
        startedAt: '2026-07-20T00:00:00.000Z',
        endedAt: null,
        activeElapsedMs: null,
        exitCode: null,
        signal: null,
        lifecycleProcesses: [],
        failure: null,
        nativeInvocation: 'native',
      }],
    }));
    const runDirectory = join(paths.resultsRoot, 'swebench-pro', runId);
    const execution = {
      taskId: 'task-a',
      arm: 'a' as const,
      key: 'task-a-a',
      nativeRoot: 'native/tasks/task-a/a',
    };
    mkdirSync(join(runDirectory, execution.nativeRoot), { recursive: true, mode: 0o700 });
    const verifierRoot = join(runDirectory, 'native/verifier/armA');
    mkdirSync(join(verifierRoot, 'output'), { recursive: true, mode: 0o700 });
    const evaluatorArtifacts = [
      ['raw-samples.jsonl', '{}\n'],
      ['predictions.json', '[]\n'],
      ['invocation.json', '{}\n'],
      ['evaluator-policy.json', '{}\n'],
      ['output/eval_results.json', '{"task-a":true}\n'],
    ] as const;
    for (const [path, contents] of evaluatorArtifacts) writeFileSync(join(verifierRoot, path), contents);
    const result: EvaluatorRunResult = {
      verdicts: { 'task-a': true },
      malformedTaskIds: [],
      resultRelativePath: 'native/verifier/armA/output/eval_results.json',
      rawSamplesRelativePath: 'native/verifier/armA/raw-samples.jsonl',
      predictionsRelativePath: 'native/verifier/armA/predictions.json',
      invocationRelativePath: 'native/verifier/armA/invocation.json',
      policyRelativePath: 'native/verifier/armA/evaluator-policy.json',
      processFailure: null,
      startedAt: '2026-07-20T00:00:00.000Z',
      endedAt: '2026-07-20T00:00:01.000Z',
      elapsedMs: 1_000,
      artifactSha256: Object.fromEntries(evaluatorArtifacts.map(([path]) => {
        const relativePath = `native/verifier/armA/${path}`;
        return [relativePath, createHash('sha256').update(readFileSync(join(verifierRoot, path))).digest('hex')];
      })),
    };
    const receiptEvents: string[] = [];
    const receipt = {
      load() {
        receiptEvents.push('load');
        return { revision: 0 };
      },
      async update() {
        receiptEvents.push('publish');
      },
    } as never;
    await expect(publishEvaluatorModeResult({
      state,
      receipt,
      executions: [{ ...execution, nativeRoot: 'native/tasks/missing/a' }] as never,
      runDirectory,
      prefix: 'armA',
      arm: 'a',
      result,
      submitted: new Set(['task-a']),
      invocationId,
    })).rejects.toThrow(/lacks complete task attribution state/);
    expect(receiptEvents).toEqual([]);
    expect(state.load().attempts).toEqual([]);
    crash = true;
    await expect(publishEvaluatorModeResult({
      state,
      receipt,
      executions: [execution] as never,
      runDirectory,
      prefix: 'armA',
      arm: 'a',
      result,
      submitted: new Set(['task-a']),
      invocationId,
      attemptId: () => '00000000-0000-4000-8000-000000000001',
    })).rejects.toThrow(/simulated verifier-attempt persistence crash/);
    expect(receiptEvents).toEqual([]);
    const replay = new BenchRunStateStore(paths, 'swebench-pro', runId, manifestSha256, lease);
    expect(replay.load().attempts).toEqual([]);
    expect(readTaskStatus(join(runDirectory, execution.nativeRoot)).phase).toBe('evaluated');

    const publicationEvents: string[] = [];
    await expect(publishEvaluatorModeResult({
      state: replay,
      receipt: {
        load() {
          publicationEvents.push('load');
          throw new Error('simulated crash after verifier state commit');
        },
        async update() {
          publicationEvents.push('publish');
        },
      } as never,
      executions: [execution] as never,
      runDirectory,
      prefix: 'armA',
      arm: 'a',
      result,
      submitted: new Set(['task-a']),
      invocationId,
      attemptId: () => '00000000-0000-4000-8000-000000000002',
    })).rejects.toThrow(/simulated crash after verifier state commit/);
    expect(publicationEvents).toEqual(['load']);
    const committed = new BenchRunStateStore(paths, 'swebench-pro', runId, manifestSha256, lease);
    expect(committed.load().attempts).toEqual([
      expect.objectContaining({
        attemptId: '00000000-0000-4000-8000-000000000002',
        phase: 'verifier',
        taskId: 'task-a',
      }),
    ]);
  });
});
