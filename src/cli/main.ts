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
