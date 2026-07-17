/**
 * ultracode MCP server (stdio): the workflow_start / workflow_status /
 * workflow_result / workflow_stop / workflow_list triad(+2).
 *
 * Design constraints (source-verified across Codex/Qoder/Gemini hosts):
 *  - No host extends tool timeouts on progress (codex 0.144.5 never sets
 *    rmcp's reset_timeout_on_progress) and none polls MCP Tasks, so the only
 *    background monitor a host can have is one long blocking call under its
 *    tool timeout: workflow_status until='terminal' holds silently for an
 *    explicit waitSeconds ≤3600 (codex hostpack writes tool_timeout_sec=3600;
 *    stock codex defaults 300s, Qoder/Gemini 600s — doctrine states concrete
 *    holds, timeout minus ≥60s margin). A client that times out anyway never
 *    cancels server-side; the abandoned hold just runs out and is dropped.
 *  - NEVER declare MCP Tasks taskSupport ('required' hard-breaks Qoder
 *    client-side; no target host polls Tasks).
 *  - Runs execute in detached runner processes over the on-disk store, so
 *    this server is disposable: kill/restart loses nothing (including
 *    Codex's timeout-orphaning behavior — the run store is truth).
 */
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { VERSION } from '../version.js';
import { parseBudget } from '../budget/parse.js';
import { startDetachedRun } from '../exec/start.js';
import { stopRun } from '../exec/stop.js';
import { readEventsFrom, type TimestampedEvent } from '../store/events.js';
import { isTerminal } from '../store/manifest.js';
import { getRun, recentRuns } from '../store/runstore.js';
import { ultracodeRoot } from '../store/layout.js';
import { renderEvent } from '../cli/lifecycle.js';
import { readFileSync, existsSync, statSync } from 'node:fs';

// Codex injects only the first 512 chars of server instructions — keep under.
const INSTRUCTIONS =
  'Dynamic multi-agent workflow orchestration. workflow_start returns a runId in <1s and the run ' +
  'survives this server. Park on workflow_status until="terminal" — wakes only when the run ends, ' +
  'rolling the last 40 log lines into each response. waitSeconds is the wake interval, not a safety ' +
  'knob: pass 3300 on the codex hostpack (pinned 3600s tool timeout); small waits burn a turn per ' +
  'wake. A timed-out poll is harmless — re-poll the same runId, then workflow_result when terminal. ' +
  'Scripts follow the skill dialect.';

/** Explicit waitSeconds ceiling — sized to the codex hostpack's tool_timeout_sec=3600; doctrine keeps holds ≥60s under the host's actual timeout. */
const MAX_WAIT_SECONDS = 3600;
const DEFAULT_WAIT_SECONDS = 25;
/** Progress cadence for activity-mode waits (Qoder/Gemini render them; codex only logs) — quiet parks emit none, per their silent contract. */
const PROGRESS_INTERVAL_MS = 10_000;
/** Quiet holds shorter than this get an in-band nudge: models hedge toward tiny "safe" waits (observed: 60), and a short hold burns a turn per wake. */
const SHORT_HOLD_NUDGE_MS = 240_000;
/** Rolling tail cap carried on every workflow_status response. */
const TAIL_LINES = 40;
/** Per-line byte cap for the tail: log()/event text is script- and worker-influenced and can be huge — logTail must stay model-context-sized (worst case ~16 KB). */
const TAIL_LINE_CHARS = 400;

function ok(structured: Record<string, unknown>) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(structured, null, 2) }],
    structuredContent: structured,
  };
}

function fail(message: string, extra: Record<string, unknown> = {}) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify({ error: message, ...extra }) }],
    isError: true as const,
  };
}

export function createServer(baseCwd: string): McpServer {
  const server = new McpServer({ name: 'ultracode', version: VERSION }, { instructions: INSTRUCTIONS });
  const rootFor = (cwd?: string) => ultracodeRoot(cwd ?? baseCwd);

  server.registerTool(
    'workflow_start',
    {
      description:
        'Launch a workflow (fire-and-forget; returns runId in <1s). Provide script (inline dialect text) ' +
        'or scriptPath, or resumeFromRunId to resume a terminal run (completed agents replay free). ' +
        'budget is a token ceiling like "500k", enforced at the dispatch gate (new agents stop; in-flight calls may overshoot by a bounded margin). backend (REQUIRED for a fresh start) is one of mock|codex|qoder|claude|gemini — mock returns fabricated stubs (rehearsal only), so pass a real backend for real work. ' +
        'wallClockMs (run wall-clock cap) and attemptTimeoutMs (per-attempt agent timeout; per-call opts.timeoutMs still wins) are unclamped and default to UNLIMITED — pass them ONLY when the user explicitly asked for a time limit, and never invent one. On resume an omitted cap inherits the prior run\'s value; pass 0 to clear an inherited cap back to unlimited.',
      inputSchema: {
        script: z.string().optional(),
        scriptPath: z.string().optional(),
        args: z.unknown().optional(),
        backend: z.string().optional(),
        budget: z.string().optional(),
        maxAgents: z.number().int().positive().optional(),
        maxConcurrency: z.number().int().positive().optional(),
        permission: z.enum(['safe', 'auto', 'danger']).optional(),
        wallClockMs: z.number().int().nonnegative().optional(),
        attemptTimeoutMs: z.number().int().nonnegative().optional(),
        resumeFromRunId: z.string().optional(),
        cwd: z.string().optional(),
      },
    },
    async (input) => {
      // Recursion guard: an ultracode MCP server inherited by a spawned worker
      // (which sets ULTRACODE_INSIDE_RUN) must not launch fresh detached runs —
      // that would fan out past the parent's budget/caps. Use in-script
      // workflow() for nested orchestration (it shares the parent's caps/budget).
      // KNOWN LIMIT: codex spawns config-registered MCP servers with a sanitized
      // env, so this marker never reaches a server a codex worker spawned itself
      // (live-verified on 0.144.5 — the 2026-07-16 fork-bomb rode exactly that).
      // The primary defense for codex workers is the spawn-time kill-switch in
      // the adapter (MCP_KILL_SWITCH, src/backends/codex.ts); this guard remains
      // for hosts that propagate env to MCP servers.
      if (process.env.ULTRACODE_INSIDE_RUN) {
        return fail('workflow_start refused: already inside an ultracode run (recursion guard). Use in-script workflow() for nesting.');
      }
      // Require an explicit backend for a fresh start. Defaulting to 'mock' would
      // silently run real review/research work on the mock backend — which
      // returns plausible fabricated stubs without touching the repo, so a fake
      // run looks successful. (Resume inherits the prior run's backend.)
      if (!input.resumeFromRunId && !input.backend) {
        return fail(
          'workflow_start requires an explicit backend (mock|codex|qoder|claude|gemini). ' +
            '"mock" returns fabricated stub output — pass it only to rehearse the dialect, never for real work.',
        );
      }
      try {
        const result = await startDetachedRun({
          script: input.script,
          scriptPath: input.scriptPath,
          args: input.args,
          backend: input.backend,
          budgetTotal: input.budget ? parseBudget(input.budget) : null,
          maxAgents: input.maxAgents,
          maxConcurrency: input.maxConcurrency,
          permission: input.permission,
          wallClockMs: input.wallClockMs,
          attemptTimeoutMs: input.attemptTimeoutMs,
          resumeFromRunId: input.resumeFromRunId,
          cwd: input.cwd ?? baseCwd,
        });
        return ok({
          runId: result.runId,
          name: result.name,
          runDir: result.dir,
          monitor: `call workflow_status {runId: '${result.runId}', until: 'terminal', waitSeconds: 3300 on the codex hostpack (else your MCP tool timeout − 60)}; re-issue until terminal and park silently between wakes ('phase' wakes per milestone if commentary is wanted)`,
        });
      } catch (err) {
        return fail((err as Error).message);
      }
    },
  );

  server.registerTool(
    'workflow_status',
    {
      description:
        'Run status long-poll. until="terminal" is the quiet monitor: wakes only when the run ends ' +
        'or after waitSeconds (re-issue the same call), rolling the last 40 log lines into each ' +
        'response; until="phase" additionally wakes at phase boundaries (boundaries crossed in one ' +
        'read batch into a single wake — each appears in logTail) — the sanctioned channel ' +
        'for milestone updates. Between wakes park silently: failures and crashes wake the monitor, ' +
        'so skip filler updates, refresh polls, and run-store tailing. Every wake costs a model ' +
        'turn — pass the largest waitSeconds your host MCP tool timeout allows: codex hostpack ' +
        '(tool_timeout_sec=3600) → 3300; stock codex 300 → 240; qoder/gemini 600 → 540; holds dying ' +
        'early mean a lower pinned timeout (drop waitSeconds below the cutoff, re-run `ultracode ' +
        'install codex`). Default until="activity" returns on new log lines past sinceEventOffset — ' +
        'pass nextEventOffset back for only fresh lines. Timed-out polls are harmless — call again.',
      inputSchema: {
        runId: z.string(),
        until: z.enum(['activity', 'phase', 'terminal']).optional(),
        waitSeconds: z.number().min(0).max(MAX_WAIT_SECONDS).optional(),
        sinceEventOffset: z.number().int().min(0).optional(),
        cwd: z.string().optional(),
      },
    },
    async (input, extra) => {
      const root = rootFor(input.cwd);
      const quiet = input.until === 'terminal' || input.until === 'phase';
      const wait = Math.min(input.waitSeconds ?? DEFAULT_WAIT_SECONDS, MAX_WAIT_SECONDS) * 1000;
      const deadline = Date.now() + wait;
      let offset = input.sinceEventOffset ?? 0;
      const progressToken = (extra as { _meta?: { progressToken?: string | number } })._meta?.progressToken;
      let ticks = 0;
      let progressAt = Date.now();
      // Rolling tail: quiet holds roll renderable lines up instead of waking
      // on them. The cursor never advances past content without it passing
      // through this tail — though the tail is lossy at TAIL_LINES, and the
      // full log always lives in the run store / workflow_result.
      const tail: string[] = [];

      for (;;) {
        const run = getRun(root, input.runId);
        if (!run) return fail(`no run ${input.runId} under ${root}`);
        const eventsFile = join(run.dir, 'events.jsonl');
        // Bounded read: a first poll against a long-running backlog must not
        // allocate/parse the whole file (clients page via nextEventOffset).
        const page = readEventsFrom(eventsFile, offset, 4 * 1024 * 1024);
        offset = page.nextOffset; // consume even null-rendered pages so ticks are never re-read
        const terminal = isTerminal(run.effectiveStatus);
        // Wake on RENDERABLE lines, not raw events: agent_usage ticks arrive
        // ~1/s per running agent and render null — waking on them would return
        // empty logTails in a tight loop, burning the polling host's tokens.
        const fresh = page.events
          .map((e: TimestampedEvent) => renderEvent(e))
          .filter((l): l is string => l !== null);
        // Bounded append: only the last TAIL_LINES lines can survive, so never
        // spread the raw page (a dense 4 MB page holds ~80k renderable lines —
        // enough to overflow V8's argument limit) and cap each stored line.
        const keep = fresh.slice(-TAIL_LINES).map((l) => (l.length > TAIL_LINE_CHARS ? `${l.slice(0, TAIL_LINE_CHARS)}…` : l));
        if (keep.length === TAIL_LINES) tail.length = 0;
        tail.push(...keep);
        if (tail.length > TAIL_LINES) tail.splice(0, tail.length - TAIL_LINES);
        const phaseHit = input.until === 'phase' && page.events.some((e: TimestampedEvent) => e.type === 'phase_started');

        // A terminal quiet wake serves the run's REAL tail with the cursor at
        // EOF — returning mid-backlog would serve the head of the log. Jump
        // straight to the final window instead of paging: only it can hold
        // the last TAIL_LINES renderable lines, and synchronously JSON-parsing
        // a multi-MB backlog would block this single-threaded stdio server.
        // (A mid-line landing is fine — the torn fragment fails to parse and
        // is dropped, exactly like any other malformed line.)
        if (quiet && terminal && page.hasMore) {
          try {
            const end = statSync(eventsFile).size;
            const jump = Math.max(page.nextOffset, end - 4 * 1024 * 1024);
            if (jump > page.nextOffset) tail.length = 0;
            offset = jump;
          } catch {
            /* fall back to plain paging */
          }
          continue;
        }

        const wake = quiet ? terminal || phaseHit : fresh.length > 0 || terminal;
        if (wake || Date.now() >= deadline || extra.signal.aborted) {
          const m = run.manifest;
          return ok({
            runId: input.runId,
            status: run.effectiveStatus,
            phases: m.phases,
            agentCount: m.agentCount,
            budget: m.budget,
            logTail: tail,
            nextEventOffset: offset,
            terminal,
            ...(terminal
              ? { next: `call workflow_result with runId=${input.runId}` }
              : quiet
                ? {
                    next: `re-issue this hold with sinceEventOffset: ${offset} and park silently — failures wake this monitor; filler updates, refresh polls, and run-store tailing waste turns`,
                    ...(wait < SHORT_HOLD_NUDGE_MS
                      ? { hint: 'short quiet holds burn a model turn per wake — re-issue with waitSeconds close to your MCP tool timeout (codex hostpack pins 3600 → pass 3300)' }
                      : {}),
                  }
                : {}),
          });
        }

        // Catching up on a clipped backlog (e.g. tick-heavy pages): read the
        // next page immediately — pacing 4 MB per 300 ms would starve clients.
        // But yield between the synchronous 4 MB parses (watch.ts does the
        // same): a long backlog must not starve the event loop, or sibling
        // MCP calls and cancellations stall behind this one.
        if (page.hasMore) {
          await sleep(0);
          continue;
        }

        if (!quiet && progressToken !== undefined && Date.now() - progressAt >= PROGRESS_INTERVAL_MS) {
          progressAt = Date.now();
          try {
            await extra.sendNotification({
              method: 'notifications/progress',
              params: { progressToken, progress: ++ticks, message: `waiting: ${run.effectiveStatus}, ${run.manifest.agentCount} agents so far` },
            });
          } catch {
            /* progress is best-effort */
          }
        }
        // Quiet holds have no sub-second wake source (terminal flip and
        // deadline only) — a wider idle tick cuts syscall churn 3× over a
        // 55-minute park at imperceptible extra latency.
        await sleep(quiet ? 1_000 : 300);
      }
    },
  );

  server.registerTool(
    'workflow_result',
    {
      description: 'Final output of a terminal run: result, logs, failures, usage, artifact paths.',
      inputSchema: { runId: z.string(), cwd: z.string().optional() },
    },
    async (input) => {
      const root = rootFor(input.cwd);
      const run = getRun(root, input.runId);
      if (!run) return fail(`no run ${input.runId} under ${root}`);
      if (!isTerminal(run.effectiveStatus)) {
        return fail(`run is still ${run.effectiveStatus} — keep polling workflow_status`, {
          status: run.effectiveStatus,
        });
      }
      const outputFile = join(run.dir, 'output.json');
      if (!existsSync(outputFile)) {
        return fail(`run ${input.runId} is ${run.effectiveStatus} but wrote no output.json (runner died?)`, {
          status: run.effectiveStatus,
          runDir: run.dir,
        });
      }
      const output = JSON.parse(readFileSync(outputFile, 'utf8')) as Record<string, unknown>;
      return ok({
        runId: input.runId,
        status: run.effectiveStatus,
        ...output,
        artifacts: { runDir: run.dir, journal: join(run.dir, 'journal.jsonl'), agentsDir: join(run.dir, 'agents') },
        ...(run.effectiveStatus !== 'completed'
          ? { recovery: `workflow_start with resumeFromRunId=${input.runId} replays completed agents free` }
          : {}),
      });
    },
  );

  server.registerTool(
    'workflow_stop',
    {
      description: 'Stop a running workflow (SIGTERM → 7s grace → SIGKILL). Journal and partial output survive.',
      inputSchema: { runId: z.string(), cwd: z.string().optional() },
    },
    async (input) => {
      // Same recursion/confused-deputy guard as workflow_start: a worker that
      // inherited this MCP server could plant a fake run manifest carrying any
      // same-user PID and call workflow_stop to make this (unsandboxed) process
      // signal that PID. Refuse to signal from inside a run.
      if (process.env.ULTRACODE_INSIDE_RUN) {
        return fail('workflow_stop refused: cannot stop runs from inside an ultracode run (recursion guard).');
      }
      const result = await stopRun(rootFor(input.cwd), input.runId);
      return result.ok ? ok({ runId: input.runId, status: result.status, message: result.message }) : fail(result.message);
    },
  );

  server.registerTool(
    'workflow_list',
    {
      description:
        'List workflow runs in the project run store. By default returns the 10 most recent active-or-last-24h runs, plus hidden (how many the cap omitted); pass all=true to include older finished runs, or count=N.',
      inputSchema: { cwd: z.string().optional(), all: z.boolean().optional(), count: z.number().int().positive().optional() },
    },
    async (input) => {
      const { runs, hidden } = recentRuns(rootFor(input.cwd), { all: input.all, count: input.count });
      return ok({
        runs: runs.map((r) => ({
          runId: r.runId,
          status: r.effectiveStatus,
          name: r.manifest.name,
          startedAt: r.manifest.startedAt,
          agents: r.manifest.agentCount,
          tokens: r.manifest.budget.spent,
        })),
        hidden,
      });
    },
  );

  return server;
}

export async function mcpMain(): Promise<void> {
  const server = createServer(process.cwd());
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Serve until the client closes the transport.
  await new Promise<void>((resolve) => {
    transport.onclose = () => resolve();
  });
}
