/**
 * Layered user/project configuration for defaults applied to spawned agents.
 * Files are read once at fresh-run admission; resolved values are persisted in
 * the run store so detached execution and resume never depend on mutable config.
 */
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import { IMPLEMENTED_BACKEND_IDS, type ImplementedBackendId } from './backends/ids.js';

const subagentSchema = z.object({
  backend: z.enum(IMPLEMENTED_BACKEND_IDS).optional(),
  model: z.string().trim().min(1).optional(),
  effort: z.string().trim().min(1).optional(),
  context_window: z.number().int().positive().optional(),
}).strict();

const configSchema = z.object({
  subagent: subagentSchema.optional(),
}).strict();

export interface SubagentDefaults {
  backend?: ImplementedBackendId;
  model?: string;
  effort?: string;
  /** Qoder-only context window, in tokens. */
  contextWindow?: number;
}

export interface LoadSubagentConfigOptions {
  /** Test seam; production defaults to the operating-system home directory. */
  userHome?: string;
}

function readConfigFile(path: string): SubagentDefaults {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new Error(`invalid ultracode config ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const parsed = configSchema.safeParse(raw);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ');
    throw new Error(`invalid ultracode config ${path}: ${detail}`);
  }
  const subagent = parsed.data.subagent;
  if (!subagent) return {};
  return {
    ...(subagent.backend !== undefined ? { backend: subagent.backend } : {}),
    ...(subagent.model !== undefined ? { model: subagent.model } : {}),
    ...(subagent.effort !== undefined ? { effort: subagent.effort } : {}),
    ...(subagent.context_window !== undefined ? { contextWindow: subagent.context_window } : {}),
  };
}

/** User defaults are overlaid field-by-field by project defaults. */
export function loadSubagentConfig(
  cwd: string,
  opts: LoadSubagentConfigOptions = {},
): SubagentDefaults {
  const paths = [
    join(opts.userHome ?? homedir(), '.ultracode', 'config.json'),
    join(resolve(cwd), '.ultracode', 'config.json'),
  ];
  const defaults: SubagentDefaults = {};
  const seen = new Set<string>();
  for (const path of paths) {
    const absolute = resolve(path);
    if (seen.has(absolute) || !existsSync(absolute)) continue;
    seen.add(absolute);
    Object.assign(defaults, readConfigFile(absolute));
  }
  return defaults;
}
