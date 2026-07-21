/**
 * Shared toolchain prep assembles an immutable container build context from a
 * overlay Dockerfile bakes into /opt/bench — from a pinned Node tarball, the
 * host codex binary, a fresh ultracode release stage, and pre-built codex
 * homes for both arms. Suite adapters layer their native runner assets on this
 * shared base. The stage keeps the dist/cli/main.js shape because the
 * detached runner re-invokes itself via that path (src/exec/daemonize.ts) and
 * resolves skill/, workflows/, hostpacks/ relative to it. prepareToolchain()
 * publishes content-addressed inputs and surfaces their v2 provenance.
 */
import { createHash, randomBytes } from 'node:crypto';
import {
  appendFileSync,
  chmodSync,
  closeSync,
  constants,
  cpSync,
  createWriteStream,
  existsSync,
  fstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { z } from 'zod';
import type { BenchPathRoots } from './contracts.js';
import type { ToolchainConfig } from './config.js';
import { ensureRealDirectoryWithin, readRegularFileWithinRoot } from './paths.js';
import { runBenchProcess } from './process.js';
import {
  sha256Buffer,
  sha256CanonicalJson,
  sha256File,
  sha256Tree,
  type ToolchainProvenance,
} from './provenance.js';

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const toolchainContentManifestSchema = z.strictObject({
  schemaVersion: z.literal(2),
  kind: z.literal('ultracode-benchmark-toolchain'),
  payloadSha256: sha256Schema,
  nodeVersion: z.string().regex(/^v?\d+\.\d+\.\d+$/),
  nodeDistribution: z.enum(['npmmirror', 'nodejs', 'unofficial-glibc217']),
  nodeArchiveSha256: sha256Schema,
  nodeChecksumManifestSha256: sha256Schema,
  nodeTreeSha256: sha256Schema,
  nodeMuslArchiveSha256: sha256Schema,
  nodeMuslChecksumManifestSha256: sha256Schema,
  nodeMuslTreeSha256: sha256Schema,
  nodeMuslRuntime: z.string().regex(/^.+@sha256:[a-f0-9]{64}$/),
  codexVersion: z.string().min(1),
  codexSha256: sha256Schema,
  ultracodeVersion: z.string().min(1),
  ultracodeRevision: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/),
  ultracodeReleaseSha256: sha256Schema,
  ultracodeTreeSha256: sha256Schema,
});

type ToolchainContentManifest = z.infer<typeof toolchainContentManifestSchema>;

/** Bind every attested metadata field together with the payload digest. */
export function toolchainCacheKey(manifest: unknown): string {
  return sha256CanonicalJson(toolchainContentManifestSchema.parse(manifest));
}

export interface PreparedToolchain {
  directory: string;
  provenance: ToolchainProvenance;
  ultracodeVersion: string;
}

const NODE_MUSL_RUNTIME_ALPINE = '3.20';
const MAX_CHECKSUM_MANIFEST_BYTES = 1_024 * 1_024;
const MAX_NODE_ARCHIVE_BYTES = 512 * 1_024 * 1_024;

async function toolchainCommand(
  command: string,
  argv: readonly string[],
  cwd: string,
): Promise<string> {
  return (await runBenchProcess(command, argv, {
    cwd,
    tailBytes: 8 * 1_024 * 1_024,
  })).stdout.trim();
}

/** Bind a mutable pull request to the immutable digest reported by that pull. */
export function dockerPullDigest(image: string, output: string): string {
  const digests = [...output.matchAll(/^Digest:\s*(sha256:[a-f0-9]{64})\s*$/gmu)]
    .map((match) => match[1]!);
  const unique = [...new Set(digests)];
  const lastSlash = image.lastIndexOf('/');
  const tag = image.lastIndexOf(':');
  if (unique.length !== 1 || tag <= lastSlash || image.includes('@')) {
    throw new Error(`Docker pull did not report one immutable digest for ${image}`);
  }
  return `${image.slice(0, tag)}@${unique[0]}`;
}

function nodeTarballUrl(version: string, dist: ToolchainConfig['nodeDistribution']): string {
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
function nodeMuslTarballUrl(version: string, dist: ToolchainConfig['nodeDistribution']): string {
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
async function prepareNodeMuslRuntime(dir: string, nodeVersion: string): Promise<string> {
  const image = `node:${nodeVersion}-alpine${NODE_MUSL_RUNTIME_ALPINE}`;
  const pullOutput = await toolchainCommand('docker', ['pull', image], dir);
  const digest = dockerPullDigest(image, pullOutput);
  const imageId = await toolchainCommand(
    'docker',
    ['image', 'inspect', '--format', '{{.Id}}', digest],
    dir,
  );
  if (!/^sha256:[a-f0-9]{64}$/.test(imageId)) {
    throw new Error(`Docker returned an invalid immutable image id for ${digest}`);
  }
  const container = await toolchainCommand('docker', [
    'create',
    '--label', 'ultracode.benchmark.schema=2',
    '--label', 'ultracode.benchmark.suite=shared-toolchain',
    '--label', 'ultracode.benchmark.purpose=musl-runtime',
    '--label', 'ultracode.benchmark.ownership=1',
    digest,
  ], dir);
  if (!/^[a-f0-9]{64}$/.test(container)) throw new Error('Docker returned an invalid toolchain container id');
  const runtimeDir = join(dir, 'node-musl-runtime');
  mkdirSync(runtimeDir);
  try {
    const containerImageId = await toolchainCommand(
      'docker',
      ['container', 'inspect', '--format', '{{.Image}}', container],
      dir,
    );
    if (containerImageId !== imageId) {
      throw new Error(`Docker container image identity drifted before runtime extraction: ${container}`);
    }
    await toolchainCommand('docker', [
      'cp',
      '-L',
      `${container}:/usr/lib/libstdc++.so.6`,
      join(runtimeDir, 'libstdc++.so.6'),
    ], dir);
    await toolchainCommand('docker', [
      'cp',
      '-L',
      `${container}:/usr/lib/libgcc_s.so.1`,
      join(runtimeDir, 'libgcc_s.so.1'),
    ], dir);
  } finally {
    await toolchainCommand('docker', ['rm', '-f', container], dir);
  }
  return digest;
}

interface PublishedArchiveChecksum {
  archiveSha256: string;
  checksumManifestSha256: string;
}

/** Parse one exact filename from a published Node checksum manifest. */
export function parsePublishedArchiveChecksum(
  bytes: Uint8Array,
  filename: string,
): PublishedArchiveChecksum {
  if (bytes.byteLength === 0 || bytes.byteLength > 1_024 * 1_024) {
    throw new Error('published checksum manifest has an unsafe size');
  }
  const buffer = Buffer.from(bytes);
  const matches = buffer.toString('utf8').split(/\r?\n/u).flatMap((line) => {
    const match = /^([a-f0-9]{64})\s+\*?(.+)$/u.exec(line);
    return match?.[2] === filename ? [match[1]!] : [];
  });
  if (matches.length !== 1) throw new Error(`published checksum does not uniquely bind ${filename}`);
  return {
    archiveSha256: matches[0]!,
    checksumManifestSha256: sha256Buffer(buffer),
  };
}

function boundedResponseBody(response: Response, maximumBytes: number, description: string): Readable {
  if (response.body === null) throw new Error(`${description} response had no body`);
  const declared = response.headers.get('content-length');
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > maximumBytes)) {
    throw new Error(`${description} response declared an unsafe size`);
  }
  const source = Readable.fromWeb(response.body as import('node:stream/web').ReadableStream);
  let observed = 0;
  return Readable.from((async function* boundedChunks() {
    for await (const value of source) {
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value as Uint8Array);
      observed += chunk.byteLength;
      if (observed > maximumBytes) throw new Error(`${description} response exceeded its size limit`);
      yield chunk;
    }
  })());
}

async function boundedResponseBuffer(response: Response, maximumBytes: number, description: string): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of boundedResponseBody(response, maximumBytes, description)) {
    chunks.push(Buffer.from(chunk as Uint8Array));
  }
  return Buffer.concat(chunks);
}

async function publishedArchiveChecksum(
  version: string,
  filename: string,
  source: 'nodejs' | 'unofficial',
): Promise<PublishedArchiveChecksum> {
  const base = source === 'nodejs'
    ? 'https://nodejs.org/dist'
    : 'https://unofficial-builds.nodejs.org/download/release';
  const url = `${base}/v${version}/SHASUMS256.txt`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`published checksum fetch failed (${response.status}): ${url}`);
  const bytes = await boundedResponseBuffer(response, MAX_CHECKSUM_MANIFEST_BYTES, 'published checksum');
  return parsePublishedArchiveChecksum(bytes, filename);
}

/** Namespace cached archives by their immutable published digest. */
export function downloadCacheFilename(url: string, expectedSha256: string): string {
  return `${sha256Schema.parse(expectedSha256)}-${basename(new URL(url).pathname)}`;
}

/** Fetch one published-checksum-bound archive into the private download cache. */
async function downloadCached(
  url: string,
  expectedSha256: string,
  roots: BenchPathRoots,
): Promise<string> {
  const directory = ensureRealDirectoryWithin(roots.cacheRoot, join(roots.cacheRoot, 'downloads'));
  const dest = join(directory, downloadCacheFilename(url, expectedSha256));
  if (existsSync(dest)) {
    if (sha256File(dest) !== expectedSha256) throw new Error(`cached download checksum drifted: ${dest}`);
    return dest;
  }
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`download failed (${res.status} ${res.statusText}): ${url}`);
  }
  // .partial + rename so an interrupted download never poses as cached.
  const partial = join(directory, `.${basename(dest)}.${process.pid}.${randomBytes(12).toString('hex')}.partial`);
  try {
    await pipeline(
      boundedResponseBody(res, MAX_NODE_ARCHIVE_BYTES, 'Node archive'),
      createWriteStream(partial, { flags: 'wx', mode: 0o600 }),
    );
    if (sha256File(partial) !== expectedSha256) throw new Error(`download checksum mismatch: ${url}`);
    renameSync(partial, dest);
  } catch (error) {
    rmSync(partial, { force: true });
    throw error;
  }
  return dest;
}

/** Resolve an explicit Codex path or discover the login-shell installation. */
export async function resolveCodexBin(codexBin: string, cwd: string): Promise<string> {
  if (codexBin !== 'auto') return resolve(cwd, codexBin);
  const marker = `__ULTRACODE_CODEX_PATH_${randomBytes(16).toString('hex')}__`;
  // bash -lc: codex is commonly installed via nvm/npm prefixes that only login
  // shells put on PATH. The marker ignores profile banners and other stdout.
  const out = await toolchainCommand(
    'bash',
    ['-lc', `codex_path="$(command -v codex)" || codex_path=''; printf '\\n${marker}%s\\n' "$codex_path"`],
    cwd,
  );
  const marked = out.split('\n').filter((line) => line.startsWith(marker));
  if (marked.length !== 1 || marked[0]!.slice(marker.length).length === 0) {
    throw new Error('could not resolve a codex binary (`command -v codex` came up empty) — set toolchain.codexBinary to an explicit path');
  }
  return realpathSync(marked[0]!.slice(marker.length));
}

function readStableExecutable(path: string): Buffer {
  const nofollow = constants.O_NOFOLLOW ?? 0;
  const fd = openSync(path, constants.O_RDONLY | nofollow);
  try {
    const before = fstatSync(fd);
    if (!before.isFile() || before.nlink !== 1 || before.size === 0 || before.size > 512 * 1_024 * 1_024
      || (before.mode & 0o111) === 0) {
      throw new Error('Codex binary must be one bounded singly-linked executable file');
    }
    const bytes = readFileSync(fd);
    const after = fstatSync(fd);
    if (after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size
      || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs || after.nlink !== 1) {
      throw new Error('Codex binary changed while being staged');
    }
    return bytes;
  } finally {
    closeSync(fd);
  }
}

/** Require the standalone Linux-x64 ELF format used inside benchmark containers. */
export function validateLinuxX64CodexExecutable(bytes: Uint8Array): void {
  const buffer = Buffer.from(bytes);
  if (buffer.length < 20
    || buffer[0] !== 0x7f
    || buffer.subarray(1, 4).toString('ascii') !== 'ELF'
    || buffer[4] !== 2
    || buffer[5] !== 1
    || buffer.readUInt16LE(18) !== 62) {
    throw new Error('Codex binary must be a standalone Linux-x64 ELF executable');
  }
}

/** Copy and authenticate one cache archive through an already-open source inode. */
export function stageVerifiedArchive(source: string, destination: string, expectedSha256: string): string {
  const nofollow = constants.O_NOFOLLOW ?? 0;
  const sourceFd = openSync(source, constants.O_RDONLY | nofollow);
  let destinationFd: number | undefined;
  let complete = false;
  try {
    const stat = fstatSync(sourceFd);
    if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_NODE_ARCHIVE_BYTES) {
      throw new Error('cached Node archive must be one bounded regular file');
    }
    destinationFd = openSync(
      destination,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | nofollow,
      0o600,
    );
    const hash = createHash('sha256');
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let total = 0;
    for (;;) {
      const bytesRead = readSync(sourceFd, buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      total += bytesRead;
      hash.update(buffer.subarray(0, bytesRead));
      let written = 0;
      while (written < bytesRead) {
        written += writeSync(destinationFd, buffer, written, bytesRead - written);
      }
    }
    if (total !== stat.size || hash.digest('hex') !== sha256Schema.parse(expectedSha256)) {
      throw new Error(`cached download checksum drifted while staging: ${source}`);
    }
    complete = true;
    return destination;
  } finally {
    if (destinationFd !== undefined) closeSync(destinationFd);
    closeSync(sourceFd);
    if (!complete) rmSync(destination, { force: true });
  }
}

/** Run scripts/build-release.mjs and return its exact stage and release archive. */
async function buildReleaseStage(
  roots: BenchPathRoots,
  stageOut: string,
): Promise<{ directory: string; archive: string }> {
  const wtRoot = resolve(roots.benchRoot, '..');
  await toolchainCommand(process.execPath, ['scripts/build-release.mjs', '.', stageOut], wtRoot);
  const dirs = readdirSync(stageOut, { withFileTypes: true })
    .filter((e) => e.isDirectory() && e.name.startsWith('ultracode-'))
    .map((e) => e.name);
  if (dirs.length !== 1) {
    throw new Error(`expected exactly one ultracode-<version>/ dir under ${stageOut}, found: ${dirs.join(', ') || '(none)'}`);
  }
  const directory = join(stageOut, dirs[0]!);
  const archive = join(stageOut, `${dirs[0]!}.tar.gz`);
  if (!existsSync(archive)) throw new Error(`release archive is missing: ${archive}`);
  return { directory, archive };
}

/**
 * Rebuild the toolchain dir from scratch (cached node tarballs are reused):
 * node runtime, codex binary, ultracode release stage, per-arm codex homes,
 * and a manifest.json recording versions + hashes.
 */
async function populateSharedToolchain(
  config: ToolchainConfig,
  roots: BenchPathRoots,
  toolchains: string,
  dir: string,
): Promise<PreparedToolchain> {
  const { nodeVersion, nodeDistribution } = config;
  const normalizedNodeVersion = nodeVersion.replace(/^v/, '');
  const nodeUrl = nodeTarballUrl(normalizedNodeVersion, nodeDistribution);
  const nodeChecksum = await publishedArchiveChecksum(
    normalizedNodeVersion,
    basename(new URL(nodeUrl).pathname),
    nodeDistribution === 'unofficial-glibc217' ? 'unofficial' : 'nodejs',
  );
  const nodeTar = await downloadCached(nodeUrl, nodeChecksum.archiveSha256, roots);
  const stagedNodeTar = stageVerifiedArchive(
    nodeTar,
    join(dir, 'node-archive.tar.xz'),
    nodeChecksum.archiveSha256,
  );
  const nodeDir = join(dir, 'node');
  mkdirSync(nodeDir);
  try {
    await toolchainCommand('tar', ['-xJf', stagedNodeTar, '-C', nodeDir, '--strip-components=1'], dir);
  } finally {
    rmSync(stagedNodeTar, { force: true });
  }
  const muslUrl = nodeMuslTarballUrl(normalizedNodeVersion, nodeDistribution);
  const muslChecksum = await publishedArchiveChecksum(
    normalizedNodeVersion,
    basename(new URL(muslUrl).pathname),
    'unofficial',
  );
  const muslTar = await downloadCached(muslUrl, muslChecksum.archiveSha256, roots);
  const stagedMuslTar = stageVerifiedArchive(
    muslTar,
    join(dir, 'node-musl-archive.tar.xz'),
    muslChecksum.archiveSha256,
  );
  const muslDir = join(dir, 'node-musl');
  mkdirSync(muslDir);
  try {
    await toolchainCommand('tar', ['-xJf', stagedMuslTar, '-C', muslDir, '--strip-components=1'], dir);
  } finally {
    rmSync(stagedMuslTar, { force: true });
  }
  const nodeMuslRuntime = await prepareNodeMuslRuntime(dir, nodeVersion.replace(/^v/, ''));
  writeFileSync(join(dir, 'node-sel'), NODE_SEL, 'utf8');
  chmodSync(join(dir, 'node-sel'), 0o755);

  const codexSrc = await resolveCodexBin(config.codexBinary, roots.benchRoot);
  const codexBin = join(dir, 'codex');
  const codexBytes = readStableExecutable(codexSrc);
  validateLinuxX64CodexExecutable(codexBytes);
  writeFileSync(codexBin, codexBytes, { flag: 'wx', mode: 0o755 });
  const codexVersion = await toolchainCommand(codexBin, ['--version'], dir);
  const codexSha256 = createHash('sha256').update(codexBytes).digest('hex');

  const releaseStage = join(dir, 'release-stage');
  const release = await buildReleaseStage(roots, releaseStage);
  const releaseArchive = join(dir, 'ultracode-release.tar.gz');
  let ultracodeVersion: string;
  try {
    cpSync(release.directory, join(dir, 'ultracode'), { recursive: true });
    cpSync(release.archive, releaseArchive);
    chmodSync(releaseArchive, 0o600);
    ultracodeVersion = (JSON.parse(readFileSync(join(release.directory, 'package.json'), 'utf8')) as {
      version: string;
    }).version;
  } finally {
    rmSync(releaseStage, { recursive: true, force: true });
  }

  const homeA = join(dir, 'codex-home-a');
  mkdirSync(homeA);
  writeFileSync(
    join(homeA, 'config.toml'),
    '# ultracode benchmark — arm a codex home\n[tools]\nweb_search = false\n',
    'utf8',
  );

  const tmpHome = mkdtempSync(join(tmpdir(), 'uc-bench-home-'));
  try {
    const { installForHost } = await import('../../../src/installer/install.js');
    installForHost('codex', {
      userHome: tmpHome,
      mcpCommand: ['/opt/bench/node-sel', '/opt/bench/ultracode/dist/cli/main.js', 'mcp'],
    });
    const homeB = join(dir, 'codex-home-b');
    const agentsHomeB = join(dir, 'agents-home-b');
    cpSync(join(tmpHome, '.codex'), homeB, { recursive: true });
    cpSync(join(tmpHome, '.agents'), agentsHomeB, { recursive: true });
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

  const ultracodeRevision = await toolchainCommand('git', ['rev-parse', 'HEAD'], resolve(roots.benchRoot, '..'));
  const payloadSha256 = sha256Tree(dir);
  const manifest: ToolchainContentManifest = {
    schemaVersion: 2,
    kind: 'ultracode-benchmark-toolchain',
    payloadSha256,
    nodeVersion,
    nodeDistribution,
    nodeArchiveSha256: nodeChecksum.archiveSha256,
    nodeChecksumManifestSha256: nodeChecksum.checksumManifestSha256,
    nodeTreeSha256: sha256Tree(nodeDir),
    nodeMuslArchiveSha256: muslChecksum.archiveSha256,
    nodeMuslChecksumManifestSha256: muslChecksum.checksumManifestSha256,
    nodeMuslTreeSha256: sha256Tree(muslDir),
    nodeMuslRuntime,
    codexVersion,
    codexSha256,
    ultracodeVersion,
    ultracodeRevision,
    ultracodeReleaseSha256: sha256File(releaseArchive),
    ultracodeTreeSha256: sha256Tree(join(dir, 'ultracode')),
  };
  writeFileSync(join(dir, 'content-manifest.json'), JSON.stringify(manifest, null, 2) + '\n', { mode: 0o600 });
  const target = join(toolchains, toolchainCacheKey(manifest));
  if (existsSync(target)) {
    rmSync(dir, { recursive: true, force: true });
  } else {
    try {
      renameSync(dir, target);
    } catch (error) {
      if (!existsSync(target)) throw error;
      rmSync(dir, { recursive: true, force: true });
    }
  }
  return loadPreparedToolchain(target);
}

/** Publish a fresh immutable toolchain, removing incomplete staging on failure. */
export async function prepareSharedToolchain(
  config: ToolchainConfig,
  roots: BenchPathRoots,
): Promise<PreparedToolchain> {
  const toolchains = ensureRealDirectoryWithin(roots.cacheRoot, join(roots.cacheRoot, 'toolchains'));
  const dir = join(toolchains, `.stage-${process.pid}-${randomBytes(12).toString('hex')}`);
  mkdirSync(dir, { mode: 0o700 });
  try {
    return await populateSharedToolchain(config, roots, toolchains, dir);
  } catch (error) {
    rmSync(dir, { recursive: true, force: true });
    throw error;
  }
}

/** Load and re-attest one immutable published toolchain. */
export function loadPreparedToolchain(directory: string): PreparedToolchain {
  const file = join(directory, 'content-manifest.json');
  if (!existsSync(file)) throw new Error(`prepared toolchain manifest is missing: ${file}`);
  const payloadSha256 = sha256Tree(directory, { exclude: ['content-manifest.json'] });
  const manifest = toolchainContentManifestSchema.parse(JSON.parse(readRegularFileWithinRoot(
    directory,
    'content-manifest.json',
    1_024 * 1_024,
  ).toString('utf8')) as unknown);
  if (payloadSha256 !== manifest.payloadSha256
    || resolve(directory) !== resolve(directory, '..', toolchainCacheKey(manifest))) {
    throw new Error('prepared toolchain payload identity drifted');
  }
  if (sha256File(join(directory, 'codex')) !== manifest.codexSha256
    || sha256Tree(join(directory, 'node')) !== manifest.nodeTreeSha256
    || sha256Tree(join(directory, 'node-musl')) !== manifest.nodeMuslTreeSha256
    || sha256File(join(directory, 'ultracode-release.tar.gz')) !== manifest.ultracodeReleaseSha256
    || sha256Tree(join(directory, 'ultracode')) !== manifest.ultracodeTreeSha256) {
    throw new Error('prepared toolchain contents drifted');
  }
  return {
    directory,
    ultracodeVersion: manifest.ultracodeVersion,
    provenance: {
      payloadSha256,
      manifestSha256: sha256File(file),
      treeSha256: sha256Tree(directory),
      node: {
        version: manifest.nodeVersion,
        platform: 'linux-x64',
        archiveSha256: manifest.nodeArchiveSha256,
        checksumManifestSha256: manifest.nodeChecksumManifestSha256,
        treeSha256: manifest.nodeTreeSha256,
        muslArchiveSha256: manifest.nodeMuslArchiveSha256,
        muslChecksumManifestSha256: manifest.nodeMuslChecksumManifestSha256,
        muslTreeSha256: manifest.nodeMuslTreeSha256,
        muslRuntimeImageDigest: manifest.nodeMuslRuntime,
      },
      codex: { version: manifest.codexVersion, binarySha256: manifest.codexSha256 },
      ultracode: {
        revision: manifest.ultracodeRevision,
        releaseSha256: manifest.ultracodeReleaseSha256,
        treeSha256: manifest.ultracodeTreeSha256,
      },
    },
  };
}
