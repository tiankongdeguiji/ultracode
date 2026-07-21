/**
 * Task-retry resume: a retry continues the failed attempt's backend session
 * (buildResume) instead of respawning fresh, with fresh-spawn fallbacks for
 * missing/invalid session ids, resume-unsupported adapters, and resumes that
 * die without reattaching. Also covers the session-aware usage subsumption
 * and the setTimeout-overflow guard for huge per-attempt timeouts.
 */
import { describe, it, expect } from 'vitest';
import { AgentCallExecutor, resumableSessionId } from '../../src/engine/agentcall.js';
import { usageFromEvents } from '../../src/backends/usage.js';
import { parseJsonLine } from '../../src/backends/ndjson.js';
import type { AgentEvent, AgentRequest, AgentSpec, BackendAdapter, ExitClass, SpawnPlan } from '../../src/backends/types.js';
import type { ProcessInspectionOptions } from '../../src/exec/procinfo.js';

const SIGNAL = new AbortController().signal;
// Keep real process-group spawn/kill while isolating these tests from host-wide discovery.
const COMPLETE_EMPTY_PROCESS_DISCOVERY: ProcessInspectionOptions = {
  discoverWorkerProcesses: () => ({ processes: [], complete: true }),
};

function spec(overrides: Partial<AgentSpec> = {}): AgentSpec {
  return { seq: 0, prompt: 'task', label: 't', backend: 'mock', cwd: process.cwd(), retries: 0, ...overrides };
}

interface ScriptedAttempt {
  lines: Record<string, unknown>[];
  exit: number;
  /** print nothing and hang (for watchdog kills) instead of exiting */
  hang?: boolean;
  /** wait this long before exiting (after printing lines) */
  delayMs?: number;
}

/** Plays one scripted process per spawn/resume, in queue order. Line protocol:
 *  {session}, {text}, {usage, cumulative}, {done}. Non-zero exits classify as
 *  retryable infra so the task-retry loop engages. */
class ScriptedAdapter implements BackendAdapter {
  readonly id = 'mock' as const;
  readonly structuredOutput = 'emulated' as const;
  spawnCalls = 0;
  resumeCalls: Array<{ sessionId: string; prompt: string }> = [];
  resumeSupported = true;
  constructor(private readonly queue: ScriptedAttempt[]) {}
  probe() {
    return Promise.resolve({ available: true });
  }
  private nextPlan(): SpawnPlan {
    const a = this.queue.shift() ?? { lines: [], exit: 1 };
    const prints = a.lines.map((l) => `console.log(${JSON.stringify(JSON.stringify(l))});`).join('');
    const tail = a.hang
      ? 'setTimeout(()=>{}, 10000)'
      : a.delayMs
        ? `setTimeout(()=>process.exit(${a.exit}), ${a.delayMs})`
        : `process.exit(${a.exit})`;
    return { bin: process.execPath, argv: ['-e', `${prints}${tail}`], env: {} };
  }
  buildSpawn(_req: AgentRequest): SpawnPlan {
    this.spawnCalls++;
    return this.nextPlan();
  }
  buildResume(sessionId: string, prompt: string, _req: AgentRequest): SpawnPlan | null {
    if (!this.resumeSupported) return null;
    this.resumeCalls.push({ sessionId, prompt });
    return this.nextPlan();
  }
  createParser() {
    return {
      push(line: string): AgentEvent[] {
        const obj = parseJsonLine(line) as Record<string, unknown> | undefined;
        if (!obj) return [];
        if (typeof obj.session === 'string') return [{ kind: 'session', sessionId: obj.session }];
        if (typeof obj.text === 'string') return [{ kind: 'message', text: obj.text }];
        if (obj.usage) {
          return [{ kind: 'usage', usage: obj.usage as never, threadCumulative: obj.cumulative === true }];
        }
        if (obj.done) return [{ kind: 'result', isError: false }];
        // unrecognized lines become notices, like the real codex parser
        return [{ kind: 'notice', message: JSON.stringify(obj) }];
      },
      end: (): AgentEvent[] => [],
    };
  }
  classifyExit(code: number | null, _sig: NodeJS.Signals | null, events: AgentEvent[]): ExitClass {
    const done = events.some((e) => e.kind === 'result' && !e.isError);
    return code === 0 && done
      ? { ok: true, retryable: false, message: 'ok' }
      : { ok: false, errorKind: 'infra', retryable: true, message: `exit ${code}` };
  }
  extractUsage(events: AgentEvent[]) {
    return usageFromEvents(events);
  }
}

function scriptedExecutor(adapter: BackendAdapter): AgentCallExecutor {
  return new AgentCallExecutor(adapter, { processInspection: COMPLETE_EMPTY_PROCESS_DISCOVERY });
}

describe('resumableSessionId', () => {
  it('accepts plain ids and rejects flag-shaped or oversized ones', () => {
    expect(resumableSessionId('019f6a24-bb42-78a1-bb08-526b1e6d8853')).toBe('019f6a24-bb42-78a1-bb08-526b1e6d8853');
    expect(resumableSessionId('abc_DEF.123')).toBe('abc_DEF.123');
    expect(resumableSessionId('--dangerously-bypass')).toBeUndefined();
    expect(resumableSessionId('-x')).toBeUndefined();
    expect(resumableSessionId('has space')).toBeUndefined();
    expect(resumableSessionId('a'.repeat(200))).toBeUndefined();
    expect(resumableSessionId('')).toBeUndefined();
    expect(resumableSessionId(undefined)).toBeUndefined();
  });
});

describe('task-retry resume', () => {
  it('retry resumes the failed attempt session with a continuation prompt', async () => {
    const adapter = new ScriptedAdapter([
      { lines: [{ session: 's1' }, { text: 'partial' }], exit: 1 },
      { lines: [{ session: 's1' }, { text: 'finished after resume' }, { done: true }], exit: 0 },
    ]);
    const outcome = await scriptedExecutor(adapter).execute(spec({ retries: 1 }), SIGNAL);
    expect(outcome.ok).toBe(true);
    expect((outcome as { value?: unknown }).value).toBe('finished after resume');
    expect(outcome.attempts).toBe(2);
    expect(adapter.spawnCalls).toBe(1);
    expect(adapter.resumeCalls).toHaveLength(1);
    expect(adapter.resumeCalls[0].sessionId).toBe('s1');
    expect(adapter.resumeCalls[0].prompt).toContain('exit 1');
    expect(adapter.resumeCalls[0].prompt).toContain('do not start over');
  });

  it('failed attempt without a session id retries with a fresh spawn', async () => {
    const adapter = new ScriptedAdapter([
      { lines: [{ text: 'no session surfaced' }], exit: 1 },
      { lines: [{ text: 'ok fresh' }, { done: true }], exit: 0 },
    ]);
    const outcome = await scriptedExecutor(adapter).execute(spec({ retries: 1 }), SIGNAL);
    expect(outcome.ok).toBe(true);
    expect(adapter.resumeCalls).toHaveLength(0);
    expect(adapter.spawnCalls).toBe(2);
  });

  it('a flag-shaped session id from the stream never reaches buildResume', async () => {
    const adapter = new ScriptedAdapter([
      { lines: [{ session: '--dangerously-bypass' }], exit: 1 },
      { lines: [{ text: 'ok fresh' }, { done: true }], exit: 0 },
    ]);
    const outcome = await scriptedExecutor(adapter).execute(spec({ retries: 1 }), SIGNAL);
    expect(outcome.ok).toBe(true);
    expect(adapter.resumeCalls).toHaveLength(0);
    expect(adapter.spawnCalls).toBe(2);
  });

  it('adapter without resume support falls back to a fresh spawn', async () => {
    const adapter = new ScriptedAdapter([
      { lines: [{ session: 's1' }], exit: 1 },
      { lines: [{ text: 'ok fresh' }, { done: true }], exit: 0 },
    ]);
    adapter.resumeSupported = false;
    const outcome = await scriptedExecutor(adapter).execute(spec({ retries: 1 }), SIGNAL);
    expect(outcome.ok).toBe(true);
    expect(adapter.resumeCalls).toHaveLength(0);
    expect(adapter.spawnCalls).toBe(2);
  });

  it('a resume that dies without reattaching reruns the attempt fresh instead of burning the retry', async () => {
    const adapter = new ScriptedAdapter([
      { lines: [{ session: 's1' }], exit: 1 }, // attempt 1 (spawn) fails retryably
      { lines: [], exit: 1 }, // attempt 2 resume: reattach failure, zero events
      { lines: [{ text: 'ok fresh' }, { done: true }], exit: 0 }, // attempt 2 fresh fallback
    ]);
    const outcome = await scriptedExecutor(adapter).execute(spec({ retries: 1 }), SIGNAL);
    expect(outcome.ok).toBe(true);
    expect((outcome as { value?: unknown }).value).toBe('ok fresh');
    expect(outcome.attempts).toBe(2);
    expect(adapter.resumeCalls).toHaveLength(1);
    expect(adapter.spawnCalls).toBe(2);
  });

  it('a resume that prints only a diagnostic line (no session event) still falls back fresh', async () => {
    const adapter = new ScriptedAdapter([
      { lines: [{ session: 's1' }], exit: 1 },
      // reattach failure with stderr-style chatter on stdout: becomes a
      // notice event, but no session event → still a mechanism failure
      { lines: [{ diagnostic: 'error: session not found' }], exit: 1 },
      { lines: [{ text: 'ok fresh' }, { done: true }], exit: 0 },
    ]);
    const outcome = await scriptedExecutor(adapter).execute(spec({ retries: 1 }), SIGNAL);
    expect(outcome.ok).toBe(true);
    expect((outcome as { value?: unknown }).value).toBe('ok fresh');
    expect(outcome.attempts).toBe(2);
    expect(adapter.resumeCalls).toHaveLength(1);
    expect(adapter.spawnCalls).toBe(2);
  });

  it('usage of a killed attempt is subsumed by a later cumulative report on the same session', async () => {
    const adapter = new ScriptedAdapter([
      { lines: [{ session: 's1' }, { text: 'partial work' }], exit: 1 }, // no usage reported
      {
        lines: [
          { session: 's1' },
          { usage: { inputTokens: 900, outputTokens: 100 }, cumulative: true },
          { text: 'done' },
          { done: true },
        ],
        exit: 0,
      },
    ]);
    const outcome = await scriptedExecutor(adapter).execute(spec({ retries: 1 }), SIGNAL);
    expect(outcome.ok).toBe(true);
    // exactly the cumulative figure: no chars/4 estimate stacked on top, and
    // the total is not flagged estimated (no '~' in the panel)
    expect(outcome.usage.totalTokens).toBe(1000);
    expect(outcome.usage.estimated).toBe(false);
  });

  it('a zero-usage attempt AFTER the session\'s last cumulative report is still estimated (ordering-aware subsumption)', async () => {
    const adapter = new ScriptedAdapter([
      // attempt 1 reports the session's (only) cumulative total, then fails retryably
      { lines: [{ session: 's1' }, { usage: { inputTokens: 900, outputTokens: 100 }, cumulative: true }], exit: 1 },
      // the resume does further work but is killed before reporting — NOT covered by attempt 1's figure
      { lines: [{ session: 's1' }], exit: 1 },
    ]);
    const outcome = await scriptedExecutor(adapter).execute(spec({ retries: 1 }), SIGNAL);
    expect(outcome.ok).toBe(false);
    // 1000 real + ceil(4-char prompt / 4) = 1 estimated for the uncovered resume
    expect(outcome.usage.totalTokens).toBe(1001);
    expect(outcome.usage.estimated).toBe(true);
  });

  it('a zero-usage attempt on a DIFFERENT session is estimated even when another session reported cumulatively', async () => {
    const adapter = new ScriptedAdapter([
      { lines: [{ session: 's1' }], exit: 1 }, // dies before reporting; s1 never gets a cumulative figure
      // retry resumes but lands on a fresh backend session that reports cumulatively
      { lines: [{ session: 's2' }, { usage: { inputTokens: 900, outputTokens: 100 }, cumulative: true }, { done: true }], exit: 0 },
    ]);
    const outcome = await scriptedExecutor(adapter).execute(spec({ retries: 1 }), SIGNAL);
    expect(outcome.ok).toBe(true);
    expect(outcome.usage.totalTokens).toBe(1001); // 1000 real + 1 estimated for s1
    expect(outcome.usage.estimated).toBe(true);
  });

  it('a stall-killed resume with zero events burns the attempt — no same-attempt fresh rerun', async () => {
    const adapter = new ScriptedAdapter([
      { lines: [{ session: 's1' }], exit: 1 }, // attempt 1 fails retryably
      { lines: [], exit: 0, hang: true }, // resume hangs silently → stall watchdog kill
    ]);
    const outcome = await scriptedExecutor(adapter).execute(spec({ retries: 1, stallMs: 250 }), SIGNAL);
    expect(outcome.ok).toBe(false);
    expect(outcome.error).toContain('stall watchdog');
    expect(adapter.resumeCalls).toHaveLength(1);
    expect(adapter.spawnCalls).toBe(1); // watchdog kills never trigger the fresh fallback
  }, 15_000);

  it('retries: 2 chains onto the LATEST session, including one minted by the fresh fallback', async () => {
    const adapter = new ScriptedAdapter([
      { lines: [{ session: 's1' }], exit: 1 }, // attempt 1 (spawn) fails retryably
      { lines: [], exit: 1 }, // attempt 2 resume of s1: mechanism failure (zero events)
      { lines: [{ session: 's2' }], exit: 1 }, // attempt 2 fresh fallback: new session, fails retryably
      { lines: [{ session: 's2' }, { text: 'ok on s2' }, { done: true }], exit: 0 }, // attempt 3 resumes s2
    ]);
    const outcome = await scriptedExecutor(adapter).execute(spec({ retries: 2 }), SIGNAL);
    expect(outcome.ok).toBe(true);
    expect((outcome as { value?: unknown }).value).toBe('ok on s2');
    expect(outcome.attempts).toBe(3);
    expect(adapter.resumeCalls.map((r) => r.sessionId)).toEqual(['s1', 's2']);
    expect(adapter.spawnCalls).toBe(2);
  });

  it('schema repair never resumes a flag-shaped session id (fresh repair spawn instead)', async () => {
    const adapter = new ScriptedAdapter([
      // clean exit but invalid structured output, with a forged session id
      { lines: [{ session: '--evil' }, { text: 'not json' }, { done: true }], exit: 0 },
      { lines: [{ text: '{"a":1}' }, { done: true }], exit: 0 }, // fresh repair attempt
    ]);
    const outcome = await scriptedExecutor(adapter).execute(spec({ schema: { type: 'object' } }), SIGNAL);
    expect(outcome.ok).toBe(true);
    expect((outcome as { value?: unknown }).value).toEqual({ a: 1 });
    expect(adapter.resumeCalls).toHaveLength(0); // '--evil' must never reach buildResume
    expect(adapter.spawnCalls).toBe(2);
  });

  it('non-cumulative usage (claude/qoder-style) sums across a resumed retry on the same session', async () => {
    const adapter = new ScriptedAdapter([
      { lines: [{ session: 's1' }, { usage: { inputTokens: 100, outputTokens: 10 } }], exit: 1 },
      { lines: [{ session: 's1' }, { usage: { inputTokens: 200, outputTokens: 20 } }, { done: true }], exit: 0 },
    ]);
    const outcome = await scriptedExecutor(adapter).execute(spec({ retries: 1 }), SIGNAL);
    expect(outcome.ok).toBe(true);
    // per-attempt (non-thread-cumulative) figures add up — no dedupe, no estimate
    expect(outcome.usage.totalTokens).toBe(330);
    expect(outcome.usage.estimated).toBe(false);
  });

  it('a timeoutMs beyond the setTimeout range never insta-kills the attempt', async () => {
    const adapter = new ScriptedAdapter([{ lines: [{ text: 'quick' }, { done: true }], exit: 0 }]);
    const outcome = await scriptedExecutor(adapter).execute(spec({ timeoutMs: 2 ** 31 }), SIGNAL);
    expect(outcome.ok).toBe(true);
    expect((outcome as { value?: unknown }).value).toBe('quick');
  });

  it('a mid-stream session event with a different id is inert (first session wins)', async () => {
    const adapter = new ScriptedAdapter([
      // a compromised worker naming a sibling's session mid-stream must not
      // redirect the retry-resume
      { lines: [{ session: 's1' }, { text: 'work' }, { session: 'sibling-target' }], exit: 1 },
      { lines: [{ session: 's1' }, { text: 'resumed' }, { done: true }], exit: 0 },
    ]);
    const outcome = await scriptedExecutor(adapter).execute(spec({ retries: 1 }), SIGNAL);
    expect(outcome.ok).toBe(true);
    expect(adapter.resumeCalls.map((r) => r.sessionId)).toEqual(['s1']);
  });

  it('the fresh fallback shares the attempt deadline instead of arming a second full window', async () => {
    const adapter = new ScriptedAdapter([
      { lines: [{ session: 's1' }], exit: 1 }, // attempt 1 fails fast, retryably
      { lines: [], exit: 1, delayMs: 3_500 }, // resume: zero events, dies on its own late in the budget
      { lines: [], exit: 0, hang: true }, // fresh fallback: hangs → must be killed at the REMAINING budget
    ]);
    const outcome = await scriptedExecutor(adapter).execute(spec({ retries: 1, timeoutMs: 6_000 }), SIGNAL);
    expect(outcome.ok).toBe(false);
    // Deterministic shape assertion, no wall-clock race: the fallback's kill
    // message carries ITS timer value — a remainder (6000 − ~3500 − overhead)
    // if the deadline is shared, the full 6000 if a second window was armed.
    const killedAfterMs = Number(/attempt timed out after (\d+)ms/.exec(outcome.error ?? '')?.[1]);
    expect(killedAfterMs).toBeGreaterThanOrEqual(1_000); // above the synthesize-floor: a real remainder spawn ran
    expect(killedAfterMs).toBeLessThan(6_000); // strictly less than a second full window
    expect(adapter.resumeCalls).toHaveLength(1);
    expect(adapter.spawnCalls).toBe(2); // attempt 1 + the fallback rerun
  }, 20_000);

  it('a sub-second remainder synthesizes the timeout instead of spawning a doomed fresh process', async () => {
    const adapter = new ScriptedAdapter([
      { lines: [{ session: 's1' }], exit: 1 }, // fails fast, retryably
      { lines: [], exit: 1, delayMs: 1_000 }, // resume: zero events, leaves <1s of the 1.5s budget
    ]);
    const outcome = await scriptedExecutor(adapter).execute(spec({ retries: 1, timeoutMs: 1_500 }), SIGNAL);
    expect(outcome.ok).toBe(false);
    expect(outcome.error).toBe('attempt timed out after 1500ms'); // synthesized: names the FULL budget
    expect(adapter.resumeCalls).toHaveLength(1);
    expect(adapter.spawnCalls).toBe(1); // no doomed fresh spawn
  }, 15_000);
});
