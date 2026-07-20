/** Typed ownership-cleanup failures that must terminate a benchmark command. */

/** Cleanup could not prove that only exact benchmark-owned resources remain absent. */
export class OwnershipUnsafeCleanupError extends Error {
  readonly code = 'ownership-unsafe' as const;

  constructor(message: string, readonly failures: readonly unknown[] = []) {
    super(message, failures.length === 0 ? undefined : {
      cause: new AggregateError(failures, message),
    });
    this.name = 'OwnershipUnsafeCleanupError';
  }
}

/** Native artifact evidence could not be read without weakening containment checks. */
export class ArtifactUnsafeError extends Error {
  readonly code = 'artifact-unsafe' as const;

  constructor(message: string, failure?: unknown) {
    super(message, failure === undefined ? undefined : { cause: failure });
    this.name = 'ArtifactUnsafeError';
  }
}

export function ownershipUnsafe(message: string, failure?: unknown): OwnershipUnsafeCleanupError {
  if (failure instanceof OwnershipUnsafeCleanupError) return failure;
  return new OwnershipUnsafeCleanupError(message, failure === undefined ? [] : [failure]);
}

export function ownershipUnsafeAggregate(
  message: string,
  failures: readonly unknown[],
): OwnershipUnsafeCleanupError {
  return new OwnershipUnsafeCleanupError(message, failures.flatMap((failure) =>
    failure === undefined
      ? []
      : failure instanceof OwnershipUnsafeCleanupError && failure.failures.length > 0
        ? failure.failures
        : [failure]));
}

export interface ActiveReclamationHelper {
  /** Deterministic exact Docker name; also the registry key. */
  name: string;
  /** Reinspect and remove only a helper satisfying the complete ownership proof. */
  cleanup: () => Promise<void>;
  cleanupPromise?: Promise<void>;
}

const ACTIVE_RECLAMATION_HELPERS = new Map<string, ActiveReclamationHelper>();

/** Register a helper before launch so root fatal cleanup can reconcile daemon survivors. */
export function trackActiveReclamationHelper(entry: ActiveReclamationHelper): void {
  if (ACTIVE_RECLAMATION_HELPERS.has(entry.name)) {
    throw new Error(`reclamation helper is already tracked: ${entry.name}`);
  }
  ACTIVE_RECLAMATION_HELPERS.set(entry.name, entry);
}

/** Release only the exact tracked entry after its Docker name is proven absent. */
export function releaseActiveReclamationHelper(entry: ActiveReclamationHelper): void {
  if (ACTIVE_RECLAMATION_HELPERS.get(entry.name) === entry) {
    ACTIVE_RECLAMATION_HELPERS.delete(entry.name);
  }
}

async function cleanupTrackedReclamationHelper(entry: ActiveReclamationHelper): Promise<void> {
  if (ACTIVE_RECLAMATION_HELPERS.get(entry.name) !== entry) return;
  entry.cleanupPromise ??= entry.cleanup().then(() => {
    releaseActiveReclamationHelper(entry);
  });
  const cleanup = entry.cleanupPromise;
  try {
    await cleanup;
  } finally {
    if (ACTIVE_RECLAMATION_HELPERS.get(entry.name) === entry && entry.cleanupPromise === cleanup) {
      entry.cleanupPromise = undefined;
    }
  }
}

/** Retry exact proof-based reclamation-helper cleanup during root fatal handling. */
export async function cleanupActiveReclamationHelpers(): Promise<number> {
  const active = [...ACTIVE_RECLAMATION_HELPERS.values()];
  const settled = await Promise.allSettled(active.map(cleanupTrackedReclamationHelper));
  const failures = settled.flatMap((result) => result.status === 'rejected' ? [result.reason] : []);
  if (failures.length > 0) {
    throw ownershipUnsafeAggregate('active SWE-bench Pro reclamation-helper cleanup failed', failures);
  }
  return active.length;
}
