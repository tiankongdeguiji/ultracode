/** Codex lifecycle-hook adapter for automatic project-memory injection. */
import { readFileSync } from 'node:fs';
import { errorMessage } from '../engine/errors.js';
import { memoryContext, type MemoryOptions } from './store.js';
import { unconditionalRulesContext } from './rules.js';

interface HookInput {
  cwd?: unknown;
  hook_event_name?: unknown;
}

export function startupMemoryContext(opts: MemoryOptions = {}): string {
  return [memoryContext(opts), unconditionalRulesContext(opts)].filter(Boolean).join('\n\n');
}

export function memoryHookPayload(cwd: string, opts: Omit<MemoryOptions, 'cwd'> = {}): Record<string, unknown> | undefined {
  const context = startupMemoryContext({ ...opts, cwd });
  if (!context) return undefined;
  return {
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext: context,
    },
  };
}

export function runMemoryHook(): number {
  try {
    const raw = readFileSync(0, 'utf8');
    const input = raw.trim() ? JSON.parse(raw) as HookInput : {};
    const cwd = typeof input.cwd === 'string' ? input.cwd : process.cwd();
    const payload = memoryHookPayload(cwd);
    if (payload) process.stdout.write(`${JSON.stringify(payload)}\n`);
    return 0;
  } catch (error) {
    process.stderr.write(`ultracode memory hook: ${errorMessage(error)}\n`);
    return 1;
  }
}
