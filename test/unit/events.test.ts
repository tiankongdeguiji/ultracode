import { describe, it, expect } from 'vitest';
import { executeWorkflow, type ExecuteOptions } from '../../src/engine/run.js';
import { MockExecutor } from '../../src/backends/mock.js';
import type { RunEvent } from '../../src/engine/hostapi.js';

type EventOf<T extends RunEvent['type']> = Extract<RunEvent, { type: T }>;

async function run(script: string, opts: Partial<ExecuteOptions> = {}) {
  const events: RunEvent[] = [];
  const out = await executeWorkflow(script, {
    executor: new MockExecutor(),
    maxConcurrency: 2,
    ...opts,
    onEvent: (e) => events.push(e),
  });
  const ofType = <T extends RunEvent['type']>(type: T): EventOf<T>[] =>
    events.filter((e): e is EventOf<T> => e.type === type);
  return { out, events, ofType };
}

describe('progress-plane events', () => {
  it('agent_usage ticks carry the agent seq and precede its completion', async () => {
    const { out, events, ofType } = await run(`export const meta = { name: 't', description: 'd' }
await agent('MOCK:ok x', { label: 'a1' })
return 1`);
    expect(out.error).toBeUndefined();
    const usage = ofType('agent_usage');
    expect(usage).toHaveLength(1); // one attempt → one mock tick
    expect(usage[0]).toMatchObject({ seq: 0, estimated: false });
    expect(usage[0]!.totalTokens).toBeGreaterThan(0);
    expect(events.findIndex((e) => e.type === 'agent_usage')).toBeLessThan(
      events.findIndex((e) => e.type === 'agent_completed'),
    );
  });

  it('agent_retry fires between task attempts with attempt/maxAttempts', async () => {
    const { out, ofType } = await run(`export const meta = { name: 't', description: 'd' }
await agent('MOCK:fail-then-ok 1 ok', { label: 'r', retries: 1 })
return 1`);
    expect(out.error).toBeUndefined();
    expect(ofType('agent_retry')).toEqual([
      expect.objectContaining({ seq: 0, label: 'r', attempt: 2, maxAttempts: 2, kind: 'task' }),
    ]);
  });

  it('agent_started carries the requested model/effort/agentType; agent_model reports the resolved one', async () => {
    const { ofType } = await run(`export const meta = { name: 't', description: 'd' }
await agent('MOCK:ok x', { label: 'm', model: 'sonnet', effort: 'low', agentType: 'reviewer' })
return 1`);
    expect(ofType('agent_started')[0]).toMatchObject({ model: 'sonnet', effort: 'low', agentType: 'reviewer' });
    expect(ofType('agent_model')).toEqual([expect.objectContaining({ seq: 0, model: 'sonnet' })]);
  });

  it('cache-replayed agents complete with cached:true, zero tokens, and no queued/started events', async () => {
    const { out, events, ofType } = await run(
      `export const meta = { name: 't', description: 'd' }
return await agent('MOCK:ok x', { label: 'c' })`,
      { cacheLookup: () => ({ hit: true, value: 'from-cache' }) },
    );
    expect(out.result).toBe('from-cache');
    expect(ofType('agent_completed')).toEqual([
      expect.objectContaining({ ok: true, cached: true, totalTokens: 0 }),
    ]);
    expect(events.some((e) => e.type === 'agent_started' || e.type === 'agent_queued')).toBe(false);
    expect(events.some((e) => e.type === 'budget_tick')).toBe(false); // replayed tokens are free
  });
});
