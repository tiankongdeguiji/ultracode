/**
 * Benchmark-native process supervision built on the engine's process-group
 * helper. Launches are argv-only, environments are allowlisted, output drains
 * are bounded after direct-child exit, and fatal cleanup shares one registry.
 */
import { setTimeout as sleep } from 'node:timers/promises';
import { Writable, type Readable } from 'node:stream';
import { spawnAgentProcess, type SpawnedAgent } from '../../../src/exec/spawn.js';
import { chainedTimeout } from '../../../src/exec/timers.js';
import {
  readProcessIdentity,
  type ProcessInspectionOptions,
} from '../../../src/exec/procinfo.js';

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

interface ActiveBenchProcess {
  spawned: SpawnedAgent;
  recordCompleteCleanup(): void;
}

const ACTIVE_BENCH_PROCESSES = new Set<ActiveBenchProcess>();
const DEFAULT_TAIL_BYTES = 64 * 1_024;
const DEFAULT_DRAIN_MS = 1_000;
const DEFAULT_TERMINATION_GRACE_MS = 1_000;

export interface BenchProcessOptions {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  inheritedEnvironment?: NodeJS.ProcessEnv;
  allowEnvironment?: readonly string[];
  stdinData?: string;
  stream?: boolean;
  stdout?: NodeJS.WritableStream;
  stderr?: NodeJS.WritableStream;
  tailBytes?: number;
  timeoutMs?: number | null;
  drainMs?: number;
  terminationGraceMs?: number;
  /** Explicit platform/process seam for deterministic supervision tests. */
  processInspection?: ProcessInspectionOptions;
  /** Stable run/cache scope attached to descendant lifecycle tokens. */
  workerScope?: string;
  /** Synchronous durable-record hook invoked before the child can start. */
  onLifecycleToken?: (token: string) => void;
  /** Enrich the pre-spawn token with the direct-child process identity. */
  onLifecycleStarted?: (token: string, pid: number | null, processStartIdentity: string | null) => void;
  /** Durable-record hook invoked after escaped-descendant cleanup settles. */
  onLifecycleRecovered?: (token: string, recovery: 'complete' | 'failed') => void;
  /**
   * Synchronous stdout observer for protocol enforcement. Calling terminate
   * stops the owned process group; the command then rejects normally.
   */
  observeStdout?: (chunk: Buffer, terminate: () => void) => void;
}

export interface BenchProcessResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  signal: NodeJS.Signals | null;
  elapsedMs: number;
}

export type BenchProcessFailureKind = 'timeout' | 'exit' | 'signal' | 'descendant-cleanup' | 'output-forwarding';

/** Build a minimal child environment without forwarding ambient credentials. */
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

/** Remove terminal controls except tabs/newlines and redact common credential assignments. */
export function sanitizeDiagnostic(value: string): string {
  return value
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '?')
    .replace(/((?:CODEX_AUTH_JSON_PATH|PIP_CONFIG_FILE|FEATUREBENCH_CREDENTIAL_BROKER_URL)\s*[=:]\s*)\S+/gi, '$1[REDACTED]')
    .replace(/([A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD)[A-Z0-9_]*\s*[=:]\s*)\S+/gi, '$1[REDACTED]')
    .replace(/(?:^|(?<=[\s'"=]))(?:\/[A-Za-z0-9._-]+)+\/auth\.json\b/g, '[REDACTED_AUTH_PATH]')
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^/@\s]+@/gi, '$1[REDACTED]@');
}

export class BenchProcessError extends Error {
  constructor(
    message: string,
    readonly result: Omit<BenchProcessResult, 'exitCode'> & { exitCode: number | null },
    readonly failureKind: BenchProcessFailureKind = 'exit',
  ) {
    super(message);
    this.name = 'BenchProcessError';
  }
}

interface StreamEndWait {
  promise: Promise<void>;
  cleanup(): void;
}

/** Retain an owned byte-exact tail with amortized-linear ingestion. */
export class ByteTailBuffer {
  private chunks: Buffer[] = [];
  private headIndex = 0;
  private headOffset = 0;
  private length = 0;
  private materialized: Buffer | null = Buffer.alloc(0);

  constructor(
    private readonly maximumBytes: number,
    private readonly observeCopiedBytes?: (bytes: number) => void,
  ) {}

  push(chunk: Buffer): void {
    if (chunk.length === 0) return;
    this.materialized = null;
    if (this.maximumBytes === 0) {
      this.clear();
      return;
    }
    if (chunk.length >= this.maximumBytes) {
      const tail = chunk.subarray(chunk.length - this.maximumBytes);
      this.observeCopiedBytes?.(tail.length);
      this.chunks = [Buffer.from(tail)];
      this.headIndex = 0;
      this.headOffset = 0;
      this.length = tail.length;
      return;
    }

    this.observeCopiedBytes?.(chunk.length);
    this.chunks.push(Buffer.from(chunk));
    this.length += chunk.length;
    this.trimHead(this.length - this.maximumBytes);
  }

  get text(): string {
    return this.bytes().toString('utf8');
  }

  private bytes(): Buffer {
    if (this.materialized !== null) return this.materialized;
    const bytes = Buffer.allocUnsafe(this.length);
    let targetOffset = 0;
    for (let index = this.headIndex; index < this.chunks.length; index++) {
      const chunk = this.chunks[index]!;
      const sourceOffset = index === this.headIndex ? this.headOffset : 0;
      targetOffset += chunk.copy(bytes, targetOffset, sourceOffset);
    }
    this.observeCopiedBytes?.(this.length);
    this.materialized = bytes;
    return bytes;
  }

  private clear(): void {
    this.chunks = [];
    this.headIndex = 0;
    this.headOffset = 0;
    this.length = 0;
  }

  private trimHead(bytes: number): void {
    if (bytes <= 0) return;
    this.length -= bytes;
    let remaining = bytes;
    while (remaining > 0) {
      const head = this.chunks[this.headIndex]!;
      const available = head.length - this.headOffset;
      if (remaining < available) {
        this.headOffset += remaining;
        remaining = 0;
      } else {
        remaining -= available;
        this.headIndex++;
        this.headOffset = 0;
      }
    }
    if (this.headIndex > 0 && this.headIndex * 2 >= this.chunks.length) {
      this.chunks = this.chunks.slice(this.headIndex);
      this.headIndex = 0;
    }
  }
}

class CallerTargetAdapter extends Writable {
  readonly completion: Promise<void>;
  private targetListenerAttached = true;

  constructor(private readonly target: Writable) {
    super();
    this.target.on('error', this.onTargetError);
    this.completion = new Promise<void>((resolvePromise, rejectPromise) => {
      const cleanup = (): void => {
        this.removeListener('finish', onFinish);
        this.removeListener('error', onError);
      };
      const onFinish = (): void => {
        cleanup();
        resolvePromise();
      };
      const onError = (error: Error): void => {
        cleanup();
        rejectPromise(error);
      };
      this.once('finish', onFinish);
      this.once('error', onError);
    });
    void this.completion.catch(() => {});
  }

  override _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    try {
      this.target.write(chunk, callback);
    } catch (error) {
      callback(error instanceof Error ? error : new Error(String(error)));
    }
  }

  override _final(callback: (error?: Error | null) => void): void {
    this.detachTargetListener();
    callback();
  }

  override _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
    this.detachTargetListener();
    callback(error);
  }

  detach(): void {
    this.detachTargetListener();
    if (!this.destroyed) this.destroy();
  }

  private readonly onTargetError = (error: Error): void => {
    this.destroy(error);
  };

  private detachTargetListener(): void {
    if (!this.targetListenerAttached) return;
    this.target.removeListener('error', this.onTargetError);
    this.targetListenerAttached = false;
  }
}

function waitForStreamEnd(stream: Readable | null): StreamEndWait {
  if (stream === null || stream.readableEnded || stream.destroyed) {
    return { promise: Promise.resolve(), cleanup: () => {} };
  }
  let resolveWait!: () => void;
  const cleanup = (): void => {
    stream.removeListener('end', done);
    stream.removeListener('close', done);
  };
  const done = (): void => {
    cleanup();
    resolveWait();
  };
  const promise = new Promise<void>((resolvePromise) => {
    resolveWait = resolvePromise;
  });
  stream.once('end', done);
  stream.once('close', done);
  return { promise, cleanup };
}

async function waitForOutputDrain(
  stdout: Readable | null,
  stderr: Readable | null,
  forwarders: readonly CallerTargetAdapter[],
  drainMs: number,
): Promise<boolean> {
  const stdoutEnd = waitForStreamEnd(stdout);
  const stderrEnd = waitForStreamEnd(stderr);
  let drainTimeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      Promise.all([
        stdoutEnd.promise,
        stderrEnd.promise,
        ...forwarders.map((forwarder) => forwarder.completion),
      ]).then(() => true),
      new Promise<boolean>((resolvePromise) => {
        drainTimeout = setTimeout(() => resolvePromise(false), drainMs);
      }),
    ]);
  } finally {
    if (drainTimeout !== undefined) clearTimeout(drainTimeout);
    stdoutEnd.cleanup();
    stderrEnd.cleanup();
  }
}

function detachChildReadable(
  source: Readable | null,
  forwarder: CallerTargetAdapter | null,
  handler: (chunk: Buffer) => void,
): void {
  if (source === null) {
    forwarder?.detach();
    return;
  }
  try {
    if (forwarder !== null) source.unpipe(forwarder);
  } finally {
    source.removeListener('data', handler);
    forwarder?.detach();
    if (!source.readableEnded && !source.destroyed) source.destroy();
  }
}

/** Run one native command and fully retire its owned process group. */
export async function runBenchProcess(
  command: string,
  argv: readonly string[],
  options: BenchProcessOptions,
): Promise<BenchProcessResult> {
  if (!command || command.includes('\0') || argv.some((argument) => argument.includes('\0'))) {
    throw new Error('benchmark process argv must contain non-empty NUL-free strings');
  }
  const tailBytes = options.tailBytes ?? DEFAULT_TAIL_BYTES;
  if (!Number.isSafeInteger(tailBytes) || tailBytes < 0) throw new Error('tailBytes must be a non-negative integer');
  if (options.timeoutMs !== undefined && options.timeoutMs !== null
    && (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs <= 0)) {
    throw new Error('timeoutMs must be positive');
  }
  const drainMs = options.drainMs ?? DEFAULT_DRAIN_MS;
  if (!Number.isSafeInteger(drainMs) || drainMs < 0) {
    throw new Error('drainMs must be a non-negative integer');
  }
  const terminationGraceMs = options.terminationGraceMs ?? DEFAULT_TERMINATION_GRACE_MS;
  if (!Number.isSafeInteger(terminationGraceMs) || terminationGraceMs < 0) {
    throw new Error('terminationGraceMs must be a non-negative integer');
  }
  const base = allowlistedEnvironment(options.inheritedEnvironment ?? process.env, options.allowEnvironment);
  const env = { ...base, ...options.env };
  const startedAt = performance.now();
  const spawned = spawnAgentProcess(command, [...argv], {
    cwd: options.cwd,
    env,
    stdinData: options.stdinData,
    workerScope: options.workerScope ?? options.cwd,
    onWorkerToken: options.onLifecycleToken,
    processInspection: options.processInspection,
  });
  let cleanupRecorded = false;
  const activeProcess: ActiveBenchProcess = {
    spawned,
    recordCompleteCleanup: () => {
      if (cleanupRecorded) return;
      options.onLifecycleRecovered?.(spawned.workerToken, 'complete');
      cleanupRecorded = true;
    },
  };
  const retireCompleteCleanup = (): void => {
    activeProcess.recordCompleteCleanup();
    ACTIVE_BENCH_PROCESSES.delete(activeProcess);
  };
  ACTIVE_BENCH_PROCESSES.add(activeProcess);
  try {
    const childPid = spawned.child.pid ?? null;
    const childIdentity = childPid === null
      ? null
      : readProcessIdentity(childPid, options.processInspection)?.starttime ?? null;
    options.onLifecycleStarted?.(spawned.workerToken, childPid, childIdentity);
  } catch (error) {
    spawned.killTree('SIGTERM');
    let remaining = 1;
    try {
      remaining = await spawned.cleanupEscaped(
        terminationGraceMs,
      );
      if (remaining === 0) retireCompleteCleanup();
    } catch {
      // The pending durable token remains available to resume recovery.
    }
    throw error;
  }
  const stdout = new ByteTailBuffer(tailBytes);
  const stderr = new ByteTailBuffer(tailBytes);
  const stdoutTarget = options.stdout ?? process.stdout;
  const stderrTarget = options.stderr ?? process.stderr;
  const childStdout = spawned.child.stdout;
  const childStderr = spawned.child.stderr;
  const stdoutObserver = { failure: null as Error | null };
  const onStdoutData = (chunk: Buffer): void => {
    stdout.push(chunk);
    try {
      options.observeStdout?.(chunk, () => spawned.killTree('SIGTERM'));
    } catch (error) {
      stdoutObserver.failure = error instanceof Error ? error : new Error(String(error));
      spawned.killTree('SIGTERM');
    }
  };
  const onStderrData = (chunk: Buffer): void => {
    stderr.push(chunk);
  };
  const stdoutForwarder = options.stream && childStdout !== null
    ? new CallerTargetAdapter(stdoutTarget as Writable)
    : null;
  const stderrForwarder = options.stream && childStderr !== null
    ? new CallerTargetAdapter(stderrTarget as Writable)
    : null;

  let timeout: ReturnType<typeof chainedTimeout> | undefined;
  let timeoutEscalation: ReturnType<typeof chainedTimeout> | undefined;
  let timedOut = false;
  let cleanupRemaining: number | null = null;
  let outputDrainFailure: Error | null = null;
  try {
    childStdout?.on('data', onStdoutData);
    childStderr?.on('data', onStderrData);
    if (stdoutForwarder !== null) childStdout?.pipe(stdoutForwarder);
    if (stderrForwarder !== null) childStderr?.pipe(stderrForwarder);
    if (options.timeoutMs !== undefined && options.timeoutMs !== null) {
      timeout = chainedTimeout(options.timeoutMs, () => {
        timedOut = true;
        spawned.killTree('SIGTERM');
        timeoutEscalation = chainedTimeout(terminationGraceMs, () => spawned.killTree('SIGKILL'));
      });
    }
    const termination = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolvePromise, reject) => {
      const cleanup = (): void => {
        spawned.child.removeListener('error', onError);
        spawned.child.removeListener('exit', onExit);
      };
      const onError = (error: Error): void => {
        cleanup();
        reject(error);
      };
      const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
        cleanup();
        resolvePromise({ code, signal });
      };
      spawned.child.once('error', onError);
      spawned.child.once('exit', onExit);
    });
    timeout?.clear();
    timeoutEscalation?.clear();
    try {
      const drained = await waitForOutputDrain(
        childStdout,
        childStderr,
        [stdoutForwarder, stderrForwarder].filter((value): value is CallerTargetAdapter => value !== null),
        drainMs,
      );
      if (!drained && !timedOut) outputDrainFailure = new Error(`output did not drain within ${drainMs}ms`);
    } catch (error) {
      outputDrainFailure = error instanceof Error ? error : new Error(String(error));
    }
    cleanupRemaining = await spawned.cleanupEscaped(
      terminationGraceMs,
    );
    if (cleanupRemaining === 0) retireCompleteCleanup();
    const elapsedMs = performance.now() - startedAt;
    const output = {
      stdout: stdout.text,
      stderr: stderr.text,
      exitCode: termination.code ?? -1,
      signal: termination.signal,
      elapsedMs,
    };
    if (cleanupRemaining !== 0) {
      throw new BenchProcessError(
        `${command} descendant cleanup failed`,
        { ...output, exitCode: termination.code },
        'descendant-cleanup',
      );
    }
    if (outputDrainFailure !== null) {
      throw new BenchProcessError(
        `${command} output forwarding failed: ${sanitizeDiagnostic(outputDrainFailure.message)}`,
        { ...output, exitCode: termination.code },
        'output-forwarding',
      );
    }
    if (stdoutObserver.failure !== null) {
      throw new BenchProcessError(
        `${command} stdout observer failed: ${sanitizeDiagnostic(stdoutObserver.failure.message)}`,
        { ...output, exitCode: termination.code },
        'output-forwarding',
      );
    }
    if (termination.code === 0 && !timedOut) return output;
    const reason = timedOut
      ? 'timed out'
      : termination.code === null
        ? `exited on signal ${termination.signal ?? 'unknown'}`
        : `exited ${termination.code}`;
    const diagnostic = sanitizeDiagnostic(stderr.text.trim());
    throw new BenchProcessError(
      `${command} ${reason}${diagnostic ? `: ${diagnostic}` : ''}`,
      { ...output, exitCode: termination.code },
      timedOut ? 'timeout' : termination.code === null ? 'signal' : 'exit',
    );
  } finally {
    timeout?.clear();
    timeoutEscalation?.clear();
    if (cleanupRemaining !== 0) {
      spawned.killTree('SIGKILL');
      try {
        cleanupRemaining = await spawned.cleanupEscaped(
          terminationGraceMs,
        );
      } catch {
        cleanupRemaining = 1;
      }
      if (cleanupRemaining === 0) retireCompleteCleanup();
    }
    try {
      detachChildReadable(childStdout, stdoutForwarder, onStdoutData);
    } finally {
      detachChildReadable(childStderr, stderrForwarder, onStderrData);
    }
  }
}

/** Retire every trusted in-memory process or fail so fatal cleanup can retry. */
export async function cleanupActiveBenchProcesses(graceMs = DEFAULT_TERMINATION_GRACE_MS): Promise<number> {
  const active = [...ACTIVE_BENCH_PROCESSES];
  if (active.length === 0) return 0;
  active.forEach(({ spawned }) => spawned.killTree('SIGTERM'));
  await sleep(graceMs);
  await Promise.all(active.map(async (entry) => {
    const { spawned } = entry;
    spawned.killTree('SIGKILL');
    try {
      if (await spawned.cleanupEscaped(graceMs) === 0) {
        entry.recordCompleteCleanup();
        ACTIVE_BENCH_PROCESSES.delete(entry);
      }
    } catch {
      // Keep the entry actionable for a later fatal-cleanup retry.
    }
  }));
  if (active.some((entry) => ACTIVE_BENCH_PROCESSES.has(entry))) {
    throw new Error('active benchmark process cleanup did not reach verified stable absence');
  }
  return active.length;
}
