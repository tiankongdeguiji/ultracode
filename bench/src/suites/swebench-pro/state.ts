/** Native task status and fail-closed patch/session classification. */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { FAILURE_CODES, type FailureCode } from '../../shared/contracts.js';
import { readRegularFileWithinRoot, replaceArtifactFile } from '../../shared/paths.js';
import type { SessionMeta, TaskStatus } from './types.js';

const statusSchema = z.strictObject({
  schemaVersion: z.literal(2),
  phase: z.enum(['pending', 'image-ready', 'session-done', 'patched', 'evaluated']),
  failure: z.enum(FAILURE_CODES).nullable(),
  startedAt: z.string().datetime({ offset: true }).optional(),
  endedAt: z.string().datetime({ offset: true }).optional(),
  codexExit: z.number().int().optional(),
  wallClockMs: z.number().finite().nonnegative().optional(),
  patchBytes: z.number().int().nonnegative().optional(),
  applyCheck: z.boolean().nullable().optional(),
  annotations: z.array(z.string().regex(/^[a-z][a-z0-9-]{0,127}$/)),
});

const sessionMetaSchema = z.strictObject({
  codexExit: z.number().int(),
  startedAt: z.number().finite().nonnegative(),
  endedAt: z.number().finite().nonnegative(),
  baseSha: z.string(),
  expectedBase: z.string(),
  patchBytes: z.number().int().nonnegative(),
  applyCheck: z.boolean().nullable(),
  ucRuns: z.array(z.strictObject({ runId: z.string(), status: z.string() })),
  waitedForTerminalMs: z.number().finite().nonnegative(),
  preDirtyPaths: z.number().int().nonnegative().optional(),
  binaryHunksStripped: z.number().int().nonnegative().optional(),
  failure: z.enum(FAILURE_CODES).nullable(),
}).superRefine((meta, context) => {
  if (meta.endedAt < meta.startedAt) {
    context.addIssue({ code: 'custom', path: ['endedAt'], message: 'session end precedes start' });
  }
});

const PATCH_FAIL_BYTES = 10_000_000;
const PATCH_FLAG_BYTES = 2_000_000;
const EXCLUDED_SEGMENTS = new Set(['.ultracode', '.agents', '.codex']);

export interface PatchValidation {
  failure: FailureCode | null;
  annotations: string[];
}

export const pendingStatus = (): TaskStatus => ({
  schemaVersion: 2,
  phase: 'pending',
  failure: null,
  annotations: [],
});

/** Read only the fixed native status path; malformed state is not accepted as success. */
export function readTaskStatus(taskDirectory: string): TaskStatus {
  const file = join(taskDirectory, 'status.json');
  if (!existsSync(file)) return pendingStatus();
  try {
    return statusSchema.parse(JSON.parse(readRegularFileWithinRoot(
      taskDirectory,
      'status.json',
      1_024 * 1_024,
    ).toString('utf8')));
  } catch {
    return pendingStatus();
  }
}

export function writeTaskStatus(taskDirectory: string, status: TaskStatus): void {
  replaceArtifactFile(join(taskDirectory, 'status.json'), `${JSON.stringify(statusSchema.parse(status), null, 2)}\n`);
}

export function parseSessionMeta(value: unknown): SessionMeta {
  return sessionMetaSchema.parse(value);
}

function excludedPathLeak(patch: string): boolean {
  for (const line of patch.split('\n')) {
    if (!line.startsWith('diff --git ')) continue;
    for (const token of line.slice('diff --git '.length).split(/\s+/)) {
      const path = token.replace(/^"?[ab]\//, '');
      if (path.endsWith('.workflow.js') || path.split('/').some((part) => EXCLUDED_SEGMENTS.has(part))) return true;
    }
  }
  return false;
}

export function validatePatch(patch: string): PatchValidation {
  const bytes = Buffer.byteLength(patch, 'utf8');
  const annotations: string[] = [];
  if (bytes > PATCH_FLAG_BYTES) annotations.push('large-patch');
  if (excludedPathLeak(patch)) annotations.push('excluded-path-leak');
  if (patch.trim() === '') return { failure: 'empty-patch', annotations };
  if (bytes > PATCH_FAIL_BYTES) return { failure: 'patch-too-large', annotations };
  return { failure: null, annotations };
}

/** Driver backstops are infrastructure; only native timeout exits are agent losses. */
export function classifyOutcome(
  meta: SessionMeta | null,
  patch: PatchValidation | null,
): { failure: FailureCode | null; annotations: string[] } {
  const annotations = [...(patch?.annotations ?? [])];
  if (meta === null) return { failure: 'driver-watchdog', annotations: [...annotations, 'backstop-kill'] };
  if (meta.baseSha && meta.expectedBase && meta.baseSha !== meta.expectedBase) annotations.push('base-sha-mismatch');
  if (meta.patchBytes === 0 && meta.ucRuns.length > 0) annotations.push('unmerged-workspace');
  for (const run of meta.ucRuns) {
    if (!['completed', 'failed', 'stopped', 'orphaned'].includes(run.status)) annotations.push('monitor-abandoned');
  }
  if (meta.failure !== null) return { failure: meta.failure, annotations };
  if (meta.codexExit === 124 || meta.codexExit === 137) return { failure: 'agent-timeout', annotations };
  if (meta.codexExit !== 0) return { failure: 'agent-crash', annotations };
  if (patch?.failure) return { failure: patch.failure, annotations };
  if (meta.applyCheck === false) return { failure: 'unapplyable-diff', annotations };
  return { failure: null, annotations };
}
