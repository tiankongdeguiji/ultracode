/** Offline coverage for the external CLI grammar, manifest boundary, and reports. */
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { artifactKey, sha256File } from '../../bench/src/external-common.js';
import {
  EXTERNAL_USAGE,
  generateExternalReport,
  featureBenchSourceProvenance,
  loadExternalManifest,
  marathonRuntimeEnvironment,
  parseExternalCliArgs,
  runExternalCli,
} from '../../bench/src/external-cli.js';
import type {
  ExternalRunManifest,
  ExternalSuite,
} from '../../bench/src/external-cli.js';

const HOST_ID = '11111111-1111-4111-8111-111111111111';
const WORKER_ID = '22222222-2222-4222-8222-222222222222';
const FEATURE_TASK = 'org__repo.abc.test_feature.def.lv1';

function put(path: string, contents: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents);
}

function rollout(sessionId: string, input: number, effort = 'high'): string {
  return [
    { type: 'session_meta', payload: { id: sessionId, model: 'gpt-test' } },
    { type: 'turn_context', payload: { model: 'gpt-test', effort } },
    {
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: {
          total_token_usage: {
            input_tokens: input,
            cached_input_tokens: 100,
            output_tokens: 200,
            reasoning_output_tokens: 50,
          },
          last_token_usage: { input_tokens: input, output_tokens: 200 },
          model_context_window: 200_000,
        },
      },
    },
  ].map((record) => JSON.stringify(record)).join('\n') + '\n';
}

function makeRun(
  suite: ExternalSuite,
  taskIds: string[],
  arm: 'a' | 'b' = 'b',
  existingRoot?: string,
): { root: string; runDir: string; manifest: ExternalRunManifest } {
  const root = existingRoot ?? mkdtempSync(join(tmpdir(), 'uc-external-cli-'));
  const runId = 'external-run-1';
  const runDir = join(root, 'external', suite, runId);
  mkdirSync(runDir, { recursive: true });
  const manifest: ExternalRunManifest = {
    schemaVersion: 1,
    kind: 'ultracode-external-run',
    runId,
    suite,
    createdAt: '2026-07-19T00:00:00.000Z',
    requested: { model: 'gpt-test', effort: 'high', arm, taskIds },
    suitePins: { sourceRevision: '0123456789abcdef0123456789abcdef01234567' },
    provenance: { codexSha256: 'a'.repeat(64) },
    artifacts: {
      root: 'native',
      tasks: taskIds.map((taskId) => ({
        taskId,
        key: artifactKey(taskId),
        nativeRoot: suite === 'swe-marathon' ? `native/${artifactKey(taskId)}` : 'native',
      })),
    },
  };
  writeFileSync(join(runDir, 'external-run.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return { root, runDir, manifest };
}

function receipt(
  runDir: string,
  suite: ExternalSuite,
  tasks: Array<{ taskId: string; key: string; verifierResult: string }>,
): void {
  put(join(runDir, 'native-receipt.json'), `${JSON.stringify({
    schemaVersion: 1,
    kind: 'ultracode-external-native-receipt',
    suite,
    tasks: tasks.map((task) => ({
      ...task,
      verifierSha256: sha256File(join(runDir, task.verifierResult)),
    })),
  }, null, 2)}\n`);
}

describe('external CLI parsing', () => {
  it('attests the FeatureBench adapter and extracted host policy together', () => {
    expect(featureBenchSourceProvenance()).toEqual({
      featureBenchAdapterSha256: sha256File(join(process.cwd(), 'bench/src/featurebench.ts')),
      featureBenchHostPolicySha256: sha256File(join(process.cwd(), 'bench/src/featurebench-host.ts')),
    });
  });

  it('requires every fresh-run identity and accepts repeated literal task ids', () => {
    expect(parseExternalCliArgs([
      'run',
      '--suite', 'featurebench',
      '--run-id', 'trial-1',
      '--model', 'gpt-test',
      '--effort', 'xhigh',
      '--arm', 'b',
      '--task-id', FEATURE_TASK,
      '--task-id', 'org__other.123.test_more.456.lv1',
    ])).toMatchObject({
      command: 'run',
      suite: 'featurebench',
      runId: 'trial-1',
      model: 'gpt-test',
      effort: 'xhigh',
      arm: 'b',
      taskIds: [FEATURE_TASK, 'org__other.123.test_more.456.lv1'],
    });
    expect(() => parseExternalCliArgs([
      'run', '--suite', 'featurebench', '--run-id', 'trial-1', '--arm', 'a', '--task-id', FEATURE_TASK,
    ])).toThrow('--model is required');
  });

  it('preserves comma-form task ids alongside repeated task-id flags', () => {
    expect(parseExternalCliArgs([
      'run',
      '--suite', 'swe-marathon',
      '--run-id', 'trial-1',
      '--model', 'gpt-test',
      '--effort', 'high',
      '--arm', 'a',
      '--task-id', 'zstd-decoder',
      '--task-ids', 'openssl-cert-chain,sqlite-indexing',
    ])).toMatchObject({
      taskIds: ['zstd-decoder', 'openssl-cert-chain', 'sqlite-indexing'],
    });
  });

  it('rejects unsafe suite, run, task, option, and duplicate inputs', () => {
    const base = [
      'run', '--suite', 'featurebench', '--run-id', 'trial-1', '--model', 'gpt-test',
      '--effort', 'high', '--arm', 'a',
    ];
    expect(() => parseExternalCliArgs([...base, '--task-id', '../escape'])).toThrow('unsafe FeatureBench task ID');
    expect(() => parseExternalCliArgs([...base, '--task-id', FEATURE_TASK, '--task-id', FEATURE_TASK])).toThrow('duplicated');
    expect(() => parseExternalCliArgs(['report', '--suite', 'unknown', '--run-id', 'trial-1'])).toThrow('--suite');
    expect(() => parseExternalCliArgs(['report', '--suite', 'featurebench', '--run-id', '../escape'])).toThrow('invalid run id');
    expect(() => parseExternalCliArgs(['prep', '--suite', 'featurebench', '--model', 'ignored'])).toThrow('unknown option');
  });

  it('handles help without owning final error formatting', async () => {
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      await runExternalCli(['--help']);
      const output = stdout.mock.calls.flat().join('');
      expect(output).toBe(`${EXTERNAL_USAGE}\n`);
      expect(output).toContain(
        'npm run bench -- --suite <swe-marathon|featurebench> prep',
      );
      expect(output).toContain(
        'npm run bench -- --suite <swe-marathon|featurebench> run --run-id <id>',
      );
      expect(output).toContain(
        'npm run bench -- --suite <swe-marathon|featurebench> report --run-id <id>',
      );
      expect(output.match(/npm run bench -- [^\n]+/gu)).toEqual([
        expect.stringMatching(/^npm run bench -- --suite /u),
        expect.stringMatching(/^npm run bench -- --suite /u),
        expect.stringMatching(/^npm run bench -- --suite /u),
      ]);
      expect(stderr).not.toHaveBeenCalled();

      stdout.mockClear();
      await expect(runExternalCli(['report', '--suite', 'featurebench'])).rejects.toThrow(
        '--run-id is required',
      );
      expect(stdout).not.toHaveBeenCalled();
      expect(stderr).not.toHaveBeenCalled();
    } finally {
      stdout.mockRestore();
      stderr.mockRestore();
    }
  });

  it('canonicalizes Marathon auth paths and resolves effective workflow waits', () => {
    const root = mkdtempSync(join(tmpdir(), 'uc-marathon-auth-'));
    const authDirectory = join(root, 'auth');
    mkdirSync(authDirectory);
    writeFileSync(join(authDirectory, 'auth.json'), '{}\n');
    symlinkSync(authDirectory, join(root, 'auth-link'));
    const runtime = marathonRuntimeEnvironment({
      PATH: '/bin',
      CODEX_AUTH_JSON_PATH: join(root, 'auth-link', 'auth.json'),
      SWE_MARATHON_WORKFLOW_WAIT_SECONDS: '2400',
      AWS_SECRET_ACCESS_KEY: 'unrelated',
    }, 'b');
    expect(runtime).toMatchObject({ authMechanism: 'codex-auth-json', workflowWaitSeconds: 2_400 });
    expect(runtime.childEnvironment.CODEX_AUTH_JSON_PATH).toBe(realpathSync.native(join(authDirectory, 'auth.json')));
    expect(runtime.childEnvironment).not.toHaveProperty('AWS_SECRET_ACCESS_KEY');
    expect(marathonRuntimeEnvironment({ OPENAI_API_KEY: 'secret' }, 'a')).toMatchObject({
      authMechanism: 'openai-api-key',
      workflowWaitSeconds: null,
    });
    expect(() => marathonRuntimeEnvironment({ OPENAI_API_KEY: 'secret' }, 'b')).not.toThrow();
    expect(() => marathonRuntimeEnvironment({
      OPENAI_API_KEY: 'secret',
      SWE_MARATHON_WORKFLOW_WAIT_SECONDS: '1.5',
    }, 'b')).toThrow(/positive integer/);
  });
});

describe('external reports', () => {
  it('keeps identical run ids in all three suite-specific manifest namespaces', () => {
    const { root, runDir } = makeRun('featurebench', [FEATURE_TASK]);
    const marathon = makeRun('swe-marathon', ['zstd-decoder'], 'a', root);
    const proManifest = join(root, 'external-run-1', 'run.json');
    put(proManifest, '{}\n');
    expect(loadExternalManifest('external-run-1', 'featurebench', root).directory).toBe(runDir);
    expect(loadExternalManifest('external-run-1', 'swe-marathon', root).directory).toBe(marathon.runDir);
    expect(proManifest).toBe(join(root, 'external-run-1', 'run.json'));
    expect(join(runDir, 'external-run.json')).toBe(join(
      root,
      'external',
      'featurebench',
      'external-run-1',
      'external-run.json',
    ));
    expect(join(marathon.runDir, 'external-run.json')).toBe(join(
      root,
      'external',
      'swe-marathon',
      'external-run-1',
      'external-run.json',
    ));
  });

  it('reports effective effort, host/workers, token context, and verified false outcomes', async () => {
    const { root, runDir } = makeRun('featurebench', [FEATURE_TASK]);
    const native = join(runDir, 'native', 'timestamp');
    put(join(native, 'logs', 'codex_events.jsonl'), `${JSON.stringify({ type: 'thread.started', thread_id: HOST_ID })}\n`);
    put(join(native, 'logs', 'codex_sessions', `rollout-test-${HOST_ID}.jsonl`), rollout(HOST_ID, 1_000));
    put(join(native, 'logs', 'codex_sessions', `rollout-test-${WORKER_ID}.jsonl`), rollout(WORKER_ID, 2_000));
    const verifierReport = join(native, 'eval_outputs', FEATURE_TASK, 'attempt-1', 'report.json');
    put(
      verifierReport,
      `${JSON.stringify({
        [FEATURE_TASK]: {
          n_attempt: 1,
          resolved: false,
          pass_rate: 0.5,
          featurebench_eval_completed: true,
        },
      })}\n`,
    );
    receipt(runDir, 'featurebench', [{
      taskId: FEATURE_TASK,
      key: artifactKey(FEATURE_TASK),
      verifierResult: verifierReport.slice(runDir.length + 1),
    }]);

    const { report, jsonPath, markdownPath } = await generateExternalReport(
      'external-run-1',
      'featurebench',
      root,
    );
    expect(report.reasoningEffort).toEqual({
      requested: 'high',
      effective: {
        verification: 'verified',
        values: { high: 2 },
        unknownSessions: 0,
        matchesRequested: true,
      },
    });
    expect(report.sessions).toMatchObject({ total: 2, host: 1, worker: 1, unknown: 0 });
    expect(report.tokens).toEqual({
      input: 2_800,
      cachedInput: 200,
      output: 400,
      reasoning: 100,
      total: 3_220,
    });
    expect(report.context).toMatchObject({ peak: 2_200, windows: [200_000], compactionEvents: 0 });
    expect(report.suiteScore).toMatchObject({
      verification: 'verified',
      metric: 'resolved_rate',
      score: 0,
      verifiedTasks: 1,
      tasks: [{ taskId: FEATURE_TASK, verification: 'verified', score: 0, resolved: false }],
    });
    expect(report.sessions.items.every((session) => !session.file.startsWith('/'))).toBe(true);
    expect(JSON.parse(readFileSync(jsonPath, 'utf8'))).toMatchObject({ kind: 'ultracode-external-report' });
    expect(readFileSync(markdownPath, 'utf8')).toContain('resolved_rate 0');
    expect(statSync(jsonPath).mode & 0o777).toBe(0o600);
    expect(statSync(markdownPath).mode & 0o777).toBe(0o600);
  });

  it('keeps an absent native verifier score unverified and null', async () => {
    const { root, runDir } = makeRun('featurebench', [FEATURE_TASK], 'a');
    put(
      join(runDir, 'native', 'agent-authored', FEATURE_TASK, 'report.json'),
      `${JSON.stringify({ instance_id: FEATURE_TASK, resolved: true })}\n`,
    );
    const { report } = await generateExternalReport('external-run-1', 'featurebench', root);
    expect(report.suiteScore).toMatchObject({
      verification: 'unverified',
      score: null,
      verifiedTasks: 0,
      tasks: [{ verification: 'unverified', score: null, resolved: null, source: null }],
    });
  });

  it('requires the pinned FeatureBench completion, resolved, and pass-rate fields', async () => {
    const { root, runDir } = makeRun('featurebench', [FEATURE_TASK]);
    const verifierReport = join(
      runDir,
      'native',
      'timestamp',
      'eval_outputs',
      FEATURE_TASK,
      'attempt-1',
      'report.json',
    );
    put(verifierReport, `${JSON.stringify({
      [FEATURE_TASK]: {
        n_attempt: 1,
        resolved: true,
        featurebench_eval_completed: true,
      },
    })}\n`);
    receipt(runDir, 'featurebench', [{
      taskId: FEATURE_TASK,
      key: artifactKey(FEATURE_TASK),
      verifierResult: verifierReport.slice(runDir.length + 1),
    }]);
    const { report } = await generateExternalReport('external-run-1', 'featurebench', root);
    expect(report.suiteScore.tasks[0]).toMatchObject({ verification: 'unverified', score: null });
  });

  it('rejects receipt content drift and symlinked verifier ancestors', async () => {
    const first = makeRun('featurebench', [FEATURE_TASK]);
    const verifier = join(
      first.runDir,
      'native',
      'timestamp',
      'eval_outputs',
      FEATURE_TASK,
      'attempt-1',
      'report.json',
    );
    put(verifier, `${JSON.stringify({
      [FEATURE_TASK]: {
        n_attempt: 1,
        resolved: true,
        pass_rate: 1,
        featurebench_eval_completed: true,
      },
    })}\n`);
    receipt(first.runDir, 'featurebench', [{
      taskId: FEATURE_TASK,
      key: artifactKey(FEATURE_TASK),
      verifierResult: verifier.slice(first.runDir.length + 1),
    }]);
    writeFileSync(verifier, '{}\n');
    await expect(generateExternalReport('external-run-1', 'featurebench', first.root)).rejects.toThrow(/hash mismatch/);

    const second = makeRun('featurebench', [FEATURE_TASK]);
    const outside = join(second.root, 'outside');
    const outsideReport = join(outside, 'eval_outputs', FEATURE_TASK, 'attempt-1', 'report.json');
    put(outsideReport, '{}\n');
    mkdirSync(join(second.runDir, 'native'));
    symlinkSync(outside, join(second.runDir, 'native', 'timestamp'));
    receipt(second.runDir, 'featurebench', [{
      taskId: FEATURE_TASK,
      key: artifactKey(FEATURE_TASK),
      verifierResult: `native/timestamp/eval_outputs/${FEATURE_TASK}/attempt-1/report.json`,
    }]);
    await expect(generateExternalReport('external-run-1', 'featurebench', second.root)).rejects.toThrow(/symlinked ancestors/);
  });

  it('uses one exact Harbor trial result as the Marathon native verifier authority', async () => {
    const taskId = 'zstd-decoder';
    const { root, runDir, manifest } = makeRun('swe-marathon', [taskId], 'a');
    const trialRoot = join(runDir, manifest.artifacts.tasks[0]!.nativeRoot, 'trial');
    put(join(trialRoot, 'config.json'), `${JSON.stringify({
      trial_name: 'trial',
      task: { path: `tasks/${taskId}` },
    })}\n`);
    const verifierResult = join(trialRoot, 'result.json');
    put(verifierResult, `${JSON.stringify({
      task_name: taskId,
      trial_name: 'trial',
      verifier_result: { rewards: { reward: 0.75 } },
    })}\n`);
    put(join(trialRoot, 'agent', 'reward.json'), '{"reward":1}\n');
    receipt(runDir, 'swe-marathon', [{
      taskId,
      key: artifactKey(taskId),
      verifierResult: verifierResult.slice(runDir.length + 1),
    }]);
    const { report } = await generateExternalReport('external-run-1', 'swe-marathon', root);
    expect(report.suiteScore).toMatchObject({
      verification: 'verified',
      metric: 'mean_reward',
      score: 0.75,
      tasks: [{ taskId, verification: 'verified', score: 0.75 }],
    });
  });
});
