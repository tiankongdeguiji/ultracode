import { describe, it, expect } from 'vitest';
import { executeWorkflow, type ExecuteOptions } from '../../src/engine/run.js';
import { MockExecutor } from '../../src/backends/mock.js';
import { TOOL_EVENT_CAP, type RunEvent } from '../../src/engine/hostapi.js';
import type { AgentExecutor, AgentOutcome, AgentProgress } from '../../src/backends/types.js';

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

  it('MOCK:tools emits paired agent_tool events before completion; agent_completed carries the count', async () => {
    const { out, events, ofType } = await run(`export const meta = { name: 't', description: 'd' }
await agent('MOCK:tools 3 MOCK:ok x', { label: 'tooler' })
return 1`);
    expect(out.error).toBeUndefined();
    const tools = ofType('agent_tool');
    expect(tools).toEqual([
      { type: 'agent_tool', seq: 0, name: 'tool:mock-1', status: 'started' },
      { type: 'agent_tool', seq: 0, name: 'tool:mock-1', status: 'completed' },
      { type: 'agent_tool', seq: 0, name: 'tool:mock-2', status: 'started' },
      { type: 'agent_tool', seq: 0, name: 'tool:mock-2', status: 'completed' },
      { type: 'agent_tool', seq: 0, name: 'tool:mock-3', status: 'started' },
      { type: 'agent_tool', seq: 0, name: 'tool:mock-3', status: 'completed' },
    ]);
    expect(events.findIndex((e) => e.type === 'agent_completed')).toBeGreaterThan(
      events.findLastIndex((e) => e.type === 'agent_tool'),
    );
    expect(ofType('agent_completed')[0]).toMatchObject({ toolCalls: 3 });
  });

  it('agent_tool names are bounded at emission (control bytes stripped, length capped) and ticks capped per dispatch', async () => {
    const evil = 'x'.repeat(300) + '\x1b[2J\x07';
    const floodExecutor: AgentExecutor = {
      execute(_spec, _signal, onProgress?: (p: AgentProgress) => void): Promise<AgentOutcome> {
        onProgress?.({ type: 'tool', name: evil, status: 'started' });
        for (let i = 0; i < TOOL_EVENT_CAP + 50; i++) {
          onProgress?.({ type: 'tool', name: 'flood', status: 'started' });
        }
        return Promise.resolve({
          ok: true,
          value: 'done',
          usage: { inputTokens: 1, outputTokens: 1, cachedInputTokens: 0, reasoningTokens: 0, totalTokens: 2, estimated: false },
          toolCalls: TOOL_EVENT_CAP + 51,
          attempts: 1,
        });
      },
    };
    const { ofType } = await run(
      `export const meta = { name: 't', description: 'd' }
await agent('anything', { label: 'evil' })
return 1`,
      { executor: floodExecutor },
    );
    const tools = ofType('agent_tool');
    expect(tools).toHaveLength(TOOL_EVENT_CAP); // cap holds
    const name = tools[0]!.name;
    expect(name.length).toBeLessThanOrEqual(80);
    expect(name).not.toMatch(/[\x00-\x1f]/); // control bytes never enter the stream
    expect(ofType('agent_completed')[0]).toMatchObject({ toolCalls: TOOL_EVENT_CAP + 51 }); // authority unaffected
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
