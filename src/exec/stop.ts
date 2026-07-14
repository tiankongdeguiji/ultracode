/** Shared stop logic (CLI `stop` and MCP `workflow_stop`). */
import { setTimeout as sleep } from 'node:timers/promises';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isTerminal, readManifest } from '../store/manifest.js';
import { getRun, isPidAlive, reapOrphans } from '../store/runstore.js';

/** Kill recorded worker process groups — used when the runner was SIGKILL'd
 *  unresponsive and never cleaned up its own detached agents. */
function killWorkerGroups(runDir: string): number {
  const agentsDir = join(runDir, 'agents');
  if (!existsSync(agentsDir)) return 0;
  let killed = 0;
  for (const d of readdirSync(agentsDir)) {
    const pgidFile = join(agentsDir, d, 'pgid');
    if (!existsSync(pgidFile)) continue;
    const pid = Number(readFileSync(pgidFile, 'utf8').trim());
    if (Number.isInteger(pid) && pid > 0) {
      try {
        process.kill(-pid, 'SIGKILL');
        killed++;
      } catch {
        /* group already gone */
      }
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
