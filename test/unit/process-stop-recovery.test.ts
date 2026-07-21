/** Deterministic persisted worker recovery across Darwin and Linux visibility limits. */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type {
  AgentEvent,
  AgentRequest,
  AgentSpec,
  BackendAdapter,
  SpawnPlan,
} from '../../src/backends/types.js';
import { ZERO_USAGE } from '../../src/backends/types.js';
import { AgentCallExecutor } from '../../src/engine/agentcall.js';
import type { ProcessInspectionOptions } from '../../src/exec/procinfo.js';
import { spawnAgentProcess } from '../../src/exec/spawn.js';
import { stopRun } from '../../src/exec/stop.js';
import {
  MAX_WORKER_CANDIDATE_RECORD_BYTES,
  parseWorkerCandidateInventory,
  serializeWorkerCandidateInventory,
  workerCandidateRecordPath,
  workerRecordDir,
  workerRecordPath,
} from '../../src/exec/worker-record.js';
import { newRunId } from '../../src/store/layout.js';
import { writeManifest } from '../../src/store/manifest.js';
import { createRunDir, getRun } from '../../src/store/runstore.js';

const TOKEN = 'b'.repeat(32);
const DARWIN_START = 'darwin:Mon_Jul_20_12:00:00_2026';
const LEADER = { pid: 20_101, pgrp: 20_101, starttime: DARWIN_START };
const DESCENDANT = { pid: 20_202, pgrp: 20_202, starttime: DARWIN_START };
const SECOND_DESCENDANT = { pid: 20_303, pgrp: 20_303, starttime: DARWIN_START };
const roots: string[] = [];
const SIGNAL = new AbortController().signal;

class ImmediateAdapter implements BackendAdapter {
  readonly id = 'mock' as const;
  readonly structuredOutput = 'emulated' as const;

  probe() {
    return Promise.resolve({ available: true });
  }

  buildSpawn(_req: AgentRequest): SpawnPlan {
    return { bin: process.execPath, argv: ['-e', ''], env: {} };
  }

  buildResume(): SpawnPlan | null {
    return null;
  }

  createParser() {
    return { push: (_line: string): AgentEvent[] => [], end: (): AgentEvent[] => [] };
  }

  classifyExit() {
    return { ok: true as const, retryable: false, message: 'ok' };
  }

  extractUsage() {
    return ZERO_USAGE;
  }
}

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

function writeRecoveryRecord(
  directory: string,
  body: string,
  candidates?: readonly { pid: number; pgrp: number; starttime: string }[],
  complete = true,
): void {
  const path = workerRecordPath(directory, 0, 1);
  writeFileSync(path, body);
  if (candidates !== undefined) {
    writeFileSync(
      workerCandidateRecordPath(path),
      serializeWorkerCandidateInventory(TOKEN, candidates, complete),
    );
  }
}

describe('persisted stop recovery', () => {
  it('allows one delayed Darwin proof after global discovery consumes the KILL grace', async () => {
    let clock = 0;
    let observations = 0;
    const waits: number[] = [];
    const spawned = spawnAgentProcess(process.execPath, ['-e', ''], {
      cwd: process.cwd(),
      env: {},
      processInspection: {
        platform: 'darwin',
        discoverWorkerProcesses: (_tokens, _scope, candidates) => {
          if (candidates !== undefined) return { processes: [], complete: true };
          observations++;
          clock += 50;
          return { processes: [], complete: true };
        },
        readIdentitySnapshot: () => ({ identities: new Map(), complete: true }),
        signalProcess: (_pid, signal) => {
          if (signal !== 0) return;
          if (observations >= 2) {
            throw Object.assign(new Error('no such process'), { code: 'ESRCH' });
          }
          throw Object.assign(new Error('inspection unavailable'), { code: 'EIO' });
        },
        observationNow: () => clock,
        observationWait: async (delayMs) => {
          waits.push(delayMs);
          clock += delayMs;
        },
      },
    });
    await new Promise<void>((resolvePromise) => spawned.child.once('exit', () => resolvePromise()));

    await expect(spawned.cleanupEscaped(50)).resolves.toBe(0);

    expect(observations).toBe(3);
    expect(waits).toEqual([1]);
  });

  it('keeps zero-grace Darwin cleanup fail-closed without a proof wait', async () => {
    let clock = 0;
    let observations = 0;
    let zeroGrace = true;
    const spawned = spawnAgentProcess(process.execPath, ['-e', ''], {
      cwd: process.cwd(),
      env: {},
      processInspection: {
        platform: 'darwin',
        discoverWorkerProcesses: (_tokens, _scope, candidates) => {
          if (candidates !== undefined) return { processes: [], complete: true };
          observations++;
          return { processes: [], complete: true };
        },
        readIdentitySnapshot: () => ({ identities: new Map(), complete: true }),
        signalProcess: (_pid, signal) => {
          if (signal === 0) {
            throw Object.assign(new Error('no such process'), { code: 'ESRCH' });
          }
        },
        observationNow: () => clock,
        observationWait: async (delayMs) => {
          if (zeroGrace) throw new Error('zero-grace cleanup must not wait');
          clock += delayMs;
        },
      },
    });
    await new Promise<void>((resolvePromise) => spawned.child.once('exit', () => resolvePromise()));

    try {
      await expect(spawned.cleanupEscaped(0)).resolves.toBeGreaterThan(0);
      expect(observations).toBe(2);
    } finally {
      zeroGrace = false;
      await spawned.cleanupEscaped(1);
    }
  });

  it('keeps a point-in-time Darwin inventory unsealed when live cleanup does not settle', async () => {
    const workerScope = mkdtempSync(join(tmpdir(), 'uc-darwin-hook-'));
    roots.push(workerScope);
    const candidate = { pid: 30_303, pgrp: 30_303, starttime: DARWIN_START };
    let discoveries = 0;
    const inspection: ProcessInspectionOptions = {
      platform: 'darwin',
      discoverWorkerProcesses: (tokens) => {
        discoveries++;
        if (discoveries > 1) throw new Error('inspection failed after durable hook');
        return {
          complete: true,
          processes: [{ ...candidate, token: tokens[0]! }],
        };
      },
      readIdentitySnapshot: (pids) => ({
        complete: true,
        identities: new Map(pids.map((pid) => [pid, {
          pgrp: pid,
          starttime: DARWIN_START,
        }])),
      }),
      signalProcess: (_pid, signal) => {
        if (signal === 0) throw Object.assign(new Error('no such process'), { code: 'ESRCH' });
      },
    };
    const spec: AgentSpec = {
      seq: 0,
      prompt: 'persist inventory',
      label: 'inventory',
      backend: 'mock',
      cwd: workerScope,
      retries: 0,
    };

    await expect(new AgentCallExecutor(new ImmediateAdapter(), {
      workerScope,
      processInspection: inspection,
    }).execute(spec, SIGNAL)).rejects.toThrow(/inspection failed/u);

    const processPath = workerRecordPath(workerScope, 0, 1);
    const token = readFileSync(processPath, 'utf8').trim().split(/\s+/u)[2]!;
    const inventory = parseWorkerCandidateInventory(
      readFileSync(workerCandidateRecordPath(processPath), 'utf8'),
      token,
    );
    expect(inventory).toEqual({ complete: false, processes: [candidate] });
  });

  it('re-authenticates live Darwin candidates individually before signaling', async () => {
    const workerScope = mkdtempSync(join(tmpdir(), 'uc-darwin-live-reauth-'));
    roots.push(workerScope);
    const marked = new Set([DESCENDANT.pid, SECOND_DESCENDANT.pid]);
    const candidatesByPid = new Map([
      [DESCENDANT.pid, DESCENDANT],
      [SECOND_DESCENDANT.pid, SECOND_DESCENDANT],
    ]);
    const signals: number[] = [];
    const inventories: boolean[] = [];
    const spawned = spawnAgentProcess(process.execPath, ['-e', ''], {
      cwd: workerScope,
      env: {},
      workerScope,
      onWorkerCandidates: (_token, _candidates, complete) => inventories.push(complete),
      processInspection: {
        platform: 'darwin',
        discoverWorkerProcesses: (tokens, _scope, candidates) => ({
          complete: true,
          processes: (candidates ?? [...candidatesByPid.keys()])
            .filter((pid) => marked.has(pid))
            .map((pid) => ({ ...candidatesByPid.get(pid)!, token: tokens[0]! })),
        }),
        // Public lstart identity cannot distinguish the same-second replacement.
        readIdentitySnapshot: (pids) => ({
          complete: true,
          identities: new Map(pids.flatMap((pid) => {
            const candidate = candidatesByPid.get(pid);
            return candidate === undefined ? [] : [[pid, candidate] as const];
          })),
        }),
        signalProcess: (pid, signal) => {
          if (signal === 0) throw Object.assign(new Error('no such process'), { code: 'ESRCH' });
          signals.push(pid);
          marked.clear();
        },
      },
    });
    await new Promise<void>((resolvePromise) => spawned.child.once('exit', () => resolvePromise()));

    await expect(spawned.cleanupEscaped(0)).resolves.toBeGreaterThan(0);

    expect(signals).toEqual([-DESCENDANT.pid]);
    expect(inventories.length).toBeGreaterThan(0);
    expect(inventories.every((complete) => !complete)).toBe(true);
  });

  it('re-authenticates a same-second Darwin PID/PGID replacement immediately before signaling', async () => {
    const run = stoppedRun('darwin-reuse');
    writeRecoveryRecord(
      run.directory,
      `${LEADER.pid} ${LEADER.starttime} ${TOKEN}`,
      [LEADER],
    );
    let discoveries = 0;
    let clock = 0;
    const signals: Array<[number, NodeJS.Signals | 0]> = [];
    const inspection: ProcessInspectionOptions = {
      platform: 'darwin',
      discoverWorkerProcesses: (tokens, _scope, candidates) => {
        if (candidates?.length === 0) return { complete: true, processes: [] };
        discoveries++;
        expect(candidates).toEqual([LEADER.pid]);
        return discoveries === 1
          ? {
              complete: true,
              processes: [{ ...LEADER, token: tokens[0]! }],
            }
          : { complete: true, processes: [] };
      },
      // Darwin lstart has one-second resolution, so the unmarked replacement
      // is deliberately indistinguishable by public PID/PGID/start identity.
      readIdentitySnapshot: () => ({
        complete: true,
        identities: new Map([[LEADER.pid, LEADER]]),
      }),
      signalProcess: (pid, signal) => { signals.push([pid, signal]); },
      observationNow: () => clock,
      observationWait: async (delayMs) => { clock += delayMs; },
    };

    const result = await stopRun(run.root, run.runId, inspection);

    expect(signals).toEqual([]);
    expect(result).toMatchObject({ ok: false, status: 'stopped' });
    expect(result.message).toMatch(/remained live after bounded authenticated cleanup.*manual cleanup required/u);
  });

  it('re-authenticates every Darwin candidate at its individual signal boundary', async () => {
    const run = stoppedRun('darwin-batched-reuse');
    writeRecoveryRecord(
      run.directory,
      `${LEADER.pid} ${LEADER.starttime} ${TOKEN}`,
      [DESCENDANT, SECOND_DESCENDANT],
    );
    const marked = new Set([DESCENDANT.pid, SECOND_DESCENDANT.pid]);
    const candidatesByPid = new Map([
      [DESCENDANT.pid, DESCENDANT],
      [SECOND_DESCENDANT.pid, SECOND_DESCENDANT],
    ]);
    const signals: number[] = [];
    let clock = 0;

    const result = await stopRun(run.root, run.runId, {
      platform: 'darwin',
      discoverWorkerProcesses: (tokens, _scope, candidates) => ({
        complete: true,
        processes: (candidates ?? [])
          .filter((pid) => marked.has(pid))
          .map((pid) => ({ ...candidatesByPid.get(pid)!, token: tokens[0]! })),
      }),
      // The second process is replaced within the same lstart second after the
      // first signal, so only its missing lifecycle markers distinguish it.
      readIdentitySnapshot: () => ({
        complete: true,
        identities: new Map([[SECOND_DESCENDANT.pid, SECOND_DESCENDANT]]),
      }),
      signalProcess: (pid) => {
        signals.push(pid);
        marked.clear();
      },
      observationNow: () => clock,
      observationWait: async (delayMs) => { clock += delayMs; },
    });

    expect(signals).toEqual([-DESCENDANT.pid]);
    expect(result).toMatchObject({ ok: false, status: 'stopped' });
    expect(result.message).toMatch(/remained live after bounded authenticated cleanup/u);
  });

  it('treats a complete worker-writable Darwin inventory only as bounded signaling hints', async () => {
    const run = stoppedRun('darwin-inventory');
    writeRecoveryRecord(
      run.directory,
      `${LEADER.pid} ${LEADER.starttime} ${TOKEN}`,
      [DESCENDANT],
    );
    const candidateSets: number[][] = [];
    let clock = 0;
    const result = await stopRun(run.root, run.runId, {
      platform: 'darwin',
      discoverWorkerProcesses: (_tokens, _scope, candidates) => {
        candidateSets.push([...(candidates ?? [])]);
        return { complete: true, processes: [] };
      },
      readIdentitySnapshot: (pids) => ({
        complete: true,
        identities: new Map(pids.map((pid) => [pid, { pgrp: pid, starttime: 'replacement' }])),
      }),
      signalProcess: () => { throw new Error('verified-absent candidates must not be signaled'); },
      observationNow: () => clock,
      observationWait: async (delayMs) => { clock += delayMs; },
    });

    expect(result).toMatchObject({ ok: false, status: 'stopped' });
    expect(result.message).toMatch(/worker-writable candidate inventory.*manual cleanup required/u);
    expect(candidateSets.length).toBeGreaterThanOrEqual(2);
    expect(candidateSets.some((pids) => pids.toSorted((left, right) => left - right)
      .join(',') === `${LEADER.pid},${DESCENDANT.pid}`)).toBe(true);
  });

  it('reports legacy and token-only Darwin records as permanently manual', async () => {
    const run = stoppedRun('darwin-manual');
    writeRecoveryRecord(run.directory, `- - ${TOKEN}`);
    const legacyDir = join(run.directory, 'agents', '0000-legacy');
    mkdirSync(legacyDir, { recursive: true });
    writeFileSync(join(legacyDir, 'pgid'), `2147483000 ${DARWIN_START}`);
    let clock = 0;

    const result = await stopRun(run.root, run.runId, {
      platform: 'darwin',
      discoverWorkerProcesses: (_tokens, _scope, candidates) => {
        expect(candidates).toEqual([]);
        return { complete: true, processes: [] };
      },
      observationNow: () => clock,
      observationWait: async (delayMs) => { clock += delayMs; },
    });

    expect(result).toMatchObject({ ok: false, status: 'stopped' });
    expect(result.message).toContain('permanently unverifiable');
    expect(result.message).toContain('manual cleanup required');
    expect(result.message).not.toContain('retry required');
  });

  it('rejects an oversized Darwin inventory without broadening recovery discovery', async () => {
    const run = stoppedRun('darwin-oversized');
    const path = workerRecordPath(run.directory, 0, 1);
    writeFileSync(path, `${LEADER.pid} ${LEADER.starttime} ${TOKEN}`);
    writeFileSync(
      workerCandidateRecordPath(path),
      'x'.repeat(MAX_WORKER_CANDIDATE_RECORD_BYTES + 1),
    );
    const candidateSets: Array<readonly number[] | undefined> = [];
    let clock = 0;
    const result = await stopRun(run.root, run.runId, {
      platform: 'darwin',
      discoverWorkerProcesses: (_tokens, _scope, candidates) => {
        candidateSets.push(candidates);
        return { complete: true, processes: [] };
      },
      readIdentitySnapshot: () => ({ complete: true, identities: new Map() }),
      observationNow: () => clock,
      observationWait: async (delayMs) => { clock += delayMs; },
    });

    expect(candidateSets.every((candidates) => (candidates?.length ?? 0) <= 1)).toBe(true);
    expect(result).toMatchObject({ ok: false, status: 'stopped' });
    expect(result.message).toMatch(/permanently unverifiable.*manual cleanup required/u);
  });

  it('reports inaccessible unrelated Linux processes as a visibility limitation, not a retry promise', async () => {
    const run = stoppedRun('linux-inaccessible');
    writeRecoveryRecord(run.directory, `${LEADER.pid} 100 ${TOKEN}`);
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

    expect(result).toMatchObject({ ok: false, status: 'stopped' });
    expect(result.message).toMatch(/incomplete process visibility|no trusted containment proof/u);
    expect(result.message).toContain('manual verification and cleanup required');
    expect(result.message).not.toContain('retry required');
  });
});
