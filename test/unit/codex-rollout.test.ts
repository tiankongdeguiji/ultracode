import { describe, it, expect } from 'vitest';
import { appendFileSync, mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
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
const tokenCount = (input: number, cached: number, output: number): string =>
  JSON.stringify({
    timestamp: 't',
    type: 'event_msg',
    payload: {
      type: 'token_count',
      info: {
        total_token_usage: { input_tokens: input, cached_input_tokens: cached, output_tokens: output, reasoning_output_tokens: 0, total_tokens: input + output },
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
