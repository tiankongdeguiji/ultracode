/**
 * Best-effort Linux `/proc/<pid>/stat` reader. Used to bind a recorded worker
 * PGID to the exact process *instance* (via its kernel start-time) so a later
 * force-kill can't be redirected to a recycled — or worker-forged — PID.
 * Returns undefined on any platform without `/proc`, or if the pid is gone.
 */
import { readFileSync } from 'node:fs';

export interface ProcStat {
  /** Process-group id (field 5). A detached worker is its own group leader, so pgrp === pid. */
  pgrp: number;
  /** Kernel start-time in clock ticks since boot (field 22) — unique per process instance. */
  starttime: string;
}

export function readProcStat(pid: number): ProcStat | undefined {
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
  if (!Number.isInteger(pgrp) || starttime === undefined) return undefined;
  return { pgrp, starttime };
}
