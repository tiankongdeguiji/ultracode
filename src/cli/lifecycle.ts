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
import { getRun, isPidAlive, listRuns, reapOrphans } from '../store/runstore.js';
import { ultracodeRoot } from '../store/layout.js';

export function renderEvent(ev: TimestampedEvent): string | null {
  switch (ev.type) {
    case 'run_started':
      return `▶ run started: ${ev.name}`;
    case 'phase_started':
      return `── phase: ${ev.title}`;
    case 'agent_started':
      return `   agent[${ev.seq}] ${ev.label} started (${ev.backend})`;
    case 'agent_completed':
      if (ev.skipped) return `   agent[${ev.seq}] ${ev.label} skipped`;
      return `   agent[${ev.seq}] ${ev.label} ${ev.ok ? `done (${ev.totalTokens} tok)` : `FAILED: ${ev.error ?? ''}`}`;
    case 'workflow_log':
      return `   log: ${ev.message}`;
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
 * Foreground attach: tail events until the manifest is terminal, mirroring
 * the run status in the exit code. First Ctrl-C sends SIGTERM to the runner
 * (explicit stop); the run store keeps everything if we die instead.
 */
export async function attachForeground(
  dir: string,
  opts: { quiet?: boolean; onSigint?: () => void } = {},
): Promise<AttachResult> {
  const eventsFile = join(dir, 'events.jsonl');
  let offset = 0;
  let sigints = 0;

  const sigintHandler = () => {
    sigints++;
    const manifest = readManifest(dir);
    if (sigints === 1 && manifest && manifest.pid > 0 && isPidAlive(manifest.pid)) {
      process.stderr.write('\n■ stopping run (Ctrl-C again to detach immediately)…\n');
      try {
        process.kill(manifest.pid, 'SIGTERM');
      } catch {
        /* already gone */
      }
    } else {
      process.stderr.write('\n■ detached; run may still be finalizing. Re-attach: ultracode status --watch\n');
      process.exit(130);
    }
  };
  process.on('SIGINT', sigintHandler);

  try {
    for (;;) {
      const page = readEventsFrom(eventsFile, offset);
      offset = page.nextOffset;
      if (!opts.quiet) {
        for (const ev of page.events) {
          const line = renderEvent(ev);
          if (line) process.stderr.write(line + '\n');
        }
      }
      const manifest = readManifest(dir);
      if (manifest && isTerminal(manifest.status)) {
        // drain remaining events
        const rest = readEventsFrom(eventsFile, offset);
        if (!opts.quiet) {
          for (const ev of rest.events) {
            const line = renderEvent(ev);
            if (line) process.stderr.write(line + '\n');
          }
        }
        return { exitCode: manifest.status === 'completed' ? 0 : 1 };
      }
      if (manifest && manifest.status === 'running' && !isPidAlive(manifest.pid)) {
        process.stderr.write('✗ runner died without finalizing (orphaned). See runner.log\n');
        return { exitCode: 1 };
      }
      await sleep(150);
    }
  } finally {
    process.removeListener('SIGINT', sigintHandler);
  }
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
  const run = getRun(root, runId);
  if (!run) {
    process.stderr.write(`ultracode: no run ${runId} under ${root}\n`);
    return 1;
  }
  if (isTerminal(run.effectiveStatus)) {
    process.stdout.write(`${runId} already ${run.effectiveStatus}\n`);
    return 0;
  }
  const pid = run.manifest.pid;
  if (!isPidAlive(pid)) {
    reapOrphans(root);
    process.stdout.write(`${runId} runner already dead; marked orphaned\n`);
    return 0;
  }
  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    /* raced */
  }
  const deadline = Date.now() + 7_000;
  while (Date.now() < deadline) {
    const m = readManifest(run.dir);
    if (m && isTerminal(m.status)) {
      process.stdout.write(`${runId} ${m.status}\n`);
      return 0;
    }
    await sleep(200);
  }
  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    /* gone */
  }
  reapOrphans(root);
  process.stdout.write(`${runId} force-killed\n`);
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
