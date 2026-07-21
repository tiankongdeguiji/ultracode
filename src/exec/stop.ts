/** Shared stop logic (CLI `stop` and MCP `workflow_stop`). */
import { setTimeout as sleep } from 'node:timers/promises';
import { closeSync, constants, existsSync, fstatSync, openSync, opendirSync, readSync } from 'node:fs';
import { join } from 'node:path';
import { isTerminal, readManifest, writeManifest } from '../store/manifest.js';
import { getRun, isRunnerAlive, reapOrphans } from '../store/runstore.js';
import {
  darwinWorkerSignalingInspection,
  discoverWorkerProcessesForTokens,
  isSafeProcessId,
  isWorkerToken,
  signal0Status,
  signalTrackedWorkerProcesses,
  signalWorkerProcessTokens,
  signalWorkerProcessTokensUntilGone,
  type ProcessInspectionOptions,
  withDarwinPsQueryBudget,
} from './procinfo.js';
import {
  MAX_WORKER_SEQUENCES,
  WORKER_RECORD_FILE_NAMES,
  workerRecordDir,
} from './worker-record.js';

// One initial attempt, five task retries, and two schema repairs are the
// maximum ordinals the engine can create. `-fresh` shares that ordinal.
const WORKER_RECORD_RE = /^pgid(?:\.attempt[1-8](?:-fresh)?)?$/;
const MAX_LEGACY_WORKER_RECORDS = 2_048;
const MAX_AGENT_ENTRIES = 2_048;
const MAX_WORKER_RECORDS_PER_AGENT = 16;
const MAX_RECORD_ENTRIES_PER_AGENT = 64;
const MAX_WORKER_RECORD_BYTES = 512;

function collectLegacyWorkerRecordPaths(agentsDir: string): string[] {
  const records: string[] = [];
  const perAgentRecords: string[][] = [];
  let agents;
  try {
    agents = opendirSync(agentsDir);
  } catch {
    return records;
  }
  let agentEntries = 0;
  try {
    for (;;) {
      if (agentEntries >= MAX_AGENT_ENTRIES) break;
      const agent = agents.readSync();
      if (!agent) break;
      agentEntries++;
      if (!agent.isDirectory()) continue;
      const agentDir = join(agentsDir, agent.name);
      let files;
      try {
        files = opendirSync(agentDir);
      } catch {
        continue;
      }
      const agentRecords: string[] = [];
      let recordEntries = 0;
      try {
        for (;;) {
          if (
            agentRecords.length >= MAX_WORKER_RECORDS_PER_AGENT ||
            recordEntries >= MAX_RECORD_ENTRIES_PER_AGENT
          ) {
            break;
          }
          const file = files.readSync();
          if (!file) break;
          recordEntries++;
          if (WORKER_RECORD_RE.test(file.name)) agentRecords.push(join(agentDir, file.name));
        }
      } finally {
        try {
          files.closeSync();
        } catch {
          /* already closed */
        }
      }
      if (agentRecords.length > 0) perAgentRecords.push(agentRecords);
    }
  } finally {
    try {
      agents.closeSync();
    } catch {
      /* already closed */
    }
  }
  // Take one record from every agent before taking a second from any agent.
  // A compromised worker can fill its own directory, but cannot consume the
  // global recovery budget and hide another agent's cleanup record.
  for (let offset = 0; records.length < MAX_LEGACY_WORKER_RECORDS; offset++) {
    let added = false;
    for (const agentRecords of perAgentRecords) {
      const path = agentRecords[offset];
      if (path === undefined) continue;
      records.push(path);
      added = true;
      if (records.length >= MAX_LEGACY_WORKER_RECORDS) break;
    }
    if (!added) break;
  }
  return records;
}

function collectWorkerRecordPaths(runDir: string): string[] {
  const records: string[] = [];
  // Fixed addressing prevents worker-created directory entries from consuming
  // a discovery quota before a real sibling record is reached.
  if (existsSync(join(runDir, 'worker-records'))) {
    for (let seq = 0; seq < MAX_WORKER_SEQUENCES; seq++) {
      const recordDir = workerRecordDir(runDir, seq);
      if (!existsSync(recordDir)) continue;
      for (const name of WORKER_RECORD_FILE_NAMES) records.push(join(recordDir, name));
    }
  }
  records.push(...collectLegacyWorkerRecordPaths(join(runDir, 'agents')));
  return records;
}

function readWorkerRecord(path: string, maxBytes = MAX_WORKER_RECORD_BYTES): string | undefined {
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size <= 0 || stat.size > maxBytes) return undefined;
    const buffer = Buffer.alloc(Number(stat.size));
    const bytes = readSync(fd, buffer, 0, buffer.length, 0);
    return buffer.toString('utf8', 0, bytes);
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        /* already closed */
      }
    }
  }
}

interface RecoveryRecords {
  groupRecords: Map<string, WorkerGroupRecord>;
  legacyGroupIds: Set<number>;
  tokenRecords: Map<string, WorkerTokenRecord>;
}

interface WorkerGroupRecord {
  path: string;
  pid: number;
  starttime: string;
  token: string;
}

interface WorkerTokenRecord {
  path: string;
  token: string;
}

function loadRecoveryRecords(runDir: string): RecoveryRecords {
  const groupRecords = new Map<string, WorkerGroupRecord>();
  const legacyGroupIds = new Set<number>();
  const tokenRecords = new Map<string, WorkerTokenRecord>();
  for (const path of collectWorkerRecordPaths(runDir)) {
    const raw = readWorkerRecord(path);
    if (raw === undefined) continue;
    const fields = raw.trim().split(/\s+/);
    if (fields.length > 3) continue;
    const [pidStr, recordedStart, workerToken] = fields;
    const pid = Number(pidStr);
    if (fields.length < 3 && isSafeProcessId(pid) && pid !== process.pid) {
      legacyGroupIds.add(pid);
      continue;
    }
    if (
      isSafeProcessId(pid) &&
      pid !== process.pid &&
      recordedStart !== undefined &&
      isWorkerToken(workerToken)
    ) {
      groupRecords.set(`${pid}:${recordedStart}:${workerToken}`, {
        path,
        pid,
        starttime: recordedStart,
        token: workerToken,
      });
    }
    if (isWorkerToken(workerToken) && !tokenRecords.has(workerToken)) {
      tokenRecords.set(workerToken, { path, token: workerToken });
    }
  }
  return { groupRecords, legacyGroupIds, tokenRecords };
}

function countLiveLegacyWorkerGroups(records: RecoveryRecords): number {
  const liveGroups = new Set<number>();
  for (const pid of records.legacyGroupIds) {
    // The old leader may already be gone while same-PGID helpers remain. A
    // signal-0 probe can surface that group without authorizing a real signal.
    try {
      process.kill(-pid, 0);
      liveGroups.add(pid);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EPERM') liveGroups.add(pid);
    }
  }
  return liveGroups.size;
}

function signalRecordedWorkerGroups(
  runDir: string,
  records: RecoveryRecords,
  inspection: ProcessInspectionOptions = {},
): Set<string> {
  const { groupRecords, tokenRecords } = records;
  const actedRecords = new Set<string>();
  const platform = inspection.platform ?? process.platform;
  const verifiedLeaders = new Map(
    discoverWorkerProcessesForTokens(
      tokenRecords.keys(),
      runDir,
      [...groupRecords.values()].map((record) => record.pid),
      inspection,
    ).processes.map((proc) => [`${proc.pid}:${proc.starttime}:${proc.token}`, proc]),
  );
  if (platform === 'darwin') {
    const authenticated = [...groupRecords.values()].flatMap((record) => {
      const live = verifiedLeaders.get(`${record.pid}:${record.starttime}:${record.token}`);
      return live?.pgrp === record.pid ? [live] : [];
    });
    const result = signalTrackedWorkerProcesses(
      authenticated,
      'SIGKILL',
      darwinWorkerSignalingInspection(tokenRecords.keys(), runDir, inspection),
    );
    for (const record of groupRecords.values()) {
      if (result.identities.has(`${record.pid}:${record.starttime}:${record.pid}:${record.token}`)) {
        actedRecords.add(record.path);
      }
    }
    return actedRecords;
  }
  for (const record of groupRecords.values()) {
    const live = verifiedLeaders.get(`${record.pid}:${record.starttime}:${record.token}`);
    // A worker can forge public PID/start-time data in this untrusted file.
    // Signal the group only when the exact leader also carries this record's
    // lifecycle token and run scope in its initial environment.
    if (!live || live.pgrp !== record.pid) continue;
    const result = signalTrackedWorkerProcesses(
      [live],
      'SIGKILL',
      inspection,
    );
    if (result.processes > 0) {
      actedRecords.add(record.path);
    }
  }
  return actedRecords;
}

function recordSignaledTokens(
  actedRecords: Set<string>,
  tokenRecords: Map<string, WorkerTokenRecord>,
  tokens: Iterable<string>,
): void {
  for (const token of tokens) {
    const record = tokenRecords.get(token);
    if (record) actedRecords.add(record.path);
  }
}

/** Kill recorded worker process groups and one Linux token snapshot.
 *
 * The records live in the worker-writable run store, so they are UNTRUSTED.
 * Group signaling requires an exact live leader identity, lifecycle token, and
 * run scope; token matching contains descendants that left the original PGID. */
export function killWorkerGroups(runDir: string): number {
  const records = loadRecoveryRecords(runDir);
  const inspection = process.platform === 'darwin'
    ? withDarwinPsQueryBudget({ platform: 'darwin' })
    : {};
  const actedRecords = signalRecordedWorkerGroups(runDir, records, inspection);

  // The run scope is checked in each target process's immutable initial
  // environment. Copying another run's readable token into this untrusted
  // record store therefore cannot authorize signaling that run's workers.
  if (process.platform === 'linux') {
    const tokenResult = signalWorkerProcessTokens(records.tokenRecords.keys(), 'SIGKILL', runDir);
    recordSignaledTokens(actedRecords, records.tokenRecords, tokenResult.tokens);
  }
  return actedRecords.size;
}

interface WorkerCleanupReport {
  killedRecords: number;
  liveLegacyGroups: number;
  manualCleanup?: string;
  settled: boolean;
}

async function settleDarwinWorkerGroups(
  runDir: string,
  records: RecoveryRecords,
  graceMs: number,
  inspection: ProcessInspectionOptions,
): Promise<{ settled: boolean; unverifiableRecords: number }> {
  const groups = [...records.groupRecords.values()];
  const groupTokens = new Set(groups.map((record) => record.token));
  const unverifiableRecords = [...records.tokenRecords.keys()]
    .filter((token) => !groupTokens.has(token)).length;
  if (groups.length === 0) {
    return { settled: records.tokenRecords.size === 0, unverifiableRecords };
  }
  const tokens = [...new Set(groups.map((record) => record.token))];
  const pids = [...new Set(groups.map((record) => record.pid))];
  const passes = new Map(groups.map((record) => [
    `${record.pid}:${record.starttime}:${record.token}`,
    0,
  ]));
  const retiredPids = new Set<number>();
  const now = inspection.observationNow ?? (() => performance.now());
  const wait = inspection.observationWait ?? sleep;
  const deadline = now() + Math.max(0, graceMs);
  const signalingInspection = darwinWorkerSignalingInspection(
    tokens,
    runDir,
    inspection,
  );
  for (;;) {
    const discovery = discoverWorkerProcessesForTokens(tokens, runDir, pids, inspection);
    const live = new Map(discovery.processes.map((candidate) => [
      `${candidate.pid}:${candidate.starttime}:${candidate.token}`,
      candidate,
    ]));
    const authenticated = groups.flatMap((record) => {
      if (retiredPids.has(record.pid)) return [];
      const candidate = live.get(`${record.pid}:${record.starttime}:${record.token}`);
      return candidate?.pgrp === record.pid ? [candidate] : [];
    });
    signalTrackedWorkerProcesses(authenticated, 'SIGKILL', signalingInspection);
    for (const record of groups) {
      const key = `${record.pid}:${record.starttime}:${record.token}`;
      const candidate = live.get(key);
      const groupStatus = signal0Status(-record.pid, inspection);
      if (groupStatus === 'absent') retiredPids.add(record.pid);
      const absent = discovery.complete
        && candidate === undefined
        && groupStatus === 'absent';
      passes.set(key, absent ? (passes.get(key) ?? 0) + 1 : 0);
    }
    if ([...passes.values()].every((count) => count >= 2)) {
      return { settled: unverifiableRecords === 0, unverifiableRecords };
    }
    const observedAt = now();
    if (observedAt >= deadline) return { settled: false, unverifiableRecords };
    await wait(Math.min(25, Math.max(1, deadline - observedAt)));
  }
}

async function cleanupWorkerGroupsUntilGone(
  runDir: string,
  graceMs = 100,
  inspection: ProcessInspectionOptions = {},
): Promise<WorkerCleanupReport> {
  const records = loadRecoveryRecords(runDir);
  const platform = inspection.platform ?? process.platform;
  const boundedInspection = platform === 'darwin'
    ? withDarwinPsQueryBudget(inspection)
    : inspection;
  const actedRecords = signalRecordedWorkerGroups(runDir, records, boundedInspection);
  const liveLegacyGroups = countLiveLegacyWorkerGroups(records);
  if (platform === 'darwin') {
    const darwin = await settleDarwinWorkerGroups(runDir, records, graceMs, boundedInspection);
    const settled = darwin.settled && liveLegacyGroups === 0;
    const manualCleanup = settled
      ? undefined
      : darwin.unverifiableRecords > 0
        ? `${darwin.unverifiableRecords} Darwin recovery record(s) lack an authenticated leader; `
          + 'manual cleanup required'
        : 'Darwin detached process-group absence could not be verified; manual cleanup required. '
          + 'Descendants that changed session or process group may have escaped cleanup';
    return {
      killedRecords: actedRecords.size,
      liveLegacyGroups,
      ...(manualCleanup === undefined ? {} : { manualCleanup }),
      settled,
    };
  }
  const tokenResult = await signalWorkerProcessTokensUntilGone(
    records.tokenRecords.keys(),
    'SIGKILL',
    runDir,
    graceMs,
    inspection,
  );
  recordSignaledTokens(actedRecords, records.tokenRecords, tokenResult.tokens);
  const settled = tokenResult.settled && liveLegacyGroups === 0;
  let manualCleanup: string | undefined;
  if (platform === 'linux' && !settled) {
    manualCleanup = 'the persisted Linux scan had incomplete process visibility or no trusted containment proof; '
      + 'could not verify stable process absence; manual verification and cleanup required';
  }
  return {
    killedRecords: actedRecords.size,
    liveLegacyGroups,
    ...(manualCleanup === undefined ? {} : { manualCleanup }),
    settled,
  };
}

/** Kill workers and require visible Linux token absence or recorded Darwin group absence. */
export async function killWorkerGroupsUntilGone(
  runDir: string,
  graceMs = 100,
  inspection: ProcessInspectionOptions = {},
): Promise<number> {
  const report = await cleanupWorkerGroupsUntilGone(runDir, graceMs, inspection);
  if (!report.settled) {
    throw new Error(report.manualCleanup ?? 'worker cleanup did not reach verified stable process absence');
  }
  return report.killedRecords;
}

export interface StopResult {
  ok: boolean;
  status: string;
  message: string;
}

function cleanupStopResult(status: string, message: string, report: WorkerCleanupReport): StopResult {
  const killed = report.killedRecords ? ` (+${report.killedRecords} worker record(s))` : '';
  const manual = [
    report.manualCleanup,
    report.liveLegacyGroups === 0
      ? undefined
      : `${report.liveLegacyGroups} unauthenticated legacy worker group(s) still active; manual cleanup required`,
  ].filter((reason): reason is string => reason !== undefined);
  if (manual.length > 0) {
    return {
      ok: false,
      status,
      message: `${message}${killed}; ${manual.join('; ')}`,
    };
  }
  if (!report.settled) {
    return {
      ok: false,
      status,
      message: `${message}${killed}; worker cleanup could not verify stable process absence; retry required`,
    };
  }
  return { ok: true, status, message: `${message}${killed}` };
}

function persistCleanupOutcome(
  runDir: string,
  manifest: NonNullable<ReturnType<typeof readManifest>>,
  settledStatus: string,
  message: string,
  report: WorkerCleanupReport,
): StopResult {
  if (!report.settled) {
    const reason = report.manualCleanup ?? 'worker cleanup did not reach verified stable absence';
    writeManifest(runDir, {
      ...manifest,
      status: 'cleanup-failed',
      endedAt: manifest.endedAt ?? new Date().toISOString(),
      heartbeatAt: new Date().toISOString(),
      error: manifest.error?.includes(reason) ? manifest.error : [manifest.error, reason].filter(Boolean).join('; '),
    });
    return cleanupStopResult('cleanup-failed', message, report);
  }
  if (manifest.status === 'cleanup-failed' || settledStatus === 'orphaned') {
    writeManifest(runDir, {
      ...manifest,
      status: 'stopped',
      heartbeatAt: new Date().toISOString(),
    });
    return cleanupStopResult('stopped', 'worker cleanup verified; marked stopped', report);
  }
  return cleanupStopResult(settledStatus, message, report);
}

export async function stopRun(
  root: string,
  runId: string,
  inspection: ProcessInspectionOptions = {},
): Promise<StopResult> {
  const run = getRun(root, runId);
  if (!run) return { ok: false, status: 'unknown', message: `no run ${runId} under ${root}` };
  if (isTerminal(run.effectiveStatus)) {
    // A hard-stop can finalize as `stopped` immediately before process.exit(),
    // and a backend can leave setsid() descendants after any terminal outcome.
    // Stale records are therefore actionable for every terminal status.
    const cleanup = await cleanupWorkerGroupsUntilGone(run.dir, 100, inspection);
    return persistCleanupOutcome(
      run.dir,
      run.manifest,
      run.effectiveStatus,
      `already ${run.effectiveStatus}`,
      cleanup,
    );
  }
  const pid = run.manifest.pid;
  // isRunnerAlive (not isPidAlive): a live PID whose start-time no longer
  // matches is a recycled PID, not our runner — signaling it would hit an
  // unrelated process. Treat that as already-dead (and reap its workers).
  if (!isRunnerAlive(run.manifest)) {
    const cleanup = await cleanupWorkerGroupsUntilGone(run.dir, 100, inspection);
    reapOrphans(root);
    return persistCleanupOutcome(
      run.dir,
      readManifest(run.dir) ?? run.manifest,
      'orphaned',
      'runner already dead; marked orphaned',
      cleanup,
    );
  }
  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    /* raced */
  }
  const deadline = Date.now() + 7_000;
  while (Date.now() < deadline) {
    const m = readManifest(run.dir);
    if (m && isTerminal(m.status)) {
      const cleanup = await cleanupWorkerGroupsUntilGone(run.dir, 100, inspection);
      return persistCleanupOutcome(run.dir, m, m.status, m.status, cleanup);
    }
    await sleep(200);
  }
  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    /* gone */
  }
  // The runner was unresponsive → it never killed its detached agent groups;
  // do it here so workers don't keep running/mutating files after "stopped".
  const cleanup = await cleanupWorkerGroupsUntilGone(run.dir, 100, inspection);
  reapOrphans(root);
  return persistCleanupOutcome(
    run.dir,
    readManifest(run.dir) ?? run.manifest,
    'stopped',
    'force-killed after 7s grace',
    cleanup,
  );
}
