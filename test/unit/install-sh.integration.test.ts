/**
 * Integration: scripts/oss/install.sh end-to-end against file:// origin
 * fixtures — real sh, curl, and tar, no network. Every spawn gets a fabricated
 * env (fresh fake HOME, temp install/bin/tmp dirs, UC_NODE=this node so
 * runtime provisioning stays deterministic — one dedicated case drops the pin
 * to exercise provisioning), so nothing touches the real $HOME.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  appendFileSync,
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '../..');
const script = join(root, 'scripts/oss/install.sh');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { version: string };

const hasCurl = spawnSync('curl', ['--version'], { stdio: 'ignore' }).status === 0;

function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function makeOrigin(): string {
  return mkdtempSync(join(tmpdir(), 'uc-inst-origin-'));
}

function makeHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'uc-inst-home-'));
  mkdirSync(join(home, 'tmp'));
  return home;
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
function addRelease(origin: string, version: string): string {
  const stageRoot = mkdtempSync(join(tmpdir(), 'uc-inst-stage-'));
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
  return tarball;
}

function runInstall(home: string, origin: string, extraEnv: Record<string, string> = {}) {
  return spawnSync('sh', [script], {
    encoding: 'utf8',
    env: {
      HOME: home,
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      TMPDIR: join(home, 'tmp'),
      UC_BASE_URL: `file://${origin}`,
      UC_INSTALL_DIR: join(home, '.ultracode'),
      UC_BIN_DIR: join(home, '.local/bin'),
      UC_NODE: process.execPath,
      ...extraEnv,
    },
  });
}

function runShim(home: string, args: string[] = []) {
  return spawnSync(join(home, '.local/bin/ultracode'), args, {
    encoding: 'utf8',
    env: { HOME: home, PATH: process.env.PATH ?? '/usr/bin:/bin' },
  });
}

describe.skipIf(!hasCurl)('install.sh', () => {
  it('parses under sh -n', () => {
    const res = spawnSync('sh', ['-n', script], { encoding: 'utf8' });
    expect(res.status, res.stderr).toBe(0);
  });

  it('fresh install: receipt, current symlink, executable marker shim that runs', () => {
    const home = makeHome();
    const origin = makeOrigin();
    addRelease(origin, '9.9.9');
    const res = runInstall(home, origin);
    expect(res.status, res.stderr).toBe(0);

    const receipt = JSON.parse(readFileSync(join(home, '.ultracode/app/9.9.9/.install-receipt.json'), 'utf8'));
    expect(receipt.version).toBe('9.9.9');
    expect(receipt.baseUrl).toBe(`file://${origin}`);
    expect(receipt.installDir).toBe(join(home, '.ultracode'));
    expect(receipt.binDir).toBe(join(home, '.local/bin'));

    const current = join(home, '.ultracode/app/current');
    expect(lstatSync(current).isSymbolicLink()).toBe(true);
    expect(readlinkSync(current)).toBe(join(home, '.ultracode/app/9.9.9'));

    const shim = join(home, '.local/bin/ultracode');
    expect(statSync(shim).mode & 0o111).toBeTruthy();
    expect(readFileSync(shim, 'utf8')).toContain('ultracode-oss-shim');
    const run = runShim(home);
    expect(run.status, run.stderr).toBe(0);
    expect(run.stdout.trim()).toBe('9.9.9');
  }, 30_000);

  it('idempotent re-run: succeeds, keeps the receipt byte-identical, shim still works', () => {
    const home = makeHome();
    const origin = makeOrigin();
    addRelease(origin, '9.9.9');
    expect(runInstall(home, origin).status).toBe(0);
    const receiptPath = join(home, '.ultracode/app/9.9.9/.install-receipt.json');
    const before = readFileSync(receiptPath, 'utf8');

    const res = runInstall(home, origin);
    expect(res.status, res.stderr).toBe(0);
    // Identical bytes (including installedAt) prove the receipt gate skipped re-extraction.
    expect(readFileSync(receiptPath, 'utf8')).toBe(before);
    expect(runShim(home).stdout.trim()).toBe('9.9.9');
  }, 30_000);

  it('upgrade: current flips to the new version, the old versioned dir is retained', () => {
    const home = makeHome();
    const origin = makeOrigin();
    addRelease(origin, '9.9.9');
    expect(runInstall(home, origin).status).toBe(0);

    addRelease(origin, '9.9.10');
    const res = runInstall(home, origin);
    expect(res.status, res.stderr).toBe(0);
    expect(readlinkSync(join(home, '.ultracode/app/current'))).toBe(join(home, '.ultracode/app/9.9.10'));
    expect(res.stdout).toContain('install codex');
    // Detached runners and MCP registrations pin the old absolute path — it must survive.
    expect(existsSync(join(home, '.ultracode/app/9.9.9/dist/cli/main.js'))).toBe(true);
    expect(existsSync(join(home, '.ultracode/app/9.9.9/.install-receipt.json'))).toBe(true);
    expect(runShim(home).stdout.trim()).toBe('9.9.10');
  }, 30_000);

  it('checksum mismatch dies before touching the install: no app dir, no shim, prior install untouched', () => {
    // Fresh env: corrupt tarball, stale sidecar/manifest hash → nothing lands.
    const home = makeHome();
    const origin = makeOrigin();
    const tarball = addRelease(origin, '9.9.9');
    appendFileSync(tarball, 'garbage');
    const res = runInstall(home, origin);
    expect(res.status).not.toBe(0);
    expect(res.stderr).toContain('corrupted download');
    expect(existsSync(join(home, '.ultracode/app/9.9.9'))).toBe(false);
    expect(existsSync(join(home, '.local/bin/ultracode'))).toBe(false);

    // After a good install: a corrupted upgrade leaves the previous current untouched.
    const home2 = makeHome();
    const origin2 = makeOrigin();
    addRelease(origin2, '9.9.9');
    expect(runInstall(home2, origin2).status).toBe(0);
    const badTarball = addRelease(origin2, '9.9.10');
    appendFileSync(badTarball, 'garbage');
    const res2 = runInstall(home2, origin2);
    expect(res2.status).not.toBe(0);
    expect(existsSync(join(home2, '.ultracode/app/9.9.10'))).toBe(false);
    expect(readlinkSync(join(home2, '.ultracode/app/current'))).toBe(join(home2, '.ultracode/app/9.9.9'));
    expect(runShim(home2).stdout.trim()).toBe('9.9.9');
  }, 30_000);

  it('a receipted install whose payload vanished is reinstalled, not trusted', () => {
    const home = makeHome();
    const origin = makeOrigin();
    addRelease(origin, '9.9.9');
    expect(runInstall(home, origin).status).toBe(0);
    // Gut the payload but leave the receipt: a re-run must not flip current
    // onto a broken target and report success.
    const mainJs = join(home, '.ultracode/app/9.9.9/dist/cli/main.js');
    rmSync(mainJs);
    const res = runInstall(home, origin);
    expect(res.status, res.stderr).toBe(0);
    expect(existsSync(mainJs)).toBe(true);
    expect(runShim(home).stdout.trim()).toBe('9.9.9');
  }, 30_000);

  it('receiptless partial install is wiped and replaced', () => {
    const home = makeHome();
    const origin = makeOrigin();
    addRelease(origin, '9.9.9');
    const partial = join(home, '.ultracode/app/9.9.9');
    mkdirSync(partial, { recursive: true });
    writeFileSync(join(partial, 'junk.txt'), 'half-written');

    const res = runInstall(home, origin);
    expect(res.status, res.stderr).toBe(0);
    expect(existsSync(join(partial, 'junk.txt'))).toBe(false);
    expect(existsSync(join(partial, 'dist/cli/main.js'))).toBe(true);
    expect(existsSync(join(partial, '.install-receipt.json'))).toBe(true);
    expect(runShim(home).stdout.trim()).toBe('9.9.9');
  }, 30_000);

  it('UC_VERSION pin bypasses latest.json (and strips a leading v)', () => {
    const home = makeHome();
    const origin = makeOrigin();
    addRelease(origin, '9.9.9');
    addRelease(origin, '9.9.10'); // latest.json now points at 9.9.10

    const res = runInstall(home, origin, { UC_VERSION: 'v9.9.9' });
    expect(res.status, res.stderr).toBe(0);
    expect(readlinkSync(join(home, '.ultracode/app/current'))).toBe(join(home, '.ultracode/app/9.9.9'));
    expect(existsSync(join(home, '.ultracode/app/9.9.10'))).toBe(false);
    expect(runShim(home).stdout.trim()).toBe('9.9.9');
  }, 30_000);

  it('pre-existing non-shim ultracode in UC_BIN_DIR is backed up to ultracode.pre-oss.bak', () => {
    const home = makeHome();
    const origin = makeOrigin();
    addRelease(origin, '9.9.9');
    const binDir = join(home, '.local/bin');
    mkdirSync(binDir, { recursive: true });
    writeFileSync(join(binDir, 'ultracode'), '#!/bin/sh\necho legacy\n');
    chmodSync(join(binDir, 'ultracode'), 0o755);

    const res = runInstall(home, origin);
    expect(res.status, res.stderr).toBe(0);
    expect(res.stdout).toContain('pre-oss.bak');
    expect(readFileSync(join(binDir, 'ultracode.pre-oss.bak'), 'utf8')).toContain('legacy');
    expect(readFileSync(join(binDir, 'ultracode'), 'utf8')).toContain('ultracode-oss-shim');
    expect(runShim(home).stdout.trim()).toBe('9.9.9');
  }, 30_000);

  it('rejects hostile or malformed remote inputs before touching anything', () => {
    const home = makeHome();
    const origin = makeOrigin();
    addRelease(origin, '9.9.9');
    // Path traversal in a pinned version names URLs and install paths.
    let res = runInstall(home, origin, { UC_VERSION: '9.9.9/../evil' });
    expect(res.status).not.toBe(0);
    expect(res.stderr).toContain('unexpected version string');
    // Non-hex sidecar content for a pinned version.
    writeFileSync(join(origin, 'releases/v9.9.9/ultracode-9.9.9.tar.gz.sha256'), 'nothex  ultracode-9.9.9.tar.gz\n');
    res = runInstall(home, origin, { UC_VERSION: '9.9.9' });
    expect(res.status).not.toBe(0);
    expect(res.stderr).toContain('well-formed sha256');
    expect(existsSync(join(home, '.ultracode/app/9.9.9'))).toBe(false);
    expect(existsSync(join(home, '.local/bin/ultracode'))).toBe(false);
  }, 30_000);

  it('dies when app/current exists but is not a symlink', () => {
    const home = makeHome();
    const origin = makeOrigin();
    addRelease(origin, '9.9.9');
    mkdirSync(join(home, '.ultracode/app/current'), { recursive: true });
    const res = runInstall(home, origin);
    expect(res.status).not.toBe(0);
    expect(res.stderr).toContain('not a symlink');
  }, 30_000);

  it('provisions the mirrored Node runtime when no usable node exists, and the shim pins it', () => {
    const home = makeHome();
    const origin = makeOrigin();
    addRelease(origin, '9.9.9');
    // A PATH node that fails --version forces the provisioning fallback
    // without hiding the real PATH tools the installer needs.
    const fakeBin = mkdtempSync(join(tmpdir(), 'uc-inst-fakebin-'));
    writeFileSync(join(fakeBin, 'node'), '#!/bin/sh\nexit 1\n');
    chmodSync(join(fakeBin, 'node'), 0o755);
    // Fabricated runtime tarball at the exact key install.sh derives from its pin.
    const os = process.platform === 'darwin' ? 'darwin' : 'linux';
    const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
    const runtimeName = `node-v22.14.0-${os}-${arch}`;
    const rtStage = mkdtempSync(join(tmpdir(), 'uc-inst-rt-'));
    mkdirSync(join(rtStage, runtimeName, 'bin'), { recursive: true });
    writeFileSync(
      join(rtStage, runtimeName, 'bin/node'),
      '#!/bin/sh\nif [ "$1" = --version ]; then echo v22.14.0; else echo "FAKE-NODE-RAN $*"; fi\n',
    );
    chmodSync(join(rtStage, runtimeName, 'bin/node'), 0o755);
    mkdirSync(join(origin, 'runtime'), { recursive: true });
    const rtTarball = join(origin, 'runtime', `${runtimeName}.tar.gz`);
    const tar = spawnSync('tar', ['-czf', rtTarball, '-C', rtStage, runtimeName]);
    expect(tar.status).toBe(0);
    writeFileSync(`${rtTarball}.sha256`, `${sha256(rtTarball)}  ${runtimeName}.tar.gz\n`);

    const res = runInstall(home, origin, { UC_NODE: '', PATH: `${fakeBin}:${process.env.PATH ?? ''}` });
    expect(res.status, res.stderr).toBe(0);
    expect(res.stdout).toContain('provisioning Node v22.14.0');
    const current = join(home, '.ultracode/runtime/current');
    expect(lstatSync(current).isSymbolicLink()).toBe(true);
    expect(readlinkSync(current)).toBe(join(home, '.ultracode/runtime', runtimeName));
    // The shim pinned the provisioned runtime — running it execs the fake node.
    const run = runShim(home);
    expect(run.status, run.stderr).toBe(0);
    expect(run.stdout).toContain('FAKE-NODE-RAN');

    // Self-heal: a runtime dir whose bin/node lost its exec bits must be
    // replaced by a re-run, not kept in preference to the verified download.
    const provisionedNode = join(home, '.ultracode/runtime', runtimeName, 'bin/node');
    chmodSync(provisionedNode, 0o644);
    const heal = runInstall(home, origin, { UC_NODE: '', PATH: `${fakeBin}:${process.env.PATH ?? ''}` });
    expect(heal.status, heal.stderr).toBe(0);
    expect(statSync(provisionedNode).mode & 0o111).toBeTruthy();
    expect(runShim(home).stdout).toContain('FAKE-NODE-RAN');
  }, 30_000);

  it('a corrupted Node runtime download dies before installing anything', () => {
    const home = makeHome();
    const origin = makeOrigin();
    addRelease(origin, '9.9.9');
    const fakeBin = mkdtempSync(join(tmpdir(), 'uc-inst-fakebin-'));
    writeFileSync(join(fakeBin, 'node'), '#!/bin/sh\nexit 1\n');
    chmodSync(join(fakeBin, 'node'), 0o755);
    const os = process.platform === 'darwin' ? 'darwin' : 'linux';
    const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
    const runtimeName = `node-v22.14.0-${os}-${arch}`;
    const rtStage = mkdtempSync(join(tmpdir(), 'uc-inst-rt-'));
    mkdirSync(join(rtStage, runtimeName, 'bin'), { recursive: true });
    writeFileSync(join(rtStage, runtimeName, 'bin/node'), '#!/bin/sh\necho v22.14.0\n');
    chmodSync(join(rtStage, runtimeName, 'bin/node'), 0o755);
    mkdirSync(join(origin, 'runtime'), { recursive: true });
    const rtTarball = join(origin, 'runtime', `${runtimeName}.tar.gz`);
    const tar = spawnSync('tar', ['-czf', rtTarball, '-C', rtStage, runtimeName]);
    expect(tar.status).toBe(0);
    writeFileSync(`${rtTarball}.sha256`, `${sha256(rtTarball)}  ${runtimeName}.tar.gz\n`);
    appendFileSync(rtTarball, 'garbage');

    const res = runInstall(home, origin, { UC_NODE: '', PATH: `${fakeBin}:${process.env.PATH ?? ''}` });
    expect(res.status).not.toBe(0);
    expect(res.stderr).toContain('sha256 mismatch for the Node runtime');
    expect(existsSync(join(home, '.ultracode/runtime'))).toBe(false);
    expect(existsSync(join(home, '.ultracode/app'))).toBe(false);
    expect(existsSync(join(home, '.local/bin/ultracode'))).toBe(false);
  }, 30_000);

  it('installs a freshly built real release artifact and the shim reports --version', () => {
    // Built into a private outDir — reading the repo-default dist-release/
    // would race release.test.ts, which wipes and rebuilds it in a parallel
    // vitest worker.
    const out = mkdtempSync(join(tmpdir(), 'uc-inst-real-'));
    const build = spawnSync(process.execPath, [join(root, 'scripts/build-release.mjs'), root, out], { encoding: 'utf8' });
    expect(build.status, build.stderr).toBe(0);
    const home = makeHome();
    const origin = makeOrigin();
    const relDir = join(origin, `releases/v${pkg.version}`);
    mkdirSync(relDir, { recursive: true });
    const tarball = join(relDir, `ultracode-${pkg.version}.tar.gz`);
    cpSync(join(out, `ultracode-${pkg.version}.tar.gz`), tarball);
    publish(origin, pkg.version, tarball);

    const res = runInstall(home, origin);
    expect(res.status, res.stderr).toBe(0);
    const run = runShim(home, ['--version']);
    expect(run.status, run.stderr).toBe(0);
    expect(run.stdout.trim()).toBe(pkg.version);
  }, 60_000);
});
