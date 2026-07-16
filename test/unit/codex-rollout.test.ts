import { describe, it, expect } from 'vitest';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { codexUsageToPartial, createCodexRolloutSidecar } from '../../src/backends/codex-rollout.js';
import type { AgentEvent } from '../../src/backends/types.js';

function rolloutDir(home: string): string {
  const d = new Date();
  const dir = join(
    home,
    'sessions',
    String(d.getFullYear()),
    String(d.getMonth() + 1).padStart(2, '0'),
    String(d.getDate()).padStart(2, '0'),
  );
  mkdirSync(dir, { recursive: true });
  return dir;
}

const turnContext = (model: string): string =>
  JSON.stringify({ timestamp: 't', type: 'turn_context', payload: { turn_id: 'turn-1', model, effort: 'xhigh' } }) + '\n';
// total_token_usage deliberately DIFFERS from last_token_usage (cumulative vs
// per-response): a regression that reads the cumulative figure re-ticks
// ever-growing totals and must fail these assertions.
const tokenCount = (input: number, cached: number, output: number): string =>
  JSON.stringify({
    timestamp: 't',
    type: 'event_msg',
    payload: {
      type: 'token_count',
      info: {
        total_token_usage: {
          input_tokens: input * 7 + 13,
          cached_input_tokens: cached * 7 + 13,
          output_tokens: output * 7 + 13,
          reasoning_output_tokens: 0,
          total_tokens: (input + output) * 7 + 26,
        },
        last_token_usage: { input_tokens: input, cached_input_tokens: cached, output_tokens: output, reasoning_output_tokens: 0, total_tokens: input + output },
      },
    },
  }) + '\n';

function collect(): { events: AgentEvent[]; emit: (ev: AgentEvent) => void } {
  const events: AgentEvent[] = [];
  return { events, emit: (ev) => events.push(ev) };
}

describe('codex rollout sidecar', () => {
  it('emits the resolved model and per-response interim usage ticks from a live rollout', async () => {
    const home = mkdtempSync(join(tmpdir(), 'uc-codex-home-'));
    const dir = rolloutDir(home);
    const sid = '0199-live-1';
    const { events, emit } = collect();
    const sidecar = createCodexRolloutSidecar(sid, emit, { home, pollMs: 20 });
    // File appears AFTER the sidecar starts (fresh session) — discovery must find it.
    const file = join(dir, `rollout-2026-01-01T00-00-00-${sid}.jsonl`);
    writeFileSync(file, JSON.stringify({ type: 'session_meta', payload: { id: sid } }) + '\n' + turnContext('gpt-5.6-sol'));
    await sleep(120);
    appendFileSync(file, tokenCount(1000, 400, 50));
    await sleep(120);
    appendFileSync(file, tokenCount(700, 700, 30));
    await sleep(120);
    sidecar.close();

    expect(events[0]).toEqual({ kind: 'session', sessionId: sid, model: 'gpt-5.6-sol' });
    const ticks = events.filter((e): e is Extract<AgentEvent, { kind: 'usage' }> => e.kind === 'usage');
    expect(ticks).toHaveLength(2);
    expect(ticks[0]).toMatchObject({ interim: true, usage: { inputTokens: 600, cachedInputTokens: 400, outputTokens: 50 } });
    expect(ticks[1]).toMatchObject({ interim: true, usage: { inputTokens: 0, cachedInputTokens: 700, outputTokens: 30 } });
  });

  it('resumed sessions (stale rollout mtime) tail only NEW records — history is never re-ticked', async () => {
    const home = mkdtempSync(join(tmpdir(), 'uc-codex-home-'));
    const dir = rolloutDir(home);
    const sid = '0199-resumed-1';
    const file = join(dir, `rollout-2026-01-01T00-00-00-${sid}.jsonl`);
    writeFileSync(file, turnContext('gpt-5.6-sol') + tokenCount(9999, 0, 999)); // prior attempt's history
    const old = (Date.now() - 120_000) / 1000;
    utimesSync(file, old, old);

    const { events, emit } = collect();
    const sidecar = createCodexRolloutSidecar(sid, emit, { home, pollMs: 20 });
    await sleep(120);
    expect(events).toEqual([]); // history skipped
    appendFileSync(file, tokenCount(100, 0, 10));
    await sleep(120);
    sidecar.close();
    expect(events).toEqual([
      { kind: 'usage', usage: { inputTokens: 100, cachedInputTokens: 0, outputTokens: 10, reasoningTokens: 0 }, interim: true },
    ]);
  });

  it('resumedSession flag seeks to EOF even when the rollout mtime is fresh (schema repair)', async () => {
    const home = mkdtempSync(join(tmpdir(), 'uc-codex-home-'));
    const dir = rolloutDir(home);
    const sid = '0199-repair-1';
    const file = join(dir, `rollout-2026-01-01T00-00-00-${sid}.jsonl`);
    // Prior attempt finished SECONDS ago: mtime is fresh, so only the explicit
    // flag can prevent re-ticking its history.
    writeFileSync(file, turnContext('gpt-5.6-sol') + tokenCount(9999, 0, 999));

    const { events, emit } = collect();
    const sidecar = createCodexRolloutSidecar(sid, emit, { home, pollMs: 20, resumedSession: true });
    await sleep(120);
    expect(events).toEqual([]); // history skipped despite fresh mtime
    appendFileSync(file, tokenCount(50, 0, 5));
    await sleep(120);
    sidecar.close();
    expect(events).toEqual([
      { kind: 'usage', usage: { inputTokens: 50, cachedInputTokens: 0, outputTokens: 5, reasoningTokens: 0 }, interim: true },
    ]);
  });

  it('reassembles a record split across appends and skips garbage lines without dying', async () => {
    const home = mkdtempSync(join(tmpdir(), 'uc-codex-home-'));
    const dir = rolloutDir(home);
    const sid = '0199-torn-1';
    const { events, emit } = collect();
    const sidecar = createCodexRolloutSidecar(sid, emit, { home, pollMs: 20 });
    const file = join(dir, `rollout-2026-01-01T00-00-00-${sid}.jsonl`);
    const whole = tokenCount(100, 0, 10);
    // First half of a record (no newline) — must be carried, not parsed.
    writeFileSync(file, whole.slice(0, 40));
    await sleep(100);
    expect(events).toEqual([]);
    // Second half + a garbage line + another valid tick: the garbage line must
    // be skipped (a throw here would clearInterval and kill all later ticks).
    appendFileSync(file, whole.slice(40) + 'not json at all\n' + tokenCount(200, 0, 20));
    await sleep(120);
    sidecar.close();
    const ticks = events.filter((e): e is Extract<AgentEvent, { kind: 'usage' }> => e.kind === 'usage');
    expect(ticks.map((t) => t.usage.inputTokens)).toEqual([100, 200]);
  });

  it('survives the rollout being deleted mid-tail (silent degradation, no throw)', async () => {
    const home = mkdtempSync(join(tmpdir(), 'uc-codex-home-'));
    const dir = rolloutDir(home);
    const sid = '0199-deleted-1';
    const file = join(dir, `rollout-2026-01-01T00-00-00-${sid}.jsonl`);
    writeFileSync(file, turnContext('gpt-5.6-sol'));
    const { events, emit } = collect();
    const sidecar = createCodexRolloutSidecar(sid, emit, { home, pollMs: 20 });
    await sleep(100);
    expect(events).toHaveLength(1); // model emitted before deletion
    rmSync(file);
    await sleep(100); // ticks after deletion must not throw or emit
    sidecar.close();
    expect(events).toHaveLength(1);
  });

  it('missing session degrades silently', async () => {
    const home = mkdtempSync(join(tmpdir(), 'uc-codex-home-'));
    const { events, emit } = collect();
    const sidecar = createCodexRolloutSidecar('no-such-session', emit, { home, pollMs: 20 });
    await sleep(80);
    sidecar.close();
    expect(events).toEqual([]);
  });

  it('codexUsageToPartial mirrors the turn.completed subset semantics', () => {
    expect(codexUsageToPartial({ input_tokens: 1000, cached_input_tokens: 400, output_tokens: 50, reasoning_output_tokens: 20 })).toEqual({
      inputTokens: 600,
      cachedInputTokens: 400,
      outputTokens: 50,
      reasoningTokens: 0, // subset of output — dropped, not double-counted
    });
    expect(codexUsageToPartial({})).toEqual({ inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningTokens: 0 });
  });
});
