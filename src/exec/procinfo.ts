/**
 * POSIX process identity and Linux lifecycle-token discovery. Start-times bind
 * recorded PGIDs to exact process instances; environment tokens find sandbox
 * descendants after they leave the original process group.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

/** Per-attempt environment marker inherited by backend children and their tool
 *  sandboxes. Unlike a process group, it survives setsid()/new PID sessions. */
export const WORKER_TOKEN_ENV = 'ULTRACODE_WORKER_TOKEN';
export const WORKER_SCOPE_ENV = 'ULTRACODE_WORKER_SCOPE';
const WORKER_TOKEN_RE = /^[a-f0-9]{32}$/;
const WORKER_SCOPE_RE = /^[a-f0-9]{64}$/;
const DARWIN_PS_BATCH_SIZE = 128;
const MAX_DARWIN_PS_QUERIES = 64;

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

/** Read process-group identities on supported hosts in one bounded operation.
 *  Linux uses procfs; macOS batches `ps` under a fixed locale. */
export function readProcessIdentities(pids: Iterable<number>): Map<number, ProcStat> {
  const requested = [...new Set(pids)].filter((pid) => Number.isInteger(pid) && pid > 1);
  const found = new Map<number, ProcStat>();
  if (process.platform === 'linux') {
    for (const pid of requested) {
      const stat = readProcStat(pid);
      if (stat) found.set(pid, stat);
    }
    return found;
  }
  if (process.platform !== 'darwin' || requested.length === 0) return found;
  let raw: string;
  try {
    raw = execFileSync('/bin/ps', ['-o', 'pid=', '-o', 'pgid=', '-o', 'lstart=', '-p', requested.join(',')], {
      encoding: 'utf8',
      env: { ...process.env, LC_ALL: 'C' },
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 1_000,
      maxBuffer: 256 * 1_024,
    }).trim();
  } catch {
    return found;
  }
  for (const line of raw.split('\n')) {
    const [pidText, pgrpText, ...started] = line.trim().split(/\s+/);
    const pid = Number(pidText);
    const pgrp = Number(pgrpText);
    if (!Number.isInteger(pid) || !Number.isInteger(pgrp) || started.length === 0) continue;
    found.set(pid, { pgrp, starttime: `darwin:${started.join('_')}` });
  }
  return found;
}

/** Read one process-group identity. */
export function readProcessIdentity(pid: number): ProcStat | undefined {
  return readProcessIdentities([pid]).get(pid);
}

/** Worker tokens cross a worker-writable boundary when persisted in the run
 *  store. Only the exact high-entropy shape minted by spawn.ts is actionable. */
export function isWorkerToken(value: string | undefined): value is string {
  return value !== undefined && WORKER_TOKEN_RE.test(value);
}

/** Stable, whitespace-free filesystem identity used for run-scope matching. */
export function workerScopeValue(scope: string): string {
  let identity: string;
  try {
    const stat = statSync(scope, { bigint: true });
    identity = `${stat.dev}:${stat.ino}`;
  } catch {
    identity = resolve(scope);
  }
  return createHash('sha256').update(identity).digest('hex');
}

/** One process carrying a tracked worker lifecycle token. */
export interface TrackedWorkerProcess extends TrackedProcess {
  token: string;
}

/** Find marked processes for a bounded token set. Linux can scan procfs for
 *  escaped descendants; macOS only verifies a supplied candidate PID set. */
export function findWorkerProcessesForTokens(
  tokens: Iterable<string>,
  scope?: string,
  candidatePids?: Iterable<number>,
): TrackedWorkerProcess[] {
  const accepted = new Set([...tokens].filter(isWorkerToken));
  if (accepted.size === 0) return [];
  const candidates =
    candidatePids === undefined
      ? undefined
      : [...new Set(candidatePids)].filter((pid) => Number.isInteger(pid) && pid > 1 && pid !== process.pid);
  const scopeValue = scope === undefined ? undefined : workerScopeValue(scope);

  if (process.platform === 'darwin') {
    // macOS has no procfs. Recovery only inspects the bounded candidate leader
    // set from persisted records; it never performs a host-wide token sweep.
    if (scopeValue === undefined || candidates === undefined || candidates.length === 0) return [];
    const found: TrackedWorkerProcess[] = [];
    const batches: number[][] = [];
    for (let offset = 0; offset < candidates.length; offset += DARWIN_PS_BATCH_SIZE) {
      batches.push(candidates.slice(offset, offset + DARWIN_PS_BATCH_SIZE));
    }
    let queries = 0;
    while (batches.length > 0 && queries < MAX_DARWIN_PS_QUERIES) {
      const batch = batches.shift()!;
      queries++;
      let raw: string;
      try {
        raw = execFileSync(
          '/bin/ps',
          ['-E', '-c', '-o', 'pid=', '-o', 'pgid=', '-o', 'lstart=', '-o', 'command=', '-p', batch.join(',')],
          {
            encoding: 'utf8',
            env: { ...process.env, LC_ALL: 'C' },
            stdio: ['ignore', 'pipe', 'ignore'],
            timeout: 1_000,
            maxBuffer: 256 * 1_024,
          },
        ).trim();
      } catch (err) {
        // A large argv/environment can overflow a multi-process result. Split
        // only maxBuffer failures, and cap total queries so hostile records
        // cannot turn recovery into an unbounded number of `ps` executions.
        if (batch.length > 1 && err instanceof Error && /maxBuffer|ENOBUFS/.test(err.message)) {
          const middle = Math.ceil(batch.length / 2);
          batches.unshift(batch.slice(middle), batch.slice(0, middle));
        }
        continue;
      }
      for (const line of raw.split('\n')) {
        const match = line.match(
          /^\s*(\d+)\s+(\d+)\s+(\w{3}\s+\w{3}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.*)$/,
        );
        if (!match) continue;
        const [, pidText = '', pgrpText = '', started = '', commandAndEnv = ''] = match;
        const pid = Number(pidText);
        const pgrp = Number(pgrpText);
        const token = [...commandAndEnv.matchAll(/(?:^|\s)ULTRACODE_WORKER_TOKEN=([a-f0-9]{32})(?=\s|$)/g)]
          .map((entry) => entry[1])
          .find((value): value is string => isWorkerToken(value) && accepted.has(value));
        const processScopes = [
          ...commandAndEnv.matchAll(/(?:^|\s)ULTRACODE_WORKER_SCOPE=([a-f0-9]{64})(?=\s|$)/g),
        ].map((entry) => entry[1]);
        if (!Number.isInteger(pid) || !Number.isInteger(pgrp) || !isWorkerToken(token)) continue;
        if (!processScopes.some((value) => value === scopeValue && WORKER_SCOPE_RE.test(value))) continue;
        found.push({
          pid,
          pgrp,
          starttime: `darwin:${started.trim().replace(/\s+/g, '_')}`,
          token,
        });
      }
    }
    return found;
  }
  if (process.platform !== 'linux') return [];
  let entries: string[];
  if (candidates !== undefined) {
    entries = candidates.map(String);
  } else {
    try {
      entries = readdirSync('/proc');
    } catch {
      return [];
    }
  }
  const tokenPrefix = `${WORKER_TOKEN_ENV}=`;
  const scopeMarker = scopeValue === undefined ? undefined : `${WORKER_SCOPE_ENV}=${scopeValue}`;
  const found: TrackedWorkerProcess[] = [];
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    const pid = Number(entry);
    if (!Number.isInteger(pid) || pid <= 1 || pid === process.pid) continue;
    const before = readProcStat(pid);
    if (!before) continue;
    let environ: string;
    try {
      environ = readFileSync(`/proc/${pid}/environ`, 'utf8');
    } catch {
      continue;
    }
    const environment = environ.split('\0');
    if (scopeMarker !== undefined && !environment.includes(scopeMarker)) continue;
    const tokenEntry = environment.find((entry) => entry.startsWith(tokenPrefix));
    const token = tokenEntry?.slice(tokenPrefix.length);
    if (token === undefined || !accepted.has(token)) continue;
    const after = readProcStat(pid);
    if (!after || after.starttime !== before.starttime || after.pgrp !== before.pgrp) continue;
    found.push({ pid, token, ...after });
  }
  return found;
}

/** Find processes carrying one exact token and optional run scope. */
export function findWorkerProcesses(token: string, scope?: string): TrackedProcess[] {
  return findWorkerProcessesForTokens([token], scope).map(({ token: _token, ...proc }) => proc);
}

export interface WorkerSignalResult {
  processes: number;
  tokens: Set<string>;
}

/** Signal an already-discovered Linux snapshot after one final identity check. */
export function signalTrackedWorkerProcesses(
  tracked: Iterable<TrackedWorkerProcess>,
  signal: NodeJS.Signals,
): WorkerSignalResult {
  const signaledTokens = new Set<string>();
  let processes = 0;
  for (const proc of tracked) {
    const live = readProcStat(proc.pid);
    if (!live || live.starttime !== proc.starttime || live.pgrp !== proc.pgrp) continue;
    try {
      process.kill(proc.pid, signal);
      processes++;
      signaledTokens.add(proc.token);
    } catch {
      /* raced with exit */
    }
  }
  return { processes, tokens: signaledTokens };
}

/** Signal a token set using bounded, batched process-table sweeps. */
export function signalWorkerProcessTokens(
  tokens: Iterable<string>,
  signal: NodeJS.Signals,
  scope?: string,
): WorkerSignalResult {
  const accepted = new Set([...tokens].filter(isWorkerToken));
  const seen = new Set<string>();
  const signaledTokens = new Set<string>();
  let processes = 0;
  if (accepted.size === 0) return { processes, tokens: signaledTokens };
  // A marked process can fork between discovery and signal delivery. Re-scan
  // after every batch until no new process identity appears. SIGKILLed members
  // cannot fork after delivery; graceful cleanup calls this function again on
  // every bounded wait pass to catch later SIGTERM-handler forks.
  for (let pass = 0; pass < 16; pass++) {
    let discovered = false;
    const batch: TrackedWorkerProcess[] = [];
    for (const proc of findWorkerProcessesForTokens(accepted, scope)) {
      const identity = `${proc.pid}:${proc.starttime}`;
      if (seen.has(identity)) continue;
      seen.add(identity);
      discovered = true;
      batch.push(proc);
    }
    const result = signalTrackedWorkerProcesses(batch, signal);
    processes += result.processes;
    for (const token of result.tokens) {
      signaledTokens.add(token);
    }
    if (!discovered) break;
  }
  return { processes, tokens: signaledTokens };
}

/** Signal every currently-live process carrying `token`. Re-read procfs on
 *  every call so a later SIGKILL sweep also catches descendants forked while
 *  the graceful signal was in flight. */
export function signalWorkerProcesses(token: string, signal: NodeJS.Signals, scope?: string): number {
  return signalWorkerProcessTokens([token], signal, scope).processes;
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
