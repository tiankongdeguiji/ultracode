/** Shared benchmark toolchain resolution diagnostics. */
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createBenchPathRoots } from '../../bench/src/shared/paths.js';
import { sha256Tree } from '../../bench/src/shared/provenance.js';
import {
  dockerPullDigest,
  downloadCacheFilename,
  resolveCodexBin,
  stageToolchainNativeAssets,
  stageVerifiedArchive,
  toolchainCacheKey,
  validateLinuxX64CodexExecutable,
} from '../../bench/src/shared/toolchain.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('Codex toolchain resolution', () => {
  it('accepts only standalone Linux-x64 Codex bytes', () => {
    const elf = Buffer.alloc(20);
    elf.set([0x7f, 0x45, 0x4c, 0x46, 2, 1]);
    elf.writeUInt16LE(62, 18);
    expect(() => validateLinuxX64CodexExecutable(elf)).not.toThrow();
    expect(() => validateLinuxX64CodexExecutable(Buffer.from('#!/usr/bin/env node\n'))).toThrow(
      /Linux-x64 ELF/u,
    );
    elf.writeUInt16LE(183, 18);
    expect(() => validateLinuxX64CodexExecutable(elf)).toThrow(/Linux-x64 ELF/u);
  });

  it('binds provenance metadata into the published cache identity', () => {
    const hash = 'a'.repeat(64);
    const manifest = {
      schemaVersion: 2,
      kind: 'ultracode-benchmark-toolchain',
      payloadSha256: hash,
      nodeVersion: '22.0.0',
      nodeDistribution: 'nodejs',
      nodeArchiveSha256: hash,
      nodeChecksumManifestSha256: hash,
      nodeTreeSha256: hash,
      nodeMuslArchiveSha256: hash,
      nodeMuslChecksumManifestSha256: hash,
      nodeMuslTreeSha256: hash,
      nodeMuslRuntime: `node@sha256:${hash}`,
      codexVersion: 'codex 1.0.0',
      codexSha256: hash,
      ultracodeVersion: '0.2.1',
      ultracodeRevision: 'b'.repeat(40),
      ultracodeReleaseSha256: hash,
      ultracodeTreeSha256: hash,
    };
    expect(toolchainCacheKey(manifest)).not.toBe(toolchainCacheKey({
      ...manifest,
      codexVersion: 'codex forged',
    }));
  });

  it('stages only checksum-bound bytes from an open cache inode', () => {
    const root = mkdtempSync(join(tmpdir(), 'uc-toolchain-archive-'));
    roots.push(root);
    const source = join(root, 'cached.tar.xz');
    const destination = join(root, 'private.tar.xz');
    const bytes = Buffer.from('archive bytes');
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    writeFileSync(source, bytes);

    expect(stageVerifiedArchive(source, destination, sha256)).toBe(destination);
    expect(readFileSync(destination)).toEqual(bytes);
    expect(() => stageVerifiedArchive(source, join(root, 'bad.tar.xz'), '0'.repeat(64))).toThrow(
      /checksum drifted/u,
    );
    expect(existsSync(join(root, 'bad.tar.xz'))).toBe(false);
  });

  it('stages suite-native Docker assets inside the payload-hashed build context', () => {
    const root = mkdtempSync(join(tmpdir(), 'uc-toolchain-assets-'));
    roots.push(root);
    const buildContext = join(root, 'build-context');
    const suite = join(root, 'suites/example');
    mkdirSync(buildContext, { mode: 0o700 });
    mkdirSync(suite, { recursive: true });
    writeFileSync(join(suite, 'entrypoint.sh'), '#!/bin/sh\nexit 0\n');

    const before = sha256Tree(buildContext);
    stageToolchainNativeAssets(createBenchPathRoots(root), buildContext, [{
      source: 'suites/example/entrypoint.sh',
      destination: 'entrypoint.sh',
    }]);

    expect(readFileSync(join(buildContext, 'entrypoint.sh'), 'utf8')).toBe('#!/bin/sh\nexit 0\n');
    expect(statSync(join(buildContext, 'entrypoint.sh')).mode & 0o777).toBe(0o500);
    expect(sha256Tree(buildContext)).not.toBe(before);
    expect(() => stageToolchainNativeAssets(createBenchPathRoots(root), buildContext, [{
      source: 'suites/example/entrypoint.sh',
      destination: '../escape.sh',
    }])).toThrow(/invalid or duplicate/);
  });

  it('uses the immutable digest reported by the exact Docker pull', () => {
    const digest = `sha256:${'a'.repeat(64)}`;
    expect(dockerPullDigest(
      'registry.example:5000/node:22-alpine3.20',
      `22-alpine3.20: Pulling from node\nDigest: ${digest}\nStatus: Downloaded newer image`,
    )).toBe(`registry.example:5000/node@${digest}`);
    expect(() => dockerPullDigest('node:22-alpine3.20', 'Status: Image is up to date')).toThrow(
      /did not report one immutable digest/u,
    );
  });

  it('names same-basename downloads by their immutable digest', () => {
    const official = downloadCacheFilename(
      'https://nodejs.org/dist/v22.0.0/node-v22.0.0-linux-x64.tar.xz',
      'a'.repeat(64),
    );
    const unofficial = downloadCacheFilename(
      'https://unofficial-builds.nodejs.org/download/release/v22.0.0/node-v22.0.0-linux-x64.tar.xz',
      'b'.repeat(64),
    );
    expect(official).not.toBe(unofficial);
    expect(official).toBe(`${'a'.repeat(64)}-node-v22.0.0-linux-x64.tar.xz`);
  });

  it('reaches the schema-valid custom diagnostic when login-shell lookup is empty', async () => {
    const root = mkdtempSync(join(tmpdir(), 'uc-codex-resolution-'));
    roots.push(root);
    const bash = join(root, 'bash');
    writeFileSync(bash, '#!/bin/sh\nexec /bin/bash --noprofile --norc -c "$2"\n');
    chmodSync(bash, 0o700);
    const previousPath = process.env.PATH;
    process.env.PATH = root;
    try {
      await expect(resolveCodexBin('auto', root)).rejects.toThrow(
        /command -v codex.*toolchain\.codexBinary/u,
      );
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
    }
  });

  it('ignores login-profile banners and canonicalizes a discovered symlink with Node', async () => {
    const root = mkdtempSync(join(tmpdir(), 'uc-codex-resolution-'));
    roots.push(root);
    const bash = join(root, 'bash');
    const executable = join(root, 'codex-real');
    writeFileSync(bash, '#!/bin/sh\nprintf "profile banner\\n"\nexec /bin/bash --noprofile --norc -c "$2"\n');
    writeFileSync(executable, '#!/bin/sh\nexit 0\n');
    chmodSync(bash, 0o700);
    chmodSync(executable, 0o700);
    symlinkSync(executable, join(root, 'codex'));
    const previousPath = process.env.PATH;
    process.env.PATH = root;
    try {
      await expect(resolveCodexBin('auto', root)).resolves.toBe(realpathSync(executable));
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
    }
  });
});
