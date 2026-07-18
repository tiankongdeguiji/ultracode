/**
 * POSIX process identity and Linux lifecycle-token discovery. Start-times bind
 * recorded PGIDs to exact process instances; environment tokens find sandbox
 * descendants after they leave the original process group.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

/** Per-attempt environment marker inherited by backend children and their tool
 *  sandboxes. Unlike a process group, it survives setsid()/new PID sessions. */
export const WORKER_TOKEN_ENV = 'ULTRACODE_WORKER_TOKEN';
export const WORKER_SCOPE_ENV = 'ULTRACODE_WORKER_SCOPE';
const WORKER_TOKEN_RE = /^[a-f0-9]{32}$/;
const WORKER_SCOPE_RE = /^[a-f0-9]{64}$/;
const DARWIN_PS_BATCH_SIZE = 128;
const MAX_DARWIN_PS_QUERIES = 64;
const MAX_PROCESS_ID = 2_147_483_647;

export interface ProcStat {
  /** Process-group id (field 5). A detached worker is its own group leader, so pgrp === pid. */
  pgrp: number;
  /** Kernel start-time in clock ticks since boot (field 22) — unique per process instance. */
  starttime: string;
}

export interface TrackedProcess extends ProcStat {
  pid: number;
}

/** Whether a numeric value fits the positive PID range used by supported hosts. */
export function isSafeProcessId(pid: number): boolean {
  return Number.isSafeInteger(pid) && pid > 1 && pid <= MAX_PROCESS_ID;
}

function isSafeProcessGroupId(pgrp: number): boolean {
  return Number.isSafeInteger(pgrp) && pgrp >= 0 && pgrp <= MAX_PROCESS_ID;
}

export function readProcStat(pid: number): ProcStat | undefined {
  if (!isSafeProcessId(pid)) return undefined;
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
  if (!isSafeProcessGroupId(pgrp) || starttime === undefined) return undefined;
  return { pgrp, starttime };
}

/** Read process-group identities on supported hosts in one bounded operation.
 *  Linux uses procfs; macOS batches `ps` under a fixed locale. */
export function readProcessIdentities(pids: Iterable<number>): Map<number, ProcStat> {
  const requested = [...new Set(pids)].filter(isSafeProcessId);
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
    if (!isSafeProcessId(pid) || !isSafeProcessGroupId(pgrp) || started.length === 0) continue;
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
      : [...new Set(candidatePids)].filter((pid) => isSafeProcessId(pid) && pid !== process.pid);
  const scopeValue = scope === undefined ? undefined : workerScopeValue(scope);

  if (process.platform === 'darwin') {
    // macOS has no procfs. Recovery only inspects the bounded candidate leader
    // set from persisted records; it never performs a host-wide token sweep.
    if (scopeValue === undefined || candidates === undefined || candidates.length === 0) return [];
    type DarwinProcess = TrackedProcess & { command: string };
    const parseProcesses = (raw: string): Map<number, DarwinProcess> => {
      const processes = new Map<number, DarwinProcess>();
      for (const line of raw.split('\n')) {
        const match = line.match(
          /^\s*(\d+)\s+(\d+)\s+(\w{3}\s+\w{3}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.*)$/,
        );
        if (!match) continue;
        const [, pidText = '', pgrpText = '', started = '', command = ''] = match;
        const pid = Number(pidText);
        const pgrp = Number(pgrpText);
        if (!isSafeProcessId(pid) || !isSafeProcessGroupId(pgrp)) continue;
        processes.set(pid, {
          pid,
          pgrp,
          starttime: `darwin:${started.trim().replace(/\s+/g, '_')}`,
          command,
        });
      }
      return processes;
    };
    const found: TrackedWorkerProcess[] = [];
    const batches: number[][] = [];
    for (let offset = 0; offset < candidates.length; offset += DARWIN_PS_BATCH_SIZE) {
      batches.push(candidates.slice(offset, offset + DARWIN_PS_BATCH_SIZE));
    }
    let queries = 0;
    while (batches.length > 0 && queries + 2 <= MAX_DARWIN_PS_QUERIES) {
      const batch = batches.shift()!;
      const query = (includeEnvironment: boolean): { processes?: Map<number, DarwinProcess>; overflow: boolean } => {
        queries++;
        try {
          const raw = execFileSync(
            '/bin/ps',
            [
              '-ww',
              ...(includeEnvironment ? ['-E'] : []),
              '-o',
              'pid=',
              '-o',
              'pgid=',
              '-o',
              'lstart=',
              '-o',
              'command=',
              '-p',
              batch.join(','),
            ],
            {
              encoding: 'utf8',
              env: { ...process.env, LC_ALL: 'C' },
              stdio: ['ignore', 'pipe', 'ignore'],
              timeout: 1_000,
              maxBuffer: 256 * 1_024,
            },
          ).trim();
          return { processes: parseProcesses(raw), overflow: false };
        } catch (err) {
          return { overflow: err instanceof Error && /maxBuffer|ENOBUFS/.test(err.message) };
        }
      };
      const commands = query(false);
      const commandsAndEnvironment = commands.processes === undefined ? undefined : query(true);
      if (commands.processes === undefined || commandsAndEnvironment?.processes === undefined) {
        // A large argv/environment can overflow a multi-process result. Split
        // only maxBuffer failures, and cap total queries so hostile records
        // cannot turn recovery into an unbounded number of `ps` executions.
        if (batch.length > 1 && (commands.overflow || commandsAndEnvironment?.overflow)) {
          const middle = Math.ceil(batch.length / 2);
          batches.unshift(batch.slice(middle), batch.slice(0, middle));
        }
        continue;
      }
      for (const expanded of commandsAndEnvironment.processes.values()) {
        const command = commands.processes.get(expanded.pid);
        if (
          command === undefined ||
          command.pgrp !== expanded.pgrp ||
          command.starttime !== expanded.starttime ||
          !expanded.command.startsWith(`${command.command} `)
        ) {
          continue;
        }
        // `ps -E` appends the launch environment to the normal command field.
        // Subtract a separately-read argv field so argv text cannot impersonate
        // lifecycle markers; identity must remain stable across both reads.
        const environment = expanded.command.slice(command.command.length + 1);
        const token = [...environment.matchAll(/(?:^|\s)ULTRACODE_WORKER_TOKEN=([a-f0-9]{32})(?=\s|$)/g)]
          .map((entry) => entry[1])
          .find((value): value is string => isWorkerToken(value) && accepted.has(value));
        const processScopes = [
          ...environment.matchAll(/(?:^|\s)ULTRACODE_WORKER_SCOPE=([a-f0-9]{64})(?=\s|$)/g),
        ].map((entry) => entry[1]);
        if (!isWorkerToken(token)) continue;
        if (!processScopes.some((value) => value === scopeValue && WORKER_SCOPE_RE.test(value))) continue;
        found.push({
          pid: expanded.pid,
          pgrp: expanded.pgrp,
          starttime: expanded.starttime,
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
    if (!isSafeProcessId(pid) || pid === process.pid) continue;
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
  identities: Set<string>;
}

/** Signal an already-discovered Linux snapshot after one final identity check. */
export function signalTrackedWorkerProcesses(
  tracked: Iterable<TrackedWorkerProcess>,
  signal: NodeJS.Signals,
): WorkerSignalResult {
  const signaledTokens = new Set<string>();
  const signaledIdentities = new Set<string>();
  let processes = 0;
  for (const proc of tracked) {
    const live = readProcStat(proc.pid);
    if (!live || live.starttime !== proc.starttime || live.pgrp !== proc.pgrp) continue;
    try {
      // An authenticated session leader may have same-group descendants that
      // deliberately replaced their environment. Cover those children without
      // extending group signaling to a marked process inside another PGID.
      process.kill(proc.pgrp === proc.pid ? -proc.pid : proc.pid, signal);
      processes++;
      signaledTokens.add(proc.token);
      signaledIdentities.add(`${proc.pid}:${proc.starttime}:${proc.pgrp}:${proc.token}`);
    } catch {
      /* raced with exit */
    }
  }
  return { processes, tokens: signaledTokens, identities: signaledIdentities };
}

/** Signal one bounded process-table snapshot for a token set. */
export function signalWorkerProcessTokens(
  tokens: Iterable<string>,
  signal: NodeJS.Signals,
  scope?: string,
): WorkerSignalResult {
  const accepted = new Set([...tokens].filter(isWorkerToken));
  if (accepted.size === 0) return { processes: 0, tokens: new Set(), identities: new Set() };
  return signalTrackedWorkerProcesses(findWorkerProcessesForTokens(accepted, scope), signal);
}

/** Asynchronously re-scan until the token set is stably absent or grace ends. */
export async function signalWorkerProcessTokensUntilGone(
  tokens: Iterable<string>,
  signal: NodeJS.Signals,
  scope?: string,
  graceMs = 100,
): Promise<WorkerSignalResult> {
  const accepted = new Set([...tokens].filter(isWorkerToken));
  const aggregate: WorkerSignalResult = { processes: 0, tokens: new Set(), identities: new Set() };
  if (accepted.size === 0) return aggregate;
  const deadline = Date.now() + Math.max(0, graceMs);
  let delayMs = 5;
  let emptyPasses = 0;
  for (;;) {
    const found = findWorkerProcessesForTokens(accepted, scope);
    emptyPasses = found.length === 0 ? emptyPasses + 1 : 0;
    const batch = found.filter(
      (proc) => !aggregate.identities.has(`${proc.pid}:${proc.starttime}:${proc.pgrp}:${proc.token}`),
    );
    const result = signalTrackedWorkerProcesses(batch, signal);
    aggregate.processes += result.processes;
    for (const token of result.tokens) aggregate.tokens.add(token);
    for (const identity of result.identities) aggregate.identities.add(identity);
    if (emptyPasses >= 2 || Date.now() >= deadline) return aggregate;
    await sleep(Math.min(delayMs, Math.max(0, deadline - Date.now())));
    delayMs = Math.min(delayMs * 2, 25);
  }
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
