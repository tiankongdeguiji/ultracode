/**
 * Detached runner launch. There is NO daemon: every run is its own detached
 * process (`ultracode __runner --run-dir <dir>`), coordinating exclusively
 * through the on-disk run store. If the launching CLI, the MCP server, or
 * the host agent dies, the run keeps executing.
 */
import { openSync, closeSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { readManifest } from '../store/manifest.js';
import { WORKER_SCOPE_ENV, WORKER_TOKEN_ENV } from './procinfo.js';

/**
 * Resolve how to re-invoke ourselves. Built (dist/): plain node + main.js.
 * Dev/tests (src/*.ts via tsx or vitest): node --import tsx + main.ts.
 */
export function resolveRunnerEntry(): string[] {
  const here = fileURLToPath(import.meta.url); // .../src/exec/daemonize.ts or .../dist/exec/daemonize.js
  if (here.endsWith('.ts')) {
    // Absolute loader URL so the child resolves tsx regardless of its cwd.
    // createRequire (not import.meta.resolve): vitest's SSR transform does
    // not implement the latter.
    const tsxLoader = pathToFileURL(createRequire(here).resolve('tsx')).href;
    return [process.execPath, '--import', tsxLoader, join(dirname(here), '../cli/main.ts')];
  }
  return [process.execPath, join(dirname(here), '../cli/main.js')];
}

export interface LaunchResult {
  pid: number;
}

export async function launchRunner(dir: string, opts: { startTimeoutMs?: number } = {}): Promise<LaunchResult> {
  const entry = resolveRunnerEntry();
  const logFd = openSync(join(dir, 'runner.log'), 'a');
  const env = { ...process.env };
  // An explicitly allowed nested run starts a new lifecycle. Carrying its
  // caller's worker token would let the outer attempt reap this detached runner.
  delete env[WORKER_TOKEN_ENV];
  delete env[WORKER_SCOPE_ENV];
  const child = spawn(entry[0]!, [...entry.slice(1), '__runner', '--run-dir', dir], {
    detached: true,
    stdio: ['ignore', logFd, logFd],
    env,
  });
  closeSync(logFd);
  const pid = child.pid;
  if (!pid) throw new Error('failed to spawn runner process');

  let exited = false;
  child.on('exit', () => {
    exited = true;
  });
  child.unref();

  const deadline = Date.now() + (opts.startTimeoutMs ?? 15_000);
  for (;;) {
    const manifest = readManifest(dir);
    if (manifest && manifest.status !== 'created') return { pid };
    if (exited && (!manifest || manifest.status === 'created')) {
      throw new Error(`runner exited before starting; see ${join(dir, 'runner.log')}`);
    }
    if (Date.now() > deadline) {
      throw new Error(`runner did not start within ${opts.startTimeoutMs ?? 15_000}ms; see ${join(dir, 'runner.log')}`);
    }
    await sleep(50);
  }
}
