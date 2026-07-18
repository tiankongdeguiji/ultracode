/**
 * bench/src/report.ts: Wilson interval and exact McNemar known values, plus
 * buildReport aggregation + markdown on in-memory fixtures. The IO-only
 * generateReport wrapper (manifest/status/metrics/eval reads) is not driven
 * here — state.js/eval.js are mocked so the module loads without its
 * concurrently-built siblings; buildReport itself never touches them.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('../../bench/src/state.js', () => ({ readStatus: vi.fn() }));
vi.mock('../../bench/src/eval.js', () => ({ readEvalResults: vi.fn() }));

import {
  buildReport,
  effectiveResolved,
  mcnemarExact,
  wilson,
  POWER_DISCLAIMER,
  SUMMARY_TABLE_HEADER,
} from '../../bench/src/report.js';
import type { InstanceInputs, ReportInputs } from '../../bench/src/report.js';
import { DEFAULT_CONFIG } from '../../bench/src/config.js';
import type { ArmMetrics, ArmStatus, RunManifest, UsageTuple } from '../../bench/src/types.js';

describe('wilson', () => {
  it('matches known values for k=8, n=10', () => {
    const { lo, hi } = wilson(8, 10);
    expect(lo).toBeCloseTo(0.49, 2);
    expect(hi).toBeCloseTo(0.94, 2);
  });

  it('returns [0, 1] for n=0', () => {
    expect(wilson(0, 0)).toEqual({ lo: 0, hi: 1 });
  });

  it('stays clamped to [0, 1] at the extremes', () => {
    const zero = wilson(0, 10);
    expect(zero.lo).toBe(0);
    expect(zero.hi).toBeGreaterThan(0);
    const all = wilson(10, 10);
    expect(all.hi).toBe(1);
    expect(all.lo).toBeLessThan(1);
  });
});

describe('mcnemarExact', () => {
  it('b=5, c=1 -> 0.21875 exactly', () => {
    expect(mcnemarExact(5, 1)).toBe(0.21875);
  });

  it('degenerate counts cap at 1', () => {
    expect(mcnemarExact(0, 0)).toBe(1);
    expect(mcnemarExact(1, 0)).toBe(1);
  });

  it('is symmetric in (b, c)', () => {
    expect(mcnemarExact(3, 8)).toBe(mcnemarExact(8, 3));
    expect(mcnemarExact(5, 1)).toBe(mcnemarExact(1, 5));
  });

  it('is finite and tiny for large lopsided counts', () => {
    const p = mcnemarExact(100, 50);
    expect(Number.isFinite(p)).toBe(true);
    expect(p).toBeGreaterThan(0);
    expect(p).toBeLessThan(0.001);
  });
});

const usage = (total: number): UsageTuple => ({
  input: total,
  cachedInput: 0,
  output: 0,
  reasoning: 0,
  total,
});

const metrics = (arm: 'a' | 'b', over: Partial<ArmMetrics> = {}): ArmMetrics => ({
  arm,
  totalUsage: usage(1_000),
  sessions: [],
  compactionEvents: 0,
  contextPeak: 10_000,
  contextWindow: 200_000,
  wallClockMs: 600_000,
  annotations: [],
  ...over,
});

const status = (over: Partial<ArmStatus> = {}): ArmStatus => ({
  phase: 'evaled',
  failure: null,
  annotations: [],
  ...over,
});

const manifest = (instanceIds: string[]): RunManifest => ({
  runId: 'run-test',
  createdAt: '2026-07-18T00:00:00.000Z',
  config: { ...DEFAULT_CONFIG, model: 'test-model' },
  instanceIds,
  armOrder: {},
  ultracodeSha: 'UC_SHA_SENTINEL',
  codexVersion: '9.9.9',
  codexSha256: 'CODEX_SHA_SENTINEL',
});

/**
 * i1: A unresolved under context pressure (compactions), B resolved -> inside stratum.
 * i2: A resolved without pressure, B unresolved -> outside stratum.
 * i3: no eval verdicts, failures on both arms -> taxonomy only.
 */
const fixtures = (): ReportInputs => {
  const i1: InstanceInputs = {
    instanceId: 'i1',
    language: 'js',
    a: {
      status: status(),
      metrics: metrics('a', { totalUsage: usage(100_000), compactionEvents: 2, wallClockMs: 3_600_000 }),
      resolved: false,
    },
    b: {
      status: status({ annotations: ['monitor-abandoned'] }),
      metrics: metrics('b', {
        totalUsage: usage(50_000),
        uc: { runs: [], engineTotalTokens: 50_000, agentCount: 7, workspacesKept: 0 },
      }),
      resolved: true,
    },
  };
  const i2: InstanceInputs = {
    instanceId: 'i2',
    language: 'python',
    a: {
      status: status(),
      metrics: metrics('a', { totalUsage: usage(40_000) }),
      resolved: true,
    },
    b: {
      status: status(),
      metrics: metrics('b', {
        totalUsage: usage(60_000),
        annotations: ['no-orchestration'],
        uc: { runs: [], engineTotalTokens: 0, agentCount: 1, workspacesKept: 0 },
      }),
      resolved: false,
    },
  };
  const i3: InstanceInputs = {
    instanceId: 'i3',
    language: null,
    a: { status: status({ phase: 'session-done', failure: 'timeout' }), metrics: null, resolved: null },
    b: { status: status({ phase: 'pending', failure: 'agent-crash' }), metrics: null, resolved: null },
  };
  return { manifest: manifest(['i1', 'i2', 'i3']), instances: [i1, i2, i3], gold: null, nullcheck: null };
};

describe('effectiveResolved', () => {
  const status = (failure: ArmStatus['failure']): ArmStatus => ({ phase: 'session-done', failure, annotations: [] });

  it('passes through harness verdicts when present', () => {
    expect(effectiveResolved({ i1: true }, 'i1', status(null))).toBe(true);
    expect(effectiveResolved({ i1: false }, 'i1', status(null))).toBe(false);
  });

  it('stays null before the arm has been evaluated at all', () => {
    expect(effectiveResolved(null, 'i1', status('empty-patch'))).toBeNull();
  });

  it('counts agent-avoidable unsubmitted instances as losses once eval ran', () => {
    for (const f of ['empty-patch', 'patch-too-large', 'unapplyable-diff', 'timeout', 'agent-crash'] as const) {
      expect(effectiveResolved({ other: true }, 'i1', status(f))).toBe(false);
    }
  });

  it('drops infra failures from the comparison (null)', () => {
    for (const f of ['image-failed', 'toolchain-incompatible', 'eval-fail', 'harness-error'] as const) {
      expect(effectiveResolved({ other: true }, 'i1', status(f))).toBeNull();
    }
  });
});

describe('buildReport', () => {
  it('computes per-arm resolved rates over evaluated instances only', () => {
    const { json } = buildReport(fixtures());
    expect(json.arms.a.evaluated).toBe(2);
    expect(json.arms.a.resolved).toBe(1);
    expect(json.arms.a.rate).toBe(0.5);
    expect(json.arms.b.evaluated).toBe(2);
    expect(json.arms.b.resolved).toBe(1);
    const ci = wilson(1, 2);
    expect(json.arms.a.ci).toEqual(ci);
  });

  it('computes paired discordants and the McNemar p', () => {
    const { json } = buildReport(fixtures());
    expect(json.paired.n).toBe(2);
    expect(json.paired.aOnly).toBe(1);
    expect(json.paired.bOnly).toBe(1);
    expect(json.paired.bothResolved).toBe(0);
    expect(json.paired.neither).toBe(0);
    expect(json.paired.p).toBe(mcnemarExact(1, 1));
  });

  it('aggregates tokens, wall-clock, compactions, and context pressure per arm', () => {
    const { json } = buildReport(fixtures());
    expect(json.arms.a.tokens.total).toBe(140_000);
    expect(json.arms.a.tokens.mean).toBe(70_000);
    expect(json.arms.a.tokens.median).toBe(70_000);
    expect(json.arms.b.tokens.total).toBe(110_000);
    expect(json.arms.a.wallClockMs.total).toBe(4_200_000);
    expect(json.arms.a.compactions).toBe(2);
    expect(json.arms.a.contextPressured).toBe(1);
    expect(json.arms.a.costUSD).toBeNull();
  });

  it('sums costUSD only when metrics carry it', () => {
    const inputs = fixtures();
    const a1 = inputs.instances[0]?.a.metrics;
    const a2 = inputs.instances[1]?.a.metrics;
    if (a1) a1.costUSD = 1.25;
    if (a2) a2.costUSD = 0.75;
    const { json } = buildReport(inputs);
    expect(json.arms.a.costUSD).toBe(2);
    expect(json.arms.b.costUSD).toBeNull();
  });

  it('cuts the thesis stratum on arm-A context pressure', () => {
    const { json } = buildReport(fixtures());
    expect(json.thesisCut.inside).toEqual({
      n: 1,
      aResolved: 0,
      bResolved: 1,
      aRate: 0,
      bRate: 1,
      delta: 1,
    });
    expect(json.thesisCut.outside).toEqual({
      n: 1,
      aResolved: 1,
      bResolved: 0,
      aRate: 1,
      bRate: 0,
      delta: -1,
    });
    expect(json.thesisCut.unclassified).toBe(0);
  });

  it('counts failures and arm-b annotations for partial instances', () => {
    const { json } = buildReport(fixtures());
    expect(json.taxonomy.a).toEqual({ timeout: 1 });
    expect(json.taxonomy.b).toEqual({ 'agent-crash': 1 });
    expect(json.armBAnnotations).toEqual({ 'monitor-abandoned': 1, 'no-orchestration': 1 });
    const i3 = json.instances.find((r) => r.instanceId === 'i3');
    expect(i3).toBeDefined();
    expect(i3?.aResolved).toBeNull();
    expect(i3?.aTokens).toBeNull();
  });

  it('renders the summary table, power disclaimer, and reproducibility block', () => {
    const { md } = buildReport(fixtures());
    expect(md).toContain(SUMMARY_TABLE_HEADER);
    expect(md).toContain(POWER_DISCLAIMER);
    expect(md).toContain('UC_SHA_SENTINEL');
    expect(md).toContain('CODEX_SHA_SENTINEL');
    expect(md).toContain('| i1 | js |');
    expect(md).toContain('b:no-orchestration');
    expect(md).toContain('## Thesis cut — long-context stratum');
    expect(md).toContain('## Failure taxonomy');
    expect(md).not.toContain('## Sanity evals');
  });

  it('reports sanity evals when gold/nullcheck verdicts are present', () => {
    const inputs = fixtures();
    inputs.gold = { i1: true, i2: true };
    inputs.nullcheck = { i1: false };
    const { json, md } = buildReport(inputs);
    expect(json.sanity.gold).toEqual({ evaluated: 2, resolved: 2 });
    expect(json.sanity.nullcheck).toEqual({ evaluated: 1, resolved: 0 });
    expect(md).toContain('- gold: 2/2 resolved (expected: all)');
    expect(md).toContain('- nullcheck: 0/1 resolved (expected: none)');
  });
});
