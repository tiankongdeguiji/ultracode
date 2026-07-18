/**
 * Toolchain prep: assembles bench/.cache/toolchain/ — the directory the
 * overlay Dockerfile bakes into /opt/bench — from a pinned Node tarball, the
 * host codex binary, a fresh ultracode release stage, and pre-built codex
 * homes for both arms. The stage keeps the dist/cli/main.js shape because the
 * detached runner re-invokes itself via that path (src/exec/daemonize.ts) and
 * resolves skill/, workflows/, hostpacks/ relative to it. prepareToolchain()
 * rebuilds everything from scratch except cached downloads; toolchainInfo()
 * surfaces manifest provenance for run.json.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  appendFileSync,
  chmodSync,
  copyFileSync,
  cpSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { BENCH_ROOT, cacheDir, downloadsDir, toolchainDir } from './config.js';
import type { BenchConfig } from './types.js';

interface ToolchainManifest {
  nodeVersion: string;
  nodeDist: string;
  nodeMuslRuntime: string;
  codexVersion: string;
  codexSha256: string;
  ultracodeVersion: string;
  builtAt: string;
}

const NODE_MUSL_RUNTIME_ALPINE = '3.20';

function nodeTarballUrl(version: string, dist: BenchConfig['toolchain']['nodeDist']): string {
  switch (dist) {
    case 'npmmirror':
      return `https://npmmirror.com/mirrors/node/v${version}/node-v${version}-linux-x64.tar.xz`;
    case 'nodejs':
      return `https://nodejs.org/dist/v${version}/node-v${version}-linux-x64.tar.xz`;
    case 'unofficial-glibc217':
      return `https://unofficial-builds.nodejs.org/download/release/v${version}/node-v${version}-linux-x64-glibc-217.tar.xz`;
  }
}

/** Alpine-based sweap images cannot run glibc node — a musl build ships alongside. */
function nodeMuslTarballUrl(version: string, dist: BenchConfig['toolchain']['nodeDist']): string {
  return dist === 'npmmirror'
    ? `https://npmmirror.com/mirrors/node-unofficial-builds/v${version}/node-v${version}-linux-x64-musl.tar.xz`
    : `https://unofficial-builds.nodejs.org/download/release/v${version}/node-v${version}-linux-x64-musl.tar.xz`;
}

/**
 * In-container node dispatcher: images are a mix of glibc and musl userlands,
 * so every baked-in node path (MCP registration, entrypoint helpers) goes
 * through this wrapper, which execs the first build that runs here.
 */
const NODE_SEL = `#!/bin/sh
if /opt/bench/node/bin/node --version >/dev/null 2>&1; then
  exec /opt/bench/node/bin/node "$@"
fi
runtime=/opt/bench/node-musl-runtime
if LD_LIBRARY_PATH="$runtime\${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}" /opt/bench/node-musl/bin/node --version >/dev/null 2>&1; then
  export LD_LIBRARY_PATH="$runtime\${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
  exec /opt/bench/node-musl/bin/node "$@"
fi
echo 'ucbench: no runnable node build for this image' >&2
exit 127
`;

/** Bundle the C++ runtime used to build Node's musl tarball for old Alpine images. */
function prepareNodeMuslRuntime(dir: string, nodeVersion: string): string {
  const image = `node:${nodeVersion}-alpine${NODE_MUSL_RUNTIME_ALPINE}`;
  execFileSync('docker', ['pull', image], { stdio: 'ignore' });
  const container = execFileSync('docker', ['create', image], { encoding: 'utf8' }).trim();
  const runtimeDir = join(dir, 'node-musl-runtime');
  mkdirSync(runtimeDir);
  try {
    execFileSync('docker', [
      'cp',
      '-L',
      `${container}:/usr/lib/libstdc++.so.6`,
      join(runtimeDir, 'libstdc++.so.6'),
    ]);
    execFileSync('docker', [
      'cp',
      '-L',
      `${container}:/usr/lib/libgcc_s.so.1`,
      join(runtimeDir, 'libgcc_s.so.1'),
    ]);
  } finally {
    execFileSync('docker', ['rm', '-f', container], { stdio: 'ignore' });
  }
  const digest = execFileSync(
    'docker',
    ['image', 'inspect', '--format', '{{index .RepoDigests 0}}', image],
    { encoding: 'utf8' },
  ).trim();
  return digest || image;
}

/** Fetch `url` into downloadsDir(), streaming; a completed download is reused. */
async function downloadCached(url: string): Promise<string> {
  const dest = join(downloadsDir(), basename(new URL(url).pathname));
  if (existsSync(dest)) return dest;
  mkdirSync(downloadsDir(), { recursive: true });
  const res = await fetch(url);
  if (!res.ok || res.body === null) {
    throw new Error(`download failed (${res.status} ${res.statusText}): ${url}`);
  }
  // .partial + rename so an interrupted download never poses as cached.
  const partial = `${dest}.partial`;
  await pipeline(Readable.fromWeb(res.body as import('node:stream/web').ReadableStream), createWriteStream(partial));
  renameSync(partial, dest);
  return dest;
}

function resolveCodexBin(codexBin: string): string {
  if (codexBin !== 'auto') return codexBin;
  // bash -lc: codex is commonly installed via nvm/npm prefixes that only login
  // shells put on PATH; readlink -f follows the npm bin symlink to the binary.
  const out = execFileSync('bash', ['-lc', 'readlink -f "$(command -v codex)"'], { encoding: 'utf8' }).trim();
  if (!out) {
    throw new Error('could not resolve a codex binary (`command -v codex` came up empty) — set toolchain.codexBin to an explicit path');
  }
  return out;
}

/** Run scripts/build-release.mjs and return the ultracode-<version>/ stage dir. */
function buildReleaseStage(): string {
  const wtRoot = resolve(BENCH_ROOT, '..');
  const stageOut = join(cacheDir(), 'release-stage');
  try {
    execFileSync(process.execPath, ['scripts/build-release.mjs', '.', stageOut], { cwd: wtRoot });
  } catch (err) {
    const stderr = (err as { stderr?: Buffer }).stderr?.toString().trim() ?? '';
    throw new Error(`scripts/build-release.mjs failed:\n${stderr || String(err)}`);
  }
  const dirs = readdirSync(stageOut, { withFileTypes: true })
    .filter((e) => e.isDirectory() && e.name.startsWith('ultracode-'))
    .map((e) => e.name);
  if (dirs.length !== 1) {
    throw new Error(`expected exactly one ultracode-<version>/ dir under ${stageOut}, found: ${dirs.join(', ') || '(none)'}`);
  }
  return join(stageOut, dirs[0]!);
}

/**
 * Rebuild the toolchain dir from scratch (cached node tarballs are reused):
 * node runtime, codex binary, ultracode release stage, per-arm codex homes,
 * entrypoint.sh, and a manifest.json recording versions + hashes.
 */
export async function prepareToolchain(cfg: BenchConfig): Promise<void> {
  const dir = toolchainDir();
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });

  const { nodeVersion, nodeDist } = cfg.toolchain;
  const nodeTar = await downloadCached(nodeTarballUrl(nodeVersion, nodeDist));
  const nodeDir = join(dir, 'node');
  mkdirSync(nodeDir);
  execFileSync('tar', ['-xJf', nodeTar, '-C', nodeDir, '--strip-components=1']);
  const muslTar = await downloadCached(nodeMuslTarballUrl(nodeVersion, nodeDist));
  const muslDir = join(dir, 'node-musl');
  mkdirSync(muslDir);
  execFileSync('tar', ['-xJf', muslTar, '-C', muslDir, '--strip-components=1']);
  const nodeMuslRuntime = prepareNodeMuslRuntime(dir, nodeVersion);
  writeFileSync(join(dir, 'node-sel'), NODE_SEL, 'utf8');
  chmodSync(join(dir, 'node-sel'), 0o755);

  const codexSrc = resolveCodexBin(cfg.toolchain.codexBin);
  const codexBin = join(dir, 'codex');
  copyFileSync(codexSrc, codexBin);
  chmodSync(codexBin, 0o755);
  const codexVersion = execFileSync(codexBin, ['--version'], { encoding: 'utf8' }).trim();
  const codexSha256 = createHash('sha256').update(readFileSync(codexBin)).digest('hex');

  const stage = buildReleaseStage();
  cpSync(stage, join(dir, 'ultracode'), { recursive: true });
  const ultracodeVersion = (JSON.parse(readFileSync(join(stage, 'package.json'), 'utf8')) as { version: string }).version;

  const homeA = join(dir, 'codex-home-a');
  mkdirSync(homeA);
  writeFileSync(
    join(homeA, 'config.toml'),
    '# ultracode SWE-bench Pro A/B bench — arm a codex home\n[tools]\nweb_search = false\n',
    'utf8',
  );

  const tmpHome = mkdtempSync(join(tmpdir(), 'uc-bench-home-'));
  try {
    const { installForHost } = await import('../../src/installer/install.js');
    installForHost('codex', {
      userHome: tmpHome,
      mcpCommand: ['/opt/bench/node-sel', '/opt/bench/ultracode/dist/cli/main.js', 'mcp'],
    });
    const homeB = join(dir, 'codex-home-b');
    const agentsHomeB = join(dir, 'agents-home-b');
    cpSync(join(tmpHome, '.codex'), homeB, { recursive: true });
    cpSync(join(tmpHome, '.agents'), agentsHomeB, { recursive: true });
    // NOTE: entrypoint.sh later prepends model keys and appends the
    // [mcp_servers.ultracode.env] table; top-level keys stay ahead of tables
    // because the installer's MCP block is the only table until this one.
    appendFileSync(join(homeB, 'config.toml'), '\n[tools]\nweb_search = false\n', 'utf8');
    const configB = readFileSync(join(homeB, 'config.toml'), 'utf8');
    if (!configB.includes('mcp_servers.ultracode') || !configB.includes('default_tools_approval_mode')) {
      throw new Error(`installer did not register the ultracode MCP server in ${join(homeB, 'config.toml')} — check src/installer/install.ts output`);
    }
    const skillMd = join(agentsHomeB, 'skills/ultracode/SKILL.md');
    if (!existsSync(skillMd)) {
      throw new Error(`installer did not stage the ultracode skill at ${skillMd}`);
    }
  } finally {
    rmSync(tmpHome, { recursive: true, force: true });
  }

  const entrypoint = join(dir, 'entrypoint.sh');
  copyFileSync(join(BENCH_ROOT, 'entrypoint.sh'), entrypoint);
  chmodSync(entrypoint, 0o755);

  const manifest: ToolchainManifest = {
    nodeVersion,
    nodeDist,
    nodeMuslRuntime,
    codexVersion,
    codexSha256,
    ultracodeVersion,
    builtAt: new Date().toISOString(),
  };
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf8');
}

/** Provenance for run.json; throws when the toolchain has not been prepared. */
export function toolchainInfo(): { codexVersion: string; codexSha256: string; ultracodeVersion: string } {
  const file = join(toolchainDir(), 'manifest.json');
  if (!existsSync(file)) {
    throw new Error(`toolchain manifest missing at ${file} — run the bench prep step (prepareToolchain) before starting a run`);
  }
  const m = JSON.parse(readFileSync(file, 'utf8')) as ToolchainManifest;
  return { codexVersion: m.codexVersion, codexSha256: m.codexSha256, ultracodeVersion: m.ultracodeVersion };
}
