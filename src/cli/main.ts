#!/usr/bin/env node
import { Command } from 'commander';
import { VERSION } from '../version.js';
import { runValidateCommand } from './validate.js';

if (process.platform === 'win32') {
  process.stderr.write(
    'ultracode: Windows is not supported in v1 (POSIX process-group semantics required). Use WSL.\n',
  );
  process.exit(1);
}

const program = new Command();

program.name('ultracode').description('Portable dynamic workflow orchestration for coding agents').version(VERSION);

program
  .command('run')
  .argument('<script>', 'workflow script file (*.workflow.js)')
  .description('run a workflow (detached runner; foreground attach by default)')
  .option('--args <json>', 'workflow args (JSON or plain string)')
  .option('--backend <id>', 'default backend for agents', 'mock')
  .option('--max-agents <n>', 'soft lifetime agent cap (hard ceiling 1000)')
  .option('--max-concurrency <n>', 'concurrent agent cap (default min(16, cores-2))')
  .option('--detach', 'print runId and return immediately')
  .option('--json', 'suppress progress; print output.json at the end')
  .option('--home <dir>', 'run-store root (default <cwd>/.ultracode or $ULTRACODE_HOME)')
  .action(async (script: string, opts: Record<string, string | boolean>) => {
    const { runCommand } = await import('./run.js');
    process.exit(await runCommand(script, opts as never));
  });

program
  .command('status')
  .argument('<runId>')
  .description('show run status (phases, agents, budget)')
  .option('--watch', 'poll until terminal')
  .option('--json')
  .option('--home <dir>')
  .action(async (runId: string, opts: Record<string, string | boolean>) => {
    const { statusCommand } = await import('./lifecycle.js');
    process.exit(await statusCommand(runId, opts as never));
  });

program
  .command('logs')
  .argument('<runId>')
  .description('print run events')
  .option('--follow', 'keep tailing until terminal')
  .option('--home <dir>')
  .action(async (runId: string, opts: Record<string, string | boolean>) => {
    const { logsCommand } = await import('./lifecycle.js');
    process.exit(await logsCommand(runId, opts as never));
  });

program
  .command('stop')
  .argument('<runId>')
  .description('stop a running workflow (SIGTERM → 7s → SIGKILL)')
  .option('--home <dir>')
  .action(async (runId: string, opts: Record<string, string | boolean>) => {
    const { stopCommand } = await import('./lifecycle.js');
    process.exit(await stopCommand(runId, opts as never));
  });

program
  .command('list')
  .description('list runs in the run store')
  .option('--all', 'include old terminal runs')
  .option('--reap', 'finalize orphaned runs first')
  .option('--json')
  .option('--home <dir>')
  .action(async (opts: Record<string, string | boolean>) => {
    const { listCommand } = await import('./lifecycle.js');
    process.exit(listCommand(opts as never));
  });

program
  .command('validate')
  .argument('<script>', 'workflow script file (*.workflow.js)')
  .description('validate meta block, dialect constraints, and compilability')
  .option('--json', 'machine-readable output')
  .action((script: string, opts: { json?: boolean }) => {
    process.exit(runValidateCommand(script, opts));
  });

program
  .command('__runner', { hidden: true })
  .requiredOption('--run-dir <dir>')
  .action(async (opts: { runDir: string }) => {
    const { runnerMain } = await import('./runner.js');
    try {
      process.exit(await runnerMain(opts.runDir));
    } catch (err) {
      process.stderr.write(`runner fatal: ${(err as Error)?.stack ?? err}\n`);
      process.exit(1);
    }
  });

program.parseAsync().catch((err) => {
  process.stderr.write(`ultracode: ${err?.message ?? err}\n`);
  process.exit(1);
});
