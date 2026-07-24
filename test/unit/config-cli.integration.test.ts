import { describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
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
  it('requires a backend for live runs but keeps backendless dry-run on mock', async () => {
    const root = mkdtempSync(join(tmpdir(), 'uc-config-cli-'));
    const project = join(root, 'project');
    const home = join(root, 'home');
    const store = join(root, 'store');
    mkdirSync(project, { recursive: true });
    writeFileSync(
      join(project, 'test.workflow.js'),
      `export const meta = { name: 'backend-required', description: 'd' }
return agent('MOCK:ok done', { label: 'worker' })`,
    );

    const live = await exec(
      process.execPath,
      ['--import', tsxLoader, mainTs, 'run', 'test.workflow.js', '--yes', '--detach', '--home', store],
      { cwd: project, env: { ...process.env, HOME: home } },
    ).then(
      () => undefined,
      (error: { stderr?: string }) => error,
    );
    expect(live?.stderr).toContain('run requires --backend or subagent.backend');
    expect(existsSync(store)).toBe(false);

    const dry = await exec(
      process.execPath,
      ['--import', tsxLoader, mainTs, 'run', 'test.workflow.js', '--yes', '--dry-run', '--home', store],
      { cwd: project, env: { ...process.env, HOME: home } },
    );
    expect(dry.stderr).toContain('dry run (mock backend');
    expect(dry.stdout).toContain('"result": "done"');
    expect(existsSync(store)).toBe(false);
  });

  it('persists config defaults and lets explicit flags override them', async () => {
    const root = mkdtempSync(join(tmpdir(), 'uc-config-cli-'));
    const project = join(root, 'project');
    const home = join(root, 'home');
    const store = join(root, 'store');
    mkdirSync(join(project, '.ultracode'), { recursive: true });
    writeFileSync(
      join(project, '.ultracode', 'config.json'),
      JSON.stringify({ subagent: { backend: 'mock', model: 'configured', effort: 'high' } }),
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
    });
    await waitTerminal(configuredDir);

    const overrideId = await runCli(project, store, home, [
      '--backend', 'mock',
      '--model', 'explicit',
      '--effort', 'low',
    ]);
    const overrideDir = join(store, 'runs', overrideId);
    expect(JSON.parse(readFileSync(join(overrideDir, 'config.json'), 'utf8'))).toMatchObject({
      backend: 'mock',
      model: 'explicit',
      effort: 'low',
    });
    await waitTerminal(overrideDir);
  }, 40_000);

  it('starts a fresh profile when an explicit CLI backend differs from config', async () => {
    const root = mkdtempSync(join(tmpdir(), 'uc-config-cli-switch-'));
    const project = join(root, 'project');
    const home = join(root, 'home');
    const store = join(root, 'store');
    mkdirSync(join(project, '.ultracode'), { recursive: true });
    writeFileSync(
      join(project, '.ultracode', 'config.json'),
      JSON.stringify({
        subagent: {
          backend: 'qoder',
          model: 'Qwen3.8-Max-Preview',
          effort: 'xhigh',
          context_window: 1_000_000,
        },
      }),
    );
    writeFileSync(
      join(project, 'test.workflow.js'),
      `export const meta = { name: 'configured-cli-switch', description: 'd' }
return agent('MOCK:ok done', { label: 'worker' })`,
    );

    const { stdout, stderr } = await exec(
      process.execPath,
      [
        '--import', tsxLoader, mainTs, 'run', 'test.workflow.js', '--yes', '--detach',
        '--home', store, '--backend', 'mock',
      ],
      { cwd: project, env: { ...process.env, HOME: home } },
    );
    const runId = stdout.trim().split('\n')[0]!;
    const dir = join(store, 'runs', runId);
    const config = JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8'));
    expect(config.backend).toBe('mock');
    expect(config).not.toHaveProperty('model');
    expect(config).not.toHaveProperty('effort');
    expect(config).not.toHaveProperty('contextWindow');
    expect(stderr).toContain(
      "backend override 'mock' differs from configured backend 'qoder'; " +
      'not inheriting configured model, effort, contextWindow',
    );
    await waitTerminal(dir);

    const incompatible = await exec(
      process.execPath,
      [
        '--import', tsxLoader, mainTs, 'run', 'test.workflow.js', '--yes', '--detach',
        '--home', join(root, 'bad-store'), '--backend', 'mock', '--context-window', '200000',
      ],
      { cwd: project, env: { ...process.env, HOME: home } },
    ).then(
      () => undefined,
      (error: { stderr?: string }) => error,
    );
    expect(incompatible?.stderr).toContain('contextWindow is supported only by the qoder backend');
    expect(existsSync(join(root, 'bad-store'))).toBe(false);
  }, 40_000);
});
