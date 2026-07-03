#!/usr/bin/env node
import { Command } from 'commander';
import { VERSION } from '../index.js';
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
  .description('run a workflow script')
  .option('--args <json>', 'workflow args (JSON or plain string)')
  .option('--backend <id>', 'default backend for agents', 'mock')
  .option('--max-agents <n>', 'soft lifetime agent cap (hard ceiling 1000)')
  .option('--max-concurrency <n>', 'concurrent agent cap (default min(16, cores-2))')
  .option('--json', 'suppress progress, print output JSON only')
  .action(async (script: string, opts: Record<string, string | boolean>) => {
    const { runCommand } = await import('./run.js');
    process.exit(await runCommand(script, opts as never));
  });

program
  .command('validate')
  .argument('<script>', 'workflow script file (*.workflow.js)')
  .description('validate meta block, dialect constraints, and compilability')
  .option('--json', 'machine-readable output')
  .action((script: string, opts: { json?: boolean }) => {
    process.exit(runValidateCommand(script, opts));
  });

program.parseAsync().catch((err) => {
  process.stderr.write(`ultracode: ${err?.message ?? err}\n`);
  process.exit(1);
});
