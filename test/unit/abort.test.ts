/**
 * Stop-while-in-flight accounting: when a run is aborted after an agent's
 * execute() returns but before settlement, the completed outcome must still be
 * counted (budget) and journaled (onAgentSettled) before the stop propagates —
 * otherwise stopped runs underreport tokens and drop resume-able records.
 */
import { describe, it, expect } from 'vitest';
import { executeWorkflow } from '../../src/engine/run.js';
import type { AgentExecutor, AgentOutcome } from '../../src/backends/types.js';
import type { AgentSettledRecord } from '../../src/engine/hostapi.js';

const SINGLE = `export const meta = { name: 'abort-one', description: 'd' }
const r = await agent('do work', { label: 'w' })
return r`;

describe('stop while an agent is in flight', () => {
  it('settles the completed outcome (budget + journal) before propagating the stop', async () => {
    const abort = new AbortController();
    // The agent completes successfully but the run is aborted as it returns —
    // simulating a stop landing between execute() and settlement.
    const executor: AgentExecutor = {
      async execute(spec): Promise<AgentOutcome> {
        abort.abort(new Error('stopped'));
        return {
          ok: true,
          value: `done-${spec.label}`,
          usage: {
            inputTokens: 10,
            outputTokens: 5,
            cachedInputTokens: 0,
            reasoningTokens: 0,
            totalTokens: 15,
            estimated: false,
          },
          toolCalls: 0,
          attempts: 1,
        };
      },
    };

    const settled: AgentSettledRecord[] = [];
    const out = await executeWorkflow(SINGLE, {
      executor,
      signal: abort.signal,
      onAgentSettled: (r) => settled.push(r),
    });

    // The run is stopped (the abort threw out of agent()) ...
    expect(out.error).toBeTruthy();
    // ... but the in-flight outcome was still recorded: tokens counted AND a
    // journal record emitted (status ok + value → replay-able on resume).
    expect(settled).toHaveLength(1);
    expect(settled[0]!.status).toBe('ok');
    expect(settled[0]!.value).toBe('done-w');
    expect(settled[0]!.usage.totalTokens).toBe(15);
    expect(out.totalTokens).toBe(15);
  });
});
