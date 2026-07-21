/** Runtime suite registry; adapter-facing types live only in shared/contracts. */
import {
  BENCH_SUITES,
  SUITE_COMMANDS,
  type AnySuiteAdapter,
  type BenchSuite,
  type SuiteAdapter,
} from './shared/contracts.js';
import { swebenchProAdapter } from './suites/swebench-pro/adapter.js';

function validateAdapter(adapter: AnySuiteAdapter): void {
  const expected = new Set<string>(SUITE_COMMANDS[adapter.suite]);
  const actual = Object.keys(adapter.commands);
  const missing = [...expected].filter((command) => !actual.includes(command));
  const extra = actual.filter((command) => !expected.has(command));
  if (missing.length > 0 || extra.length > 0) {
    const detail = [
      missing.length > 0 ? `missing ${missing.join(', ')}` : '',
      extra.length > 0 ? `unexpected ${extra.join(', ')}` : '',
    ].filter(Boolean).join('; ');
    throw new Error(`${adapter.suite} adapter command contract is invalid: ${detail}`);
  }
  for (const command of actual) {
    const spec = (adapter.commands as Record<string, unknown>)[command];
    if (
      spec === null
      || typeof spec !== 'object'
      || typeof (spec as { parse?: unknown }).parse !== 'function'
      || typeof (spec as { run?: unknown }).run !== 'function'
    ) {
      throw new Error(`${adapter.suite} command '${command}' is not a complete command specification`);
    }
  }
}

export class SuiteRegistry {
  private readonly adapters = new Map<BenchSuite, AnySuiteAdapter>();

  constructor(entries: readonly AnySuiteAdapter[]) {
    for (const adapter of entries) {
      if (!(BENCH_SUITES as readonly string[]).includes(adapter.suite)) {
        throw new Error(`adapter declares unknown suite '${String(adapter.suite)}'`);
      }
      if (this.adapters.has(adapter.suite)) throw new Error(`duplicate suite adapter '${adapter.suite}'`);
      validateAdapter(adapter);
      this.adapters.set(adapter.suite, adapter);
    }
  }

  get<S extends BenchSuite>(suite: S): SuiteAdapter<S> {
    const adapter = this.adapters.get(suite);
    if (!adapter) throw new Error(`suite '${suite}' is not registered`);
    return adapter as unknown as SuiteAdapter<S>;
  }

  list(): readonly AnySuiteAdapter[] {
    return BENCH_SUITES.flatMap((suite) => {
      const adapter = this.adapters.get(suite);
      return adapter === undefined ? [] : [adapter];
    });
  }
}

export function createSuiteRegistry(entries: readonly AnySuiteAdapter[]): SuiteRegistry {
  return new SuiteRegistry(entries);
}

/** Production registry. Native runners remain behind command-level imports. */
export const suiteRegistry = createSuiteRegistry([
  swebenchProAdapter,
]);
