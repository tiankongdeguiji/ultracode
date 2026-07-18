/**
 * Integration coverage for worker descendants that leave the worker's process
 * group. Codex's Linux sandbox uses new sessions, so kill(-pgid) alone cannot
 * contain every command it launches.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { describe, expect, it } from 'vitest';
import type { AgentEvent, AgentRequest, AgentSpec, BackendAdapter, ExitClass, SpawnPlan } from '../../src/backends/types.js';
import { ZERO_USAGE } from '../../src/backends/types.js';
import { AgentCallExecutor } from '../../src/engine/agentcall.js';
import {
  findWorkerProcesses,
  isSafeProcessId,
  readProcessIdentity,
  readProcStat,
} from '../../src/exec/procinfo.js';
import { spawnAgentProcess } from '../../src/exec/spawn.js';
import { killWorkerGroups } from '../../src/exec/stop.js';
import { workerRecordDir, workerRecordPath } from '../../src/exec/worker-record.js';

const SIGNAL = new AbortController().signal;

class EscapingAdapter implements BackendAdapter {
  readonly id = 'mock' as const;
  readonly structuredOutput = 'emulated' as const;

  constructor(
    private readonly pidFile: string,
    private readonly hang = false,
    private readonly inheritStdio = false,
    private readonly ignoreTerm = false,
  ) {}

  probe() {
    return Promise.resolve({ available: true });
  }

  buildSpawn(_req: AgentRequest): SpawnPlan {
    const escapedSource = [
      this.ignoreTerm ? "process.on('SIGTERM', () => {})" : '',
      'setInterval(() => {}, 60_000)',
    ]
      .filter(Boolean)
      .join(';');
    const escapedStdio = this.inheritStdio ? "['ignore', 'inherit', 'inherit']" : "'ignore'";
    const source = [
      "const { spawn } = require('node:child_process')",
      "const { writeFileSync } = require('node:fs')",
      `const escaped = spawn(process.execPath, ['-e', ${JSON.stringify(escapedSource)}], { detached: true, stdio: ${escapedStdio}, env: process.env })`,
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
    try {
      const pid = Number(readFileSync(file, 'utf8').trim());
      if (isSafeProcessId(pid)) return pid;
    } catch {
      /* not written yet */
    }
    await sleep(25);
  }
  throw new Error('escaped child pid was not written');
}

async function waitForFile(file: string): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    if (existsSync(file)) return;
    await sleep(25);
  }
  throw new Error('readiness marker was not written');
}

async function waitUntilGone(pid: number): Promise<boolean> {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    if (!readProcessIdentity(pid)) return true;
    await sleep(25);
  }
  return false;
}

describe('escaped worker descendant cleanup', () => {
  it('persists a token-only recovery record before the backend starts', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'uc-token-first-'));
    const recordFile = join(dir, 'record');
    const observedFile = join(dir, 'observed');
    const source = [
      "const { readFileSync, writeFileSync } = require('node:fs')",
      `writeFileSync(${JSON.stringify(observedFile)}, readFileSync(${JSON.stringify(recordFile)}, 'utf8'))`,
    ].join(';');
    const launcher = spawnAgentProcess(process.execPath, ['-e', source], {
      cwd: process.cwd(),
      env: {},
      onWorkerToken: (token) => writeFileSync(recordFile, `- - ${token}`),
    });
    try {
      await new Promise<void>((resolve) => launcher.child.once('close', () => resolve()));
      expect(readFileSync(observedFile, 'utf8')).toBe(`- - ${launcher.workerToken}`);
    } finally {
      launcher.killTree('SIGKILL');
    }
  });

  it('reaps escaped and markerless same-group children from a token-only record', async () => {
    if (process.platform !== 'linux') return;
    const runDir = mkdtempSync(join(tmpdir(), 'uc-token-recovery-'));
    const pidFile = join(runDir, 'escaped.pid');
    const markerlessPidFile = join(runDir, 'markerless.pid');
    const escapedSource = 'setInterval(() => {}, 60_000)';
    const launcherSource = [
      "const { spawn } = require('node:child_process')",
      "const { writeFileSync } = require('node:fs')",
      `const escaped = spawn(process.execPath, ['-e', ${JSON.stringify(escapedSource)}], { detached: true, stdio: 'ignore', env: process.env })`,
      `const markerless = spawn(process.execPath, ['-e', ${JSON.stringify(escapedSource)}], { stdio: 'ignore', env: {} })`,
      `writeFileSync(${JSON.stringify(pidFile)}, String(escaped.pid))`,
      `writeFileSync(${JSON.stringify(markerlessPidFile)}, String(markerless.pid))`,
      'escaped.unref()',
      'markerless.unref()',
      'setInterval(() => {}, 60_000)',
    ].join(';');
    const launcher = spawnAgentProcess(process.execPath, ['-e', launcherSource], {
      cwd: process.cwd(),
      env: {},
      workerScope: runDir,
    });
    const launcherPid = launcher.child.pid!;
    let escapedPid: number | undefined;
    let markerlessPid: number | undefined;
    try {
      escapedPid = await waitForPid(pidFile);
      markerlessPid = await waitForPid(markerlessPidFile);
      mkdirSync(workerRecordDir(runDir, 0), { recursive: true });
      writeFileSync(workerRecordPath(runDir, 0, 1), `- - ${launcher.workerToken}`);
      expect(killWorkerGroups(runDir)).toBe(1);
      expect(await waitUntilGone(launcherPid)).toBe(true);
      expect(await waitUntilGone(escapedPid)).toBe(true);
      expect(await waitUntilGone(markerlessPid)).toBe(true);
    } finally {
      launcher.killTree('SIGKILL');
      if (escapedPid !== undefined) {
        try {
          process.kill(-escapedPid, 'SIGKILL');
        } catch {
          /* already gone */
        }
      }
      if (markerlessPid !== undefined) {
        try {
          process.kill(markerlessPid, 'SIGKILL');
        } catch {
          /* already gone */
        }
      }
    }
  });

  it('reaps a same-group helper after the backend group leader exits', async () => {
    if (process.platform !== 'linux' && process.platform !== 'darwin') return;
    const dir = mkdtempSync(join(tmpdir(), 'uc-group-helper-'));
    const pidFile = join(dir, 'pid');
    const helperSource = 'setInterval(() => {}, 60_000)';
    const launcherSource = [
      "const { spawn } = require('node:child_process')",
      "const { writeFileSync } = require('node:fs')",
      `const helper = spawn(process.execPath, ['-e', ${JSON.stringify(helperSource)}], { stdio: 'ignore', env: process.env })`,
      `writeFileSync(${JSON.stringify(pidFile)}, String(helper.pid))`,
      'helper.unref()',
    ].join(';');
    const launcher = spawnAgentProcess(process.execPath, ['-e', launcherSource], {
      cwd: process.cwd(),
      env: {},
    });
    const closed = new Promise<void>((resolve) => launcher.child.once('close', () => resolve()));
    const helperPid = await waitForPid(pidFile);
    await closed;
    try {
      expect(readProcessIdentity(helperPid)).toBeTruthy();
      expect(await launcher.cleanupEscaped()).toBe(0);
      expect(await waitUntilGone(helperPid)).toBe(true);
    } finally {
      launcher.killTree('SIGKILL');
    }
  });

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

  it('starts cleanup on direct-child exit when an escaped helper inherits stdio', async () => {
    if (process.platform !== 'linux') return;
    const pidFile = join(mkdtempSync(join(tmpdir(), 'uc-escaped-stdio-')), 'pid');
    const spec: AgentSpec = {
      seq: 0,
      prompt: 'spawn an escaped helper with inherited stdio',
      label: 'escape-stdio',
      backend: 'mock',
      cwd: process.cwd(),
      retries: 0,
    };

    const pending = new AgentCallExecutor(new EscapingAdapter(pidFile, false, true)).execute(spec, SIGNAL);
    const escapedPid = await waitForPid(pidFile);
    try {
      const outcome = await pending;
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

  it('disarms attempt watchdogs before slow descendant cleanup', async () => {
    if (process.platform !== 'linux') return;
    const pidFile = join(mkdtempSync(join(tmpdir(), 'uc-cleanup-watchdog-')), 'pid');
    const spec: AgentSpec = {
      seq: 0,
      prompt: 'finish while a stubborn escaped helper remains',
      label: 'cleanup-watchdog',
      backend: 'mock',
      cwd: process.cwd(),
      retries: 0,
      timeoutMs: 250,
    };

    const pending = new AgentCallExecutor(new EscapingAdapter(pidFile, false, false, true)).execute(spec, SIGNAL);
    const escapedPid = await waitForPid(pidFile);
    try {
      const outcome = await pending;
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
    writeFileSync(
      scriptFile,
      [
        "const { spawn } = require('node:child_process');",
        "const { existsSync, writeFileSync } = require('node:fs');",
        "const { join } = require('node:path');",
        'const generation = Number(process.argv[2]);',
        `const markerDir = ${JSON.stringify(dir)};`,
        "const marker = (kind, value) => join(markerDir, `${kind}-${value}`);",
        'let handled = false;',
        "process.on('SIGTERM', () => {",
        '  if (handled) return;',
        '  handled = true;',
        "  writeFileSync(marker('term', generation), '1');",
        '  if (generation < 2) {',
        "    const child = spawn(process.execPath, [__filename, String(generation + 1)], { detached: true, stdio: 'ignore', env: process.env });",
        '    child.unref();',
        "    const waiter = setInterval(() => {",
        "      if (!existsSync(marker('ready', generation + 1))) return;",
        '      clearInterval(waiter);',
        '      process.exit(0);',
        '    }, 5);',
        '  } else {',
        '    setTimeout(() => process.exit(0), 10);',
        '  }',
        '});',
        "writeFileSync(marker('ready', generation), '1');",
        'setInterval(() => {}, 60_000);',
      ].join('\n'),
    );
    const launcher = spawnAgentProcess(process.execPath, [scriptFile, '0'], {
      cwd: process.cwd(),
      env: {},
    });
    try {
      await waitForFile(join(dir, 'ready-0'));
      expect(await launcher.cleanupEscaped(1_000)).toBe(0);
      for (let generation = 0; generation <= 2; generation++) {
        expect(existsSync(join(dir, `ready-${generation}`))).toBe(true);
        expect(existsSync(join(dir, `term-${generation}`))).toBe(true);
      }
      expect(findWorkerProcesses(launcher.workerToken)).toEqual([]);
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
      workerScope: runDir,
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

  it('does not authorize a copied token outside its original run scope', async () => {
    if (process.platform !== 'linux') return;
    const attackerRun = mkdtempSync(join(tmpdir(), 'uc-scope-attacker-'));
    const victimRun = mkdtempSync(join(tmpdir(), 'uc-scope-victim-'));
    const attackerAgent = join(attackerRun, 'agents', '0000-forged');
    const victimAgent = join(victimRun, 'agents', '0000-real');
    const victimAlias = join(mkdtempSync(join(tmpdir(), 'uc-scope-alias-')), 'run');
    mkdirSync(attackerAgent, { recursive: true });
    mkdirSync(victimAgent, { recursive: true });
    symlinkSync(victimRun, victimAlias, 'dir');
    const launcher = spawnAgentProcess(process.execPath, ['-e', 'setInterval(() => {}, 60_000)'], {
      cwd: process.cwd(),
      env: {},
      workerScope: victimRun,
    });
    const pid = launcher.child.pid!;
    writeFileSync(join(attackerAgent, 'pgid.attempt1'), `999999999 - ${launcher.workerToken}`);
    writeFileSync(join(victimAgent, 'pgid.attempt1'), `999999999 - ${launcher.workerToken}`);
    try {
      expect(killWorkerGroups(attackerRun)).toBe(0);
      expect(readProcStat(pid)).toBeTruthy();
      expect(killWorkerGroups(victimAlias)).toBe(1);
      expect(await waitUntilGone(pid)).toBe(true);
    } finally {
      launcher.killTree('SIGKILL');
    }
  });
});
