/**
 * Child-process plumbing: every agent CLI runs in its own process group for
 * portable bulk signaling. Linux also assigns a per-attempt environment token
 * because Codex/bwrap descendants may call setsid() and leave that group.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import {
  darwinWorkerSignalingInspection,
  discoverWorkerProcessesForTokens,
  MAX_DARWIN_CANDIDATE_PROCESSES,
  readProcessIdentitySnapshot,
  snapshotLinuxProcessIdentities,
  signalTrackedWorkerProcesses,
  signal0Status,
  signalWorkerProcesses,
  type ProcessInspectionOptions,
  type TrackedProcess,
  type TrackedWorkerProcess,
  WORKER_SCOPE_ENV,
  WORKER_TOKEN_ENV,
  workerScopeValue,
} from './procinfo.js';

interface ActiveWorker {
  signal(signal: NodeJS.Signals): number;
}

const ACTIVE_WORKERS = new Map<string, ActiveWorker>();

/** Signal trusted in-memory worker identities without reading recovery files. */
export function killActiveWorkers(signal: NodeJS.Signals = 'SIGKILL'): number {
  let signaled = 0;
  for (const worker of ACTIVE_WORKERS.values()) {
    try {
      signaled += worker.signal(signal);
    } catch {
      // A compromised record path must not prevent containment of siblings.
    }
  }
  return signaled;
}

export interface SpawnedAgent {
  child: ChildProcess;
  /** High-entropy marker inherited by descendants even if they leave our PGID. */
  workerToken: string;
  killTree(signal?: NodeJS.Signals): void;
  /** Reap descendants, returning nonzero unless complete observations prove stable absence. */
  cleanupEscaped(graceMs?: number): Promise<number>;
}

export interface SpawnAgentOptions {
  cwd: string;
  env: Record<string, string | undefined>;
  stdinData?: string;
  /** Stable run-dir scope used to authorize persisted token recovery. */
  workerScope?: string;
  /** Persist the lifecycle token before the backend process can start. */
  onWorkerToken?: (token: string) => void;
  /** Persist macOS identities before a cleanup signal can act on them. */
  onWorkerCandidates?: (
    token: string,
    candidates: readonly TrackedProcess[],
    settled: boolean,
  ) => void;
  /** Explicit platform/process seam for deterministic supervision tests. */
  processInspection?: ProcessInspectionOptions;
}

export function spawnAgentProcess(bin: string, argv: string[], opts: SpawnAgentOptions): SpawnedAgent {
  const workerToken = randomBytes(16).toString('hex');
  const platform = opts.processInspection?.platform ?? process.platform;
  const preexistingLinuxIdentities = platform === 'linux'
    ? snapshotLinuxProcessIdentities(opts.processInspection)
    : undefined;
  opts.onWorkerToken?.(workerToken);
  const env: NodeJS.ProcessEnv = { ...opts.env, [WORKER_TOKEN_ENV]: workerToken };
  if (opts.workerScope !== undefined) env[WORKER_SCOPE_ENV] = workerScopeValue(opts.workerScope);
  const child = spawn(bin, argv, {
    cwd: opts.cwd,
    env,
    detached: true, // own process group → killable as a tree
    stdio: [opts.stdinData !== undefined ? 'pipe' : 'ignore', 'pipe', 'pipe'],
  });

  if (opts.stdinData !== undefined && child.stdin) {
    // If the child dies before draining stdin, the write raises EPIPE on the
    // Writable; without a listener Node throws it as uncaught and takes down
    // the detached runner. Swallow it — the spawn 'error'/exit is handled by
    // the caller as a clean agent failure.
    child.stdin.on('error', () => {});
    child.stdin.write(opts.stdinData);
    child.stdin.end();
  }

  const pid = child.pid;
  const tokenInspection = platform === 'linux'
    ? {
        ...opts.processInspection,
        excludedLinuxProcessIdentities: preexistingLinuxIdentities,
      }
    : opts.processInspection;
  const processGroupStatus = (): 'alive' | 'absent' | 'unknown' => {
    if (!pid) return 'absent';
    return signal0Status(-pid, opts.processInspection);
  };
  let groupTargetRetired = false;
  const retireGroupIfGone = (): boolean => {
    if (!groupTargetRetired && processGroupStatus() === 'absent') groupTargetRetired = true;
    return groupTargetRetired;
  };

  const signalGroup = (signal: NodeJS.Signals): boolean => {
    if (!pid || groupTargetRetired) return false;
    const status = processGroupStatus();
    if (status === 'absent') {
      // Never target this numeric PGID after observing it absent; a later
      // process group may reuse the id during or after cleanup.
      groupTargetRetired = true;
      return false;
    }
    if (status === 'unknown') return false;
    try {
      process.kill(-pid, signal);
      return true;
    } catch {
      retireGroupIfGone();
      return false;
    }
  };

  const retainedDarwinCandidates = new Map<string, TrackedWorkerProcess>();
  let darwinDiscoveryComplete = false;
  let darwinCandidateOverflow = false;
  let persistedDarwinInventory = '';
  const identityKey = (proc: TrackedProcess): string => `${proc.pid}:${proc.starttime}:${proc.pgrp}`;
  const persistDarwinCandidates = (settled: boolean): boolean => {
    const candidates = [...retainedDarwinCandidates.values()]
      .map(({ pid: candidatePid, pgrp, starttime }) => ({ pid: candidatePid, pgrp, starttime }))
      .sort((left, right) => left.pid - right.pid);
    const fingerprint = `${Number(settled)}:${candidates.map(identityKey).join(',')}`;
    if (fingerprint === persistedDarwinInventory) return true;
    try {
      opts.onWorkerCandidates?.(workerToken, candidates, settled);
      persistedDarwinInventory = fingerprint;
      return true;
    } catch {
      // Worker containment uses retained identities even when its durable
      // inventory path is temporarily unwritable. Cleanup retries persistence.
      return false;
    }
  };
  const discoverDarwinCandidates = (): boolean => {
    const discovery = discoverWorkerProcessesForTokens(
      [workerToken],
      opts.workerScope,
      undefined,
      opts.processInspection,
    );
    for (const candidate of discovery.processes) {
      const key = identityKey(candidate);
      if (retainedDarwinCandidates.has(key)) continue;
      if (retainedDarwinCandidates.size >= MAX_DARWIN_CANDIDATE_PROCESSES) {
        darwinCandidateOverflow = true;
        continue;
      }
      retainedDarwinCandidates.set(key, candidate);
    }
    darwinDiscoveryComplete = discovery.complete && !darwinCandidateOverflow;
    return darwinDiscoveryComplete;
  };
  const darwinSignalInspection = darwinWorkerSignalingInspection(
    [workerToken],
    opts.workerScope,
    opts.processInspection,
  );
  const signalRetainedDarwinCandidates = (signal: NodeJS.Signals): number =>
    signalTrackedWorkerProcesses(
      retainedDarwinCandidates.values(),
      signal,
      darwinSignalInspection,
    ).processes;
  const signalLiveWorker = (signal: NodeJS.Signals): number => {
    if (platform === 'darwin') {
      discoverDarwinCandidates();
      try {
        return Number(signalGroup(signal)) + signalRetainedDarwinCandidates(signal);
      } finally {
        // A complete point-in-time scan is not a closed inventory while the
        // worker can still fork. Seal only after stable live cleanup below.
        persistDarwinCandidates(false);
      }
    }
    return Number(signalGroup(signal))
      + signalWorkerProcesses(workerToken, signal, opts.workerScope, tokenInspection);
  };

  if (pid) ACTIVE_WORKERS.set(workerToken, { signal: signalLiveWorker });

  const killTree = (signal: NodeJS.Signals = 'SIGTERM'): void => {
    // Sandboxes may call setsid(), so lifecycle markers remain the containment
    // boundary after descendants leave the original process group.
    signalLiveWorker(signal);
  };

  const cleanupEscaped = async (graceMs = 500): Promise<number> => {
    retireGroupIfGone();
    if (platform === 'darwin') {
      const retained = retainedDarwinCandidates;
      const now = opts.processInspection?.observationNow ?? (() => performance.now());
      const wait = opts.processInspection?.observationWait ?? sleep;
      const sweepUntil = async (signal: NodeJS.Signals, deadline: number): Promise<boolean> => {
        let delayMs = 25;
        let emptyPasses = 0;
        let finalProofUsed = false;
        for (;;) {
          const discoveredCompletely = discoverDarwinCandidates();
          signalGroup(signal);
          const candidates = [...retained.values()];
          try {
            signalRetainedDarwinCandidates(signal);
          } finally {
            persistDarwinCandidates(false);
          }
          const live = readProcessIdentitySnapshot(
            candidates.map((candidate) => candidate.pid),
            opts.processInspection,
          );
          retireGroupIfGone();
          const candidatesAbsent = live.complete && candidates.every((candidate) => {
            const identity = live.identities.get(candidate.pid);
            return identity === undefined
              || identity.starttime !== candidate.starttime
              || identity.pgrp !== candidate.pgrp;
          });
          emptyPasses = discoveredCompletely && candidatesAbsent && groupTargetRetired
            ? emptyPasses + 1
            : 0;
          if (emptyPasses >= 2) {
            if (persistDarwinCandidates(true)) return true;
          }
          const observedAt = now();
          if (observedAt >= deadline) {
            if (graceMs > 0 && !finalProofUsed && groupTargetRetired && emptyPasses === 1) {
              finalProofUsed = true;
              await wait(1);
              continue;
            }
            return false;
          }
          await wait(Math.min(delayMs, Math.max(1, deadline - observedAt)));
          delayMs = Math.min(delayMs * 2, 100);
        }
      };
      if (await sweepUntil('SIGTERM', now() + graceMs)) {
        ACTIVE_WORKERS.delete(workerToken);
        return 0;
      }
      if (await sweepUntil('SIGKILL', now() + graceMs)) {
        ACTIVE_WORKERS.delete(workerToken);
        return 0;
      }
      retireGroupIfGone();
      const finalIdentities = readProcessIdentitySnapshot(
        [...retained.values()].map((candidate) => candidate.pid),
        opts.processInspection,
      );
      const liveCandidates = [...retained.values()].filter((candidate) => {
        const identity = finalIdentities.identities.get(candidate.pid);
        return identity?.starttime === candidate.starttime && identity.pgrp === candidate.pgrp;
      }).length;
      return liveCandidates
        + Number(!groupTargetRetired)
        + Number(!darwinDiscoveryComplete || !finalIdentities.complete)
        + 1;
    }
    const observeTokenProcesses = () => discoverWorkerProcessesForTokens(
      [workerToken],
      opts.workerScope,
      undefined,
      tokenInspection,
    );
    const now = opts.processInspection?.observationNow ?? (() => performance.now());
    const wait = opts.processInspection?.observationWait ?? sleep;
    const sweepUntil = async (signal: NodeJS.Signals, deadline: number): Promise<boolean> => {
      let delayMs = 25;
      let emptyPasses = 0;
      let finalProofUsed = false;
      for (;;) {
        signalGroup(signal);
        const discovery = observeTokenProcesses();
        signalTrackedWorkerProcesses(discovery.processes, signal, opts.processInspection);
        retireGroupIfGone();
        emptyPasses = discovery.complete && discovery.processes.length === 0
          ? emptyPasses + 1
          : 0;
        // One procfs directory snapshot can miss a PID forked after readdir.
        // Require stable absence across two backoff polls before settling.
        if (groupTargetRetired && emptyPasses >= 2) return true;
        const observedAt = now();
        if (observedAt >= deadline) {
          if (graceMs > 0 && !finalProofUsed && groupTargetRetired && emptyPasses === 1) {
            finalProofUsed = true;
            await wait(1);
            continue;
          }
          return false;
        }
        await wait(Math.min(delayMs, Math.max(1, deadline - observedAt)));
        delayMs = Math.min(delayMs * 2, 100);
      }
    };
    if (await sweepUntil('SIGTERM', now() + graceMs)) {
      ACTIVE_WORKERS.delete(workerToken);
      return 0;
    }
    if (await sweepUntil('SIGKILL', now() + graceMs)) {
      ACTIVE_WORKERS.delete(workerToken);
      return 0;
    }
    retireGroupIfGone();
    const finalDiscovery = observeTokenProcesses();
    return finalDiscovery.processes.length
      + Number(!groupTargetRetired)
      + Number(!finalDiscovery.complete)
      + 1;
  };

  return { child, workerToken, killTree, cleanupEscaped };
}

/** Keep only the trailing maxBytes of accumulated text (stderr tails). */
export class TailBuffer {
  private buf = '';

  constructor(private readonly maxBytes = 64 * 1024) {}

  push(chunk: string): void {
    this.buf += chunk;
    if (this.buf.length > this.maxBytes) {
      this.buf = this.buf.slice(this.buf.length - this.maxBytes);
    }
  }

  get text(): string {
    return this.buf;
  }
}
