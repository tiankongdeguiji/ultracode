/** Durable, revisioned execution history for one immutable benchmark run. */
import { existsSync } from 'node:fs';
import { z } from 'zod';
import {
  findWorkerProcessesForTokens,
  signalTrackedWorkerProcesses,
} from '../../../src/exec/procinfo.js';
import { FAILURE_CODES, type BenchPathRoots, type BenchSuite, type FailureCode } from './contracts.js';
import type { BenchLockHandle } from './locks.js';
import { sha256Schema } from './provenance.js';
import {
  readPrivateJson,
  runDir,
  runLeaseFile,
  runStateFile,
  validateRelativeArtifactPath,
  validateRunId,
  validateTaskId,
  writePrivateJsonAtomic,
} from './paths.js';

const commandSchema = z.enum(['fetch', 'prep', 'run', 'eval', 'report', 'status', 'clean']);
const failureSchema = z.enum(FAILURE_CODES);
const timestampSchema = z.string().datetime({ offset: true });
const relativePathSchema = z.string().transform(validateRelativeArtifactPath);

export const invocationRecordSchema = z.strictObject({
  invocationId: z.string().uuid(),
  command: commandSchema,
  startedAt: timestampSchema,
  endedAt: timestampSchema.nullable(),
  activeElapsedMs: z.number().finite().nonnegative().nullable(),
  exitCode: z.number().int().nullable(),
  signal: z.string().min(1).nullable(),
  lifecycleProcesses: z.array(z.strictObject({
    token: z.string().regex(/^[a-f0-9]{32}$/),
    pid: z.number().int().positive().nullable(),
    processStartIdentity: z.string().min(1).nullable(),
    recovery: z.enum(['pending', 'complete', 'failed']),
  })),
  failure: failureSchema.nullable(),
  nativeInvocation: relativePathSchema.nullable(),
});

export const attemptRecordSchema = z.strictObject({
  attemptId: z.string().uuid(),
  invocationId: z.string().uuid(),
  taskId: z.string().transform(validateTaskId),
  arm: z.enum(['a', 'b']),
  ordinal: z.number().int().positive(),
  phase: z.enum(['prep', 'inference', 'session', 'verifier', 'detached-wait', 'cleanup']),
  startedAt: timestampSchema,
  endedAt: timestampSchema.nullable(),
  elapsedMs: z.number().finite().nonnegative().nullable(),
  nativePath: relativePathSchema.nullable(),
  exitCode: z.number().int().nullable(),
  signal: z.string().min(1).nullable(),
  status: z.enum(['running', 'succeeded', 'failed', 'interrupted']),
  failures: z.array(failureSchema),
  annotations: z.array(z.string().regex(/^[a-z][a-z0-9-]{0,127}$/)),
});

const rawRunStateSchema = z.strictObject({
  schemaVersion: z.literal(2),
  kind: z.literal('ultracode-benchmark-run-state'),
  suite: z.enum(['swebench-pro', 'swe-marathon', 'featurebench']),
  runId: z.string().transform(validateRunId),
  manifestSha256: sha256Schema,
  revision: z.number().int().nonnegative(),
  invocations: z.array(invocationRecordSchema),
  attempts: z.array(attemptRecordSchema),
});

export const benchRunStateSchema = rawRunStateSchema.superRefine((state, context) => {
  const invocations = new Set<string>();
  for (let index = 0; index < state.invocations.length; index += 1) {
    const invocation = state.invocations[index]!;
    if (invocations.has(invocation.invocationId)) {
      context.addIssue({ code: 'custom', path: ['invocations', index, 'invocationId'], message: 'duplicate invocation id' });
    }
    invocations.add(invocation.invocationId);
    const ended = invocation.endedAt !== null;
    if (ended !== (invocation.activeElapsedMs !== null)) {
      context.addIssue({ code: 'custom', path: ['invocations', index], message: 'ended invocation must have elapsed time' });
    }
    const tokens = invocation.lifecycleProcesses.map((process) => process.token);
    if (new Set(tokens).size !== tokens.length) {
      context.addIssue({ code: 'custom', path: ['invocations', index, 'lifecycleProcesses'], message: 'duplicate lifecycle token' });
    }
    if (ended && invocation.lifecycleProcesses.some((process) => process.recovery !== 'complete')) {
      context.addIssue({ code: 'custom', path: ['invocations', index, 'lifecycleProcesses'], message: 'ended invocation retains unsettled descendants' });
    }
  }
  const attempts = new Set<string>();
  for (let index = 0; index < state.attempts.length; index += 1) {
    const attempt = state.attempts[index]!;
    if (attempts.has(attempt.attemptId)) {
      context.addIssue({ code: 'custom', path: ['attempts', index, 'attemptId'], message: 'duplicate attempt id' });
    }
    attempts.add(attempt.attemptId);
    if (!invocations.has(attempt.invocationId)) {
      context.addIssue({ code: 'custom', path: ['attempts', index, 'invocationId'], message: 'attempt references unknown invocation' });
    }
    const running = attempt.status === 'running';
    if (running !== (attempt.endedAt === null && attempt.elapsedMs === null)) {
      context.addIssue({ code: 'custom', path: ['attempts', index], message: 'attempt timing does not match status' });
    }
  }
});

export type BenchRunState = z.infer<typeof benchRunStateSchema>;
export type InvocationRecord = z.infer<typeof invocationRecordSchema>;
export type AttemptRecord = z.infer<typeof attemptRecordSchema>;

export function createBenchRunState(
  suite: BenchSuite,
  runId: string,
  manifestSha256: string,
): BenchRunState {
  return benchRunStateSchema.parse({
    schemaVersion: 2,
    kind: 'ultracode-benchmark-run-state',
    suite,
    runId,
    manifestSha256,
    revision: 0,
    invocations: [],
    attempts: [],
  });
}

export function parseBenchRunState(value: unknown): BenchRunState {
  return benchRunStateSchema.parse(value);
}

/** Serialized in-process mutation plus disk revision checks under the lifecycle lease. */
export class BenchRunStateStore {
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly roots: BenchPathRoots,
    private readonly suite: BenchSuite,
    private readonly runId: string,
    private readonly manifestSha256: string,
    private readonly lease: BenchLockHandle,
  ) {
    if (lease.path !== runLeaseFile(roots, suite, runId)) {
      throw new Error('run-state store requires the exact run lifecycle lease');
    }
  }

  load(): BenchRunState {
    this.lease.assertHeld();
    const directory = runDir(this.roots, this.suite, this.runId);
    const state = parseBenchRunState(readPrivateJson(
      directory,
      runStateFile(this.roots, this.suite, this.runId),
    ));
    this.assertIdentity(state);
    return state;
  }

  initialize(): BenchRunState {
    this.lease.assertHeld();
    const path = runStateFile(this.roots, this.suite, this.runId);
    if (existsSync(path)) throw new Error('run state already exists');
    const state = createBenchRunState(this.suite, this.runId, this.manifestSha256);
    writePrivateJsonAtomic(runDir(this.roots, this.suite, this.runId), path, state);
    return state;
  }

  async update(
    expectedRevision: number,
    mutate: (state: BenchRunState) => Omit<BenchRunState, 'revision'> | BenchRunState,
  ): Promise<BenchRunState> {
    let result: BenchRunState | undefined;
    let failure: unknown;
    this.queue = this.queue.then(() => {
      try {
        this.lease.assertHeld();
        const current = this.load();
        if (current.revision !== expectedRevision) {
          throw new Error(`run-state revision mismatch: expected ${expectedRevision}, found ${current.revision}`);
        }
        const changed = mutate(current);
        result = parseBenchRunState({ ...changed, revision: current.revision + 1 });
        this.assertIdentity(result);
        const directory = runDir(this.roots, this.suite, this.runId);
        writePrivateJsonAtomic(directory, runStateFile(this.roots, this.suite, this.runId), result);
      } catch (error) {
        failure = error;
      }
    });
    await this.queue;
    if (failure !== undefined) throw failure;
    return result!;
  }

  /** Serialize against the latest disk revision while the exact lease is held. */
  async updateCurrent(
    mutate: (state: BenchRunState) => Omit<BenchRunState, 'revision'> | BenchRunState,
  ): Promise<BenchRunState> {
    let result: BenchRunState | undefined;
    let failure: unknown;
    this.queue = this.queue.then(() => {
      try {
        this.lease.assertHeld();
        const current = this.load();
        result = parseBenchRunState({ ...mutate(current), revision: current.revision + 1 });
        this.assertIdentity(result);
        writePrivateJsonAtomic(
          runDir(this.roots, this.suite, this.runId),
          runStateFile(this.roots, this.suite, this.runId),
          result,
        );
      } catch (error) {
        failure = error;
      }
    });
    await this.queue;
    if (failure !== undefined) throw failure;
    return result!;
  }

  /** Persist a lifecycle transition synchronously before a native child can start. */
  updateCurrentSync(
    mutate: (state: BenchRunState) => Omit<BenchRunState, 'revision'> | BenchRunState,
  ): BenchRunState {
    this.lease.assertHeld();
    const current = this.load();
    const result = parseBenchRunState({ ...mutate(current), revision: current.revision + 1 });
    this.assertIdentity(result);
    writePrivateJsonAtomic(
      runDir(this.roots, this.suite, this.runId),
      runStateFile(this.roots, this.suite, this.runId),
      result,
    );
    return result;
  }

  /** Add one exact token before spawn and keep its recovery outcome durable. */
  lifecycleHooks(invocationId: string): {
    onLifecycleToken(token: string): void;
    onLifecycleStarted(token: string, pid: number | null, processStartIdentity: string | null): void;
    onLifecycleRecovered(token: string, recovery: 'complete' | 'failed'): void;
  } {
    return {
      onLifecycleToken: (token) => {
        this.updateCurrentSync((state) => {
          let matchedInvocation = false;
          const invocations = state.invocations.map((invocation) => {
            if (invocation.invocationId !== invocationId) return invocation;
            matchedInvocation = true;
            if (invocation.endedAt !== null) throw new Error(`invocation ${invocationId} has already ended`);
            if (invocation.lifecycleProcesses.some((process) => process.token === token)) {
              throw new Error(`duplicate lifecycle token for invocation ${invocationId}`);
            }
            return {
              ...invocation,
              lifecycleProcesses: [...invocation.lifecycleProcesses, {
                token,
                pid: null,
                processStartIdentity: null,
                recovery: 'pending' as const,
              }],
            };
          });
          if (!matchedInvocation) throw new Error(`unknown lifecycle invocation ${invocationId}`);
          return { ...state, invocations };
        });
      },
      onLifecycleStarted: (token, pid, processStartIdentity) => {
        this.updateCurrentSync((state) => {
          let matchedInvocation = false;
          let matchedToken = false;
          const invocations = state.invocations.map((invocation) => {
            if (invocation.invocationId !== invocationId) return invocation;
            matchedInvocation = true;
            return {
              ...invocation,
              lifecycleProcesses: invocation.lifecycleProcesses.map((process) => {
                if (process.token !== token) return process;
                matchedToken = true;
                if (process.recovery !== 'pending') throw new Error(`lifecycle token ${token} has already settled`);
                return { ...process, pid, processStartIdentity };
              }),
            };
          });
          if (!matchedInvocation) throw new Error(`unknown lifecycle invocation ${invocationId}`);
          if (!matchedToken) throw new Error(`unknown lifecycle token ${token}`);
          return { ...state, invocations };
        });
      },
      onLifecycleRecovered: (token, recovery) => {
        this.updateCurrentSync((state) => {
          let matchedInvocation = false;
          let matchedToken = false;
          const invocations = state.invocations.map((invocation) => {
            if (invocation.invocationId !== invocationId) return invocation;
            matchedInvocation = true;
            return {
              ...invocation,
              lifecycleProcesses: invocation.lifecycleProcesses.map((process) => {
                if (process.token !== token) return process;
                matchedToken = true;
                if (process.recovery !== 'pending') throw new Error(`lifecycle token ${token} has already settled`);
                return { ...process, recovery };
              }),
            };
          });
          if (!matchedInvocation) throw new Error(`unknown lifecycle invocation ${invocationId}`);
          if (!matchedToken) throw new Error(`unknown lifecycle token ${token}`);
          return { ...state, invocations };
        });
      },
    };
  }

  /** Recover token-bearing descendants from an interrupted prior invocation. */
  async recoverPendingLifecycleProcesses(workerScope: string, graceMs = 1_000): Promise<number> {
    this.lease.assertHeld();
    const state = this.load();
    const recoverable = state.invocations.flatMap((invocation) => invocation.lifecycleProcesses)
      .filter((process) => process.recovery !== 'complete');
    if (recoverable.length === 0) return 0;
    const tokens = recoverable.map((process) => process.token);
    const pendingByToken = new Map(recoverable.map((entry) => [entry.token, entry]));
    const unverifiableTokens = new Set(recoverable.flatMap((entry) => {
      if (process.platform === 'linux') return [];
      if (process.platform === 'darwin' && entry.pid !== null && entry.processStartIdentity !== null) return [];
      return [entry.token];
    }));
    const candidatePids = recoverable.flatMap((entry) =>
      entry.pid === null || unverifiableTokens.has(entry.token) ? [] : [entry.pid]);
    const findRecoverableProcesses = () => findWorkerProcessesForTokens(
      tokens,
      workerScope,
      process.platform === 'darwin' ? candidatePids : undefined,
    ).filter((entry) => {
      if (process.platform !== 'darwin') return true;
      const recorded = pendingByToken.get(entry.token);
      return recorded?.pid === entry.pid && recorded.processStartIdentity === entry.starttime;
    });
    const deadline = Date.now() + Math.max(0, graceMs);
    let signal: NodeJS.Signals = 'SIGTERM';
    let emptyPasses = 0;
    for (;;) {
      const found = findRecoverableProcesses();
      emptyPasses = found.length === 0 ? emptyPasses + 1 : 0;
      signalTrackedWorkerProcesses(found, signal);
      if (emptyPasses >= 2) break;
      if (Date.now() >= deadline) {
        if (signal === 'SIGKILL') break;
        signal = 'SIGKILL';
      }
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
    }
    const remaining = findRecoverableProcesses();
    const liveTokens = new Set([...unverifiableTokens, ...remaining.map((entry) => entry.token)]);
    this.updateCurrentSync((current) => ({
      ...current,
      invocations: current.invocations.map((invocation) => {
        const lifecycleProcesses = invocation.lifecycleProcesses.map((process) =>
          process.recovery === 'complete' ? process : {
            ...process,
            recovery: liveTokens.has(process.token) ? 'failed' as const : 'complete' as const,
          });
        return { ...invocation, lifecycleProcesses };
      }),
    }));
    if (liveTokens.size > 0) throw new Error('interrupted benchmark descendants could not be recovered safely');
    return recoverable.length;
  }

  /** Close prior open invocations only after suite-owned external resources are retired. */
  async closeInterruptedInvocations(
    failure: FailureCode = 'driver-interrupted',
    now = new Date(),
  ): Promise<number> {
    const state = this.load();
    const open = state.invocations.filter((invocation) => invocation.endedAt === null);
    if (open.length === 0) return 0;
    if (open.some((invocation) => invocation.lifecycleProcesses.some((entry) => entry.recovery !== 'complete'))) {
      throw new Error('cannot close an interrupted invocation with unsettled descendants');
    }
    await this.updateCurrent((current) => ({
      ...current,
      invocations: current.invocations.map((invocation) => invocation.endedAt !== null ? invocation : {
        ...invocation,
        endedAt: now.toISOString(),
        activeElapsedMs: Math.max(0, now.getTime() - Date.parse(invocation.startedAt)),
        exitCode: 1,
        signal: 'interrupted',
        failure,
      }),
    }));
    return open.length;
  }

  private assertIdentity(state: BenchRunState): void {
    if (
      state.suite !== this.suite
      || state.runId !== validateRunId(this.runId)
      || state.manifestSha256 !== this.manifestSha256
    ) {
      throw new Error('run-state identity does not match its immutable manifest');
    }
  }
}
