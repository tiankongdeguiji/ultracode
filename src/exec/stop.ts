/** Shared stop logic (CLI `stop` and MCP `workflow_stop`). */
import { setTimeout as sleep } from 'node:timers/promises';
import { closeSync, constants, existsSync, fstatSync, openSync, opendirSync, readSync } from 'node:fs';
import { join } from 'node:path';
import { isTerminal, readManifest } from '../store/manifest.js';
import { getRun, isRunnerAlive, reapOrphans } from '../store/runstore.js';
import {
  darwinWorkerSignalingInspection,
  discoverWorkerProcessesForTokens,
  isSafeProcessId,
  isWorkerToken,
  readProcessIdentitySnapshot,
  signalTrackedWorkerProcesses,
  signalWorkerProcessTokens,
  signalWorkerProcessTokensUntilGone,
  type ProcessInspectionOptions,
  type TrackedProcess,
} from './procinfo.js';
import {
  DARWIN_START_IDENTITY_RE,
  MAX_WORKER_CANDIDATE_RECORD_BYTES,
  MAX_WORKER_SEQUENCES,
  parseWorkerCandidateInventory,
  WORKER_RECORD_FILE_NAMES,
  workerCandidateRecordPath,
  workerRecordDir,
  type WorkerCandidateInventory,
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
  candidateInventory?: WorkerCandidateInventory;
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
      const candidateRaw = readWorkerRecord(
        workerCandidateRecordPath(path),
        MAX_WORKER_CANDIDATE_RECORD_BYTES,
      );
      const candidateInventory = candidateRaw === undefined
        ? undefined
        : parseWorkerCandidateInventory(candidateRaw, workerToken);
      tokenRecords.set(workerToken, {
        path,
        token: workerToken,
        ...(candidateInventory === undefined ? {} : { candidateInventory }),
      });
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
  for (const record of groupRecords.values()) {
    const live = verifiedLeaders.get(`${record.pid}:${record.starttime}:${record.token}`);
    // A worker can forge public PID/start-time data in this untrusted file.
    // Signal the group only when the exact leader also carries this record's
    // lifecycle token and run scope in its initial environment.
    if (!live || live.pgrp !== record.pid) continue;
    const result = signalTrackedWorkerProcesses(
      [live],
      'SIGKILL',
      platform === 'darwin'
        ? darwinWorkerSignalingInspection([record.token], runDir, inspection)
        : inspection,
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
  const actedRecords = signalRecordedWorkerGroups(runDir, records);

  // The run scope is checked in each target process's immutable initial
  // environment. Copying another run's readable token into this untrusted
  // record store therefore cannot authorize signaling that run's workers.
  const platform = process.platform;
  const darwinCandidates = platform === 'darwin'
    ? darwinRecoveryCandidates(records)
    : undefined;
  const tokenResult = darwinCandidates === undefined
    ? signalWorkerProcessTokens(records.tokenRecords.keys(), 'SIGKILL', runDir)
    : signalTrackedWorkerProcesses(
        discoverWorkerProcessesForTokens(
          records.tokenRecords.keys(),
          runDir,
          darwinCandidates.pids,
        ).processes,
        'SIGKILL',
        darwinWorkerSignalingInspection(records.tokenRecords.keys(), runDir),
      );
  recordSignaledTokens(actedRecords, records.tokenRecords, tokenResult.tokens);
  return actedRecords.size;
}

interface WorkerCleanupReport {
  killedRecords: number;
  liveLegacyGroups: number;
  manualCleanup?: string;
  settled: boolean;
}

function darwinRecoveryCandidates(records: RecoveryRecords): {
  complete: boolean;
  identities: TrackedProcess[];
  pids: number[];
  unverifiableRecords: number;
} {
  const identities = new Map<string, TrackedProcess>();
  const groupsByToken = new Map<string, WorkerGroupRecord>();
  for (const record of records.groupRecords.values()) {
    if (DARWIN_START_IDENTITY_RE.test(record.starttime) && !groupsByToken.has(record.token)) {
      groupsByToken.set(record.token, record);
    }
  }
  let unverifiableRecords = records.legacyGroupIds.size;
  for (const record of records.tokenRecords.values()) {
    const group = groupsByToken.get(record.token);
    const inventory = record.candidateInventory;
    if (group !== undefined) {
      identities.set(`${group.pid}:${group.starttime}:${group.pid}`, {
        pid: group.pid,
        pgrp: group.pid,
        starttime: group.starttime,
      });
    }
    for (const candidate of inventory?.processes ?? []) {
      identities.set(`${candidate.pid}:${candidate.starttime}:${candidate.pgrp}`, candidate);
    }
    // Candidate sidecars are useful bounded hints, but they live in the same
    // worker-writable store as the primary record. Their `complete` bit cannot
    // prove that a compromised worker did not omit an escaped descendant.
    unverifiableRecords++;
  }
  const processes = [...identities.values()];
  return {
    complete: unverifiableRecords === 0,
    identities: processes,
    pids: [...new Set(processes.map((candidate) => candidate.pid))],
    unverifiableRecords,
  };
}

function candidatesAbsent(
  candidates: readonly TrackedProcess[],
  inspection: ProcessInspectionOptions,
): { absent: boolean; complete: boolean } {
  if (candidates.length === 0) return { absent: true, complete: true };
  const snapshot = readProcessIdentitySnapshot(
    [...new Set(candidates.map((candidate) => candidate.pid))],
    inspection,
  );
  return {
    absent: snapshot.complete && candidates.every((candidate) => {
      const live = snapshot.identities.get(candidate.pid);
      return live === undefined
        || live.starttime !== candidate.starttime
        || live.pgrp !== candidate.pgrp;
    }),
    complete: snapshot.complete,
  };
}

async function cleanupWorkerGroupsUntilGone(
  runDir: string,
  graceMs = 100,
  inspection: ProcessInspectionOptions = {},
): Promise<WorkerCleanupReport> {
  const records = loadRecoveryRecords(runDir);
  const platform = inspection.platform ?? process.platform;
  const actedRecords = signalRecordedWorkerGroups(runDir, records, inspection);
  const darwinCandidates = platform === 'darwin'
    ? darwinRecoveryCandidates(records)
    : undefined;
  const tokenInspection = darwinCandidates === undefined
    ? inspection
    : darwinWorkerSignalingInspection(records.tokenRecords.keys(), runDir, inspection);
  const tokenResult = await signalWorkerProcessTokensUntilGone(
    records.tokenRecords.keys(),
    'SIGKILL',
    runDir,
    graceMs,
    tokenInspection,
    darwinCandidates?.pids,
  );
  recordSignaledTokens(actedRecords, records.tokenRecords, tokenResult.tokens);
  const darwinAbsence = darwinCandidates === undefined
    ? undefined
    : candidatesAbsent(darwinCandidates.identities, inspection);
  const liveLegacyGroups = countLiveLegacyWorkerGroups(records);
  const settled = tokenResult.settled
    && (darwinCandidates?.complete ?? true)
    && (darwinAbsence?.absent ?? true)
    && liveLegacyGroups === 0;
  let manualCleanup: string | undefined;
  if (darwinAbsence !== undefined && !darwinAbsence.complete) {
    manualCleanup = 'Darwin process identity visibility was incomplete; '
      + 'could not verify stable process absence; manual cleanup required';
  } else if (darwinAbsence !== undefined && !darwinAbsence.absent) {
    manualCleanup = 'a Darwin candidate identity remained live after bounded authenticated cleanup; '
      + 'could not verify stable process absence; manual cleanup required';
  } else if (darwinCandidates !== undefined && darwinCandidates.unverifiableRecords > 0) {
    manualCleanup = `${darwinCandidates.unverifiableRecords} Darwin recovery record(s) are permanently unverifiable `
      + '(legacy, token-only, malformed, incomplete, or worker-writable candidate inventory); '
      + 'could not verify stable process absence; manual cleanup required';
  } else if (platform === 'linux' && !settled) {
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

/** Kill workers and throw unless complete observations confirm stable token absence. */
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
    return cleanupStopResult(run.effectiveStatus, `already ${run.effectiveStatus}`, cleanup);
  }
  const pid = run.manifest.pid;
  // isRunnerAlive (not isPidAlive): a live PID whose start-time no longer
  // matches is a recycled PID, not our runner — signaling it would hit an
  // unrelated process. Treat that as already-dead (and reap its workers).
  if (!isRunnerAlive(run.manifest)) {
    const cleanup = await cleanupWorkerGroupsUntilGone(run.dir, 100, inspection);
    reapOrphans(root);
    return cleanupStopResult('orphaned', 'runner already dead; marked orphaned', cleanup);
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
      return cleanupStopResult(m.status, m.status, cleanup);
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
  return cleanupStopResult('stopped', 'force-killed after 7s grace', cleanup);
}
