/**
 * On-disk layout. Project-local by default:
 *   <cwd>/.ultracode/runs/<wf_...>/{manifest.json, script.js, args.json,
 *     config.json, journal.jsonl, events.jsonl, output.json, runner.log,
 *     worker-records/<seq>/..., agents/<seq>-<slug>/...}
 * Overridable via $ULTRACODE_HOME or --home. Deliberately OUTSIDE .qoder/
 * and .claude/ (namespace defensiveness).
 */
import { randomBytes } from 'node:crypto';
import { join, resolve } from 'node:path';

export function ultracodeRoot(cwd: string, homeOverride?: string): string {
  const fromEnv = process.env.ULTRACODE_HOME;
  if (homeOverride) return resolve(homeOverride);
  if (fromEnv && fromEnv.length > 0) return resolve(fromEnv);
  return join(resolve(cwd), '.ultracode');
}

export function runsDir(root: string): string {
  return join(root, 'runs');
}

export function runDir(root: string, runId: string): string {
  return join(runsDir(root), runId);
}

/** wf_<12 lowercase hex> — matches the reference resume regex ^wf_[a-z0-9-]{6,}$ */
export function newRunId(): string {
  return `wf_${randomBytes(6).toString('hex')}`;
}

export const RUN_ID_RE = /^wf_[a-z0-9-]{6,}$/;

export function agentDirName(seq: number, label: string): string {
  const slug =
    label
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'agent';
  return `${String(seq).padStart(4, '0')}-${slug}`;
}
