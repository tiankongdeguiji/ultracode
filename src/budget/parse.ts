/**
 * Budget directive parsing: "500k" / "2m" / "1.5m" / "750000" are absolute
 * token targets; "+500k" adds to a configured base (absolute when no base).
 * The target is a HARD dispatch-gate ceiling, not advisory.
 */

export function parseBudget(input: string, base?: number | null): number {
  const raw = input.trim().toLowerCase();
  const relative = raw.startsWith('+');
  const body = relative ? raw.slice(1) : raw;
  const m = body.match(/^(\d+(?:\.\d+)?)\s*([km])?$/);
  if (!m) {
    throw new Error(`invalid budget "${input}" — expected forms: 500k, +500k, 2m, 1.5m, 750000`);
  }
  const value = Number(m[1]);
  const mult = m[2] === 'm' ? 1_000_000 : m[2] === 'k' ? 1_000 : 1;
  const tokens = Math.round(value * mult);
  if (tokens <= 0) throw new Error(`budget must be positive, got ${input}`);
  return relative ? (base ?? 0) + tokens : tokens;
}
