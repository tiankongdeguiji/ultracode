/**
 * POSIX process identity and Linux lifecycle-token discovery. Start-times bind
 * recorded PGIDs to exact process instances; environment tokens find sandbox
 * descendants after they leave the original process group.
 */
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';

/** Per-attempt environment marker inherited by backend children and their tool
 *  sandboxes. Unlike a process group, it survives setsid()/new PID sessions. */
export const WORKER_TOKEN_ENV = 'ULTRACODE_WORKER_TOKEN';
const WORKER_TOKEN_RE = /^[a-f0-9]{32}$/;

export interface ProcStat {
  /** Process-group id (field 5). A detached worker is its own group leader, so pgrp === pid. */
  pgrp: number;
  /** Kernel start-time in clock ticks since boot (field 22) — unique per process instance. */
  starttime: string;
}

export interface TrackedProcess extends ProcStat {
  pid: number;
}

export function readProcStat(pid: number): ProcStat | undefined {
  let raw: string;
  try {
    raw = readFileSync(`/proc/${pid}/stat`, 'utf8');
  } catch {
    return undefined; // no /proc (macOS/Windows), or the process is gone
  }
  // comm (field 2) is parenthesized and may itself contain spaces and ')' — so
  // split AFTER the last ')'. The remaining tokens begin at field 3 (state):
  //   rest[0]=state(3) rest[1]=ppid(4) rest[2]=pgrp(5) ... starttime(22) = rest[19].
  const close = raw.lastIndexOf(')');
  if (close === -1) return undefined;
  const rest = raw.slice(close + 1).trim().split(/\s+/);
  const pgrp = Number(rest[2]);
  const starttime = rest[19];
  if (!Number.isInteger(pgrp) || starttime === undefined) return undefined;
  return { pgrp, starttime };
}

/** Read a process-group identity on supported hosts. Linux uses kernel clock
 *  ticks from procfs; macOS uses `ps` start-time output under a fixed locale. */
export function readProcessIdentity(pid: number): ProcStat | undefined {
  const linux = readProcStat(pid);
  if (linux || process.platform !== 'darwin') return linux;
  let raw: string;
  try {
    raw = execFileSync('/bin/ps', ['-o', 'pgid=', '-o', 'lstart=', '-p', String(pid)], {
      encoding: 'utf8',
      env: { ...process.env, LC_ALL: 'C' },
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 1_000,
      maxBuffer: 4_096,
    }).trim();
  } catch {
    return undefined;
  }
  const [pgrpText, ...started] = raw.split(/\s+/);
  const pgrp = Number(pgrpText);
  if (!Number.isInteger(pgrp) || started.length === 0) return undefined;
  return { pgrp, starttime: `darwin:${started.join('_')}` };
}

/** Worker tokens cross a worker-writable boundary when persisted in the run
 *  store. Only the exact high-entropy shape minted by spawn.ts is actionable. */
export function isWorkerToken(value: string | undefined): value is string {
  return value !== undefined && WORKER_TOKEN_RE.test(value);
}

/** Find same-user Linux processes carrying an exact worker lifecycle token.
 *  The token follows Codex/bwrap descendants even after they call setsid() or
 *  are reparented to PID 1. `/proc/<pid>/environ` is unreadable for other users
 *  under normal procfs permissions; every read still fails closed. */
export function findWorkerProcesses(token: string): TrackedProcess[] {
  if (process.platform !== 'linux' || !isWorkerToken(token)) return [];
  let entries: string[];
  try {
    entries = readdirSync('/proc');
  } catch {
    return [];
  }
  const marker = `${WORKER_TOKEN_ENV}=${token}`;
  const found: TrackedProcess[] = [];
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    const pid = Number(entry);
    if (!Number.isInteger(pid) || pid <= 1 || pid === process.pid) continue;
    let environ: string;
    try {
      environ = readFileSync(`/proc/${pid}/environ`, 'utf8');
    } catch {
      continue;
    }
    if (!environ.split('\0').includes(marker)) continue;
    const stat = readProcStat(pid);
    if (stat) found.push({ pid, ...stat });
  }
  return found;
}

/** Signal every currently-live process carrying `token`. Re-read procfs on
 *  every call so a later SIGKILL sweep also catches descendants forked while
 *  the graceful signal was in flight. */
export function signalWorkerProcesses(token: string, signal: NodeJS.Signals): number {
  const seen = new Set<string>();
  let signaled = 0;
  // A marked process can fork between discovery and signal delivery. Re-scan
  // after every batch until no new process identity appears. SIGKILLed members
  // cannot fork after delivery; graceful cleanup calls this function again on
  // every bounded wait pass to catch later SIGTERM-handler forks.
  for (let pass = 0; pass < 16; pass++) {
    let discovered = false;
    for (const proc of findWorkerProcesses(token)) {
      const identity = `${proc.pid}:${proc.starttime}`;
      if (seen.has(identity)) continue;
      seen.add(identity);
      discovered = true;
      // Close the environ→kill PID-reuse window as far as procfs permits: the
      // exact process instance observed above must still own this PID.
      if (readProcStat(proc.pid)?.starttime !== proc.starttime) continue;
      try {
        process.kill(proc.pid, signal);
        signaled++;
      } catch {
        /* raced with exit */
      }
    }
    if (!discovered) break;
  }
  return signaled;
}

/**
 * PIDs this small mean the process was born inside a fresh PID namespace —
 * a sandbox or one-shot container whose teardown SIGKILLs everything in it.
 * Shared by the detach-time warning (run/resume) and the orphan hint (watch).
 */
export const NAMESPACE_LOCAL_PID_MAX = 64;

export function looksNamespaceLocal(pid: number): boolean {
  return pid > 0 && pid <= NAMESPACE_LOCAL_PID_MAX;
}
