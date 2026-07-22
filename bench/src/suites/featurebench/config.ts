/** Strict FeatureBench pins, operator configuration, and runtime-only bindings. */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import type { BenchPathRoots } from '../../shared/contracts.js';
import { loadPrivateOperatorConfig, toolchainConfigSchema } from '../../shared/config.js';
import { validateFeatureBenchTaskId, validatePortableComponent } from '../../shared/paths.js';
import { sha256CanonicalJson } from '../../shared/provenance.js';

export const FEATUREBENCH_REPOSITORY = 'https://github.com/LiberCoders/FeatureBench.git';
export const FEATUREBENCH_SOURCE_REVISION = '445dcbaec0b2e136061b0acb54e753c0a9f1888e';
export const FEATUREBENCH_DATASET = 'LiberCoders/FeatureBench';
export const FEATUREBENCH_DATASET_REVISION = 'e99d6efdfe511ea832c1b5735c536129561ec96a';
export const FEATUREBENCH_SPLIT = 'fast';
export const FEATUREBENCH_PYTHON_VERSION = '3.13.5';

export const FEATUREBENCH_NETWORK_POLICY = Object.freeze({
  schemaVersion: 2,
  dockerNetwork: 'internal',
  policyLabel: 'openai-via-credential-broker',
  preexistingEndpoints: 1,
  brokerLabel: 'ultracode.credential-broker=true',
  transport: 'https',
});

export const FEATUREBENCH_NETWORK_POLICY_SHA256 = sha256CanonicalJson(FEATUREBENCH_NETWORK_POLICY);

const pricingEntrySchema = z.strictObject({
  uncachedInputPerMTokens: z.number().finite().nonnegative(),
  cachedInputPerMTokens: z.number().finite().nonnegative(),
  outputPerMTokens: z.number().finite().nonnegative(),
});

export const featureBenchConfigSchema = z.strictObject({
  model: z.string().min(1).max(256).regex(/^[^\u0000-\u001f\u007f]+$/),
  requestedEffort: z.string().min(1).max(64).regex(/^[a-z][a-z0-9_-]*$/i),
  arm: z.enum(['a', 'b']),
  taskIds: z.array(z.string().min(1)),
  broker: z.strictObject({
    publicIdentity: z.string().min(1).max(512),
    publicVersion: z.string().min(1).max(256),
  }),
  concurrency: z.strictObject({
    inference: z.number().int().positive(),
    evaluation: z.number().int().positive(),
  }),
  timeouts: z.strictObject({
    inferenceMs: z.number().int().min(60_000),
    evaluationMs: z.number().int().min(60_000),
  }),
  resources: z.strictObject({
    cpus: z.number().finite().positive(),
    memoryBytes: z.number().int().positive(),
  }),
  pricing: z.record(z.string(), pricingEntrySchema).optional(),
});

const operatorConfigSchema = z.strictObject({
  schemaVersion: z.union([z.literal(2), z.literal(3)]),
  toolchain: toolchainConfigSchema,
  swebenchPro: z.unknown().optional(),
  sweMarathon: z.unknown().optional(),
  featureBench: featureBenchConfigSchema,
});

export type FeatureBenchConfig = z.infer<typeof featureBenchConfigSchema>;
export type FeatureBenchOperatorConfig = z.infer<typeof operatorConfigSchema>;

export interface FeatureBenchRuntimeBindings {
  brokerUrl: string;
  restrictedNetwork: string;
}

export const DEFAULT_FEATUREBENCH_CONFIG: FeatureBenchConfig = {
  model: '',
  requestedEffort: '',
  arm: 'a',
  taskIds: [],
  broker: {
    publicIdentity: 'operator-supplied-broker-identity',
    publicVersion: 'operator-supplied-broker-version',
  },
  concurrency: { inference: 4, evaluation: 4 },
  timeouts: { inferenceMs: 43_200_000, evaluationMs: 21_600_000 },
  resources: { cpus: 8, memoryBytes: 24 * 1_024 * 1_024 * 1_024 },
};

export function validateFeatureBenchConfig(config: FeatureBenchConfig): void {
  if (!config.model) throw new Error('FeatureBench run requires an explicit model');
  if (!config.requestedEffort) throw new Error('FeatureBench run requires an explicit requested effort');
  if (config.taskIds.length === 0) throw new Error('FeatureBench run requires at least one --task-id');
  if (new Set(config.taskIds).size !== config.taskIds.length) throw new Error('FeatureBench task ids must be unique');
  config.taskIds.forEach(validateFeatureBenchTaskId);
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

export function loadFeatureBenchOperatorConfig(roots: BenchPathRoots): FeatureBenchOperatorConfig {
  const file = join(roots.benchRoot, 'bench.config.json');
  if (!existsSync(file)) {
    throw new Error(`private benchmark config is missing at ${file}; copy bench.example.config.json and chmod it 0600`);
  }
  return loadPrivateOperatorConfig(file, operatorConfigSchema);
}

export function resolveFeatureBenchConfig(
  operator: FeatureBenchOperatorConfig,
  override: Partial<FeatureBenchConfig> = {},
): FeatureBenchConfig {
  const config = featureBenchConfigSchema.parse(merge(operator.featureBench, override));
  validateFeatureBenchConfig(config);
  return config;
}

/** Runtime names are supplied anew for every launch and never enter a manifest. */
export function loadFeatureBenchRuntimeBindings(
  source: NodeJS.ProcessEnv = process.env,
): FeatureBenchRuntimeBindings {
  const brokerUrl = source.FEATUREBENCH_CREDENTIAL_BROKER_URL ?? '';
  const restrictedNetwork = source.FEATUREBENCH_RESTRICTED_NETWORK ?? '';
  let parsed: URL;
  try { parsed = new URL(brokerUrl); } catch {
    throw new Error('FEATUREBENCH_CREDENTIAL_BROKER_URL must be an absolute HTTPS URL');
  }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error('FEATUREBENCH_CREDENTIAL_BROKER_URL must be HTTPS without userinfo, query, or fragment');
  }
  validatePortableComponent(parsed.hostname, 'FeatureBench broker hostname');
  validatePortableComponent(restrictedNetwork, 'FEATUREBENCH_RESTRICTED_NETWORK');
  return { brokerUrl, restrictedNetwork };
}

export const featureBenchCacheRoot = (roots: BenchPathRoots): string => join(roots.cacheRoot, 'featurebench');
export const featureBenchCurrentFile = (roots: BenchPathRoots): string => join(featureBenchCacheRoot(roots), 'current.json');
export const featureBenchPreparedDir = (roots: BenchPathRoots, identity: string): string =>
  join(featureBenchCacheRoot(roots), identity);
