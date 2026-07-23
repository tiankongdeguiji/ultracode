import { existsSync, readFileSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { parseWorkflowScript } from '../engine/meta.js';
import { resolveWorkflowSource } from '../installer/registry.js';
import { executeWorkflow, validateArgsAgainstInputSchema } from '../engine/run.js';
import { defaultConcurrency } from '../engine/semaphore.js';
import { MockExecutor } from '../backends/mock.js';
import { parseBudget } from '../budget/parse.js';
import { looksNamespaceLocal } from '../exec/procinfo.js';
import { newRunId, ultracodeRoot } from '../store/layout.js';
import { createRunDir } from '../store/runstore.js';
import { launchRunner } from '../exec/daemonize.js';
import { IMPLEMENTED_BACKENDS } from '../exec/start.js';
import { loadSubagentConfig, type SubagentDefaults } from '../config.js';
import { attachForeground, printOutput } from './lifecycle.js';
import { readContextWindowOpt, readMaxConcurrencyOpt, readNonEmptyOpt, refuseInsideWorker } from './options.js';
import { validateScript } from './validate.js';

export interface RunCliOptions {
  args?: string;
  backend?: string;
  model?: string;
  effort?: string;
  contextWindow?: string;
  maxAgents?: string;
  maxConcurrency?: string;
  budget?: string;
  permission?: string;
  timeout?: string;
  detach?: boolean;
  dryRun?: boolean;
  yes?: boolean;
  json?: boolean;
  plain?: boolean;
  noColor?: boolean;
  home?: string;
  allowNested?: boolean;
}

/**
 * Execution ALWAYS happens in a detached runner process; the CLI attaches in
 * the foreground by default (Ctrl-C = explicit stop; shell death = run
 * survives). --detach prints the runId and returns immediately.
 */
export async function runCommand(file: string, opts: RunCliOptions): Promise<number> {
  // --dry-run stays exempt: it rehearses in-process on the mock backend (no
  // tokens, no run dir), and a worker validating a workflow it authored is a
  // legitimate task.
  if (!opts.dryRun && refuseInsideWorker('start a run', opts.allowNested)) return 1;

  let defaults: SubagentDefaults;
  try {
    defaults = loadSubagentConfig(process.cwd());
  } catch (err) {
    process.stderr.write(`ultracode: ${(err as Error).message}\n`);
    return 1;
  }
  const backend = opts.backend ?? defaults.backend ?? (opts.dryRun ? 'mock' : undefined);
  if (backend === undefined) {
    process.stderr.write(
      `ultracode: run requires --backend or subagent.backend in ultracode config ` +
        `(use --dry-run for a mock rehearsal)\n`,
    );
    return 1;
  }
  if (!IMPLEMENTED_BACKENDS.has(backend)) {
    process.stderr.write(
      `ultracode: backend '${backend}' is not implemented yet (available: ${[...IMPLEMENTED_BACKENDS].join(', ')})\n`,
    );
    return 1;
  }
  const modelOpt = readNonEmptyOpt(opts.model, '--model');
  const effortOpt = readNonEmptyOpt(opts.effort, '--effort');
  const contextWindowOpt = readContextWindowOpt(opts.contextWindow);
  if (!modelOpt.ok || !effortOpt.ok || !contextWindowOpt.ok) return 1;
  const model = modelOpt.value ?? defaults.model;
  const effort = effortOpt.value ?? defaults.effort;
  const contextWindow = contextWindowOpt.value ?? defaults.contextWindow;

  let source: string;
  try {
    // Accept a file path or a registry name (.ultracode/workflows, packaged).
    if (existsSync(file)) {
      source = readFileSync(file, 'utf8');
    } else {
      source = resolveWorkflowSource(file, process.cwd());
    }
  } catch (err) {
    process.stderr.write(`ultracode: cannot resolve workflow '${file}': ${(err as Error).message}\n`);
    return 1;
  }

  // Fail fast on invalid scripts before creating any run state.
  let parsed: ReturnType<typeof parseWorkflowScript>;
  try {
    parsed = parseWorkflowScript(source);
  } catch (err) {
    process.stderr.write(`ultracode: invalid workflow: ${(err as Error).message}\n`);
    return 1;
  }
  const name = parsed.meta.name;

  let args: unknown = null;
  if (opts.args !== undefined) {
    try {
      args = JSON.parse(opts.args);
    } catch {
      args = opts.args; // plain string args are legal
    }
  }

  // Validate args against meta.inputSchema BEFORE creating any run dir — else a
  // bad-args run creates the dir, launches, and the runner fails after marking
  // the manifest 'running', leaving an orphan with no output.json.
  try {
    validateArgsAgainstInputSchema(parsed, args ?? undefined);
  } catch (err) {
    process.stderr.write(`ultracode: ${(err as Error).message}\n`);
    return 1;
  }

  let budgetTotal: number | null = null;
  if (opts.budget) {
    try {
      budgetTotal = parseBudget(opts.budget);
    } catch (err) {
      process.stderr.write(`ultracode: ${(err as Error).message}\n`);
      return 1;
    }
  }

  const permission = (opts.permission ?? 'auto') as 'safe' | 'auto' | 'danger';
  if (!['safe', 'auto', 'danger'].includes(permission)) {
    process.stderr.write(`ultracode: --permission must be safe|auto|danger\n`);
    return 1;
  }

  // Fail fast on a bad cap BEFORE any run dir exists — a non-positive or
  // fractional value would crash the runner after the manifest says 'running',
  // orphaning the run (the MCP path gets this guard from zod; the CLI must match).
  const mcOpt = readMaxConcurrencyOpt(opts.maxConcurrency);
  if (!mcOpt.ok) return 1;
  const maxConcurrencyOpt = mcOpt.value;

  // Same fail-fast for an explicit --timeout: an operator who asked for a cap
  // must never silently get an uncapped run (NaN would store as null). 0 =
  // unlimited, matching the MCP clear-the-cap semantic.
  const timeoutMin = opts.timeout === undefined ? undefined : Number(opts.timeout);
  if (timeoutMin !== undefined && (!Number.isFinite(timeoutMin) || timeoutMin < 0)) {
    process.stderr.write(`ultracode: --timeout must be a non-negative number of minutes\n`);
    return 1;
  }

  // Dry run: rehearse on the mock backend in-process — free, instant, and
  // exercises the identical dialect semantics (schema validation included).
  if (opts.dryRun) {
    process.stderr.write(`▷ dry run (mock backend, no tokens, no run dir)\n`);
    const output = await executeWorkflow(source, {
      executor: new MockExecutor(),
      args,
      budgetTotal,
      defaultBackend: backend,
      defaultModel: model,
      defaultEffort: effort,
      defaultContextWindow: contextWindow,
      maxAgents: opts.maxAgents ? Number(opts.maxAgents) : undefined,
      maxConcurrency: maxConcurrencyOpt,
    });
    process.stdout.write(JSON.stringify(output, null, 2) + '\n');
    return output.error ? 1 : 0;
  }

  const maxConcurrency = maxConcurrencyOpt ?? defaultConcurrency();

  // Review before run: print the plan; require confirmation unless --yes.
  if (!opts.yes) {
    const report = validateScript(source);
    process.stderr.write(
      [
        `Review dynamic workflow before running:`,
        `  ${report.name} — ${report.description}`,
        `  phases: ${report.phaseTitles?.join(', ') || '(none)'}`,
        `  static agent calls: ${report.agentCalls?.length ?? 0}` +
          (report.callCounts?.parallel || report.callCounts?.pipeline
            ? ` (+ dynamic fan-out via ${['parallel', 'pipeline'].filter((f) => report.callCounts?.[f]).join('/')})`
            : ''),
        `  backend: ${backend}  model: ${model ?? 'default'}  effort: ${effort ?? 'default'}  contextWindow: ${contextWindow ?? 'default'}`,
        `  permission: ${permission}  budget: ${budgetTotal ?? 'unlimited'}  concurrency: ${maxConcurrency}`,
      ].join('\n') + '\n',
    );
    if (!process.stdin.isTTY) {
      process.stderr.write(`ultracode: refusing to run unreviewed in a non-interactive shell — pass --yes\n`);
      return 1;
    }
    const rl = createInterface({ input: process.stdin, output: process.stderr });
    const answer = (await rl.question('Run this workflow? [y/N] ')).trim().toLowerCase();
    rl.close();
    if (answer !== 'y' && answer !== 'yes') {
      process.stderr.write('aborted\n');
      return 1;
    }
  }

  const root = ultracodeRoot(process.cwd(), opts.home);
  const runId = newRunId();
  const dir = createRunDir(root, {
    runId,
    name,
    source,
    args,
    config: {
      backend,
      model,
      effort,
      contextWindow,
      cwd: process.cwd(),
      maxAgents: opts.maxAgents ? Number(opts.maxAgents) : undefined,
      maxConcurrency,
      budgetTotal,
      permission,
      wallClockMs: timeoutMin === undefined || timeoutMin === 0 ? undefined : Math.round(timeoutMin * 60_000),
    },
  });

  try {
    await launchRunner(dir);
  } catch (err) {
    process.stderr.write(`ultracode: ${(err as Error).message}\n`);
    return 1;
  }

  if (opts.detach) {
    process.stdout.write(`${runId}\n`);
    // A namespace-local pid means THIS CLI is inside a fresh PID namespace
    // (agent exec jail, one-shot container) — the detached runner dies with
    // it. Warn at launch; the corpse is otherwise silent (SIGKILL, no logs).
    if (looksNamespaceLocal(process.pid)) {
      process.stderr.write(
        `⚠ heuristic: this shell has a namespace-local pid (${process.pid}). If it is a TRANSIENT sandbox (agent exec jail), the detached runner dies when it exits — long-lived containers are fine. Verify liveness: ultracode status\n`,
      );
    }
    process.stderr.write(`run dir: ${dir}\nmonitor: ultracode watch ${runId}\n`);
    return 0;
  }

  process.stderr.write(`▶ ${runId} (${dir})\n`);
  const { exitCode } = await attachForeground(dir, { quiet: opts.json, plain: opts.plain, noColor: opts.noColor });
  if (opts.json) printOutput(dir);
  return exitCode;
}
