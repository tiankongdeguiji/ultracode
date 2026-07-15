/** Parse a --max-concurrency CLI value: strict positive integer, else null (reject — don't guess). */
export function parseMaxConcurrency(raw: string): number | null {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
}
