/**
 * Child-process plumbing: every agent CLI runs in its own process group for
 * portable bulk signaling. Linux also assigns a per-attempt environment token
 * because Codex/bwrap descendants may call setsid() and leave that group.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import {
  findWorkerProcesses,
  signalWorkerProcesses,
  WORKER_SCOPE_ENV,
  WORKER_TOKEN_ENV,
} from './procinfo.js';

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
}

export function spawnAgentProcess(bin: string, argv: string[], opts: SpawnAgentOptions): SpawnedAgent {
  const workerToken = randomBytes(16).toString('hex');
  const env: NodeJS.ProcessEnv = { ...opts.env, [WORKER_TOKEN_ENV]: workerToken };
  if (opts.workerScope !== undefined) env[WORKER_SCOPE_ENV] = opts.workerScope;
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

  const killTree = (signal: NodeJS.Signals = 'SIGTERM'): void => {
    const pid = child.pid;
    if (!pid) return;
    try {
      process.kill(-pid, signal); // whole process group
    } catch {
      try {
        child.kill(signal);
      } catch {
        /* already gone */
      }
    }
    // Codex's Linux sandbox calls setsid()/bwrap --new-session, so descendants
    // can leave the worker PGID. The inherited token is the containment
    // boundary for those escaped sessions.
    signalWorkerProcesses(workerToken, signal, opts.workerScope);
  };

  const cleanupEscaped = async (graceMs = 500): Promise<number> => {
    const pid = child.pid;
    const groupAlive = (): boolean => {
      if (!pid) return false;
      try {
        process.kill(-pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    const signalGroup = (signal: NodeJS.Signals): void => {
      if (!pid) return;
      try {
        process.kill(-pid, signal);
      } catch {
        /* group already gone */
      }
    };
    const tokenProcesses = () => findWorkerProcesses(workerToken, opts.workerScope);
    if (!groupAlive() && tokenProcesses().length === 0) return 0;
    const sweepUntil = async (signal: NodeJS.Signals, deadline: number): Promise<boolean> => {
      for (;;) {
        signalGroup(signal);
        signalWorkerProcesses(workerToken, signal, opts.workerScope);
        if (!groupAlive() && tokenProcesses().length === 0) return true;
        if (Date.now() >= deadline) return false;
        await sleep(25);
      }
    };
    if (await sweepUntil('SIGTERM', Date.now() + graceMs)) return 0;
    if (await sweepUntil('SIGKILL', Date.now() + graceMs)) return 0;
    return tokenProcesses().length + Number(groupAlive());
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
