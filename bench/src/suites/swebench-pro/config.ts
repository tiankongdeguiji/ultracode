/** Strict SWE-bench Pro operator configuration and suite-cache layout. */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import type { BenchPathRoots } from '../../shared/contracts.js';
import {
  assertPrivateRuntimeFile,
  loadPrivateOperatorConfig,
  toolchainConfigSchema,
  type RuntimeBindings,
} from '../../shared/config.js';
import { publicLocatorSchema } from '../../shared/provenance.js';

const selectionSchema = z.strictObject({
  taskIds: z.array(z.string().min(1)).nullable(),
  count: z.number().int().positive(),
  seed: z.number().int().nonnegative(),
  stratifyBy: z.enum(['repo_language', 'repo']),
});

const pricingEntrySchema = z.strictObject({
  uncachedInputPerMTokens: z.number().finite().nonnegative(),
  cachedInputPerMTokens: z.number().finite().nonnegative(),
  outputPerMTokens: z.number().finite().nonnegative(),
});

export const swebenchProConfigSchema = z.strictObject({
  model: z.string().regex(/^[^\u0000-\u001f\u007f]*$/),
  requestedEffort: z.string().regex(/^[^\u0000-\u001f\u007f]*$/),
  arm: z.enum(['a', 'b', 'both']),
  selection: selectionSchema,
  auth: z.strictObject({
    mechanism: z.enum(['chatgpt', 'api-key']),
    publicIdentity: z.string().min(1).max(512),
  }),
  timeouts: z.strictObject({
    sessionMs: z.number().int().min(60_000),
    verifierMs: z.number().int().positive(),
    evaluatorWatchdogMs: z.number().int().positive(),
  }),
  concurrency: z.strictObject({
    tasks: z.number().int().positive(),
    verifier: z.number().int().positive(),
  }),
  docker: z.strictObject({
    cpus: z.number().finite().positive(),
    memoryBytes: z.number().int().positive(),
    keepImages: z.boolean(),
  }),
  evaluator: z.strictObject({
    repository: publicLocatorSchema,
    revision: z.string().regex(/^[a-f0-9]{40}$/),
    pipIndex: publicLocatorSchema,
  }),
  sanitizeGitHistory: z.literal(true),
  pricing: z.record(z.string(), pricingEntrySchema).optional(),
});

const operatorConfigSchema = z.strictObject({
  schemaVersion: z.literal(2),
  toolchain: toolchainConfigSchema,
  swebenchPro: swebenchProConfigSchema,
  sweMarathon: z.unknown().optional(),
  featureBench: z.unknown().optional(),
});

export type SwebenchProConfig = z.infer<typeof swebenchProConfigSchema>;
export type SwebenchProOperatorConfig = z.infer<typeof operatorConfigSchema>;

export const DEFAULT_SWEBENCH_PRO_CONFIG: SwebenchProConfig = {
  model: '',
  requestedEffort: '',
  arm: 'both',
  selection: { taskIds: null, count: 20, seed: 7, stratifyBy: 'repo_language' },
  auth: { mechanism: 'chatgpt', publicIdentity: 'operator-supplied-chatgpt-account' },
  timeouts: { sessionMs: 43_200_000, verifierMs: 21_600_000, evaluatorWatchdogMs: 5_400_000 },
  concurrency: { tasks: 4, verifier: 8 },
  docker: { cpus: 8, memoryBytes: 24 * 1_024 * 1_024 * 1_024, keepImages: false },
  evaluator: {
    repository: 'https://github.com/scaleapi/SWE-bench_Pro-os',
    revision: 'ca10a60a5fcae51e6948ffe1485d4153d421e6c5',
    pipIndex: 'https://pypi.org/simple',
  },
  sanitizeGitHistory: true,
};

const merge = <T>(base: T, override: Partial<T> | undefined): T => {
  if (override === undefined) return base;
  if (base === null || typeof base !== 'object' || Array.isArray(base)) return override as T;
  const output = { ...base } as Record<string, unknown>;
  for (const [key, value] of Object.entries(override as Record<string, unknown>)) {
    output[key] = merge((base as Record<string, unknown>)[key], value as never);
  }
  return output as T;
};

export function operatorConfigFile(roots: BenchPathRoots): string {
  return join(roots.benchRoot, 'bench.config.json');
}

/** Load only the strict v2 config; the unreleased legacy shape is rejected. */
export function loadSwebenchProOperatorConfig(roots: BenchPathRoots): SwebenchProOperatorConfig {
  const file = operatorConfigFile(roots);
  if (!existsSync(file)) {
    throw new Error(`private benchmark config is missing at ${file}; copy bench.example.config.json and chmod it 0600`);
  }
  return loadPrivateOperatorConfig(file, operatorConfigSchema);
}

export function resolveSwebenchProConfig(
  operator: SwebenchProOperatorConfig,
  override: Partial<SwebenchProConfig> = {},
): SwebenchProConfig {
  return swebenchProConfigSchema.parse(merge(operator.swebenchPro, override));
}

export function validateRunConfig(config: SwebenchProConfig): void {
  if (!config.model) throw new Error('SWE-bench Pro run requires an explicit model');
  if (!config.requestedEffort) throw new Error('SWE-bench Pro run requires an explicit requested effort');
  if (config.selection.taskIds !== null && config.selection.taskIds.length === 0) {
    throw new Error('SWE-bench Pro taskIds must be null or a non-empty list');
  }
}

/** Runtime credentials are supplied anew and are never serialized. */
export function loadRuntimeBindings(config: SwebenchProConfig, env = process.env): RuntimeBindings {
  const pipConfigFile = env.PIP_CONFIG_FILE === undefined
    ? undefined
    : assertPrivateRuntimeFile(env.PIP_CONFIG_FILE, 'private pip config');
  if (config.auth.mechanism === 'chatgpt') {
    const authFile = env.CODEX_AUTH_JSON_PATH;
    if (!authFile) throw new Error('chatgpt auth requires CODEX_AUTH_JSON_PATH for every run invocation');
    return {
      authFile: assertPrivateRuntimeFile(authFile, 'Codex auth file'),
      ...(pipConfigFile === undefined ? {} : { pipConfigFile }),
    };
  }
  const apiKey = env.CODEX_API_KEY;
  if (!apiKey || apiKey.includes('\0')) throw new Error('api-key auth requires CODEX_API_KEY for every run invocation');
  return { apiKey, ...(pipConfigFile === undefined ? {} : { pipConfigFile }) };
}

export const suiteCacheDir = (roots: BenchPathRoots): string => join(roots.cacheRoot, 'swebench-pro');
export const instancesFile = (roots: BenchPathRoots): string => join(suiteCacheDir(roots), 'instances-v2.json');
export const swebenchProCurrentFile = (roots: BenchPathRoots): string => join(suiteCacheDir(roots), 'current-v2.json');
export const swebenchProPreparedDir = (roots: BenchPathRoots, identity: string): string =>
  join(suiteCacheDir(roots), identity);
