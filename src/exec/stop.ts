/** Shared stop logic (CLI `stop` and MCP `workflow_stop`). */
import { setTimeout as sleep } from 'node:timers/promises';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isTerminal, readManifest } from '../store/manifest.js';
import { getRun, isRunnerAlive, reapOrphans } from '../store/runstore.js';
import { isWorkerToken, readProcStat, signalWorkerProcesses } from './procinfo.js';

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
  let killed = 0;
  for (const d of readdirSync(agentsDir)) {
    const agentDir = join(agentsDir, d);
    let recordNames: string[];
    try {
      recordNames = readdirSync(agentDir).filter((name) => name === 'pgid' || name.startsWith('pgid.attempt'));
    } catch {
      continue;
    }
    for (const recordName of recordNames) {
      let fields: string[];
      try {
        fields = readFileSync(join(agentDir, recordName), 'utf8').trim().split(/\s+/);
      } catch {
        continue;
      }
      const [pidStr, recordedStart, workerToken] = fields;
      const pid = Number(pidStr);
      let acted = false;
      if (Number.isInteger(pid) && pid > 1 && pid !== process.pid) {
        const live = readProcStat(pid);
        // Linux fails closed when the leader is gone or its identity mismatches;
        // the token sweep below is the safe recovery path for leaderless groups.
        // Platforms without procfs retain the guarded best-effort PGID fallback.
        const groupVerified =
          process.platform !== 'linux' ||
          (live !== undefined && recordedStart !== undefined && live.starttime === recordedStart && live.pgrp === pid);
        if (groupVerified) {
          try {
            process.kill(-pid, 'SIGKILL');
            acted = true;
          } catch {
            /* group already gone */
          }
        }
      }
      if (isWorkerToken(workerToken) && signalWorkerProcesses(workerToken, 'SIGKILL') > 0) acted = true;
      if (acted) killed++;
    }
  }
  return killed;
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
