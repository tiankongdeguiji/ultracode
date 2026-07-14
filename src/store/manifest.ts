/**
 * manifest.json: single-writer (the runner), atomic tmp+rename swaps so
 * readers never observe a torn manifest.
 */
import { readFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { writeFileNoFollow } from '../exec/safe-write.js';

export type RunStatus = 'created' | 'running' | 'completed' | 'failed' | 'stopped' | 'orphaned';

export interface RunManifest {
  runId: string;
  name: string;
  title?: string;
  status: RunStatus;
  pid: number;
  /** Kernel start-time of `pid` (Linux) — distinguishes the real runner from a
   *  recycled PID when deciding orphaned-vs-alive and before signaling a stop. */
  pidStart?: string;
  startedAt: string;
  endedAt?: string;
  heartbeatAt: string;
  phases: { title: string; agentsDone: number }[];
  agentCount: number;
  budget: { total: number | null; spent: number };
  backendDefault: string;
  resumedFrom?: string;
  engineVersion: string;
  error?: string;
}

export const HEARTBEAT_INTERVAL_MS = 5_000;
export const HEARTBEAT_STALE_MS = 30_000;

export function manifestPath(dir: string): string {
  return join(dir, 'manifest.json');
}

export function writeManifest(dir: string, manifest: RunManifest): void {
  // The run store is worker-writable and the manifest is rewritten every ~5s by
  // the heartbeat WHILE workers run, so the tmp path (predictable — pid is
  // public in manifest.json) is a symlink-redirect target. Write it O_NOFOLLOW
  // (unlink-first + refuse a symlink leaf) so an injected worker can't redirect
  // the unsandboxed runner's write; the rename to manifest.json stays atomic.
  const tmp = join(dir, `.manifest.${process.pid}.tmp`);
  writeFileNoFollow(tmp, JSON.stringify(manifest, null, 2));
  renameSync(tmp, manifestPath(dir));
}

export function readManifest(dir: string): RunManifest | null {
  try {
    return JSON.parse(readFileSync(manifestPath(dir), 'utf8')) as RunManifest;
  } catch {
    return null;
  }
}

export function isTerminal(status: RunStatus): boolean {
  return status === 'completed' || status === 'failed' || status === 'stopped' || status === 'orphaned';
}
