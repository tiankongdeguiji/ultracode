/** Shared ajv (2020-12) plumbing — CJS/ESM interop isolated here. */
import ajvModule from 'ajv/dist/2020.js';
import type { JsonSchema } from '../backends/types.js';

const Ajv2020 = (ajvModule as unknown as { default?: typeof ajvModule.Ajv2020 }).default ?? ajvModule.Ajv2020;

export function createAjv() {
  return new Ajv2020({ allErrors: true, strict: false });
}

export interface SchemaValidation {
  ok: boolean;
  errors: string[];
}

/**
 * Validate a value against the ORIGINAL author schema. This runs on every
 * structured-output path regardless of native backend enforcement — native
 * flags are accelerators, never the source of truth.
 */
export function validateWithSchema(schema: JsonSchema, value: unknown): SchemaValidation {
  const ajv = createAjv();
  let validate;
  try {
    validate = ajv.compile(schema);
  } catch (err) {
    return { ok: false, errors: [`schema does not compile: ${(err as Error).message}`] };
  }
  if (validate(value)) return { ok: true, errors: [] };
  const errors = (validate.errors ?? []).map(
    (e: { instancePath?: string; message?: string; params?: unknown }) =>
      `${e.instancePath || '/'} ${e.message ?? ''}`.trim(),
  );
  return { ok: false, errors };
}
