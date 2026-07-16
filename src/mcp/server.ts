/**
 * ultracode MCP server (stdio): the workflow_start / workflow_status /
 * workflow_result / workflow_stop / workflow_list triad(+2).
 *
 * Design constraints (source-verified across Codex/Qoder/Gemini hosts):
 *  - No host extends tool timeouts on progress → every call returns fast;
 *    workflow_status long-polls but clamps at 50s (under every default:
 *    60s legacy Codex, 300s current Codex, 600s Qoder/Gemini).
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
import { getRun, listRuns } from '../store/runstore.js';
import { ultracodeRoot } from '../store/layout.js';
import { renderEvent } from '../cli/lifecycle.js';
import { readFileSync, existsSync } from 'node:fs';

const INSTRUCTIONS =
  'Dynamic multi-agent workflow orchestration. workflow_start returns a runId in <1s and the run ' +
  'survives this server. Poll workflow_status (long-poll ≤50s; pass nextEventOffset back) until ' +
  'status is terminal, then call workflow_result. A timed-out poll is harmless — re-poll the same ' +
  'runId. Author scripts per the ultracode skill dialect (export const meta + agent/parallel/pipeline).';

const MAX_WAIT_SECONDS = 50;
const DEFAULT_WAIT_SECONDS = 25;

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
        'budget is a token ceiling like "500k", enforced at the dispatch gate (new agents stop; in-flight calls may overshoot by a bounded margin). backend (REQUIRED for a fresh start) is one of mock|codex|qoder|claude|gemini — mock returns fabricated stubs (rehearsal only), so pass a real backend for real work.',
      inputSchema: {
        script: z.string().optional(),
        scriptPath: z.string().optional(),
        args: z.unknown().optional(),
        backend: z.string().optional(),
        budget: z.string().optional(),
        maxAgents: z.number().int().positive().optional(),
        maxConcurrency: z.number().int().positive().optional(),
        permission: z.enum(['safe', 'auto', 'danger']).optional(),
        resumeFromRunId: z.string().optional(),
        cwd: z.string().optional(),
      },
    },
    async (input) => {
      // Recursion guard: an ultracode MCP server inherited by a spawned worker
      // (which sets ULTRACODE_INSIDE_RUN) must not launch fresh detached runs —
      // that would fan out past the parent's budget/caps. Use in-script
      // workflow() for nested orchestration (it shares the parent's caps/budget).
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
          resumeFromRunId: input.resumeFromRunId,
          cwd: input.cwd ?? baseCwd,
        });
        return ok({
          runId: result.runId,
          name: result.name,
          runDir: result.dir,
          monitor: `call workflow_status with runId=${result.runId}; poll until terminal`,
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
        'Run status with long-poll: returns immediately when new events exist past sinceEventOffset or ' +
        'the run is terminal, else waits up to waitSeconds (≤50). Pass nextEventOffset from the previous ' +
        'call to receive only fresh log lines. Timed-out polls are harmless — call again.',
      inputSchema: {
        runId: z.string(),
        waitSeconds: z.number().min(0).max(600).optional(),
        sinceEventOffset: z.number().int().min(0).optional(),
        cwd: z.string().optional(),
      },
    },
    async (input, extra) => {
      const root = rootFor(input.cwd);
      const wait = Math.min(input.waitSeconds ?? DEFAULT_WAIT_SECONDS, MAX_WAIT_SECONDS) * 1000;
      const deadline = Date.now() + wait;
      let offset = input.sinceEventOffset ?? 0;
      const progressToken = (extra as { _meta?: { progressToken?: string | number } })._meta?.progressToken;
      let ticks = 0;

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
        const logTail = page.events
          .map((e: TimestampedEvent) => renderEvent(e))
          .filter((l): l is string => l !== null);

        if (logTail.length > 0 || terminal || Date.now() >= deadline) {
          const m = run.manifest;
          return ok({
            runId: input.runId,
            status: run.effectiveStatus,
            phases: m.phases,
            agentCount: m.agentCount,
            budget: m.budget,
            logTail: logTail.slice(-40),
            nextEventOffset: offset,
            terminal,
            ...(terminal ? { next: `call workflow_result with runId=${input.runId}` } : {}),
          });
        }

        // Catching up on a clipped backlog (e.g. tick-heavy pages): read the
        // next page immediately — pacing 4 MB per 300 ms would starve clients.
        if (page.hasMore) continue;

        if (progressToken !== undefined) {
          try {
            await extra.sendNotification({
              method: 'notifications/progress',
              params: { progressToken, progress: ++ticks, message: `waiting: ${run.effectiveStatus}, ${run.manifest.agentCount} agents so far` },
            });
          } catch {
            /* progress is best-effort */
          }
        }
        await sleep(300);
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
      description: 'List workflow runs in the project run store.',
      inputSchema: { cwd: z.string().optional(), all: z.boolean().optional() },
    },
    async (input) => {
      const runs = listRuns(rootFor(input.cwd))
        .filter((r) => input.all || !isTerminal(r.effectiveStatus) || Date.parse(r.manifest.startedAt) > Date.now() - 24 * 3600e3)
        .map((r) => ({
          runId: r.runId,
          status: r.effectiveStatus,
          name: r.manifest.name,
          startedAt: r.manifest.startedAt,
          agents: r.manifest.agentCount,
          tokens: r.manifest.budget.spent,
        }));
      return ok({ runs });
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
