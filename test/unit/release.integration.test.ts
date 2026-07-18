/**
 * Integration: the esbuild release bundle exercised end-to-end — detached
 * self-re-spawn on the mock backend, packaged-registry resolution, and
 * installer path resolution, all from the flattened dist/cli/main.js. Builds
 * into a temp outDir so parallel vitest workers never race release.test.ts
 * over the default dist-release/.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readManifest } from '../../src/store/manifest.js';

const root = join(__dirname, '../..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

// The bundle must behave like a fresh operator shell: no inherited worker
// guard (ULTRACODE_INSIDE_RUN would make `run` refuse) and no inherited store
// override (ultracodeRoot prefers $ULTRACODE_HOME over cwd).
function childEnv(): Record<string, string> {
  const env: Record<string, string> = { ...(process.env as Record<string, string>) };
  delete env.ULTRACODE_INSIDE_RUN;
  delete env.ULTRACODE_HOME;
  return env;
}

// Exact workflow source the detached-runner integration test drives through
// the mock backend — same result shape asserted here through the bundle.
const HELLO = `export const meta = { name: 'hello', description: 'd', phases: [{ title: 'Greet' }] }
phase('Greet')
const g = await agent('MOCK:tools 2 MOCK:ok hi', { label: 'greeter' })
log('greeting received')
return { g }
`;

describe('release bundle E2E', () => {
  let mainJs: string;

  beforeAll(() => {
    const outDir = mkdtempSync(join(tmpdir(), 'uc-release-'));
    execFileSync(process.execPath, [join(root, 'scripts/build-release.mjs'), root, outDir], { stdio: 'pipe' });
    mainJs = join(outDir, `ultracode-${pkg.version}`, 'dist/cli/main.js');
  }, 120_000);

  it('detached self-re-spawn: bundle runs a mock workflow to a completed manifest', () => {
    // Riskiest path: launchRunner re-invokes import.meta.url-relative
    // ../cli/main.js, which must land back on the bundle itself.
    const dir = mkdtempSync(join(tmpdir(), 'uc-relrun-'));
    const wfPath = join(dir, 'hello.workflow.js');
    writeFileSync(wfPath, HELLO);
    const home = join(dir, 'home');
    const stdout = execFileSync(
      process.execPath,
      [mainJs, 'run', wfPath, '--backend', 'mock', '--json', '--yes', '--home', home],
      { encoding: 'utf8', env: childEnv(), stdio: ['ignore', 'pipe', 'pipe'] },
    );
    // --json prints output.json on stdout after the run; tolerate any leading
    // non-JSON progress line by parsing from the first brace.
    const output = JSON.parse(stdout.slice(stdout.indexOf('{')));
    expect(output.result).toEqual({ g: 'hi' });
    expect(output.logs).toEqual(['greeting received']);
    expect(output.agentCount).toBe(1);

    const runIds = readdirSync(join(home, 'runs'));
    expect(runIds).toHaveLength(1);
    const manifest = readManifest(join(home, 'runs', runIds[0]!))!;
    expect(manifest.status).toBe('completed');
    expect(manifest.agentCount).toBe(1);
    expect(manifest.phases).toEqual([{ title: 'Greet', agentsDone: 1 }]);
  }, 30_000);

  it('packaged registry: uc-review resolves from the release tree and parses', () => {
    // HOME is pointed at a bare temp dir so a real ~/.ultracode/workflows copy
    // cannot shadow the packaged one — the schema error proves the packaged
    // workflows/ copy resolved + parsed (a resolution failure would say the
    // workflow was not found instead).
    let status = 0;
    let stderr = '';
    try {
      execFileSync(process.execPath, [mainJs, 'run', 'uc-review', '--dry-run', '--yes'], {
        cwd: mkdtempSync(join(tmpdir(), 'uc-relreg-')),
        env: { ...childEnv(), HOME: mkdtempSync(join(tmpdir(), 'uc-relhome-')) },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (e) {
      status = (e as { status?: number }).status ?? -1;
      stderr = String((e as { stderr?: unknown }).stderr ?? '');
    }
    expect(status).not.toBe(0);
    expect(stderr).toMatch(/uc-review meta.inputSchema/);
  }, 30_000);

  it('installer: generic --project --dry-run resolves the packaged skill and writes nothing', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'uc-relinst-'));
    const stdout = execFileSync(process.execPath, [mainJs, 'install', 'generic', '--project', '--dry-run'], {
      cwd,
      encoding: 'utf8',
      env: childEnv(),
    });
    expect(stdout).toContain('.agents/skills/ultracode');
    expect(readdirSync(cwd)).toEqual([]); // dry-run must not write
  }, 30_000);
});
