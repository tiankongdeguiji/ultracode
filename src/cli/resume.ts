import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseWorkflowScript } from '../engine/meta.js';
import { validateArgsAgainstInputSchema } from '../engine/run.js';
import { newRunId, ultracodeRoot } from '../store/layout.js';
import { createRunDir, getRun, readRunArgs, readRunConfig, reapOrphans } from '../store/runstore.js';
import { isTerminal } from '../store/manifest.js';
import { launchRunner } from '../exec/daemonize.js';
import { attachForeground, printOutput } from './lifecycle.js';
import { readMaxConcurrencyOpt } from './options.js';

export interface ResumeCliOptions {
  script?: string;
  args?: string;
  maxConcurrency?: string;
  yes?: boolean;
  detach?: boolean;
  json?: boolean;
  home?: string;
}

/**
 * ultracode resume <runId> [--script edited.js] — new run dir with
 * resumedFrom lineage; completed agents replay instantly from the prior
 * journal (longest unchanged prefix), the rest run live. Works across
 * processes and sessions by construction (plain files).
 */
export async function resumeCommand(runId: string, opts: ResumeCliOptions): Promise<number> {
  // Validate CLI input before touching the store — bad input fails fast even
  // when the run id is unknown.
  const mcOpt = readMaxConcurrencyOpt(opts.maxConcurrency);
  if (!mcOpt.ok) return 1;
  const maxConcurrencyOverride = mcOpt.value;

  const root = ultracodeRoot(process.cwd(), opts.home);
  let prior = getRun(root, runId);
  if (!prior) {
    process.stderr.write(`ultracode: no run ${runId} under ${root}\n`);
    return 1;
  }
  if (prior.effectiveStatus === 'orphaned' && prior.manifest.status !== 'orphaned') {
    reapOrphans(root);
    prior = getRun(root, runId)!;
  }
  if (!isTerminal(prior.effectiveStatus)) {
    process.stderr.write(`ultracode: run ${runId} is still ${prior.effectiveStatus} — stop it first\n`);
    return 1;
  }

  let source: string;
  try {
    source = opts.script ? readFileSync(opts.script, 'utf8') : readFileSync(join(prior.dir, 'script.js'), 'utf8');
  } catch (err) {
    process.stderr.write(`ultracode: ${(err as Error).message}\n`);
    return 1;
  }

  let parsed: ReturnType<typeof parseWorkflowScript>;
  try {
    parsed = parseWorkflowScript(source);
  } catch (err) {
    process.stderr.write(`ultracode: invalid workflow: ${(err as Error).message}\n`);
    return 1;
  }
  const name = parsed.meta.name;

  let args: unknown = readRunArgs(prior.dir);
  if (opts.args !== undefined) {
    try {
      args = JSON.parse(opts.args);
    } catch {
      args = opts.args;
    }
  }

  // Validate args before createRunDir (same rationale as `run`) — avoid
  // launching a runner that fails post-'running' and orphans the new run.
  try {
    validateArgsAgainstInputSchema(parsed, args ?? undefined);
  } catch (err) {
    process.stderr.write(`ultracode: ${(err as Error).message}\n`);
    return 1;
  }

  const config = readRunConfig(prior.dir);
  config.resumeFromRunId = runId;

  // The stored maxConcurrency is frozen at run creation; this is the explicit
  // way to change it for a resume (ULTRACODE_MAX_CONCURRENCY only seeds new runs).
  if (maxConcurrencyOverride !== undefined) config.maxConcurrency = maxConcurrencyOverride;

  const newId = newRunId();
  const dir = createRunDir(root, { runId: newId, name, source, args, config, resumedFrom: runId });

  try {
    await launchRunner(dir);
  } catch (err) {
    process.stderr.write(`ultracode: ${(err as Error).message}\n`);
    return 1;
  }

  if (opts.detach) {
    process.stdout.write(`${newId}\n`);
    process.stderr.write(`resumed from ${runId}; monitor: ultracode status ${newId} --watch\n`);
    return 0;
  }
  process.stderr.write(`▶ ${newId} (resumed from ${runId})\n`);
  const { exitCode } = await attachForeground(dir, { quiet: opts.json });
  if (opts.json) printOutput(dir);
  return exitCode;
}
