/**
 * Final benchmark identity and filesystem layout contract. All persistent runs
 * live below results/<suite>/<runId>; host-owned files are private, atomic, and
 * never written through symlink leaves or ancestors.
 */
import { createHash, randomBytes } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  readdirSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import type { Stats } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep, win32 } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BENCH_SUITES, type BenchPathRoots, type BenchSuite } from './contracts.js';

declare const RUN_ID_BRAND: unique symbol;
declare const ARTIFACT_KEY_BRAND: unique symbol;
declare const RELATIVE_ARTIFACT_PATH_BRAND: unique symbol;

export type RunId = string & { readonly [RUN_ID_BRAND]: true };
export type ArtifactKey = string & { readonly [ARTIFACT_KEY_BRAND]: true };
export type RelativeArtifactPath = string & { readonly [RELATIVE_ARTIFACT_PATH_BRAND]: true };

const RUN_ID_RE = /^[a-z0-9](?:[a-z0-9._-]{0,126}[a-z0-9])?$/;
const PORTABLE_COMPONENT_RE = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,126}[A-Za-z0-9])?$/;
const WINDOWS_RESERVED_NAME_RE = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;
const ARTIFACT_KEY_RE = /^[a-z0-9](?:[a-z0-9-]{0,47}[a-z0-9])?-[a-f0-9]{64}$/;
const MAX_PRIVATE_FILE_BYTES = 64 * 1_024 * 1_024;
const NOFOLLOW = constants.O_NOFOLLOW ?? 0;
let temporarySequence = 0;

const BENCH_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

export const DEFAULT_BENCH_PATH_ROOTS: BenchPathRoots = Object.freeze({
  benchRoot: BENCH_ROOT,
  cacheRoot: join(BENCH_ROOT, '.cache'),
  resultsRoot: join(BENCH_ROOT, 'results'),
});

/** Build absolute roots for tests or an explicitly relocated bench checkout. */
export function createBenchPathRoots(benchRoot: string): BenchPathRoots {
  const root = resolve(benchRoot);
  return Object.freeze({
    benchRoot: root,
    cacheRoot: join(root, '.cache'),
    resultsRoot: join(root, 'results'),
  });
}

export function validateBenchSuite(value: string): BenchSuite {
  if (!(BENCH_SUITES as readonly string[]).includes(value)) {
    throw new Error(`unknown benchmark suite '${value}'`);
  }
  return value as BenchSuite;
}

export function isSafeRunId(value: string): boolean {
  return Buffer.byteLength(value, 'utf8') <= 128
    && RUN_ID_RE.test(value)
    && !WINDOWS_RESERVED_NAME_RE.test(value);
}

/** Validate the lowercase, portable run namespace used on every supported host. */
export function validateRunId(value: string): RunId {
  if (!isSafeRunId(value)) {
    throw new Error(
      `invalid run id '${value}': use 1-128 lowercase ASCII letters, digits, dots, underscores, or dashes; start and end with a letter or digit`,
    );
  }
  return value as RunId;
}

export function isPortableComponent(value: string): boolean {
  return Buffer.byteLength(value, 'utf8') <= 128
    && PORTABLE_COMPONENT_RE.test(value)
    && !WINDOWS_RESERVED_NAME_RE.test(value);
}

/** Validate a native component that is not a benchmark run identity. */
export function validatePortableComponent(value: string, description: string): string {
  if (!isPortableComponent(value)) {
    throw new Error(`${description} must be one portable filesystem component`);
  }
  return value;
}

/** Task IDs remain logical inventory keys and are never joined into host paths. */
export function validateTaskId(value: string): string {
  if (
    value.length === 0
    || Buffer.byteLength(value, 'utf8') > 4_096
    || value.includes('\0')
    || /[\u0001-\u001f\u007f]/.test(value)
    || Buffer.from(value, 'utf8').toString('utf8') !== value
  ) {
    throw new Error('task id must be non-empty, canonical UTF-8 text without control characters');
  }
  return value;
}

/** Retained suite-specific inventory validation; the result is still not a path component. */
export function validateFeatureBenchTaskId(value: string): string {
  validateTaskId(value);
  if (!isPortableComponent(value) || value.includes('..')) {
    throw new Error(`unsafe FeatureBench task ID '${value}'`);
  }
  return value;
}

/** Map arbitrary inventory identity to a collision-resistant portable directory key. */
export function artifactKey(taskId: string): ArtifactKey {
  validateTaskId(taskId);
  const prefix = taskId
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
    .replace(/-+$/g, '') || 'task';
  const digest = createHash('sha256').update(taskId, 'utf8').digest('hex');
  return `${prefix}-${digest}` as ArtifactKey;
}

export function validateArtifactKey(value: string): ArtifactKey {
  if (!ARTIFACT_KEY_RE.test(value)) throw new Error(`invalid benchmark artifact key '${value}'`);
  return value as ArtifactKey;
}

/** Validate a canonical slash-separated relative path for persisted bindings. */
export function validateRelativeArtifactPath(value: string): RelativeArtifactPath {
  if (
    value.length === 0
    || value.includes('\0')
    || value.includes('\\')
    || isAbsolute(value)
    || win32.isAbsolute(value)
  ) {
    throw new Error(`invalid relative artifact path '${value}'`);
  }
  const components = value.split('/');
  if (components.some((component) => !isPortableComponent(component))) {
    throw new Error(`invalid relative artifact path '${value}'`);
  }
  return value as RelativeArtifactPath;
}

/** Resolve relative input beneath one root, rejecting Windows forms on POSIX too. */
export function joinWithinRoot(root: string, ...parts: string[]): string {
  for (const part of parts) {
    if (part.includes('\0') || part.includes('\\') || isAbsolute(part) || win32.isAbsolute(part)) {
      throw new Error(`path component must be a portable relative path: '${part}'`);
    }
  }
  const base = resolve(root);
  const candidate = resolve(base, ...parts);
  const fromBase = relative(base, candidate);
  if (fromBase === '..' || fromBase.startsWith(`..${sep}`) || isAbsolute(fromBase)) {
    throw new Error(`path escapes root '${base}'`);
  }
  return candidate;
}

export const suiteResultsDir = (roots: BenchPathRoots, suite: BenchSuite): string =>
  join(roots.resultsRoot, validateBenchSuite(suite));

export const runDir = (roots: BenchPathRoots, suite: BenchSuite, runId: RunId | string): string =>
  join(suiteResultsDir(roots, suite), validateRunId(runId));

export const manifestFile = (roots: BenchPathRoots, suite: BenchSuite, runId: RunId | string): string =>
  join(runDir(roots, suite, runId), 'manifest.json');

export const runStateFile = (roots: BenchPathRoots, suite: BenchSuite, runId: RunId | string): string =>
  join(runDir(roots, suite, runId), 'run-state.json');

export const runStateLedgerDir = (roots: BenchPathRoots, suite: BenchSuite, runId: RunId | string): string =>
  join(runDir(roots, suite, runId), 'run-state-ledger');

export const verifierReceiptFile = (roots: BenchPathRoots, suite: BenchSuite, runId: RunId | string): string =>
  join(runDir(roots, suite, runId), 'verifier-receipt.json');

export const reportJsonFile = (roots: BenchPathRoots, suite: BenchSuite, runId: RunId | string): string =>
  join(runDir(roots, suite, runId), 'report.json');

export const reportMarkdownFile = (roots: BenchPathRoots, suite: BenchSuite, runId: RunId | string): string =>
  join(runDir(roots, suite, runId), 'report.md');

export const nativeDir = (roots: BenchPathRoots, suite: BenchSuite, runId: RunId | string): string =>
  join(runDir(roots, suite, runId), 'native');

export const runClaimFile = (roots: BenchPathRoots, suite: BenchSuite, runId: RunId | string): string =>
  join(suiteResultsDir(roots, suite), '.claims', `${validateRunId(runId)}.lock`);

export const runLeaseFile = (roots: BenchPathRoots, suite: BenchSuite, runId: RunId | string): string =>
  join(runDir(roots, suite, runId), '.lifecycle.lock');

function currentUid(): number | undefined {
  return typeof process.getuid === 'function' ? process.getuid() : undefined;
}

function assertOwned(info: Stats, path: string): void {
  const uid = currentUid();
  if (uid !== undefined && info.uid !== uid) throw new Error(`path is not owned by the current user: ${path}`);
}

function assertRealDirectory(path: string, description: string, privateMode = false): void {
  const info = lstatSync(path);
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new Error(`${description} must be a real directory: ${path}`);
  }
  assertOwned(info, path);
  if (privateMode && (info.mode & 0o777) !== 0o700) {
    throw new Error(`${description} must have mode 0700: ${path}`);
  }
}

function mkdirExclusiveOrExisting(path: string, mode: number): void {
  try {
    mkdirSync(path, { mode });
  } catch (error) {
    if (!(error instanceof Error) || !('code' in error) || error.code !== 'EEXIST') throw error;
  }
}

/** Create missing real ancestors beneath a root without changing existing root permissions. */
export function ensureRealDirectoryWithin(root: string, directory: string): string {
  const base = resolve(root);
  const target = joinWithinRoot(base, relative(base, resolve(directory)));
  mkdirExclusiveOrExisting(base, 0o700);
  assertRealDirectory(base, 'artifact root');
  let current = base;
  const fromBase = relative(base, target);
  for (const component of fromBase === '' ? [] : fromBase.split(sep)) {
    current = join(current, component);
    mkdirExclusiveOrExisting(current, 0o700);
    assertRealDirectory(current, 'artifact ancestor');
  }
  return target;
}

/** Create and require private suite/run ancestors while preserving results-root mode. */
export function ensurePrivateDirectoryWithin(root: string, directory: string): string {
  const base = resolve(root);
  const target = joinWithinRoot(base, relative(base, resolve(directory)));
  mkdirExclusiveOrExisting(base, 0o700);
  assertRealDirectory(base, 'benchmark root');
  let current = base;
  const fromBase = relative(base, target);
  for (const component of fromBase === '' ? [] : fromBase.split(sep)) {
    current = join(current, component);
    mkdirExclusiveOrExisting(current, 0o700);
    assertRealDirectory(current, 'private benchmark directory', true);
  }
  return target;
}

/** Require an existing private directory chain without creating any component. */
export function requirePrivateDirectoryWithin(root: string, directory: string): string {
  const base = resolve(root);
  const target = joinWithinRoot(base, relative(base, resolve(directory)));
  assertRealDirectory(base, 'benchmark root');
  let current = base;
  const fromBase = relative(base, target);
  for (const component of fromBase === '' ? [] : fromBase.split(sep)) {
    current = join(current, component);
    assertRealDirectory(current, 'private benchmark directory', true);
  }
  return target;
}

/** Exclusively create one final run directory; callers must hold its run-ID claim. */
export function createPrivateRunDirectory(roots: BenchPathRoots, suite: BenchSuite, runId: RunId | string): string {
  const parent = ensurePrivateDirectoryWithin(roots.resultsRoot, suiteResultsDir(roots, suite));
  const target = runDir(roots, suite, runId);
  mkdirSync(target, { mode: 0o700 });
  assertRealDirectory(parent, 'suite results directory', true);
  assertRealDirectory(target, 'run directory', true);
  return target;
}

/** Remove one contained stopped-attempt tree and recreate a private real directory. */
export function resetArtifactDirectory(root: string, directory: string): string {
  const parent = ensureRealDirectoryWithin(root, dirname(directory));
  const target = resolve(directory);
  const fromParent = relative(parent, target);
  if (fromParent === '' || fromParent === '..' || fromParent.startsWith(`..${sep}`) || fromParent.includes(sep)) {
    throw new Error(`artifact reset target must be one child of ${parent}: ${target}`);
  }
  let targetInfo: Stats | null = null;
  try {
    targetInfo = lstatSync(target);
  } catch (error) {
    if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error;
  }
  if (targetInfo?.isSymbolicLink()) {
    assertOwned(targetInfo, target);
    unlinkSync(target);
  } else if (targetInfo !== null) {
    reclaimAndAssertArtifactTree(target);
    rmSync(target, { recursive: true });
  }
  mkdirSync(target, { mode: 0o700 });
  assertRealDirectory(target, 'artifact directory');
  return target;
}

/** Reject links and special files anywhere in a stopped task-controlled tree. */
export function assertArtifactTree(root: string): void {
  const base = resolve(root);
  assertRealDirectory(base, 'artifact tree root');
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      const info = lstatSync(path);
      assertOwned(info, path);
      if (info.isSymbolicLink()) throw new Error(`artifact tree contains a symlink: ${path}`);
      if (info.isDirectory()) walk(path);
      else if (!info.isFile()) throw new Error(`artifact tree contains a non-file entry: ${path}`);
      else if (info.nlink !== 1) throw new Error(`artifact tree contains a multiply-linked file: ${path}`);
    }
  };
  walk(base);
}

/** Reclaim owner-controlled mode-000 directories, then apply the strict tree walk. */
export function reclaimAndAssertArtifactTree(root: string): void {
  const base = resolve(root);
  const visit = (directory: string): void => {
    const directoryInfo = lstatSync(directory);
    if (directoryInfo.isSymbolicLink() || !directoryInfo.isDirectory()) {
      throw new Error(`artifact tree directory is unsafe: ${directory}`);
    }
    assertOwned(directoryInfo, directory);
    chmodSync(directory, 0o700);
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      const info = lstatSync(path);
      assertOwned(info, path);
      if (info.isSymbolicLink()) throw new Error(`artifact tree contains a symlink: ${path}`);
      if (info.isDirectory()) visit(path);
      else if (!info.isFile()) throw new Error(`artifact tree contains a non-file entry: ${path}`);
      else if (info.nlink !== 1) throw new Error(`artifact tree contains a multiply-linked file: ${path}`);
      else chmodSync(path, 0o600);
    }
  };
  visit(base);
  assertArtifactTree(base);
}

function assertReplaceableTarget(path: string): void {
  if (!existsSync(path)) return;
  const info = lstatSync(path);
  if (info.isSymbolicLink()) return;
  if (!info.isFile() || info.nlink !== 1) throw new Error(`private file target is not replaceable: ${path}`);
  assertOwned(info, path);
}

function assertRealAncestorChain(root: string, path: string, description: string): string {
  const base = resolve(root);
  assertRealDirectory(base, `${description} root`);
  const target = joinWithinRoot(base, relative(base, resolve(path)));
  const fromBase = relative(base, target);
  const components = fromBase === '' ? [] : fromBase.split(sep);
  if (components.length === 0) throw new Error(`${description} must be beneath ${base}`);
  let current = base;
  for (const component of components.slice(0, -1)) {
    current = join(current, component);
    const info = lstatSync(current);
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new Error(`${description} ancestor must be a real directory: ${current}`);
    }
    assertOwned(info, current);
  }
  return target;
}

/** Durably publish directory-entry changes where the host filesystem supports it. */
export function fsyncDirectory(path: string): void {
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | NOFOLLOW);
    fsyncSync(fd);
  } catch (error) {
    if (!(error instanceof Error) || !/EINVAL|ENOTSUP|EISDIR/.test(error.message)) throw error;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** Atomically replace one host-owned file, cleaning failed temporary files. */
export function replaceArtifactFile(path: string, contents: string | Buffer): void {
  const parent = dirname(path);
  assertRealDirectory(parent, 'artifact file parent');
  assertReplaceableTarget(path);
  const temporary = join(parent, `.${process.pid}.${temporarySequence++}.${randomBytes(16).toString('hex')}.tmp`);
  let fd: number | undefined;
  try {
    fd = openSync(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW,
      0o600,
    );
    const payload = typeof contents === 'string' ? Buffer.from(contents, 'utf8') : contents;
    let offset = 0;
    while (offset < payload.length) {
      const written = writeSync(fd, payload, offset, payload.length - offset);
      if (written === 0) throw new Error(`temporary private file write made no progress: ${temporary}`);
      offset += written;
    }
    fchmodSync(fd, 0o600);
    fsyncSync(fd);
    const info = fstatSync(fd);
    if (!info.isFile() || info.nlink !== 1 || (info.mode & 0o777) !== 0o600) {
      throw new Error(`temporary private file failed postcondition: ${temporary}`);
    }
    closeSync(fd);
    fd = undefined;
    assertReplaceableTarget(path);
    renameSync(temporary, path);
    fsyncDirectory(parent);
  } catch (error) {
    if (fd !== undefined) closeSync(fd);
    try {
      unlinkSync(temporary);
    } catch {
      // The temporary may never have been created or may already be renamed.
    }
    throw error;
  }
}

/** Atomically write beneath an explicitly trusted real root. */
export function writePrivateFileAtomic(root: string, path: string, contents: string | Buffer): void {
  const target = assertRealAncestorChain(root, path, 'private file');
  replaceArtifactFile(target, contents);
}

/** Atomically persist one JSON value beneath a trusted root with mode 0600. */
export function writePrivateJsonAtomic(root: string, path: string, value: unknown): void {
  writePrivateFileAtomic(root, path, `${JSON.stringify(value, null, 2)}\n`);
}

function readRegularDescriptor(path: string, maximumBytes: number, requirePrivate = false): Buffer {
  const fd = openSync(path, constants.O_RDONLY | NOFOLLOW);
  try {
    const info = fstatSync(fd);
    if (!info.isFile() || info.nlink !== 1) throw new Error(`artifact is not a singly-linked regular file: ${path}`);
    if (requirePrivate) {
      assertOwned(info, path);
      if ((info.mode & 0o777) !== 0o600) throw new Error(`private file must have mode 0600: ${path}`);
    }
    if (info.size > maximumBytes) throw new Error(`artifact exceeds ${maximumBytes} bytes: ${path}`);
    const output = Buffer.alloc(info.size);
    let offset = 0;
    while (offset < output.length) {
      const count = readSync(fd, output, offset, output.length - offset, offset);
      if (count === 0) break;
      offset += count;
    }
    if (offset !== output.length) throw new Error(`artifact changed while being read: ${path}`);
    const after = fstatSync(fd);
    const leaf = lstatSync(path);
    if (after.dev !== info.dev || after.ino !== info.ino || after.size !== info.size
      || after.mtimeMs !== info.mtimeMs || after.ctimeMs !== info.ctimeMs || after.nlink !== 1
      || leaf.isSymbolicLink() || leaf.dev !== info.dev || leaf.ino !== info.ino) {
      throw new Error(`artifact changed while being read: ${path}`);
    }
    return output;
  } finally {
    closeSync(fd);
  }
}

/** Resolve and read bounded regular data through a checked real ancestor chain. */
export function readRegularFileWithinRoot(
  root: string,
  relativePath: string,
  maximumBytes = MAX_PRIVATE_FILE_BYTES,
): Buffer {
  const path = resolveRegularFileWithinRoot(root, relativePath);
  return readRegularDescriptor(path, maximumBytes);
}

/** Resolve a contained regular file while rejecting symlinked ancestors. */
export function resolveRegularFileWithinRoot(
  root: string,
  relativePath: string,
  description = 'artifact',
): string {
  const base = resolve(root);
  const rootInfo = lstatSync(base);
  if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) {
    throw new Error(`${description} root must be a real directory: ${base}`);
  }
  const candidate = joinWithinRoot(base, relativePath);
  const components = relative(base, candidate).split(sep);
  if (components.length === 0 || components[0] === '') {
    throw new Error(`${description} must name a file beneath ${base}`);
  }
  let current = base;
  for (let index = 0; index < components.length; index += 1) {
    current = join(current, components[index]!);
    const info = lstatSync(current);
    assertOwned(info, current);
    if (info.isSymbolicLink()) throw new Error(`${description} must not have symlinked ancestors: ${current}`);
    if (index < components.length - 1 && !info.isDirectory()) {
      throw new Error(`${description} ancestor must be a directory: ${current}`);
    }
    if (index === components.length - 1 && (!info.isFile() || info.nlink !== 1)) {
      throw new Error(`${description} must be a singly-linked regular file: ${current}`);
    }
  }
  return candidate;
}

/** Read a host-owned private file after checking ownership and exact mode. */
export function readPrivateFile(root: string, path: string, maximumBytes = MAX_PRIVATE_FILE_BYTES): Buffer {
  const target = assertRealAncestorChain(root, path, 'private file');
  const info = lstatSync(target);
  if (info.isSymbolicLink() || !info.isFile() || info.nlink !== 1) {
    throw new Error(`private file must be a singly-linked regular file: ${target}`);
  }
  assertOwned(info, target);
  if ((info.mode & 0o777) !== 0o600) throw new Error(`private file must have mode 0600: ${target}`);
  return readRegularDescriptor(target, maximumBytes, true);
}

/** Read and parse one private JSON file without accepting an empty document. */
export function readPrivateJson(root: string, path: string, maximumBytes = MAX_PRIVATE_FILE_BYTES): unknown {
  const raw = readPrivateFile(root, path, maximumBytes).toString('utf8');
  if (raw.trim().length === 0) throw new Error(`private JSON file is empty: ${path}`);
  return JSON.parse(raw) as unknown;
}
