/**
 * manifest.json: single-writer (the runner), atomic tmp+rename swaps so
 * readers never observe a torn manifest.
 */
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export type RunStatus = 'created' | 'running' | 'completed' | 'failed' | 'stopped' | 'orphaned';

export interface RunManifest {
  runId: string;
  name: string;
  title?: string;
  status: RunStatus;
  pid: number;
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
  const tmp = join(dir, `.manifest.${process.pid}.tmp`);
  writeFileSync(tmp, JSON.stringify(manifest, null, 2), 'utf8');
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
