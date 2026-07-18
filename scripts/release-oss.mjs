#!/usr/bin/env node
// Publish an ultracode release to Alibaba Cloud OSS by shelling out to ossutil.
// Two modes:
//   node scripts/release-oss.mjs [--dry-run] [--resume] [--force] [--allow-dirty]
//     Publishes dist-release/ultracode-<version>.tar.gz (built on demand via
//     scripts/build-release.mjs) plus its .sha256, scripts/oss/install.sh, and
//     a freshly generated latest.json pointer. Pointer objects upload only
//     after everything they reference, so a crash mid-publish never leaves
//     installers chasing missing objects. Released tarballs are immutable:
//     re-publishing an existing version aborts unless --resume (finish a
//     partial publish: keep the remote tarball — rebuilds are not
//     byte-reproducible — and reconcile the pointers to it) or --force
//     (overwrite outright).
//   node scripts/release-oss.mjs --mirror-node [x.y.z] [--from npmmirror|nodejs]
//     Mirror-only mode: downloads the pinned Node runtime tarballs (verified
//     against the upstream SHASUMS256.txt) and uploads them to
//     <bucket>/runtime/, skipping objects that already exist. The version
//     defaults to the UC_NODE_VERSION pin in scripts/oss/install.sh.
// Credentials come from the environment — ALIBABA_CLOUD_ECS_METADATA (ECS RAM
// role, the nightly-CI path), OSS_ACCESS_KEY_ID + OSS_ACCESS_KEY_SECRET
// (optional OSS_STS_TOKEN), or OSS_CONFIG_FILE — and key material is redacted
// as *** in every printed command. --dry-run runs every local preflight and
// prints the exact argv stream without contacting OSS; --root <dir> overrides
// the repo root and OSS_PUBLIC_URL the public endpoint (both exist for tests
// and future mirrors).
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertSemver } from './semver.mjs';

const BUCKET_URL = 'oss://hongsheng-jhs/ultracode';
const PUBLIC_URL = 'https://hongsheng-jhs.oss-cn-hangzhou.aliyuncs.com/ultracode';
const DEFAULT_ENDPOINT = 'oss-cn-hangzhou.aliyuncs.com';
const NODE_PLATFORMS = ['linux-x64', 'linux-arm64', 'darwin-x64', 'darwin-arm64'];
const IMMUTABLE_META = 'Cache-Control:max-age=31536000, immutable';
const POINTER_META = 'Cache-Control:max-age=60';
const NODE_PIN_RE = /^\s*:\s*"\$\{UC_NODE_VERSION:=(\d+\.\d+\.\d+)\}"/m;

const USAGE = [
  'usage: node scripts/release-oss.mjs [--dry-run] [--resume] [--force] [--allow-dirty] [--root <dir>]',
  '       node scripts/release-oss.mjs --mirror-node [x.y.z] [--from npmmirror|nodejs] [--dry-run] [--root <dir>]',
].join('\n');

const CREDENTIAL_GUIDANCE = [
  'no OSS credentials in the environment — set one of:',
  '  ALIBABA_CLOUD_ECS_METADATA=<ram-role-name>       attached ECS instance RAM role (nightly CI)',
  '  OSS_ACCESS_KEY_ID=... OSS_ACCESS_KEY_SECRET=...  AccessKey pair (optional OSS_STS_TOKEN for STS)',
  '  OSS_CONFIG_FILE=<path>                           an existing ossutil config file',
].join('\n');

function fail(message) {
  throw new Error(message);
}

function parseArgs(argv) {
  const opts = {
    dryRun: false,
    resume: false,
    force: false,
    allowDirty: false,
    mirrorNode: false,
    nodeVersion: undefined,
    from: 'npmmirror',
    root: undefined,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--dry-run') opts.dryRun = true;
    else if (arg === '--resume') opts.resume = true;
    else if (arg === '--force') opts.force = true;
    else if (arg === '--allow-dirty') opts.allowDirty = true;
    else if (arg === '--mirror-node') {
      opts.mirrorNode = true;
      if (argv[i + 1] && !argv[i + 1].startsWith('--')) opts.nodeVersion = argv[++i];
    } else if (arg === '--from') {
      const value = argv[++i];
      if (value !== 'npmmirror' && value !== 'nodejs') {
        fail(`--from must be npmmirror or nodejs, got ${JSON.stringify(value)}\n${USAGE}`);
      }
      opts.from = value;
    } else if (arg === '--root') {
      const value = argv[++i];
      if (!value) fail(`--root requires a directory\n${USAGE}`);
      opts.root = resolve(value);
    } else {
      fail(`unknown argument: ${arg}\n${USAGE}`);
    }
  }
  return opts;
}

// One credential-args array for every ossutil invocation; `secrets` lists the
// argv values that must appear as *** in anything we print.
function resolveCredentials(env) {
  if (env.ALIBABA_CLOUD_ECS_METADATA) {
    return { credArgs: ['--mode', 'EcsRamRole', '--ecs-role-name', env.ALIBABA_CLOUD_ECS_METADATA], secrets: [] };
  }
  if (env.OSS_ACCESS_KEY_ID && env.OSS_ACCESS_KEY_SECRET) {
    const credArgs = ['-i', env.OSS_ACCESS_KEY_ID, '-k', env.OSS_ACCESS_KEY_SECRET];
    const secrets = [env.OSS_ACCESS_KEY_ID, env.OSS_ACCESS_KEY_SECRET];
    if (env.OSS_STS_TOKEN) {
      credArgs.push('-t', env.OSS_STS_TOKEN);
      secrets.push(env.OSS_STS_TOKEN);
    }
    return { credArgs, secrets };
  }
  if (env.OSS_CONFIG_FILE) {
    return { credArgs: ['-c', env.OSS_CONFIG_FILE], secrets: [] };
  }
  fail(CREDENTIAL_GUIDANCE);
}

function echo(ctx, args) {
  console.log(`+ ${[ctx.bin, ...args].map((a) => (ctx.secrets.includes(a) ? '***' : a)).join(' ')}`);
}

// Upload one object; in --dry-run only the (redacted) argv is printed.
function cp(ctx, local, key, meta) {
  const args = ['cp', '-f', local, `${BUCKET_URL}/${key}`, '--acl', 'public-read', '-e', ctx.endpoint, ...ctx.credArgs, '--meta', meta];
  echo(ctx, args);
  if (ctx.dryRun) return;
  const r = spawnSync(ctx.bin, args, { stdio: 'inherit' });
  if (r.status !== 0) fail(`ossutil cp ${key} failed (${r.error ? r.error.message : `exit ${r.status}`})`);
}

// Absence must be positively identified: treating an auth/network stat error
// as "absent" would silently bypass the release-immutability guard.
function statExists(ctx, key) {
  const r = spawnSync(ctx.bin, ['stat', `${BUCKET_URL}/${key}`, '-e', ctx.endpoint, ...ctx.credArgs], {
    stdio: 'pipe',
    encoding: 'utf8',
  });
  if (r.error) fail(`could not run ${ctx.bin} (${r.error.message}) — install ossutil or set OSSUTIL_BIN`);
  if (r.status === 0) return true;
  const text = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  if (/NoSuchKey|StatusCode=404|not exist/i.test(text)) return false;
  fail(`ossutil stat ${key} failed for a reason other than absence — refusing to guess:\n${text.trim()}`);
}

function catObject(ctx, key) {
  const r = spawnSync(ctx.bin, ['cat', `${BUCKET_URL}/${key}`, '-e', ctx.endpoint, ...ctx.credArgs], {
    stdio: 'pipe',
    encoding: 'utf8',
  });
  if (r.status !== 0) fail(`ossutil cat ${key} failed (${r.error ? r.error.message : `exit ${r.status}`})`);
  return r.stdout;
}

// Download one object (remote -> local); used only by --resume reconciliation.
function fetchObject(ctx, key, dest) {
  const args = ['cp', '-f', `${BUCKET_URL}/${key}`, dest, '-e', ctx.endpoint, ...ctx.credArgs];
  echo(ctx, args);
  const r = spawnSync(ctx.bin, args, { stdio: 'inherit' });
  if (r.status !== 0) fail(`ossutil cp ${key} -> ${dest} failed (${r.error ? r.error.message : `exit ${r.status}`})`);
}

function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function parseNodePin(source) {
  const m = NODE_PIN_RE.exec(source);
  if (!m) {
    fail('scripts/oss/install.sh exists but its UC_NODE_VERSION pin is unparseable — expected a line like : "${UC_NODE_VERSION:=22.14.0}"');
  }
  return m[1];
}

async function fetchText(url) {
  const res = await fetch(url);
  if (!res.ok) fail(`GET ${url} returned ${res.status}`);
  return res.text();
}

async function download(url, dest) {
  console.log(`downloading ${url}`);
  const res = await fetch(url);
  if (!res.ok) fail(`GET ${url} returned ${res.status}`);
  writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
}

function shasumFor(shasums, name) {
  for (const line of shasums.split('\n')) {
    const [hex, file] = line.trim().split(/\s+/);
    if (file === name) return hex.toLowerCase();
  }
  fail(`SHASUMS256.txt has no entry for ${name}`);
}

async function publish(ctx, root, opts) {
  const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  assertSemver(version);

  const st = spawnSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' });
  if (st.status !== 0) fail(`git status failed in ${root}: ${st.error ? st.error.message : st.stderr.trim()}`);
  if (st.stdout.trim() !== '' && !opts.allowDirty) {
    fail('working tree is dirty — commit or stash so the release matches a commit, or pass --allow-dirty');
  }

  const tarName = `ultracode-${version}.tar.gz`;
  const tarPath = join(root, 'dist-release', tarName);
  const shaPath = `${tarPath}.sha256`;
  if (!existsSync(tarPath) || !existsSync(shaPath)) {
    console.log('dist-release artifacts missing — running scripts/build-release.mjs');
    const b = spawnSync(process.execPath, [join(root, 'scripts/build-release.mjs')], { cwd: root, stdio: 'inherit' });
    if (b.status !== 0) fail(`scripts/build-release.mjs failed (${b.error ? b.error.message : `exit ${b.status}`})`);
    if (!existsSync(tarPath) || !existsSync(shaPath)) fail(`scripts/build-release.mjs did not produce ${tarName} + .sha256`);
  }

  // Stale-pair guard: the sidecar is what installers verify against, so it
  // must describe exactly the tarball being uploaded.
  const sha256 = sha256File(tarPath);
  const recorded = readFileSync(shaPath, 'utf8').trim().split(/\s+/)[0].toLowerCase();
  if (recorded !== sha256) {
    fail(`stale artifact pair: ${tarName}.sha256 records ${recorded} but the tarball hashes to ${sha256} — rerun npm run build:release`);
  }

  const installSh = join(root, 'scripts/oss/install.sh');
  if (!existsSync(installSh)) fail('scripts/oss/install.sh not found — it is published alongside every release');
  const pin = parseNodePin(readFileSync(installSh, 'utf8'));
  if (ctx.dryRun) {
    console.log(`dry-run: skipping runtime presence check for Node v${pin}`);
  } else {
    const missing = NODE_PLATFORMS.filter((p) => !statExists(ctx, `runtime/node-v${pin}-${p}.tar.gz`));
    if (missing.length > 0) {
      console.error(
        `warning: Node v${pin} runtime missing on OSS for ${missing.join(', ')} — run scripts/release-oss.mjs --mirror-node or fresh installs will fail`,
      );
    }
  }

  const releaseKey = `releases/v${version}/${tarName}`;
  const sidecarKey = `${releaseKey}.sha256`;
  // The sha the pointers advertise; --resume pins it to the remote artifact.
  let publishedSha = sha256;
  let uploadImmutables = true;
  if (ctx.dryRun) {
    console.log(`dry-run: skipping immutability stat for ${releaseKey}`);
  } else if (!opts.force && statExists(ctx, releaseKey)) {
    if (!opts.resume) {
      fail(
        `${BUCKET_URL}/${releaseKey} already exists — releases are immutable, bump the version ` +
          '(--resume finishes a partial publish by reconciling the pointers to the existing release; --force overwrites)',
      );
    }
    // Resume after a partial publish. Rebuilds are not byte-reproducible (tar
    // mtimes), so the remote pair IS the release — never re-upload it; the
    // pointers must advertise the sha the sidecar on OSS records.
    uploadImmutables = false;
    if (statExists(ctx, sidecarKey)) {
      const remote = (catObject(ctx, sidecarKey).trim().split(/\s+/)[0] ?? '').toLowerCase();
      if (!/^[0-9a-f]{64}$/.test(remote)) fail(`remote ${sidecarKey} is not a well-formed sha256 sidecar`);
      publishedSha = remote;
      console.log(`v${version} tarball already on OSS — keeping it and reconciling the pointers`);
    } else {
      // The tarball landed but its sidecar did not: finish the immutable pair
      // from the remote bytes, not the (differently-hashed) local rebuild.
      const tmp = mkdtempSync(join(tmpdir(), 'uc-reconcile-'));
      const local = join(tmp, tarName);
      fetchObject(ctx, releaseKey, local);
      publishedSha = sha256File(local);
      writeFileSync(`${local}.sha256`, `${publishedSha}  ${tarName}\n`);
      cp(ctx, `${local}.sha256`, sidecarKey, IMMUTABLE_META);
      console.log(`v${version} tarball already on OSS — restored its missing .sha256 sidecar; reconciling the pointers`);
    }
  }

  const latestPath = join(root, 'dist-release', 'latest.json');
  writeFileSync(
    latestPath,
    JSON.stringify({ schema: 1, version, tarball: releaseKey, sha256: publishedSha, publishedAt: new Date().toISOString() }, null, 2) +
      '\n',
  );

  // Pointer objects (install.sh, latest.json) upload last so a failure
  // part-way through never publishes a pointer to a missing object.
  if (uploadImmutables) {
    cp(ctx, tarPath, releaseKey, IMMUTABLE_META);
    cp(ctx, shaPath, sidecarKey, IMMUTABLE_META);
  }
  cp(ctx, installSh, 'install.sh', POINTER_META);
  cp(ctx, latestPath, 'latest.json', `${POINTER_META}#Content-Type:application/json`);

  if (ctx.dryRun) {
    console.log(`dry-run complete — v${version} would be published to ${ctx.publicUrl}`);
    return;
  }
  // A forgotten ACL leaves objects uploaded but unreadable — verify through
  // the public endpoint, exactly as an installer would fetch them.
  for (const key of [releaseKey, sidecarKey, 'install.sh', 'latest.json']) {
    const url = `${ctx.publicUrl}/${key}`;
    const res = await fetch(url, { method: 'HEAD' });
    if (res.status !== 200) fail(`HEAD ${url} returned ${res.status} — object missing or ACL not public-read`);
  }
  console.log(`published v${version} — install: curl -fsSL ${ctx.publicUrl}/install.sh | sh`);
}

async function mirrorNode(ctx, root, opts) {
  let version = opts.nodeVersion;
  if (!version) {
    const installSh = join(root, 'scripts/oss/install.sh');
    if (!existsSync(installSh)) {
      fail('--mirror-node: no version given and scripts/oss/install.sh not found to read the UC_NODE_VERSION pin from');
    }
    version = parseNodePin(readFileSync(installSh, 'utf8'));
  }
  if (!/^\d+\.\d+\.\d+$/.test(version)) fail(`--mirror-node version must be x.y.z, got ${JSON.stringify(version)}`);
  const base = opts.from === 'nodejs' ? `https://nodejs.org/dist/v${version}/` : `https://npmmirror.com/mirrors/node/v${version}/`;
  // Checksums always come from the origin, not the mirror — a compromised
  // mirror must not be able to vouch for its own tarballs.
  const shasumsUrl = `https://nodejs.org/dist/v${version}/SHASUMS256.txt`;
  console.log(`mirroring Node v${version} from ${base} to ${BUCKET_URL}/runtime/ (checksums from nodejs.org)`);

  if (ctx.dryRun) {
    for (const plat of NODE_PLATFORMS) {
      const name = `node-v${version}-${plat}.tar.gz`;
      cp(ctx, `<download-dir>/${name}`, `runtime/${name}`, IMMUTABLE_META);
      cp(ctx, `<download-dir>/${name}.sha256`, `runtime/${name}.sha256`, IMMUTABLE_META);
    }
    console.log('dry-run complete — nothing downloaded or uploaded');
    return;
  }

  const dir = mkdtempSync(join(tmpdir(), 'uc-mirror-node-'));
  let shasums;
  const getShasums = async () => (shasums ??= await fetchText(shasumsUrl));
  let uploaded = 0;
  let skipped = 0;
  for (const plat of NODE_PLATFORMS) {
    const name = `node-v${version}-${plat}.tar.gz`;
    const tarKey = `runtime/${name}`;
    const haveTar = statExists(ctx, tarKey);
    const haveSha = statExists(ctx, `${tarKey}.sha256`);
    if (haveTar && haveSha) {
      console.log(`${tarKey} already mirrored — skipping`);
      skipped += 1;
      continue;
    }
    const expected = shasumFor(await getShasums(), name);
    const local = join(dir, name);
    await download(`${base}${name}`, local);
    const actual = sha256File(local);
    if (actual !== expected) fail(`checksum mismatch for ${name}: SHASUMS256.txt says ${expected}, download hashes to ${actual}`);
    writeFileSync(`${local}.sha256`, `${actual}  ${name}\n`);
    if (!haveTar) cp(ctx, local, tarKey, IMMUTABLE_META);
    if (!haveSha) cp(ctx, `${local}.sha256`, `${tarKey}.sha256`, IMMUTABLE_META);
    uploaded += 1;
  }
  console.log(`mirrored Node v${version}: ${uploaded} platform(s) uploaded, ${skipped} already present`);
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const root = opts.root ?? join(dirname(fileURLToPath(import.meta.url)), '..');
  const ctx = {
    bin: process.env.OSSUTIL_BIN || 'ossutil',
    endpoint: process.env.OSS_ENDPOINT || DEFAULT_ENDPOINT,
    publicUrl: process.env.OSS_PUBLIC_URL || PUBLIC_URL,
    dryRun: opts.dryRun,
    ...resolveCredentials(process.env),
  };
  if (opts.mirrorNode) await mirrorNode(ctx, root, opts);
  else await publish(ctx, root, opts);
}

try {
  await main();
} catch (err) {
  console.error(`release-oss: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
}
