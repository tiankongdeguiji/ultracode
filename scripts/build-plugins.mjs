#!/usr/bin/env node
// Assemble the fully generated dist-codex / dist-qoder plugin bundles from
// canonical sources (skill/, workflows/, hostpacks/); manifest versions are
// stamped from package.json. Marketplace distribution is deferred
// (internal-first); `ultracode install` is the supported path.
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertSemver } from './semver.mjs';

// Optional argv override of the root used for BOTH reading canonical sources
// and writing the dist-* outputs (exists for tests); default is the repo root.
const root = process.argv[2] ? resolve(process.argv[2]) : join(dirname(fileURLToPath(import.meta.url)), '..');
const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
// A malformed version would ship in both manifests — validate before stamping.
assertSemver(version);
const copy = (from, to) => {
  mkdirSync(dirname(to), { recursive: true });
  cpSync(join(root, from), to, { recursive: true, force: true });
};
const manifest = (from, to) => {
  const template = JSON.parse(readFileSync(join(root, from), 'utf8'));
  mkdirSync(dirname(to), { recursive: true });
  writeFileSync(to, JSON.stringify({ ...template, version }, null, 2) + '\n');
};

// Codex: skill only (MCP registration + AGENTS.md are written by the installer).
rmSync(join(root, 'dist-codex'), { recursive: true, force: true });
copy('skill/ultracode', join(root, 'dist-codex/skills/ultracode'));
copy('hostpacks/codex/README.md', join(root, 'dist-codex/README.md'));
manifest('hostpacks/codex/plugin.json', join(root, 'dist-codex/.codex-plugin/plugin.json'));

// Qoder: skill + uc-* templates + effort-routing agents.
rmSync(join(root, 'dist-qoder'), { recursive: true, force: true });
copy('skill/ultracode', join(root, 'dist-qoder/skills/ultracode'));
copy('workflows', join(root, 'dist-qoder/workflows'));
copy('hostpacks/qoder/agents', join(root, 'dist-qoder/agents'));
copy('hostpacks/qoder/README.md', join(root, 'dist-qoder/README.md'));
manifest('hostpacks/qoder/plugin.json', join(root, 'dist-qoder/.qoder-plugin/plugin.json'));

console.log('built dist-codex/ and dist-qoder/');
