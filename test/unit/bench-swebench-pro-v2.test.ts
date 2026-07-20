/** Focused offline coverage for the final SWE-bench Pro adapter boundary. */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { swebenchProAdapter } from '../../bench/src/suites/swebench-pro/adapter.js';
import { repositoryDigest } from '../../bench/src/suites/swebench-pro/image.js';
import { instanceFromRow, selectInstances } from '../../bench/src/suites/swebench-pro/instances.js';
import { classifyOutcome } from '../../bench/src/suites/swebench-pro/state.js';
import {
  hasCompleteProVerifierReceipt,
  cleanupProRuntimeHomes,
  ownedRunContainerIds,
  retainVerifierBindingsAfterRedo,
} from '../../bench/src/suites/swebench-pro/runner.js';
import {
  ownedEvaluatorContainerIds,
  parseEvaluatorResults,
  runOfficialEvaluator,
} from '../../bench/src/suites/swebench-pro/verifier.js';
import { createBenchPathRoots } from '../../bench/src/shared/paths.js';
import type { SwebenchProConfig } from '../../bench/src/suites/swebench-pro/config.js';

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
    before_repo_set_cmd: '',
    selected_test_files_to_run: '',
    patch: 'gold',
    test_patch: '',
    future_dataset_column: { preserved: true },
  };
}

const config: SwebenchProConfig = {
  model: 'gpt-test',
  requestedEffort: 'high',
  arm: 'both',
  selection: { taskIds: null, count: 1, seed: 7, stratifyBy: 'repo_language' },
  auth: { mechanism: 'api-key', publicIdentity: 'test' },
  timeouts: { sessionMs: 60_000, verifierMs: 60_000, evaluatorWatchdogMs: 60_000 },
  concurrency: { tasks: 1, verifier: 1 },
  docker: { cpus: 1, memoryBytes: 1_000_000, keepImages: false },
  evaluator: {
    repository: 'https://example.test/evaluator.git',
    revision: 'b'.repeat(40),
    pipIndex: 'https://pypi.org/simple',
  },
  sanitizeGitHistory: true,
};

describe('SWE-bench Pro adapter parsing', () => {
  it('declares the exact command set and parses suite-native resume/redo options', () => {
    expect(Object.keys(swebenchProAdapter.commands)).toEqual([
      'fetch', 'prep', 'run', 'eval', 'report', 'status', 'clean',
    ]);
    expect(swebenchProAdapter.commands.run.parse([
      '--run-id', 'pilot1', '--resume', '--redo', 'owner/repo::a', '--task-id', 'owner/repo',
    ])).toMatchObject({
      runId: 'pilot1', resume: true, redo: ['owner/repo::a'], taskIds: ['owner/repo'],
    });
    expect(() => swebenchProAdapter.commands.run.parse(['--run-id', 'pilot1', '--unknown'])).toThrow(/unknown option/);
  });

  it('invalidates every native result in an affected evaluator arm on redo', () => {
    const binding = (taskId: string, arm: 'a' | 'b', role: 'native-result' | 'predictions') => ({
      invocationId: '11111111-1111-4111-8111-111111111111',
      scope: { kind: 'task-arm' as const, taskId, arm },
      role,
      path: `native/${taskId}-${arm}.json`,
      sha256: 'a'.repeat(64),
      nativeRecordKey: taskId,
    });
    const retained = retainVerifierBindingsAfterRedo([
      binding('one', 'a', 'native-result'),
      binding('two', 'a', 'native-result'),
      binding('one', 'b', 'native-result'),
      binding('two', 'a', 'predictions'),
    ] as never, new Set(['one\0a']));
    expect(retained.map((entry) => [entry.scope, entry.role])).toEqual([
      [{ kind: 'task-arm', taskId: 'one', arm: 'b' }, 'native-result'],
      [{ kind: 'task-arm', taskId: 'two', arm: 'a' }, 'predictions'],
    ]);
  });

  it('does not treat a partial Pro verifier receipt as complete', () => {
    const invocationId = '11111111-1111-4111-8111-111111111111';
    const bindings = ['raw-samples', 'predictions', 'verifier-invocation', 'native-config'].map((role) => ({
      invocationId,
      scope: { kind: 'suite-check', name: role },
      role,
      path: `native/${role}.json`,
      sha256: 'a'.repeat(64),
      nativeRecordKey: role,
    }));
    expect(hasCompleteProVerifierReceipt(bindings as never, invocationId)).toBe(true);
    expect(hasCompleteProVerifierReceipt(bindings.slice(1) as never, invocationId)).toBe(false);
  });
});

describe('complete row freezing and strict native evidence', () => {
  it('retains complete sampled rows instead of reloading task IDs later', () => {
    const source = row('owner-repo-one');
    const instance = instanceFromRow(source);
    expect(instance.row).toEqual(source);
    expect(instance.row).not.toBe(source);
    expect(instance.row.future_dataset_column).toEqual({ preserved: true });
    const selected = selectInstances({
      schemaVersion: 2,
      kind: 'ultracode-swebench-pro-dataset-snapshot',
      identity: 'ScaleAI/SWE-bench_Pro',
      split: 'test',
      source: 'https://datasets-server.huggingface.co/rows',
      rows: [row('task-b'), row('task-a')],
    }, { taskIds: ['task-a'], count: 1, seed: 0, stratifyBy: 'repo' });
    expect(selected.map((entry) => entry.instanceId)).toEqual(['task-a']);
  });

  it('rejects task IDs that the pinned evaluator could treat as host paths', () => {
    expect(() => instanceFromRow(row('../escape'))).toThrow(/unsafe for the pinned native evaluator/);
    expect(() => instanceFromRow(row('nested/task'))).toThrow(/unsafe for the pinned native evaluator/);
  });

  it('keeps omitted and malformed evaluator records unverified', () => {
    const fixture = JSON.parse(readFileSync(
      join(process.cwd(), 'test/fixtures/bench/swebench-pro/eval_results.json'),
      'utf8',
    )) as unknown;
    expect(parseEvaluatorResults(fixture)).toEqual({
      verdicts: { 'task-fail': false, 'task-pass': true },
      malformedTaskIds: ['task-malformed'],
    });
    expect(() => parseEvaluatorResults([])).toThrow(/object/);
  });

  it('classifies a driver backstop as infrastructure and a native timeout as agent-owned', () => {
    expect(classifyOutcome(null, null).failure).toBe('driver-watchdog');
    expect(classifyOutcome({
      codexExit: 124,
      startedAt: 1,
      endedAt: 2,
      baseSha: 'a',
      expectedBase: 'a',
      patchBytes: 0,
      applyCheck: null,
      ucRuns: [],
      waitedForTerminalMs: 0,
      failure: null,
    }, null).failure).toBe('agent-timeout');
  });
});

describe('evaluator ownership and empty predictions', () => {
  it('requires exact repository, post-baseline ownership, start time, and output mount', () => {
    const labels = (taskId: string) => ({
      'ultracode.benchmark.schema': '2',
      'ultracode.benchmark.suite': 'swebench-pro',
      'ultracode.benchmark.run': 'pilot1',
      'ultracode.benchmark.arm': 'a',
      'ultracode.benchmark.invocation': 'invocation-1',
      'ultracode.benchmark.task': taskId,
      'ultracode.benchmark.purpose': 'verifier',
      'ultracode.benchmark.ownership': '1',
    });
    const records = [
      { Id: 'a'.repeat(64), Config: { Image: 'jefzda/sweap-images:task', Labels: labels('task') }, State: { StartedAt: '2026-07-20T12:01:00Z' }, Mounts: [{ Type: 'bind', Source: '/run/output/task' }] },
      { Id: 'b'.repeat(64), Config: { Image: 'jefzda/sweap-images:task', Labels: labels('task') }, State: { StartedAt: '2026-07-20T12:01:00Z' }, Mounts: [{ Type: 'bind', Source: '/run/output/task' }] },
      { Id: 'c'.repeat(64), Config: { Image: 'jefzda/sweap-images-evil:task', Labels: labels('task') }, State: { StartedAt: '2026-07-20T12:01:00Z' }, Mounts: [{ Type: 'bind', Source: '/run/output/task' }] },
      { Id: 'd'.repeat(64), Config: { Image: 'jefzda/sweap-images:task', Labels: labels('task') }, State: { StartedAt: '2026-07-20T12:01:00Z' }, Mounts: [{ Type: 'bind', Source: '/other' }] },
    ];
    expect(ownedEvaluatorContainerIds(records, {
      outputDirectory: '/run/output',
      baselineIds: new Set(['b'.repeat(64)]),
      runId: 'pilot1',
      armLabel: 'a',
      invocationId: 'invocation-1',
      taskIds: new Set(['task']),
      invocationStartedMs: Date.parse('2026-07-20T12:00:00Z'),
      nowMs: Date.parse('2026-07-20T13:00:00Z'),
      maximumAgeMs: null,
    })).toEqual(['a'.repeat(64)]);
  });

  it('selects only the requested repository digest', () => {
    const digest = `jefzda/sweap-images@sha256:${'a'.repeat(64)}`;
    expect(repositoryDigest({ RepoDigests: [digest, `other/image@sha256:${'b'.repeat(64)}`] })).toBe(digest);
    expect(() => repositoryDigest({ RepoDigests: [`jefzda/sweap-images-evil@sha256:${'a'.repeat(64)}`] })).toThrow();
  });

  it('cleans only fully labelled containers for manifest-owned tasks', () => {
    const labels = {
      'ultracode.benchmark.schema': '2',
      'ultracode.benchmark.suite': 'swebench-pro',
      'ultracode.benchmark.run': 'pilot1',
      'ultracode.benchmark.task': 'task-a',
      'ultracode.benchmark.arm': 'a',
      'ultracode.benchmark.purpose': 'session',
      'ultracode.benchmark.ownership': '1',
      'ultracode.benchmark.runtime': 'a'.repeat(64),
    };
    expect(ownedRunContainerIds([
      { Id: 'a'.repeat(64), Config: { Labels: labels } },
      { Id: 'b'.repeat(64), Config: { Labels: { ...labels, 'ultracode.benchmark.task': 'task-b' } } },
      { Id: 'c'.repeat(64), Config: { Labels: { ...labels, 'ultracode.benchmark.purpose': 'prep' } } },
      { Id: 'short', Config: { Labels: labels } },
    ], 'pilot1', new Set(['task-a']), new Set())).toEqual(['a'.repeat(64)]);
  });

  it('does not launch an evaluator or fabricate eval_results for an empty prediction set', async () => {
    const root = mkdtempSync(join(tmpdir(), 'uc-bench-pro-empty-'));
    temporaryRoots.push(root);
    const roots = createBenchPathRoots(root);
    mkdirSync(roots.resultsRoot, { mode: 0o700 });
    const runDirectory = join(roots.resultsRoot, 'swebench-pro', 'pilot1');
    mkdirSync(runDirectory, { recursive: true, mode: 0o700 });
    const result = await runOfficialEvaluator({
      runDirectory,
      evaluatorDirectory: join(root, 'unused-evaluator'),
      evaluatorPythonBinary: join(root, 'unused-python'),
      config,
      invocationId: '11111111-1111-4111-8111-111111111111',
      runId: 'pilot1',
      armLabel: 'a',
      prefix: 'armA',
      predictions: [],
      instances: [instanceFromRow(row('task-a'))],
      docker: async () => { throw new Error('docker must not be called'); },
    });
    expect(result.resultRelativePath).toBeNull();
    expect(result.verdicts).toEqual({});
    expect(existsSync(join(runDirectory, 'native/verifier/armA/output/eval_results.json'))).toBe(false);
  });

  it('sweeps an exact manifest-owned credential runtime even without a container', () => {
    const runtime = mkdtempSync(join(tmpdir(), 'uc-bench-pro-runtime-'));
    temporaryRoots.push(runtime);
    mkdirSync(join(runtime, 'codex-home'), { mode: 0o700 });
    writeFileSync(join(runtime, 'ownership.json'), `${JSON.stringify({
      schemaVersion: 2,
      kind: 'ultracode-swebench-pro-session-runtime',
      runId: 'pilot1',
      taskId: 'task-a',
      arm: 'a',
      runtimeNonce: 'a'.repeat(64),
    })}\n`, { mode: 0o600 });
    const manifest = {
      runId: 'pilot1',
      artifacts: { executions: [{ taskId: 'task-a', arm: 'a' }] },
    } as never;
    expect(cleanupProRuntimeHomes({
      runId: 'other', artifacts: { executions: [{ taskId: 'task-a', arm: 'a' }] },
    } as never)).toBe(0);
    expect(cleanupProRuntimeHomes(manifest)).toBe(1);
    expect(existsSync(runtime)).toBe(false);
  });
});
