/**
 * Shared headless run-start path (MCP `workflow_start` and programmatic
 * callers). The interactive CLI adds its review prompt on top of this.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseWorkflowScript } from '../engine/meta.js';
import { validateArgsAgainstInputSchema } from '../engine/run.js';
import { defaultConcurrency, isPositiveInt } from '../engine/semaphore.js';
import { newRunId, ultracodeRoot } from '../store/layout.js';
import { createRunDir, getRun } from '../store/runstore.js';
import { isResumableStatus, isTerminal } from '../store/manifest.js';
import { launchRunner } from './daemonize.js';
import { IMPLEMENTED_BACKENDS } from '../backends/ids.js';
import { loadSubagentConfig, type SubagentDefaults } from '../config.js';

export interface StartRunInput {
  script?: string;
  scriptPath?: string;
  args?: unknown;
  backend?: string;
  model?: string;
  effort?: string;
  /** Default Qoder context window, in tokens. */
  contextWindow?: number;
  budgetTotal?: number | null;
  maxAgents?: number;
  maxConcurrency?: number;
  permission?: 'safe' | 'auto' | 'danger';
  /** run wall-clock cap in ms; 0 clears an inherited cap (unlimited) */
  wallClockMs?: number;
  /** run-wide per-attempt timeout in ms; 0 clears an inherited cap (unlimited) */
  attemptTimeoutMs?: number;
  resumeFromRunId?: string;
  cwd?: string;
  home?: string;
  /** Fresh starts must resolve a backend without using the mock fallback. */
  requireBackend?: boolean;
}

export interface StartRunResult {
  runId: string;
  dir: string;
  name: string;
  backend: string;
  model?: string;
  effort?: string;
  contextWindow?: number;
}

export { IMPLEMENTED_BACKENDS } from '../backends/ids.js';

/** Timeout caps are opt-in and resume-inherited; 0 is the explicit "clear the
 *  inherited cap" value (an undefined key never overrides a stored one). */
function clearableCap(ms: number | undefined): number | undefined {
  return ms === 0 ? undefined : ms;
}

export async function startDetachedRun(input: StartRunInput): Promise<StartRunResult> {
  const cwd = input.cwd ?? process.cwd();
  const root = ultracodeRoot(cwd, input.home);

  const defaults: SubagentDefaults = input.resumeFromRunId ? {} : loadSubagentConfig(cwd);
  if (!input.resumeFromRunId && input.requireBackend && input.backend === undefined && defaults.backend === undefined) {
    throw new Error(
      'workflow_start requires an explicit backend or subagent.backend in ultracode config ' +
        '(mock|codex|qoder|claude|gemini)',
    );
  }

  let source = input.script;
  let args = input.args ?? null;
  let config = {
    backend: input.backend ?? defaults.backend ?? 'mock',
    model: input.model ?? defaults.model,
    effort: input.effort ?? defaults.effort,
    contextWindow: input.contextWindow ?? defaults.contextWindow,
    cwd,
    maxAgents: input.maxAgents,
    maxConcurrency: input.maxConcurrency ?? defaultConcurrency(),
    budgetTotal: input.budgetTotal ?? null,
    permission: input.permission ?? 'auto',
    wallClockMs: clearableCap(input.wallClockMs),
    attemptTimeoutMs: clearableCap(input.attemptTimeoutMs),
    resumeFromRunId: undefined as string | undefined,
  };

  // Resume: inherit script/args/config from the prior run unless overridden.
  let resumedFrom: string | undefined;
  if (input.resumeFromRunId) {
    const prior = getRun(root, input.resumeFromRunId);
    if (!prior) throw new Error(`no run ${input.resumeFromRunId} under ${root}`);
    if (!isTerminal(prior.effectiveStatus)) {
      throw new Error(`run ${input.resumeFromRunId} is still ${prior.effectiveStatus} — stop it first`);
    }
    if (!isResumableStatus(prior.effectiveStatus)) {
      throw new Error(`run ${input.resumeFromRunId} cannot resume before the worker cleanup scan settles`);
    }
    resumedFrom = input.resumeFromRunId;
    config.resumeFromRunId = input.resumeFromRunId;
    if (source === undefined && !input.scriptPath) {
      source = readFileSync(join(prior.dir, 'script.js'), 'utf8');
    }
    if (input.args === undefined) {
      args = JSON.parse(readFileSync(join(prior.dir, 'args.json'), 'utf8'));
    }
    // Inherit the prior run's config and override ONLY fields the caller
    // explicitly supplied. Spreading the default-filled `config` over
    // priorConfig would reset backend→mock, budget→unlimited, etc. — and since
    // backend is part of the cache key, that silently reruns everything on mock
    // instead of resuming. (cwd stays the prior run's for cache-key stability.)
    const priorConfig = JSON.parse(readFileSync(join(prior.dir, 'config.json'), 'utf8'));
    config = { ...priorConfig, resumeFromRunId: input.resumeFromRunId };
    if (input.backend !== undefined) config.backend = input.backend;
    if (input.model !== undefined) config.model = input.model;
    if (input.effort !== undefined) config.effort = input.effort;
    if (input.contextWindow !== undefined) config.contextWindow = input.contextWindow;
    if (input.maxAgents !== undefined) config.maxAgents = input.maxAgents;
    if (input.maxConcurrency !== undefined) config.maxConcurrency = input.maxConcurrency;
    if (input.budgetTotal !== undefined) config.budgetTotal = input.budgetTotal;
    if (input.permission !== undefined) config.permission = input.permission;
    if (input.wallClockMs !== undefined) config.wallClockMs = clearableCap(input.wallClockMs);
    if (input.attemptTimeoutMs !== undefined) config.attemptTimeoutMs = clearableCap(input.attemptTimeoutMs);
  }

  if (input.scriptPath) source = readFileSync(input.scriptPath, 'utf8');
  if (source === undefined) throw new Error('one of script, scriptPath, or resumeFromRunId is required');

  if (!IMPLEMENTED_BACKENDS.has(config.backend)) {
    throw new Error(`backend '${config.backend}' is not implemented yet (available: ${[...IMPLEMENTED_BACKENDS].join(', ')})`);
  }
  if (config.model !== undefined && (typeof config.model !== 'string' || config.model.trim().length === 0)) {
    throw new Error('model must be a non-empty string');
  }
  if (config.effort !== undefined && (typeof config.effort !== 'string' || config.effort.trim().length === 0)) {
    throw new Error('effort must be a non-empty string');
  }
  if (config.contextWindow !== undefined && !isPositiveInt(config.contextWindow)) {
    throw new Error('contextWindow must be a positive integer');
  }

  const parsed = parseWorkflowScript(source);
  validateArgsAgainstInputSchema(parsed, args ?? undefined);

  const runId = newRunId();
  const dir = createRunDir(root, { runId, name: parsed.meta.name, source, args, config, resumedFrom });
  await launchRunner(dir);
  return {
    runId,
    dir,
    name: parsed.meta.name,
    backend: config.backend,
    model: config.model,
    effort: config.effort,
    contextWindow: config.contextWindow,
  };
}
