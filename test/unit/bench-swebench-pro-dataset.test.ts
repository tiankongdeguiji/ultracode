/** Offline tests for the audited canonical SWE-bench Pro dataset descriptor. */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createBenchPathRoots } from '../../bench/src/shared/paths.js';
import { sha256CanonicalJson } from '../../bench/src/shared/provenance.js';
import {
  canonicalDatasetDescriptor,
  datasetDescriptorSha256,
  fetchInstances,
  loadDatasetPin,
  loadDatasetSnapshot,
} from '../../bench/src/suites/swebench-pro/instances.js';

const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function row(id: string): Record<string, unknown> {
  return {
    instance_id: id,
    repo: 'owner/repo',
    repo_language: 'ts',
    base_commit: 'a'.repeat(40),
    problem_statement: `problem ${id}`,
    requirements: null,
    interface: null,
    fail_to_pass: '[]',
    pass_to_pass: '[]',
    dockerhub_tag: 'owner.repo-task',
    before_repo_set_cmd: '',
    selected_test_files_to_run: '',
    patch: 'gold',
    test_patch: '',
    retained_future_field: { id },
  };
}

function fixture(rows: readonly Record<string, unknown>[]) {
  const root = mkdtempSync(join(tmpdir(), 'uc-pro-dataset-'));
  temporaryRoots.push(root);
  const roots = createBenchPathRoots(root);
  const descriptor = canonicalDatasetDescriptor(rows);
  mkdirSync(join(root, 'suites/swebench-pro'), { recursive: true });
  mkdirSync(join(root, '.cache/swebench-pro'), { recursive: true, mode: 0o700 });
  writeFileSync(join(root, 'suites/swebench-pro/dataset-pin.json'), `${JSON.stringify({
    schemaVersion: 1,
    kind: 'ultracode-swebench-pro-dataset-pin',
    dataset: 'ScaleAI/SWE-bench_Pro',
    config: 'default',
    split: 'test',
    rowCount: descriptor.rows.length,
    descriptorSha256: sha256CanonicalJson(descriptor),
  }, null, 2)}\n`);
  return { roots, descriptor };
}

describe('SWE-bench Pro dataset provenance', () => {
  it('commits the reviewed 731-row descriptor digest', () => {
    const pin = loadDatasetPin(createBenchPathRoots(join(process.cwd(), 'bench')));
    expect(pin).toMatchObject({
      schemaVersion: 1,
      dataset: 'ScaleAI/SWE-bench_Pro',
      config: 'default',
      split: 'test',
      rowCount: 731,
      descriptorSha256: '067bd23ae664ba2113b70d24803e04bb95242ff7c15a7c92642c482544fce0d2',
    });
  });

  it('sorts complete rows by codepoint identity and persists only a verified descriptor', async () => {
    const rows = [row('task-b'), row('task-a')];
    const { roots, descriptor } = fixture(rows);
    const calls: number[] = [];
    await expect(fetchInstances(roots, async (offset) => {
      calls.push(offset);
      return { rows: rows.map((entry) => ({ row: entry })), num_rows_total: rows.length };
    })).resolves.toBe(2);
    expect(calls).toEqual([0]);
    const loaded = loadDatasetSnapshot(roots);
    expect(loaded).toEqual(descriptor);
    expect(loaded.rows.map((entry) => entry.instance_id)).toEqual(['task-a', 'task-b']);
    expect(loaded.rows[0]?.retained_future_field).toEqual({ id: 'task-a' });
    expect(datasetDescriptorSha256(roots, loaded)).toBe(sha256CanonicalJson(descriptor));
  });

  it('preserves existing cache bytes when fetched rows miss the audited digest', async () => {
    const { roots } = fixture([row('task-a')]);
    const cache = join(roots.cacheRoot, 'swebench-pro/instances-v2.json');
    const original = Buffer.from('existing-cache-bytes\n');
    writeFileSync(cache, original, { mode: 0o600 });
    await expect(fetchInstances(roots, async () => ({
      rows: [{ row: row('task-b') }],
      num_rows_total: 1,
    }))).rejects.toThrow(/does not match the audited pin/);
    expect(readFileSync(cache)).toEqual(original);
  });

  it('rejects an inflated declared total on the first page without fetching further', async () => {
    const { roots } = fixture([row('task-a')]);
    const calls: number[] = [];
    await expect(fetchInstances(roots, async (offset) => {
      calls.push(offset);
      return { rows: [{ row: row('task-a') }], num_rows_total: 1_000_000_000 };
    })).rejects.toThrow(/row count does not match the audited pin/);
    expect(calls).toEqual([0]);
  });

  it('re-verifies the canonical digest on every cache load', () => {
    const { roots, descriptor } = fixture([row('task-a')]);
    const cache = join(roots.cacheRoot, 'swebench-pro/instances-v2.json');
    writeFileSync(cache, `${JSON.stringify({
      ...descriptor,
      rows: [row('task-b')],
    }, null, 2)}\n`, { mode: 0o600 });
    expect(() => loadDatasetSnapshot(roots)).toThrow(/does not match the audited pin/);
  });
});
