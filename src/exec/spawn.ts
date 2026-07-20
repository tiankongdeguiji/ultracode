/**
 * Child-process plumbing: every agent CLI runs in its own process group for
 * portable bulk signaling. Linux also assigns a per-attempt environment token
 * because Codex/bwrap descendants may call setsid() and leave that group.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import {
  discoverWorkerProcessesForTokens,
  findWorkerProcessesForTokens,
  MAX_DARWIN_CANDIDATE_PROCESSES,
  readProcessIdentitySnapshot,
  signalTrackedWorkerProcesses,
  signalWorkerProcessTokens,
  signalWorkerProcesses,
  type ProcessInspectionOptions,
  type TrackedProcess,
  type TrackedWorkerProcess,
  WORKER_SCOPE_ENV,
  WORKER_TOKEN_ENV,
  workerScopeValue,
} from './procinfo.js';

interface ActiveWorker {
  scope: string | undefined;
  signalGroup(signal: NodeJS.Signals): boolean;
  token: string;
}

const ACTIVE_WORKERS = new Map<string, ActiveWorker>();

/** Signal trusted in-memory worker identities without reading recovery files. */
export function killActiveWorkers(signal: NodeJS.Signals = 'SIGKILL'): number {
  const tokensByScope = new Map<string | undefined, string[]>();
  let signaled = 0;
  for (const worker of ACTIVE_WORKERS.values()) {
    if (worker.signalGroup(signal)) signaled++;
    const tokens = tokensByScope.get(worker.scope) ?? [];
    tokens.push(worker.token);
    tokensByScope.set(worker.scope, tokens);
  }
  for (const [scope, tokens] of tokensByScope) {
    signaled += signalWorkerProcessTokens(tokens, signal, scope).processes;
  }
  return signaled;
}

export interface SpawnedAgent {
  child: ChildProcess;
  /** High-entropy marker inherited by descendants even if they leave our PGID. */
  workerToken: string;
  killTree(signal?: NodeJS.Signals): void;
  /** Reap same-group and token-bearing descendants after the direct child closes. */
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
    complete: boolean,
  ) => void;
  /** Explicit platform/process seam for deterministic supervision tests. */
  processInspection?: ProcessInspectionOptions;
}

export function spawnAgentProcess(bin: string, argv: string[], opts: SpawnAgentOptions): SpawnedAgent {
  const workerToken = randomBytes(16).toString('hex');
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
  const platform = opts.processInspection?.platform ?? process.platform;
  const processGroupStatus = (): 'alive' | 'absent' | 'unknown' => {
    if (!pid) return 'absent';
    try {
      process.kill(-pid, 0);
      return 'alive';
    } catch (error) {
      if (platform !== 'darwin') return 'absent';
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ESRCH') return 'absent';
      if (code === 'EPERM') return 'alive';
      return 'unknown';
    }
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

  if (pid) {
    ACTIVE_WORKERS.set(workerToken, {
      scope: opts.workerScope,
      signalGroup,
      token: workerToken,
    });
  }

  const killTree = (signal: NodeJS.Signals = 'SIGTERM'): void => {
    signalGroup(signal);
    // Codex's Linux sandbox calls setsid()/bwrap --new-session, so descendants
    // can leave the worker PGID. The inherited token is the containment
    // boundary for those escaped sessions.
    if (platform === 'darwin') {
      signalWorkerProcesses(workerToken, signal, opts.workerScope, opts.processInspection);
    } else {
      signalWorkerProcesses(workerToken, signal, opts.workerScope);
    }
  };

  const retainedDarwinCandidates = new Map<string, TrackedWorkerProcess>();
  let darwinInventoryComplete = false;
  let darwinCandidateOverflow = false;
  let persistedDarwinInventory = '';

  const cleanupEscaped = async (graceMs = 500): Promise<number> => {
    retireGroupIfGone();
    if (platform === 'darwin') {
      const retained = retainedDarwinCandidates;
      const identityKey = (proc: TrackedProcess): string => `${proc.pid}:${proc.starttime}:${proc.pgrp}`;
      const persistCandidates = (complete: boolean): void => {
        const candidates = [...retained.values()]
          .map(({ token: _token, ...proc }) => proc)
          .sort((left, right) => left.pid - right.pid);
        const fingerprint = `${Number(complete)}:${candidates.map(identityKey).join(',')}`;
        if (fingerprint === persistedDarwinInventory) return;
        opts.onWorkerCandidates?.(workerToken, candidates, complete);
        persistedDarwinInventory = fingerprint;
      };
      const discoverCandidates = (): boolean => {
        const discovery = discoverWorkerProcessesForTokens(
          [workerToken],
          opts.workerScope,
          undefined,
          opts.processInspection,
        );
        for (const candidate of discovery.processes) {
          const key = identityKey(candidate);
          if (retained.has(key)) continue;
          if (retained.size >= MAX_DARWIN_CANDIDATE_PROCESSES) {
            darwinCandidateOverflow = true;
            continue;
          }
          retained.set(key, candidate);
        }
        darwinInventoryComplete = discovery.complete
          && !darwinCandidateOverflow;
        persistCandidates(darwinInventoryComplete);
        return darwinInventoryComplete;
      };
      let emptyPasses = 0;
      const sweepUntil = async (signal: NodeJS.Signals, deadline: number): Promise<boolean> => {
        let delayMs = 25;
        for (;;) {
          signalGroup(signal);
          const discoveredCompletely = discoverCandidates();
          const candidates = [...retained.values()];
          signalTrackedWorkerProcesses(candidates, signal, opts.processInspection);
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
          if (emptyPasses >= 2) return true;
          if (Date.now() >= deadline) return false;
          await sleep(delayMs);
          delayMs = Math.min(delayMs * 2, 100);
        }
      };
      if (await sweepUntil('SIGTERM', Date.now() + graceMs)) {
        ACTIVE_WORKERS.delete(workerToken);
        return 0;
      }
      if (await sweepUntil('SIGKILL', Date.now() + graceMs)) {
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
        + Number(!darwinInventoryComplete || !finalIdentities.complete)
        + 1;
    }
    const tokenProcesses = () => findWorkerProcessesForTokens([workerToken], opts.workerScope);
    const sweepUntil = async (signal: NodeJS.Signals, deadline: number): Promise<boolean> => {
      let delayMs = 25;
      let emptyPasses = 0;
      for (;;) {
        signalGroup(signal);
        const tracked = tokenProcesses();
        signalTrackedWorkerProcesses(tracked, signal);
        retireGroupIfGone();
        emptyPasses = tracked.length === 0 ? emptyPasses + 1 : 0;
        // One procfs directory snapshot can miss a PID forked after readdir.
        // Require stable absence across two backoff polls before settling.
        if (groupTargetRetired && emptyPasses >= 2) return true;
        if (Date.now() >= deadline) return false;
        await sleep(delayMs);
        delayMs = Math.min(delayMs * 2, 100);
      }
    };
    if (await sweepUntil('SIGTERM', Date.now() + graceMs)) {
      ACTIVE_WORKERS.delete(workerToken);
      return 0;
    }
    if (await sweepUntil('SIGKILL', Date.now() + graceMs)) {
      ACTIVE_WORKERS.delete(workerToken);
      return 0;
    }
    retireGroupIfGone();
    return tokenProcesses().length + Number(!groupTargetRetired);
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
