/** Suite registry exactness and dependency-direction coverage. */
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createSuiteRegistry, suiteRegistry } from '../../bench/src/registry.js';
import {
  SUITE_COMMANDS,
  type AnySuiteAdapter,
  type SuiteCommandSpec,
} from '../../bench/src/shared/contracts.js';

const command = (): SuiteCommandSpec<unknown> => ({
  summary: 'test command',
  usage: '',
  options: [],
  parse: () => ({}),
  run: async () => {},
});

function adapter(suite: keyof typeof SUITE_COMMANDS): AnySuiteAdapter {
  return {
    suite,
    displayName: suite,
    description: `${suite} adapter`,
    commands: Object.fromEntries(SUITE_COMMANDS[suite].map((name) => [name, command()])),
  } as unknown as AnySuiteAdapter;
}

function filesBelow(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? filesBelow(path) : [path];
  });
}

describe('suite registry contracts', () => {
  it('registers exact suite command sets in canonical order', () => {
    const registry = createSuiteRegistry([
      adapter('featurebench'),
      adapter('swebench-pro'),
      adapter('swe-marathon'),
      adapter('workflow-authoring'),
    ]);
    expect(registry.list().map((entry) => entry.suite)).toEqual([
      'swebench-pro',
      'swe-marathon',
      'featurebench',
      'workflow-authoring',
    ]);
    expect(Object.keys(registry.get('swebench-pro').commands)).toEqual([...SUITE_COMMANDS['swebench-pro']]);
    expect(suiteRegistry.list().map(({ suite }) => suite)).toEqual([
      'swebench-pro',
      'swe-marathon',
      'featurebench',
      'workflow-authoring',
    ]);
    for (const suite of suiteRegistry.list()) {
      expect(Object.keys(suite.commands)).toEqual([...SUITE_COMMANDS[suite.suite]]);
      expect(suite.cleanup, `${suite.suite} runtime cleanup`).toBeTypeOf('function');
    }
  });

  it('rejects duplicates, missing commands, and extra commands', () => {
    expect(() => createSuiteRegistry([adapter('featurebench'), adapter('featurebench')])).toThrow(/duplicate/);
    const missing = adapter('swe-marathon') as unknown as { commands: Record<string, unknown> };
    delete missing.commands.report;
    expect(() => createSuiteRegistry([missing as unknown as AnySuiteAdapter])).toThrow(/missing report/);
    const extra = adapter('featurebench') as unknown as { commands: Record<string, unknown> };
    extra.commands.clean = command();
    expect(() => createSuiteRegistry([extra as unknown as AnySuiteAdapter])).toThrow(/unexpected clean/);
    expect(() => createSuiteRegistry([adapter('featurebench'), adapter('swe-marathon')])).toThrow(
      /missing swebench-pro/,
    );
  });

  it('settles every production suite resource hook when its registry is empty', async () => {
    for (const suite of suiteRegistry.list()) {
      await expect(suite.cleanup!(), suite.suite).resolves.toBeUndefined();
    }
  });

  it('keeps leaf contracts independent of registry and adapters', () => {
    const root = process.cwd();
    const contracts = readFileSync(join(root, 'bench/src/shared/contracts.ts'), 'utf8');
    const registry = readFileSync(join(root, 'bench/src/registry.ts'), 'utf8');
    expect(contracts).not.toMatch(/from ['"].*(?:registry|suites)\//);
    expect(registry).toContain("from './shared/contracts.js'");
    for (const suite of ['swebench-pro', 'swe-marathon', 'featurebench', 'workflow-authoring']) {
      expect(registry).toContain(`from './suites/${suite}/adapter.js'`);
      const adapterSource = readFileSync(join(root, 'bench/src/suites', suite, 'adapter.ts'), 'utf8');
      expect(adapterSource, suite).not.toMatch(/from ['"].*registry\.js/);
      expect([...adapterSource.matchAll(/from '([^']+)'/gu)].map((match) => match[1])).toEqual([
        '../../shared/contracts.js',
        '../../shared/options.js',
      ]);
      const runnerSource = readFileSync(join(root, 'bench/src/suites', suite, 'runner.ts'), 'utf8');
      expect(runnerSource, suite).not.toMatch(/from ['"].*adapter\.js/);
    }
    for (const file of readdirSync(join(root, 'bench/src/shared')).filter((name) => name.endsWith('.ts'))) {
      const source = readFileSync(join(root, 'bench/src/shared', file), 'utf8');
      expect(source, file).not.toMatch(/from ['"].*(?:registry|suites)\//);
    }
    for (const file of filesBelow(join(root, 'bench/src/suites')).filter((name) => name.endsWith('.ts'))) {
      const source = readFileSync(file, 'utf8');
      expect(source, relative(root, file)).not.toMatch(/from ['"].*(?:cli|registry)\.js/);
    }
  });

  it('matches the exact final benchmark source and native-asset allowlist', () => {
    const root = process.cwd();
    const expected = readFileSync(join(root, 'test/fixtures/bench/tracked-bench-files.txt'), 'utf8')
      .trimEnd()
      .split('\n');
    const actual = [
      ...filesBelow(join(root, 'bench/src')),
      ...filesBelow(join(root, 'bench/suites')),
    ].map((path) => relative(root, path)).sort();
    expect(actual).toEqual(expected);
  });

  it('binds Pro resume and evaluation to the manifest-selected prepared identity', () => {
    const root = process.cwd();
    const runner = readFileSync(join(root, 'bench/src/suites/swebench-pro/runner.ts'), 'utf8');
    const verifier = readFileSync(join(root, 'bench/src/suites/swebench-pro/verifier.ts'), 'utf8');
    const preparation = readFileSync(join(root, 'bench/src/suites/swebench-pro/toolchain.ts'), 'utf8');
    expect(runner.match(/swebenchProPreparedDir\(context\.paths, stores\.manifest\.suiteConfig\.preparedInputSha256\)/gu))
      .toHaveLength(2);
    expect(runner).toContain('loadCurrentPreparedSwebenchProInputs(context.paths, config)');
    expect(verifier).toContain('options.evaluatorPythonBinary');
    expect(verifier).toContain('options.evaluatorDirectory');
    expect(verifier).not.toMatch(/evaluatorVenvDir|harnessDir/);
    expect(preparation).toContain("const target = swebenchProPreparedDir(roots, payloadSha256)");
    expect(preparation).toContain("'--require-hashes'");
    expect(preparation).toContain("'--only-binary=:all:', '--no-deps'");
    expect(preparation).toContain("'venv', '--without-pip'");
    expect(preparation).not.toContain("'--report'");
    expect(preparation.indexOf('const dependencies = loadEvaluatorDependencies(roots)'))
      .toBeLessThan(preparation.indexOf('const targetDependencyPartition = await preflightEvaluatorDependencies'));
    expect(preparation.indexOf('const targetDependencyPartition = await preflightEvaluatorDependencies'))
      .toBeLessThan(preparation.indexOf('const toolchain = await prepareSharedToolchain'));
    expect(preparation).not.toMatch(/prepared-v2|evaluator-venv/);
  });

  it('attests the exact Ultracode release archive separately from its staged tree', () => {
    const source = readFileSync(join(process.cwd(), 'bench/src/shared/toolchain.ts'), 'utf8');
    expect(source).toContain('ultracode-release.tar.gz');
    expect(source).toContain('ultracodeReleaseSha256: sha256File(releaseArchive)');
    expect(source).toContain("sha256File(join(directory, 'ultracode-release.tar.gz')) !== manifest.ultracodeReleaseSha256");
  });
});
