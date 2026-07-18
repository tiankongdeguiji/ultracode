/**
 * Integration coverage for worker descendants that leave the worker's process
 * group. Codex's Linux sandbox uses new sessions, so kill(-pgid) alone cannot
 * contain every command it launches.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { describe, expect, it } from 'vitest';
import type { AgentEvent, AgentRequest, AgentSpec, BackendAdapter, ExitClass, SpawnPlan } from '../../src/backends/types.js';
import { ZERO_USAGE } from '../../src/backends/types.js';
import { AgentCallExecutor } from '../../src/engine/agentcall.js';
import { readProcStat } from '../../src/exec/procinfo.js';
import { spawnAgentProcess } from '../../src/exec/spawn.js';
import { killWorkerGroups } from '../../src/exec/stop.js';

const SIGNAL = new AbortController().signal;

class EscapingAdapter implements BackendAdapter {
  readonly id = 'mock' as const;
  readonly structuredOutput = 'emulated' as const;

  constructor(
    private readonly pidFile: string,
    private readonly hang = false,
  ) {}

  probe() {
    return Promise.resolve({ available: true });
  }

  buildSpawn(_req: AgentRequest): SpawnPlan {
    const escapedSource = 'setInterval(() => {}, 60_000)';
    const source = [
      "const { spawn } = require('node:child_process')",
      "const { writeFileSync } = require('node:fs')",
      `const escaped = spawn(process.execPath, ['-e', ${JSON.stringify(escapedSource)}], { detached: true, stdio: 'ignore', env: process.env })`,
      `writeFileSync(${JSON.stringify(this.pidFile)}, String(escaped.pid))`,
      'escaped.unref()',
      this.hang ? 'setInterval(() => {}, 60_000)' : "process.stdout.write('done\\n')",
    ].join(';');
    return { bin: process.execPath, argv: ['-e', source], env: {} };
  }

  buildResume(_sessionId: string, _prompt: string, _req: AgentRequest): SpawnPlan | null {
    return null;
  }

  createParser() {
    return {
      push(line: string): AgentEvent[] {
        return line === 'done' ? [{ kind: 'result', isError: false }, { kind: 'message', text: 'ok' }] : [];
      },
      end: (): AgentEvent[] => [],
    };
  }

  classifyExit(code: number | null, _signal: NodeJS.Signals | null, events: AgentEvent[]): ExitClass {
    const done = events.some((event) => event.kind === 'result' && !event.isError);
    return code === 0 && done
      ? { ok: true, retryable: false, message: 'ok' }
      : { ok: false, errorKind: 'infra', retryable: false, message: `exit ${code}` };
  }

  extractUsage() {
    return ZERO_USAGE;
  }
}

async function waitForPid(file: string): Promise<number> {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    if (existsSync(file)) return Number(readFileSync(file, 'utf8'));
    await sleep(25);
  }
  throw new Error('escaped child pid was not written');
}

async function waitUntilGone(pid: number): Promise<boolean> {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    if (!readProcStat(pid)) return true;
    await sleep(25);
  }
  return false;
}

describe('escaped worker descendant cleanup', () => {
  it('reaps a descendant that creates a new session before the worker exits', async () => {
    if (process.platform !== 'linux') return;
    const pidFile = join(mkdtempSync(join(tmpdir(), 'uc-escaped-')), 'pid');
    const spec: AgentSpec = {
      seq: 0,
      prompt: 'spawn an escaped helper',
      label: 'escape',
      backend: 'mock',
      cwd: process.cwd(),
      retries: 0,
    };

    const outcome = await new AgentCallExecutor(new EscapingAdapter(pidFile)).execute(spec, SIGNAL);
    const escapedPid = await waitForPid(pidFile);
    try {
      expect(outcome.ok).toBe(true);
      expect(await waitUntilGone(escapedPid)).toBe(true);
    } finally {
      try {
        process.kill(-escapedPid, 'SIGKILL');
      } catch {
        /* already gone */
      }
    }
  });

  it('reaps the escaped session when an attempt timeout terminates the worker', async () => {
    if (process.platform !== 'linux') return;
    const pidFile = join(mkdtempSync(join(tmpdir(), 'uc-escaped-timeout-')), 'pid');
    const spec: AgentSpec = {
      seq: 0,
      prompt: 'spawn an escaped helper and hang',
      label: 'escape-timeout',
      backend: 'mock',
      cwd: process.cwd(),
      retries: 0,
      timeoutMs: 250,
    };

    const pending = new AgentCallExecutor(new EscapingAdapter(pidFile, true)).execute(spec, SIGNAL);
    const escapedPid = await waitForPid(pidFile);
    try {
      const outcome = await pending;
      expect(outcome.ok).toBe(false);
      expect(outcome.error).toContain('attempt timed out');
      expect(await waitUntilGone(escapedPid)).toBe(true);
    } finally {
      try {
        process.kill(-escapedPid, 'SIGKILL');
      } catch {
        /* already gone */
      }
    }
  });

  it('re-signals token descendants spawned during graceful cleanup', async () => {
    if (process.platform !== 'linux') return;
    const dir = mkdtempSync(join(tmpdir(), 'uc-escaped-chain-'));
    const scriptFile = join(dir, 'chain.cjs');
    const readyFile = join(dir, 'ready');
    writeFileSync(
      scriptFile,
      [
        "const { spawn } = require('node:child_process');",
        "const { writeFileSync } = require('node:fs');",
        'const generation = Number(process.argv[2]);',
        `if (generation === 0) writeFileSync(${JSON.stringify(readyFile)}, '1');`,
        'let handled = false;',
        "process.on('SIGTERM', () => {",
        '  if (handled) return;',
        '  handled = true;',
        '  if (generation < 2) {',
        "    const child = spawn(process.execPath, [__filename, String(generation + 1)], { detached: true, stdio: 'ignore', env: process.env });",
        '    child.unref();',
        '  }',
        '  setTimeout(() => process.exit(0), 10);',
        '});',
        'setInterval(() => {}, 60_000);',
      ].join('\n'),
    );
    const launcher = spawnAgentProcess(process.execPath, [scriptFile, '0'], {
      cwd: process.cwd(),
      env: {},
    });
    try {
      await waitForPid(readyFile);
      const started = Date.now();
      expect(await launcher.cleanupEscaped(1_000)).toBe(0);
      expect(Date.now() - started).toBeLessThan(700);
    } finally {
      launcher.killTree('SIGKILL');
    }
  });

  it('uses the persisted token after the recorded process-group leader is gone', async () => {
    if (process.platform !== 'linux') return;
    const runDir = mkdtempSync(join(tmpdir(), 'uc-escaped-recovery-'));
    const agentDir = join(runDir, 'agents', '0000-escape');
    const pidFile = join(runDir, 'escaped.pid');
    mkdirSync(agentDir, { recursive: true });
    const escapedSource = 'setInterval(() => {}, 60_000)';
    const launcherSource = [
      "const { spawn } = require('node:child_process')",
      "const { writeFileSync } = require('node:fs')",
      `const escaped = spawn(process.execPath, ['-e', ${JSON.stringify(escapedSource)}], { detached: true, stdio: 'ignore', env: process.env })`,
      `writeFileSync(${JSON.stringify(pidFile)}, String(escaped.pid))`,
      'escaped.unref()',
      'setTimeout(() => {}, 100)',
    ].join(';');
    const launcher = spawnAgentProcess(process.execPath, ['-e', launcherSource], {
      cwd: process.cwd(),
      env: {},
    });
    const launcherPid = launcher.child.pid!;
    writeFileSync(join(agentDir, 'pgid.attempt1'), `${launcherPid} - ${launcher.workerToken}`);

    const closed = new Promise<void>((resolve) => launcher.child.once('close', () => resolve()));
    const escapedPid = await waitForPid(pidFile);
    await closed;
    try {
      expect(readProcStat(launcherPid)).toBeUndefined();
      expect(killWorkerGroups(runDir)).toBe(1);
      expect(await waitUntilGone(escapedPid)).toBe(true);
    } finally {
      launcher.killTree('SIGKILL');
      try {
        process.kill(-escapedPid, 'SIGKILL');
      } catch {
        /* already gone */
      }
    }
  });
});
