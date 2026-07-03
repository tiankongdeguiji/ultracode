/**
 * Emulated structured-output loop pieces (for backends without a native
 * schema flag) + shared candidate extraction and repair prompts.
 */
import type { JsonSchema } from './types.js';

export const SCHEMA_REPAIR_LIMIT = 2;

export function schemaPromptSuffix(schema: JsonSchema): string {
  return [
    '',
    '---',
    'OUTPUT CONTRACT: Respond with ONLY a single JSON value conforming to this JSON Schema.',
    'No prose, no explanations, no markdown code fences — raw JSON only.',
    JSON.stringify(schema),
  ].join('\n');
}

/** Strip markdown fences and extract the outermost JSON object/array. */
export function extractJsonCandidate(text: string): { value: unknown; raw: string } | null {
  let t = text.trim();
  const fence = t.match(/^```(?:json)?\s*\n([\s\S]*?)\n?```\s*$/);
  if (fence) t = fence[1]!.trim();
  try {
    return { value: JSON.parse(t), raw: t };
  } catch {
    /* fall through to substring extraction */
  }
  const first = t.search(/[[{]/);
  if (first === -1) return null;
  const lastBrace = Math.max(t.lastIndexOf('}'), t.lastIndexOf(']'));
  if (lastBrace <= first) return null;
  const sub = t.slice(first, lastBrace + 1);
  try {
    return { value: JSON.parse(sub), raw: sub };
  } catch {
    return null;
  }
}

/** Short follow-up for resume-based repair (session context retained). */
export function resumeRepairPrompt(errors: string[], schema: JsonSchema): string {
  return [
    'Your previous reply did not conform to the required JSON Schema.',
    `Validation errors: ${errors.slice(0, 10).join('; ') || 'output was not parseable as JSON'}`,
    'Reply again with ONLY the corrected raw JSON (no prose, no fences), conforming to:',
    JSON.stringify(schema),
  ].join('\n');
}

/** Self-contained prompt for fresh-spawn repair (no session to resume). */
export function freshRepairPrompt(
  originalPrompt: string,
  previousAnswer: string | undefined,
  errors: string[],
  schema: JsonSchema,
): string {
  return [
    originalPrompt,
    '',
    '---',
    'A previous attempt at this task produced output that failed JSON Schema validation.',
    previousAnswer ? `Previous output:\n${previousAnswer.slice(0, 2000)}` : 'Previous output was not parseable as JSON.',
    `Validation errors: ${errors.slice(0, 10).join('; ')}`,
    'Respond with ONLY a single raw JSON value conforming to this JSON Schema (no prose, no fences):',
    JSON.stringify(schema),
  ].join('\n');
}
