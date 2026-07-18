import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Offline coverage of scripts/release-oss.mjs. Two layers: --dry-run --root
// <tmp> asserts the local preflights and the exact (redacted) ossutil argv
// stream; the reconcile suite swaps in a stub ossutil (OSSUTIL_BIN) plus a
// loopback HTTP endpoint (OSS_PUBLIC_URL) to drive the real non-dry-run flow
// — upload order, --resume semantics, immutability abort — with no network.
// What only a REAL run verifies — the actual upload and the public-read ACL
// taking effect on the bucket — is covered by the nightly release workflow
// plus the script's own post-upload HEAD checks against the public endpoint.

const root = join(__dirname, '../..');
const SCRIPT = join(root, 'scripts/release-oss.mjs');
const PIN_LINE = ': "${UC_NODE_VERSION:=22.14.0}"\n';
const PLATFORMS = ['linux-x64', 'linux-arm64', 'darwin-x64', 'darwin-arm64'];

// Strip every credential/config variable the script reads so the suite is
// hermetic even on a machine (or CI runner) that has real OSS credentials.
function baseEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' };
  for (const k of ['OSS_ACCESS_KEY_ID', 'OSS_ACCESS_KEY_SECRET', 'OSS_STS_TOKEN', 'OSS_CONFIG_FILE', 'ALIBABA_CLOUD_ECS_METADATA', 'OSS_ENDPOINT', 'OSSUTIL_BIN']) {
    delete env[k];
  }
  return { ...env, ...extra };
}

// A minimal publishable repo root: committed clean tree (dist-release/ is
// gitignored, matching the real repo), a real tarball + matching .sha256, and
// an install.sh stub carrying only the Node pin line.
function makeRoot(version = '1.2.3'): { dir: string; sha256: string } {
  const dir = mkdtempSync(join(tmpdir(), 'uc-reloss-'));
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'uc-reloss-fixture', version }, null, 2) + '\n');
  writeFileSync(join(dir, '.gitignore'), 'dist-release/\n');
  mkdirSync(join(dir, 'scripts/oss'), { recursive: true });
  writeFileSync(join(dir, 'scripts/oss/install.sh'), PIN_LINE);
  mkdirSync(join(dir, 'dist-release'), { recursive: true });
  const tarName = `ultracode-${version}.tar.gz`;
  execFileSync('tar', ['-czf', join(dir, 'dist-release', tarName), '-C', dir, 'package.json'], { stdio: 'pipe' });
  const sha256 = createHash('sha256').update(readFileSync(join(dir, 'dist-release', tarName))).digest('hex');
  writeFileSync(join(dir, 'dist-release', `${tarName}.sha256`), `${sha256}  ${tarName}\n`);
  const git = (...a: string[]) => execFileSync('git', a, { cwd: dir, env: baseEnv(), stdio: 'pipe' });
  git('init', '-q');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'test');
  git('add', '-A');
  git('commit', '-qm', 'init');
  return { dir, sha256 };
}

function run(args: string[], env: NodeJS.ProcessEnv): string {
  return execFileSync(process.execPath, [SCRIPT, ...args], { env, encoding: 'utf8' });
}

function runFail(args: string[], env: NodeJS.ProcessEnv): { status: number; output: string } {
  try {
    execFileSync(process.execPath, [SCRIPT, ...args], { env, encoding: 'utf8', stdio: 'pipe' });
  } catch (e) {
    const err = e as { status?: number | null; stdout?: string; stderr?: string };
    return { status: err.status ?? -1, output: `${err.stdout ?? ''}${err.stderr ?? ''}` };
  }
  throw new Error('expected the script to exit nonzero');
}

const cpLines = (out: string) => out.split('\n').filter((l) => l.includes(' cp -f '));

// The reconcile suite MUST spawn asynchronously: the script's post-publish
// HEAD checks call back into the loopback server running in THIS process, and
// a sync spawn would block the event loop it answers from (deadlock).
const execFileAsync = promisify(execFile);

async function runAsync(args: string[], env: NodeJS.ProcessEnv): Promise<string> {
  const { stdout, stderr } = await execFileAsync(process.execPath, [SCRIPT, ...args], { env, encoding: 'utf8' });
  return `${stdout}${stderr}`;
}

async function runFailAsync(args: string[], env: NodeJS.ProcessEnv): Promise<{ status: number; output: string }> {
  try {
    await execFileAsync(process.execPath, [SCRIPT, ...args], { env, encoding: 'utf8' });
  } catch (e) {
    const err = e as { code?: number | null; stdout?: string; stderr?: string };
    return { status: err.code ?? -1, output: `${err.stdout ?? ''}${err.stderr ?? ''}` };
  }
  throw new Error('expected the script to exit nonzero');
}

describe('release-oss publish --dry-run', () => {
  let dir = '';
  let sha256 = '';
  let out = '';

  beforeAll(() => {
    ({ dir, sha256 } = makeRoot());
    out = run(
      ['--dry-run', '--root', dir],
      baseEnv({ OSS_ACCESS_KEY_ID: 'AKIDFAKE', OSS_ACCESS_KEY_SECRET: 'sekret', OSS_STS_TOKEN: 'ststoken' }),
    );
  });

  it('uploads in pointer-safe order: tarball, sha256, install.sh, latest.json last', () => {
    const cps = cpLines(out);
    expect(cps).toHaveLength(4);
    expect(cps[0]).toContain('oss://hongsheng-jhs/ultracode/releases/v1.2.3/ultracode-1.2.3.tar.gz --acl');
    expect(cps[1]).toContain('oss://hongsheng-jhs/ultracode/releases/v1.2.3/ultracode-1.2.3.tar.gz.sha256 --acl');
    expect(cps[2]).toContain('oss://hongsheng-jhs/ultracode/install.sh --acl');
    expect(cps[3]).toContain('oss://hongsheng-jhs/ultracode/latest.json --acl');
  });

  it('every cp carries the ACL + endpoint; cache metadata splits immutable vs pointer', () => {
    for (const l of cpLines(out)) {
      expect(l).toContain('--acl public-read');
      expect(l).toContain('-e oss-cn-hangzhou.aliyuncs.com');
    }
    const [tarball, sidecar, installSh, latest] = cpLines(out);
    expect(tarball).toContain('Cache-Control:max-age=31536000');
    expect(sidecar).toContain('Cache-Control:max-age=31536000');
    expect(installSh).toContain('Cache-Control:max-age=60');
    expect(latest).toContain('Cache-Control:max-age=60');
    expect(installSh).not.toContain('31536000');
    expect(latest).not.toContain('31536000');
    expect(latest).toContain('Content-Type:application/json');
    expect(tarball).not.toContain('Content-Type');
  });

  it('keeps AccessKey id, secret, and STS token off every argv (temp config via -c)', () => {
    expect(out).not.toContain('AKIDFAKE');
    expect(out).not.toContain('sekret');
    expect(out).not.toContain('ststoken');
    expect(out).not.toContain(' -i ');
    expect(out).not.toContain(' -k ');
    expect(out).toMatch(/ -c \S*uc-osscred-/);
  });

  it('writes dist-release/latest.json with schema, release key, and the real sha256', () => {
    const raw = readFileSync(join(dir, 'dist-release/latest.json'), 'utf8');
    const latest = JSON.parse(raw);
    expect(latest).toMatchObject({
      schema: 1,
      version: '1.2.3',
      tarball: 'releases/v1.2.3/ultracode-1.2.3.tar.gz',
      sha256,
    });
    expect(Number.isNaN(Date.parse(latest.publishedAt))).toBe(false);
    // Pretty-printed, one key per line — installers may grep it.
    expect(raw.split('\n')[1]).toBe('  "schema": 1,');
  });
});

describe('release-oss credential chain', () => {
  it('ECS RAM role wins over an AccessKey pair and its name is redacted in output', () => {
    const { dir } = makeRoot();
    const out = run(
      ['--dry-run', '--root', dir],
      baseEnv({ ALIBABA_CLOUD_ECS_METADATA: 'my-role', OSS_ACCESS_KEY_ID: 'AKIDFAKE', OSS_ACCESS_KEY_SECRET: 'sekret' }),
    );
    expect(out).toContain('--mode EcsRamRole --ecs-role-name ***');
    expect(out).not.toContain('my-role');
    expect(out).not.toContain(' -i ');
    expect(out).not.toContain('AKIDFAKE');
  });

  it('falls back to an ossutil config file via -c', () => {
    const { dir } = makeRoot();
    const out = run(['--dry-run', '--root', dir], baseEnv({ OSS_CONFIG_FILE: '/fake/ossutil-config' }));
    expect(out).toContain('-c /fake/ossutil-config');
  });

  it('exits 1 with guidance naming all three options when no credentials are set', () => {
    const { dir } = makeRoot();
    const r = runFail(['--dry-run', '--root', dir], baseEnv());
    expect(r.status).not.toBe(0);
    for (const option of ['ALIBABA_CLOUD_ECS_METADATA', 'OSS_ACCESS_KEY_ID', 'OSS_CONFIG_FILE']) {
      expect(r.output).toContain(option);
    }
  });
});

describe('release-oss preflight errors', () => {
  const env = () => baseEnv({ ALIBABA_CLOUD_ECS_METADATA: 'ci-role' });

  it('rejects a dirty working tree unless --allow-dirty', () => {
    const { dir } = makeRoot();
    writeFileSync(join(dir, 'uncommitted.txt'), 'x');
    const r = runFail(['--dry-run', '--root', dir], env());
    expect(r.status).not.toBe(0);
    expect(r.output).toMatch(/dirty/);
    run(['--dry-run', '--allow-dirty', '--root', dir], env());
  });

  it('rejects a .sha256 sidecar that does not match the tarball', () => {
    const { dir } = makeRoot();
    writeFileSync(join(dir, 'dist-release/ultracode-1.2.3.tar.gz.sha256'), `${'0'.repeat(64)}  ultracode-1.2.3.tar.gz\n`);
    const r = runFail(['--dry-run', '--root', dir], env());
    expect(r.status).not.toBe(0);
    expect(r.output).toMatch(/stale artifact pair/);
  });

  it('rejects a non-SemVer package.json version', () => {
    const { dir } = makeRoot('nope');
    const r = runFail(['--dry-run', '--root', dir], env());
    expect(r.status).not.toBe(0);
    expect(r.output).toMatch(/version missing or invalid/);
  });

  it('rejects an install.sh whose UC_NODE_VERSION pin is unparseable', () => {
    const { dir } = makeRoot();
    writeFileSync(join(dir, 'scripts/oss/install.sh'), '#!/bin/sh\necho no pin here\n');
    // The overwrite dirties the tree; --allow-dirty isolates the pin failure.
    const r = runFail(['--dry-run', '--allow-dirty', '--root', dir], env());
    expect(r.status).not.toBe(0);
    expect(r.output).toMatch(/UC_NODE_VERSION pin is unparseable/);
  });
});

// The stub speaks just enough ossutil: `stat`/`cat` answer from a JSON map of
// remote objects, `cp` records uploads (or serves downloads) — every argv is
// appended to a log the assertions read back.
const STUB_SOURCE = `#!/usr/bin/env node
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
const args = process.argv.slice(2);
appendFileSync(process.env.STUB_LOG, JSON.stringify(args) + '\\n');
const cfg = JSON.parse(readFileSync(process.env.STUB_OBJECTS, 'utf8'));
const objects = cfg.objects;
const errors = cfg.errors ?? {};
const sub = args[0];
if (sub === 'stat' || sub === 'cat') {
  const key = args[1];
  if (key in errors) {
    process.stderr.write(errors[key] + '\\n');
    process.exit(1);
  }
  if (!(key in objects)) {
    process.stderr.write('oss: object not exists\\n');
    process.exit(1);
  }
  process.stdout.write(sub === 'cat' ? objects[key] : 'Content-Length : 1\\n');
} else if (sub === 'cp') {
  // The script always invokes: cp -f <src> <dst> ...
  const src = args[2];
  const dst = args[3];
  if (src.startsWith('oss://')) writeFileSync(dst, objects[src] ?? '');
} else {
  process.stderr.write('stub: unknown subcommand ' + sub + '\\n');
  process.exit(2);
}
`;

describe('release-oss publish + --resume against a stub ossutil', () => {
  let server: Server;
  let publicUrl = '';
  const headHits: string[] = [];

  beforeAll(async () => {
    // Loopback only — stands in for the public OSS endpoint the post-publish
    // HEAD verification probes.
    server = createServer((req, res) => {
      headHits.push(`${req.method} ${req.url}`);
      res.statusCode = 200;
      res.end();
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const addr = server.address();
    if (addr === null || typeof addr !== 'object') throw new Error('no server address');
    publicUrl = `http://127.0.0.1:${addr.port}/ultracode`;
  });

  afterAll(async () => {
    await new Promise((r) => server.close(r));
  });

  // Remote object keys as the script addresses them.
  const REMOTE_TAR = 'oss://hongsheng-jhs/ultracode/releases/v1.2.3/ultracode-1.2.3.tar.gz';
  const REMOTE_SHA = `${REMOTE_TAR}.sha256`;

  function stubEnv(
    remoteObjects: Record<string, string>,
    errors: Record<string, string> = {},
    opts: { prefillRuntime?: boolean } = {},
  ): { env: NodeJS.ProcessEnv; log: string } {
    // Stub state lives OUTSIDE the fixture repo — extra files there would
    // trip the clean-tree preflight.
    const stubDir = mkdtempSync(join(tmpdir(), 'uc-osstub-'));
    const stub = join(stubDir, 'ossutil-stub.mjs');
    writeFileSync(stub, STUB_SOURCE);
    chmodSync(stub, 0o755);
    const log = join(stubDir, 'stub-log.jsonl');
    writeFileSync(log, '');
    // Runtime tarball+sidecar pairs exist so the fail-closed runtime
    // preflight stays quiet (mirror-mode tests opt out to exercise it).
    if (opts.prefillRuntime !== false) {
      for (const plat of PLATFORMS) {
        remoteObjects[`oss://hongsheng-jhs/ultracode/runtime/node-v22.14.0-${plat}.tar.gz`] ??= '';
        remoteObjects[`oss://hongsheng-jhs/ultracode/runtime/node-v22.14.0-${plat}.tar.gz.sha256`] ??= '';
      }
    }
    const objects = join(stubDir, 'stub-objects.json');
    writeFileSync(objects, JSON.stringify({ objects: remoteObjects, errors }));
    const env = baseEnv({
      ALIBABA_CLOUD_ECS_METADATA: 'ci-role',
      OSSUTIL_BIN: stub,
      OSS_PUBLIC_URL: publicUrl,
      STUB_LOG: log,
      STUB_OBJECTS: objects,
    });
    return { env, log };
  }

  // Upload argvs only (cp -f <local> <oss://dest>), excluding reconcile downloads.
  const uploads = (log: string): string[][] =>
    readFileSync(log, 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as string[])
      .filter((a) => a[0] === 'cp' && !a[2]!.startsWith('oss://'));

  it('fresh publish uploads all four objects in pointer-safe order and HEAD-verifies them', async () => {
    const { dir, sha256 } = makeRoot();
    const { env, log } = stubEnv({});
    headHits.length = 0;
    await runAsync(['--root', dir], env);
    const dests = uploads(log).map((a) => a[3]);
    expect(dests).toEqual([
      REMOTE_TAR,
      REMOTE_SHA,
      'oss://hongsheng-jhs/ultracode/install.sh',
      'oss://hongsheng-jhs/ultracode/latest.json',
    ]);
    expect(JSON.parse(readFileSync(join(dir, 'dist-release/latest.json'), 'utf8')).sha256).toBe(sha256);
    expect(headHits).toEqual([
      'HEAD /ultracode/releases/v1.2.3/ultracode-1.2.3.tar.gz',
      'HEAD /ultracode/releases/v1.2.3/ultracode-1.2.3.tar.gz.sha256',
      'HEAD /ultracode/install.sh',
      'HEAD /ultracode/latest.json',
    ]);
  });

  it('re-publish of an existing version aborts, naming --resume and --force', async () => {
    const { dir } = makeRoot();
    const { env } = stubEnv({ [REMOTE_TAR]: 'remote-bytes' });
    const r = await runFailAsync(['--root', dir], env);
    expect(r.status).not.toBe(0);
    expect(r.output).toMatch(/already exists — releases are immutable/);
    expect(r.output).toContain('--resume');
    expect(r.output).toContain('--force');
  });

  it('--resume with a verified remote pair uploads only the pointers, advertising the REMOTE sha', async () => {
    const { dir, sha256 } = makeRoot();
    const remoteBytes = 'remote-bytes';
    const remoteSha = createHash('sha256').update(remoteBytes).digest('hex');
    const { env, log } = stubEnv({
      [REMOTE_TAR]: remoteBytes,
      [REMOTE_SHA]: `${remoteSha}  ultracode-1.2.3.tar.gz\n`,
    });
    const out = await runAsync(['--resume', '--root', dir], env);
    expect(out).toMatch(/keeping it and reconciling/);
    const dests = uploads(log).map((a) => a[3]);
    expect(dests).toEqual(['oss://hongsheng-jhs/ultracode/install.sh', 'oss://hongsheng-jhs/ultracode/latest.json']);
    const latest = JSON.parse(readFileSync(join(dir, 'dist-release/latest.json'), 'utf8'));
    expect(latest.sha256).toBe(remoteSha);
    expect(latest.sha256).not.toBe(sha256);
  });

  it('--resume repairs a sidecar that does not match the remote tarball bytes', async () => {
    const { dir } = makeRoot();
    const remoteBytes = 'remote-bytes';
    const remoteSha = createHash('sha256').update(remoteBytes).digest('hex');
    // An interleaved earlier publish left tarball B + sidecar A.
    const { env, log } = stubEnv({
      [REMOTE_TAR]: remoteBytes,
      [REMOTE_SHA]: `${'a'.repeat(64)}  ultracode-1.2.3.tar.gz\n`,
    });
    const out = await runAsync(['--resume', '--root', dir], env);
    expect(out).toMatch(/repaired its mismatched \.sha256 sidecar/);
    const dests = uploads(log).map((a) => a[3]);
    expect(dests).toEqual([
      REMOTE_SHA,
      'oss://hongsheng-jhs/ultracode/install.sh',
      'oss://hongsheng-jhs/ultracode/latest.json',
    ]);
    expect(JSON.parse(readFileSync(join(dir, 'dist-release/latest.json'), 'utf8')).sha256).toBe(remoteSha);
  });

  it('--force overwrites an existing release with the local artifacts', async () => {
    const { dir, sha256 } = makeRoot();
    const { env, log } = stubEnv({
      [REMOTE_TAR]: 'remote-bytes',
      [REMOTE_SHA]: `${'b'.repeat(64)}  ultracode-1.2.3.tar.gz\n`,
    });
    await runAsync(['--force', '--root', dir], env);
    const dests = uploads(log).map((a) => a[3]);
    expect(dests).toEqual([
      REMOTE_TAR,
      REMOTE_SHA,
      'oss://hongsheng-jhs/ultracode/install.sh',
      'oss://hongsheng-jhs/ultracode/latest.json',
    ]);
    expect(JSON.parse(readFileSync(join(dir, 'dist-release/latest.json'), 'utf8')).sha256).toBe(sha256);
  });

  it('an auth/network stat error aborts instead of being read as absence', async () => {
    const { dir } = makeRoot();
    const { env, log } = stubEnv(
      {},
      { [REMOTE_TAR]: 'Error: oss: service returned error: StatusCode=403, ErrorCode=AccessDenied' },
    );
    const r = await runFailAsync(['--root', dir], env);
    expect(r.status).not.toBe(0);
    expect(r.output).toMatch(/refusing to guess/);
    expect(uploads(log)).toHaveLength(0);
  });

  it('--mirror-node aborts when a download does not match SHASUMS256.txt', async () => {
    // A loopback origin (UC_MIRROR_BASE_URL test seam) serving tarball bytes
    // that do NOT hash to the SHASUMS entry — the anti-tamper abort must fire
    // before any upload.
    const shasums = PLATFORMS.map((p) => `${'0'.repeat(64)}  node-v22.14.0-${p}.tar.gz`).join('\n') + '\n';
    const mirror = createServer((req, res) => {
      res.end(req.url!.endsWith('SHASUMS256.txt') ? shasums : 'tarball-bytes-that-hash-differently');
    });
    await new Promise<void>((r) => mirror.listen(0, '127.0.0.1', r));
    const addr = mirror.address();
    if (addr === null || typeof addr !== 'object') throw new Error('no mirror address');
    try {
      const { dir } = makeRoot();
      const { env, log } = stubEnv({}, {}, { prefillRuntime: false });
      const r = await runFailAsync(
        ['--mirror-node', '--root', dir],
        { ...env, UC_MIRROR_BASE_URL: `http://127.0.0.1:${addr.port}/` },
      );
      expect(r.status).not.toBe(0);
      expect(r.output).toMatch(/checksum mismatch/);
      expect(uploads(log)).toHaveLength(0);
    } finally {
      await new Promise((r) => mirror.close(r));
    }
  });

  it('--mirror-node uploads absent platforms, skips mirrored ones, and restores a lone missing sidecar', async () => {
    const content = 'node-tarball-bytes';
    const hex = createHash('sha256').update(content).digest('hex');
    const shasums = PLATFORMS.map((p) => `${hex}  node-v22.14.0-${p}.tar.gz`).join('\n') + '\n';
    const hits: string[] = [];
    const mirror = createServer((req, res) => {
      hits.push(req.url!);
      res.end(req.url!.endsWith('SHASUMS256.txt') ? shasums : content);
    });
    await new Promise<void>((r) => mirror.listen(0, '127.0.0.1', r));
    const addr = mirror.address();
    if (addr === null || typeof addr !== 'object') throw new Error('no mirror address');
    try {
      const { dir } = makeRoot();
      const RT = (p: string) => `oss://hongsheng-jhs/ultracode/runtime/node-v22.14.0-${p}.tar.gz`;
      // linux-x64 fully mirrored; linux-arm64 tarball-only; darwins absent.
      const { env, log } = stubEnv(
        { [RT('linux-x64')]: '', [`${RT('linux-x64')}.sha256`]: '', [RT('linux-arm64')]: '' },
        {},
        { prefillRuntime: false },
      );
      const out = await runAsync(
        ['--mirror-node', '--root', dir],
        { ...env, UC_MIRROR_BASE_URL: `http://127.0.0.1:${addr.port}/` },
      );
      expect(out).toContain('node-v22.14.0-linux-x64.tar.gz already mirrored — skipping');
      expect(uploads(log).map((a) => a[3])).toEqual([
        `${RT('linux-arm64')}.sha256`,
        RT('darwin-x64'),
        `${RT('darwin-x64')}.sha256`,
        RT('darwin-arm64'),
        `${RT('darwin-arm64')}.sha256`,
      ]);
      // Only the two absent platforms were downloaded; the sidecar restore
      // came straight from SHASUMS256.txt.
      expect(hits.filter((u) => !u.endsWith('SHASUMS256.txt'))).toEqual([
        '/node-v22.14.0-darwin-x64.tar.gz',
        '/node-v22.14.0-darwin-arm64.tar.gz',
      ]);
    } finally {
      await new Promise((r) => mirror.close(r));
    }
  });

  it('publish fails closed when the pinned Node runtime is not mirrored', async () => {
    const { dir } = makeRoot();
    const { env, log } = stubEnv({}, {}, { prefillRuntime: false });
    const r = await runFailAsync(['--root', dir], env);
    expect(r.status).not.toBe(0);
    expect(r.output).toMatch(/--mirror-node first/);
    expect(uploads(log)).toHaveLength(0);
  });

  it('--skip-runtime-check publishes despite a missing runtime mirror', async () => {
    const { dir } = makeRoot();
    const { env, log } = stubEnv({}, {}, { prefillRuntime: false });
    await runAsync(['--skip-runtime-check', '--root', dir], env);
    expect(uploads(log)).toHaveLength(4);
  });

  it('--resume with a missing sidecar restores it from the remote bytes before the pointers', async () => {
    const { dir } = makeRoot();
    const remoteBytes = 'remote-tarball-bytes';
    const remoteSha = createHash('sha256').update(remoteBytes).digest('hex');
    const { env, log } = stubEnv({ [REMOTE_TAR]: remoteBytes });
    const out = await runAsync(['--resume', '--root', dir], env);
    expect(out).toMatch(/restored its missing \.sha256 sidecar/);
    const dests = uploads(log).map((a) => a[3]);
    expect(dests).toEqual([
      REMOTE_SHA,
      'oss://hongsheng-jhs/ultracode/install.sh',
      'oss://hongsheng-jhs/ultracode/latest.json',
    ]);
    expect(JSON.parse(readFileSync(join(dir, 'dist-release/latest.json'), 'utf8')).sha256).toBe(remoteSha);
  });
});

describe('release-oss --mirror-node --dry-run', () => {
  const env = () => baseEnv({ ALIBABA_CLOUD_ECS_METADATA: 'ci-role' });

  it('prints runtime uploads for all four platforms using the install.sh pin', () => {
    const { dir } = makeRoot();
    const out = run(['--dry-run', '--mirror-node', '--root', dir], env());
    const cps = cpLines(out);
    expect(cps).toHaveLength(8);
    for (const plat of PLATFORMS) {
      expect(out).toContain(`oss://hongsheng-jhs/ultracode/runtime/node-v22.14.0-${plat}.tar.gz --acl`);
      expect(out).toContain(`oss://hongsheng-jhs/ultracode/runtime/node-v22.14.0-${plat}.tar.gz.sha256 --acl`);
    }
    for (const l of cps) {
      expect(l).toContain('--acl public-read');
      expect(l).toContain('Cache-Control:max-age=31536000');
    }
    expect(out).toContain('npmmirror.com/mirrors/node/v22.14.0');
    // Mirror-only mode: no publish objects, no latest.json generated.
    expect(out).not.toContain('latest.json');
    expect(existsSync(join(dir, 'dist-release/latest.json'))).toBe(false);
  });

  it('honors an explicit version and --from nodejs', () => {
    const { dir } = makeRoot();
    const out = run(['--dry-run', '--mirror-node', '20.11.1', '--from', 'nodejs', '--root', dir], env());
    expect(out).toContain('nodejs.org/dist/v20.11.1');
    expect(out).toContain('oss://hongsheng-jhs/ultracode/runtime/node-v20.11.1-linux-x64.tar.gz --acl');
  });
});
