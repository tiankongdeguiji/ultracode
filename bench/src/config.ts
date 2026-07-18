/**
 * Bench configuration and filesystem layout. Defaults live here; a gitignored
 * bench/bench.config.json overrides them (deep-merged per section), and CLI
 * flags override individual fields on top. Path helpers centralize the layout
 * contract shared by session.ts, entrypoint.sh (via bind mount), metrics.ts,
 * and eval.ts — change them only together.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Arm, BenchConfig } from './types.js';

/** bench/ directory (this file lives in bench/src/). */
export const BENCH_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export const DEFAULT_CONFIG: BenchConfig = {
  instances: { ids: null, count: 20, seed: 7, stratifyBy: 'repo_language' },
  model: '',
  effort: '',
  auth: { mode: 'chatgpt' },
  arms: 'both',
  timeouts: { sessionSecs: 43_200, evalWatchdogSecs: 5_400 },
  parallel: { instances: 4, evalWorkers: 8 },
  docker: { cpus: 8, memoryGb: 24, keepImages: false },
  toolchain: { nodeVersion: '22.14.0', nodeDist: 'npmmirror', codexBin: 'auto' },
  harness: {
    repo: 'https://github.com/scaleapi/SWE-bench_Pro-os',
    pin: 'ca10a60a5fcae51e6948ffe1485d4153d421e6c5',
  },
  pipIndex: 'https://mirrors.aliyun.com/pypi/simple',
  sanitizeGitHistory: true,
};

/** Deep-merge one level of sections; arrays and scalars replace wholesale. */
function mergeSection<T>(base: T, over: Partial<T> | undefined): T {
  if (over === undefined) return base;
  if (base === null || typeof base !== 'object' || Array.isArray(base)) return over as T;
  const out = { ...base } as Record<string, unknown>;
  for (const [k, v] of Object.entries(over as Record<string, unknown>)) {
    out[k] = mergeSection((base as Record<string, unknown>)[k], v as undefined);
  }
  return out as T;
}

/** Load defaults <- bench.config.json <- overrides (typically CLI flags). */
export function loadConfig(overrides?: Partial<BenchConfig>): BenchConfig {
  const file = join(BENCH_ROOT, 'bench.config.json');
  let fromFile: Partial<BenchConfig> = {};
  if (existsSync(file)) {
    fromFile = JSON.parse(readFileSync(file, 'utf8')) as Partial<BenchConfig>;
  }
  return mergeSection(mergeSection(DEFAULT_CONFIG, fromFile), overrides);
}

/** Throws with an actionable message when a config cannot drive `run`. */
export function validateForRun(cfg: BenchConfig): void {
  if (!cfg.model) {
    throw new Error('config.model is required for `run` (pin it via --model or bench.config.json; there is no default)');
  }
  if (!cfg.effort) {
    throw new Error('config.effort is required for `run` (pin it explicitly; an empty value silently uses the model default)');
  }
  if (cfg.instances.ids !== null && cfg.instances.ids.length === 0) {
    throw new Error('config.instances.ids is an empty list — provide ids or set it to null for sampling');
  }
  if (cfg.timeouts.sessionSecs < 60) throw new Error('timeouts.sessionSecs must be >= 60');
  if (cfg.parallel.instances < 1) throw new Error('parallel.instances must be >= 1');
}

/* ---------------------------------------------------------------- layout -- */

export const cacheDir = (): string => join(BENCH_ROOT, '.cache');
export const instancesFile = (): string => join(cacheDir(), 'instances.json');
export const toolchainDir = (): string => join(cacheDir(), 'toolchain');
export const harnessDir = (): string => join(cacheDir(), 'harness');
export const venvDir = (): string => join(cacheDir(), 'venv');
export const downloadsDir = (): string => join(cacheDir(), 'downloads');
export const resultsDir = (): string => join(BENCH_ROOT, 'results');

export const runDir = (runId: string): string => join(resultsDir(), runId);
export const runManifestFile = (runId: string): string => join(runDir(runId), 'run.json');
/** Bind-mounted at /bench inside the session container. */
export const armDir = (runId: string, iid: string, arm: Arm): string =>
  join(runDir(runId), 'instances', iid, arm);
export const evalDir = (runId: string): string => join(runDir(runId), 'eval');

/** Overlay image name for one instance (tags are lowercase alnum/dash/underscore). */
export function overlayImageName(instanceId: string): string {
  const slug = instanceId.toLowerCase().replace(/[^a-z0-9_.-]+/g, '-').slice(0, 100);
  return `ucbench:${slug}`;
}

export const BASE_IMAGE_REPO = 'jefzda/sweap-images';
/** In-container mount point of the arm dir; entrypoint.sh hardcodes the same. */
export const CONTAINER_BENCH_DIR = '/bench';
/** In-container repo checkout used by the sweap images. */
export const CONTAINER_REPO_DIR = '/app';
