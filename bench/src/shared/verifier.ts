/** Native-verifier evidence bindings; absent evidence always remains unverified. */
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { BenchPathRoots, BenchSuite } from './contracts.js';
import type { BenchLockHandle } from './locks.js';
import { sha256File, sha256Schema } from './provenance.js';
import {
  readPrivateJson,
  resolveRegularFileWithinRoot,
  runDir,
  runLeaseFile,
  validateRelativeArtifactPath,
  validateRunId,
  validateTaskId,
  verifierReceiptFile,
  writePrivateJsonAtomic,
} from './paths.js';

const relativePathSchema = z.string()
  .transform(validateRelativeArtifactPath)
  .refine((path) => path.startsWith('native/'), 'verifier evidence must be beneath native/');
const armSchema = z.enum(['a', 'b']);

export const verifierScopeSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('task-arm'), taskId: z.string().transform(validateTaskId), arm: armSchema }),
  z.strictObject({ kind: z.literal('suite-check'), name: z.string().min(1).max(128) }),
]);

export const verifierBindingRoleSchema = z.enum([
  'raw-samples',
  'predictions',
  'native-config',
  'native-result',
  'run-metadata',
  'rollout-output',
  'verifier-input',
  'verifier-invocation',
  'task-report',
  'aggregate-report',
  'completion-marker',
]);

export const verifierBindingSchema = z.strictObject({
  invocationId: z.string().uuid(),
  scope: verifierScopeSchema,
  role: verifierBindingRoleSchema,
  path: relativePathSchema,
  sha256: sha256Schema,
  nativeRecordKey: z.string().min(1).max(1_024).nullable(),
});

const rawVerifierReceiptSchema = z.strictObject({
  schemaVersion: z.literal(2),
  kind: z.literal('ultracode-benchmark-verifier-receipt'),
  suite: z.enum(['swebench-pro', 'swe-marathon', 'featurebench']),
  runId: z.string().transform(validateRunId),
  manifestSha256: sha256Schema,
  revision: z.number().int().nonnegative(),
  updatedAt: z.string().datetime({ offset: true }),
  bindings: z.array(verifierBindingSchema),
});

export const verifierReceiptSchema = rawVerifierReceiptSchema.superRefine((receipt, context) => {
  const identities = new Set<string>();
  const pathHashes = new Map<string, string>();
  for (let index = 0; index < receipt.bindings.length; index += 1) {
    const binding = receipt.bindings[index]!;
    const identity = `${binding.invocationId}\0${binding.role}\0${JSON.stringify(binding.scope)}\0${binding.nativeRecordKey ?? ''}`;
    if (identities.has(identity)) {
      context.addIssue({ code: 'custom', path: ['bindings', index], message: 'duplicate verifier binding identity' });
    }
    const previousHash = pathHashes.get(binding.path);
    if (previousHash !== undefined && previousHash !== binding.sha256) {
      context.addIssue({ code: 'custom', path: ['bindings', index, 'sha256'], message: 'one artifact path has conflicting hashes' });
    }
    identities.add(identity);
    pathHashes.set(binding.path, binding.sha256);
  }
});

export type VerifierReceipt = z.infer<typeof verifierReceiptSchema>;
export type VerifierBinding = z.infer<typeof verifierBindingSchema>;
export type VerifierScope = z.infer<typeof verifierScopeSchema>;
export type VerifierBindingRole = z.infer<typeof verifierBindingRoleSchema>;

export interface NativeVerifierResult {
  verification: 'verified' | 'unverified';
  score: number | null;
  resolved: boolean | null;
  artifact: Pick<VerifierBinding, 'path' | 'sha256' | 'nativeRecordKey'> | null;
}

export const UNVERIFIED_NATIVE_RESULT: NativeVerifierResult = Object.freeze({
  verification: 'unverified',
  score: null,
  resolved: null,
  artifact: null,
});

export function createVerifierReceipt(
  suite: BenchSuite,
  runId: string,
  manifestSha256: string,
  now = new Date(),
): VerifierReceipt {
  return verifierReceiptSchema.parse({
    schemaVersion: 2,
    kind: 'ultracode-benchmark-verifier-receipt',
    suite,
    runId,
    manifestSha256,
    revision: 0,
    updatedAt: now.toISOString(),
    bindings: [],
  });
}

/** Bind exact native evidence only after safe containment and content hashing. */
export function createVerifierBinding(
  runDirectory: string,
  input: Omit<VerifierBinding, 'invocationId' | 'sha256'> & { invocationId?: string },
  /** Hash of bytes already parsed by the caller; drift before binding is rejected. */
  parsedBytesSha256: string,
): VerifierBinding {
  const path = relativePathSchema.parse(input.path);
  const parsedSha256 = sha256Schema.parse(parsedBytesSha256);
  const file = resolveRegularFileWithinRoot(runDirectory, path, 'native verifier artifact');
  const sha256 = sha256File(file);
  if (sha256 !== parsedSha256) {
    throw new Error(`native verifier artifact changed between parsing and binding: ${path}`);
  }
  return verifierBindingSchema.parse({
    ...input,
    invocationId: input.invocationId ?? randomUUID(),
    path,
    sha256,
  });
}

/** Serialized receipt mutation with revision checks under the exact run lease. */
export class VerifierReceiptStore {
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly roots: BenchPathRoots,
    private readonly suite: BenchSuite,
    private readonly runId: string,
    private readonly manifestSha256: string,
    private readonly lease: BenchLockHandle,
  ) {
    if (lease.path !== runLeaseFile(roots, suite, runId)) {
      throw new Error('verifier receipt store requires the exact run lifecycle lease');
    }
  }

  load(): VerifierReceipt {
    this.lease.assertHeld();
    const directory = runDir(this.roots, this.suite, this.runId);
    const receipt = verifierReceiptSchema.parse(readPrivateJson(
      directory,
      verifierReceiptFile(this.roots, this.suite, this.runId),
    ));
    this.assertIdentity(receipt);
    return receipt;
  }

  initialize(now = new Date()): VerifierReceipt {
    this.lease.assertHeld();
    const path = verifierReceiptFile(this.roots, this.suite, this.runId);
    if (existsSync(path)) throw new Error('verifier receipt already exists');
    const receipt = createVerifierReceipt(this.suite, this.runId, this.manifestSha256, now);
    writePrivateJsonAtomic(runDir(this.roots, this.suite, this.runId), path, receipt);
    return receipt;
  }

  async update(
    expectedRevision: number,
    mutate: (bindings: readonly VerifierBinding[]) => readonly VerifierBinding[],
    now = new Date(),
  ): Promise<VerifierReceipt> {
    let result: VerifierReceipt | undefined;
    let failure: unknown;
    this.queue = this.queue.then(() => {
      try {
        const current = this.load();
        if (current.revision !== expectedRevision) {
          throw new Error(`verifier receipt revision mismatch: expected ${expectedRevision}, found ${current.revision}`);
        }
        result = verifierReceiptSchema.parse({
          ...current,
          revision: current.revision + 1,
          updatedAt: now.toISOString(),
          bindings: mutate(current.bindings),
        });
        this.assertIdentity(result);
        const directory = runDir(this.roots, this.suite, this.runId);
        writePrivateJsonAtomic(directory, verifierReceiptFile(this.roots, this.suite, this.runId), result);
      } catch (error) {
        failure = error;
      }
    });
    await this.queue;
    if (failure !== undefined) throw failure;
    return result!;
  }

  runDirectory(): string {
    return runDir(this.roots, this.suite, this.runId);
  }

  private assertIdentity(receipt: VerifierReceipt): void {
    if (
      receipt.suite !== this.suite
      || receipt.runId !== validateRunId(this.runId)
      || receipt.manifestSha256 !== this.manifestSha256
    ) {
      throw new Error('verifier receipt identity does not match its immutable manifest');
    }
  }
}
