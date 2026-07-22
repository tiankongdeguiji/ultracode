/** Deterministic bounded Darwin groups and unchanged Linux recovery visibility. */
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readProcessIdentity, type ProcessInspectionOptions } from '../../src/exec/procinfo.js';
import { killActiveWorkers, spawnAgentProcess } from '../../src/exec/spawn.js';
import { stopRun } from '../../src/exec/stop.js';
import { workerRecordDir, workerRecordPath } from '../../src/exec/worker-record.js';
import { newRunId } from '../../src/store/layout.js';
import { readManifest, writeManifest } from '../../src/store/manifest.js';
import { createRunDir, getRun } from '../../src/store/runstore.js';

const TOKEN = 'b'.repeat(32);
const DARWIN_START = 'darwin:Mon_Jul_20_12:00:00_2026';
const LEADER = { pid: 20_101, pgrp: 20_101, starttime: DARWIN_START };
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function stoppedRun(name: string): { directory: string; root: string; runId: string } {
  const root = mkdtempSync(join(tmpdir(), `uc-${name}-`));
  roots.push(root);
  const runId = newRunId();
  const directory = createRunDir(root, {
    runId,
    name,
    source: 'return null',
    args: null,
    config: { backend: 'mock', cwd: root },
  });
  const run = getRun(root, runId)!;
  writeManifest(directory, {
    ...run.manifest,
    status: 'stopped',
    endedAt: new Date(0).toISOString(),
  });
  mkdirSync(workerRecordDir(directory, 0), { recursive: true });
  return { directory, root, runId };
}

function writeLeaderRecord(directory: string): void {
  writeFileSync(
    workerRecordPath(directory, 0, 1),
    `${LEADER.pid} ${LEADER.starttime} ${TOKEN}`,
  );
}

describe('Darwin live cleanup', () => {
  it('signals only the detached process group and proves stable absence', async () => {
    let groupLive = true;
    let clock = 0;
    const signals: Array<[number, NodeJS.Signals]> = [];
    const spawned = spawnAgentProcess(process.execPath, ['-e', ''], {
      cwd: process.cwd(),
      env: {},
      processInspection: {
        platform: 'darwin',
        discoverWorkerProcesses: () => { throw new Error('live Darwin cleanup must not discover processes'); },
        signalProcess: (target, signal) => {
          if (signal === 0) {
            if (!groupLive) throw Object.assign(new Error('gone'), { code: 'ESRCH' });
            return;
          }
          signals.push([target, signal]);
          groupLive = false;
        },
        observationNow: () => clock,
        observationWait: async (delayMs) => { clock += delayMs; },
      },
    });
    await new Promise<void>((resolve) => spawned.child.once('exit', () => resolve()));

    await expect(spawned.cleanupEscaped(50)).resolves.toBe(0);

    expect(signals).toEqual([[-spawned.child.pid!, 'SIGTERM']]);
  });

  it('fails closed when group state is unknown', async () => {
    let nonzeroSignals = 0;
    const spawned = spawnAgentProcess(process.execPath, ['-e', ''], {
      cwd: process.cwd(),
      env: {},
      processInspection: {
        platform: 'darwin',
        signalProcess: (_target, signal) => {
          if (signal === 0) throw Object.assign(new Error('unknown'), { code: 'EIO' });
          nonzeroSignals += 1;
        },
      },
    });
    await new Promise<void>((resolve) => spawned.child.once('exit', () => resolve()));

    await expect(spawned.cleanupEscaped(0)).resolves.toBeGreaterThan(0);
    expect(nonzeroSignals).toBe(0);
  });

  it('never signals a numeric PGID after observing it absent', async () => {
    let signals = 0;
    let clock = 0;
    let probes = 0;
    const spawned = spawnAgentProcess(process.execPath, ['-e', ''], {
      cwd: process.cwd(),
      env: {},
      processInspection: {
        platform: 'darwin',
        signalProcess: (_target, signal) => {
          if (signal === 0) {
            probes += 1;
            if (probes === 1) throw Object.assign(new Error('gone'), { code: 'ESRCH' });
            return;
          }
          signals += 1;
        },
        observationNow: () => clock,
        observationWait: async (delayMs) => { clock += delayMs; },
      },
    });
    await new Promise<void>((resolve) => spawned.child.once('exit', () => resolve()));

    await expect(spawned.cleanupEscaped(50)).resolves.toBeGreaterThan(0);
    expect(probes).toBeGreaterThan(1);
    expect(signals).toBe(0);
  });
});

describe('persisted Darwin recovery', () => {
  it('makes an orphan resumable only after verified recovery', async () => {
    const run = stoppedRun('darwin-orphan');
    const manifest = readManifest(run.directory)!;
    writeManifest(run.directory, { ...manifest, status: 'orphaned' });

    const result = await stopRun(run.root, run.runId, { platform: 'darwin' });

    expect(result).toMatchObject({ ok: true, status: 'stopped' });
    expect(readManifest(run.directory)?.status).toBe('stopped');
  });

  it('inspects and signals only recorded worker leader PIDs', async () => {
    const run = stoppedRun('darwin-leader');
    writeLeaderRecord(run.directory);
    let live = true;
    let clock = 0;
    const candidates: Array<readonly number[] | undefined> = [];
    const signals: number[] = [];
    const inspection: ProcessInspectionOptions = {
      platform: 'darwin',
      discoverWorkerProcesses: (tokens, _scope, candidatePids) => {
        candidates.push(candidatePids);
        return {
          complete: true,
          processes: live ? [{ ...LEADER, token: tokens[0]! }] : [],
        };
      },
      signalProcess: (target, signal) => {
        if (signal === 0) {
          if (!live) throw Object.assign(new Error('gone'), { code: 'ESRCH' });
          return;
        }
        signals.push(target);
        live = false;
      },
      observationNow: () => clock,
      observationWait: async (delayMs) => { clock += delayMs; },
    };

    const result = await stopRun(run.root, run.runId, inspection);

    expect(result).toMatchObject({ ok: true, status: 'stopped' });
    expect(signals).toEqual([-LEADER.pid]);
    expect(candidates.length).toBeGreaterThan(0);
    expect(candidates.every((value) => value?.length === 1 && value[0] === LEADER.pid)).toBe(true);
  });

  it('does not signal a reused recorded PID or PGID', async () => {
    const run = stoppedRun('darwin-reused-leader');
    writeLeaderRecord(run.directory);
    let clock = 0;
    let signals = 0;
    const result = await stopRun(run.root, run.runId, {
      platform: 'darwin',
      discoverWorkerProcesses: (_tokens, _scope, candidates) => {
        expect(candidates).toEqual([LEADER.pid]);
        return { complete: true, processes: [] };
      },
      signalProcess: (_target, signal) => {
        if (signal !== 0) signals += 1;
      },
      observationNow: () => clock,
      observationWait: async (delayMs) => { clock += delayMs; },
    });

    expect(result).toMatchObject({ ok: false, status: 'cleanup-failed' });
    expect(signals).toBe(0);
    expect(readManifest(run.directory)?.status).toBe('cleanup-failed');
  });
});

describe('persisted Linux recovery', () => {
  it('terminates a live authenticated runner even when its manifest claims completion', async () => {
    if (process.platform !== 'linux') return;
    const run = stoppedRun('terminal-live-runner');
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 60_000)']);
    const identity = readProcessIdentity(child.pid!);
    expect(identity).toBeDefined();
    const manifest = readManifest(run.directory)!;
    writeManifest(run.directory, {
      ...manifest,
      status: 'completed',
      pid: child.pid!,
      pidStart: identity!.starttime,
    });

    const exited = once(child, 'exit');
    const result = await stopRun(run.root, run.runId);
    await exited;

    expect(result).toMatchObject({ ok: true, status: 'completed' });
  });

  it('batches fatal token discovery once for workers in one scope', async () => {
    const discoveries: string[][] = [];
    let baselineSnapshots = 0;
    const inspection: ProcessInspectionOptions = {
      platform: 'linux',
      listLinuxProcessIds: () => {
        baselineSnapshots += 1;
        return [];
      },
      discoverWorkerProcesses: (tokens) => {
        discoveries.push([...tokens]);
        return { processes: [], complete: true };
      },
    };
    const first = spawnAgentProcess(process.execPath, ['-e', 'setInterval(() => {}, 1_000)'], {
      cwd: process.cwd(),
      env: {},
      workerScope: '/shared-fatal-scope',
      processInspection: inspection,
    });
    const second = spawnAgentProcess(process.execPath, ['-e', 'setInterval(() => {}, 1_000)'], {
      cwd: process.cwd(),
      env: {},
      workerScope: '/shared-fatal-scope',
      processInspection: inspection,
    });
    const exits = [once(first.child, 'exit'), once(second.child, 'exit')];

    expect(killActiveWorkers()).toBe(2);
    await Promise.all(exits);
    expect(baselineSnapshots).toBe(1);
    expect(discoveries).toHaveLength(1);
    expect(new Set(discoveries[0])).toEqual(new Set([first.workerToken, second.workerToken]));
    await expect(first.cleanupEscaped(50)).resolves.toBe(0);
    await expect(second.cleanupEscaped(50)).resolves.toBe(0);
  });

  it('reports inaccessible unrelated processes as a visibility limitation, not a retry promise', async () => {
    const run = stoppedRun('linux-inaccessible');
    writeLeaderRecord(run.directory);
    const inaccessiblePid = 303;
    const inaccessible = { pid: inaccessiblePid, pgrp: inaccessiblePid, starttime: '200' };
    let clock = 0;
    const inspection: ProcessInspectionOptions = {
      platform: 'linux',
      listLinuxProcessIds: () => [String(inaccessiblePid)],
      readLinuxEffectiveUid: () => 0,
      readLinuxProcessIdentity: (pid) => pid === inaccessiblePid ? inaccessible : undefined,
      readLinuxProcessOwner: () => 1_000,
      readLinuxProcessEnvironment: () => {
        throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
      },
      signalProcess: (_pid, signal) => {
        if (signal === 0) throw Object.assign(new Error('no such process'), { code: 'ESRCH' });
      },
      observationNow: () => clock,
      observationWait: async (delayMs) => { clock += delayMs; },
    };

    const result = await stopRun(run.root, run.runId, inspection);

    expect(result).toMatchObject({ ok: false, status: 'cleanup-failed' });
    expect(result.message).toMatch(/incomplete process visibility|no trusted containment proof/u);
    expect(result.message).toContain('manual verification and cleanup required');
    expect(result.message).not.toContain('retry required');
    expect(readManifest(run.directory)?.status).toBe('cleanup-failed');
  });
});
