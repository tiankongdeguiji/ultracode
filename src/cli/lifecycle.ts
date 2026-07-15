/**
 * Shared CLI plumbing: event rendering, foreground attach loop,
 * status/logs/stop/list command implementations. All of these are stateless
 * readers over the run store (plus signals for stop).
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { readEventsFrom, type TimestampedEvent } from '../store/events.js';
import { isTerminal, readManifest } from '../store/manifest.js';
import { getRun, listRuns, reapOrphans } from '../store/runstore.js';
import { stopRun } from '../exec/stop.js';
import { ultracodeRoot } from '../store/layout.js';

export function renderEvent(ev: TimestampedEvent): string | null {
  switch (ev.type) {
    case 'run_started':
      return `▶ run started: ${ev.name}`;
    case 'phase_started':
      return `── phase: ${ev.title}`;
    case 'agent_started':
      return `   agent[${ev.seq}] ${ev.label} started (${ev.backend}${ev.model ? ` · ${ev.model}` : ''})`;
    case 'agent_retry':
      return `   agent[${ev.seq}] ${ev.label} retry ${ev.attempt}/${ev.maxAttempts}${ev.reason ? `: ${ev.reason}` : ''}`;
    case 'agent_completed':
      if (ev.skipped) return `   agent[${ev.seq}] ${ev.label} skipped`;
      if (ev.cached) return `   agent[${ev.seq}] ${ev.label} done (cached)`;
      return `   agent[${ev.seq}] ${ev.label} ${ev.ok ? `done (${ev.totalTokens} tok)` : `FAILED: ${ev.error ?? ''}`}`;
    case 'agent_usage':
    case 'agent_model':
      // Live-tick noise for folding panels only: line consumers (logs
      // --follow, MCP logTail) would emit ~1 line/s per running agent.
      return null;
    case 'child_started':
      return `▸ child workflow: ${ev.name}`;
    case 'child_completed':
      return `▸ child workflow ${ev.name} ${ev.ok ? 'done' : `FAILED: ${ev.error ?? ''}`}`;
    case 'workflow_log':
      return `   log: ${ev.message}`;
    case 'budget_tick':
      return `   spent: ${ev.spent} tok`;
    case 'stop_requested':
      return `■ stop requested`;
    case 'run_completed':
      return `✓ run completed`;
    case 'run_failed':
      return `✗ run failed: ${ev.error ?? ''}`;
    case 'run_stopped':
      return `■ run stopped`;
    default:
      return null;
  }
}

export interface AttachResult {
  exitCode: number;
}

/**
 * Foreground attach: the live panel (or line stream) until the manifest is
 * terminal, mirroring the run status in the exit code. First Ctrl-C sends
 * SIGTERM to the runner (explicit stop); the run store keeps everything if we
 * die instead. Thin delegation to panelLoop — dynamic import because watch.ts
 * imports renderEvent from this module.
 */
export async function attachForeground(
  dir: string,
  opts: { quiet?: boolean; plain?: boolean; noColor?: boolean } = {},
): Promise<AttachResult> {
  const { panelLoop } = await import('./watch.js');
  return panelLoop(dir, { mode: 'attach', quiet: opts.quiet, plain: opts.plain, noColor: opts.noColor });
}

export function statusCommand(runId: string, opts: { watch?: boolean; json?: boolean; home?: string }): Promise<number> {
  return (async () => {
    const root = ultracodeRoot(process.cwd(), opts.home);
    for (;;) {
      const run = getRun(root, runId);
      if (!run) {
        process.stderr.write(`ultracode: no run ${runId} under ${root}\n`);
        return 1;
      }
      const m = run.manifest;
      if (opts.json) {
        process.stdout.write(JSON.stringify({ ...m, effectiveStatus: run.effectiveStatus }, null, 2) + '\n');
      } else {
        const phases = m.phases.map((p) => `${p.title}(${p.agentsDone})`).join(' → ') || '(none)';
        process.stdout.write(
          [
            `${m.runId}  ${run.effectiveStatus}  ${m.name}`,
            `  agents: ${m.agentCount}  tokens: ${m.budget.spent}${m.budget.total ? `/${m.budget.total}` : ''}`,
            `  phases: ${phases}`,
            m.error ? `  error: ${m.error}` : null,
          ]
            .filter(Boolean)
            .join('\n') + '\n',
        );
      }
      if (!opts.watch || isTerminal(run.effectiveStatus)) {
        return isTerminal(run.effectiveStatus) && run.effectiveStatus !== 'completed' ? 1 : 0;
      }
      await sleep(1000);
    }
  })();
}

export async function logsCommand(
  runId: string,
  opts: { follow?: boolean; home?: string },
): Promise<number> {
  const root = ultracodeRoot(process.cwd(), opts.home);
  const run = getRun(root, runId);
  if (!run) {
    process.stderr.write(`ultracode: no run ${runId} under ${root}\n`);
    return 1;
  }
  const eventsFile = join(run.dir, 'events.jsonl');
  let offset = 0;
  for (;;) {
    const page = readEventsFrom(eventsFile, offset);
    offset = page.nextOffset;
    for (const ev of page.events) {
      const line = renderEvent(ev);
      if (line) process.stdout.write(line + '\n');
    }
    const manifest = readManifest(run.dir);
    if (!opts.follow || (manifest && isTerminal(manifest.status))) return 0;
    await sleep(300);
  }
}

export async function stopCommand(runId: string, opts: { home?: string }): Promise<number> {
  const root = ultracodeRoot(process.cwd(), opts.home);
  // Route through the single hardened stop path (stopRun): PID-recycle-aware
  // signaling (pidStart) + detached worker-group cleanup on the SIGKILL fallback
  // and the dead-runner path. Previously this reimplemented an older, weaker
  // path that ignored both.
  const result = await stopRun(root, runId);
  if (!result.ok) {
    process.stderr.write(`ultracode: ${result.message}\n`);
    return 1;
  }
  const detail = result.message && result.message !== result.status ? ` (${result.message})` : '';
  process.stdout.write(`${runId} ${result.status}${detail}\n`);
  return 0;
}

export function listCommand(opts: { all?: boolean; reap?: boolean; json?: boolean; home?: string }): number {
  const root = ultracodeRoot(process.cwd(), opts.home);
  if (opts.reap) {
    for (const id of reapOrphans(root)) process.stderr.write(`reaped ${id}\n`);
  }
  let runs = listRuns(root);
  if (!opts.all) {
    runs = runs.filter((r) => !isTerminal(r.effectiveStatus) || Date.parse(r.manifest.startedAt) > Date.now() - 24 * 3600e3);
  }
  if (opts.json) {
    process.stdout.write(
      JSON.stringify(
        runs.map((r) => ({ runId: r.runId, status: r.effectiveStatus, name: r.manifest.name, startedAt: r.manifest.startedAt, agents: r.manifest.agentCount })),
        null,
        2,
      ) + '\n',
    );
    return 0;
  }
  if (runs.length === 0) {
    process.stdout.write(`no runs under ${root}\n`);
    return 0;
  }
  for (const r of runs) {
    process.stdout.write(
      `${r.runId}  ${r.effectiveStatus.padEnd(9)}  agents:${String(r.manifest.agentCount).padEnd(4)} ${r.manifest.name}  (${r.manifest.startedAt})\n`,
    );
  }
  return 0;
}

export function printOutput(dir: string): void {
  const file = join(dir, 'output.json');
  if (existsSync(file)) process.stdout.write(readFileSync(file, 'utf8') + '\n');
}
