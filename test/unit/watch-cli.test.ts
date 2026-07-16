import { describe, it, expect, vi, afterEach } from 'vitest';
import { appendFileSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { newRunId } from '../../src/store/layout.js';
import { createRunDir } from '../../src/store/runstore.js';
import { readManifest, writeManifest, isTerminal } from '../../src/store/manifest.js';
import { launchRunner } from '../../src/exec/daemonize.js';
import { setTimeout as sleep } from 'node:timers/promises';
import { panelLoop, readArtifact, resolveRenderMode, watchCommand, type PanelStream } from '../../src/cli/watch.js';

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

function fakeTty(): PanelStream & { chunks: string[]; rows: number; resize: () => void } {
  const chunks: string[] = [];
  const emitter = new EventEmitter();
  return {
    chunks,
    isTTY: true,
    columns: 100,
    rows: 40,
    write(chunk: string) {
      chunks.push(chunk);
      return true;
    },
    on: (e: 'resize', l: () => void) => emitter.on(e, l),
    removeListener: (e: 'resize', l: () => void) => emitter.removeListener(e, l),
    resize: () => emitter.emit('resize'),
  };
}

/** stdin-shaped fake: press() delivers bytes as if typed on a raw-mode TTY. */
function fakeStdin(isTTY = true) {
  const emitter = new EventEmitter();
  const s = {
    emitter,
    isTTY,
    rawCalls: [] as boolean[],
    setRawMode(m: boolean) {
      s.rawCalls.push(m);
    },
    on: (e: 'data', l: (c: Buffer | string) => void) => emitter.on(e, l),
    removeListener: (e: 'data', l: (c: Buffer | string) => void) => emitter.removeListener(e, l),
    resume: () => {},
    pause: () => {},
    press: (seq: string) => emitter.emit('data', Buffer.from(seq, 'utf8')),
  };
  return s;
}

async function waitForOutput(chunks: string[], needle: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!chunks.join('').includes(needle)) {
    if (Date.now() > deadline) throw new Error(`never painted: ${needle}`);
    await sleep(50);
  }
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

describe('readArtifact', () => {
  it('reads regular files, returns undefined for missing paths, and caps oversized content', () => {
    const dir = mkdtempSync(join(tmpdir(), 'uc-artifact-'));
    writeFileSync(join(dir, 'prompt.md'), 'hello');
    expect(readArtifact(join(dir, 'prompt.md'))).toBe('hello');
    expect(readArtifact(join(dir, 'absent.md'))).toBeUndefined();
    writeFileSync(join(dir, 'big.md'), 'x'.repeat(65 * 1024));
    const big = readArtifact(join(dir, 'big.md'))!;
    expect(big.length).toBeLessThan(66 * 1024);
    expect(big.endsWith('… truncated')).toBe(true);
  });

  it('refuses worker-planted symlinks and never blocks on a planted FIFO', () => {
    const dir = mkdtempSync(join(tmpdir(), 'uc-artifact-'));
    writeFileSync(join(dir, 'secret'), 'leak');
    symlinkSync(join(dir, 'secret'), join(dir, 'link.md'));
    expect(readArtifact(join(dir, 'link.md'))).toBeUndefined(); // O_NOFOLLOW
    const fifo = join(dir, 'fifo.md');
    const mk = spawnSync('mkfifo', [fifo]);
    if (mk.status === 0) {
      // O_NONBLOCK + fstat gate: returns immediately instead of hanging open(2)
      expect(readArtifact(fifo)).toBeUndefined();
    }
  });
});

describe('interactive panel', () => {
  const BUSY = `export const meta = { name: 'busy', description: 'd', phases: [{ title: 'Work' }] }
phase('Work')
await agent('MOCK:tools 2 MOCK:delay 15000 MOCK:ok done', { label: 'worker' })
return 1
`;

  it('selects with arrows, drills into the live detail view, escs back, and freezes detail on stop', async () => {
    const { dir } = makeRun(BUSY);
    const { pid } = await launchRunner(dir);
    const stream = fakeTty();
    const stdin = fakeStdin();
    const loop = panelLoop(dir, { mode: 'observe', noColor: true, stream, input: stdin });

    await waitForOutput(stream.chunks, 'worker'); // agent row folded and painted
    expect(stream.chunks.join('')).toContain('↑/↓ select'); // overview keymap on

    stdin.press('\x1b[B'); // ↓ selects the first row — repaint is immediate
    expect(stream.chunks.at(-1)).toContain('❯');

    stdin.press('\r'); // ⏎ opens the detail view
    expect(stream.chunks.at(-1)).toContain('Outcome'); // detail layout is up immediately…
    // …while artifact/tool data may lag a fold tick or two — poll, don't race.
    await waitForOutput(stream.chunks, 'Prompt · 1 line'); // prompt.md readable while RUNNING (early write)
    await waitForOutput(stream.chunks, 'tool:mock-2');
    await waitForOutput(stream.chunks, '2 tool calls');
    const detail = stream.chunks.findLast((c) => c.includes('tool:mock-2'))!;
    expect(detail).toContain('MOCK:tools 2 MOCK:delay 15000');
    expect(detail).toContain('Still running…');
    expect(detail).toContain('j/k scroll');

    stdin.press('\x1b'); // esc back to the overview, selection retained
    expect(stream.chunks.at(-1)).toContain('❯');
    expect(stream.chunks.at(-1)).not.toContain('Outcome');

    stdin.press('\r'); // back into detail, then let the run get stopped under us
    process.kill(pid, 'SIGTERM');
    const { exitCode } = await loop;
    expect(exitCode).toBe(1);
    const final = stream.chunks.findLast((c) => c.includes('Outcome'))!; // the frozen final frame
    expect(final).toContain('failed: aborted'); // the stop settled the in-flight agent
    expect(final).not.toContain('j/k scroll'); // keys are dead on the final frame
    expect(stdin.rawCalls[0]).toBe(true);
    expect(stdin.rawCalls.at(-1)).toBe(false); // cooked mode restored by the loop's finally
  }, 30_000);

  it('a 0x03 byte in attach mode triggers the graceful stop (raw mode swallows real SIGINT)', async () => {
    const { dir } = makeRun(BUSY);
    await launchRunner(dir);
    const stream = fakeTty();
    const stdin = fakeStdin();
    const loop = panelLoop(dir, { mode: 'attach', noColor: true, stream, input: stdin });
    await waitForOutput(stream.chunks, 'worker');

    stdin.press('\x03');
    const { exitCode } = await loop; // first ^C SIGTERMs the runner; the loop follows it to 'stopped'
    expect(exitCode).toBe(1);
    expect(stream.chunks.join('')).toContain('stopping run (Ctrl-C again to detach immediately)');
    expect(readManifest(dir)!.status).toBe('stopped');
  }, 30_000);

  it('q detaches the viewer with exit 130 while the run continues', async () => {
    const { dir } = makeRun(BUSY);
    const { pid } = await launchRunner(dir);
    const stream = fakeTty();
    const stdin = fakeStdin();
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('exit-called');
    }) as never);
    const loop = panelLoop(dir, { mode: 'attach', noColor: true, stream, input: stdin });
    try {
      await waitForOutput(stream.chunks, 'worker');
      expect(() => stdin.press('q')).toThrow('exit-called');
      expect(exitSpy).toHaveBeenCalledWith(130);
      expect(stream.chunks.join('')).toContain('■ detached (the run continues)');
      expect(readManifest(dir)!.status).toBe('running'); // q never signals the run
    } finally {
      exitSpy.mockRestore();
      process.kill(pid, 'SIGTERM'); // cleanup; let the loop finish
      await loop;
    }
  }, 30_000);

  it('overview selection: ↑ from none selects last, clamps at both edges, esc clears', async () => {
    const DUO = `export const meta = { name: 'duo', description: 'd' }
await parallel([
  () => agent('MOCK:delay 15000 MOCK:ok a', { label: 'alpha' }),
  () => agent('MOCK:delay 15000 MOCK:ok b', { label: 'beta' }),
])
return 1
`;
    const { dir } = makeRun(DUO);
    const { pid } = await launchRunner(dir);
    const stream = fakeTty();
    const stdin = fakeStdin();
    const loop = panelLoop(dir, { mode: 'observe', noColor: true, stream, input: stdin });
    const selectedRow = (): string | undefined =>
      stream.chunks.at(-1)!.split('\n').find((l) => l.includes('❯'));
    try {
      await waitForOutput(stream.chunks, 'beta');
      stdin.press('\x1b[A'); // ↑ with no selection → selects the LAST row
      expect(selectedRow()).toContain('beta');
      stdin.press('\x1b[B'); // ↓ at the bottom edge → clamped, stays put
      expect(selectedRow()).toContain('beta');
      stdin.press('k'); // up → alpha
      expect(selectedRow()).toContain('alpha');
      stdin.press('k'); // top edge → clamped
      expect(selectedRow()).toContain('alpha');
      stdin.press('\x1b'); // esc clears the selection entirely
      expect(selectedRow()).toBeUndefined();
    } finally {
      process.kill(pid, 'SIGTERM');
      await loop;
    }
  }, 30_000);

  it('detail view scrolls with j/k and re-clamps within the height budget across resizes', async () => {
    const filler = Array.from({ length: 40 }, (_, i) => `filler line ${i + 1}`).join('\n');
    const LONG = `export const meta = { name: 'long', description: 'd' }
await agent(${JSON.stringify('MOCK:delay 15000 MOCK:ok done\n' + filler)}, { label: 'wordy' })
return 1
`;
    const { dir } = makeRun(LONG);
    const { pid } = await launchRunner(dir);
    const stream = fakeTty();
    stream.rows = 20;
    const stdin = fakeStdin();
    const loop = panelLoop(dir, { mode: 'observe', noColor: true, stream, input: stdin });
    const frameLines = (c: string): number => c.slice(c.indexOf('⏺')).trimEnd().split('\n').length;
    try {
      await waitForOutput(stream.chunks, 'wordy');
      stdin.press('\x1b[B');
      stdin.press('\r'); // detail
      stdin.press('\r'); // expand the 41-line prompt → scrollable body
      expect(stream.chunks.at(-1)).toMatch(/\n1–\d+ of \d+ ↓/);
      stdin.press('j');
      stdin.press('j');
      expect(stream.chunks.at(-1)).toMatch(/\n3–\d+ of \d+ ↑ ↓/);
      stdin.press('k');
      expect(stream.chunks.at(-1)).toMatch(/\n2–\d+ of \d+ ↑ ↓/);
      expect(frameLines(stream.chunks.at(-1)!)).toBeLessThanOrEqual(19);

      // Shrink the terminal: resize resets the region; every subsequent frame
      // must fit the new budget and the scroll offset re-clamps itself.
      stream.rows = 8;
      stream.resize();
      await sleep(400); // a few ticks at the new geometry
      const after = stream.chunks.findLast((c) => c.includes('⏺'))!;
      expect(frameLines(after)).toBeLessThanOrEqual(7);
      stdin.press('j'); // scrolling still works post-resize
      expect(frameLines(stream.chunks.at(-1)!)).toBeLessThanOrEqual(7);
    } finally {
      process.kill(pid, 'SIGTERM');
      await loop;
    }
  }, 30_000);

  it('ctrl-z suspends once (double byte guarded), SIGCONT re-arms exactly one key listener', async () => {
    const { dir } = makeRun(BUSY);
    const { pid } = await launchRunner(dir);
    const stream = fakeTty();
    const stdin = fakeStdin();
    const realKill = process.kill.bind(process);
    const tstops: number[] = [];
    const killSpy = vi.spyOn(process, 'kill').mockImplementation((target: number, sig?: string | number) => {
      if (sig === 'SIGTSTP') {
        tstops.push(target);
        return true; // swallow — actually stopping would freeze the test runner
      }
      return realKill(target, sig as NodeJS.Signals);
    });
    const loop = panelLoop(dir, { mode: 'observe', noColor: true, stream, input: stdin });
    try {
      await waitForOutput(stream.chunks, 'worker');
      stdin.press('\x1a\x1a'); // two ctrl-z in ONE chunk — must suspend once
      expect(tstops).toEqual([process.pid]);
      expect(stdin.rawCalls).toEqual([true, false]); // cooked mode handed back to the shell
      expect(stream.chunks).toContain('\x1b[?25h'); // cursor visible for the shell

      process.emit('SIGCONT'); // resume: raw mode + cursor re-hidden + repaint
      expect(stdin.rawCalls).toEqual([true, false, true]);
      expect(stdin.emitter.listenerCount('data')).toBe(1); // exactly one handler — keys never double-dispatch
      stdin.press('\x1b[B');
      expect(stream.chunks.at(-1)).toContain('❯'); // keys live again after resume
    } finally {
      killSpy.mockRestore();
      process.kill(pid, 'SIGTERM');
      await loop;
    }
  }, 30_000);

  it('a truncated oversized result.json renders its head instead of finalizing forever; a torn empty prompt.md is retried', async () => {
    // Fabricated live run (manifest pid = this process): no real runner, so the
    // test controls exactly what is on disk when.
    const root = mkdtempSync(join(tmpdir(), 'uc-artifacts-'));
    const runId = newRunId();
    const dir = createRunDir(root, { runId, name: 'arts', source: 'export const meta = { name: "arts", description: "d" }\nreturn 1\n', args: null, config: { backend: 'mock', cwd: root } });
    const m = readManifest(dir)!;
    writeManifest(dir, { ...m, status: 'running', pid: process.pid, pidStart: undefined });
    const agentDir = join(dir, 'agents', '0000-big');
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(join(agentDir, 'prompt.md'), ''); // torn early write: zero bytes
    const partialDir = join(dir, 'agents', '0001-partial');
    mkdirSync(partialDir, { recursive: true });
    writeFileSync(join(partialDir, 'prompt.md'), 'PARTIAL-TORN'); // non-empty torn early write
    appendFileSync(
      join(dir, 'events.jsonl'),
      '{"ts":1,"type":"agent_started","seq":0,"label":"big","backend":"mock"}\n' +
        '{"ts":2,"type":"agent_completed","seq":0,"label":"big","ok":true,"totalTokens":10,"toolCalls":0}\n' +
        '{"ts":3,"type":"agent_started","seq":1,"label":"partial","backend":"mock"}\n' +
        '{"ts":4,"type":"agent_completed","seq":1,"label":"partial","ok":true,"totalTokens":5,"toolCalls":0}\n',
    );
    writeFileSync(join(agentDir, 'result.json'), JSON.stringify({ ok: true, status: 'ok', value: 'HEAD-MARKER-' + 'x'.repeat(80 * 1024) }));
    // NOTE: no result.json for seq 1 yet — completion folded, artifacts not rewritten
    // (the runner emits agent_completed BEFORE onAgentSettled rewrites the files).

    const stream = fakeTty();
    const stdin = fakeStdin();
    const loop = panelLoop(dir, { mode: 'observe', noColor: true, stream, input: stdin });
    try {
      await waitForOutput(stream.chunks, 'big');
      stdin.press('\x1b[B');
      stdin.press('\r');
      // Oversized result.json: capped read cannot parse — the head must render,
      // not '(finalizing…)'. (The '… truncated' tail lives thousands of virtual
      // lines down; the visible window shows the head.)
      await waitForOutput(stream.chunks, 'HEAD-MARKER-');
      const detail = stream.chunks.findLast((c) => c.includes('Outcome'))!;
      expect(detail).not.toContain('(finalizing…)');
      // Settled row: the empty torn prompt was replaced by the settle-time re-read…
      writeFileSync(join(agentDir, 'prompt.md'), 'the real prompt');
      // …wait: settle re-read happens once; the empty file was read BEFORE we wrote.
      // The guard treats '' as unreadable, so the next paint picks up the real content.
      await waitForOutput(stream.chunks, 'the real prompt');

      // Non-empty torn prompt: completion is folded but result.json is absent,
      // so the finalize re-read must NOT have fired yet — the torn text shows…
      stdin.press('\x1b'); // back to overview
      stdin.press('\x1b[B'); // seq 0 → seq 1
      stdin.press('\r');
      await waitForOutput(stream.chunks, 'PARTIAL-TORN');
      // …until the settle handler lands its writes (prompt.md BEFORE result.json):
      writeFileSync(join(partialDir, 'prompt.md'), 'FULL-PROMPT-AFTER-SETTLE');
      writeFileSync(join(partialDir, 'result.json'), JSON.stringify({ ok: true, status: 'ok', value: 'small' }));
      await waitForOutput(stream.chunks, 'FULL-PROMPT-AFTER-SETTLE'); // result-gated re-read replaced the torn cache
    } finally {
      const m2 = readManifest(dir)!;
      writeManifest(dir, { ...m2, status: 'stopped', endedAt: new Date().toISOString() });
      await loop;
    }
  }, 30_000);

  it('non-TTY stdin stays non-interactive: no raw mode, no keymap, no selection marker', async () => {
    const { dir } = makeRun(HELLO);
    await launchRunner(dir);
    await waitTerminal(dir);
    const stream = fakeTty();
    const stdin = fakeStdin(false);
    const { exitCode } = await panelLoop(dir, { mode: 'observe', noColor: true, stream, input: stdin });
    expect(exitCode).toBe(0);
    expect(stdin.rawCalls).toEqual([]);
    const out = stream.chunks.join('');
    expect(out).not.toContain('↑/↓ select');
    expect(out).not.toContain('❯');
  }, 20_000);
});
