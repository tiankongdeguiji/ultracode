/** Offline evaluator invocation, artifact, filtering, and attribution coverage. */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { BenchProcessError, type BenchProcessOptions } from '../../bench/src/shared/process.js';
import type { SwebenchProConfig } from '../../bench/src/suites/swebench-pro/config.js';
import type { SwebenchProContainerPolicy } from '../../bench/src/suites/swebench-pro/container-policy.js';
import { instanceFromRow } from '../../bench/src/suites/swebench-pro/instances.js';
import {
  evaluatorReceiptBindings,
  evaluatorTaskAttribution,
  hasCompleteProVerifierReceipt,
} from '../../bench/src/suites/swebench-pro/runner.js';
import {
  evaluatorProcessArgv,
  evaluatorPolicyDocument,
  runOfficialEvaluator,
  type EvaluatorProcessExecutor,
} from '../../bench/src/suites/swebench-pro/verifier.js';

const temporaryRoots: string[] = [];

afterEach(() => {
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
  auth: { mechanism: 'api-key', publicIdentity: 'test' },
  timeouts: { sessionMs: 60_000, verifierMs: 60_000, evaluatorWatchdogMs: 60_000 },
  concurrency: { tasks: 1, verifier: 3 },
  docker: { cpus: 1.5, memoryBytes: 2_000_000, keepImages: false },
  evaluator: {
    repository: 'https://example.test/evaluator.git',
    revision: 'b'.repeat(40),
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

describe('official SWE-bench Pro evaluator seam', () => {
  it('records exact non-empty invocation and artifacts while filtering native output', async () => {
    const { runDirectory, evaluatorDirectory } = evaluatorFixture();
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
      docker: emptyDocker,
      processExecutor,
    });
    const verifierRoot = join(runDirectory, 'native/verifier/armA');
    const rawSamples = join(verifierRoot, 'raw-samples.jsonl');
    const predictions = join(verifierRoot, 'predictions.json');
    const output = join(verifierRoot, 'output');
    const policy = join(verifierRoot, 'evaluator-policy.json');
    expect(calls).toEqual([{
      command: '/test/python',
      argv: evaluatorProcessArgv({
        rawSamples,
        predictions,
        outputDirectory: output,
        policy,
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
    expect(result.resultRelativePath).toBe('native/verifier/armA/output/eval_results.json');
    expect(readFileSync(rawSamples, 'utf8').trim().split('\n').map((line) => JSON.parse(line))).toEqual([
      expect.objectContaining({ instance_id: 'task-a', before_repo_set_cmd: 'prepare' }),
      expect.objectContaining({ instance_id: 'task-b', selected_test_files_to_run: 'test.ts' }),
    ]);
    expect(JSON.parse(readFileSync(predictions, 'utf8'))).toEqual([prediction]);
    expect(JSON.parse(readFileSync(policy, 'utf8'))).toEqual(evaluatorPolicyDocument(config, containerPolicy));
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
});
