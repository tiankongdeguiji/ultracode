/** Strict SWE-bench Pro operator configuration and suite-cache layout. */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import type { BenchPathRoots } from '../../shared/contracts.js';
import {
  loadPrivateOperatorConfig,
  toolchainConfigSchema,
} from '../../shared/config.js';
import { publicLocatorSchema } from '../../shared/provenance.js';

export const OFFICIAL_SWEBENCH_PRO_EVALUATOR_REPOSITORY =
  'https://github.com/scaleapi/SWE-bench_Pro-os' as const;
export const OFFICIAL_SWEBENCH_PRO_EVALUATOR_REVISION =
  'ca10a60a5fcae51e6948ffe1485d4153d421e6c5' as const;

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

const modelTransportSchema = z.strictObject({
  relayIdentity: z.string().min(1).max(512),
  relayVersion: z.string().min(1).max(256),
  fixedDestination: publicLocatorSchema.refine((value) => {
    const destination = new URL(value);
    return destination.protocol === 'https:' && destination.pathname === '/v1'
      && !value.includes('?') && !value.includes('#');
  }, 'fixed model destination must be an HTTPS /v1 base URL'),
});

export const swebenchProConfigSchema = z.strictObject({
  model: z.string().max(256).regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/),
  requestedEffort: z.string().max(64).regex(/^[A-Za-z][A-Za-z0-9_-]*$/),
  arm: z.enum(['a', 'b', 'both']),
  selection: selectionSchema,
  modelTransport: modelTransportSchema,
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
    cpus: z.number().finite().positive().refine(
      (cpus) => Number.isSafeInteger(cpus * 1_000_000_000),
      'CPU limit must be an exact positive number of nanocores',
    ),
    memoryBytes: z.number().int().positive(),
  }),
  evaluator: z.strictObject({
    repository: z.literal(OFFICIAL_SWEBENCH_PRO_EVALUATOR_REPOSITORY),
    revision: z.literal(OFFICIAL_SWEBENCH_PRO_EVALUATOR_REVISION),
    pipIndex: publicLocatorSchema,
  }),
  sanitizeGitHistory: z.literal(true),
  pricing: z.record(z.string(), pricingEntrySchema).optional(),
});

const operatorConfigEnvelopeSchema = z.strictObject({
  schemaVersion: z.number().int(),
  toolchain: toolchainConfigSchema,
  swebenchPro: z.unknown(),
  sweMarathon: z.unknown().optional(),
  featureBench: z.unknown().optional(),
}).superRefine((config, context) => {
  if (config.schemaVersion === 2) {
    context.addIssue({
      code: 'custom',
      path: ['schemaVersion'],
      message: 'SWE-bench Pro operator schema version 2 used direct provider auth and is unsupported; migrate to version 3 modelTransport',
    });
  } else if (config.schemaVersion !== 3) {
    context.addIssue({ code: 'custom', path: ['schemaVersion'], message: 'SWE-bench Pro requires operator schema version 3' });
  }
});

export const swebenchProOperatorConfigSchema = operatorConfigEnvelopeSchema.pipe(z.strictObject({
  schemaVersion: z.literal(3),
  toolchain: toolchainConfigSchema,
  swebenchPro: swebenchProConfigSchema,
  sweMarathon: z.unknown().optional(),
  featureBench: z.unknown().optional(),
}));

export type SwebenchProConfig = z.infer<typeof swebenchProConfigSchema>;
export type SwebenchProOperatorConfig = z.infer<typeof swebenchProOperatorConfigSchema>;

export const DEFAULT_SWEBENCH_PRO_CONFIG: SwebenchProConfig = {
  model: '',
  requestedEffort: '',
  arm: 'both',
  selection: { taskIds: null, count: 20, seed: 7, stratifyBy: 'repo_language' },
  modelTransport: {
    relayIdentity: 'operator-supplied-relay-identity',
    relayVersion: 'operator-supplied-relay-version',
    fixedDestination: 'https://api.openai.com/v1',
  },
  timeouts: { sessionMs: 43_200_000, verifierMs: 21_600_000, evaluatorWatchdogMs: 5_400_000 },
  concurrency: { tasks: 4, verifier: 8 },
  docker: { cpus: 8, memoryBytes: 24 * 1_024 * 1_024 * 1_024 },
  evaluator: {
    repository: OFFICIAL_SWEBENCH_PRO_EVALUATOR_REPOSITORY,
    revision: OFFICIAL_SWEBENCH_PRO_EVALUATOR_REVISION,
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

/** Load only the strict v3 config; the incompatible v2 transport shape is rejected. */
export function loadSwebenchProOperatorConfig(roots: BenchPathRoots): SwebenchProOperatorConfig {
  const file = operatorConfigFile(roots);
  if (!existsSync(file)) {
    throw new Error(`private benchmark config is missing at ${file}; copy bench.example.config.json and chmod it 0600`);
  }
  return loadPrivateOperatorConfig(file, swebenchProOperatorConfigSchema);
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

export const suiteCacheDir = (roots: BenchPathRoots): string => join(roots.cacheRoot, 'swebench-pro');
export const instancesFile = (roots: BenchPathRoots): string => join(suiteCacheDir(roots), 'instances-v2.json');
export const swebenchProCurrentFile = (roots: BenchPathRoots): string => join(suiteCacheDir(roots), 'current-v3.json');
export const swebenchProPreparedDir = (roots: BenchPathRoots, identity: string): string =>
  join(suiteCacheDir(roots), identity);
