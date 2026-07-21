/** Strict operator configuration loading across the credential boundary. */
import { closeSync, constants, fstatSync, openSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { z, type ZodType } from 'zod';

const NOFOLLOW = constants.O_NOFOLLOW ?? 0;
const MAX_CONFIG_BYTES = 1 * 1_024 * 1_024;

export const toolchainConfigSchema = z.strictObject({
  nodeVersion: z.string().regex(/^v?\d+\.\d+\.\d+$/),
  nodeDistribution: z.enum(['npmmirror', 'nodejs', 'unofficial-glibc217']),
  codexBinary: z.string().min(1),
});

export const sharedBenchConfigSchema = z.strictObject({
  schemaVersion: z.union([z.literal(2), z.literal(3)]),
  toolchain: toolchainConfigSchema,
  cacheRoot: z.string().min(1).optional(),
});

export type ToolchainConfig = z.infer<typeof toolchainConfigSchema>;
export type SharedBenchConfig = z.infer<typeof sharedBenchConfigSchema>;

export interface SerializedImmutableOptions {
  readonly model: string;
  readonly requestedEffort: string;
  readonly publicCredentialIdentitySha256: string;
}

export interface RuntimeBindings {
  readonly authFile?: string;
  readonly apiKey?: string;
  readonly brokerUrl?: string;
  readonly restrictedNetwork?: string;
  readonly pipConfigFile?: string;
}

/** Validate a runtime-only private file without reading or serializing it. */
export function assertPrivateRuntimeFile(path: string, description: string): string {
  const resolved = resolve(path);
  const fd = openSync(resolved, constants.O_RDONLY | NOFOLLOW);
  try {
    const info = fstatSync(fd);
    const uid = typeof process.getuid === 'function' ? process.getuid() : undefined;
    if (!info.isFile() || info.nlink !== 1) throw new Error(`${description} must be a singly-linked regular file`);
    if (uid !== undefined && info.uid !== uid) throw new Error(`${description} must be owned by the current user`);
    if ((info.mode & 0o777) !== 0o600) throw new Error(`${description} must have mode 0600`);
    return resolved;
  } finally {
    closeSync(fd);
  }
}

function assertNoSecretBearingUrls(value: unknown, path = 'config'): void {
  if (typeof value === 'string' && /^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
    const url = new URL(value);
    if (url.username || url.password || url.search || url.hash) {
      throw new Error(`${path} contains a secret-bearing URL`);
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertNoSecretBearingUrls(entry, `${path}[${index}]`));
    return;
  }
  if (value !== null && typeof value === 'object') {
    for (const [key, entry] of Object.entries(value)) assertNoSecretBearingUrls(entry, `${path}.${key}`);
  }
}

/** Read a real, current-user-owned 0600 JSON file and validate it strictly. */
export function loadPrivateOperatorConfig<T>(path: string, schema: ZodType<T>): T {
  const fd = openSync(path, constants.O_RDONLY | NOFOLLOW);
  try {
    const info = fstatSync(fd);
    const uid = typeof process.getuid === 'function' ? process.getuid() : undefined;
    if (!info.isFile() || info.nlink !== 1) throw new Error('benchmark operator config must be a regular file');
    if (uid !== undefined && info.uid !== uid) throw new Error('benchmark operator config must be owned by the current user');
    if ((info.mode & 0o777) !== 0o600) throw new Error('benchmark operator config must have mode 0600');
    if (info.size > MAX_CONFIG_BYTES) throw new Error('benchmark operator config is too large');
    const parsed = JSON.parse(readFileSync(fd, 'utf8')) as unknown;
    const after = fstatSync(fd);
    if (after.dev !== info.dev || after.ino !== info.ino || after.size !== info.size
      || after.mtimeMs !== info.mtimeMs || after.ctimeMs !== info.ctimeMs || after.nlink !== 1) {
      throw new Error('benchmark operator config changed while it was being read');
    }
    assertNoSecretBearingUrls(parsed);
    return schema.parse(parsed);
  } finally {
    closeSync(fd);
  }
}

export function loadSharedBenchConfig(path: string): SharedBenchConfig {
  return loadPrivateOperatorConfig(path, sharedBenchConfigSchema);
}
