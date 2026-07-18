/**
 * Arm-dir state for the bench driver: `status.json` read/write (temp file +
 * same-dir rename for atomicity), patch validation, and the pre-registered
 * outcome classification mapping a session's meta.json plus patch checks onto
 * the FailureKind taxonomy in types.ts. Pure data/filesystem logic — no
 * docker, no network — so session.ts, metrics.ts, and eval.ts share one
 * source of truth for "what happened to this instance x arm". Classification
 * never gates eval inclusion: a 'timeout' with a valid patch is still scored.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ArmStatus, FailureKind, SessionMeta } from './types.js';

const STATUS_FILE = 'status.json';

/** Hard cap: a patch beyond this fails validation outright. */
const PATCH_FAIL_BYTES = 10_000_000;
/** Soft threshold: flagged for the report, still evaluated. */
const PATCH_FLAG_BYTES = 2_000_000;

/** Directory names that mark harness scaffolding leaking into a patch. */
const EXCLUDED_SEGMENTS = new Set(['.ultracode', '.agents', '.codex']);

interface PatchValidation {
  failure: FailureKind | null;
  flags: string[];
}

/** Current arm status; a missing or corrupt status.json degrades to a pristine 'pending'. */
export function readStatus(armDirPath: string): ArmStatus {
  try {
    const parsed = JSON.parse(readFileSync(join(armDirPath, STATUS_FILE), 'utf8')) as ArmStatus | null;
    if (parsed && typeof parsed === 'object' && typeof parsed.phase === 'string') return parsed;
  } catch {
    /* degrade to the pristine default */
  }
  return { phase: 'pending', failure: null, annotations: [] };
}

/** Persist status atomically: mkdir -p, write a sibling temp file, rename over status.json. */
export function writeStatus(armDirPath: string, s: ArmStatus): void {
  mkdirSync(armDirPath, { recursive: true });
  const target = join(armDirPath, STATUS_FILE);
  const tmp = `${target}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(s, null, 2)}\n`, 'utf8');
  renameSync(tmp, target);
}

/**
 * Validate a captured diff. Failure (fatal, first match): empty after trim,
 * then over the hard byte cap. Flags are non-fatal and collected regardless:
 * 'large-patch' over the soft cap, 'excluded-path-leak' when a `diff --git`
 * header references harness scaffolding (headers only — hunk bodies
 * legitimately contain arbitrary text).
 */
export function validatePatch(patch: string): PatchValidation {
  const bytes = Buffer.byteLength(patch, 'utf8');
  const flags: string[] = [];
  if (bytes > PATCH_FLAG_BYTES) flags.push('large-patch');
  if (hasExcludedPathHeader(patch)) flags.push('excluded-path-leak');
  if (patch.trim() === '') return { failure: 'empty-patch', flags };
  if (bytes > PATCH_FAIL_BYTES) return { failure: 'patch-too-large', flags };
  return { failure: null, flags };
}

function hasExcludedPathHeader(patch: string): boolean {
  for (const line of patch.split('\n')) {
    if (!line.startsWith('diff --git ')) continue;
    for (const token of line.slice('diff --git '.length).split(/\s+/)) {
      const path = token.replace(/^"?[ab]\//, '');
      if (path.endsWith('.workflow.js')) return true;
      if (path.split('/').some((seg) => EXCLUDED_SEGMENTS.has(seg))) return true;
    }
  }
  return false;
}

/**
 * Map session meta + patch validation onto the failure taxonomy. Failure
 * precedence (first match wins): no meta at all means the container died
 * before writing it (driver backstop kill) -> 'timeout'; then the
 * entrypoint's own failure verdict; exit 124/137 -> 'timeout'; any other
 * non-zero exit -> 'agent-crash'; the patch validation failure; a failed
 * `git apply --check` -> 'unapplyable-diff'. Annotations are collected
 * independently of the failure so the report never loses signal.
 */
export function classifyOutcome(
  meta: SessionMeta | null,
  patchValidation: PatchValidation | null,
): { failure: FailureKind | null; annotations: string[] } {
  const annotations: string[] = [];
  if (meta === null) annotations.push('backstop-kill');
  if (patchValidation) annotations.push(...patchValidation.flags);
  if (meta) {
    // Guard every field: the entrypoint's last-resort fallback meta (written
    // when its node invocation itself fails) carries only a failure + exit code.
    const ucRuns = Array.isArray(meta.ucRuns) ? meta.ucRuns : [];
    if (meta.expectedBase && meta.baseSha !== meta.expectedBase) annotations.push('base-sha-mismatch');
    if (meta.patchBytes === 0 && ucRuns.length > 0) annotations.push('unmerged-workspace');
    for (const run of ucRuns) {
      if (run.status !== 'completed') annotations.push(`uc-run-${run.status}`);
    }
  }
  return { failure: classifyFailure(meta, patchValidation), annotations };
}

function classifyFailure(
  meta: SessionMeta | null,
  patchValidation: PatchValidation | null,
): FailureKind | null {
  if (meta === null) return 'timeout';
  if (meta.failure !== null) return meta.failure;
  if (meta.codexExit === 124 || meta.codexExit === 137) return 'timeout';
  if (meta.codexExit !== 0) return 'agent-crash';
  if (patchValidation?.failure) return patchValidation.failure;
  if (meta.applyCheck === false) return 'unapplyable-diff';
  return null;
}
