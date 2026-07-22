/** Fixture-backed coverage for Pro telemetry indexing and thesis analysis. */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_METRICS_POLICY, normalizeBenchMetrics } from '../../bench/src/shared/metrics.js';
import type { TaskResult } from '../../bench/src/shared/report.js';
import { swebenchProAnalysisHook } from '../../bench/src/suites/swebench-pro/analysis.js';
import { writeTaskStatus } from '../../bench/src/suites/swebench-pro/state.js';
import { indexSwebenchProMetrics } from '../../bench/src/suites/swebench-pro/telemetry.js';

const roots: string[] = [];
const HOST_ID = '11111111-1111-4111-8111-111111111111';
const WORKER_ID = '22222222-2222-4222-8222-222222222222';

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function write(path: string, contents: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents);
}

function rollout(inputTokens: number): string {
  return [
    { type: 'turn_context', payload: { effort: 'high', model: 'gpt-test' } },
    {
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: {
          total_token_usage: {
            input_tokens: inputTokens,
            cached_input_tokens: 0,
            output_tokens: 100,
            reasoning_output_tokens: 10,
          },
          last_token_usage: { input_tokens: inputTokens, output_tokens: 100 },
          model_context_window: 100_000,
        },
      },
    },
  ].map((record) => JSON.stringify(record)).join('\n') + '\n';
}

function result(
  taskId: string,
  arm: 'a' | 'b',
  resolved: boolean | null,
  disposition: TaskResult['disposition'] = 'scored',
): TaskResult {
  return {
    taskId,
    arm,
    nativeVerifier: {
      verification: resolved === null ? 'unverified' : 'verified',
      score: resolved === null ? null : Number(resolved),
      resolved,
      artifact: null,
    },
    disposition,
    failures: [],
    annotations: [],
  };
}

describe('SWE-bench Pro analysis artifacts', () => {
  it('classifies host and worker sessions and computes native, adjusted, and thesis cuts', () => {
    const runDirectory = mkdtempSync(join(tmpdir(), 'uc-pro-analysis-'));
    roots.push(runDirectory);
    const taskIds = ['pressured', 'outside', 'unclassified', 'agent-loss'];
    const executions = taskIds.flatMap((taskId) => (['a', 'b'] as const).map((arm) => ({
      taskId,
      arm,
      nativeRoot: `native/tasks/${taskId}/${arm}`,
    })));
    const manifest = {
      suite: 'swebench-pro',
      experiment: { model: 'gpt-test', requestedEffort: 'high' },
      metricsPolicy: DEFAULT_METRICS_POLICY,
      pricing: null,
      artifacts: { executions },
    } as never;

    for (const execution of executions) {
      const directory = join(runDirectory, ...execution.nativeRoot.split('/'));
      mkdirSync(directory, { recursive: true });
      writeTaskStatus(directory, {
        schemaVersion: 2, phase: 'evaluated', failure: null, annotations: [],
      });
    }
    write(join(runDirectory, 'native/tasks/pressured/a/codex-home/sessions', `rollout-host-${HOST_ID}.jsonl`), rollout(90_000));
    write(join(runDirectory, 'native/tasks/outside/a/codex-home/sessions', `rollout-host-${HOST_ID}.jsonl`), rollout(10_000));
    write(join(runDirectory, 'native/tasks/pressured/b/logs/host.jsonl'), `${JSON.stringify({ thread_id: HOST_ID })}\n`);
    write(join(runDirectory, 'native/tasks/pressured/b/codex-home/sessions', `rollout-host-${HOST_ID}.jsonl`), rollout(1_000));
    write(join(runDirectory, 'native/tasks/pressured/b/codex-home/sessions', `rollout-worker-${WORKER_ID}.jsonl`), rollout(2_000));

    const index = indexSwebenchProMetrics(manifest, runDirectory);
    expect(index.rollouts.map((entry) => [entry.scope.arm, entry.roleHint])).toEqual([
      ['a', 'host'], ['b', 'host'], ['b', 'worker'], ['a', 'host'],
    ]);
    const metrics = normalizeBenchMetrics(manifest, runDirectory, index);
    expect(metrics.sessions.items.find((session) =>
      session.scope.taskId === 'pressured' && session.scope.arm === 'a')?.underContextPressure).toBe(true);
    expect(metrics.sessions.items.find((session) =>
      session.scope.taskId === 'outside' && session.scope.arm === 'a')?.underContextPressure).toBe(false);
    expect(metrics.sessions).toMatchObject({ total: 4, host: 3, worker: 1, unknown: 0 });

    const taskResults = [
      result('pressured', 'a', false), result('pressured', 'b', true),
      result('outside', 'a', true), result('outside', 'b', false),
      result('unclassified', 'a', false), result('unclassified', 'b', false),
      result('agent-loss', 'a', false), result('agent-loss', 'b', null, 'agent-loss'),
    ];
    const analysis = swebenchProAnalysisHook.analyze({
      suite: 'swebench-pro', manifest, metrics, taskResults, nativeAnalysisInput: null,
    });
    expect(analysis.native).toMatchObject({
      arms: { a: { evaluated: 4, resolved: 1 }, b: { evaluated: 3, resolved: 1 } },
      paired: { paired: 3, bothResolved: 0, aOnly: 1, bOnly: 1, neither: 1 },
      thesisCut: {
        inside: { paired: 1, aResolved: 0, bResolved: 1, delta: 1 },
        outside: { paired: 1, aResolved: 1, bResolved: 0, delta: -1 },
        unclassified: 1,
      },
    });
    expect(analysis.policyAdjusted).toMatchObject({
      arms: { a: { evaluated: 4, resolved: 1 }, b: { evaluated: 4, resolved: 1 } },
      paired: { paired: 4, bothResolved: 0, aOnly: 1, bOnly: 1, neither: 2 },
    });
  });
});
