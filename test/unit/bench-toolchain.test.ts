/** Shared benchmark toolchain resolution diagnostics. */
import { chmodSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  dockerPullDigest,
  downloadCacheFilename,
  resolveCodexBin,
} from '../../bench/src/shared/toolchain.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('Codex toolchain resolution', () => {
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
