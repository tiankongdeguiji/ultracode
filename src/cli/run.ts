import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { parseWorkflowScript } from '../engine/meta.js';
import { executeWorkflow } from '../engine/run.js';
import { defaultConcurrency } from '../engine/semaphore.js';
import { MockExecutor } from '../backends/mock.js';
import { codexConcurrencyPolicy, detectCodexAuth } from '../backends/codex-auth.js';
import { parseBudget } from '../budget/parse.js';
import { newRunId, ultracodeRoot } from '../store/layout.js';
import { createRunDir } from '../store/runstore.js';
import { launchRunner } from '../exec/daemonize.js';
import { attachForeground, printOutput } from './lifecycle.js';
import { validateScript } from './validate.js';

export interface RunCliOptions {
  args?: string;
  backend?: string;
  maxAgents?: string;
  maxConcurrency?: string;
  budget?: string;
  permission?: string;
  timeout?: string;
  detach?: boolean;
  dryRun?: boolean;
  yes?: boolean;
  forceOauthFanout?: boolean;
  json?: boolean;
  home?: string;
}

const IMPLEMENTED_BACKENDS = new Set(['mock', 'codex', 'qoder', 'claude', 'gemini']);

/**
 * Execution ALWAYS happens in a detached runner process; the CLI attaches in
 * the foreground by default (Ctrl-C = explicit stop; shell death = run
 * survives). --detach prints the runId and returns immediately.
 */
export async function runCommand(file: string, opts: RunCliOptions): Promise<number> {
  const backend = opts.backend ?? 'mock';
  if (!IMPLEMENTED_BACKENDS.has(backend)) {
    process.stderr.write(
      `ultracode: backend '${backend}' is not implemented yet (available: ${[...IMPLEMENTED_BACKENDS].join(', ')})\n`,
    );
    return 1;
  }

  let source: string;
  try {
    source = readFileSync(file, 'utf8');
  } catch (err) {
    process.stderr.write(`ultracode: cannot read ${file}: ${(err as Error).message}\n`);
    return 1;
  }

  // Fail fast on invalid scripts before creating any run state.
  let name: string;
  try {
    name = parseWorkflowScript(source).meta.name;
  } catch (err) {
    process.stderr.write(`ultracode: invalid workflow: ${(err as Error).message}\n`);
    return 1;
  }

  let args: unknown = null;
  if (opts.args !== undefined) {
    try {
      args = JSON.parse(opts.args);
    } catch {
      args = opts.args; // plain string args are legal
    }
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

  // Dry run: rehearse on the mock backend in-process — free, instant, and
  // exercises the identical dialect semantics (schema validation included).
  if (opts.dryRun) {
    process.stderr.write(`▷ dry run (mock backend, no tokens, no run dir)\n`);
    const output = await executeWorkflow(source, {
      executor: new MockExecutor(),
      args,
      budgetTotal,
      defaultBackend: 'mock',
      maxAgents: opts.maxAgents ? Number(opts.maxAgents) : undefined,
      maxConcurrency: opts.maxConcurrency ? Number(opts.maxConcurrency) : undefined,
    });
    process.stdout.write(JSON.stringify(output, null, 2) + '\n');
    return output.error ? 1 : 0;
  }

  // Auth-aware concurrency policy: ChatGPT-OAuth fan-out is unsafe.
  let maxConcurrency = opts.maxConcurrency ? Number(opts.maxConcurrency) : defaultConcurrency();
  if (backend === 'codex') {
    const policy = codexConcurrencyPolicy(maxConcurrency, detectCodexAuth(), opts.forceOauthFanout === true);
    if (policy.warning) process.stderr.write(`⚠ ${policy.warning}\n`);
    maxConcurrency = policy.maxConcurrency;
  }

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
        `  backend: ${backend}  permission: ${permission}  budget: ${budgetTotal ?? 'unlimited'}  concurrency: ${maxConcurrency}`,
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
      cwd: process.cwd(),
      maxAgents: opts.maxAgents ? Number(opts.maxAgents) : undefined,
      maxConcurrency,
      budgetTotal,
      permission,
      wallClockMs: opts.timeout ? Number(opts.timeout) * 60_000 : undefined,
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
    process.stderr.write(`run dir: ${dir}\nmonitor: ultracode status ${runId} --watch\n`);
    return 0;
  }

  process.stderr.write(`▶ ${runId} (${dir})\n`);
  const { exitCode } = await attachForeground(dir, { quiet: opts.json });
  if (opts.json) printOutput(dir);
  return exitCode;
}
