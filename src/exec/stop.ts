/** Shared stop logic (CLI `stop` and MCP `workflow_stop`). */
import { setTimeout as sleep } from 'node:timers/promises';
import { closeSync, constants, existsSync, fstatSync, openSync, opendirSync, readSync } from 'node:fs';
import { join } from 'node:path';
import { isTerminal, readManifest } from '../store/manifest.js';
import { getRun, isRunnerAlive, reapOrphans } from '../store/runstore.js';
import { isWorkerToken, readProcessIdentities, signalWorkerProcessTokens } from './procinfo.js';

const WORKER_RECORD_RE = /^pgid(?:\.attempt[1-9]\d*(?:-fresh)?)?$/;
const MAX_WORKER_RECORDS = 1_024;
const MAX_AGENT_ENTRIES = 2_048;
const MAX_RECORD_ENTRIES = 8_192;
const MAX_WORKER_RECORD_BYTES = 512;

function collectWorkerRecordPaths(agentsDir: string): string[] {
  const records: string[] = [];
  let agents;
  try {
    agents = opendirSync(agentsDir);
  } catch {
    return records;
  }
  let agentEntries = 0;
  let recordEntries = 0;
  try {
    for (;;) {
      if (records.length >= MAX_WORKER_RECORDS || agentEntries >= MAX_AGENT_ENTRIES) break;
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
      try {
        for (;;) {
          if (records.length >= MAX_WORKER_RECORDS || recordEntries >= MAX_RECORD_ENTRIES) break;
          const file = files.readSync();
          if (!file) break;
          recordEntries++;
          if (WORKER_RECORD_RE.test(file.name)) records.push(join(agentDir, file.name));
        }
      } finally {
        try {
          files.closeSync();
        } catch {
          /* already closed */
        }
      }
      if (recordEntries >= MAX_RECORD_ENTRIES) break;
    }
  } finally {
    try {
      agents.closeSync();
    } catch {
      /* already closed */
    }
  }
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

/** Kill recorded worker process groups and token-tracked Linux descendants —
 *  used when the runner could not finish its own detached-agent cleanup.
 *
 *  The `pgid*` records live in the worker-writable run store, so they are UNTRUSTED
 *  input (a prompt-injected worker reading hostile repo content could plant
 *  one). `process.kill(-pid, …)` on a hostile value is catastrophic: `-1`
 *  broadcasts SIGKILL to every process the user owns, `-0` hits our own group.
 *  So we (a) refuse pid ≤ 1 and our own pid, and (b) bind a live group leader to
 *  the recorded kernel start-time. The third field is a high-entropy lifecycle
 *  token: on Linux it also finds descendants that escaped the PGID via setsid(). */
export function killWorkerGroups(runDir: string): number {
  const agentsDir = join(runDir, 'agents');
  if (!existsSync(agentsDir)) return 0;
  const groupRecords = new Map<string, { path: string; pid: number; starttime: string }>();
  const tokenRecords = new Map<string, string>();
  for (const path of collectWorkerRecordPaths(agentsDir)) {
    const raw = readWorkerRecord(path);
    if (raw === undefined) continue;
    const fields = raw.trim().split(/\s+/);
    if (fields.length < 2 || fields.length > 3) continue;
    const [pidStr, recordedStart, workerToken] = fields;
    const pid = Number(pidStr);
    if (Number.isInteger(pid) && pid > 1 && pid !== process.pid && recordedStart !== undefined) {
      groupRecords.set(`${pid}:${recordedStart}`, { path, pid, starttime: recordedStart });
    }
    if (isWorkerToken(workerToken) && !tokenRecords.has(workerToken)) tokenRecords.set(workerToken, path);
  }

  const actedRecords = new Set<string>();
  const identities = readProcessIdentities([...groupRecords.values()].map((record) => record.pid));
  for (const record of groupRecords.values()) {
    const live = identities.get(record.pid);
    // Fail closed when the leader is gone or its OS start-time identity
    // mismatches. Linux's scoped token sweep below is the recovery path for
    // leaderless groups; macOS safely remains process-group-only.
    if (!live || live.starttime !== record.starttime || live.pgrp !== record.pid) continue;
    try {
      process.kill(-record.pid, 'SIGKILL');
      actedRecords.add(record.path);
    } catch {
      /* group already gone */
    }
  }

  // The run scope is checked in each target process's immutable initial
  // environment. Copying another run's readable token into this untrusted
  // record store therefore cannot authorize signaling that run's workers.
  const tokenResult = signalWorkerProcessTokens(tokenRecords.keys(), 'SIGKILL', runDir);
  for (const token of tokenResult.tokens) {
    const path = tokenRecords.get(token);
    if (path) actedRecords.add(path);
  }
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
    const killed = killWorkerGroups(run.dir);
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
    const killed = killWorkerGroups(run.dir);
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
  const killedGroups = killWorkerGroups(run.dir);
  reapOrphans(root);
  return {
    ok: true,
    status: 'stopped',
    message: `force-killed after 7s grace${killedGroups ? ` (+${killedGroups} worker group(s))` : ''}`,
  };
}
