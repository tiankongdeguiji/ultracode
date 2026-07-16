/**
 * The live panel loop: tail events.jsonl + manifest.json and repaint a
 * Claude-Code-style progress panel (phases, per-agent live tokens/elapsed,
 * child groups, budget footer). Two entry points share it: `ultracode watch`
 * (observe mode — Ctrl-C detaches, never signals the run) and the foreground
 * attach of run/resume (attach mode — Ctrl-C owns the run). Falls back to the
 * classic line-per-event stream for pipes, TERM=dumb, or --plain.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { readEventsFrom } from '../store/events.js';
import { isTerminal, readManifest, type RunStatus } from '../store/manifest.js';
import { getRun, isRunnerAlive, liveStatus } from '../store/runstore.js';
import { ultracodeRoot } from '../store/layout.js';
import { looksNamespaceLocal } from '../exec/procinfo.js';
import { parseWorkflowScript } from '../engine/meta.js';
import { LiveRegion } from './live-region.js';
import { renderEvent } from './lifecycle.js';
import {
  createPanelState,
  foldEvent,
  renderFrame,
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

  const paint = (manifest: ReturnType<typeof readManifest>, status: RunStatus, nowMs: number, final: boolean): void => {
    const frame = renderFrame(state, {
      // || not ??: a detached/0-size PTY (CI, `script`) reports 0×0
      cols: stream.columns || 80,
      rows: stream.rows || 24,
      nowMs,
      color: mode.color,
      runStatus: status,
      spentFloor: manifest?.budget.spent,
    });
    if (final) region.close(drainNarrator(), frame);
    else region.update(drainNarrator(), frame);
  };

  // A resize rewraps already-painted lines and invalidates the cursor-up
  // count — abandon the old region and paint fresh below on the next tick.
  const onResize = (): void => region.reset();
  if (mode.kind === 'panel' && !opts.quiet) {
    region.open();
    stream.on?.('resize', onResize);
  }
  try {
    for (;;) {
      const page = readEventsFrom(eventsFile, offset, EVENT_PAGE_BYTES);
      offset = page.nextOffset;
      for (const ev of page.events) foldEvent(state, ev);
      // One manifest read per tick: status and spentFloor come from the same
      // snapshot (a second read could observe a newer generation mid-frame).
      const manifest = readManifest(dir);
      const status: RunStatus = manifest ? liveStatus(manifest) : 'running';

      if (manifest && isTerminal(status)) {
        if (mode.kind === 'plain' && !opts.quiet) writePlain(page.events);
        // Drain the remainder in bounded pages too.
        for (;;) {
          const rest = readEventsFrom(eventsFile, offset, EVENT_PAGE_BYTES);
          offset = rest.nextOffset;
          for (const ev of rest.events) foldEvent(state, ev);
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
            // Freeze elapsed at the recorded end — the final frame stays in scrollback.
            paint(manifest, status, manifest.endedAt ? Date.parse(manifest.endedAt) : Date.now(), true);
          }
        }
        return { exitCode: status === 'completed' ? 0 : 1 };
      }

      if (!opts.quiet) {
        if (mode.kind === 'plain') writePlain(page.events);
        else paint(manifest, status, Date.now(), false);
      }
      if (page.hasMore) continue; // catching up on a backlog — page again without sleeping
      await sleep(mode.kind === 'panel' ? PANEL_TICK_MS : PLAIN_TICK_MS);
    }
  } finally {
    process.removeListener('SIGINT', sigintHandler);
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
