import { describe, it, expect } from 'vitest';
import { selectInstances } from '../../bench/src/instances.js';
import type { BenchInstance } from '../../bench/src/types.js';

function inst(id: string, lang: string): BenchInstance {
  return {
    instanceId: id,
    repo: `org/${lang}-repo`,
    repoLanguage: lang,
    baseCommit: 'deadbeef',
    problemStatement: 'fix the thing',
    requirements: null,
    interface: null,
    failToPass: "['t1']",
    passToPass: "['t2']",
    dockerhubTag: `tag-${id}`,
    beforeRepoSetCmd: ':',
    selectedTestFilesToRun: 't1.py',
    goldPatch: 'diff --git a b',
    testPatch: 'diff --git a b',
  };
}

// 12 instances: py 5, js 4, go 3 — count=6 exercises floors (py 2.5, js 2.0,
// go 1.5) plus a largest-remainder tie (py vs go) broken by key order.
function fixtures(): BenchInstance[] {
  return [
    ...['py-1', 'py-2', 'py-3', 'py-4', 'py-5'].map((id) => inst(id, 'python')),
    ...['js-1', 'js-2', 'js-3', 'js-4'].map((id) => inst(id, 'js')),
    ...['go-1', 'go-2', 'go-3'].map((id) => inst(id, 'go')),
  ];
}

const sample = (count: number, seed: number) =>
  selectInstances(fixtures(), { ids: null, count, seed, stratifyBy: 'repo_language' });

const ids = (list: BenchInstance[]) => list.map((i) => i.instanceId);

describe('selectInstances', () => {
  it('is deterministic: same seed and count give an identical id list', () => {
    expect(ids(sample(6, 7))).toEqual(ids(sample(6, 7)));
    expect(ids(sample(6, 7))).toEqual(ids(sample(6, 7)));
  });

  it('a different seed changes the selection', () => {
    expect(ids(sample(6, 7))).not.toEqual(ids(sample(6, 8)));
  });

  it('allocates per stratum by largest-remainder proportion', () => {
    const counts: Record<string, number> = {};
    for (const i of sample(6, 7)) counts[i.repoLanguage] = (counts[i.repoLanguage] ?? 0) + 1;
    // exact quotas 2.5/2.0/1.5; the leftover seat goes to go (tie with python,
    // key order wins) -> go 2, js 2, python 2
    expect(counts).toEqual({ go: 2, js: 2, python: 2 });
  });

  it('ids mode preserves the given order and rejects unknown ids', () => {
    const all = fixtures();
    const picked = selectInstances(all, { ids: ['py-3', 'go-1', 'js-2'], count: 0, seed: 0, stratifyBy: 'repo_language' });
    expect(ids(picked)).toEqual(['py-3', 'go-1', 'js-2']);
    expect(() =>
      selectInstances(all, { ids: ['py-3', 'nope-1'], count: 0, seed: 0, stratifyBy: 'repo_language' }),
    ).toThrow(/nope-1/);
  });

  it('count >= all.length returns every instance, sorted by instanceId', () => {
    const picked = sample(50, 3);
    expect(ids(picked)).toEqual(ids(fixtures()).sort());
    expect(picked).toHaveLength(12);
  });
});
