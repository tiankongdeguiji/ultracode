/** Strict, dependency-free parsing for suite command long options. */
import type { OptionHelp } from './contracts.js';

export interface OptionDefinition extends OptionHelp {
  kind: 'boolean' | 'string';
}

export interface ParsedOptions {
  values: Readonly<Record<string, boolean | string | readonly string[]>>;
  positionals: readonly string[];
}

function storeValue(
  values: Record<string, boolean | string | string[]>,
  definition: OptionDefinition,
  value: boolean | string,
): void {
  const previous = values[definition.name];
  if (!definition.repeatable) {
    if (previous !== undefined) throw new Error(`--${definition.name} may be provided only once`);
    values[definition.name] = value;
    return;
  }
  const entries = Array.isArray(previous) ? previous : [];
  entries.push(String(value));
  values[definition.name] = entries;
}

/** Parse `--name value` and `--name=value` without aliases or silent coercion. */
export function parseStrictOptions(
  argv: readonly string[],
  definitions: readonly OptionDefinition[],
  options: { allowPositionals?: boolean } = {},
): ParsedOptions {
  const byName = new Map(definitions.map((definition) => [definition.name, definition]));
  if (byName.size !== definitions.length) throw new Error('option definitions contain duplicate names');
  const values: Record<string, boolean | string | string[]> = {};
  const positionals: string[] = [];
  let positionalOnly = false;

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]!;
    if (token === '--') {
      positionalOnly = true;
      continue;
    }
    if (positionalOnly || !token.startsWith('--')) {
      if (!options.allowPositionals) throw new Error(`unexpected positional argument '${token}'`);
      positionals.push(token);
      continue;
    }

    const equals = token.indexOf('=');
    const name = token.slice(2, equals < 0 ? undefined : equals);
    const definition = byName.get(name);
    if (!definition) throw new Error(`unknown option '--${name}'`);
    const inline = equals < 0 ? undefined : token.slice(equals + 1);
    if (definition.kind === 'boolean') {
      if (inline !== undefined) throw new Error(`--${name} does not take a value`);
      storeValue(values, definition, true);
      continue;
    }

    const value = inline ?? argv[++index];
    if (value === undefined || value === '--' || value.startsWith('--')) {
      throw new Error(`--${name} requires a value`);
    }
    if (value.includes('\0')) throw new Error(`--${name} contains a NUL byte`);
    storeValue(values, definition, value);
  }

  return { values, positionals };
}

/** Parse a finite integer without accepting exponent, fraction, or whitespace syntax. */
export function parseIntegerOption(name: string, value: string, minimum = 0): number {
  if (!/^(?:0|[1-9][0-9]*)$/.test(value)) {
    throw new Error(`--${name} must be a base-10 integer`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum) {
    throw new Error(`--${name} must be an integer greater than or equal to ${minimum}`);
  }
  return parsed;
}
