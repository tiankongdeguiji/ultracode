import { describe, it, expect } from 'vitest';
import { AgentCallExecutor } from '../../src/engine/agentcall.js';
import { SCHEMA_REPAIR_LIMIT } from '../../src/backends/structured.js';
import { parseJsonLine } from '../../src/backends/ndjson.js';
import { usageFromEvents } from '../../src/backends/usage.js';
import type {
  AgentEvent,
  AgentProgress,
  AgentRequest,
  AgentSpec,
  BackendAdapter,
  ExitClass,
  JsonSchema,
  SpawnPlan,
} from '../../src/backends/types.js';

/**
 * Scripted fake adapter (pattern from schema.test.ts): each spawn "runs"
 * `node -e` printing pre-scripted NDJSON — real subprocesses, hermetic.
 * Line grammar: {"session","model"} | {"iu": usage} interim | {"text"} |
 * {"done": true, "usage"?} terminal usage + result.
 */
class FakeAdapter implements BackendAdapter {
  readonly id = 'mock' as const;
  readonly structuredOutput: 'native' | 'emulated';
  spawnCount = 0;

  constructor(
    structuredOutput: 'native' | 'emulated',
    private readonly runs: { lines: object[]; exit?: number }[],
  ) {
    this.structuredOutput = structuredOutput;
  }

  probe() {
    return Promise.resolve({ available: true });
  }

  buildSpawn(_req: AgentRequest): SpawnPlan {
    const run = this.runs[Math.min(this.spawnCount, this.runs.length - 1)]!;
    this.spawnCount++;
    const body = run.lines.map((l) => `console.log(${JSON.stringify(JSON.stringify(l))})`).join(';');
    return { bin: process.execPath, argv: ['-e', run.exit ? `${body};process.exit(${run.exit})` : body], env: {} };
  }

  buildResume(): SpawnPlan | null {
    return null; // repairs go through fresh spawns
  }

  createParser() {
    return {
      push(line: string): AgentEvent[] {
        const obj = parseJsonLine(line) as Record<string, unknown> | undefined;
        if (!obj) return [];
        if (typeof obj.session === 'string') {
          return [{ kind: 'session', sessionId: obj.session, model: obj.model as string | undefined }];
        }
        if (obj.iu) return [{ kind: 'usage', usage: obj.iu as object, interim: true }];
        if (typeof obj.text === 'string') return [{ kind: 'message', text: obj.text }];
        if (obj.done) {
          const out: AgentEvent[] = [];
          if (obj.usage) out.push({ kind: 'usage', usage: obj.usage as object });
          out.push({ kind: 'result', isError: false });
          return out;
        }
        return [];
      },
      end: (): AgentEvent[] => [],
    };
  }

  classifyExit(code: number | null): ExitClass {
    return code === 0
      ? { ok: true, retryable: false, message: 'ok' }
      : { ok: false, errorKind: 'infra', retryable: true, message: `exit ${code}` };
  }

  extractUsage(events: AgentEvent[]) {
    return usageFromEvents(events);
  }
}

function spec(o: Partial<AgentSpec> = {}): AgentSpec {
  return { seq: 0, prompt: 'task', label: 't', backend: 'mock', cwd: process.cwd(), retries: 0, ...o };
}

function collect(): { events: AgentProgress[]; onProgress: (p: AgentProgress) => void } {
  const events: AgentProgress[] = [];
  return { events, onProgress: (p) => events.push(p) };
}

const tokens = (events: AgentProgress[]): number[] =>
  events.filter((p): p is Extract<AgentProgress, { type: 'usage' }> => p.type === 'usage').map((p) => p.usage.totalTokens);

const signal = new AbortController().signal;

describe('AgentCallExecutor progress', () => {
  it('interim ticks accumulate; the terminal usage replaces the sum (no double count)', async () => {
    const adapter = new FakeAdapter('native', [
      {
        lines: [
          { session: 's1', model: 'm-resolved' },
          { iu: { inputTokens: 100, outputTokens: 10 } },
          { iu: { inputTokens: 50, outputTokens: 5 } },
          { text: 'done' },
          { done: true, usage: { inputTokens: 200, outputTokens: 20 } },
        ],
      },
    ]);
    const exec = new AgentCallExecutor(adapter, { usageTickIntervalMs: 0 });
    const { events, onProgress } = collect();
    const outcome = await exec.execute(spec(), signal, onProgress);
    expect(outcome.ok).toBe(true);
    // 110 → 165 (interim sums), then 220 (authoritative replacement, NOT 165+220);
    // the attempt-end checkpoint is change-only so no duplicate 220.
    expect(tokens(events)).toEqual([110, 165, 220]);
    expect(outcome.usage.totalTokens).toBe(220);
    expect(events.filter((p) => p.type === 'model')).toEqual([{ type: 'model', model: 'm-resolved' }]);
  });

  it('reports the model once even when every stream line repeats the session', async () => {
    const adapter = new FakeAdapter('native', [
      { lines: [{ session: 's1', model: 'm1' }, { session: 's1', model: 'm1' }, { done: true }] },
    ]);
    const exec = new AgentCallExecutor(adapter, { usageTickIntervalMs: 0 });
    const { events, onProgress } = collect();
    await exec.execute(spec(), signal, onProgress);
    expect(events.filter((p) => p.type === 'model')).toHaveLength(1);
  });

  it('task retry emits retry progress and keeps ticks strictly increasing across attempts', async () => {
    const adapter = new FakeAdapter('native', [
      { lines: [{ iu: { inputTokens: 40, outputTokens: 4 } }], exit: 1 },
      { lines: [{ text: 'ok' }, { done: true, usage: { inputTokens: 80, outputTokens: 8 } }] },
    ]);
    const exec = new AgentCallExecutor(adapter, { usageTickIntervalMs: 0 });
    const { events, onProgress } = collect();
    const outcome = await exec.execute(spec({ retries: 1 }), signal, onProgress);
    expect(outcome.ok).toBe(true);
    expect(events.filter((p) => p.type === 'retry')).toEqual([
      { type: 'retry', attempt: 2, maxAttempts: 2, kind: 'task', reason: 'exit 1' },
    ]);
    // Attempt 1's failed-estimate checkpoint (~1 tok) is BELOW the 44-tok interim
    // tick already shown — suppressed by the strictly-increasing guard.
    const totals = tokens(events);
    expect(totals[0]).toBe(44);
    for (let i = 1; i < totals.length; i++) expect(totals[i]).toBeGreaterThan(totals[i - 1]!);
    expect(totals.at(-1)).toBeGreaterThanOrEqual(88); // attempt 2 real usage + attempt 1 estimate
  });

  it('schema repair emits schema-repair retry progress', async () => {
    const adapter = new FakeAdapter('emulated', [
      { lines: [{ text: '{"count": "bad"}' }, { done: true, usage: { inputTokens: 10, outputTokens: 2 } }] },
      { lines: [{ text: '{"count": 7}' }, { done: true, usage: { inputTokens: 10, outputTokens: 2 } }] },
    ]);
    const schema: JsonSchema = { type: 'object', properties: { count: { type: 'number' } }, required: ['count'] };
    const exec = new AgentCallExecutor(adapter, { usageTickIntervalMs: 0 });
    const { events, onProgress } = collect();
    const outcome = await exec.execute(spec({ schema }), signal, onProgress);
    expect(outcome.ok).toBe(true);
    expect(outcome.value).toEqual({ count: 7 });
    const retries = events.filter((p): p is Extract<AgentProgress, { type: 'retry' }> => p.type === 'retry');
    expect(retries).toHaveLength(1);
    // Overall attempt ordinal: 1 task attempt + first repair spawn = attempt 2.
    expect(retries[0]).toMatchObject({ kind: 'schema-repair', attempt: 2, maxAttempts: 1 + SCHEMA_REPAIR_LIMIT });
    expect(retries[0]!.reason).toContain('count');
  });

  it('throttles interim ticks; the attempt-end checkpoint bypasses the throttle', async () => {
    const adapter = new FakeAdapter('native', [
      {
        lines: [
          { iu: { inputTokens: 100, outputTokens: 10 } },
          { iu: { inputTokens: 50, outputTokens: 5 } },
          { done: true, usage: { inputTokens: 200, outputTokens: 20 } },
        ],
      },
    ]);
    const exec = new AgentCallExecutor(adapter, { usageTickIntervalMs: 3_600_000 });
    const { events, onProgress } = collect();
    await exec.execute(spec(), signal, onProgress);
    // First change always emits (lastTickAt starts at epoch 0); the rest of the
    // stream is throttled; the forced end-of-attempt checkpoint still lands.
    expect(tokens(events)).toEqual([110, 220]);
  });

  it('thread-cumulative usage (codex exec resume): last report per session wins, distinct sessions sum', async () => {
    // Adapter emulating codex semantics: usage events are session-cumulative.
    class CumulativeAdapter extends FakeAdapter {
      constructor(runs: { lines: object[]; exit?: number }[], private readonly resumable: boolean) {
        super('emulated', runs);
      }
      override buildResume(_s: string, _p: string, req: AgentRequest): SpawnPlan | null {
        return this.resumable ? this.buildSpawn(req) : null;
      }
      override createParser() {
        const inner = super.createParser();
        return {
          push: (line: string) =>
            inner.push(line).map((ev) => (ev.kind === 'usage' && !ev.interim ? { ...ev, threadCumulative: true } : ev)),
          end: () => inner.end(),
        };
      }
    }

    // Schema repair resumes the SAME session: attempt 2's 150 already contains
    // attempt 1's 100 → merged total must be 150, not 250.
    const sameSession = new CumulativeAdapter(
      [
        { lines: [{ session: 's1' }, { text: '{"count": "bad"}' }, { done: true, usage: { inputTokens: 90, outputTokens: 10 } }] },
        { lines: [{ session: 's1' }, { text: '{"count": 7}' }, { done: true, usage: { inputTokens: 130, outputTokens: 20 } }] },
      ],
      true,
    );
    const schema: JsonSchema = { type: 'object', properties: { count: { type: 'number' } }, required: ['count'] };
    const out1 = await new AgentCallExecutor(sameSession, { usageTickIntervalMs: 0 }).execute(spec({ schema }), signal);
    expect(out1.ok).toBe(true);
    expect(out1.usage.totalTokens).toBe(150);

    // Task retries spawn FRESH sessions: cumulative flags on distinct sessions sum.
    const distinctSessions = new CumulativeAdapter(
      [
        { lines: [{ session: 's1' }, { done: true, usage: { inputTokens: 90, outputTokens: 10 } }], exit: 1 },
        { lines: [{ session: 's2' }, { text: 'ok' }, { done: true, usage: { inputTokens: 70, outputTokens: 10 } }] },
      ],
      false,
    );
    const out2 = await new AgentCallExecutor(distinctSessions, { usageTickIntervalMs: 0 }).execute(spec({ retries: 1 }), signal);
    expect(out2.ok).toBe(true);
    expect(out2.usage.totalTokens).toBe(180);
  });

  it('starts the adapter sidecar on the session event and closes it after the attempt', async () => {
    const closed: string[] = [];
    const sidecarOpts: ({ resumedSession?: boolean } | undefined)[] = [];
    class SidecarAdapter extends FakeAdapter {
      override createSidecar(sessionId: string, emit: (ev: AgentEvent) => void, opts?: { resumedSession?: boolean }) {
        sidecarOpts.push(opts);
        emit({ kind: 'session', sessionId, model: 'sidecar-model' });
        emit({ kind: 'usage', usage: { inputTokens: 40, outputTokens: 2 }, interim: true });
        return { close: () => closed.push(sessionId) };
      }
    }
    const adapter = new SidecarAdapter('native', [
      { lines: [{ session: 's9' }, { text: 'ok' }, { done: true, usage: { inputTokens: 100, outputTokens: 10 } }] },
    ]);
    const { events, onProgress } = collect();
    const outcome = await new AgentCallExecutor(adapter, { usageTickIntervalMs: 0 }).execute(spec(), signal, onProgress);
    expect(outcome.ok).toBe(true);
    expect(events.filter((p) => p.type === 'model')).toEqual([{ type: 'model', model: 'sidecar-model' }]);
    expect(tokens(events)[0]).toBe(42); // the sidecar's interim tick reached the tracker
    expect(outcome.usage.totalTokens).toBe(110); // …but never the accounting
    expect(closed).toEqual(['s9']);
    expect(sidecarOpts).toEqual([{ resumedSession: false }]); // fresh spawn, not a repair resume

    // Without onProgress there is no consumer — the sidecar must not start.
    const adapter2 = new SidecarAdapter('native', [
      { lines: [{ session: 's10' }, { done: true, usage: { inputTokens: 1, outputTokens: 1 } }] },
    ]);
    closed.length = 0;
    await new AgentCallExecutor(adapter2, {}).execute(spec(), signal);
    expect(closed).toEqual([]);
  });

  it('works without an onProgress callback (no observable change)', async () => {
    const adapter = new FakeAdapter('native', [
      { lines: [{ iu: { inputTokens: 1, outputTokens: 1 } }, { done: true, usage: { inputTokens: 5, outputTokens: 5 } }] },
    ]);
    const exec = new AgentCallExecutor(adapter, { usageTickIntervalMs: 0 });
    const outcome = await exec.execute(spec(), signal);
    expect(outcome.ok).toBe(true);
    expect(outcome.usage.totalTokens).toBe(10);
  });
});
