/** Static workflow control-flow and safety proxy coverage. */
import { describe, expect, it } from 'vitest';
import { analyzeWorkflowSource } from '../../bench/src/suites/workflow-authoring/analyzer.js';

const META = `export const meta = {
  name: 'uc-static-test',
  description: 'static authoring fixture',
  phases: [{ title: 'Explore' }, { title: 'Implement' }, { title: 'Review' }, { title: 'Final' }],
}
`;

describe('workflow-authoring static analysis', () => {
  it('calculates the Claude-aligned localized 12-18 agent control paths', () => {
    const source = `${META}
phase('Explore')
const scouts = await parallel([
  () => agent('Inspect implementation and data flow. Read only.'),
  () => agent('Inspect tests and reproduction. Read only.'),
  () => agent('Inspect conventions and regressions. Read only.'),
])
const design = await agent('Design the fix from scout results.', {
  schema: { type: 'object', properties: { plan: { type: 'string' } }, required: ['plan'] },
})
phase('Implement')
let implementation
try {
  implementation = await agent('Implement the requested fix as the only mutation owner.')
} catch {
  implementation = await agent('Take over the failed implementation from the current working tree.')
}
phase('Review')
const firstReviews = await parallel([
  () => agent('Review correctness and tests. Read only.'),
  () => agent('Review requirements and interfaces. Read only.'),
  () => agent('Review regression risk. Read only.'),
])
let triage = await agent('Triage review verdicts and decide readiness.', {
  schema: {
    type: 'object',
    properties: {
      ready: { type: 'boolean' },
      blockingIssues: { type: 'array', items: { type: 'string' } },
    },
    required: ['ready', 'blockingIssues'],
  },
})
if (!triage.ready) {
  await agent('Repair only the concrete blocking issues as the mutation owner.')
  const secondReviews = await parallel([
    () => agent('Review repaired correctness and tests. Read only.'),
    () => agent('Review repaired requirements and interfaces. Read only.'),
    () => agent('Review repaired regression risk. Read only.'),
  ])
  triage = await agent('Adjudicate the second-round verdict and preserve blockers.', {
    schema: {
      type: 'object',
      properties: {
        ready: { type: 'boolean' },
        blockingIssues: { type: 'array', items: { type: 'string' } },
      },
      required: ['ready', 'blockingIssues'],
    },
  })
}
phase('Final')
const validators = await parallel([
  () => agent('Run targeted final validation. Read only.'),
  () => agent('Audit final constraints and regressions. Read only.'),
])
return agent('Make the final fail-closed adjudication.', {
  schema: { type: 'object', properties: { ready: { type: 'boolean' } }, required: ['ready'] },
})
`;
    const analysis = analyzeWorkflowSource(source, 'Requirements:\n- Do not modify protected tests.\n- Keep public interfaces stable.');
    expect(analysis.metrics).not.toBeNull();
    expect(analysis.metrics!.agentCalls).toEqual({ min: 12, max: 18 });
    expect(analysis.metrics!.conditionalRepairCalls).toBe(1);
    expect(analysis.metrics!.triageOrAdjudicationCalls).toBeGreaterThanOrEqual(2);
    expect(analysis.metrics!.unsafeParallelMutators).toBe(0);
    expect(analysis.metrics!.unboundedLoops).toBe(0);
  });

  it('handles bounded loops, literal pipelines, retries, and dynamic loops conservatively', () => {
    const bounded = analyzeWorkflowSource(`${META}
for (let round = 0; round < 2; round += 1) {
  await agent('Review one bounded round.')
  if (round > 0) break
}
await pipeline(['a', 'b', 'c'],
  () => agent('Implement one exclusively owned component.'),
  () => agent('Verify that component.'),
)
return agent('Transient transport step.', { retries: 1 })
`);
    expect(bounded.metrics!.agentCalls).toEqual({ min: 8, max: 9 });
    expect(bounded.metrics!.dispatchAttempts).toEqual({ min: 9, max: 10 });
    expect(bounded.metrics!.boundedLoops).toBe(1);
    expect(bounded.metrics!.pipelineCalls).toBe(1);
    expect(bounded.metrics!.retryDeclarations).toBe(1);

    const dynamic = analyzeWorkflowSource(`${META}
while (args.more) await agent('Find another item.')
`);
    expect(dynamic.metrics!.agentCalls.max).toBeNull();
    expect(dynamic.metrics!.unboundedLoops).toBe(1);
  });

  it('expands agent-bearing helper functions at bounded call sites', () => {
    const result = analyzeWorkflowSource(`${META}
async function reviewRound() {
  return parallel([
    () => agent('Review correctness.'),
    () => agent('Review compatibility.'),
  ])
}
for (let round = 0; round < 2; round += 1) await reviewRound()
`);
    expect(result.metrics!.agentCallSites).toBe(2);
    expect(result.metrics!.agentCalls).toEqual({ min: 4, max: 4 });

    const from = analyzeWorkflowSource(`${META}
await parallel(Array.from({ length: 3 }, () => () => agent('Inspect independently.')))
`);
    expect(from.metrics!.agentCalls).toEqual({ min: 3, max: 3 });
  });

  it('flags overlapping parallel mutators and repeated full-result serialization', () => {
    const unsafe = analyzeWorkflowSource(`${META}
const result = await agent('Inspect.', {
  schema: { type: 'object', properties: { files: { type: 'array', items: { type: 'string' } } }, required: ['files'] },
})
if (result.files.length) {
  await parallel([
    () => agent('Implement the fix.'),
    () => agent('Modify code and repair the same feature.'),
  ])
}
log(JSON.stringify(result))
log(JSON.stringify(result))
`);
    expect(unsafe.metrics!.unsafeParallelMutators).toBe(1);
    expect(unsafe.metrics!.duplicateSerializedBindings).toEqual(['result']);
    expect(unsafe.metrics!.programmaticAgentResults).toBe(1);
    expect(unsafe.metrics!.schemaCoveredProgrammaticResults).toBe(1);
    expect(unsafe.diagnostics.join('\n')).toMatch(/parallel mutation/);

    const owned = analyzeWorkflowSource(`${META}
await parallel([
  () => agent('Implement only src/a/** with exclusive ownership.'),
  () => agent('Implement only src/b/** with exclusive ownership.'),
])
`);
    expect(owned.metrics!.unsafeParallelMutators).toBe(0);
  });

  it('returns parse diagnostics instead of inventing metrics', () => {
    const result = analyzeWorkflowSource('export const meta = {');
    expect(result.metrics).toBeNull();
    expect(result.diagnostics[0]).toMatch(/^parse:/);
  });
});
