import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { newRunId } from '../../src/store/layout.js';
import { createRunDir } from '../../src/store/runstore.js';
import { readManifest, writeManifest, isTerminal } from '../../src/store/manifest.js';
import { launchRunner } from '../../src/exec/daemonize.js';
import { setTimeout as sleep } from 'node:timers/promises';
import { panelLoop, resolveRenderMode, watchCommand, type PanelStream } from '../../src/cli/watch.js';

const HELLO = `export const meta = { name: 'hello', description: 'd', title: 'Say hi', phases: [{ title: 'Greet', detail: 'wave' }] }
phase('Greet')
const g = await agent('MOCK:ok hi', { label: 'greeter' })
log('greeting received')
return { g }
`;

const BOOM = `export const meta = { name: 'boom', description: 'd' }
await agent('MOCK:fail kapow', { label: 'bad' })
`;

function makeRun(source: string) {
  const root = mkdtempSync(join(tmpdir(), 'uc-watch-'));
  const runId = newRunId();
  const dir = createRunDir(root, { runId, name: 'wtest', source, args: null, config: { backend: 'mock', cwd: root } });
  return { root, runId, dir };
}

async function waitTerminal(dir: string, timeoutMs = 15_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const m = readManifest(dir);
    if (m && isTerminal(m.status)) return m.status;
    if (Date.now() > deadline) throw new Error(`run did not finish; status=${m?.status}`);
    await sleep(100);
  }
}

function captureStderr(): { chunks: string[]; restore: () => void } {
  const chunks: string[] = [];
  const spy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
    chunks.push(String(chunk));
    return true;
  });
  return { chunks, restore: () => spy.mockRestore() };
}

function fakeTty(): PanelStream & { chunks: string[] } {
  const chunks: string[] = [];
  return {
    chunks,
    isTTY: true,
    columns: 100,
    rows: 40,
    write(chunk: string) {
      chunks.push(chunk);
      return true;
    },
  };
}

afterEach(() => vi.restoreAllMocks());

describe('resolveRenderMode', () => {
  const tty = { isTTY: true };
  it('gates panel vs plain vs color', () => {
    expect(resolveRenderMode(tty, {}, {})).toEqual({ kind: 'panel', color: true });
    expect(resolveRenderMode(tty, { plain: true }, {})).toEqual({ kind: 'plain', color: false });
    expect(resolveRenderMode({ isTTY: false }, {}, {})).toEqual({ kind: 'plain', color: false });
    expect(resolveRenderMode(tty, {}, { TERM: 'dumb' })).toEqual({ kind: 'plain', color: false });
    expect(resolveRenderMode(tty, {}, { NO_COLOR: '1' })).toEqual({ kind: 'panel', color: false });
    expect(resolveRenderMode(tty, { noColor: true }, {})).toEqual({ kind: 'panel', color: false });
    expect(resolveRenderMode(tty, {}, { NO_COLOR: '' })).toEqual({ kind: 'panel', color: true }); // empty = unset per no-color.org
  });
});

describe('watch CLI', () => {
  it('plain watch tails a live run to completion and mirrors the exit code', async () => {
    const { root, runId, dir } = makeRun(HELLO);
    await launchRunner(dir);
    const { chunks, restore } = captureStderr();
    const cwd = vi.spyOn(process, 'cwd').mockReturnValue(root);
    let code: number;
    try {
      code = await watchCommand(runId, { home: root, plain: true });
    } finally {
      restore();
      cwd.mockRestore();
    }
    const out = chunks.join('');
    expect(code).toBe(0);
    expect(out).toContain('▶ run started: hello');
    expect(out).toContain('── phase: Greet');
    expect(out).toContain('agent[0] greeter done');
    expect(out).toContain('log: greeting received');
    expect(out).toContain('✓ run completed');
  }, 20_000);

  it('watch of an already-terminal failed run replays lines once and exits 1', async () => {
    const { root, runId, dir } = makeRun(BOOM);
    await launchRunner(dir);
    await waitTerminal(dir);
    const { chunks, restore } = captureStderr();
    let code: number;
    try {
      code = await watchCommand(runId, { home: root, plain: true });
    } finally {
      restore();
    }
    const out = chunks.join('');
    expect(code).toBe(1);
    expect(out).toContain('FAILED: kapow');
    expect(out).toContain('✗ run failed');
    // the run is over — watch must not linger or duplicate
    expect(out.match(/run failed/g)).toHaveLength(1);
  }, 20_000);

  it('panel mode on a TTY paints frames with cursor control and a frozen final frame', async () => {
    const { dir } = makeRun(HELLO);
    await launchRunner(dir);
    await waitTerminal(dir);
    const stream = fakeTty();
    const { exitCode } = await panelLoop(dir, { mode: 'observe', stream });
    expect(exitCode).toBe(0);
    const out = stream.chunks.join('');
    expect(stream.chunks[0]).toBe('\x1b[?25l'); // region opened
    expect(out).toContain('\x1b[?25h'); // cursor restored on close
    expect(out).toContain('wtest'); // header carries the manifest run name
    expect(out).toContain('Say hi'); // meta.title recovered from script.js
    expect(out).toContain('Greet (1/1)');
    expect(out).toContain('wave'); // phase detail recovered from script.js
    expect(out).toContain('· greeting received'); // narrator line above the region
    expect(out).toContain('agents 1/1');
    expect(out).toContain('completed');
  }, 20_000);

  it('attach mode follows an externally-stopped run to exit 1 and shows the stop', async () => {
    const SLOW = `export const meta = { name: 'slow', description: 'd' }
await agent('MOCK:delay 15000 MOCK:ok done', { label: 'sleeper' })
return 'finished'
`;
    const { dir } = makeRun(SLOW);
    const { pid } = await launchRunner(dir);
    const stream = fakeTty();
    const loop = panelLoop(dir, { mode: 'attach', stream });
    await sleep(400); // let the panel paint the running sleeper
    process.kill(pid, 'SIGTERM');
    const { exitCode } = await loop;
    const out = stream.chunks.join('');
    expect(exitCode).toBe(1);
    expect(out).toContain('sleeper');
    expect(out).toContain('stopped');
  }, 20_000);

  it('quiet mode emits nothing but still mirrors the exit code', async () => {
    const { dir } = makeRun(HELLO);
    await launchRunner(dir);
    const stream = fakeTty();
    const { exitCode } = await panelLoop(dir, { mode: 'attach', quiet: true, stream });
    expect(exitCode).toBe(0);
    expect(stream.chunks).toEqual([]);
  }, 20_000);

  it('observe-mode Ctrl-C detaches WITHOUT signaling the run (subprocess, real SIGINT)', async () => {
    const SLOW = `export const meta = { name: 'slow-watch', description: 'd' }
await agent('MOCK:delay 20000 MOCK:ok done', { label: 'sleeper' })
return 1
`;
    const { root, runId, dir } = makeRun(SLOW);
    await launchRunner(dir);

    const here = dirname(fileURLToPath(import.meta.url));
    const mainTs = join(here, '../../src/cli/main.ts');
    const tsxLoader = createRequire(import.meta.url).resolve('tsx');
    const watcher = spawn(process.execPath, ['--import', tsxLoader, mainTs, 'watch', runId, '--home', root, '--plain'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let err = '';
    watcher.stderr!.setEncoding('utf8');
    watcher.stderr!.on('data', (c: string) => (err += c));
    // Give the watcher time to attach, then Ctrl-C it.
    await sleep(2500);
    watcher.kill('SIGINT');
    const code = await new Promise<number | null>((resolve) => watcher.on('close', (c) => resolve(c)));

    expect(code).toBe(130);
    expect(err).toContain('detached (the run continues)');
    // The load-bearing contract: the RUN survived the watcher's Ctrl-C.
    const m = readManifest(dir)!;
    expect(m.status).toBe('running');
    expect(() => process.kill(m.pid, 0)).not.toThrow();
    process.kill(m.pid, 'SIGTERM'); // cleanup
    await waitTerminal(dir);
  }, 30_000);

  it('attach-mode first Ctrl-C SIGTERMs the REAL runner via the identity guard (graceful stop)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'uc-attach-sigint-'));
    const wf = join(root, 'slow.workflow.js');
    writeFileSync(wf, `export const meta = { name: 'slow-attach', description: 'd' }
await agent('MOCK:delay 20000 MOCK:ok done', { label: 'sleeper' })
return 1
`);
    const here = dirname(fileURLToPath(import.meta.url));
    const mainTs = join(here, '../../src/cli/main.ts');
    const tsxLoader = createRequire(import.meta.url).resolve('tsx');
    const child = spawn(
      process.execPath,
      ['--import', tsxLoader, mainTs, 'run', wf, '--home', root, '--backend', 'mock', '--yes'],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let err = '';
    child.stderr!.setEncoding('utf8');
    child.stderr!.on('data', (c: string) => (err += c));
    await sleep(3000); // runner launched + attach running
    child.kill('SIGINT'); // first Ctrl-C: must SIGTERM the runner, then follow it to 'stopped'
    const code = await new Promise<number | null>((resolve) => child.on('close', (c) => resolve(c)));

    expect(err).toContain('stopping run (Ctrl-C again to detach immediately)');
    expect(code).toBe(1); // exit mirrors the stopped run
    const runId = /▶ (wf_[0-9a-f]+)/.exec(err)?.[1];
    expect(runId).toBeTruthy();
    const m = readManifest(join(root, 'runs', runId!))!;
    expect(m.status).toBe('stopped'); // graceful SIGTERM path, not a kill
  }, 30_000);

  it('watch of an orphaned run reports it and exits 1, in both plain and panel modes', async () => {
    const { root, runId, dir } = makeRun(HELLO);
    // Fabricate an orphan without racing a real runner: 'running' manifest with a
    // namespace-local pid (9 is either a kernel thread with a mismatched start
    // time or absent → both paths give liveStatus 'orphaned' on any machine).
    const m = readManifest(dir)!;
    writeManifest(dir, { ...m, status: 'running', pid: 9, pidStart: 'recycled-pid-start' });

    const { chunks, restore } = captureStderr();
    let code: number;
    try {
      code = await watchCommand(runId, { home: root, plain: true });
    } finally {
      restore();
    }
    expect(code).toBe(1);
    const plainOut = chunks.join('');
    expect(plainOut).toContain('orphaned');
    expect(plainOut).toContain('looks namespace-local'); // sandbox-teardown hint

    const stream = fakeTty();
    const { exitCode } = await panelLoop(dir, { mode: 'observe', stream });
    expect(exitCode).toBe(1);
    const panelOut = stream.chunks.join('');
    expect(panelOut).toContain('runner died without finalizing (orphaned)');
    expect(panelOut).toContain('looks namespace-local');
  });

  it('unknown runId fails fast with a message', async () => {
    const root = mkdtempSync(join(tmpdir(), 'uc-watch-'));
    const { chunks, restore } = captureStderr();
    let code: number;
    try {
      code = await watchCommand('wf_000000000000', { home: root, plain: true });
    } finally {
      restore();
    }
    expect(code).toBe(1);
    expect(chunks.join('')).toContain('no run wf_000000000000');
  });
});
