/** Shared stop logic (CLI `stop` and MCP `workflow_stop`). */
import { setTimeout as sleep } from 'node:timers/promises';
import { isTerminal, readManifest } from '../store/manifest.js';
import { getRun, isPidAlive, reapOrphans } from '../store/runstore.js';

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
  reapOrphans(root);
  return { ok: true, status: 'stopped', message: 'force-killed after 7s grace' };
}
