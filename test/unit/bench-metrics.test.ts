import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { collectMetrics } from '../../bench/src/metrics.js';
import type { SessionMeta } from '../../bench/src/types.js';

const UUID_1 = '11111111-aaaa-7362-8c91-6e1e216cbce5';
const UUID_2 = '22222222-bbbb-7342-bf98-c24085eebe35';
const MODEL = 'gpt-5.2-codex';

const jsonl = (...records: object[]): string => records.map((r) => JSON.stringify(r)).join('\n') + '\n';

const tokenCount = (
  total: { input: number; cached: number; output: number; reasoning: number },
  last: { input: number; cached: number; output: number; reasoning: number },
): object => ({
  timestamp: '2026-07-18T04:02:01.049Z',
  type: 'event_msg',
  payload: {
    type: 'token_count',
    info: {
      total_token_usage: {
        input_tokens: total.input,
        cached_input_tokens: total.cached,
        output_tokens: total.output,
        reasoning_output_tokens: total.reasoning,
        total_tokens: total.input + total.output,
      },
      last_token_usage: {
        input_tokens: last.input,
        cached_input_tokens: last.cached,
        output_tokens: last.output,
        reasoning_output_tokens: last.reasoning,
        total_tokens: last.input + last.output,
      },
      model_context_window: 258_400,
    },
  },
});

const sessionMeta = (uuid: string): object => ({
  timestamp: '2026-07-18T04:01:52.054Z',
  type: 'session_meta',
  payload: { session_id: uuid, id: uuid, cwd: '/app', cli_version: '0.144.5' },
});

const turnContext = (): object => ({
  timestamp: '2026-07-18T04:01:52.069Z',
  type: 'turn_context',
  payload: { turn_id: 't1', cwd: '/app', model: MODEL, effort: 'high' },
});

/** rollout 1: last cumulative 3000/1200/350/80 -> tuple 1800/1200/350/80 total 2350; peak 2250; 1 compaction */
const ROLLOUT_1 = jsonl(
  sessionMeta(UUID_1),
  turnContext(),
  tokenCount({ input: 1000, cached: 400, output: 100, reasoning: 20 }, { input: 1000, cached: 400, output: 100, reasoning: 20 }),
  { timestamp: '2026-07-18T04:03:00.000Z', type: 'compacted', payload: { message: '' } },
  { timestamp: '2026-07-18T04:03:00.001Z', type: 'event_msg', payload: { type: 'context_compacted' } },
  tokenCount({ input: 3000, cached: 1200, output: 350, reasoning: 80 }, { input: 2000, cached: 800, output: 250, reasoning: 60 }),
);

/** rollout 2: last cumulative 4000/2000/500/100 -> tuple 2000/2000/500/100 total 2800; peak 3950 */
const ROLLOUT_2 = jsonl(
  sessionMeta(UUID_2),
  turnContext(),
  tokenCount({ input: 500, cached: 0, output: 50, reasoning: 10 }, { input: 500, cached: 0, output: 50, reasoning: 10 }),
  tokenCount({ input: 4000, cached: 2000, output: 500, reasoning: 100 }, { input: 3500, cached: 2000, output: 450, reasoning: 90 }),
);

const HOST_WITH_START = jsonl(
  { type: 'item.started', item: { id: 'item_0', type: 'mcp_tool_call', server: 'ultracode', tool: 'workflow_start', status: 'in_progress' } },
  { type: 'item.completed', item: { id: 'item_0', type: 'mcp_tool_call', server: 'ultracode', tool: 'workflow_start', status: 'completed' } },
);

const HOST_WITHOUT_START = jsonl(
  { type: 'item.completed', item: { id: 'item_0', type: 'command_execution', command: 'ls', status: 'completed' } },
  { type: 'item.completed', item: { id: 'item_1', type: 'mcp_tool_call', server: 'ultracode', tool: 'workflow_status', status: 'completed' } },
);

interface FixtureOpts {
  hostLog?: string | null;
  ucConfig?: { backend: string; cwd: string };
  rollouts?: boolean;
}

function makeArmDir(opts: FixtureOpts = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'uc-bench-metrics-'));
  const put = (rel: string, content: string): void => {
    const file = join(dir, rel);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, content);
  };
  if (opts.rollouts !== false) {
    put(`codex-home/sessions/2026/07/18/rollout-2026-07-18T10-00-00-${UUID_1}.jsonl`, ROLLOUT_1);
    put(`codex-home/sessions/2026/07/18/rollout-2026-07-18T11-00-00-${UUID_2}.jsonl`, ROLLOUT_2);
  }
  if (opts.hostLog !== null) put('logs/host.jsonl', opts.hostLog ?? HOST_WITH_START);
  const cfg = opts.ucConfig ?? { backend: 'codex', cwd: '/app' };
  put(
    'uc/runs/wf_x/output.json',
    JSON.stringify({
      result: null,
      logs: [],
      droppedLogs: 0,
      failures: ['agent 3 failed'],
      agentCount: 5,
      totalTokens: 12_345,
      totalToolCalls: 3,
      durationMs: 1000,
      workspaces: ['/bench/uc/wt1'],
    }),
  );
  put('uc/runs/wf_x/manifest.json', JSON.stringify({ runId: 'wf_x', status: 'completed', agentCount: 5 }));
  put('uc/runs/wf_x/config.json', JSON.stringify(cfg));
  return dir;
}

const makeMeta = (over: Partial<SessionMeta> = {}): SessionMeta => ({
  codexExit: 0,
  startedAt: 1_000,
  endedAt: 1_060,
  baseSha: 'abc',
  expectedBase: 'abc',
  patchBytes: 10,
  applyCheck: true,
  ucRuns: [{ runId: 'wf_x', status: 'completed' }],
  waitedForTerminalMs: 0,
  failure: null,
  ...over,
});

describe('collectMetrics rollout usage', () => {
  it('uses last-cumulative token_count per session and the 0.1x cached term in totals', () => {
    const m = collectMetrics(makeArmDir(), 'b');
    expect(m.sessions).toHaveLength(2);
    const s1 = m.sessions.find((s) => s.sessionId === UUID_1);
    const s2 = m.sessions.find((s) => s.sessionId === UUID_2);
    // last cumulative, NOT summed turns (summed turns would give input 4000 raw for s1)
    // reasoning is a subset of output in codex usage — reported, never re-added
    expect(s1?.usage).toEqual({ input: 1800, cachedInput: 1200, output: 350, reasoning: 80, total: 2270 });
    expect(s2?.usage).toEqual({ input: 2000, cachedInput: 2000, output: 500, reasoning: 100, total: 2700 });
    expect(s1?.model).toBe(MODEL);
    expect(m.totalUsage).toEqual({
      input: 3800,
      cachedInput: 3200,
      output: 850,
      reasoning: 180,
      total: 3800 + 850 + Math.round(0.1 * 3200),
    });
  });

  it('counts each compaction once, preferring the event_msg form over compacted records', () => {
    const m = collectMetrics(makeArmDir(), 'b');
    expect(m.compactionEvents).toBe(1);
    expect(m.sessions.find((s) => s.sessionId === UUID_1)?.compactions).toBe(1);
  });

  it('tracks context peak from last_token_usage and the model context window', () => {
    const m = collectMetrics(makeArmDir(), 'b');
    expect(m.contextPeak).toBe(3950);
    expect(m.sessions.find((s) => s.sessionId === UUID_1)?.contextPeak).toBe(2250);
    expect(m.contextWindow).toBe(258_400);
  });

  it('degrades to zeros on an empty arm dir', () => {
    const dir = mkdtempSync(join(tmpdir(), 'uc-bench-metrics-empty-'));
    const m = collectMetrics(dir, 'a');
    expect(m.sessions).toEqual([]);
    expect(m.totalUsage).toEqual({ input: 0, cachedInput: 0, output: 0, reasoning: 0, total: 0 });
    expect(m.contextWindow).toBeNull();
    expect(m.wallClockMs).toBe(0);
    expect(m.uc).toBeUndefined();
    expect(m.costUSD).toBeUndefined();
  });
});

describe('collectMetrics uc cross-check', () => {
  it('populates uc from output.json + manifest.json when uc/runs exists', () => {
    const m = collectMetrics(makeArmDir(), 'b');
    expect(m.uc).toEqual({
      runs: [{ runId: 'wf_x', status: 'completed', totalTokens: 12_345, agentCount: 5, failures: 1 }],
      engineTotalTokens: 12_345,
      agentCount: 5,
      workspacesKept: 1,
    });
  });

  it('annotates mock-backend and cwd-mismatch from config.json', () => {
    const m = collectMetrics(makeArmDir({ ucConfig: { backend: 'mock', cwd: '/tmp/elsewhere' } }), 'b');
    expect(m.annotations).toContain('mock-backend');
    expect(m.annotations).toContain('cwd-mismatch');
    const clean = collectMetrics(makeArmDir(), 'b');
    expect(clean.annotations).not.toContain('mock-backend');
    expect(clean.annotations).not.toContain('cwd-mismatch');
  });
});

describe('collectMetrics orchestration detection', () => {
  it('does not annotate arm b when host.jsonl carries a workflow_start mcp call', () => {
    expect(collectMetrics(makeArmDir(), 'b').annotations).not.toContain('no-orchestration');
  });

  it('annotates no-orchestration when host.jsonl lacks the call or is missing', () => {
    expect(collectMetrics(makeArmDir({ hostLog: HOST_WITHOUT_START }), 'b').annotations).toContain('no-orchestration');
    expect(collectMetrics(makeArmDir({ hostLog: null }), 'b').annotations).toContain('no-orchestration');
  });

  it('never annotates arm a', () => {
    expect(collectMetrics(makeArmDir({ hostLog: null }), 'a').annotations).not.toContain('no-orchestration');
  });
});

describe('collectMetrics meta-derived fields', () => {
  it('computes wallClockMs from meta epoch seconds', () => {
    expect(collectMetrics(makeArmDir(), 'b', { meta: makeMeta() }).wallClockMs).toBe(60_000);
  });

  it('adds the arm-b post-codex wait for detached runs into wallClockMs', () => {
    const m = collectMetrics(makeArmDir(), 'b', { meta: makeMeta({ waitedForTerminalMs: 90_000 }) });
    expect(m.wallClockMs).toBe(150_000);
  });

  it('annotates monitor-abandoned only for waited-on non-terminal uc runs', () => {
    const abandoned = collectMetrics(makeArmDir(), 'b', {
      meta: makeMeta({ waitedForTerminalMs: 5_000, ucRuns: [{ runId: 'wf_x', status: 'running' }] }),
    });
    expect(abandoned.annotations).toContain('monitor-abandoned');
    const terminal = collectMetrics(makeArmDir(), 'b', { meta: makeMeta({ waitedForTerminalMs: 5_000 }) });
    expect(terminal.annotations).not.toContain('monitor-abandoned');
  });

  it('annotates no-rollouts when meta reports uc runs but no rollout usage exists', () => {
    const m = collectMetrics(makeArmDir({ rollouts: false }), 'b', { meta: makeMeta() });
    expect(m.annotations).toContain('no-rollouts');
    const withRollouts = collectMetrics(makeArmDir(), 'b', { meta: makeMeta() });
    expect(withRollouts.annotations).not.toContain('no-rollouts');
  });
});

describe('collectMetrics cost', () => {
  it('prices summed usage per the pricing map, rounded to cents', () => {
    const m = collectMetrics(makeArmDir(), 'b', {
      pricing: { [MODEL]: { inputPerM: 1000, cachedPerM: 100, outputPerM: 1000 } },
    });
    // (3800/1e6)*1000 + (3200/1e6)*100 + (1030/1e6)*1000 = 3.8 + 0.32 + 1.03
    expect(m.costUSD).toBe(4.97);
  });

  it('omits costUSD when the model has no pricing entry', () => {
    const m = collectMetrics(makeArmDir(), 'b', { pricing: { 'other-model': { inputPerM: 1, cachedPerM: 1, outputPerM: 1 } } });
    expect(m.costUSD).toBeUndefined();
  });
});
