/** Exhaustive offline coverage for the single normalized rollout metrics path. */
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { MetricsPolicySnapshot } from '../../bench/src/shared/manifest.js';
import {
  emptyMetricsArtifactIndex,
  normalizeBenchMetrics,
  normalizeMetrics,
  parseCodexRollout,
  type MetricsArtifactIndex,
  type RolloutArtifact,
} from '../../bench/src/shared/metrics.js';

const HOST_ID = '11111111-1111-4111-8111-111111111111';
const WORKER_ID = '22222222-2222-4222-8222-222222222222';
const HASH = 'a'.repeat(64);
const policy: MetricsPolicySnapshot = {
  parserContractVersion: 2,
  cachedInputWeight: 0.1,
  compactionRule: 'max-event-record',
  resetMinDropTokens: 16_000,
  resetRetainedFraction: 0.5,
  workflowDedupeRule: 'run-id',
  implementationSha256: HASH,
};

const tokenCount = (
  total: Record<string, unknown>,
  last: Record<string, unknown> = { input_tokens: 1_000, output_tokens: 100 },
): unknown => ({
  type: 'event_msg',
  payload: {
    type: 'token_count',
    info: { total_token_usage: total, last_token_usage: last, model_context_window: 100_000 },
  },
});

function jsonl(...records: unknown[]): string {
  return `${records.map((record) => typeof record === 'string' ? record : JSON.stringify(record)).join('\n')}\n`;
}

function put(root: string, path: string, contents: string): string {
  const file = join(root, path);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, contents);
  return path;
}

function artifact(path: string, over: Partial<RolloutArtifact> = {}): RolloutArtifact {
  return {
    scope: { taskId: 'task-one', arm: 'b' },
    path,
    roleHint: 'worker',
    backend: 'codex',
    billingClass: 'billable',
    ...over,
  };
}

function root(): string {
  return mkdtempSync(join(tmpdir(), 'uc-normalized-metrics-'));
}

function normalize(runDirectory: string, index: MetricsArtifactIndex) {
  return normalizeMetrics({
    runDirectory,
    index,
    requested: { model: 'gpt-test', effort: 'high' },
    policy,
    pricing: null,
  });
}

describe('Codex cumulative rollout normalization', () => {
  it('parses the sanitized cumulative rollout golden', () => {
    const runDirectory = root();
    const path = put(
      runDirectory,
      `native/rollout-golden-${HOST_ID}.jsonl`,
      readFileSync('test/fixtures/bench/codex/rollout.jsonl', 'utf8'),
    );
    const session = parseCodexRollout(runDirectory, artifact(path, { roleHint: 'host' }), policy);
    expect(session).toMatchObject({
      sessionId: HOST_ID,
      role: 'host',
      model: 'gpt-test',
      effectiveEffort: 'high',
      usage: {
        inputTokens: 1_200,
        cachedInputTokens: 300,
        outputTokens: 120,
        reasoningOutputTokens: 20,
        rawTokenCount: 1_320,
      },
    });
  });

  it('replaces with the final complete cumulative object and never double-counts reasoning', () => {
    const runDirectory = root();
    const path = put(runDirectory, `native/rollout-final-${HOST_ID}.jsonl`, jsonl(
      { type: 'session_meta', payload: { id: HOST_ID, model: 'gpt-test' } },
      { type: 'turn_context', payload: { effort: 'high' } },
      tokenCount({ input_tokens: 100, cached_input_tokens: 40, output_tokens: 20, reasoning_output_tokens: 10 }),
      tokenCount({ input_tokens: 200, cached_input_tokens: 50, output_tokens: 30 }),
      tokenCount({ input_tokens: 999, cached_input_tokens: 100 }),
    ));
    const session = parseCodexRollout(runDirectory, artifact(path, { roleHint: 'host' }), policy);
    expect(session.usage).toEqual({
      inputTokens: 200,
      cachedInputTokens: 50,
      nonCachedInputTokens: 150,
      outputTokens: 30,
      reasoningOutputTokens: 0,
      rawTokenCount: 230,
      cachedInputWeight: 0.1,
      discountedTokenEquivalent: 185,
    });
    expect(session.role).toBe('host');
    expect(session.effectiveEffort).toBe('high');
  });

  it('clamps cached input to inclusive input and reasoning to its output subset', () => {
    const runDirectory = root();
    const path = put(runDirectory, `native/rollout-clamp-${HOST_ID}.jsonl`, jsonl(
      tokenCount({ input_tokens: 10, cached_input_tokens: 30, output_tokens: 4, reasoning_output_tokens: 9 }),
    ));
    const session = parseCodexRollout(runDirectory, artifact(path), policy);
    expect(session.usage).toMatchObject({
      inputTokens: 10,
      cachedInputTokens: 10,
      nonCachedInputTokens: 0,
      outputTokens: 4,
      reasoningOutputTokens: 4,
      rawTokenCount: 14,
      discountedTokenEquivalent: 5,
    });
    expect(session.annotations.map(({ code }) => code)).toEqual(expect.arrayContaining([
      'cached-input-clamped',
      'reasoning-output-clamped',
    ]));
  });

  it('uses max compaction dedupe and keeps inferred prompt resets diagnostic', () => {
    const runDirectory = root();
    const path = put(runDirectory, `native/rollout-reset-${HOST_ID}.jsonl`, jsonl(
      tokenCount({ input_tokens: 10, cached_input_tokens: 0, output_tokens: 1 }, { input_tokens: 50_000, output_tokens: 1_000 }),
      { type: 'compacted', payload: {} },
      { type: 'event_msg', payload: { type: 'context_compacted' } },
      { type: 'compacted', payload: {} },
      tokenCount({ input_tokens: 20, cached_input_tokens: 0, output_tokens: 2 }, { input_tokens: 8_000, output_tokens: 400 }),
    ));
    const session = parseCodexRollout(runDirectory, artifact(path), policy);
    expect(session.explicitCompactions).toBe(2);
    expect(session.inferredPromptResets).toBe(1);
    expect(session.contextHighWaterMark).toBe(51_000);
    expect(session.underContextPressure).toBe(true);
  });

  it('reads collaboration reasoning effort and annotates a mismatched metadata id', () => {
    const runDirectory = root();
    const path = put(runDirectory, `native/rollout-effort-${HOST_ID}.jsonl`, jsonl(
      { type: 'session_meta', payload: { id: WORKER_ID } },
      { type: 'turn_context', payload: { collaboration_mode: { settings: { reasoning_effort: 'xhigh' } } } },
      tokenCount({ input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 }),
    ));
    const session = parseCodexRollout(runDirectory, artifact(path), policy);
    expect(session.sessionId).toBe(HOST_ID);
    expect(session.effectiveEffort).toBe('xhigh');
    expect(session.annotations.map(({ code }) => code)).toContain('rollout-session-id-mismatch');
  });
});

describe('normalized aggregation invariants', () => {
  it('separates billing classes and prices only billable usage', () => {
    const runDirectory = root();
    const host = put(runDirectory, `native/rollout-host-${HOST_ID}.jsonl`, jsonl(
      { type: 'turn_context', payload: { effort: 'high', model: 'gpt-test' } },
      tokenCount({ input_tokens: 1_000, cached_input_tokens: 400, output_tokens: 100, reasoning_output_tokens: 20 }),
    ));
    const mock = put(runDirectory, `native/rollout-worker-${WORKER_ID}.jsonl`, jsonl(
      { type: 'turn_context', payload: { effort: 'high', model: 'gpt-test' } },
      tokenCount({ input_tokens: 2_000, cached_input_tokens: 500, output_tokens: 200, reasoning_output_tokens: 50 }),
    ));
    const metrics = normalizeMetrics({
      runDirectory,
      index: {
        ...emptyMetricsArtifactIndex(),
        rollouts: [
          artifact(host, { roleHint: 'host' }),
          artifact(mock, { billingClass: 'mock', backend: 'mock' }),
        ],
      },
      requested: { model: 'gpt-test', effort: 'high' },
      policy,
      pricing: {
        currency: 'USD',
        model: 'gpt-test',
        uncachedInputPerMTokens: 1_000,
        cachedInputPerMTokens: 100,
        outputPerMTokens: 1_000,
      },
    });
    expect(metrics.sessions).toMatchObject({ total: 2, host: 1, worker: 1, unknown: 0 });
    expect(metrics.tokens.total.rawTokenCount).toBe(3_300);
    expect(metrics.tokens.byBillingClass.billable.rawTokenCount).toBe(1_100);
    expect(metrics.tokens.byBillingClass.mock.rawTokenCount).toBe(2_200);
    expect(metrics.pricing).toEqual({ currency: 'USD', verification: 'priced', billableCost: 0.74 });
    expect(metrics.effectiveEffort).toMatchObject({
      verification: 'verified',
      values: { high: 2 },
      matchesRequested: true,
    });
  });

  it('rejects duplicate paths and same-scope session ids, but permits ids across scopes', () => {
    const runDirectory = root();
    const first = put(runDirectory, 'native/rollout-one.jsonl', jsonl(
      { type: 'session_meta', payload: { id: HOST_ID } },
      tokenCount({ input_tokens: 1, cached_input_tokens: 0, output_tokens: 0 }),
    ));
    const second = put(runDirectory, 'native/rollout-two.jsonl', jsonl(
      { type: 'session_meta', payload: { id: HOST_ID } },
      tokenCount({ input_tokens: 2, cached_input_tokens: 0, output_tokens: 0 }),
    ));
    expect(() => normalize(runDirectory, {
      ...emptyMetricsArtifactIndex(),
      rollouts: [artifact(first), artifact(first)],
    })).toThrow(/duplicate rollout path/);
    expect(() => normalize(runDirectory, {
      ...emptyMetricsArtifactIndex(),
      rollouts: [artifact(first), artifact(second)],
    })).toThrow(/duplicate rollout session/);
    expect(normalize(runDirectory, {
      ...emptyMetricsArtifactIndex(),
      rollouts: [artifact(first), artifact(second, { scope: { taskId: 'task-two', arm: 'b' } })],
    }).sessions.total).toBe(2);
  });

  it('dedupes identical workflow ids and rejects conflicting copies', () => {
    const runDirectory = root();
    const workflow = {
      scope: { taskId: 'task-one', arm: 'b' as const },
      workflowId: 'wf-one',
      status: 'completed',
      agentCount: 3,
      failureCount: 1,
      workspacesKept: 0,
      backend: 'codex',
      billingClass: 'billable' as const,
    };
    const metrics = normalize(runDirectory, {
      ...emptyMetricsArtifactIndex(),
      workflows: [workflow, { ...workflow }],
    });
    expect(metrics.workflows).toMatchObject({ count: 1, agentCount: 3, failureCount: 1 });
    expect(() => normalize(runDirectory, {
      ...emptyMetricsArtifactIndex(),
      workflows: [workflow, { ...workflow, agentCount: 4 }],
    })).toThrow(/conflicting workflow telemetry/);
  });

  it('turns an unsafe exact rollout reference into an explicit infrastructure failure', () => {
    const metrics = normalize(root(), {
      ...emptyMetricsArtifactIndex(),
      rollouts: [artifact('native/missing.jsonl')],
    });
    expect(metrics.sessions.total).toBe(0);
    expect(metrics.failures.map(({ code }) => code)).toEqual(['artifact-unsafe']);
  });

  it('rejects adapter task/arm scopes that are absent from the immutable manifest', () => {
    const runDirectory = root();
    const path = put(runDirectory, `native/rollout-scope-${HOST_ID}.jsonl`, jsonl(
      tokenCount({ input_tokens: 1, cached_input_tokens: 0, output_tokens: 0 }),
    ));
    const manifest = {
      experiment: { model: 'gpt-test', requestedEffort: 'high' },
      metricsPolicy: policy,
      pricing: null,
      artifacts: { executions: [{ taskId: 'task-one', arm: 'a' }] },
    } as never;
    expect(() => normalizeBenchMetrics(manifest, runDirectory, {
      ...emptyMetricsArtifactIndex(),
      rollouts: [artifact(path, { scope: { taskId: 'task-one', arm: 'b' } })],
    })).toThrow(/not frozen in the manifest/);
  });

  it('does not add detached wait twice when it is nested in task wall time', () => {
    const runDirectory = root();
    const state = {
      schemaVersion: 2,
      kind: 'ultracode-benchmark-run-state',
      suite: 'swebench-pro',
      runId: 'run-one',
      manifestSha256: HASH,
      revision: 0,
      invocations: [{
        invocationId: HOST_ID,
        command: 'run',
        startedAt: '2026-07-20T00:00:00.000Z',
        endedAt: '2026-07-20T00:01:40.000Z',
        activeElapsedMs: 100_000,
        exitCode: 0,
        signal: null,
        lifecycleProcesses: [],
        failure: null,
        nativeInvocation: null,
      }],
      attempts: [
        {
          attemptId: WORKER_ID,
          invocationId: HOST_ID,
          taskId: 'task-one',
          arm: 'b',
          ordinal: 1,
          phase: 'session',
          startedAt: '2026-07-20T00:00:00.000Z',
          endedAt: '2026-07-20T00:01:40.000Z',
          elapsedMs: 100_000,
          nativePath: null,
          exitCode: 0,
          signal: null,
          status: 'succeeded',
          failures: [],
          annotations: [],
        },
        {
          attemptId: '33333333-3333-4333-8333-333333333333',
          invocationId: HOST_ID,
          taskId: 'task-one',
          arm: 'b',
          ordinal: 1,
          phase: 'detached-wait',
          startedAt: '2026-07-20T00:01:00.000Z',
          endedAt: '2026-07-20T00:01:40.000Z',
          elapsedMs: 40_000,
          nativePath: null,
          exitCode: 0,
          signal: null,
          status: 'succeeded',
          failures: [],
          annotations: [],
        },
      ],
    } as const;
    const metrics = normalizeMetrics({
      runDirectory,
      index: emptyMetricsArtifactIndex(),
      requested: { model: 'gpt-test', effort: 'high' },
      policy,
      pricing: null,
      runState: state,
    });
    expect(metrics.timing).toMatchObject({
      runElapsedMs: 100_000,
      calendarSpanMs: 100_000,
      criticalPathMs: 100_000,
      summedTaskMs: 100_000,
      nativeRunnerMs: 100_000,
      detachedWorkflowWaitMs: 40_000,
    });
  });
});
