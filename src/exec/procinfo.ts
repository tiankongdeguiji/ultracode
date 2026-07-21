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
const MAX_DARWIN_PS_QUERIES = 66;
/** Maximum durable macOS identities accepted for one worker lifecycle. */
export const MAX_DARWIN_CANDIDATE_PROCESSES = 4_096;
const MAX_PROCESS_ID = 2_147_483_647;

export interface ProcessInspectionOptions {
  /** Explicit platform seam for deterministic process-supervision tests. */
  platform?: NodeJS.Platform;
  /** Headerless `/bin/ps` execution seam; arguments exclude the executable. */
  executePs?: (argv: readonly string[]) => string;
  /** Complete process-discovery seam for deterministic recovery tests. */
  discoverWorkerProcesses?: (
    tokens: readonly string[],
    scope: string | undefined,
    candidatePids: readonly number[] | undefined,
  ) => WorkerProcessDiscovery;
  /** Process-identity snapshot seam for deterministic recovery tests. */
  readIdentitySnapshot?: (pids: readonly number[]) => ProcessIdentitySnapshot;
  /** Linux `/proc` directory seam for deterministic incomplete-scan tests. */
  listLinuxProcessIds?: () => readonly string[];
  /** Linux stat seam; undefined means the requested identity was not readable. */
  readLinuxProcessIdentity?: (pid: number) => ProcStat | undefined;
  /** Linux environment seam; errors retain their normal unreadable meaning. */
  readLinuxProcessEnvironment?: (pid: number) => string;
  /** Linux procfs owner seam; ownership never proves lifecycle-token absence. */
  readLinuxProcessOwner?: (pid: number) => number | undefined;
  /** Effective-UID seam; Linux permission checks use `geteuid`, not the real UID. */
  readLinuxEffectiveUid?: () => number | undefined;
  /** Linux procfs mountinfo seam; restricted or unprovable visibility fails closed. */
  readLinuxProcMountInfo?: () => string;
  /** Exact pre-spawn Linux identities that cannot carry the new worker token. */
  excludedLinuxProcessIdentities?: ReadonlySet<string>;
  /** POSIX signal seam, including signal 0 probes. */
  signalProcess?: (pid: number, signal: NodeJS.Signals | 0) => void;
  /** Monotonic-millisecond seam for deterministic process-settlement deadlines. */
  observationNow?: () => number;
  /** Bounded polling seam for deterministic process-settlement tests. */
  observationWait?: (delayMs: number) => Promise<void>;
}

export interface ProcStat {
  /** Linux process state (field 3); omitted by non-Linux and synthetic seams. */
  state?: string;
  /** Process-group id (field 5). A detached worker is its own group leader, so pgrp === pid. */
  pgrp: number;
  /** Linux session id (field 6); omitted by non-Linux and synthetic seams. */
  session?: number;
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
  const state = rest[0];
  const pgrp = Number(rest[2]);
  const session = Number(rest[3]);
  const starttime = rest[19];
  if (
    state === undefined
    || !isSafeProcessGroupId(pgrp)
    || !isSafeProcessGroupId(session)
    || starttime === undefined
  ) return undefined;
  return { state, pgrp, session, starttime };
}

/** One bounded identity read plus whether absence claims are authoritative. */
export interface ProcessIdentitySnapshot {
  identities: Map<number, ProcStat>;
  complete: boolean;
}

function inspectionPlatform(options: ProcessInspectionOptions): NodeJS.Platform {
  return options.platform ?? process.platform;
}

function linuxProcessIdentity(pid: number, options: ProcessInspectionOptions): ProcStat | undefined {
  return options.readLinuxProcessIdentity === undefined
    ? readProcStat(pid)
    : options.readLinuxProcessIdentity(pid);
}

function linuxIdentityKey(pid: number, identity: ProcStat): string {
  return `${pid}:${identity.starttime}:${identity.pgrp}`;
}

function sameLinuxIdentity(left: ProcStat, right: ProcStat): boolean {
  return left.starttime === right.starttime && left.pgrp === right.pgrp;
}

function hasExactPreSpawnLeader(
  pid: number,
  options: ProcessInspectionOptions,
): boolean {
  const excluded = options.excludedLinuxProcessIdentities;
  if (excluded === undefined || !isSafeProcessId(pid)) return false;
  let leader: ProcStat | undefined;
  try { leader = linuxProcessIdentity(pid, options); } catch { leader = undefined; }
  return leader !== undefined && excluded.has(linuxIdentityKey(pid, leader));
}

function isExcludedUnreadableLinuxProcess(
  pid: number,
  identity: ProcStat,
  options: ProcessInspectionOptions,
): boolean {
  if (options.excludedLinuxProcessIdentities?.has(linuxIdentityKey(pid, identity))) return true;
  return hasExactPreSpawnLeader(identity.pgrp, options)
    || (identity.session !== undefined && hasExactPreSpawnLeader(identity.session, options));
}

function procMountAllowsFullEnumeration(
  raw: string,
  effectiveUid: number | undefined,
): boolean {
  let found = false;
  for (const line of raw.split('\n')) {
    if (line.trim() === '') continue;
    const fields = line.trim().split(/\s+/u);
    const separator = fields.indexOf('-');
    if (fields[4] !== '/proc') continue;
    if (
      separator < 6
      || fields.length !== separator + 4
      || fields[3] !== '/'
      || fields[separator + 1] !== 'proc'
    ) return false;
    found = true;
    const options = [
      ...(fields[5] ?? '').split(','),
      ...(fields[separator + 3] ?? '').split(','),
    ];
    for (const option of options) {
      if (option === 'hidepid' || option.startsWith('hidepid=')) {
        const value = option.slice('hidepid='.length);
        if (effectiveUid !== 0 && value !== '0' && value !== 'off') return false;
      }
    }
  }
  return found;
}

function linuxProcessEnumerationIsAuthoritative(
  effectiveUid: number | undefined,
  options: ProcessInspectionOptions,
): boolean {
  if (
    options.readLinuxProcMountInfo === undefined
    && process.platform !== 'linux'
    && options.listLinuxProcessIds !== undefined
  ) return true;
  let mountInfo: string;
  try {
    mountInfo = options.readLinuxProcMountInfo?.()
      ?? readFileSync('/proc/self/mountinfo', 'utf8');
  } catch {
    return false;
  }
  return procMountAllowsFullEnumeration(mountInfo, effectiveUid);
}

/** Snapshot readable Linux identities before spawn so unrelated peers cannot
 * make a later token-absence proof incomplete. PID reuse changes the key. */
export function snapshotLinuxProcessIdentities(
  options: ProcessInspectionOptions = {},
): ReadonlySet<string> {
  if (inspectionPlatform(options) !== 'linux') return new Set();
  let entries: readonly string[];
  try {
    entries = options.listLinuxProcessIds?.() ?? readdirSync('/proc');
  } catch {
    return new Set();
  }
  const identities = new Set<string>();
  for (const entry of entries) {
    if (!/^\d+$/u.test(entry)) continue;
    const pid = Number(entry);
    if (!isSafeProcessId(pid)) continue;
    let identity: ProcStat | undefined;
    try { identity = linuxProcessIdentity(pid, options); } catch { identity = undefined; }
    if (identity !== undefined) identities.add(linuxIdentityKey(pid, identity));
  }
  return identities;
}

/** Classify one process or process-group signal-0 probe without collapsing permission errors into absence. */
export function signal0Status(
  target: number,
  options: ProcessInspectionOptions = {},
): 'alive' | 'absent' | 'unknown' {
  const signalProcess = options.signalProcess ?? ((pid: number, signal: NodeJS.Signals | 0) => {
    process.kill(pid, signal);
  });
  try {
    signalProcess(target, 0);
    return 'alive';
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') return 'absent';
    if (code === 'EPERM') return 'alive';
    return 'unknown';
  }
}

function executeDarwinPs(argv: readonly string[], options: ProcessInspectionOptions): string {
  if (options.executePs !== undefined) return options.executePs(argv);
  return execFileSync('/bin/ps', [...argv], {
    encoding: 'utf8',
    env: { ...process.env, LC_ALL: 'C' },
    stdio: ['ignore', 'pipe', 'ignore'],
    timeout: 1_000,
    maxBuffer: 256 * 1_024,
  });
}

interface DarwinPsFailure {
  status?: unknown;
  stdout?: unknown;
}

function isDarwinNoSelection(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const failure = error as DarwinPsFailure;
  const stdout = typeof failure.stdout === 'string'
    ? failure.stdout
    : Buffer.isBuffer(failure.stdout)
      ? failure.stdout.toString('utf8')
      : '';
  return failure.status === 1 && stdout.trim() === '';
}

function parseDarwinIdentities(raw: string): ProcessIdentitySnapshot {
  const identities = new Map<number, ProcStat>();
  let complete = true;
  for (const line of raw.split('\n')) {
    if (line.trim() === '') continue;
    const match = line.match(
      /^\s*(\d+)\s+(\d+)\s+(\w{3}\s+\w{3}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s*$/,
    );
    if (!match) {
      complete = false;
      continue;
    }
    const [, pidText = '', pgrpText = '', started = ''] = match;
    const pid = Number(pidText);
    const pgrp = Number(pgrpText);
    if (!isSafeProcessId(pid) || !isSafeProcessGroupId(pgrp) || identities.has(pid)) {
      complete = false;
      continue;
    }
    identities.set(pid, {
      pgrp,
      starttime: `darwin:${started.trim().replace(/\s+/g, '_')}`,
    });
  }
  return { identities, complete };
}

/** Read process identities while preserving whether macOS `ps` was authoritative. */
export function readProcessIdentitySnapshot(
  pids: Iterable<number>,
  options: ProcessInspectionOptions = {},
): ProcessIdentitySnapshot {
  const requested = [...new Set(pids)].filter(isSafeProcessId);
  if (options.readIdentitySnapshot !== undefined) {
    return options.readIdentitySnapshot(requested);
  }
  const found = new Map<number, ProcStat>();
  const platform = inspectionPlatform(options);
  if (platform === 'linux') {
    let complete = true;
    for (const pid of requested) {
      let stat: ProcStat | undefined;
      try {
        stat = linuxProcessIdentity(pid, options);
      } catch {
        stat = undefined;
      }
      if (stat) found.set(pid, stat);
      else if (signal0Status(pid, options) !== 'absent') complete = false;
    }
    return { identities: found, complete };
  }
  if (platform !== 'darwin' || requested.length === 0) {
    return { identities: found, complete: platform === 'darwin' };
  }
  let complete = true;
  for (let offset = 0; offset < requested.length; offset += DARWIN_PS_BATCH_SIZE) {
    const batch = requested.slice(offset, offset + DARWIN_PS_BATCH_SIZE);
    const accepted = new Set(batch);
    try {
      const parsed = parseDarwinIdentities(executeDarwinPs(
        ['-o', 'pid=', '-o', 'pgid=', '-o', 'lstart=', '-p', batch.join(',')],
        options,
      ));
      complete &&= parsed.complete;
      for (const [pid, identity] of parsed.identities) {
        if (accepted.has(pid)) found.set(pid, identity);
        else complete = false;
      }
    } catch (error) {
      if (!isDarwinNoSelection(error)) complete = false;
    }
  }
  return { identities: found, complete };
}

/** Read process-group identities on supported hosts in one bounded operation. */
export function readProcessIdentities(
  pids: Iterable<number>,
  options: ProcessInspectionOptions = {},
): Map<number, ProcStat> {
  return readProcessIdentitySnapshot(pids, options).identities;
}

/** Read one process-group identity. */
export function readProcessIdentity(
  pid: number,
  options: ProcessInspectionOptions = {},
): ProcStat | undefined {
  return readProcessIdentities([pid], options).get(pid);
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

export interface WorkerProcessDiscovery {
  processes: TrackedWorkerProcess[];
  /** False means an empty/partial result cannot prove process absence. */
  complete: boolean;
}

interface DarwinProcess extends TrackedProcess {
  command: string;
}

interface DarwinProcessParse {
  processes: Map<number, DarwinProcess>;
  complete: boolean;
}

function parseDarwinProcesses(raw: string): DarwinProcessParse {
  const processes = new Map<number, DarwinProcess>();
  let complete = true;
  for (const line of raw.split('\n')) {
    if (line.trim() === '') continue;
    const match = line.match(
      /^\s*(\d+)\s+(\d+)\s+(\w{3}\s+\w{3}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})(?:\s+(.*))?$/,
    );
    if (!match) {
      complete = false;
      continue;
    }
    const [, pidText = '', pgrpText = '', started = '', command = ''] = match;
    const pid = Number(pidText);
    const pgrp = Number(pgrpText);
    if (!isSafeProcessId(pid) || !isSafeProcessGroupId(pgrp) || processes.has(pid)) {
      complete = false;
      continue;
    }
    processes.set(pid, {
      pid,
      pgrp,
      starttime: `darwin:${started.trim().replace(/\s+/g, '_')}`,
      command,
    });
  }
  return { processes, complete };
}

function isPsOverflow(error: unknown): boolean {
  return error instanceof Error && /maxBuffer|ENOBUFS/u.test(error.message);
}

function darwinProcessQuery(
  batch: readonly number[],
  includeEnvironment: boolean,
  options: ProcessInspectionOptions,
): DarwinProcessParse & { overflow: boolean } {
  try {
    const raw = executeDarwinPs([
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
    ], options);
    return { ...parseDarwinProcesses(raw), overflow: false };
  } catch (error) {
    if (isDarwinNoSelection(error)) {
      return { processes: new Map(), complete: true, overflow: false };
    }
    return { processes: new Map(), complete: false, overflow: isPsOverflow(error) };
  }
}

function darwinProcessIds(options: ProcessInspectionOptions): {
  pids: number[];
  complete: boolean;
} {
  try {
    const seen = new Set<number>();
    for (const line of executeDarwinPs(['-ax', '-o', 'pid='], options).split('\n')) {
      if (line.trim() === '') continue;
      const pid = Number(line.trim());
      if (
        !/^\d+$/u.test(line.trim())
        || !Number.isSafeInteger(pid)
        || pid > MAX_PROCESS_ID
        || seen.has(pid)
      ) {
        return { pids: [], complete: false };
      }
      if (!isSafeProcessId(pid)) continue;
      if (pid !== process.pid) seen.add(pid);
      if (seen.size > MAX_DARWIN_CANDIDATE_PROCESSES) {
        return { pids: [], complete: false };
      }
    }
    return { pids: [...seen], complete: true };
  } catch {
    return { pids: [], complete: false };
  }
}

/** Discover marked processes and report whether the bounded snapshot was complete. */
export function discoverWorkerProcessesForTokens(
  tokens: Iterable<string>,
  scope?: string,
  candidatePids?: Iterable<number>,
  options: ProcessInspectionOptions = {},
): WorkerProcessDiscovery {
  const accepted = new Set([...tokens].filter(isWorkerToken));
  if (accepted.size === 0) return { processes: [], complete: true };
  const candidates =
    candidatePids === undefined
      ? undefined
      : [...new Set(candidatePids)].filter((pid) => isSafeProcessId(pid) && pid !== process.pid);
  if (options.discoverWorkerProcesses !== undefined) {
    const discovered = options.discoverWorkerProcesses([...accepted], scope, candidates);
    const candidateSet = candidates === undefined ? undefined : new Set(candidates);
    const filtered = discovered.processes.filter((entry) =>
      accepted.has(entry.token)
      && isSafeProcessId(entry.pid)
      && entry.pid !== process.pid
      && isSafeProcessGroupId(entry.pgrp)
      && entry.starttime.length > 0
      && (candidateSet === undefined || candidateSet.has(entry.pid)));
    const processes = [...new Map(filtered.map((entry) => [
      `${entry.pid}:${entry.starttime}:${entry.pgrp}:${entry.token}`,
      entry,
    ])).values()];
    return {
      processes,
      complete: discovered.complete
        && filtered.length === discovered.processes.length
        && processes.length === filtered.length,
    };
  }
  const scopeValue = scope === undefined ? undefined : workerScopeValue(scope);
  const platform = inspectionPlatform(options);

  if (platform === 'darwin') {
    if (scopeValue === undefined) return { processes: [], complete: false };
    if (candidates !== undefined && candidates.length === 0) return { processes: [], complete: true };
    const found: TrackedWorkerProcess[] = [];
    const inventory = candidates === undefined
      ? darwinProcessIds(options)
      : { pids: candidates, complete: true };
    if (!inventory.complete) return { processes: [], complete: false };
    const batches: number[][] = [];
    for (let offset = 0; offset < inventory.pids.length; offset += DARWIN_PS_BATCH_SIZE) {
      batches.push(inventory.pids.slice(offset, offset + DARWIN_PS_BATCH_SIZE));
    }
    let queries = candidates === undefined ? 1 : 0;
    let complete = true;
    while (batches.length > 0) {
      if (queries + 2 > MAX_DARWIN_PS_QUERIES) {
        complete = false;
        break;
      }
      const batch = batches.shift()!;
      const commands = darwinProcessQuery(batch, false, options);
      queries++;
      const commandsAndEnvironment = darwinProcessQuery(batch, true, options);
      queries++;
      if (!commands.complete || !commandsAndEnvironment.complete) {
        if (
          batch.length > 1
          && (commands.overflow || commandsAndEnvironment.overflow)
        ) {
          const middle = Math.ceil(batch.length / 2);
          batches.unshift(batch.slice(0, middle), batch.slice(middle));
        } else {
          complete = false;
        }
        continue;
      }
      const observedPids = new Set([
        ...commands.processes.keys(),
        ...commandsAndEnvironment.processes.keys(),
      ]);
      if ([...observedPids].some((pid) =>
        !commands.processes.has(pid) || !commandsAndEnvironment.processes.has(pid))) {
        complete = false;
      }
      for (const expanded of commandsAndEnvironment.processes.values()) {
        const command = commands.processes.get(expanded.pid);
        if (
          command === undefined ||
          command.pgrp !== expanded.pgrp ||
          command.starttime !== expanded.starttime
        ) {
          complete = false;
          continue;
        }
        const environment = expanded.command === command.command
          ? ''
          : expanded.command.startsWith(`${command.command} `)
            ? expanded.command.slice(command.command.length + 1)
            : null;
        if (environment === null) {
          complete = false;
          continue;
        }
        // `ps -E` appends the launch environment to the normal command field.
        // Subtract a separately-read argv field so argv text cannot impersonate
        // lifecycle markers; identity must remain stable across both reads.
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
    if (found.length > MAX_DARWIN_CANDIDATE_PROCESSES) complete = false;
    return {
      processes: found.slice(0, MAX_DARWIN_CANDIDATE_PROCESSES),
      complete,
    };
  }
  if (platform !== 'linux') return { processes: [], complete: false };
  let entries: readonly string[];
  if (candidates !== undefined) {
    entries = candidates.map(String);
  } else {
    try {
      entries = options.listLinuxProcessIds?.() ?? readdirSync('/proc');
    } catch {
      return { processes: [], complete: false };
    }
  }
  const tokenPrefix = `${WORKER_TOKEN_ENV}=`;
  const scopeMarker = scopeValue === undefined ? undefined : `${WORKER_SCOPE_ENV}=${scopeValue}`;
  const found: TrackedWorkerProcess[] = [];
  let complete = true;
  if (candidates === undefined) {
    let effectiveUid: number | undefined;
    try {
      effectiveUid = options.readLinuxEffectiveUid === undefined
        ? (typeof process.geteuid === 'function' ? process.geteuid() : undefined)
        : options.readLinuxEffectiveUid();
    } catch {
      effectiveUid = undefined;
    }
    complete = linuxProcessEnumerationIsAuthoritative(effectiveUid, options);
  }
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    const pid = Number(entry);
    if (!isSafeProcessId(pid) || pid === process.pid) continue;
    let before: ProcStat | undefined;
    try {
      before = linuxProcessIdentity(pid, options);
    } catch {
      before = undefined;
    }
    if (!before) {
      if (signal0Status(pid, options) !== 'absent') complete = false;
      continue;
    }
    if (before.state === 'Z' || before.pgrp === 0) {
      let afterExemption: ProcStat | undefined;
      try {
        afterExemption = linuxProcessIdentity(pid, options);
      } catch {
        afterExemption = undefined;
      }
      if (afterExemption === undefined) {
        if (signal0Status(pid, options) !== 'absent') complete = false;
      } else if (!sameLinuxIdentity(before, afterExemption)) {
        complete = false;
      }
      // Zombies cannot execute or fork, and Linux kernel workers use process
      // group zero and cannot inherit a userspace environment marker.
      continue;
    }
    let environ: string;
    try {
      environ = options.readLinuxProcessEnvironment?.(pid)
        ?? readFileSync(`/proc/${pid}/environ`, 'utf8');
    } catch {
      let afterFailure: ProcStat | undefined;
      try {
        afterFailure = linuxProcessIdentity(pid, options);
      } catch {
        afterFailure = undefined;
      }
      if (afterFailure === undefined) {
        if (signal0Status(pid, options) !== 'absent') complete = false;
        continue;
      }
      if (!sameLinuxIdentity(before, afterFailure)) {
        complete = false;
        continue;
      }
      // A readable environment always gets authenticated first. These exact
      // pre-spawn relationships prove unrelatedness only when environ cannot
      // be inspected and the candidate identity remained stable around the read.
      if (!isExcludedUnreadableLinuxProcess(pid, afterFailure, options)) {
        complete = false;
        continue;
      }
      let finalIdentity: ProcStat | undefined;
      try {
        finalIdentity = linuxProcessIdentity(pid, options);
      } catch {
        finalIdentity = undefined;
      }
      if (finalIdentity === undefined) {
        if (signal0Status(pid, options) !== 'absent') complete = false;
      } else if (!sameLinuxIdentity(afterFailure, finalIdentity)) {
        complete = false;
      }
      continue;
    }
    let after: ProcStat | undefined;
    try {
      after = linuxProcessIdentity(pid, options);
    } catch {
      after = undefined;
    }
    if (!after) {
      if (signal0Status(pid, options) !== 'absent') complete = false;
      continue;
    }
    if (!sameLinuxIdentity(before, after)) {
      complete = false;
      continue;
    }
    const environment = environ.split('\0');
    if (scopeMarker !== undefined && !environment.includes(scopeMarker)) continue;
    const token = environment
      .filter((entry) => entry.startsWith(tokenPrefix))
      .map((entry) => entry.slice(tokenPrefix.length))
      .find((value) => accepted.has(value));
    if (token === undefined) continue;
    found.push({ pid, token, ...after });
  }
  return { processes: found, complete };
}

/** Find marked processes while preserving the legacy Linux-only scan behavior. */
export function findWorkerProcessesForTokens(
  tokens: Iterable<string>,
  scope?: string,
  candidatePids?: Iterable<number>,
  options: ProcessInspectionOptions = {},
): TrackedWorkerProcess[] {
  if (inspectionPlatform(options) === 'darwin' && candidatePids === undefined) return [];
  return discoverWorkerProcessesForTokens(tokens, scope, candidatePids, options).processes;
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

/** Aggregate signaling plus whether complete observations proved stable absence. */
export interface WorkerSettlementResult extends WorkerSignalResult {
  settled: boolean;
}

/** Re-authenticate Darwin lifecycle markers at each individual signal boundary. */
export function darwinWorkerSignalingInspection(
  tokens: Iterable<string>,
  scope: string | undefined,
  options: ProcessInspectionOptions = {},
): ProcessInspectionOptions {
  const accepted = [...new Set([...tokens].filter(isWorkerToken))];
  const forwardSignal = options.signalProcess ?? ((pid: number, signal: NodeJS.Signals | 0) => {
    process.kill(pid, signal);
  });
  return {
    ...options,
    // Darwin's second-granularity lstart can match a same-second PID/PGID
    // replacement. Token and scope are therefore re-read for every target.
    readIdentitySnapshot: (pids) => {
      const authenticated = discoverWorkerProcessesForTokens(
        accepted,
        scope,
        pids,
        options,
      );
      return {
        identities: new Map(authenticated.processes.map((candidate) => [
          candidate.pid,
          { pgrp: candidate.pgrp, starttime: candidate.starttime },
        ])),
        complete: authenticated.complete,
      };
    },
    signalProcess: (target, signal) => {
      const pid = Math.abs(target);
      const authenticated = discoverWorkerProcessesForTokens(
        accepted,
        scope,
        [pid],
        options,
      ).processes.some((candidate) =>
        candidate.pid === pid && (target > 0 || candidate.pgrp === pid));
      if (!authenticated) {
        throw Object.assign(new Error('Darwin worker identity is no longer authenticated'), {
          code: 'ESRCH',
        });
      }
      forwardSignal(target, signal);
    },
  };
}

/** Signal an authenticated snapshot after one final platform-capable identity check. */
export function signalTrackedWorkerProcesses(
  tracked: Iterable<TrackedWorkerProcess>,
  signal: NodeJS.Signals,
  options: ProcessInspectionOptions = {},
): WorkerSignalResult {
  const processesToSignal = [...tracked];
  const platform = inspectionPlatform(options);
  const signaledTokens = new Set<string>();
  const signaledIdentities = new Set<string>();
  let processes = 0;
  const signalProcess = options.signalProcess ?? ((pid: number, sent: NodeJS.Signals | 0) => {
    process.kill(pid, sent);
  });
  if (platform === 'linux') {
    for (const proc of processesToSignal) {
      const live = options.readIdentitySnapshot === undefined
        ? linuxProcessIdentity(proc.pid, options)
        : readProcessIdentitySnapshot([proc.pid], options).identities.get(proc.pid);
      if (!live || live.starttime !== proc.starttime || live.pgrp !== proc.pgrp) continue;
      try {
        signalProcess(proc.pgrp === proc.pid ? -proc.pid : proc.pid, signal);
        processes++;
        signaledTokens.add(proc.token);
        signaledIdentities.add(`${proc.pid}:${proc.starttime}:${proc.pgrp}:${proc.token}`);
      } catch {
        /* raced with exit */
      }
    }
    return { processes, tokens: signaledTokens, identities: signaledIdentities };
  }
  const liveIdentities = readProcessIdentities(
    processesToSignal.map((proc) => proc.pid),
    options,
  );
  for (const proc of processesToSignal) {
    const live = liveIdentities.get(proc.pid);
    if (!live || live.starttime !== proc.starttime || live.pgrp !== proc.pgrp) continue;
    try {
      // An authenticated session leader may have same-group descendants that
      // deliberately replaced their environment. Cover those children without
      // extending group signaling to a marked process inside another PGID.
      signalProcess(proc.pgrp === proc.pid ? -proc.pid : proc.pid, signal);
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
  options: ProcessInspectionOptions = {},
): WorkerSignalResult {
  const accepted = new Set([...tokens].filter(isWorkerToken));
  if (accepted.size === 0) return { processes: 0, tokens: new Set(), identities: new Set() };
  return signalTrackedWorkerProcesses(findWorkerProcessesForTokens(accepted, scope, undefined, options), signal, options);
}

/** Re-scan until complete observations prove stable absence or grace ends unsettled. */
export async function signalWorkerProcessTokensUntilGone(
  tokens: Iterable<string>,
  signal: NodeJS.Signals,
  scope?: string,
  graceMs = 100,
  options: ProcessInspectionOptions = {},
  candidatePids?: Iterable<number>,
): Promise<WorkerSettlementResult> {
  const accepted = new Set([...tokens].filter(isWorkerToken));
  const aggregate: WorkerSignalResult = { processes: 0, tokens: new Set(), identities: new Set() };
  if (accepted.size === 0) return { ...aggregate, settled: true };
  const candidates = candidatePids === undefined ? undefined : [...candidatePids];
  const now = options.observationNow ?? (() => performance.now());
  const wait = options.observationWait ?? sleep;
  const deadline = now() + Math.max(0, graceMs);
  let delayMs = 5;
  let emptyPasses = 0;
  let finalProofUsed = false;
  for (;;) {
    const discovery = discoverWorkerProcessesForTokens(accepted, scope, candidates, options);
    emptyPasses = discovery.complete && discovery.processes.length === 0 ? emptyPasses + 1 : 0;
    const batch = discovery.processes.filter(
      (proc) => !aggregate.identities.has(`${proc.pid}:${proc.starttime}:${proc.pgrp}:${proc.token}`),
    );
    const result = signalTrackedWorkerProcesses(batch, signal, options);
    aggregate.processes += result.processes;
    for (const token of result.tokens) aggregate.tokens.add(token);
    for (const identity of result.identities) aggregate.identities.add(identity);
    if (emptyPasses >= 2) return { ...aggregate, settled: true };
    const observedAt = now();
    if (observedAt >= deadline) {
      if (graceMs > 0 && !finalProofUsed && emptyPasses === 1) {
        finalProofUsed = true;
        await wait(1);
        continue;
      }
      return { ...aggregate, settled: false };
    }
    await wait(Math.min(delayMs, Math.max(1, deadline - observedAt)));
    delayMs = Math.min(delayMs * 2, 25);
  }
}

/** Signal every currently-live process carrying `token`. Re-read procfs on
 *  every call so a later SIGKILL sweep also catches descendants forked while
 *  the graceful signal was in flight. */
export function signalWorkerProcesses(
  token: string,
  signal: NodeJS.Signals,
  scope?: string,
  options: ProcessInspectionOptions = {},
): number {
  return signalWorkerProcessTokens([token], signal, scope, options).processes;
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
