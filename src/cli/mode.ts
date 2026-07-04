import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { ultracodeRoot } from '../store/layout.js';

/** Machine-readable session-mode marker: <root>/.ultracode/mode ('on'|'off'). */
export function modeFile(cwd: string, home?: string): string {
  return join(ultracodeRoot(cwd, home), 'mode');
}

export function readMode(cwd: string, home?: string): 'on' | 'off' {
  const file = modeFile(cwd, home);
  if (!existsSync(file)) return 'off';
  return readFileSync(file, 'utf8').trim() === 'on' ? 'on' : 'off';
}

export function modeCommand(value: string | undefined, opts: { home?: string }): number {
  const cwd = process.cwd();
  if (value === undefined) {
    process.stdout.write(readMode(cwd, opts.home) + '\n');
    return 0;
  }
  if (value !== 'on' && value !== 'off') {
    process.stderr.write(`ultracode: mode must be 'on' or 'off'\n`);
    return 1;
  }
  const file = modeFile(cwd, opts.home);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, value + '\n', 'utf8');
  process.stdout.write(`ultracode mode ${value}\n`);
  return 0;
}
