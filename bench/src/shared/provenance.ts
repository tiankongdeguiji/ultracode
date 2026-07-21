/** Structured immutable provenance and deterministic content attestation. */
import { createHash } from 'node:crypto';
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  readdirSync,
  readlinkSync,
  realpathSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import { validateRelativeArtifactPath, validateTaskId } from './paths.js';

export const SHA256_RE = /^[a-f0-9]{64}$/;
export const GIT_OBJECT_ID_RE = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
export const sha256Schema = z.string().regex(SHA256_RE);
const DOCKER_LOCAL_ID_RE = /^sha256:[a-f0-9]{64}$/;
const DOCKER_IMAGE_REFERENCE_RE = /^[^\s\u0000-\u001f\u007f]+$/;
const DOCKER_PLATFORM_RE = /^linux\/[a-z0-9_]+$/;
const NOFOLLOW = constants.O_NOFOLLOW ?? 0;

function publicLocator(value: string): string {
  if (value.includes('\0') || /[\u0001-\u001f\u007f]/.test(value)) {
    throw new Error('source locator contains control characters');
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('source locator must be an absolute URL');
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error('source locator must not contain credentials, query parameters, or fragments');
  }
  return value;
}

export const publicLocatorSchema = z.string().transform(publicLocator);

export const toolchainProvenanceSchema = z.strictObject({
  payloadSha256: sha256Schema,
  manifestSha256: sha256Schema,
  treeSha256: sha256Schema,
  node: z.strictObject({
    version: z.string().min(1),
    platform: z.string().min(1),
    archiveSha256: sha256Schema,
    checksumManifestSha256: sha256Schema,
    treeSha256: sha256Schema,
    muslArchiveSha256: sha256Schema,
    muslChecksumManifestSha256: sha256Schema,
    muslTreeSha256: sha256Schema,
    muslRuntimeImageDigest: z.string().regex(/^.+@sha256:[a-f0-9]{64}$/),
  }),
  codex: z.strictObject({
    version: z.string().min(1),
    binarySha256: sha256Schema,
  }),
  ultracode: z.strictObject({
    revision: z.string().regex(GIT_OBJECT_ID_RE),
    releaseSha256: sha256Schema,
    treeSha256: sha256Schema,
  }),
});

export const controlPlaneProvenanceSchema = z.strictObject({
  manifestPolicySha256: sha256Schema,
  metricsPolicySha256: sha256Schema,
  failurePolicySha256: sha256Schema,
  reportPolicySha256: sha256Schema,
  adapterPolicySha256: sha256Schema,
});

export const sourceProvenanceSchema = z.strictObject({
  repository: publicLocatorSchema,
  revision: z.string().regex(GIT_OBJECT_ID_RE),
  treeSha256: sha256Schema,
});

export const datasetProvenanceSchema = z.strictObject({
  identity: z.string().min(1).max(512),
  revision: z.string().min(1).max(512),
  split: z.string().min(1).max(128),
  snapshotSha256: sha256Schema,
});

export const environmentProvenanceSchema = z.strictObject({
  platform: z.string().min(1),
  architecture: z.string().min(1),
  nodeVersion: z.string().min(1),
  pythonVersion: z.string().min(1).nullable(),
  environmentSha256: sha256Schema.nullable(),
});

export const nativeAssetProvenanceSchema = z.strictObject({
  path: z.string().transform(validateRelativeArtifactPath),
  sha256: sha256Schema,
});

export const taskProvenanceSchema = z.strictObject({
  taskId: z.string().transform(validateTaskId),
  sourceSha256: sha256Schema,
  image: z.strictObject({
    requested: z.string().regex(DOCKER_IMAGE_REFERENCE_RE),
    resolvedDigest: z.string().regex(/^.+@sha256:[a-f0-9]{64}$/),
    base: z.strictObject({
      localId: z.string().regex(DOCKER_LOCAL_ID_RE),
      platform: z.string().regex(DOCKER_PLATFORM_RE),
    }),
    overlay: z.strictObject({
      name: z.string().regex(DOCKER_IMAGE_REFERENCE_RE),
      localId: z.string().regex(DOCKER_LOCAL_ID_RE),
      platform: z.string().regex(DOCKER_PLATFORM_RE),
    }),
  }).nullable(),
});

export const modelTransportProvenanceSchema = z.strictObject({
  mechanism: z.literal('attested-model-relay'),
  contractSha256: sha256Schema,
  relayIdentitySha256: sha256Schema,
  relayVersionSha256: sha256Schema,
  fixedDestinationSha256: sha256Schema,
  modelSha256: sha256Schema,
  relayRuntimeSha256: sha256Schema,
  topologySha256: sha256Schema,
});

export const benchProvenanceSchema = z.strictObject({
  toolchain: toolchainProvenanceSchema,
  controlPlane: controlPlaneProvenanceSchema,
  suiteSource: sourceProvenanceSchema,
  dataset: datasetProvenanceSchema,
  environment: environmentProvenanceSchema,
  modelTransport: modelTransportProvenanceSchema.optional(),
  nativeAssets: z.array(nativeAssetProvenanceSchema),
  tasks: z.array(taskProvenanceSchema),
});

export type BenchProvenance = z.infer<typeof benchProvenanceSchema>;
export type ToolchainProvenance = z.infer<typeof toolchainProvenanceSchema>;
export type SourceProvenance = z.infer<typeof sourceProvenanceSchema>;

/** Hash exact in-memory bytes already read through a trusted descriptor. */
export function sha256Buffer(value: Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

function hashFrame(hash: ReturnType<typeof createHash>, value: string): void {
  const payload = Buffer.from(value, 'utf8');
  const length = Buffer.allocUnsafe(8);
  length.writeBigUInt64BE(BigInt(payload.length));
  hash.update(length);
  hash.update(payload);
}

/** SHA-256 one regular file from an O_NOFOLLOW descriptor. */
export function sha256File(path: string): string {
  const fd = openSync(path, constants.O_RDONLY | NOFOLLOW);
  try {
    const before = fstatSync(fd);
    if (!before.isFile() || before.nlink !== 1) throw new Error(`provenance input must be a regular file: ${path}`);
    const hash = createHash('sha256');
    const buffer = Buffer.allocUnsafe(64 * 1_024);
    for (;;) {
      const bytes = readSync(fd, buffer, 0, buffer.length, null);
      if (bytes === 0) break;
      hash.update(buffer.subarray(0, bytes));
    }
    const after = fstatSync(fd);
    if (
      after.dev !== before.dev
      || after.ino !== before.ino
      || after.size !== before.size
      || after.mtimeMs !== before.mtimeMs
      || after.ctimeMs !== before.ctimeMs
      || after.nlink !== 1
    ) {
      throw new Error(`provenance input changed while being hashed: ${path}`);
    }
    return hash.digest('hex');
  } finally {
    closeSync(fd);
  }
}

export interface Sha256TreeOptions {
  excludePythonCacheArtifacts?: boolean;
  /** Exclude exact root-relative paths such as a self-describing content manifest. */
  exclude?: readonly string[];
}

interface TreeHashRecord {
  kind: 'directory' | 'file' | 'symlink';
  path: string;
  mode: number;
  payload: string;
}

function isPythonCacheArtifact(path: string): boolean {
  const components = path.split('/');
  return path.endsWith('.pyc') && components.at(-2) === '__pycache__';
}

/** Hash a real directory tree deterministically without following links. */
export function sha256Tree(root: string, options: Sha256TreeOptions = {}): string {
  const base = resolve(root);
  const rootInfo = lstatSync(base);
  if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) {
    throw new Error(`tree root must be a real directory: ${base}`);
  }
  const excluded = new Set(options.exclude ?? []);
  const walk = (directory: string, prefix: string): TreeHashRecord[] => {
    const records: TreeHashRecord[] = [];
    for (const entry of readdirSync(directory, { withFileTypes: true })
      .sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0)) {
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (excluded.has(relativePath)) continue;
      const path = join(directory, entry.name);
      const info = lstatSync(path);
      if (info.isSymbolicLink()) {
        records.push({ kind: 'symlink', path: relativePath, mode: info.mode & 0o777, payload: readlinkSync(path) });
      } else if (info.isDirectory()) {
        const children = walk(path, relativePath);
        if (options.excludePythonCacheArtifacts && entry.name === '__pycache__' && children.length === 0) continue;
        records.push({ kind: 'directory', path: relativePath, mode: info.mode & 0o777, payload: '' }, ...children);
      } else if (info.isFile()) {
        if (info.nlink !== 1) throw new Error(`cannot attest multiply-linked file: ${path}`);
        if (options.excludePythonCacheArtifacts && isPythonCacheArtifact(relativePath)) continue;
        records.push({
          kind: 'file',
          path: relativePath,
          mode: info.mode & 0o777,
          payload: `${info.size}:${sha256File(path)}`,
        });
      } else {
        throw new Error(`cannot attest non-file tree entry: ${path}`);
      }
    }
    return records;
  };
  const hash = createHash('sha256');
  hashFrame(hash, 'ultracode-tree-sha256-v2');
  for (const record of walk(base, '')) {
    hashFrame(hash, record.kind);
    hashFrame(hash, record.path);
    hashFrame(hash, String(record.mode));
    hashFrame(hash, record.payload);
  }
  return hash.digest('hex');
}

/** Bind a Python environment tree and the bytes behind its interpreter symlink. */
export function pythonEnvironmentSha256(environmentDirectory: string): string {
  return sha256CanonicalJson({
    treeSha256: sha256Tree(environmentDirectory, { excludePythonCacheArtifacts: true }),
    pythonBinarySha256: sha256File(realpathSync(join(environmentDirectory, 'bin', 'python'))),
  });
}

function canonicalize(value: unknown): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('canonical JSON does not permit non-finite numbers');
    return value;
  }
  if (Array.isArray(value)) return value.map(canonicalize);
  if (typeof value === 'object') {
    const output: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const entry = (value as Record<string, unknown>)[key];
      if (entry === undefined) throw new Error(`canonical JSON does not permit undefined at '${key}'`);
      output[key] = canonicalize(entry);
    }
    return output;
  }
  throw new Error(`canonical JSON does not permit ${typeof value}`);
}

/** Stable JSON bytes used for row, policy, and immutable-resume identities. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

export function sha256CanonicalJson(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex');
}

export function assertFileSha256(path: string, expected: string, description = 'file'): void {
  if (!SHA256_RE.test(expected) || sha256File(path) !== expected) {
    throw new Error(`${description} provenance drifted`);
  }
}

export function assertTreeSha256(path: string, expected: string, options: Sha256TreeOptions = {}): void {
  if (!SHA256_RE.test(expected) || sha256Tree(path, options) !== expected) {
    throw new Error('tree provenance drifted');
  }
}
