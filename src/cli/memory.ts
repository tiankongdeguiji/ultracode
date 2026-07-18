/** CLI surface for portable project memory and Claude Code migration. */
import { errorMessage } from '../engine/errors.js';
import { runMemoryHook, startupMemoryContext } from '../memory/hook.js';
import { migrateClaudeMemory } from '../memory/migrate-claude.js';
import { pathRulesContext } from '../memory/rules.js';
import {
  forgetTopic,
  memoryInfo,
  readMemoryTopic,
  remember,
  searchMemory,
  setAutoMemoryEnabled,
} from '../memory/store.js';

function print(value: unknown, json = false): void {
  if (json || typeof value !== 'string') process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
  else process.stdout.write(value.endsWith('\n') ? value : `${value}\n`);
}

function guarded(action: () => void): number {
  try {
    action();
    return 0;
  } catch (error) {
    process.stderr.write(`ultracode memory: ${errorMessage(error)}\n`);
    return 1;
  }
}

export function memoryInfoCommand(opts: { cwd?: string; json?: boolean }): number {
  return guarded(() => print(memoryInfo({ cwd: opts.cwd }), opts.json));
}

export function memoryContextCommand(opts: { cwd?: string; json?: boolean }): number {
  return guarded(() => {
    const context = startupMemoryContext({ cwd: opts.cwd });
    print(opts.json ? { context } : context, opts.json);
  });
}

export function memorySearchCommand(query: string, opts: { cwd?: string; json?: boolean; limit?: string }): number {
  return guarded(() => {
    const limit = opts.limit === undefined ? undefined : Number(opts.limit);
    if (limit !== undefined && (!Number.isInteger(limit) || limit <= 0)) throw new Error('--limit must be a positive integer');
    print(searchMemory(query, { cwd: opts.cwd, limit }), true);
  });
}

export function memoryReadCommand(topic: string, opts: { cwd?: string; json?: boolean }): number {
  return guarded(() => {
    const result = readMemoryTopic(topic, { cwd: opts.cwd });
    print(opts.json ? result : result.content, opts.json);
  });
}

export function memoryRememberCommand(
  text: string,
  opts: { cwd?: string; topic?: string; summary?: string; allowSensitive?: boolean; json?: boolean },
): number {
  return guarded(() => print(remember(text, opts), true));
}

export function memoryForgetCommand(topic: string, opts: { cwd?: string; yes?: boolean; json?: boolean }): number {
  return guarded(() => {
    if (!opts.yes) throw new Error('forget is destructive; pass --yes after confirming the topic');
    print(forgetTopic(topic, opts), true);
  });
}

export function memoryModeCommand(value: string | undefined, opts: { cwd?: string }): number {
  return guarded(() => {
    if (value === undefined) {
      const info = memoryInfo({ cwd: opts.cwd }) as { autoMemoryEnabled: boolean };
      print(info.autoMemoryEnabled ? 'on' : 'off');
      return;
    }
    if (value !== 'on' && value !== 'off') throw new Error("mode must be 'on' or 'off'");
    setAutoMemoryEnabled(value === 'on', { cwd: opts.cwd });
    print(`ultracode memory ${value}`);
  });
}

export function memoryRulesCommand(path: string, opts: { cwd?: string; json?: boolean }): number {
  return guarded(() => {
    const context = pathRulesContext(path, { cwd: opts.cwd });
    print(opts.json ? { path, context } : context, opts.json);
  });
}

export function memoryMigrateClaudeCommand(opts: {
  cwd?: string;
  from?: string;
  apply?: boolean;
  includeSensitive?: boolean;
  json?: boolean;
}): number {
  return guarded(() => {
    const result = migrateClaudeMemory({
      cwd: opts.cwd,
      source: opts.from,
      apply: opts.apply,
      includeSensitive: opts.includeSensitive,
    });
    if (opts.json) {
      print(result, true);
      return;
    }
    const all = [...result.files, ...result.rules, ...result.instructions];
    const counts = Object.fromEntries(
      ['copy', 'same', 'conflict-copy', 'skip-sensitive'].map((action) => [
        action,
        all.filter((file) => file.action === action).length,
      ]),
    );
    process.stdout.write(`${result.applied ? 'Migrated' : 'Migration plan'}: ${result.sourceMemoryDir}\n`);
    process.stdout.write(`Destination: ${result.destinationMemoryDir}\n`);
    process.stdout.write(`Files: ${JSON.stringify(counts)}\n`);
    if (!result.applied) process.stdout.write('No files changed. Re-run with --apply after reviewing this plan.\n');
  });
}

export { runMemoryHook };
