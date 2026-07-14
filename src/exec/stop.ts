/** Shared stop logic (CLI `stop` and MCP `workflow_stop`). */
import { setTimeout as sleep } from 'node:timers/promises';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isTerminal, readManifest } from '../store/manifest.js';
import { getRun, isPidAlive, reapOrphans } from '../store/runstore.js';
import { readProcStat } from './procinfo.js';

/** Kill recorded worker process groups — used when the runner was SIGKILL'd
 *  unresponsive and never cleaned up its own detached agents.
 *
 *  The `pgid` file lives in the worker-writable run store, so it is UNTRUSTED
 *  input (a prompt-injected worker reading hostile repo content could plant
 *  one). `process.kill(-pid, …)` on a hostile value is catastrophic: `-1`
 *  broadcasts SIGKILL to every process the user owns, `-0` hits our own group.
 *  So we (a) refuse pid ≤ 1 and our own pid, and (b) bind to the exact process
 *  the runner spawned — the recorded kernel start-time must still match, and the
 *  target must be its own group leader (true for our detached workers). A
 *  recycled or forged PID fails one of these. */
export function killWorkerGroups(runDir: string): number {
  const agentsDir = join(runDir, 'agents');
  if (!existsSync(agentsDir)) return 0;
  let killed = 0;
  for (const d of readdirSync(agentsDir)) {
    const pgidFile = join(agentsDir, d, 'pgid');
    if (!existsSync(pgidFile)) continue;
    const [pidStr, recordedStart] = readFileSync(pgidFile, 'utf8').trim().split(/\s+/);
    const pid = Number(pidStr);
    if (!Number.isInteger(pid) || pid <= 1 || pid === process.pid) continue;
    // Verify identity where /proc exists (Linux). Elsewhere `readProcStat` is
    // undefined and we fall back to the pid>1 guard — best-effort, as the whole
    // force-kill path already is.
    const live = readProcStat(pid);
    if (live && (live.pgrp !== pid || (recordedStart && live.starttime !== recordedStart))) continue;
    try {
      process.kill(-pid, 'SIGKILL');
      killed++;
    } catch {
      /* group already gone */
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
    return { ok: true, status: run.effectiveStatus, message: `already ${run.effectiveStatus}` };
  }
  const pid = run.manifest.pid;
  if (!isPidAlive(pid)) {
    reapOrphans(root);
    return { ok: true, status: 'orphaned', message: 'runner already dead; marked orphaned' };
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
