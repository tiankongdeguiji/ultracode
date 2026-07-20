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
