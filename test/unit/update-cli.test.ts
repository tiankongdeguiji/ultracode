/**
 * `ultracode update` (src/cli/update.ts): source-checkout refusal, --check
 * against file:// origin fixtures, semver-compare edges, and a full update
 * that re-execs the REAL scripts/oss/install.sh into a temp install root.
 * Everything is offline — file:// base URLs throughout; the full-update case
 * needs curl (install.sh's fetcher) and self-skips without it.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compareVersions, updateCommand, type UpdateDeps } from '../../src/cli/update.js';
import { VERSION } from '../../src/version.js';

const here = dirname(fileURLToPath(import.meta.url));
const installSh = join(here, '../../scripts/oss/install.sh');

const hasCurl = spawnSync('curl', ['--version'], { stdio: 'ignore' }).status === 0;

function capture(stream: 'stdout' | 'stderr'): { chunks: string[]; restore: () => void } {
  const chunks: string[] = [];
  const spy = vi.spyOn(process[stream], 'write').mockImplementation((chunk) => {
    chunks.push(String(chunk));
    return true;
  });
  return { chunks, restore: () => spy.mockRestore() };
}

/** Fake installed appRoot: a receipt plus deps whose modulePath looks like the built dist. */
function makeInstalled(receipt: Record<string, unknown>, env: NodeJS.ProcessEnv = {}): { appRoot: string; deps: UpdateDeps } {
  const appRoot = mkdtempSync(join(tmpdir(), 'uc-update-app-'));
  writeFileSync(join(appRoot, '.install-receipt.json'), JSON.stringify(receipt));
  return { appRoot, deps: { appRoot, modulePath: join(appRoot, 'dist/cli/update.js'), env } };
}

function makeOrigin(latestJson?: string): string {
  const origin = mkdtempSync(join(tmpdir(), 'uc-update-origin-'));
  if (latestJson !== undefined) writeFileSync(join(origin, 'latest.json'), latestJson);
  return origin;
}

function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

/** Writes the .sha256 sidecar and rewrites latest.json (one key per line) for a tarball already in the origin. */
function publish(origin: string, version: string, tarball: string): void {
  const hex = sha256(tarball);
  writeFileSync(`${tarball}.sha256`, `${hex}  ultracode-${version}.tar.gz\n`);
  writeFileSync(
    join(origin, 'latest.json'),
    [
      '{',
      '  "schema": 1,',
      `  "version": "${version}",`,
      `  "tarball": "releases/v${version}/ultracode-${version}.tar.gz",`,
      `  "sha256": "${hex}",`,
      '  "publishedAt": "2026-07-17T00:00:00Z"',
      '}',
      '',
    ].join('\n'),
  );
}

/** Fabricates a stub release (CJS main.js that prints its version) and points latest.json at it. */
function addRelease(origin: string, version: string): void {
  const stageRoot = mkdtempSync(join(tmpdir(), 'uc-update-stage-'));
  const stage = join(stageRoot, `ultracode-${version}`);
  mkdirSync(join(stage, 'dist/cli'), { recursive: true });
  writeFileSync(join(stage, 'package.json'), JSON.stringify({ name: 'ultracode', version, type: 'commonjs' }) + '\n');
  writeFileSync(join(stage, 'dist/cli/main.js'), `#!/usr/bin/env node\nconsole.log('${version}');\n`);
  const relDir = join(origin, `releases/v${version}`);
  mkdirSync(relDir, { recursive: true });
  const tarball = join(relDir, `ultracode-${version}.tar.gz`);
  const tar = spawnSync('tar', ['-czf', tarball, '-C', stageRoot, `ultracode-${version}`]);
  if (tar.status !== 0) throw new Error(`fixture tar failed: ${tar.stderr}`);
  publish(origin, version, tarball);
}

afterEach(() => vi.restoreAllMocks());

describe('update CLI', () => {
  it('refuses a source checkout (no receipt) with exit 2', async () => {
    const appRoot = mkdtempSync(join(tmpdir(), 'uc-update-src-'));
    const err = capture('stderr');
    const code = await updateCommand({}, { appRoot, modulePath: join(appRoot, 'dist/cli/update.js'), env: {} });
    err.restore();
    expect(code).toBe(2);
    expect(err.chunks.join('')).toContain('source checkout');
  });

  it('refuses when running from .ts sources even with a receipt present', async () => {
    const { appRoot } = makeInstalled({ baseUrl: 'file:///nowhere', installDir: '/x', binDir: '/y' });
    const err = capture('stderr');
    const code = await updateCommand({}, { appRoot, modulePath: join(appRoot, 'src/cli/update.ts'), env: {} });
    err.restore();
    expect(code).toBe(2);
    expect(err.chunks.join('')).toContain('source checkout');
  });

  it('--check reports an available update with exit 1', async () => {
    const origin = makeOrigin('{ "version": "99.0.0" }');
    const { deps } = makeInstalled({ baseUrl: `file://${origin}`, installDir: '/x', binDir: '/y' });
    const out = capture('stdout');
    const code = await updateCommand({ check: true }, deps);
    out.restore();
    expect(code).toBe(1);
    expect(out.chunks.join('')).toBe(`ultracode ${VERSION} -> latest 99.0.0 (update available)\n`);
  });

  it('--check on the current version exits 0', async () => {
    const origin = makeOrigin(`{ "version": "${VERSION}" }`);
    const { deps } = makeInstalled({ baseUrl: `file://${origin}`, installDir: '/x', binDir: '/y' });
    const out = capture('stdout');
    const code = await updateCommand({ check: true }, deps);
    out.restore();
    expect(code).toBe(0);
    expect(out.chunks.join('')).toBe(`up to date (${VERSION})\n`);
  });

  it('--check treats a prerelease of the current triple as older (up to date)', async () => {
    const origin = makeOrigin(`{ "version": "${VERSION}-rc.1" }`);
    const { deps } = makeInstalled({ baseUrl: `file://${origin}`, installDir: '/x', binDir: '/y' });
    const out = capture('stdout');
    const code = await updateCommand({ check: true }, deps);
    out.restore();
    expect(code).toBe(0);
    expect(out.chunks.join('')).toContain('up to date');
  });

  it('--check honors env UC_BASE_URL over the receipt baseUrl', async () => {
    const origin = makeOrigin('{ "version": "99.0.0" }');
    const { deps } = makeInstalled(
      { baseUrl: 'file:///nowhere-uc-stale', installDir: '/x', binDir: '/y' },
      { UC_BASE_URL: `file://${origin}` },
    );
    const out = capture('stdout');
    expect(await updateCommand({ check: true }, deps)).toBe(1);
    out.restore();
  });

  it('--check exits 2 on an unreachable origin and on garbage latest.json', async () => {
    const gone = makeInstalled({ baseUrl: 'file:///nowhere-uc-missing', installDir: '/x', binDir: '/y' });
    let err = capture('stderr');
    expect(await updateCommand({ check: true }, gone.deps)).toBe(2);
    err.restore();
    expect(err.chunks.join('')).toContain('ultracode update:');

    const garbage = makeInstalled(
      { baseUrl: `file://${makeOrigin('not json at all')}`, installDir: '/x', binDir: '/y' },
      {},
    );
    err = capture('stderr');
    expect(await updateCommand({ check: true }, garbage.deps)).toBe(2);
    err.restore();

    const noVersion = makeInstalled(
      { baseUrl: `file://${makeOrigin('{ "version": "not-a-version" }')}`, installDir: '/x', binDir: '/y' },
      {},
    );
    err = capture('stderr');
    expect(await updateCommand({ check: true }, noVersion.deps)).toBe(2);
    err.restore();
  });

  it('compareVersions: numeric per-component ordering, prerelease older than plain', () => {
    expect(compareVersions('10.0.0', '9.9.9')).toBe(1);
    expect(compareVersions('9.9.9', '10.0.0')).toBe(-1);
    expect(compareVersions('1.2.10', '1.2.9')).toBe(1);
    expect(compareVersions('1.2.3', '1.2.3')).toBe(0);
    expect(compareVersions('1.2.3-rc.1', '1.2.3')).toBe(-1);
    expect(compareVersions('1.2.3', '1.2.3-rc.1')).toBe(1);
    expect(() => compareVersions('nope', '1.2.3')).toThrow(/semver/);
  });

  it('compareVersions: SemVer prerelease identifier and build-metadata semantics', () => {
    expect(compareVersions('1.2.3-rc.10', '1.2.3-rc.2')).toBe(1);
    expect(compareVersions('1.2.3-rc.2', '1.2.3-rc.10')).toBe(-1);
    expect(compareVersions('1.2.3-alpha', '1.2.3-alpha.1')).toBe(-1);
    expect(compareVersions('1.2.3-1', '1.2.3-alpha')).toBe(-1);
    expect(compareVersions('1.2.3-alpha.beta', '1.2.3-alpha.beta')).toBe(0);
    expect(compareVersions('1.2.3+build.1', '1.2.3')).toBe(0);
    expect(compareVersions('1.2.3-rc.1+build.7', '1.2.3-rc.1')).toBe(0);
  });

  it('full update hands the running node to the installer as UC_NODE', async () => {
    const origin = makeOrigin('{ "version": "99.0.0" }');
    // Stub install.sh records the UC_NODE the updater passed down.
    writeFileSync(join(origin, 'install.sh'), '#!/bin/sh\nprintf %s "$UC_NODE" > "$UC_INSTALL_DIR/node-used"\n');
    const installDir = mkdtempSync(join(tmpdir(), 'uc-update-idir-'));
    const { deps } = makeInstalled({ baseUrl: `file://${origin}`, installDir, binDir: '/y' });
    const code = await updateCommand({}, deps);
    expect(code).toBe(0);
    expect(readFileSync(join(installDir, 'node-used'), 'utf8')).toBe(process.execPath);
  });

  it('--to the running version is a friendly no-op', async () => {
    const { deps } = makeInstalled({ baseUrl: 'file:///nowhere', installDir: '/x', binDir: '/y' });
    const out = capture('stdout');
    const code = await updateCommand({ to: `v${VERSION}` }, deps);
    out.restore();
    expect(code).toBe(0);
    expect(out.chunks.join('')).toContain(`already on ${VERSION}`);
  });

  it('bare update never downgrades when latest.json lags the running version', async () => {
    // No install.sh exists in this origin — exit 0 proves the downgrade gate
    // returned before any re-exec was attempted.
    const origin = makeOrigin('{ "version": "0.0.1" }');
    const { deps } = makeInstalled({ baseUrl: `file://${origin}`, installDir: '/x', binDir: '/y' });
    const out = capture('stdout');
    const code = await updateCommand({}, deps);
    out.restore();
    expect(code).toBe(0);
    expect(out.chunks.join('')).toContain('up to date');
  });

  it('--to rejects a malformed version with exit 2', async () => {
    const { deps } = makeInstalled({ baseUrl: 'file:///nowhere', installDir: '/x', binDir: '/y' });
    const err = capture('stderr');
    const code = await updateCommand({ to: 'not.a.version' }, deps);
    err.restore();
    expect(code).toBe(2);
    expect(err.chunks.join('')).toContain('--to expects');
  });

  it('a corrupt receipt exits 2 with an error message', async () => {
    const appRoot = mkdtempSync(join(tmpdir(), 'uc-update-app-'));
    writeFileSync(join(appRoot, '.install-receipt.json'), 'not json {');
    const err = capture('stderr');
    const code = await updateCommand({ check: true }, { appRoot, modulePath: join(appRoot, 'dist/cli/update.js'), env: {} });
    err.restore();
    expect(code).toBe(2);
    expect(err.chunks.join('')).toContain('ultracode update:');
  });

  it('a receipt missing installDir/binDir exits 2 before any re-exec', async () => {
    const origin = makeOrigin('{ "version": "99.0.0" }');
    const { deps } = makeInstalled({ baseUrl: `file://${origin}` });
    const err = capture('stderr');
    const code = await updateCommand({}, deps);
    err.restore();
    expect(code).toBe(2);
    expect(err.chunks.join('')).toContain('installDir/binDir');
  });

  it.skipIf(!hasCurl)('a failing install.sh re-exec propagates its exit code and prints no success line', async () => {
    const home = mkdtempSync(join(tmpdir(), 'uc-update-home-'));
    mkdirSync(join(home, 'tmp'));
    // latest.json points at 9.9.9 but no release objects exist — the
    // re-exec'd installer must die and the updater must not claim success.
    const origin = makeOrigin('{ "version": "9.9.9" }');
    cpSync(installSh, join(origin, 'install.sh'));
    const installDir = join(home, '.ultracode');
    const binDir = join(home, '.local/bin');
    const appRoot = join(installDir, 'app', VERSION);
    mkdirSync(appRoot, { recursive: true });
    writeFileSync(
      join(appRoot, '.install-receipt.json'),
      JSON.stringify({ schema: 1, version: VERSION, baseUrl: `file://${origin}`, installDir, binDir }),
    );

    const out = capture('stdout');
    const code = await updateCommand({}, {
      appRoot,
      modulePath: join(appRoot, 'dist/cli/update.js'),
      env: { HOME: home, PATH: process.env.PATH ?? '/usr/bin:/bin', TMPDIR: join(home, 'tmp') },
    });
    out.restore();
    expect(code).not.toBe(0);
    expect(out.chunks.join('')).not.toContain('updated');
    expect(existsSync(join(installDir, 'app/9.9.9'))).toBe(false);
  }, 30_000);

  it.skipIf(!hasCurl)('full update re-execs the real install.sh: new dir + flipped current, old dir retained', async () => {
    const home = mkdtempSync(join(tmpdir(), 'uc-update-home-'));
    mkdirSync(join(home, 'tmp'));
    const origin = makeOrigin();
    cpSync(installSh, join(origin, 'install.sh'));
    addRelease(origin, '9.9.9');

    // Fake prior install: versioned app dir holding the receipt, current pointing at it.
    const installDir = join(home, '.ultracode');
    const binDir = join(home, '.local/bin');
    const appRoot = join(installDir, 'app', VERSION);
    mkdirSync(appRoot, { recursive: true });
    writeFileSync(
      join(appRoot, '.install-receipt.json'),
      JSON.stringify({ schema: 1, version: VERSION, baseUrl: `file://${origin}`, installDir, binDir }),
    );
    symlinkSync(appRoot, join(installDir, 'app/current'));

    const out = capture('stdout');
    const code = await updateCommand({}, {
      appRoot,
      modulePath: join(appRoot, 'dist/cli/update.js'),
      env: {
        HOME: home,
        PATH: process.env.PATH ?? '/usr/bin:/bin',
        TMPDIR: join(home, 'tmp'),
        UC_NODE: process.execPath,
      },
    });
    out.restore();
    expect(code).toBe(0);

    const newDir = join(installDir, 'app/9.9.9');
    expect(existsSync(join(newDir, 'dist/cli/main.js'))).toBe(true);
    const newReceipt = JSON.parse(readFileSync(join(newDir, '.install-receipt.json'), 'utf8'));
    expect(newReceipt.version).toBe('9.9.9');
    expect(readlinkSync(join(installDir, 'app/current'))).toBe(newDir);
    // The running copy's dir must survive the upgrade (detached runners pin it).
    expect(existsSync(join(appRoot, '.install-receipt.json'))).toBe(true);
    expect(readFileSync(join(binDir, 'ultracode'), 'utf8')).toContain('ultracode-oss-shim');

    const text = out.chunks.join('');
    expect(text).toContain(`updated ${VERSION} -> 9.9.9`);
    expect(text).toContain('ultracode install codex');
  }, 30_000);
});
