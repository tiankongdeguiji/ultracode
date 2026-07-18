/** Shared stop logic (CLI `stop` and MCP `workflow_stop`). */
import { setTimeout as sleep } from 'node:timers/promises';
import { closeSync, constants, existsSync, fstatSync, openSync, opendirSync, readSync } from 'node:fs';
import { join } from 'node:path';
import { isTerminal, readManifest } from '../store/manifest.js';
import { getRun, isRunnerAlive, reapOrphans } from '../store/runstore.js';
import {
  findWorkerProcessesForTokens,
  isSafeProcessId,
  isWorkerToken,
  readProcessIdentity,
  signalWorkerProcessTokens,
  signalWorkerProcessTokensUntilGone,
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

function readWorkerRecord(path: string): string | undefined {
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_WORKER_RECORD_BYTES) return undefined;
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
  groupRecords: Map<string, { path: string; pid: number; starttime: string; token: string }>;
  tokenRecords: Map<string, string>;
}

function loadRecoveryRecords(runDir: string): RecoveryRecords {
  const groupRecords = new Map<string, { path: string; pid: number; starttime: string; token: string }>();
  const tokenRecords = new Map<string, string>();
  for (const path of collectWorkerRecordPaths(runDir)) {
    const raw = readWorkerRecord(path);
    if (raw === undefined) continue;
    const fields = raw.trim().split(/\s+/);
    if (fields.length < 2 || fields.length > 3) continue;
    const [pidStr, recordedStart, workerToken] = fields;
    const pid = Number(pidStr);
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
    if (isWorkerToken(workerToken) && !tokenRecords.has(workerToken)) tokenRecords.set(workerToken, path);
  }
  return { groupRecords, tokenRecords };
}

function signalRecordedWorkerGroups(runDir: string, records: RecoveryRecords): Set<string> {
  const { groupRecords, tokenRecords } = records;
  const actedRecords = new Set<string>();
  const verifiedLeaders = new Map(
    findWorkerProcessesForTokens(
      tokenRecords.keys(),
      runDir,
      [...groupRecords.values()].map((record) => record.pid),
    ).map((proc) => [`${proc.pid}:${proc.starttime}:${proc.token}`, proc]),
  );
  for (const record of groupRecords.values()) {
    const live = verifiedLeaders.get(`${record.pid}:${record.starttime}:${record.token}`);
    // A worker can forge public PID/start-time data in this untrusted file.
    // Signal the group only when the exact leader also carries this record's
    // lifecycle token and run scope in its initial environment.
    if (!live || live.pgrp !== record.pid) continue;
    const immediate = findWorkerProcessesForTokens([record.token], runDir, [record.pid])[0];
    if (
      !immediate ||
      immediate.pid !== record.pid ||
      immediate.pgrp !== record.pid ||
      immediate.starttime !== record.starttime
    ) {
      continue;
    }
    const finalIdentity = readProcessIdentity(record.pid);
    if (!finalIdentity || finalIdentity.pgrp !== record.pid || finalIdentity.starttime !== record.starttime) continue;
    try {
      process.kill(-record.pid, 'SIGKILL');
      actedRecords.add(record.path);
    } catch {
      /* group already gone */
    }
  }
  return actedRecords;
}

function recordSignaledTokens(
  actedRecords: Set<string>,
  tokenRecords: Map<string, string>,
  tokens: Iterable<string>,
): void {
  for (const token of tokens) {
    const path = tokenRecords.get(token);
    if (path) actedRecords.add(path);
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
  const tokenResult = signalWorkerProcessTokens(records.tokenRecords.keys(), 'SIGKILL', runDir);
  recordSignaledTokens(actedRecords, records.tokenRecords, tokenResult.tokens);
  return actedRecords.size;
}

/** Kill workers, then asynchronously confirm stable token absence. */
export async function killWorkerGroupsUntilGone(runDir: string, graceMs = 100): Promise<number> {
  const records = loadRecoveryRecords(runDir);
  const actedRecords = signalRecordedWorkerGroups(runDir, records);
  const tokenResult = await signalWorkerProcessTokensUntilGone(
    records.tokenRecords.keys(),
    'SIGKILL',
    runDir,
    graceMs,
  );
  recordSignaledTokens(actedRecords, records.tokenRecords, tokenResult.tokens);
  return actedRecords.size;
}

export interface StopResult {
  ok: boolean;
  status: string;
  message: string;
}

export async function stopRun(root: string, runId: string): Promise<StopResult> {
  const run = getRun(root, runId);
  if (!run) return { ok: false, status: 'unknown', message: `no run ${runId} under ${root}` };
  if (isTerminal(run.effectiveStatus)) {
    // A hard-stop can finalize as `stopped` immediately before process.exit(),
    // and a backend can leave setsid() descendants after any terminal outcome.
    // Stale records are therefore actionable for every terminal status.
    const killed = await killWorkerGroupsUntilGone(run.dir);
    return {
      ok: true,
      status: run.effectiveStatus,
      message: `already ${run.effectiveStatus}${killed ? ` (+${killed} stale worker record(s))` : ''}`,
    };
  }
  const pid = run.manifest.pid;
  // isRunnerAlive (not isPidAlive): a live PID whose start-time no longer
  // matches is a recycled PID, not our runner — signaling it would hit an
  // unrelated process. Treat that as already-dead (and reap its workers).
  if (!isRunnerAlive(run.manifest)) {
    const killed = await killWorkerGroupsUntilGone(run.dir);
    reapOrphans(root);
    return {
      ok: true,
      status: 'orphaned',
      message: `runner already dead; marked orphaned${killed ? ` (+${killed} worker group(s))` : ''}`,
    };
  }
  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    /* raced */
  }
  const deadline = Date.now() + 7_000;
  while (Date.now() < deadline) {
    const m = readManifest(run.dir);
    if (m && isTerminal(m.status)) return { ok: true, status: m.status, message: m.status };
    await sleep(200);
  }
  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    /* gone */
  }
  // The runner was unresponsive → it never killed its detached agent groups;
  // do it here so workers don't keep running/mutating files after "stopped".
  const killedGroups = await killWorkerGroupsUntilGone(run.dir);
  reapOrphans(root);
  return {
    ok: true,
    status: 'stopped',
    message: `force-killed after 7s grace${killedGroups ? ` (+${killedGroups} worker group(s))` : ''}`,
  };
}
