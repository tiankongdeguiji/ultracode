/** Fetch, validate, freeze, and deterministically sample complete Pro rows. */
import { existsSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { z } from 'zod';
import type { BenchPathRoots } from '../../shared/contracts.js';
import {
  ensureRealDirectoryWithin,
  isPortableComponent,
  readRegularFileWithinRoot,
  validateTaskId,
  writePrivateJsonAtomic,
} from '../../shared/paths.js';
import { instancesFile, suiteCacheDir, type SwebenchProConfig } from './config.js';
import type { SwebenchProDatasetSnapshot, SwebenchProInstance } from './types.js';

export const SWE_BENCH_PRO_DATASET = 'ScaleAI/SWE-bench_Pro';
export const SWE_BENCH_PRO_SPLIT = 'test';
const DATASET_SOURCE = 'https://datasets-server.huggingface.co/rows';
const PAGE_LENGTH = 100;
const RETRY_DELAYS_MS = [1_000, 4_000, 16_000];

const snapshotSchema = z.strictObject({
  schemaVersion: z.literal(2),
  kind: z.literal('ultracode-swebench-pro-dataset-snapshot'),
  identity: z.literal(SWE_BENCH_PRO_DATASET),
  split: z.literal(SWE_BENCH_PRO_SPLIT),
  source: z.literal(DATASET_SOURCE),
  rows: z.array(z.record(z.string(), z.unknown())).min(1),
});

interface HfRowsPage {
  rows: { row: Record<string, unknown> }[];
  num_rows_total: number;
}

function required(row: Record<string, unknown>, key: string, id: string): string {
  const value = row[key];
  if (typeof value !== 'string') throw new Error(`dataset row ${id}: '${key}' must be a string`);
  return value;
}

/** Normalize execution fields while retaining the complete exact source row. */
export function instanceFromRow(row: Record<string, unknown>): SwebenchProInstance {
  const instanceId = required(row, 'instance_id', '<unknown>');
  validateTaskId(instanceId);
  if (!isPortableComponent(instanceId) || instanceId.includes('..')) {
    throw new Error(`dataset row ${instanceId}: instance_id is unsafe for the pinned native evaluator`);
  }
  const optional = (key: string): string | null => {
    const value = row[key];
    if (value === null || value === undefined) return null;
    if (typeof value !== 'string') throw new Error(`dataset row ${instanceId}: '${key}' must be a string or null`);
    return value;
  };
  const baseCommit = required(row, 'base_commit', instanceId);
  const dockerhubTag = required(row, 'dockerhub_tag', instanceId);
  if (!/^[a-f0-9]{40}$/.test(baseCommit)) throw new Error(`dataset row ${instanceId}: invalid base_commit`);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(dockerhubTag)) {
    throw new Error(`dataset row ${instanceId}: invalid dockerhub_tag`);
  }
  return {
    row: structuredClone(row),
    instanceId,
    repo: required(row, 'repo', instanceId),
    repoLanguage: required(row, 'repo_language', instanceId),
    baseCommit,
    problemStatement: required(row, 'problem_statement', instanceId),
    requirements: optional('requirements'),
    interface: optional('interface'),
    failToPass: required(row, 'fail_to_pass', instanceId),
    passToPass: required(row, 'pass_to_pass', instanceId),
    dockerhubTag,
    beforeRepoSetCmd: required(row, 'before_repo_set_cmd', instanceId),
    selectedTestFilesToRun: required(row, 'selected_test_files_to_run', instanceId),
    goldPatch: required(row, 'patch', instanceId),
    testPatch: required(row, 'test_patch', instanceId),
  };
}

async function fetchPage(offset: number): Promise<HfRowsPage> {
  const query = new URLSearchParams({
    dataset: SWE_BENCH_PRO_DATASET,
    config: 'default',
    split: SWE_BENCH_PRO_SPLIT,
    offset: String(offset),
    length: String(PAGE_LENGTH),
  });
  let lastError: unknown;
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt += 1) {
    if (attempt > 0) await sleep(RETRY_DELAYS_MS[attempt - 1]!);
    try {
      const response = await fetch(`${DATASET_SOURCE}?${query.toString()}`);
      if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);
      const page = await response.json() as HfRowsPage;
      if (!Array.isArray(page.rows) || !Number.isSafeInteger(page.num_rows_total)) {
        throw new Error('unexpected datasets-server response');
      }
      return page;
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(`failed to fetch SWE-bench Pro rows at offset ${offset}: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
}

export async function fetchInstances(roots: BenchPathRoots): Promise<number> {
  const rows: Record<string, unknown>[] = [];
  let total: number | null = null;
  while (total === null || rows.length < total) {
    const page = await fetchPage(rows.length);
    if (total !== null && page.num_rows_total !== total) throw new Error('datasets-server total changed during snapshot fetch');
    total = page.num_rows_total;
    if (page.rows.length === 0 && rows.length < total) throw new Error('datasets-server returned an incomplete snapshot');
    if (rows.length + page.rows.length > total) throw new Error('datasets-server returned more rows than its declared total');
    for (const entry of page.rows) {
      instanceFromRow(entry.row);
      rows.push(entry.row);
    }
  }
  if (rows.length !== total) throw new Error('datasets-server snapshot row count is incomplete');
  const taskIds = rows.map((row) => instanceFromRow(row).instanceId);
  if (new Set(taskIds).size !== taskIds.length) throw new Error('datasets-server snapshot contains duplicate task IDs');
  const directory = ensureRealDirectoryWithin(roots.cacheRoot, suiteCacheDir(roots));
  const snapshot: SwebenchProDatasetSnapshot = {
    schemaVersion: 2,
    kind: 'ultracode-swebench-pro-dataset-snapshot',
    identity: SWE_BENCH_PRO_DATASET,
    split: SWE_BENCH_PRO_SPLIT,
    source: DATASET_SOURCE,
    rows,
  };
  writePrivateJsonAtomic(directory, instancesFile(roots), snapshotSchema.parse(snapshot));
  return rows.length;
}

export function loadDatasetSnapshot(roots: BenchPathRoots): SwebenchProDatasetSnapshot {
  const file = instancesFile(roots);
  if (!existsSync(file)) {
    throw new Error(`SWE-bench Pro v2 dataset snapshot is missing; run npm run bench -- --suite swebench-pro fetch`);
  }
  return snapshotSchema.parse(JSON.parse(readRegularFileWithinRoot(
    suiteCacheDir(roots),
    file.slice(suiteCacheDir(roots).length + 1),
  ).toString('utf8'))) as SwebenchProDatasetSnapshot;
}

function mulberry32(seed: number): () => number {
  let value = seed >>> 0;
  return () => {
    value = (value + 0x6d_2b_79_f5) >>> 0;
    let mixed = value;
    mixed = Math.imul(mixed ^ mixed >>> 15, mixed | 1);
    mixed ^= mixed + Math.imul(mixed ^ mixed >>> 7, mixed | 61);
    return ((mixed ^ mixed >>> 14) >>> 0) / 4_294_967_296;
  };
}

function shuffle<T>(values: T[], random: () => number): void {
  for (let index = values.length - 1; index > 0; index -= 1) {
    const selected = Math.floor(random() * (index + 1));
    [values[index], values[selected]] = [values[selected]!, values[index]!];
  }
}

function allocations(sizes: number[], count: number): number[] {
  const total = sizes.reduce((sum, size) => sum + size, 0);
  const output = sizes.map((size) => Math.floor(count * size / total));
  let remaining = count - output.reduce((sum, size) => sum + size, 0);
  const order = sizes.map((size, index) => ({ index, remainder: count * size / total - output[index]! }))
    .sort((left, right) => right.remainder - left.remainder || left.index - right.index);
  for (const entry of order) {
    if (remaining === 0) break;
    output[entry.index] = output[entry.index]! + 1;
    remaining -= 1;
  }
  return output;
}

export function selectInstances(
  snapshot: SwebenchProDatasetSnapshot,
  selection: SwebenchProConfig['selection'],
): SwebenchProInstance[] {
  const all = snapshot.rows.map(instanceFromRow);
  if (selection.taskIds !== null) {
    const byId = new Map(all.map((instance) => [instance.instanceId, instance]));
    const unknown = selection.taskIds.filter((taskId) => !byId.has(taskId));
    if (unknown.length > 0) throw new Error(`unknown SWE-bench Pro task IDs: ${unknown.join(', ')}`);
    if (new Set(selection.taskIds).size !== selection.taskIds.length) throw new Error('duplicate SWE-bench Pro task IDs');
    return selection.taskIds.map((taskId) => byId.get(taskId)!);
  }
  const count = Math.min(selection.count, all.length);
  const strata = new Map<string, SwebenchProInstance[]>();
  for (const instance of all) {
    const key = selection.stratifyBy === 'repo' ? instance.repo : instance.repoLanguage;
    strata.set(key, [...(strata.get(key) ?? []), instance]);
  }
  const keys = [...strata.keys()].sort();
  const quota = allocations(keys.map((key) => strata.get(key)!.length), count);
  const random = mulberry32(selection.seed);
  const selected: SwebenchProInstance[] = [];
  keys.forEach((key, index) => {
    const values = [...strata.get(key)!].sort((left, right) => left.instanceId.localeCompare(right.instanceId));
    shuffle(values, random);
    selected.push(...values.slice(0, quota[index]!));
  });
  return selected.sort((left, right) => left.instanceId.localeCompare(right.instanceId));
}
