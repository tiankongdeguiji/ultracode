import { readFileSync } from 'node:fs';
import { parseWorkflowScript } from '../engine/meta.js';
import { newRunId, ultracodeRoot } from '../store/layout.js';
import { createRunDir } from '../store/runstore.js';
import { launchRunner } from '../exec/daemonize.js';
import { attachForeground, printOutput } from './lifecycle.js';

export interface RunCliOptions {
  args?: string;
  backend?: string;
  maxAgents?: string;
  maxConcurrency?: string;
  detach?: boolean;
  json?: boolean;
  home?: string;
}

const IMPLEMENTED_BACKENDS = new Set(['mock']);

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
      maxConcurrency: opts.maxConcurrency ? Number(opts.maxConcurrency) : undefined,
      budgetTotal: null,
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
