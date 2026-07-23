import { describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import { isTerminal, readManifest } from '../../src/store/manifest.js';

const exec = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const mainTs = join(here, '../../src/cli/main.ts');
const tsxLoader = createRequire(import.meta.url).resolve('tsx');

async function waitTerminal(dir: string): Promise<void> {
  const deadline = Date.now() + 15_000;
  for (;;) {
    const manifest = readManifest(dir);
    if (manifest && isTerminal(manifest.status)) return;
    if (Date.now() > deadline) throw new Error(`run not terminal: ${manifest?.status}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

async function runCli(project: string, store: string, home: string, extra: string[] = []): Promise<string> {
  const { stdout } = await exec(
    process.execPath,
    ['--import', tsxLoader, mainTs, 'run', 'test.workflow.js', '--yes', '--detach', '--home', store, ...extra],
    { cwd: project, env: { ...process.env, HOME: home } },
  );
  return stdout.trim().split('\n')[0]!;
}

describe('CLI layered subagent config', () => {
  it('persists config defaults and lets explicit flags override them', async () => {
    const root = mkdtempSync(join(tmpdir(), 'uc-config-cli-'));
    const project = join(root, 'project');
    const home = join(root, 'home');
    const store = join(root, 'store');
    mkdirSync(join(project, '.ultracode'), { recursive: true });
    writeFileSync(
      join(project, '.ultracode', 'config.json'),
      JSON.stringify({ subagent: { backend: 'mock', model: 'configured', effort: 'high', context_window: 200_000 } }),
    );
    writeFileSync(
      join(project, 'test.workflow.js'),
      `export const meta = { name: 'configured-cli', description: 'd' }
return agent('MOCK:ok done', { label: 'worker' })`,
    );

    const configuredId = await runCli(project, store, home);
    const configuredDir = join(store, 'runs', configuredId);
    expect(JSON.parse(readFileSync(join(configuredDir, 'config.json'), 'utf8'))).toMatchObject({
      backend: 'mock',
      model: 'configured',
      effort: 'high',
      contextWindow: 200_000,
    });
    await waitTerminal(configuredDir);

    const overrideId = await runCli(project, store, home, [
      '--backend', 'mock',
      '--model', 'explicit',
      '--effort', 'low',
      '--context-window', '100000',
    ]);
    const overrideDir = join(store, 'runs', overrideId);
    expect(JSON.parse(readFileSync(join(overrideDir, 'config.json'), 'utf8'))).toMatchObject({
      backend: 'mock',
      model: 'explicit',
      effort: 'low',
      contextWindow: 100_000,
    });
    await waitTerminal(overrideDir);
  }, 40_000);
});
