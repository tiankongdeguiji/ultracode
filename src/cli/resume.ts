import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseWorkflowScript } from '../engine/meta.js';
import { codexConcurrencyPolicy, detectCodexAuth } from '../backends/codex-auth.js';
import { defaultConcurrency } from '../engine/semaphore.js';
import { newRunId, ultracodeRoot } from '../store/layout.js';
import { createRunDir, getRun, readRunArgs, readRunConfig, reapOrphans } from '../store/runstore.js';
import { isTerminal } from '../store/manifest.js';
import { launchRunner } from '../exec/daemonize.js';
import { attachForeground, printOutput } from './lifecycle.js';

export interface ResumeCliOptions {
  script?: string;
  args?: string;
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

  let name: string;
  try {
    name = parseWorkflowScript(source).meta.name;
  } catch (err) {
    process.stderr.write(`ultracode: invalid workflow: ${(err as Error).message}\n`);
    return 1;
  }

  let args: unknown = readRunArgs(prior.dir);
  if (opts.args !== undefined) {
    try {
      args = JSON.parse(opts.args);
    } catch {
      args = opts.args;
    }
  }

  const config = readRunConfig(prior.dir);
  config.resumeFromRunId = runId;

  // Recompute the Codex OAuth fan-out cap against CURRENT auth (mirrors
  // startDetachedRun). The stored value reflects the ORIGINAL run's auth:
  // resuming an API-key run (uncapped) while now authenticated via ChatGPT OAuth
  // must re-cap concurrency to 1, or the runner races the single-use rotating
  // refresh token and corrupts the token family.
  const codexPolicy = codexConcurrencyPolicy(
    config.maxConcurrency ?? defaultConcurrency(),
    detectCodexAuth(),
    false,
  );
  config.codexMaxConcurrency = codexPolicy.maxConcurrency;
  if (config.backend === 'codex') {
    if (codexPolicy.warning) process.stderr.write(`⚠ ${codexPolicy.warning}\n`);
    config.maxConcurrency = codexPolicy.maxConcurrency;
  }

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
