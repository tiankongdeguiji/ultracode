/** Shared benchmark toolchain resolution diagnostics. */
import { chmodSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveCodexBin } from '../../bench/src/shared/toolchain.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('Codex toolchain resolution', () => {
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
