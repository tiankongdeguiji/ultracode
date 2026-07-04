/**
 * Shared headless run-start path (MCP `workflow_start` and programmatic
 * callers). The interactive CLI adds its review prompt on top of this.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseWorkflowScript } from '../engine/meta.js';
import { validateArgsAgainstInputSchema } from '../engine/run.js';
import { defaultConcurrency } from '../engine/semaphore.js';
import { codexConcurrencyPolicy, detectCodexAuth } from '../backends/codex-auth.js';
import { newRunId, ultracodeRoot } from '../store/layout.js';
import { createRunDir, getRun } from '../store/runstore.js';
import { isTerminal } from '../store/manifest.js';
import { launchRunner } from './daemonize.js';

export interface StartRunInput {
  script?: string;
  scriptPath?: string;
  args?: unknown;
  backend?: string;
  budgetTotal?: number | null;
  maxAgents?: number;
  maxConcurrency?: number;
  permission?: 'safe' | 'auto' | 'danger';
  wallClockMs?: number;
  resumeFromRunId?: string;
  cwd?: string;
  home?: string;
  forceOauthFanout?: boolean;
}

export interface StartRunResult {
  runId: string;
  dir: string;
  name: string;
  warnings: string[];
}

export const IMPLEMENTED_BACKENDS = new Set(['mock', 'codex']);

export async function startDetachedRun(input: StartRunInput): Promise<StartRunResult> {
  const cwd = input.cwd ?? process.cwd();
  const root = ultracodeRoot(cwd, input.home);
  const warnings: string[] = [];

  let source = input.script;
  let args = input.args ?? null;
  let config = {
    backend: input.backend ?? 'mock',
    cwd,
    maxAgents: input.maxAgents,
    maxConcurrency: input.maxConcurrency ?? defaultConcurrency(),
    budgetTotal: input.budgetTotal ?? null,
    permission: input.permission ?? 'auto',
    wallClockMs: input.wallClockMs,
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
    resumedFrom = input.resumeFromRunId;
    config.resumeFromRunId = input.resumeFromRunId;
    if (source === undefined && !input.scriptPath) {
      source = readFileSync(join(prior.dir, 'script.js'), 'utf8');
    }
    if (input.args === undefined) {
      args = JSON.parse(readFileSync(join(prior.dir, 'args.json'), 'utf8'));
    }
    const priorConfig = JSON.parse(readFileSync(join(prior.dir, 'config.json'), 'utf8'));
    config = { ...priorConfig, ...config, resumeFromRunId: input.resumeFromRunId };
  }

  if (input.scriptPath) source = readFileSync(input.scriptPath, 'utf8');
  if (source === undefined) throw new Error('one of script, scriptPath, or resumeFromRunId is required');

  if (!IMPLEMENTED_BACKENDS.has(config.backend)) {
    throw new Error(`backend '${config.backend}' is not implemented yet (available: ${[...IMPLEMENTED_BACKENDS].join(', ')})`);
  }

  const parsed = parseWorkflowScript(source);
  validateArgsAgainstInputSchema(parsed, args ?? undefined);

  if (config.backend === 'codex') {
    const policy = codexConcurrencyPolicy(config.maxConcurrency!, detectCodexAuth(), input.forceOauthFanout === true);
    if (policy.warning) warnings.push(policy.warning);
    config.maxConcurrency = policy.maxConcurrency;
  }

  const runId = newRunId();
  const dir = createRunDir(root, { runId, name: parsed.meta.name, source, args, config, resumedFrom });
  await launchRunner(dir);
  return { runId, dir, name: parsed.meta.name, warnings };
}
