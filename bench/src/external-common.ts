/**
 * Shared validation, provenance, environment, and owned-process helpers for
 * external benchmark adapters. Process launches are argv-only POSIX groups,
 * and external identifiers are never trusted as path components.
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync, readlinkSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep, win32 } from 'node:path';

const MAX_RUN_ID_LENGTH = 128;
const PORTABLE_RUN_ID_RE = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,126}[A-Za-z0-9])?$/;
const WINDOWS_RESERVED_NAME_RE = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;
const GIT_OBJECT_ID_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;
const FEATUREBENCH_TASK_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,511}$/;
const PORTABLE_COMPONENT_RE = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,126}[A-Za-z0-9])?$/;
const DEFAULT_TAIL_BYTES = 64 * 1024;

/** One executable plus its arguments, suitable for execFile/spawn without a shell. */
export type Argv = [executable: string, ...args: string[]];

export interface PinnedCheckoutPlanOptions {
  repository: string;
  pin: string;
  directory: string;
  /** Whether a clone with an `origin` remote already exists at `directory`. */
  existing?: boolean;
}

/** Return whether a run id is one portable, non-reserved filesystem component. */
export function isSafeRunId(runId: string): boolean {
  if (runId.length === 0 || runId.length > MAX_RUN_ID_LENGTH) return false;
  if (!PORTABLE_RUN_ID_RE.test(runId)) return false;
  return !WINDOWS_RESERVED_NAME_RE.test(runId);
}

/** Validate and return a run id, throwing before it can influence a path or container name. */
export function validateRunId(runId: string): string {
  if (!isSafeRunId(runId)) {
    throw new Error(
      `invalid run id '${runId}': use 1-${MAX_RUN_ID_LENGTH} ASCII letters, digits, dots, underscores, or dashes; start and end with a letter or digit`,
    );
  }
  return runId;
}

/** Reject path-like FeatureBench ids at every public adapter boundary. */
export function validateFeatureBenchTaskId(taskId: string): string {
  if (
    !FEATUREBENCH_TASK_RE.test(taskId)
    || taskId === '.'
    || taskId === '..'
    || taskId.includes('..')
  ) {
    throw new Error(`unsafe FeatureBench task ID '${taskId}'`);
  }
  return taskId;
}

/** Validate one portable, non-reserved component such as a native job name. */
export function validatePortableComponent(name: string, description: string): string {
  if (!PORTABLE_COMPONENT_RE.test(name) || WINDOWS_RESERVED_NAME_RE.test(name)) {
    throw new Error(`${description} must be one portable filesystem component`);
  }
  return name;
}

/** SHA-256 one regular file without executing it. */
export function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

export interface Sha256TreeOptions {
  /** Ignore interpreter-created bytecode files, but no source or loose `.pyc` files. */
  excludePythonCacheArtifacts?: boolean;
}

interface TreeHashRecord {
  kind: 'directory' | 'file' | 'symlink';
  path: string;
  mode: number;
  payload: string;
}

function hashFrame(hash: ReturnType<typeof createHash>, value: string): void {
  const payload = Buffer.from(value, 'utf8');
  const length = Buffer.allocUnsafe(8);
  length.writeBigUInt64BE(BigInt(payload.length));
  hash.update(length);
  hash.update(payload);
}

function isPythonCacheArtifact(relativePath: string): boolean {
  if (!relativePath.endsWith('.pyc')) return false;
  const components = relativePath.split('/');
  return components.length >= 2 && components.at(-2) === '__pycache__';
}

/**
 * Deterministically hash a real directory tree without following symlinks.
 * Every field is length-framed, so paths and payloads cannot be reinterpreted
 * as adjacent records. Python mode suppresses only cache bytecode and a cache
 * directory left empty by that suppression.
 */
export function sha256Tree(root: string, options: Sha256TreeOptions = {}): string {
  const resolvedRoot = resolve(root);
  const rootInfo = lstatSync(resolvedRoot);
  if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) {
    throw new Error(`tree root must be a real directory: ${resolvedRoot}`);
  }
  const walk = (directory: string, prefix: string): TreeHashRecord[] => {
    const records: TreeHashRecord[] = [];
    for (const entry of readdirSync(directory, { withFileTypes: true })
      .sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0)) {
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
      const path = join(directory, entry.name);
      const info = lstatSync(path);
      if (info.isSymbolicLink()) {
        records.push({
          kind: 'symlink',
          path: relativePath,
          mode: info.mode & 0o777,
          payload: readlinkSync(path),
        });
      } else if (info.isDirectory()) {
        const children = walk(path, relativePath);
        if (options.excludePythonCacheArtifacts && entry.name === '__pycache__' && children.length === 0) {
          continue;
        }
        records.push({ kind: 'directory', path: relativePath, mode: info.mode & 0o777, payload: '' }, ...children);
      } else if (info.isFile()) {
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
  for (const record of walk(resolvedRoot, '')) {
    hashFrame(hash, record.kind);
    hashFrame(hash, record.path);
    hashFrame(hash, String(record.mode));
    hashFrame(hash, record.payload);
  }
  return hash.digest('hex');
}

const BASE_CHILD_ENV = [
  'HOME',
  'LANG',
  'LANGUAGE',
  'LC_ALL',
  'LOGNAME',
  'PATH',
  'SHELL',
  'SSL_CERT_DIR',
  'SSL_CERT_FILE',
  'TERM',
  'TMPDIR',
  'TZ',
  'USER',
  'XDG_RUNTIME_DIR',
  'DOCKER_CONFIG',
  'DOCKER_CONTEXT',
  'DOCKER_HOST',
  'DOCKER_TLS_VERIFY',
  'DOCKER_CERT_PATH',
] as const;

/** Build a minimal child environment instead of forwarding unrelated secrets. */
export function allowlistedEnvironment(
  source: NodeJS.ProcessEnv,
  selected: readonly string[] = [],
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const name of [...BASE_CHILD_ENV, ...selected]) {
    const value = source[name];
    if (value !== undefined) env[name] = value;
  }
  return env;
}

export interface OwnedProcessOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** Echo child output as it arrives. */
  stream?: boolean;
  /** Keep only this many bytes per output stream for diagnostics. */
  tailBytes?: number;
}

export interface OwnedProcessResult {
  stdout: string;
  stderr: string;
}

function appendTail(current: Buffer, chunk: Buffer, limit: number): Buffer {
  if (limit === 0) return Buffer.alloc(0);
  const combined = Buffer.concat([current, chunk]);
  return combined.length <= limit ? combined : combined.subarray(combined.length - limit);
}

/**
 * Run one owned POSIX process group, relay wrapper termination signals, await
 * group shutdown, and retain only bounded output tails.
 */
export async function runOwnedProcess(
  command: string,
  argv: readonly string[],
  options: OwnedProcessOptions = {},
): Promise<OwnedProcessResult> {
  const tailBytes = options.tailBytes ?? DEFAULT_TAIL_BYTES;
  if (!Number.isSafeInteger(tailBytes) || tailBytes < 0) throw new Error('tailBytes must be a non-negative integer');
  return await new Promise((resolvePromise, reject) => {
    const child = spawn(command, [...argv], {
      cwd: options.cwd,
      env: options.env,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout: Buffer = Buffer.alloc(0);
    let stderr: Buffer = Buffer.alloc(0);
    let relayedSignal: NodeJS.Signals | null = null;
    let settled = false;
    let escalation: NodeJS.Timeout | null = null;

    const relay = (signal: NodeJS.Signals): void => {
      relayedSignal ??= signal;
      if (child.pid !== undefined) {
        try {
          process.kill(-child.pid, signal);
        } catch {
          // The process group may already have completed.
        }
        if (escalation === null) {
          escalation = setTimeout(() => {
            try {
              process.kill(-child.pid!, 'SIGKILL');
            } catch {
              // The process group honored the relayed signal.
            }
          }, 15_000);
        }
      }
    };
    const onSigint = (): void => relay('SIGINT');
    const onSigterm = (): void => relay('SIGTERM');
    const groupIsAlive = (): boolean => {
      if (child.pid === undefined) return false;
      try {
        process.kill(-child.pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    const awaitGroupShutdown = async (): Promise<void> => {
      const deadline = Date.now() + 16_000;
      while (groupIsAlive() && Date.now() < deadline) {
        await new Promise<void>((resolveWait) => setTimeout(resolveWait, 100));
      }
      if (!groupIsAlive() || child.pid === undefined) return;
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        return;
      }
      const killDeadline = Date.now() + 1_000;
      while (groupIsAlive() && Date.now() < killDeadline) {
        await new Promise<void>((resolveWait) => setTimeout(resolveWait, 100));
      }
    };
    const terminateGroup = async (): Promise<void> => {
      if (!groupIsAlive() || child.pid === undefined) return;
      try {
        process.kill(-child.pid, 'SIGTERM');
      } catch {
        return;
      }
      await awaitGroupShutdown();
    };
    const restore = (): void => {
      process.off('SIGINT', onSigint);
      process.off('SIGTERM', onSigterm);
      if (escalation !== null) clearTimeout(escalation);
    };
    process.on('SIGINT', onSigint);
    process.on('SIGTERM', onSigterm);

    child.stdout.on('data', (chunk: Buffer) => {
      stdout = appendTail(stdout, chunk, tailBytes);
      if (options.stream) process.stdout.write(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr = appendTail(stderr, chunk, tailBytes);
      if (options.stream) process.stderr.write(chunk);
    });
    child.once('error', (error) => {
      if (settled) return;
      settled = true;
      void (async () => {
        await terminateGroup();
        restore();
        reject(error);
      })();
    });
    child.once('close', (code, signal) => {
      if (settled) return;
      settled = true;
      const result = { stdout: stdout.toString('utf8'), stderr: stderr.toString('utf8') };
      void (async () => {
        await terminateGroup();
        restore();
        if (code === 0 && relayedSignal === null) {
          resolvePromise(result);
          return;
        }
        const termination = relayedSignal ?? signal;
        const detail = result.stderr.trim();
        reject(new Error(
          `${command} exited ${code ?? `on signal ${termination ?? 'unknown'}`}${detail ? `: ${detail}` : ''}`,
        ));
      })();
    });
  });
}

/**
 * Turn an arbitrary task id into a bounded portable filename. The readable
 * prefix is never relied upon for identity; the full SHA-256 digest prevents
 * normalization, truncation, and punctuation replacement from colliding.
 */
export function artifactKey(taskId: string): string {
  const prefix = taskId
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
    .replace(/-+$/g, '') || 'task';
  const digest = createHash('sha256').update(taskId, 'utf8').digest('hex');
  return `${prefix}-${digest}`;
}

/**
 * Resolve a relative path beneath `root` and reject lexical escapes. Absolute
 * and Windows-style path inputs are rejected even on POSIX so the same caller
 * input cannot become unsafe on another host.
 */
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

/**
 * Resolve one regular-file artifact beneath a real root while rejecting every
 * symlink in its ancestor chain. This closes the gap between lexical path
 * containment and the filesystem target that will actually be read.
 */
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
  const fromBase = relative(base, candidate);
  const components = fromBase === '' ? [] : fromBase.split(sep);
  if (components.length === 0) throw new Error(`${description} must name a file beneath ${base}`);
  let current = base;
  for (let index = 0; index < components.length; index += 1) {
    current = join(current, components[index]!);
    const info = lstatSync(current);
    if (info.isSymbolicLink()) throw new Error(`${description} must not have symlinked ancestors: ${current}`);
    if (index < components.length - 1 && !info.isDirectory()) {
      throw new Error(`${description} ancestor must be a directory: ${current}`);
    }
    if (index === components.length - 1 && !info.isFile()) {
      throw new Error(`${description} must be a regular file: ${current}`);
    }
  }
  return candidate;
}

function validatePin(pin: string): void {
  if (!GIT_OBJECT_ID_RE.test(pin)) {
    throw new Error(`git pin must be a full 40- or 64-character object id, got '${pin}'`);
  }
}

function validateArg(name: string, value: string): void {
  if (value.length === 0 || value.includes('\0')) throw new Error(`${name} must be non-empty and contain no NUL bytes`);
}

/** Plan a blob-filtered clone followed by a fetch and detached pinned checkout. */
export function planPinnedClone(repository: string, pin: string, directory: string): Argv[] {
  validateArg('repository', repository);
  validateArg('checkout directory', directory);
  validatePin(pin);
  return [
    ['git', 'clone', '--filter=blob:none', '--no-checkout', '--no-tags', '--', repository, directory],
    ...planPinnedUpdate(directory, pin),
  ];
}

/** Plan an exact fetch and detached checkout for an existing clone. */
export function planPinnedUpdate(directory: string, pin: string): Argv[] {
  validateArg('checkout directory', directory);
  validatePin(pin);
  return [
    ['git', '-C', directory, 'fetch', '--filter=blob:none', '--depth=1', '--no-tags', 'origin', pin],
    ['git', '-C', directory, 'checkout', '--detach', pin],
  ];
}

/** Build the complete argv-only plan for a new or existing pinned checkout. */
export function planPinnedCheckout(options: PinnedCheckoutPlanOptions): Argv[] {
  return options.existing
    ? planPinnedUpdate(options.directory, options.pin)
    : planPinnedClone(options.repository, options.pin, options.directory);
}
