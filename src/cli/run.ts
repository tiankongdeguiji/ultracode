import { readFileSync } from 'node:fs';
import { executeWorkflow } from '../engine/run.js';
import { MockExecutor } from '../backends/mock.js';

export interface RunCliOptions {
  args?: string;
  backend?: string;
  maxAgents?: string;
  maxConcurrency?: string;
  json?: boolean;
}

/**
 * M3 shape: in-process foreground execution on the mock backend. M4 replaces
 * the internals with the detached runner + run store while keeping the UX.
 */
export async function runCommand(file: string, opts: RunCliOptions): Promise<number> {
  const backend = opts.backend ?? 'mock';
  if (backend !== 'mock') {
    process.stderr.write(`ultracode: backend '${backend}' is not implemented yet (available: mock)\n`);
    return 1;
  }

  let source: string;
  try {
    source = readFileSync(file, 'utf8');
  } catch (err) {
    process.stderr.write(`ultracode: cannot read ${file}: ${(err as Error).message}\n`);
    return 1;
  }

  let args: unknown;
  if (opts.args !== undefined) {
    try {
      args = JSON.parse(opts.args);
    } catch {
      args = opts.args; // plain string args are legal
    }
  }

  const output = await executeWorkflow(source, {
    executor: new MockExecutor(),
    args,
    defaultBackend: backend,
    maxAgents: opts.maxAgents ? Number(opts.maxAgents) : undefined,
    maxConcurrency: opts.maxConcurrency ? Number(opts.maxConcurrency) : undefined,
    onEvent: opts.json
      ? undefined
      : (ev) => {
          if (ev.type === 'phase_started') process.stderr.write(`── phase: ${ev.title}\n`);
          if (ev.type === 'agent_started') process.stderr.write(`   agent[${ev.seq}] ${ev.label} started\n`);
          if (ev.type === 'agent_completed' && 'ok' in ev) {
            process.stderr.write(`   agent[${ev.seq}] ${ev.label} ${ev.ok ? 'done' : `FAILED: ${ev.error ?? ''}`}\n`);
          }
          if (ev.type === 'workflow_log') process.stderr.write(`   log: ${ev.message}\n`);
        },
  });

  process.stdout.write(JSON.stringify(output, null, 2) + '\n');
  return output.error ? 1 : 0;
}
