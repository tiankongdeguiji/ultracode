/** Strict SWE-Marathon operator configuration, inventory, and cache layout. */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import type { BenchPathRoots } from '../../shared/contracts.js';
import { loadPrivateOperatorConfig, toolchainConfigSchema } from '../../shared/config.js';

export const SWE_MARATHON_REPOSITORY = 'https://github.com/abundant-ai/swe-marathon.git';
export const SWE_MARATHON_SOURCE_REVISION = '6d6855af390226f6eca607d63818fe076e57ea8c';
export const SWE_MARATHON_PYTHON_VERSION = '3.13.5';
export const SWE_MARATHON_HARBOR_VERSION = '0.17.1';
export const SWE_MARATHON_DATASET = 'abundant-ai/swe-marathon/tasks';
export const SWE_MARATHON_SPLIT = 'official-verifier-non-cua';

/** Tasks whose source experiment did not produce an authoritative CUA result. */
export const EXCLUDED_CUA_TASKS = [
  'excel-clone',
  'mastodon-clone',
  's3-clone',
  'slack-clone',
] as const;

/** Post-hoc stress cohort; it is never presented as a representative sample. */
export const CONTEXT_PRESSURE_STRESS_TASKS = [
  'find-network-alignments',
  'kubernetes-rust-rewrite',
  'nextjs-vite-rewrite',
  'rust-java-lsp',
] as const;

export const SWE_MARATHON_TASKS = [
  'biofabric-rust-rewrite',
  'embedding-eval',
  'excel-clone',
  'find-network-alignments',
  'jax-pytorch-rewrite',
  'kubernetes-rust-rewrite',
  'mastodon-clone',
  'nextjs-vite-rewrite',
  'parameter-golf',
  'post-train-ifeval-gpu',
  'ruby-rust-port',
  'rust-c-compiler',
  'rust-java-lsp',
  's3-clone',
  'slack-clone',
  'stripe-clone',
  'trimul-cuda',
  'vliw-kernel-optimization',
  'wasm-simd',
  'zstd-decoder',
] as const;

const TASK_SET = new Set<string>(SWE_MARATHON_TASKS);
const EXCLUDED_SET = new Set<string>(EXCLUDED_CUA_TASKS);

const pricingEntrySchema = z.strictObject({
  uncachedInputPerMTokens: z.number().finite().nonnegative(),
  cachedInputPerMTokens: z.number().finite().nonnegative(),
  outputPerMTokens: z.number().finite().nonnegative(),
});

export const sweMarathonConfigSchema = z.strictObject({
  model: z.string().regex(/^[^\u0000-\u001f\u007f]*$/),
  requestedEffort: z.string().regex(/^[^\u0000-\u001f\u007f]*$/),
  arm: z.enum(['a', 'b']),
  taskIds: z.array(z.string().min(1)),
  auth: z.strictObject({
    mechanism: z.enum(['chatgpt', 'api-key']),
    publicIdentity: z.string().min(1).max(512),
  }),
  workflowWaitMs: z.number().int().positive(),
  timeouts: z.strictObject({
    taskMs: z.number().int().min(60_000),
    verifierMs: z.number().int().positive(),
  }),
  pricing: z.record(z.string(), pricingEntrySchema).optional(),
});

const operatorConfigSchema = z.strictObject({
  schemaVersion: z.literal(2),
  toolchain: toolchainConfigSchema,
  swebenchPro: z.unknown().optional(),
  sweMarathon: sweMarathonConfigSchema,
  featureBench: z.unknown().optional(),
});

export type SweMarathonConfig = z.infer<typeof sweMarathonConfigSchema>;
export type SweMarathonOperatorConfig = z.infer<typeof operatorConfigSchema>;

export const DEFAULT_SWE_MARATHON_CONFIG: SweMarathonConfig = {
  model: '',
  requestedEffort: '',
  arm: 'a',
  taskIds: [],
  auth: { mechanism: 'chatgpt', publicIdentity: 'operator-supplied-chatgpt-account' },
  workflowWaitMs: 3_300_000,
  timeouts: { taskMs: 43_200_000, verifierMs: 21_600_000 },
};

export function validateMarathonTaskId(taskId: string): string {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(taskId)) {
    throw new Error(`unsafe SWE-Marathon task id '${taskId}'`);
  }
  if (!TASK_SET.has(taskId)) {
    throw new Error(`unknown SWE-Marathon task '${taskId}' at pin ${SWE_MARATHON_SOURCE_REVISION}`);
  }
  if (EXCLUDED_SET.has(taskId)) {
    throw new Error(`SWE-Marathon task '${taskId}' has no authoritative CUA verifier result`);
  }
  return taskId;
}

export function validateSweMarathonConfig(config: SweMarathonConfig): void {
  if (!config.model) throw new Error('SWE-Marathon run requires an explicit model');
  if (!config.requestedEffort) throw new Error('SWE-Marathon run requires an explicit requested effort');
  if (config.taskIds.length === 0) throw new Error('SWE-Marathon run requires at least one --task-id');
  if (new Set(config.taskIds).size !== config.taskIds.length) throw new Error('SWE-Marathon task ids must be unique');
  config.taskIds.forEach(validateMarathonTaskId);
}

function merge<T>(base: T, override: Partial<T> | undefined): T {
  if (override === undefined) return base;
  if (base === null || typeof base !== 'object' || Array.isArray(base)) return override as T;
  const output = { ...base } as Record<string, unknown>;
  for (const [key, value] of Object.entries(override as Record<string, unknown>)) {
    output[key] = merge((base as Record<string, unknown>)[key], value as never);
  }
  return output as T;
}

export function marathonOperatorConfigFile(roots: BenchPathRoots): string {
  return join(roots.benchRoot, 'bench.config.json');
}

export function loadSweMarathonOperatorConfig(roots: BenchPathRoots): SweMarathonOperatorConfig {
  const file = marathonOperatorConfigFile(roots);
  if (!existsSync(file)) {
    throw new Error(`private benchmark config is missing at ${file}; copy bench.example.config.json and chmod it 0600`);
  }
  return loadPrivateOperatorConfig(file, operatorConfigSchema);
}

export function resolveSweMarathonConfig(
  operator: SweMarathonOperatorConfig,
  override: Partial<SweMarathonConfig> = {},
): SweMarathonConfig {
  return sweMarathonConfigSchema.parse(merge(operator.sweMarathon, override));
}

export const marathonCacheRoot = (roots: BenchPathRoots): string => join(roots.cacheRoot, 'swe-marathon');
export const marathonCurrentFile = (roots: BenchPathRoots): string => join(marathonCacheRoot(roots), 'current.json');
export const marathonPreparedDir = (roots: BenchPathRoots, identity: string): string =>
  join(marathonCacheRoot(roots), identity);
