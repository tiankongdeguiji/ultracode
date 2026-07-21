/** Exhaustive offline coverage for the single normalized rollout metrics path. */
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { failureObservationSchema } from '../../bench/src/shared/failure.js';
import type { MetricsPolicySnapshot } from '../../bench/src/shared/manifest.js';
import {
  emptyMetricsArtifactIndex,
  normalizeBenchMetrics,
  normalizeMetrics,
  parseCodexRollout,
  type MetricsArtifactIndex,
  type RolloutArtifact,
  type TimingObservation,
} from '../../bench/src/shared/metrics.js';
import {
  parseBenchRunState,
  type AttemptRecord,
  type InvocationRecord,
} from '../../bench/src/shared/run-state.js';

const HOST_ID = '11111111-1111-4111-8111-111111111111';
const WORKER_ID = '22222222-2222-4222-8222-222222222222';
const HASH = 'a'.repeat(64);
const SECOND_INVOCATION_ID = '33333333-3333-4333-8333-333333333333';
const THIRD_ATTEMPT_ID = '44444444-4444-4444-8444-444444444444';
const FOURTH_ATTEMPT_ID = '55555555-5555-4555-8555-555555555555';
const policy: MetricsPolicySnapshot = {
  parserContractVersion: 2,
  cachedInputWeight: 0.1,
  compactionRule: 'max-event-record',
  resetMinDropTokens: 16_000,
  resetRetainedFraction: 0.5,
  workflowDedupeRule: 'run-id',
  implementationSha256: HASH,
};

const pricing = {
  currency: 'USD' as const,
  model: 'gpt-test',
  uncachedInputPerMTokens: 1_000,
  cachedInputPerMTokens: 100,
  outputPerMTokens: 1_000,
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

function completedAttempt(
  attemptId: string,
  taskId: string,
  phase: AttemptRecord['phase'],
  startedAt: string,
  endedAt: string,
  elapsedMs: number,
  over: Partial<AttemptRecord> = {},
): AttemptRecord {
  return {
    attemptId,
    invocationId: HOST_ID,
    taskId,
    arm: 'b',
    ordinal: 1,
    phase,
    startedAt,
    endedAt,
    elapsedMs,
    nativePath: null,
    exitCode: 0,
    signal: null,
    status: 'succeeded',
    failures: [],
    annotations: [],
    ...over,
  };
}

function completedInvocation(
  invocationId: string,
  over: Partial<InvocationRecord> = {},
): InvocationRecord {
  return {
    invocationId,
    command: 'run',
    startedAt: '2026-07-20T00:00:00.000Z',
    endedAt: '2026-07-20T00:00:01.000Z',
    activeElapsedMs: 1_000,
    exitCode: 0,
    signal: null,
    lifecycleProcesses: [],
    failure: null,
    nativeInvocation: 'native',
    ...over,
  };
}

function timing(
  sourceKey: string,
  taskId: string,
  phase: TimingObservation['phase'],
  startedAt: string,
  endedAt: string,
  elapsedMs: number,
  over: Partial<TimingObservation> = {},
): TimingObservation {
  return {
    sourceKey,
    invocationId: HOST_ID,
    scope: { taskId, arm: 'b' },
    phase,
    startedAt,
    endedAt,
    elapsedMs,
    ...over,
  };
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
    expect(session).not.toHaveProperty('observedModels');
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
      pricing,
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

  it('prices only positive billable sessions with uniform exact observed model evidence', () => {
    const runDirectory = root();
    const observed = (
      name: string,
      models: string[],
      inputTokens: number,
    ): string => put(runDirectory, `native/${name}.jsonl`, jsonl(
      ...models.map((model, index) => index === 0
        ? { type: 'session_meta', payload: { model } }
        : { type: 'turn_context', payload: { model } }),
      tokenCount({ input_tokens: inputTokens, cached_input_tokens: inputTokens === 1_000 ? 400 : 0,
        output_tokens: inputTokens / 10 }),
    ));
    const matched = observed('matched', ['gpt-test', 'gpt-test'], 1_000);
    const mismatched = observed('mismatched', ['gpt-other'], 2_000);
    const unobserved = observed('unobserved', [], 3_000);
    const requestedThenOther = observed('requested-then-other', ['gpt-test', 'gpt-other'], 4_000);
    const otherThenRequested = observed('other-then-requested', ['gpt-other', 'gpt-test'], 5_000);
    const metrics = normalizeMetrics({
      runDirectory,
      index: {
        ...emptyMetricsArtifactIndex(),
        rollouts: [matched, mismatched, unobserved, requestedThenOther, otherThenRequested]
          .map((path) => artifact(path)),
      },
      requested: { model: 'gpt-test', effort: 'high' },
      policy,
      pricing,
    });
    const annotations = (path: string) => metrics.sessions.items.find((session) => session.path === path)!
      .annotations.map(({ code }) => code);

    expect(metrics.tokens.total.rawTokenCount).toBe(16_500);
    expect(metrics.tokens.byBillingClass.billable.rawTokenCount).toBe(16_500);
    expect(metrics.pricing).toEqual({ currency: 'USD', verification: 'partial', billableCost: 0.74 });
    expect(annotations(matched)).toEqual([]);
    expect(annotations(mismatched)).toContain('model-mismatch');
    expect(annotations(unobserved)).toContain('model-unobserved');
    expect(annotations(requestedThenOther)).toContain('model-multiple');
    expect(annotations(otherThenRequested)).toContain('model-multiple');
    expect(metrics.sessions.items.find((session) => session.path === requestedThenOther)?.model).toBe('gpt-other');
    expect(metrics.sessions.items.find((session) => session.path === otherThenRequested)?.model).toBe('gpt-test');
  });

  it('keeps the known subtotal but makes pricing partial for missing billable usage', () => {
    const runDirectory = root();
    const known = put(runDirectory, 'native/rollout-known.jsonl', jsonl(
      { type: 'turn_context', payload: { model: 'gpt-test' } },
      tokenCount({ input_tokens: 1_000, cached_input_tokens: 400, output_tokens: 100 }),
    ));
    const missing = put(runDirectory, 'native/rollout-missing.jsonl', jsonl(
      { type: 'turn_context', payload: { effort: 'high', model: 'gpt-test' } },
    ));
    const index = {
      ...emptyMetricsArtifactIndex(),
      rollouts: [artifact(known), artifact(missing, { scope: { taskId: 'task-two', arm: 'b' } })],
    };
    const metrics = normalizeMetrics({
      runDirectory,
      index,
      requested: { model: 'gpt-test', effort: 'high' },
      policy,
      pricing,
    });
    expect(metrics.pricing).toEqual({ currency: 'USD', verification: 'partial', billableCost: 0.74 });
    expect(metrics.sessions.items.find((session) => session.path === missing)?.annotations
      .map(({ code }) => code)).toContain('rollout-usage-missing');

    expect(normalizeMetrics({
      runDirectory,
      index,
      requested: { model: 'gpt-test', effort: 'high' },
      policy,
      pricing: null,
    }).pricing).toEqual({ currency: 'USD', verification: 'unpriced', billableCost: null });
  });

  it('excludes positive usage when malformed records make model evidence incomplete', () => {
    const runDirectory = root();
    const corrupt = put(runDirectory, 'native/rollout-corrupt.jsonl', jsonl(
      { type: 'turn_context', payload: { model: 'gpt-test' } },
      '{not-json',
      tokenCount({ input_tokens: 1_000, cached_input_tokens: 400, output_tokens: 100 }),
    ));
    const metrics = normalizeMetrics({
      runDirectory,
      index: { ...emptyMetricsArtifactIndex(), rollouts: [artifact(corrupt)] },
      requested: { model: 'gpt-test', effort: 'high' },
      policy,
      pricing,
    });
    expect(metrics.tokens.byBillingClass.billable.rawTokenCount).toBe(1_100);
    expect(metrics.pricing).toEqual({ currency: 'USD', verification: 'partial', billableCost: 0 });
    expect(metrics.sessions.items[0]?.annotations.map(({ code }) => code)).toContain('rollout-malformed-json');
  });

  it('keeps pricing partial when potentially billable indexed usage cannot be established', () => {
    const runDirectory = root();
    const known = put(runDirectory, 'native/rollout-known.jsonl', jsonl(
      { type: 'turn_context', payload: { model: 'gpt-test' } },
      tokenCount({ input_tokens: 1_000, cached_input_tokens: 400, output_tokens: 100 }),
    ));
    const unknownMissing = put(runDirectory, 'native/rollout-unknown.jsonl', jsonl(
      { type: 'turn_context', payload: { effort: 'high', model: 'gpt-test' } },
    ));
    const metrics = (rollouts: RolloutArtifact[]) => normalizeMetrics({
      runDirectory,
      index: { ...emptyMetricsArtifactIndex(), rollouts },
      requested: { model: 'gpt-test', effort: 'high' },
      policy,
      pricing,
    });

    const unreadableBillable = metrics([
      artifact(known),
      artifact('native/rollout-absent.jsonl', { scope: { taskId: 'task-two', arm: 'b' } }),
    ]);
    expect(unreadableBillable.sessions.total).toBe(1);
    expect(unreadableBillable.failures.map(({ code }) => code)).toEqual(['artifact-unsafe']);
    expect(unreadableBillable.pricing).toEqual({
      currency: 'USD', verification: 'partial', billableCost: 0.74,
    });

    const missingUnknown = metrics([
      artifact(known),
      artifact(unknownMissing, {
        scope: { taskId: 'task-two', arm: 'b' },
        backend: null,
        billingClass: 'unknown',
      }),
    ]);
    expect(missingUnknown.tokens.byBillingClass.unknown.rawTokenCount).toBe(0);
    expect(missingUnknown.pricing).toEqual({
      currency: 'USD', verification: 'partial', billableCost: 0.74,
    });
  });

  it('keeps valid zero usage and non-billable sessions neutral for model-verified pricing', () => {
    const runDirectory = root();
    const zero = put(runDirectory, 'native/rollout-zero.jsonl', jsonl(
      tokenCount({ input_tokens: 0, cached_input_tokens: 0, output_tokens: 0 }),
    ));
    const missingNonBillable = put(runDirectory, 'native/rollout-missing-nonbillable.jsonl', jsonl(
      { type: 'turn_context', payload: { effort: 'high', model: 'gpt-test' } },
    ));
    const positiveNonBillable = put(runDirectory, 'native/rollout-positive-nonbillable.jsonl', jsonl(
      tokenCount({ input_tokens: 2_000, cached_input_tokens: 0, output_tokens: 200 }),
    ));
    const metrics = normalizeMetrics({
      runDirectory,
      index: {
        ...emptyMetricsArtifactIndex(),
        rollouts: [
          artifact(zero),
          artifact(missingNonBillable, {
            scope: { taskId: 'task-two', arm: 'b' },
            backend: 'local',
            billingClass: 'non-billable',
          }),
          artifact(positiveNonBillable, {
            scope: { taskId: 'task-three', arm: 'b' },
            backend: 'local',
            billingClass: 'non-billable',
          }),
        ],
      },
      requested: { model: 'gpt-test', effort: 'high' },
      policy,
      pricing,
    });
    expect(metrics.pricing).toEqual({ currency: 'USD', verification: 'priced', billableCost: 0 });
    expect(metrics.tokens.total.rawTokenCount).toBe(2_200);
    expect(metrics.tokens.byBillingClass['non-billable'].rawTokenCount).toBe(2_200);
    expect(metrics.sessions.items.find((session) => session.path === zero)?.annotations
      .map(({ code }) => code)).not.toContain('rollout-usage-missing');
    expect(metrics.sessions.items.find((session) => session.path === zero)?.annotations
      .map(({ code }) => code)).not.toContain('model-unobserved');
    expect(metrics.sessions.items.find((session) => session.path === missingNonBillable)?.annotations
      .map(({ code }) => code)).toContain('rollout-usage-missing');
    expect(metrics.sessions.items.find((session) => session.path === positiveNonBillable)?.annotations
      .map(({ code }) => code)).not.toContain('model-unobserved');
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

  it('projects failed invocations after adapter and artifact failures while ignoring successful ones', () => {
    const state = parseBenchRunState({
      schemaVersion: 2,
      kind: 'ultracode-benchmark-run-state',
      suite: 'swebench-pro',
      runId: 'run-one',
      manifestSha256: HASH,
      revision: 0,
      invocations: [
        completedInvocation(HOST_ID),
        completedInvocation(WORKER_ID, { failure: 'unknown-terminal', exitCode: 1 }),
        completedInvocation(SECOND_INVOCATION_ID, { failure: 'agent-timeout', exitCode: 1 }),
      ],
      attempts: [],
    });
    const metrics = normalizeMetrics({
      runDirectory: root(),
      index: {
        ...emptyMetricsArtifactIndex(),
        rollouts: [artifact('native/missing.jsonl')],
        failures: [failureObservationSchema.parse({
          code: 'driver-watchdog',
          scope: { kind: 'run' },
          phase: null,
          terminal: true,
          evidence: 'harness',
        })],
      },
      requested: { model: 'gpt-test', effort: 'high' },
      policy,
      pricing: null,
      runState: state,
    });

    expect(metrics.failures).toEqual([
      { code: 'driver-watchdog', scope: { kind: 'run' }, phase: null, terminal: true, evidence: 'harness' },
      {
        code: 'artifact-unsafe', scope: { kind: 'task-arm', taskId: 'task-one', arm: 'b' },
        phase: 'report', terminal: false, evidence: 'harness',
      },
      { code: 'unknown-terminal', scope: { kind: 'run' }, phase: null, terminal: true, evidence: 'harness' },
      { code: 'agent-timeout', scope: { kind: 'run' }, phase: null, terminal: true, evidence: 'native' },
    ]);
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

  it('counts grouped attempt projections once and permits per-task status differences', () => {
    const state = parseBenchRunState({
      schemaVersion: 2,
      kind: 'ultracode-benchmark-run-state',
      suite: 'featurebench',
      runId: 'run-one',
      manifestSha256: HASH,
      revision: 0,
      invocations: [{
        invocationId: HOST_ID,
        command: 'run',
        startedAt: '2026-07-20T00:00:00.000Z',
        endedAt: '2026-07-20T00:00:00.130Z',
        activeElapsedMs: 130,
        exitCode: 0,
        signal: null,
        lifecycleProcesses: [],
        failure: null,
        nativeInvocation: null,
      }],
      attempts: [
        completedAttempt(WORKER_ID, 'task-one', 'inference',
          '2026-07-20T00:00:00.000Z', '2026-07-20T00:00:00.100Z', 100,
          { timingGroupId: 'inference-batch' }),
        completedAttempt(SECOND_INVOCATION_ID, 'task-two', 'inference',
          '2026-07-20T00:00:00.000Z', '2026-07-20T00:00:00.100Z', 100,
          { timingGroupId: 'inference-batch', status: 'failed', exitCode: 1 }),
        completedAttempt(THIRD_ATTEMPT_ID, 'task-one', 'verifier',
          '2026-07-20T00:00:00.100Z', '2026-07-20T00:00:00.130Z', 30,
          { timingGroupId: 'verifier-batch', status: 'failed', exitCode: 1 }),
        completedAttempt(FOURTH_ATTEMPT_ID, 'task-two', 'verifier',
          '2026-07-20T00:00:00.100Z', '2026-07-20T00:00:00.130Z', 30,
          { timingGroupId: 'verifier-batch' }),
      ],
    });
    const metrics = normalizeMetrics({
      runDirectory: root(),
      index: emptyMetricsArtifactIndex(),
      requested: { model: 'gpt-test', effort: 'high' },
      policy,
      pricing: null,
      runState: state,
    });
    expect(metrics.timing).toMatchObject({
      criticalPathMs: 130,
      summedTaskMs: 130,
      nativeRunnerMs: 100,
      verifierMs: 30,
    });
  });

  it('counts grouped timing observations once and preserves ungrouped task sums', () => {
    const grouped = [
      timing('inference-one', 'task-one', 'inference',
        '2026-07-20T00:00:00.000Z', '2026-07-20T00:00:00.100Z', 100,
        { timingGroupId: 'inference-batch' }),
      timing('inference-two', 'task-two', 'inference',
        '2026-07-20T00:00:00.000Z', '2026-07-20T00:00:00.100Z', 100,
        { timingGroupId: 'inference-batch' }),
      timing('verifier-one', 'task-one', 'verifier',
        '2026-07-20T00:00:00.100Z', '2026-07-20T00:00:00.130Z', 30,
        { timingGroupId: 'verifier-batch' }),
      timing('verifier-two', 'task-two', 'verifier',
        '2026-07-20T00:00:00.100Z', '2026-07-20T00:00:00.130Z', 30,
        { timingGroupId: 'verifier-batch' }),
    ];
    const normalized = (timings: TimingObservation[]) => normalizeMetrics({
      runDirectory: root(),
      index: { ...emptyMetricsArtifactIndex(), timings },
      requested: { model: 'gpt-test', effort: 'high' },
      policy,
      pricing: null,
    }).timing;
    expect(normalized(grouped)).toMatchObject({
      summedTaskMs: 130,
      nativeRunnerMs: 100,
      verifierMs: 30,
    });
    expect(normalized(grouped.map(({ timingGroupId: _timingGroupId, ...entry }) => entry))).toMatchObject({
      summedTaskMs: 260,
      nativeRunnerMs: 200,
      verifierMs: 60,
    });
  });

  it.each([
    ['invocation', { invocationId: SECOND_INVOCATION_ID }],
    ['arm', { scope: { taskId: 'task-two', arm: 'a' as const } }],
    ['phase', { phase: 'verifier' as const }],
    ['start timestamp', { startedAt: '2026-07-20T00:00:00.001Z' }],
    ['end timestamp', { endedAt: '2026-07-20T00:00:00.101Z' }],
    ['elapsed time', { elapsedMs: 101 }],
  ])('rejects timing-group members that disagree on %s', (_description, conflict) => {
    const first = timing('one', 'task-one', 'inference',
      '2026-07-20T00:00:00.000Z', '2026-07-20T00:00:00.100Z', 100,
      { timingGroupId: 'batch-one' });
    const second = timing('two', 'task-two', 'inference',
      '2026-07-20T00:00:00.000Z', '2026-07-20T00:00:00.100Z', 100,
      { timingGroupId: 'batch-one', ...conflict });
    expect(() => normalize(root(), {
      ...emptyMetricsArtifactIndex(),
      timings: [first, second],
    })).toThrow(/conflicting timing group/);
  });

  it('rejects repeated and unscoped tasks in timing groups', () => {
    const first = timing('one', 'task-one', 'inference',
      '2026-07-20T00:00:00.000Z', '2026-07-20T00:00:00.100Z', 100,
      { timingGroupId: 'batch-one' });
    expect(() => normalize(root(), {
      ...emptyMetricsArtifactIndex(),
      timings: [first, { ...first, sourceKey: 'two' }],
    })).toThrow(/repeats task/);
    expect(() => normalize(root(), {
      ...emptyMetricsArtifactIndex(),
      timings: [{ ...first, scope: null }],
    })).toThrow(/task-scoped/);
  });

  it('keeps schema-v2 attempts without timing groups compatible and validates grouped attempts', () => {
    const invocation = {
      invocationId: HOST_ID,
      command: 'run',
      startedAt: '2026-07-20T00:00:00.000Z',
      endedAt: '2026-07-20T00:00:00.100Z',
      activeElapsedMs: 100,
      exitCode: 0,
      signal: null,
      lifecycleProcesses: [],
      failure: null,
      nativeInvocation: null,
    } as const;
    const first = completedAttempt(WORKER_ID, 'task-one', 'inference',
      '2026-07-20T00:00:00.000Z', '2026-07-20T00:00:00.100Z', 100);
    const value = {
      schemaVersion: 2,
      kind: 'ultracode-benchmark-run-state',
      suite: 'featurebench',
      runId: 'run-one',
      manifestSha256: HASH,
      revision: 0,
      invocations: [invocation],
      attempts: [first],
    } as const;
    expect(parseBenchRunState(value).attempts[0]?.timingGroupId).toBeUndefined();

    const grouped = {
      ...value,
      attempts: [
        { ...first, timingGroupId: 'batch-one' },
        completedAttempt(SECOND_INVOCATION_ID, 'task-two', 'inference',
          first.startedAt, first.endedAt!, first.elapsedMs!, { timingGroupId: 'batch-one' }),
      ],
    };
    expect(parseBenchRunState(grouped).attempts).toHaveLength(2);
    expect(() => parseBenchRunState({
      ...grouped,
      attempts: [grouped.attempts[0], { ...grouped.attempts[1], elapsedMs: 101 }],
    })).toThrow(/same physical process/);
    expect(() => parseBenchRunState({
      ...grouped,
      attempts: [grouped.attempts[0], { ...grouped.attempts[1], taskId: 'task-one' }],
    })).toThrow(/must not repeat a task/);
  });
});
