/**
 * Codex strict-subset schema handling.
 *
 * codex exec --output-schema is enforced server-side with strict:true
 * constrained decoding; a schema outside the subset fails deterministically
 * with HTTP 400 (zero internal retries) on EVERY attempt — so incompatible
 * schemas are rejected here at parse time, before any tokens burn.
 *
 * Where losslessly possible the schema is NORMALIZED for the wire (inject
 * `required` with all keys and `additionalProperties: false` at every object
 * level — both strictly NARROW the accepted outputs, so anything the model
 * produces still validates against the ORIGINAL schema, which remains the
 * engine-side ajv target).
 */
import type { JsonSchema } from './types.js';

/** Keywords the strict subset understands (post-Aug-2025 expansion included). */
const ALLOWED_KEYWORDS = new Set([
  'type',
  'properties',
  'required',
  'additionalProperties',
  'items',
  'enum',
  'const',
  'anyOf',
  '$ref',
  '$defs',
  'definitions',
  'description',
  'title',
  'default',
  'format',
  'pattern',
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'multipleOf',
  'minLength',
  'maxLength',
  'minItems',
  'maxItems',
  '$schema',
]);

const REJECTED_KEYWORDS = new Set([
  'oneOf',
  'allOf',
  'not',
  'if',
  'then',
  'else',
  'patternProperties',
  'propertyNames',
  'dependencies',
  'dependentRequired',
  'dependentSchemas',
  'unevaluatedProperties',
  'unevaluatedItems',
  'contains',
  'prefixItems',
]);

export type StrictCheck = { ok: true; wireSchema: JsonSchema } | { ok: false; reason: string };

export function checkCodexStrictSchema(schema: JsonSchema): StrictCheck {
  if (schema.type !== 'object') {
    return { ok: false, reason: `root: strict structured outputs require type:"object", got ${JSON.stringify(schema.type)}` };
  }
  try {
    const wireSchema = normalizeNode(schema, '$') as JsonSchema;
    return { ok: true, wireSchema };
  } catch (err) {
    return { ok: false, reason: (err as Error).message };
  }
}

function normalizeNode(node: unknown, path: string): unknown {
  if (Array.isArray(node)) return node.map((n, i) => normalizeNode(n, `${path}[${i}]`));
  if (node === null || typeof node !== 'object') return node;

  const src = node as Record<string, unknown>;
  const out: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(src)) {
    if (REJECTED_KEYWORDS.has(key)) {
      throw new Error(`${path}: keyword "${key}" is outside the codex strict subset (deterministic 400)`);
    }
    if (!ALLOWED_KEYWORDS.has(key)) {
      throw new Error(`${path}: keyword "${key}" is not in the strict-subset allowlist`);
    }
    switch (key) {
      case 'properties': {
        const props: Record<string, unknown> = {};
        for (const [name, sub] of Object.entries(value as Record<string, unknown>)) {
          props[name] = normalizeNode(sub, `${path}.properties.${name}`);
        }
        out.properties = props;
        break;
      }
      case 'items':
        out.items = normalizeNode(value, `${path}.items`);
        break;
      case 'anyOf':
        out.anyOf = (value as unknown[]).map((sub, i) => normalizeNode(sub, `${path}.anyOf[${i}]`));
        break;
      case '$defs':
      case 'definitions': {
        const defs: Record<string, unknown> = {};
        for (const [name, sub] of Object.entries(value as Record<string, unknown>)) {
          defs[name] = normalizeNode(sub, `${path}.${key}.${name}`);
        }
        out[key] = defs;
        break;
      }
      case 'additionalProperties':
        if (typeof value === 'object' && value !== null) {
          throw new Error(
            `${path}.additionalProperties: map-style schemas cannot be expressed in the strict subset (narrowing to false would lose data)`,
          );
        }
        out.additionalProperties = false; // true → narrowed; false stays
        break;
      default:
        out[key] = value;
    }
  }

  // Strict mode: every object level lists all properties as required and
  // forbids extras. Both are narrowing-only injections.
  if (src.type === 'object' || out.properties !== undefined) {
    const keys = Object.keys((out.properties as Record<string, unknown>) ?? {});
    out.required = keys;
    if (out.additionalProperties === undefined) out.additionalProperties = false;
  }
  return out;
}
