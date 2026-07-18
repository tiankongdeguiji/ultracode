/** Error taxonomy for the ultracode engine. */

/**
 * Cross-realm-safe error message extraction: errors thrown inside the vm
 * context are instances of the CONTEXT's Error, so `instanceof Error` fails
 * on the host side.
 */
export function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (e !== null && typeof e === 'object' && typeof (e as { message?: unknown }).message === 'string') {
    return (e as { message: string }).message;
  }
  return String(e);
}

export class UltracodeError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

/** Script failed structural validation before execution (size, syntax, meta shape). */
export class MetaValidationError extends UltracodeError {
  constructor(
    message: string,
    readonly loc?: { line: number; column: number },
  ) {
    super(loc ? `${message} (at line ${loc.line}:${loc.column})` : message, 'meta-validation');
  }
}

/** An agent() call failed after exhausting its retry budget. */
export class WorkflowAgentError extends UltracodeError {
  constructor(
    message: string,
    readonly seq: number,
    readonly label: string,
  ) {
    super(message, 'agent-failed');
  }
}

/** agent({schema}) could not produce a schema-valid result within the repair budget. */
export class WorkflowSchemaError extends UltracodeError {
  constructor(
    message: string,
    readonly errors: string[],
  ) {
    super(message, 'schema-invalid');
  }
}

/** Budget dispatch gate tripped. */
export class WorkflowBudgetError extends UltracodeError {
  constructor() {
    super('Workflow budget exceeded', 'budget-exceeded');
  }
}

/** Lifetime agent cap tripped. */
export class WorkflowAgentCapError extends UltracodeError {
  constructor(cap: number) {
    super(`Workflow reached max agents (${cap})`, 'agent-cap');
  }
}

/** A portable-memory operation was unsafe, invalid, or could not be completed. */
export class MemoryError extends UltracodeError {
  constructor(message: string) {
    super(message, 'memory');
  }
}
