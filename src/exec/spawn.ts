/**
 * Child-process plumbing: every agent CLI runs in its own process group for
 * portable bulk signaling. Linux also assigns a per-attempt environment token
 * because Codex/bwrap descendants may call setsid() and leave that group.
 * Darwin intentionally does not discover descendants that leave the group.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import {
  discoverWorkerProcessesForTokens,
  snapshotLinuxProcessIdentities,
  signalTrackedWorkerProcesses,
  signal0Status,
  signalWorkerProcessTokens,
  signalWorkerProcesses,
  type ProcessInspectionOptions,
  WORKER_SCOPE_ENV,
  WORKER_TOKEN_ENV,
  workerScopeValue,
} from './procinfo.js';

interface ActiveWorker {
  inspection?: ProcessInspectionOptions;
  platform: NodeJS.Platform;
  scope?: string;
  signalGroup(signal: NodeJS.Signals): boolean;
  token: string;
}

const ACTIVE_WORKERS = new Map<string, ActiveWorker>();

/** Signal trusted in-memory worker identities without reading recovery files. */
export function killActiveWorkers(signal: NodeJS.Signals = 'SIGKILL'): number {
  let signaled = 0;
  const linuxBatches: Array<{
    inspection: ProcessInspectionOptions | undefined;
    scope: string | undefined;
    tokens: string[];
  }> = [];
  for (const worker of ACTIVE_WORKERS.values()) {
    try {
      signaled += Number(worker.signalGroup(signal));
      if (worker.platform !== 'linux') continue;
      let batch = linuxBatches.find((candidate) =>
        candidate.scope === worker.scope && candidate.inspection === worker.inspection);
      if (batch === undefined) {
        batch = { inspection: worker.inspection, scope: worker.scope, tokens: [] };
        linuxBatches.push(batch);
      }
      batch.tokens.push(worker.token);
    } catch {
      // A compromised record path must not prevent containment of siblings.
    }
  }
  for (const batch of linuxBatches) {
    try {
      signaled += signalWorkerProcessTokens(
        batch.tokens,
        signal,
        batch.scope,
        batch.inspection,
      ).processes;
    } catch {
      // Fatal cleanup remains best-effort across independent run scopes.
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
  const signalGroupProcess = platform === 'darwin'
    ? opts.processInspection?.signalProcess
      ?? ((target: number, signal: NodeJS.Signals | 0) => { process.kill(target, signal); })
    : (target: number, signal: NodeJS.Signals | 0) => { process.kill(target, signal); };
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
      signalGroupProcess(-pid, signal);
      return true;
    } catch {
      retireGroupIfGone();
      return false;
    }
  };

  const signalLiveWorker = (signal: NodeJS.Signals): number => {
    if (platform === 'darwin') return Number(signalGroup(signal));
    return Number(signalGroup(signal))
      + signalWorkerProcesses(workerToken, signal, opts.workerScope, tokenInspection);
  };

  if (pid) {
    ACTIVE_WORKERS.set(workerToken, {
      inspection: opts.processInspection,
      platform,
      scope: opts.workerScope,
      signalGroup,
      token: workerToken,
    });
  }

  const killTree = (signal: NodeJS.Signals = 'SIGTERM'): void => {
    // Linux lifecycle markers cover descendants that leave the original PGID.
    // Darwin deliberately stays group-only: setsid/daemonized descendants may escape.
    signalLiveWorker(signal);
  };

  const cleanupEscaped = async (graceMs = 500): Promise<number> => {
    retireGroupIfGone();
    if (platform === 'darwin') {
      const now = opts.processInspection?.observationNow ?? (() => performance.now());
      const wait = opts.processInspection?.observationWait ?? sleep;
      const sweepUntil = async (signal: NodeJS.Signals, deadline: number): Promise<boolean> => {
        let delayMs = 25;
        let emptyPasses = 0;
        let finalProofUsed = false;
        for (;;) {
          signalGroup(signal);
          // Retirement suppresses real signals, but signal 0 must still prove
          // stable absence and detect a group that reused the numeric PGID.
          const status = processGroupStatus();
          if (status === 'absent') groupTargetRetired = true;
          emptyPasses = status === 'absent' ? emptyPasses + 1 : 0;
          if (emptyPasses >= 2) return true;
          const observedAt = now();
          if (observedAt >= deadline) {
            if (graceMs > 0 && !finalProofUsed && emptyPasses === 1) {
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
      return Number(!groupTargetRetired) + 1;
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
