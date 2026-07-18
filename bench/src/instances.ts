/**
 * SWE-bench Pro instance acquisition and selection. `fetchInstances` pages the
 * HuggingFace datasets-server REST API and caches the whole test split (731
 * rows expected) as camelCased BenchInstance records in instancesFile();
 * `loadInstances` reads that cache back; `selectInstances` resolves a
 * BenchConfig.instances block into the concrete instance list — explicit ids
 * in the given order, or a seeded stratified sample that is fully
 * deterministic (own PRNG, codepoint sorts) so a run manifest can be
 * reproduced from config alone.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { cacheDir, instancesFile } from './config.js';
import type { BenchConfig, BenchInstance } from './types.js';

const HF_ROWS_URL =
  'https://datasets-server.huggingface.co/rows?dataset=ScaleAI%2FSWE-bench_Pro&config=default&split=test';
const PAGE_LENGTH = 100;
const RETRY_DELAYS_MS = [1_000, 4_000, 16_000];

interface HfRowsPage {
  rows: { row: Record<string, unknown> }[];
  num_rows_total: number;
}

/** Map one raw dataset row to BenchInstance; throws on missing/mistyped fields. */
function toInstance(row: Record<string, unknown>): BenchInstance {
  const id = typeof row.instance_id === 'string' ? row.instance_id : '<no instance_id>';
  const req = (key: string): string => {
    const v = row[key];
    if (typeof v !== 'string') {
      throw new Error(`dataset row ${id}: required field "${key}" is missing or not a string`);
    }
    return v;
  };
  const opt = (key: string): string | null => {
    const v = row[key];
    if (v === null || v === undefined) return null;
    if (typeof v !== 'string') throw new Error(`dataset row ${id}: field "${key}" is not a string`);
    return v;
  };
  return {
    instanceId: req('instance_id'),
    repo: req('repo'),
    repoLanguage: req('repo_language'),
    baseCommit: req('base_commit'),
    problemStatement: req('problem_statement'),
    requirements: opt('requirements'),
    interface: opt('interface'),
    failToPass: req('fail_to_pass'),
    passToPass: req('pass_to_pass'),
    dockerhubTag: req('dockerhub_tag'),
    beforeRepoSetCmd: req('before_repo_set_cmd'),
    selectedTestFilesToRun: req('selected_test_files_to_run'),
    goldPatch: req('patch'),
    testPatch: req('test_patch'),
  };
}

async function fetchPage(offset: number): Promise<HfRowsPage> {
  const url = `${HF_ROWS_URL}&offset=${offset}&length=${PAGE_LENGTH}`;
  let lastErr: unknown;
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    if (attempt > 0) await sleep(RETRY_DELAYS_MS[attempt - 1]!);
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
      const page = (await res.json()) as HfRowsPage;
      if (!Array.isArray(page.rows) || typeof page.num_rows_total !== 'number') {
        throw new Error('unexpected response shape (no rows/num_rows_total)');
      }
      return page;
    } catch (err) {
      lastErr = err;
    }
  }
  throw new Error(
    `failed to fetch dataset rows at offset ${offset} after ${RETRY_DELAYS_MS.length + 1} attempts: ` +
      `${lastErr instanceof Error ? lastErr.message : String(lastErr)}`,
  );
}

/** Download the full split into instancesFile() (pretty JSON array); returns the row count. */
export async function fetchInstances(): Promise<number> {
  const instances: BenchInstance[] = [];
  let total = Number.POSITIVE_INFINITY;
  while (instances.length < total) {
    const page = await fetchPage(instances.length);
    total = page.num_rows_total;
    if (page.rows.length === 0 && instances.length < total) {
      throw new Error(
        `datasets-server returned an empty page at offset ${instances.length} (${instances.length}/${total} rows collected)`,
      );
    }
    for (const { row } of page.rows) instances.push(toInstance(row));
  }
  mkdirSync(cacheDir(), { recursive: true });
  writeFileSync(instancesFile(), JSON.stringify(instances, null, 2) + '\n');
  return instances.length;
}

/** Read the cached dataset; actionable error when `fetch` has not been run yet. */
export function loadInstances(): BenchInstance[] {
  const file = instancesFile();
  if (!existsSync(file)) {
    throw new Error(`instance cache not found at ${file} — run \`npm run bench -- fetch\` first`);
  }
  return JSON.parse(readFileSync(file, 'utf8')) as BenchInstance[];
}

/** Deterministic 32-bit PRNG (mulberry32); Math.random would break reproducibility. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d_2b_79_f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function shuffle<T>(arr: T[], rand: () => number): void {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    const tmp = arr[i]!;
    arr[i] = arr[j]!;
    arr[j] = tmp;
  }
}

/** Codepoint compare — localeCompare is environment-dependent and would break determinism. */
function byIdAsc(a: BenchInstance, b: BenchInstance): number {
  return a.instanceId < b.instanceId ? -1 : a.instanceId > b.instanceId ? 1 : 0;
}

/**
 * Proportional allocation with largest-remainder rounding; sums exactly to `n`
 * (requires n <= sum(sizes)). Ties broken by index so key-sorted callers stay stable.
 */
function largestRemainder(sizes: number[], n: number): number[] {
  const total = sizes.reduce((s, x) => s + x, 0);
  if (total === 0) return sizes.map(() => 0);
  const out = sizes.map((size) => Math.floor((n * size) / total));
  let left = n - out.reduce((s, x) => s + x, 0);
  const order = sizes
    .map((size, i) => ({ i, rem: (n * size) / total - out[i]! }))
    .sort((a, b) => b.rem - a.rem || a.i - b.i);
  for (const { i } of order) {
    if (left === 0) break;
    out[i] = out[i]! + 1;
    left--;
  }
  return out;
}

/**
 * Resolve the config's instance block against the full dataset: explicit ids
 * in the ids' order (throws listing unknown ids), else a seeded stratified
 * sample of min(count, all) instances, returned sorted by instanceId.
 */
export function selectInstances(all: BenchInstance[], sel: BenchConfig['instances']): BenchInstance[] {
  if (sel.ids !== null) {
    const byId = new Map(all.map((inst) => [inst.instanceId, inst]));
    const unknown = sel.ids.filter((id) => !byId.has(id));
    if (unknown.length > 0) {
      throw new Error(`unknown instance ids (not in the fetched dataset): ${unknown.join(', ')}`);
    }
    return sel.ids.map((id) => byId.get(id)!);
  }

  const n = Math.min(sel.count, all.length);
  const strata = new Map<string, BenchInstance[]>();
  for (const inst of all) {
    const key = sel.stratifyBy === 'repo' ? inst.repo : inst.repoLanguage;
    const bucket = strata.get(key);
    if (bucket) bucket.push(inst);
    else strata.set(key, [inst]);
  }
  const keys = [...strata.keys()].sort();
  const alloc = largestRemainder(keys.map((k) => strata.get(k)!.length), n);
  const rand = mulberry32(sel.seed);
  const picked: BenchInstance[] = [];
  keys.forEach((key, i) => {
    const members = [...strata.get(key)!].sort(byIdAsc);
    shuffle(members, rand);
    picked.push(...members.slice(0, alloc[i]!));
  });
  return picked.sort(byIdAsc);
}
