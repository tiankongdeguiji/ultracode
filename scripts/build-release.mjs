#!/usr/bin/env node
// Assemble the standalone OSS release artifact: an esbuild-bundled CLI plus
// the runtime assets it resolves relative to itself (skill/, workflows/,
// hostpacks/, LICENSE) staged as <outDir>/ultracode-<version>/ and packed as
// ultracode-<version>.tar.gz with a sha256sum-compatible checksum file. The
// stage keeps the dist/cli/main.js shape so every import.meta.url-relative
// lookup (packaged workflows, skill source, runner self-re-spawn) lands
// exactly where the dev tree puts it. Usage:
//   node scripts/build-release.mjs [root] [outDir]
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { assertSemver } from './semver.mjs';

// Optional argv overrides (exist for tests): root supplies package.json and
// all canonical sources; outDir receives the stage + tarball.
const root = process.argv[2] ? resolve(process.argv[2]) : join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = process.argv[3] ? resolve(process.argv[3]) : join(root, 'dist-release');

const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
// A malformed version would name the stage, the tarball, and the shipped
// package.json — validate before anything is written.
assertSemver(version);

rmSync(outDir, { recursive: true, force: true });
const stage = join(outDir, `ultracode-${version}`);
mkdirSync(stage, { recursive: true });

// Single-line banner: an engines guard first (a Node < 20 host must get the
// message, not an ESM syntax error from the bundle body), then a require
// binding for the __require('node:*') sites esbuild emits for CJS transitives.
// createRequire is aliased — daemonize.ts's own top-level import of it would
// otherwise collide in the flattened bundle.
const BANNER =
  `if (Number(process.versions.node.split('.')[0]) < 20) { process.stderr.write('ultracode requires Node >= 20\\n'); process.exit(1); } ` +
  `import { createRequire as __ucCreateRequire } from 'node:module'; const require = __ucCreateRequire(import.meta.url);`;

const outfile = join(stage, 'dist/cli/main.js');
await build({
  entryPoints: [join(root, 'src/cli/main.ts')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  outfile,
  logLevel: 'warning',
  banner: { js: BANNER },
});
chmodSync(outfile, 0o755);

for (const asset of ['skill', 'workflows', 'hostpacks', 'LICENSE']) {
  cpSync(join(root, asset), join(stage, asset), { recursive: true });
}

// Minimal manifest for `npm install -g <tarball>` / npm link. type: module is
// load-bearing — without it Node parses the ESM bundle as CJS.
writeFileSync(
  join(stage, 'package.json'),
  JSON.stringify(
    {
      name: 'ultracode',
      version,
      type: 'module',
      license: 'Apache-2.0',
      engines: { node: '>=20' },
      bin: { ultracode: 'dist/cli/main.js' },
    },
    null,
    2,
  ) + '\n',
);

// Self-checks: a bundle that misplaces the hashbang, lost the banner, or was
// built from a stale src/version.ts must fail the build, not the user.
const bundled = readFileSync(outfile, 'utf8');
if (bundled.split('\n')[0] !== '#!/usr/bin/env node') {
  throw new Error('release bundle does not start with #!/usr/bin/env node');
}
if (!bundled.includes('__ucCreateRequire')) {
  throw new Error('release bundle is missing the __ucCreateRequire banner shim');
}
const reported = execFileSync(process.execPath, [outfile, '--version'], { encoding: 'utf8' }).trim();
if (reported !== version) {
  throw new Error(`release bundle reports version ${reported}, expected ${version} (src/version.ts drift?)`);
}

// Portable tar invocation only — macOS bsdtar has no --sort/--owner.
const tarName = `ultracode-${version}.tar.gz`;
const tarball = join(outDir, tarName);
execFileSync('tar', ['-czf', tarball, '-C', outDir, `ultracode-${version}`]);
const hex = createHash('sha256').update(readFileSync(tarball)).digest('hex');
writeFileSync(`${tarball}.sha256`, `${hex}  ${tarName}\n`);

console.log(`built ${tarball} (+ .sha256)`);
