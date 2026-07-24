/**
 * Layered user/project configuration for defaults applied to spawned agents.
 * Files are read once at fresh-run admission; resolved values are persisted in
 * the run store so detached execution and resume never depend on mutable config.
 */
import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs';
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

/** Maximum size of either layered configuration file. */
export const MAX_CONFIG_BYTES = 64 * 1024;

export interface SubagentProfile {
  backend?: string;
  model?: string;
  effort?: string;
  /** Qoder-only context window, in tokens. */
  contextWindow?: number;
}

export interface SubagentDefaults extends SubagentProfile {
  backend?: ImplementedBackendId;
}

export type BackendScopedDefault = 'model' | 'effort' | 'contextWindow';

export interface ResolvedSubagentProfile {
  profile: SubagentProfile;
  /** Configured controls intentionally dropped after switching backends. */
  ignoredDefaults: BackendScopedDefault[];
}

export interface LoadSubagentConfigOptions {
  /** Test seam; production defaults to the operating-system home directory. */
  userHome?: string;
}

/**
 * Resolves launch or per-agent overrides without leaking one backend's controls
 * into another backend. An explicit backend switch starts a fresh profile;
 * otherwise unspecified controls continue to inherit normally.
 */
export function resolveSubagentProfile(
  defaults: SubagentProfile,
  overrides: SubagentProfile,
): ResolvedSubagentProfile {
  const switchesBackend =
    overrides.backend !== undefined &&
    defaults.backend !== undefined &&
    overrides.backend !== defaults.backend;
  const ignoredDefaults: BackendScopedDefault[] = [];
  const inherited = <K extends BackendScopedDefault>(key: K): SubagentProfile[K] => {
    if (!switchesBackend) return overrides[key] ?? defaults[key];
    if (overrides[key] !== undefined) return overrides[key];
    if (defaults[key] !== undefined) ignoredDefaults.push(key);
    return undefined;
  };

  return {
    profile: {
      backend: overrides.backend ?? defaults.backend,
      model: inherited('model'),
      effort: inherited('effort'),
      contextWindow: inherited('contextWindow'),
    },
    ignoredDefaults,
  };
}

/** Human-readable warning for controls dropped by an explicit backend switch. */
export function backendOverrideWarning(
  defaults: SubagentProfile,
  resolved: ResolvedSubagentProfile,
): string | undefined {
  if (resolved.ignoredDefaults.length === 0) return undefined;
  return (
    `backend override '${resolved.profile.backend}' differs from configured backend '${defaults.backend}'; ` +
    `not inheriting configured ${resolved.ignoredDefaults.join(', ')}`
  );
}

/** Rejects controls that the selected backend is known not to support. */
export function validateSubagentProfile(profile: SubagentProfile, subject = 'subagent profile'): void {
  if (profile.contextWindow !== undefined && profile.backend !== 'qoder') {
    throw new Error(`${subject}: contextWindow is supported only by the qoder backend, got ${JSON.stringify(profile.backend)}`);
  }
  if (profile.effort !== undefined && profile.backend === 'gemini') {
    throw new Error(`${subject}: effort is unsupported by the gemini backend; omit it to use the backend default`);
  }
}

function readConfigSource(path: string): string | undefined {
  let fd: number | undefined;
  try {
    try {
      fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
    const stat = fstatSync(fd);
    if (!stat.isFile()) throw new Error('must be a regular file');
    if (stat.size > MAX_CONFIG_BYTES) throw new Error(`exceeds ${MAX_CONFIG_BYTES} bytes`);

    const buffer = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < buffer.length) {
      const bytesRead = readSync(fd, buffer, offset, buffer.length - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    const finalStat = fstatSync(fd);
    if (!finalStat.isFile() || finalStat.size !== stat.size) throw new Error('changed while being read');
    return buffer.toString('utf8', 0, offset);
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function readConfigFile(path: string): SubagentDefaults | undefined {
  let raw: unknown;
  try {
    const source = readConfigSource(path);
    if (source === undefined) return undefined;
    raw = JSON.parse(source);
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

/**
 * User defaults are overlaid by project defaults as backend profiles. A
 * project-level backend switch drops backend-scoped controls from the user
 * profile instead of leaking them into the new backend.
 */
export function loadSubagentConfig(
  cwd: string,
  opts: LoadSubagentConfigOptions = {},
): SubagentDefaults {
  const paths = [
    join(opts.userHome ?? homedir(), '.ultracode', 'config.json'),
    join(resolve(cwd), '.ultracode', 'config.json'),
  ];
  let defaults: SubagentDefaults = {};
  const seen = new Set<string>();
  for (const path of paths) {
    const absolute = resolve(path);
    if (seen.has(absolute)) continue;
    seen.add(absolute);
    const config = readConfigFile(absolute);
    if (config) {
      const profile = resolveSubagentProfile(defaults, config).profile;
      defaults = {
        ...(profile.backend !== undefined ? { backend: profile.backend as ImplementedBackendId } : {}),
        ...(profile.model !== undefined ? { model: profile.model } : {}),
        ...(profile.effort !== undefined ? { effort: profile.effort } : {}),
        ...(profile.contextWindow !== undefined ? { contextWindow: profile.contextWindow } : {}),
      };
    }
  }
  return defaults;
}
