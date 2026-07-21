/** Durable, revisioned execution history for one immutable benchmark run. */
import { existsSync } from 'node:fs';
import { z } from 'zod';
import {
  darwinWorkerSignalingInspection,
  discoverWorkerProcessesForTokens,
  MAX_DARWIN_CANDIDATE_PROCESSES,
  readProcessIdentitySnapshot,
  signal0Status,
  signalTrackedWorkerProcesses,
  type ProcessInspectionOptions,
  type TrackedProcess,
  type TrackedWorkerProcess,
} from '../../../src/exec/procinfo.js';
import { FAILURE_CODES, type BenchPathRoots, type BenchSuite, type FailureCode } from './contracts.js';
import type { BenchLockHandle } from './locks.js';
import { sha256Schema } from './provenance.js';
import {
  runLeaseFile,
  runStateFile,
  validateRelativeArtifactPath,
  validateRunId,
  validateTaskId,
} from './paths.js';
import {
  appendRunStateRevision,
  initializeRunStateLedger,
  loadRunStateMaterialization,
  migrateLegacyRunStateLedger,
  runStateCommitFileSha256,
  runStateLedgerSegmentsUnchanged,
  type RunStateLedgerOptions,
  type RunStateMaterialization,
} from './run-state-ledger.js';

const commandSchema = z.enum(['fetch', 'prep', 'run', 'eval', 'report', 'status', 'clean']);
const failureSchema = z.enum(FAILURE_CODES);
const timestampSchema = z.string().datetime({ offset: true });
const relativePathSchema = z.string().transform(validateRelativeArtifactPath);
const lifecycleCandidateSchema = z.strictObject({
  pid: z.number().int().min(2).max(2_147_483_647),
  pgrp: z.number().int().nonnegative().max(2_147_483_647),
  starttime: z.string().min(1),
});

export interface LifecycleRecoveryOptions extends ProcessInspectionOptions {
  /** Monotonic-millisecond seam used to bound deterministic Linux recovery phases. */
  recoveryNow?: () => number;
  /** Bounded polling seam used by deterministic Linux recovery tests. */
  recoveryWait?: (delayMs: number) => Promise<void>;
}

function processGroupStatus(
  pgrp: number,
  inspection: ProcessInspectionOptions,
): 'alive' | 'absent' | 'unknown' {
  return signal0Status(-pgrp, inspection);
}

interface LinuxLifecycleProcess {
  token: string;
  pid: number | null;
  processStartIdentity: string | null;
}

async function recoverLinuxPhase(
  entries: readonly LinuxLifecycleProcess[],
  workerScope: string,
  signal: NodeJS.Signals,
  graceMs: number,
  inspection: LifecycleRecoveryOptions,
): Promise<Set<string>> {
  const byToken = new Map(entries.map((entry) => [entry.token, entry]));
  const tokens = [...byToken.keys()];
  const emptyPasses = new Map(tokens.map((token) => [token, 0]));
  const observe = (separated: boolean) => {
    const discovery = discoverWorkerProcessesForTokens(
      tokens,
      workerScope,
      undefined,
      inspection,
    );
    const foundTokens = new Set(discovery.processes.map((process) => process.token));
    const leaderPids = entries.flatMap((entry) => entry.pid === null ? [] : [entry.pid]);
    const leaders = readProcessIdentitySnapshot(leaderPids, inspection);
    const signalCandidates = new Map(discovery.processes.map((candidate) => [
      `${candidate.pid}:${candidate.starttime}:${candidate.pgrp}:${candidate.token}`,
      candidate,
    ]));
    for (const token of tokens) {
      const entry = byToken.get(token)!;
      let leaderAbsent = false;
      if (entry.pid !== null && entry.processStartIdentity !== null) {
        const identity = leaders.identities.get(entry.pid);
        if (identity !== undefined) {
          if (identity.starttime === entry.processStartIdentity && identity.pgrp === entry.pid) {
            signalCandidates.set(`${entry.pid}:${identity.starttime}:${identity.pgrp}:${token}`, {
              pid: entry.pid,
              token,
              ...identity,
            });
          } else if (identity.starttime !== entry.processStartIdentity) {
            leaderAbsent = true;
          }
        } else if (leaders.complete && signal0Status(entry.pid, inspection) === 'absent') {
          leaderAbsent = true;
        }
      }
      const groupAbsent = entry.pid !== null
        && processGroupStatus(entry.pid, inspection) === 'absent';
      const absent = discovery.complete
        && !foundTokens.has(token)
        && leaderAbsent
        && groupAbsent;
      const prior = emptyPasses.get(token) ?? 0;
      emptyPasses.set(token, absent ? (separated && prior > 0 ? prior + 1 : 1) : 0);
    }
    return [...signalCandidates.values()];
  };
  const unsettledTokens = (): Set<string> => new Set(
    tokens.filter((token) => (emptyPasses.get(token) ?? 0) < 2),
  );
  const now = inspection.recoveryNow ?? (() => performance.now());
  const wait = inspection.recoveryWait
    ?? ((delayMs: number) => new Promise<void>((resolvePromise) => setTimeout(resolvePromise, delayMs)));
  const boundedGraceMs = Number.isFinite(graceMs) ? Math.max(0, graceMs) : 0;
  const deadline = now() + boundedGraceMs;
  const initial = observe(false);
  signalTrackedWorkerProcesses(initial, signal, inspection);
  for (;;) {
    const unsettled = unsettledTokens();
    if (unsettled.size === 0) return unsettled;
    const observedAt = now();
    if (observedAt >= deadline) return unsettled;
    await wait(Math.min(25, Math.max(1, deadline - observedAt)));
    signalTrackedWorkerProcesses(observe(true), signal, inspection);
  }
}

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
    darwinCandidateInventory: z.strictObject({
      complete: z.boolean(),
      processes: z.array(lifecycleCandidateSchema).max(MAX_DARWIN_CANDIDATE_PROCESSES),
    }).optional(),
    recovery: z.enum(['pending', 'complete', 'failed']),
  })),
  failure: failureSchema.nullable(),
  nativeInvocation: relativePathSchema.nullable(),
});

export const attemptRecordSchema = z.strictObject({
  attemptId: z.string().uuid(),
  invocationId: z.string().uuid(),
  timingGroupId: z.string().min(1).max(256).optional(),
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
  const timingGroups = new Map<string, {
    invocationId: string;
    arm: 'a' | 'b';
    phase: typeof state.attempts[number]['phase'];
    startedAt: string;
    endedAt: string | null;
    elapsedMs: number | null;
    taskIds: Set<string>;
  }>();
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
    if (attempt.timingGroupId !== undefined) {
      const previous = timingGroups.get(attempt.timingGroupId);
      if (previous === undefined) {
        timingGroups.set(attempt.timingGroupId, {
          invocationId: attempt.invocationId,
          arm: attempt.arm,
          phase: attempt.phase,
          startedAt: attempt.startedAt,
          endedAt: attempt.endedAt,
          elapsedMs: attempt.elapsedMs,
          taskIds: new Set([attempt.taskId]),
        });
      } else {
        if (
          previous.invocationId !== attempt.invocationId
          || previous.arm !== attempt.arm
          || previous.phase !== attempt.phase
          || previous.startedAt !== attempt.startedAt
          || previous.endedAt !== attempt.endedAt
          || previous.elapsedMs !== attempt.elapsedMs
        ) {
          context.addIssue({
            code: 'custom',
            path: ['attempts', index, 'timingGroupId'],
            message: 'timing group members must describe the same physical process',
          });
        }
        if (previous.taskIds.has(attempt.taskId)) {
          context.addIssue({
            code: 'custom',
            path: ['attempts', index, 'timingGroupId'],
            message: 'timing group must not repeat a task',
          });
        }
        previous.taskIds.add(attempt.taskId);
      }
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

export interface BenchRunStateEvidence {
  state: BenchRunState;
  stateFileSha256: string;
  ledgerRootSha256: string | null;
}

/** Read-only materialization used by reports and legacy-v2 inspection. */
export function loadBenchRunStateEvidence(
  roots: BenchPathRoots,
  suite: BenchSuite,
  runId: string,
  manifestSha256: string,
): BenchRunStateEvidence {
  const materialized = loadRunStateMaterialization(
    { roots, suite, runId, manifestSha256 },
    parseBenchRunState,
  );
  const state = materialized.state;
  if (state.suite !== suite || state.runId !== validateRunId(runId) || state.manifestSha256 !== manifestSha256) {
    throw new Error('run-state identity does not match its immutable manifest');
  }
  return {
    state: structuredClone(state),
    stateFileSha256: materialized.stateFileSha256,
    ledgerRootSha256: materialized.ledgerRootSha256,
  };
}

/** Serialized in-process mutation plus disk revision checks under the lifecycle lease. */
export class BenchRunStateStore {
  private queue: Promise<void> = Promise.resolve();
  private materialized: RunStateMaterialization | null = null;

  constructor(
    private readonly roots: BenchPathRoots,
    private readonly suite: BenchSuite,
    private readonly runId: string,
    private readonly manifestSha256: string,
    private readonly lease: BenchLockHandle,
    private readonly ledgerOptions: RunStateLedgerOptions = {},
  ) {
    if (lease.path !== runLeaseFile(roots, suite, runId)) {
      throw new Error('run-state store requires the exact run lifecycle lease');
    }
  }

  load(): BenchRunState {
    this.lease.assertHeld();
    const state = this.currentMaterialization().state;
    this.assertIdentity(state);
    return structuredClone(state);
  }

  initialize(): BenchRunState {
    this.lease.assertHeld();
    const path = runStateFile(this.roots, this.suite, this.runId);
    if (existsSync(path)) throw new Error('run state already exists');
    const state = createBenchRunState(this.suite, this.runId, this.manifestSha256);
    this.materialized = initializeRunStateLedger(this.identity(), state, this.ledgerOptions);
    return structuredClone(state);
  }

  /** Explicitly convert a loaded legacy v2 monolith before permitting writes. */
  migrateLegacy(): BenchRunState {
    this.lease.assertHeld();
    const current = this.currentMaterialization();
    if (current.head !== null) throw new Error('run state already uses the append-only ledger');
    this.assertIdentity(current.state);
    this.materialized = migrateLegacyRunStateLedger(
      this.identity(),
      current.state,
      this.ledgerOptions,
    );
    return structuredClone(current.state);
  }

  /** Upgrade legacy v2 storage before any recovery side effects or command write. */
  migrateLegacyIfNeeded(): boolean {
    this.lease.assertHeld();
    const current = this.currentMaterialization();
    if (current.head !== null) return false;
    this.assertIdentity(current.state);
    this.materialized = migrateLegacyRunStateLedger(
      this.identity(),
      current.state,
      this.ledgerOptions,
    );
    return true;
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
        this.commit(result);
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
        this.commit(result);
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
    this.commit(result);
    return result;
  }

  /** Add one exact token before spawn and keep its recovery outcome durable. */
  lifecycleHooks(invocationId: string): {
    onLifecycleToken(token: string): void;
    onLifecycleStarted(token: string, pid: number | null, processStartIdentity: string | null): void;
    onLifecycleCandidates(token: string, candidates: readonly TrackedProcess[], complete: boolean): void;
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
      onLifecycleCandidates: (token, candidates, complete) => {
        this.updateCurrentSync((state) => {
          let matchedInvocation = false;
          let matchedToken = false;
          const inventory = {
            complete,
            processes: [...new Map(candidates.map((candidate) => [
              `${candidate.pid}:${candidate.starttime}:${candidate.pgrp}`,
              candidate,
            ])).values()].sort((left, right) => left.pid - right.pid),
          };
          const invocations = state.invocations.map((invocation) => {
            if (invocation.invocationId !== invocationId) return invocation;
            matchedInvocation = true;
            return {
              ...invocation,
              lifecycleProcesses: invocation.lifecycleProcesses.map((process) => {
                if (process.token !== token) return process;
                matchedToken = true;
                if (process.recovery !== 'pending') throw new Error(`lifecycle token ${token} has already settled`);
                return { ...process, darwinCandidateInventory: inventory };
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
  async recoverPendingLifecycleProcesses(
    workerScope: string,
    graceMs = 1_000,
    inspection: LifecycleRecoveryOptions = {},
  ): Promise<number> {
    this.lease.assertHeld();
    const state = this.load();
    const recoverable = state.invocations.flatMap((invocation) => invocation.lifecycleProcesses)
      .filter((process) => process.recovery !== 'complete');
    if (recoverable.length === 0) return 0;
    const platform = inspection.platform ?? process.platform;
    if (platform === 'darwin') {
      const unverifiableTokens = new Set<string>();
      const candidatesByToken = new Map<string, Map<string, TrackedWorkerProcess>>();
      const identityKey = (candidate: TrackedProcess): string =>
        `${candidate.pid}:${candidate.starttime}:${candidate.pgrp}`;
      for (const entry of recoverable) {
        const inventory = entry.darwinCandidateInventory;
        if (
          entry.pid === null
          || entry.processStartIdentity === null
          || inventory === undefined
          || !inventory.complete
        ) {
          unverifiableTokens.add(entry.token);
          continue;
        }
        const candidates = new Map<string, TrackedWorkerProcess>();
        const leader = {
          pid: entry.pid,
          pgrp: entry.pid,
          starttime: entry.processStartIdentity,
          token: entry.token,
        };
        candidates.set(identityKey(leader), leader);
        for (const candidate of inventory.processes) {
          candidates.set(identityKey(candidate), { ...candidate, token: entry.token });
        }
        if (candidates.size > MAX_DARWIN_CANDIDATE_PROCESSES) {
          unverifiableTokens.add(entry.token);
          continue;
        }
        candidatesByToken.set(entry.token, candidates);
      }

      const validTokens = [...candidatesByToken.keys()];
      const signalingInspection = darwinWorkerSignalingInspection(
        validTokens,
        workerScope,
        inspection,
      );
      const emptyPasses = new Map(validTokens.map((token) => [token, 0]));
      let deadline = Date.now() + Math.max(0, graceMs);
      let signal: NodeJS.Signals = 'SIGTERM';
      for (;;) {
        const discovery = discoverWorkerProcessesForTokens(
          validTokens,
          workerScope,
          undefined,
          inspection,
        );
        let candidatesChanged = false;
        for (const candidate of discovery.processes) {
          const candidates = candidatesByToken.get(candidate.token);
          if (candidates === undefined) continue;
          const key = identityKey(candidate);
          if (!candidates.has(key)) {
            candidates.set(key, candidate);
            candidatesChanged = true;
          }
          if (candidates.size > MAX_DARWIN_CANDIDATE_PROCESSES) {
            unverifiableTokens.add(candidate.token);
            candidatesByToken.delete(candidate.token);
          }
        }
        if (candidatesChanged) {
          this.updateCurrentSync((current) => ({
            ...current,
            invocations: current.invocations.map((invocation) => ({
              ...invocation,
              lifecycleProcesses: invocation.lifecycleProcesses.map((entry) => {
                const candidates = candidatesByToken.get(entry.token);
                if (entry.recovery === 'complete' || candidates === undefined) return entry;
                return {
                  ...entry,
                  darwinCandidateInventory: {
                    complete: true,
                    processes: [...candidates.values()]
                      .map(({ token: _token, ...candidate }) => candidate)
                      .sort((left, right) => left.pid - right.pid),
                  },
                };
              }),
            })),
          }));
        }

        const allCandidates = [...candidatesByToken.values()].flatMap((candidates) => [...candidates.values()]);
        signalTrackedWorkerProcesses(allCandidates, signal, signalingInspection);
        const identities = readProcessIdentitySnapshot(
          allCandidates.map((candidate) => candidate.pid),
          inspection,
        );
        const discoveredTokens = new Set(discovery.processes.map((candidate) => candidate.token));
        for (const entry of recoverable) {
          const candidates = candidatesByToken.get(entry.token);
          if (candidates === undefined || entry.pid === null) continue;
          const candidatesAbsent = identities.complete && [...candidates.values()].every((candidate) => {
            const live = identities.identities.get(candidate.pid);
            return live === undefined
              || live.starttime !== candidate.starttime
              || live.pgrp !== candidate.pgrp;
          });
          const absent = discovery.complete
            && !discoveredTokens.has(entry.token)
            && candidatesAbsent
            && processGroupStatus(entry.pid, inspection) === 'absent';
          emptyPasses.set(entry.token, absent ? (emptyPasses.get(entry.token) ?? 0) + 1 : 0);
        }
        if (
          validTokens.length > 0
          && validTokens.every((token) => (emptyPasses.get(token) ?? 0) >= 2)
        ) {
          break;
        }
        if (Date.now() >= deadline) {
          if (signal === 'SIGKILL') break;
          signal = 'SIGKILL';
          deadline = Date.now() + Math.max(0, graceMs);
        } else {
          await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
        }
      }
      const liveTokens = new Set([
        ...unverifiableTokens,
        ...validTokens.filter((token) => (emptyPasses.get(token) ?? 0) < 2),
      ]);
      this.updateCurrentSync((current) => ({
        ...current,
        invocations: current.invocations.map((invocation) => ({
          ...invocation,
          lifecycleProcesses: invocation.lifecycleProcesses.map((entry) =>
            entry.recovery === 'complete' ? entry : {
              ...entry,
              recovery: liveTokens.has(entry.token) ? 'failed' as const : 'complete' as const,
            }),
        })),
      }));
      if (liveTokens.size > 0) throw new Error('interrupted benchmark descendants could not be recovered safely');
      return recoverable.length;
    }

    const tokens = [...new Set(recoverable.map((process) => process.token))];
    let liveTokens = new Set(tokens);
    if (platform === 'linux') {
      liveTokens = await recoverLinuxPhase(
        recoverable,
        workerScope,
        'SIGTERM',
        graceMs,
        inspection,
      );
      if (liveTokens.size > 0) {
        liveTokens = await recoverLinuxPhase(
          recoverable.filter((entry) => liveTokens.has(entry.token)),
          workerScope,
          'SIGKILL',
          graceMs,
          inspection,
        );
      }
    }
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

  private identity() {
    return {
      roots: this.roots,
      suite: this.suite,
      runId: this.runId,
      manifestSha256: this.manifestSha256,
    };
  }

  private currentMaterialization(): RunStateMaterialization {
    if (this.materialized !== null) {
      const commitSha256 = runStateCommitFileSha256(this.identity(), this.materialized.head !== null);
      if (commitSha256 !== this.materialized.stateFileSha256
        || !runStateLedgerSegmentsUnchanged(this.identity(), this.materialized)) {
        this.materialized = null;
      }
    }
    if (this.materialized === null) {
      this.materialized = loadRunStateMaterialization(this.identity(), parseBenchRunState);
      this.assertIdentity(this.materialized.state);
    }
    return this.materialized;
  }

  private commit(next: BenchRunState): void {
    const current = this.materialized ?? this.currentMaterialization();
    try {
      this.materialized = appendRunStateRevision(
        this.identity(),
        current,
        next,
        parseBenchRunState,
        this.ledgerOptions,
      );
    } catch (error) {
      this.materialized = null;
      throw error;
    }
  }
}
