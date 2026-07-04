#!/usr/bin/env node
// Assemble the dist-codex / dist-qoder plugin bundles from canonical sources.
// Marketplace distribution is deferred (internal-first); `ultracode install`
// is the supported path. This keeps the bundles in sync for when it lands.
import { cpSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const copy = (from, to) => {
  mkdirSync(dirname(to), { recursive: true });
  cpSync(join(root, from), to, { recursive: true, force: true });
};

// Codex: skill only (MCP registration + AGENTS.md are written by the installer).
rmSync(join(root, 'dist-codex/skills'), { recursive: true, force: true });
copy('skill/ultracode', join(root, 'dist-codex/skills/ultracode'));

// Qoder: skill + uc-* templates + effort-routing agents.
for (const d of ['skills', 'workflows', 'agents']) {
  rmSync(join(root, `dist-qoder/${d}`), { recursive: true, force: true });
}
copy('skill/ultracode', join(root, 'dist-qoder/skills/ultracode'));
copy('workflows', join(root, 'dist-qoder/workflows'));
copy('hostpacks/qoder/agents', join(root, 'dist-qoder/agents'));

console.log('built dist-codex/ and dist-qoder/');
