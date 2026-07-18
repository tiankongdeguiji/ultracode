/**
 * Offline tests for bench/src/eval.ts prediction/sample generation: exact
 * raw-sample JSONL keys with verbatim python-literal passthrough, arm
 * prediction collection over a fabricated run layout, and the gold/null
 * prediction sets. prepareHarness/runEval (network, docker, python) are
 * exercised by the live smokes, not here.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { armDir, resultsDir } from '../../bench/src/config.js';
import {
  collectPredictions,
  generateRawSamples,
  goldPredictions,
  nullPredictions,
} from '../../bench/src/eval.js';
import type { BenchInstance } from '../../bench/src/types.js';

const tmp = mkdtempSync(join(tmpdir(), 'uc-bench-evalgen-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

// armDir anchors at bench/results; a '..'-relative runId redirects the layout
// into the tmpdir without touching the repo tree.
const runId = relative(resultsDir(), join(tmp, 'run1'));

const F2P = "['test/a.js | first case', 'test/b.js | should keep single quotes']";

function inst(id: string, over: Partial<BenchInstance> = {}): BenchInstance {
  return {
    instanceId: id,
    repo: 'acme/widgets',
    repoLanguage: 'js',
    baseCommit: 'deadbeef00',
    problemStatement: 'fix the widget',
    requirements: null,
    interface: null,
    failToPass: F2P,
    passToPass: "['test/c.js | third']",
    dockerhubTag: 'acme.widgets-x',
    beforeRepoSetCmd: 'true',
    selectedTestFilesToRun: "['test/a.js', 'test/b.js']",
    goldPatch: `gold patch for ${id}\n`,
    testPatch: 'never-prompted',
    ...over,
  };
}

function writeArmFiles(iid: string, arm: 'a' | 'b', patch: string | null, failure?: string): void {
  const dir = armDir(runId, iid, arm);
  mkdirSync(join(dir, 'out'), { recursive: true });
  if (patch !== null) writeFileSync(join(dir, 'out', 'patch.diff'), patch);
  if (failure !== undefined) {
    writeFileSync(join(dir, 'status.json'), JSON.stringify({ phase: 'patched', failure, annotations: [] }));
  }
}

describe('generateRawSamples', () => {
  it('writes JSONL with exactly the lowercase harness keys, values verbatim', () => {
    const outFile = join(tmp, 'raw_samples.jsonl');
    generateRawSamples([inst('i-one'), inst('i-two')], outFile);

    const lines = readFileSync(outFile, 'utf8').split('\n').filter((l) => l !== '');
    expect(lines).toHaveLength(2);
    const rows = lines.map((l) => JSON.parse(l) as Record<string, string>);
    for (const row of rows) {
      expect(Object.keys(row).sort()).toEqual([
        'base_commit',
        'before_repo_set_cmd',
        'fail_to_pass',
        'instance_id',
        'pass_to_pass',
        'repo',
        'selected_test_files_to_run',
      ]);
    }
    expect(rows[0]?.instance_id).toBe('i-one');
    expect(rows[1]?.instance_id).toBe('i-two');
    expect(rows[0]?.fail_to_pass).toBe(F2P);
    expect(rows[0]?.pass_to_pass).toBe("['test/c.js | third']");
    expect(rows[0]?.base_commit).toBe('deadbeef00');
    expect(rows[0]?.repo).toBe('acme/widgets');
    expect(rows[0]?.before_repo_set_cmd).toBe('true');
    expect(rows[0]?.selected_test_files_to_run).toBe("['test/a.js', 'test/b.js']");
  });
});

describe('collectPredictions', () => {
  const instances = [inst('i-good'), inst('i-empty'), inst('i-missing'), inst('i-toolarge')];

  it('keeps only non-empty patches whose status is not patch-too-large', () => {
    writeArmFiles('i-good', 'a', 'diff --git a/f.js b/f.js\n--- a/f.js\n+++ b/f.js\n');
    writeArmFiles('i-empty', 'a', '   \n\t\n');
    writeArmFiles('i-toolarge', 'a', 'diff --git a/huge b/huge\n', 'patch-too-large');

    const preds = collectPredictions(runId, 'a', instances);
    expect(preds).toEqual([
      { instance_id: 'i-good', patch: 'diff --git a/f.js b/f.js\n--- a/f.js\n+++ b/f.js\n', prefix: 'armA' },
    ]);
  });

  it('maps arm b to the armB prefix', () => {
    writeArmFiles('i-good', 'b', 'diff --git a/g.js b/g.js\n');
    const preds = collectPredictions(runId, 'b', [inst('i-good')]);
    expect(preds).toEqual([{ instance_id: 'i-good', patch: 'diff --git a/g.js b/g.js\n', prefix: 'armB' }]);
  });
});

describe('goldPredictions', () => {
  it('maps gold patches under the gold prefix', () => {
    expect(goldPredictions([inst('i-one'), inst('i-two')])).toEqual([
      { instance_id: 'i-one', patch: 'gold patch for i-one\n', prefix: 'gold' },
      { instance_id: 'i-two', patch: 'gold patch for i-two\n', prefix: 'gold' },
    ]);
  });
});

describe('nullPredictions', () => {
  it('emits a self-contained new-file diff under the nullcheck prefix', () => {
    const preds = nullPredictions([inst('i-one'), inst('i-two')]);
    expect(preds).toHaveLength(2);
    for (const p of preds) {
      expect(p.prefix).toBe('nullcheck');
      expect(p.patch.startsWith('diff --git a/ucbench-null-check.txt')).toBe(true);
      expect(p.patch).toContain('new file mode');
    }
    expect(preds[0]?.instance_id).toBe('i-one');
    expect(preds[1]?.instance_id).toBe('i-two');
  });
});
