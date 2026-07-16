/**
 * The live panel loop: tail events.jsonl + manifest.json and repaint a
 * Claude-Code-style progress panel (phases, per-agent live tokens/elapsed,
 * child groups, budget footer). Two entry points share it: `ultracode watch`
 * (observe mode — Ctrl-C detaches, never signals the run) and the foreground
 * attach of run/resume (attach mode — Ctrl-C owns the run). Falls back to the
 * classic line-per-event stream for pipes, TERM=dumb, or --plain.
 *
 * When BOTH the output stream and stdin are TTYs the panel is interactive:
 * ↑/↓ (or j/k) select an agent row, ⏎ opens a per-agent detail view (prompt /
 * tool activity / outcome, read lazily from the agent's artifact dir), esc
 * goes back, q detaches. Raw-mode stdin swallows terminal signals, so Ctrl-C
 * arrives as a byte and is routed to the exact SIGINT semantics above.
 */
import { closeSync, constants as fsConstants, fstatSync, openSync, readFileSync, readSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { readEventsFrom } from '../store/events.js';
import { isTerminal, readManifest, type RunStatus } from '../store/manifest.js';
import { getRun, isRunnerAlive, liveStatus } from '../store/runstore.js';
import { agentDirName, ultracodeRoot } from '../store/layout.js';
import { looksNamespaceLocal } from '../exec/procinfo.js';
import { parseWorkflowScript } from '../engine/meta.js';
import { LiveRegion } from './live-region.js';
import { renderEvent } from './lifecycle.js';
import { attachKeys, type Key, type KeyInput } from './keys.js';
import { renderDetailFrame, type AgentArtifacts } from './panel-detail.js';
import {
  createPanelState,
  foldEvent,
  renderFrame,
  selectableSeqs,
  takeNarratorLines,
  type PanelSeed,
} from './panel.js';

const PANEL_TICK_MS = 125; // 8fps spinner + sub-second elapsed
const PLAIN_TICK_MS = 150; // the historical attach cadence
const NARRATOR_BACKFILL = 50;
/** Bound per-tick backlog reads: a late attach to a long run pages through
 *  events.jsonl instead of allocating/parsing the whole remainder at once. */
const EVENT_PAGE_BYTES = 4 * 1024 * 1024;

export interface PanelStream {
  write(chunk: string): boolean;
  isTTY?: boolean;
  columns?: number;
  rows?: number;
  /** tty.WriteStream resize signal (optional — fakes/pipes may omit it) */
  on?(event: 'resize', listener: () => void): unknown;
  removeListener?(event: 'resize', listener: () => void): unknown;
}

export interface PanelLoopOptions {
  /** attach: Ctrl-C owns the run (SIGTERM); observe: Ctrl-C detaches only */
  mode: 'attach' | 'observe';
  /** --json path: no progress output at all (exit code + signals still work) */
  quiet?: boolean;
  plain?: boolean;
  noColor?: boolean;
  /** default process.stderr — progress is never machine output */
  stream?: PanelStream;
  /** keyboard source, default process.stdin — interactivity engages only when
   *  it is a raw-mode-capable TTY (and the panel itself is rendering) */
  input?: KeyInput;
}

/** Bounds one artifact read: prompts/results beyond this render truncated. */
const ARTIFACT_READ_CAP = 64 * 1024;

/**
 * Read a worker-writable artifact without following symlinks (a worker may
 * have planted one — mirror of safe-write's O_NOFOLLOW stance on the read
 * side), capped at ARTIFACT_READ_CAP. O_NONBLOCK because a planted FIFO would
 * otherwise block the open(2) forever with the event loop (and therefore
 * Ctrl-C) dead — it is a no-op for regular files, and the fstat gate below
 * rejects everything that is not one. undefined when unreadable (not yet
 * written, symlink, FIFO/device, permission) — callers retry on a later paint.
 */
export function readArtifact(path: string): string | undefined {
  let fd: number | undefined;
  try {
    fd = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
    const stat = fstatSync(fd);
    if (!stat.isFile()) return undefined;
    const len = Math.min(stat.size, ARTIFACT_READ_CAP);
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, 0);
    return stat.size > ARTIFACT_READ_CAP ? buf.toString('utf8') + '\n… truncated' : buf.toString('utf8');
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** Gating precedence: --plain / not-a-TTY / TERM=dumb → line mode; NO_COLOR / --no-color strip SGR only. */
export function resolveRenderMode(
  stream: { isTTY?: boolean },
  opts: { plain?: boolean; noColor?: boolean },
  env: NodeJS.ProcessEnv = process.env,
): { kind: 'panel' | 'plain'; color: boolean } {
  if (opts.plain || !stream.isTTY || env.TERM === 'dumb') return { kind: 'plain', color: false };
  const noColorEnv = env.NO_COLOR !== undefined && env.NO_COLOR !== '';
  return { kind: 'panel', color: !opts.noColor && !noColorEnv };
}

function buildSeed(dir: string): PanelSeed {
  const manifest = readManifest(dir);
  const seed: PanelSeed = {
    runName: manifest?.name ?? '(unknown)',
    budgetTotal: manifest?.budget.total ?? null,
    startedAtMs: manifest ? Date.parse(manifest.startedAt) : Date.now(),
  };
  try {
    // meta.title and phase details never reach the manifest — best-effort
    // re-parse of the run's own script.js fills them in.
    const meta = parseWorkflowScript(readFileSync(join(dir, 'script.js'), 'utf8')).meta;
    seed.title = meta.title;
    seed.phases = meta.phases?.map((p) => ({ title: p.title, detail: p.detail }));
  } catch {
    seed.phases = manifest?.phases.map((p) => ({ title: p.title }));
  }
  return seed;
}

export async function panelLoop(dir: string, opts: PanelLoopOptions): Promise<{ exitCode: number }> {
  const stream: PanelStream = opts.stream ?? process.stderr;
  const mode = resolveRenderMode(stream, opts);
  const eventsFile = join(dir, 'events.jsonl');
  const state = createPanelState(buildSeed(dir));
  const region = new LiveRegion(stream);
  const notices: string[] = []; // SIGINT feedback, surfaced as narrator lines in panel mode
  let offset = 0;
  let sigints = 0;
  let firstDrain = true;

  const sigintHandler = (): void => {
    sigints++;
    if (opts.mode === 'observe') {
      stream.write('\n■ detached (the run continues); stop it with: ultracode stop\n');
      process.exit(130); // LiveRegion's exit hook restores the cursor
    }
    const manifest = readManifest(dir);
    // isRunnerAlive, not bare isPidAlive: a recycled PID must never be
    // SIGTERMed — the kernel start-time binds the manifest to the real runner.
    if (sigints === 1 && manifest && manifest.pid > 0 && isRunnerAlive(manifest)) {
      const msg = '■ stopping run (Ctrl-C again to detach immediately)…';
      if (mode.kind === 'panel' && !opts.quiet) notices.push(`· ${msg}`);
      else stream.write(`\n${msg}\n`);
      try {
        process.kill(manifest.pid, 'SIGTERM');
      } catch {
        /* already gone */
      }
    } else {
      stream.write('\n■ detached; run may still be finalizing. Re-attach: ultracode watch\n');
      process.exit(130);
    }
  };
  process.on('SIGINT', sigintHandler);

  const drainNarrator = (): string[] => {
    let lines = [...notices.splice(0, notices.length), ...takeNarratorLines(state)];
    if (firstDrain) {
      firstDrain = false;
      if (lines.length > NARRATOR_BACKFILL) {
        lines = [`· … ${lines.length - NARRATOR_BACKFILL} earlier lines (see: ultracode logs)`, ...lines.slice(-NARRATOR_BACKFILL)];
      }
    }
    return mode.color ? lines.map((l) => `\x1b[2m${l}\x1b[0m`) : lines;
  };

  const writePlain = (events: ReturnType<typeof readEventsFrom>['events']): void => {
    for (const ev of events) {
      const line = renderEvent(ev);
      if (line) stream.write(line + '\n');
    }
  };

  // ---- interactive UI state (viewer-local; never part of the event fold) ----
  interface UiState {
    view: 'overview' | 'detail';
    selectedSeq?: number;
    detailScroll: number;
    promptExpanded: boolean;
  }
  const ui: UiState = { view: 'overview', detailScroll: 0, promptExpanded: false };
  const artifacts = new Map<number, AgentArtifacts>();
  let finished = false;
  let lastManifest: ReturnType<typeof readManifest>;
  let lastStatus: RunStatus = 'running';

  /** Lazy per-agent artifact reads, cached once readable; result.json only after settle. */
  const promptFinalized = new Set<number>();
  const artifactsFor = (seq: number, final: boolean): AgentArtifacts => {
    let art = artifacts.get(seq);
    if (!art) {
      art = {};
      artifacts.set(seq, art);
    }
    const row = state.agents.get(seq);
    if (!row) return art;
    const agentDir = join(dir, 'agents', agentDirName(row.seq, row.label));
    const settled = row.endedTs !== undefined || final;
    if (settled && !promptFinalized.has(seq)) {
      // The settle-time write is authoritative — one re-read replaces anything
      // torn/empty the 8fps poll may have caught mid-write during the run.
      promptFinalized.add(seq);
      art.prompt = readArtifact(join(agentDir, 'prompt.md')) ?? art.prompt;
    } else if (art.prompt === undefined || art.prompt.length === 0) {
      // Live: cache only a non-empty read — an empty string is most likely the
      // O_TRUNC window of the runner's non-atomic early write, so keep retrying.
      const p = readArtifact(join(agentDir, 'prompt.md'));
      if (p !== undefined) art.prompt = p;
    }
    if (art.result === undefined && settled) {
      const raw = readArtifact(join(agentDir, 'result.json'));
      if (raw !== undefined) {
        try {
          art.result = JSON.parse(raw) as unknown;
        } catch {
          if (raw.endsWith('… truncated')) {
            // Capped read of an oversized result.json can never parse — show
            // the head as text instead of retrying (and re-reading 64KB) forever.
            art.result = { value: raw };
          }
          /* else: torn write — retry next paint */
        }
      }
    }
    return art;
  };

  const paint = (manifest: ReturnType<typeof readManifest>, status: RunStatus, nowMs: number, final: boolean): void => {
    // || not ??: a detached/0-size PTY (CI, `script`) reports 0×0
    const cols = stream.columns || 80;
    const rows = stream.rows || 24;
    const base = { cols, rows, nowMs, color: mode.color, runStatus: status, spentFloor: manifest?.budget.spent };
    let frame: string;
    if (interactive && ui.view === 'detail' && ui.selectedSeq !== undefined && state.agents.has(ui.selectedSeq)) {
      const detail = renderDetailFrame(state, ui.selectedSeq, artifactsFor(ui.selectedSeq, final), {
        ...base,
        scroll: ui.detailScroll,
        promptExpanded: ui.promptExpanded,
        keymap: final ? undefined : DETAIL_KEYMAP,
      });
      ui.detailScroll = Math.min(ui.detailScroll, detail.maxScroll); // self-heal on shrink/resize
      frame = detail.text;
    } else {
      frame = renderFrame(state, {
        ...base,
        selectedSeq: interactive ? ui.selectedSeq : undefined,
        keymap: interactive && !final ? overviewKeymap : undefined,
      });
    }
    if (final) region.close(drainNarrator(), frame);
    else region.update(drainNarrator(), frame);
  };

  /** Immediate feedback on a keypress: repaint from the last tick's snapshot.
   *  Safe because readEventsFrom is sync — 'data' events only fire while the
   *  loop is parked at sleep(), never mid-fold; the next tick repaints again
   *  with ≤125ms-fresher state. */
  const repaintNow = (): void => {
    if (finished || opts.quiet || mode.kind !== 'panel') return;
    paint(lastManifest, lastStatus, Date.now(), false);
  };

  const moveSelection = (delta: 1 | -1): void => {
    const seqs = selectableSeqs(state);
    if (seqs.length === 0) return;
    const idx = ui.selectedSeq === undefined ? -1 : seqs.indexOf(ui.selectedSeq);
    if (idx === -1) ui.selectedSeq = delta === 1 ? seqs[0] : seqs.at(-1);
    else ui.selectedSeq = seqs[Math.min(seqs.length - 1, Math.max(0, idx + delta))];
  };

  const detachViewer = (): void => {
    stream.write('\n■ detached (the run continues); re-attach: ultracode watch\n');
    process.exit(130); // keys' exit backstop restores cooked mode; LiveRegion's restores the cursor
  };

  let suspended = false;
  const onSigCont = (): void => {
    suspended = false;
    keysAtt = attachKeys(input, onKey);
    stream.write('\x1b[?25l'); // re-hide the cursor (inverse of the suspend hand-back)
    region.reset();
    repaintNow();
  };

  const suspend = (): void => {
    // Re-entrancy guard: two ctrl-z bytes in one chunk would otherwise arm two
    // once-listeners — after SIGCONT both would attachKeys and every key
    // would dispatch twice from then on.
    if (suspended) return;
    suspended = true;
    // Hand the terminal back to the shell: cooked mode, visible cursor, and
    // the painted region left behind in scrollback.
    keysAtt.detach();
    stream.write('\x1b[?25h');
    region.reset();
    process.once('SIGCONT', onSigCont);
    process.kill(process.pid, 'SIGTSTP');
  };

  const onKey = (key: Key): void => {
    if (finished) return;
    if (key.type === 'ctrl-c') {
      sigintHandler();
      repaintNow(); // surface the stop notice without waiting for the tick
      return;
    }
    if (key.type === 'ctrl-d' || (key.type === 'char' && key.ch === 'q')) {
      detachViewer();
      return;
    }
    if (key.type === 'ctrl-z') {
      suspend();
      return;
    }
    if (ui.view === 'detail') {
      if (key.type === 'esc') ui.view = 'overview'; // selection retained
      else if (key.type === 'down' || (key.type === 'char' && key.ch === 'j')) ui.detailScroll++;
      else if (key.type === 'up' || (key.type === 'char' && key.ch === 'k')) ui.detailScroll = Math.max(0, ui.detailScroll - 1);
      else if (key.type === 'enter') ui.promptExpanded = !ui.promptExpanded;
      else return;
    } else {
      if (key.type === 'down' || (key.type === 'char' && key.ch === 'j')) moveSelection(1);
      else if (key.type === 'up' || (key.type === 'char' && key.ch === 'k')) moveSelection(-1);
      else if (key.type === 'enter') {
        if (ui.selectedSeq === undefined) moveSelection(1);
        else {
          ui.view = 'detail';
          ui.detailScroll = 0;
          ui.promptExpanded = false;
        }
      } else if (key.type === 'esc') ui.selectedSeq = undefined;
      else return;
    }
    repaintNow();
  };

  const input: KeyInput = opts.input ?? process.stdin;
  let keysAtt =
    mode.kind === 'panel' && !opts.quiet ? attachKeys(input, onKey) : { interactive: false, detach: (): void => {} };
  const interactive = keysAtt.interactive;
  const overviewKeymap = `↑/↓ select · ⏎ details · esc clear · q detach · ctrl-c ${opts.mode === 'attach' ? 'stop' : 'detach'}`;
  const DETAIL_KEYMAP = 'j/k scroll · ⏎ prompt · esc back · q detach';

  // A resize rewraps already-painted lines and invalidates the cursor-up
  // count — abandon the old region and paint fresh below on the next tick.
  const onResize = (): void => region.reset();
  if (mode.kind === 'panel' && !opts.quiet) {
    region.open();
    stream.on?.('resize', onResize);
  }
  try {
    const panelFolds = mode.kind === 'panel' && !opts.quiet; // plain/quiet never render PanelState
    for (;;) {
      const page = readEventsFrom(eventsFile, offset, EVENT_PAGE_BYTES);
      offset = page.nextOffset;
      if (panelFolds) for (const ev of page.events) foldEvent(state, ev);
      // One manifest read per tick: status and spentFloor come from the same
      // snapshot (a second read could observe a newer generation mid-frame).
      const manifest = readManifest(dir);
      const status: RunStatus = manifest ? liveStatus(manifest) : 'running';
      lastManifest = manifest;
      lastStatus = status;

      if (manifest && isTerminal(status)) {
        if (mode.kind === 'plain' && !opts.quiet) writePlain(page.events);
        // Drain the remainder in bounded pages too.
        for (;;) {
          const rest = readEventsFrom(eventsFile, offset, EVENT_PAGE_BYTES);
          offset = rest.nextOffset;
          if (panelFolds) for (const ev of rest.events) foldEvent(state, ev);
          if (mode.kind === 'plain' && !opts.quiet) writePlain(rest.events);
          if (!rest.hasMore) break;
        }
        // A namespace-local pid means the runner was born inside a fresh
        // PID namespace — a transient sandbox (agent exec jail, one-shot
        // container) that SIGKILLs everything in it when the launcher returns.
        const sandboxHint =
          status === 'orphaned' && looksNamespaceLocal(manifest.pid)
            ? `runner pid ${manifest.pid} looks namespace-local — the run was likely launched inside a transient sandbox (agent shell / one-shot container) that was torn down. Launch from a persistent shell, or keep the launching command attached until the run completes.`
            : undefined;
        if (!opts.quiet) {
          if (mode.kind === 'plain') {
            if (status === 'orphaned') stream.write('✗ runner died without finalizing (orphaned). See runner.log\n');
            if (sandboxHint) stream.write(`⚠ ${sandboxHint}\n`);
          } else {
            if (sandboxHint) notices.push(`· ⚠ ${sandboxHint}`);
            // Freeze elapsed at the recorded end — the final frame stays in
            // scrollback (in the detail view when one is open: the user's
            // context, now showing the final outcome).
            finished = true;
            paint(manifest, status, manifest.endedAt ? Date.parse(manifest.endedAt) : Date.now(), true);
          }
        }
        return { exitCode: status === 'completed' ? 0 : 1 };
      }

      if (mode.kind === 'plain' && !opts.quiet) writePlain(page.events);
      if (page.hasMore) continue; // catching up on a backlog — no repaint, no sleep
      if (panelFolds) paint(manifest, status, Date.now(), false);
      await sleep(mode.kind === 'panel' ? PANEL_TICK_MS : PLAIN_TICK_MS);
    }
  } finally {
    finished = true;
    keysAtt.detach();
    process.removeListener('SIGINT', sigintHandler);
    process.removeListener('SIGCONT', onSigCont);
    stream.removeListener?.('resize', onResize);
  }
}

export async function watchCommand(
  runId: string,
  opts: { home?: string; plain?: boolean; noColor?: boolean },
): Promise<number> {
  const root = ultracodeRoot(process.cwd(), opts.home);
  const run = getRun(root, runId);
  if (!run) {
    process.stderr.write(`ultracode: no run ${runId} under ${root}\n`);
    return 1;
  }
  const { exitCode } = await panelLoop(run.dir, {
    mode: 'observe',
    plain: opts.plain,
    noColor: opts.noColor,
  });
  return exitCode;
}
