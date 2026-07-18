/**
 * ultracode update: self-update for copies installed by the OSS installer
 * (scripts/oss/install.sh). The installer leaves an .install-receipt.json in
 * the versioned app dir two levels above this module; update reads it,
 * resolves the target release from the origin (env UC_BASE_URL > receipt
 * baseUrl > default), then downloads the origin's install.sh and re-execs it
 * with UC_VERSION/UC_BASE_URL/UC_INSTALL_DIR/UC_BIN_DIR pinned — one source
 * of install logic, nothing duplicated here. Re-exec is safe mid-flight: the
 * running process executes from the old versioned app/<version> dir, which
 * the installer retains on purpose, and the shim swap is an atomic mv.
 * Source checkouts / npm links have no receipt and are refused (exit 2).
 * `--check` mirrors `sync --check`: exit 1 when an update is available,
 * 0 when current, 2 on errors.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { errorMessage } from '../engine/errors.js';
import { VERSION } from '../version.js';

const DEFAULT_BASE_URL = 'https://hongsheng-jhs.oss-cn-hangzhou.aliyuncs.com/ultracode';

const SEMVER_RE = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

/**
 * SemVer 2.0.0 precedence: numeric triple, then dot-split prerelease
 * identifiers (numeric identifiers compare numerically and sort below
 * alphanumeric ones, so rc.10 > rc.2); a prerelease sorts below its plain
 * triple; build metadata is accepted and ignored.
 */
export function compareVersions(a: string, b: string): number {
  const pa = SEMVER_RE.exec(a);
  const pb = SEMVER_RE.exec(b);
  if (!pa || !pb) throw new Error(`not a semver version: '${pa ? b : a}'`);
  for (let i = 1; i <= 3; i++) {
    const d = Number(pa[i]) - Number(pb[i]);
    if (d !== 0) return Math.sign(d);
  }
  const ra = pa[4];
  const rb = pb[4];
  if (ra === undefined || rb === undefined) return ra === rb ? 0 : ra !== undefined ? -1 : 1;
  const ia = ra.split('.');
  const ib = rb.split('.');
  for (let i = 0; i < Math.max(ia.length, ib.length); i++) {
    const x = ia[i];
    const y = ib[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const nx = /^\d+$/.test(x);
    const ny = /^\d+$/.test(y);
    if (nx && ny) {
      const d = Number(x) - Number(y);
      if (d !== 0) return Math.sign(d);
    } else if (nx !== ny) {
      return nx ? -1 : 1;
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  return 0;
}

/** Written by install.sh into the versioned app dir; proves an OSS install and pins its layout. */
interface InstallReceipt {
  version?: string;
  baseUrl?: string;
  installDir?: string;
  binDir?: string;
}

/** file: URLs read straight off disk (keeps tests offline); everything else via fetch with a 10s cap. */
async function fetchText(url: string): Promise<string> {
  if (url.startsWith('file:')) return readFileSync(fileURLToPath(url), 'utf8');
  const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`download failed (HTTP ${res.status}): ${url}`);
  return res.text();
}

async function latestVersion(base: string): Promise<string> {
  const manifest = JSON.parse(await fetchText(`${base}/latest.json`)) as { version?: unknown };
  if (typeof manifest.version !== 'string' || !SEMVER_RE.test(manifest.version)) {
    throw new Error(`no well-formed version in ${base}/latest.json`);
  }
  return manifest.version;
}

export interface UpdateOptions {
  check?: boolean;
  to?: string;
}

export interface UpdateDeps {
  /** test seams */
  appRoot?: string;
  modulePath?: string;
  env?: NodeJS.ProcessEnv;
}

export async function updateCommand(opts: UpdateOptions, deps: UpdateDeps = {}): Promise<number> {
  const modulePath = deps.modulePath ?? fileURLToPath(import.meta.url);
  const appRoot = deps.appRoot ?? resolve(dirname(modulePath), '../..');
  const env = deps.env ?? process.env;
  const receiptPath = join(appRoot, '.install-receipt.json');
  if (modulePath.endsWith('.ts') || !existsSync(receiptPath)) {
    process.stderr.write(
      'ultracode update: this copy was not installed from the release server (source checkout or npm link); update with: git pull && npm run build\n',
    );
    return 2;
  }
  try {
    const receipt = JSON.parse(readFileSync(receiptPath, 'utf8')) as InstallReceipt;
    const base = (env.UC_BASE_URL || receipt.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '');
    if (opts.check) {
      const latest = await latestVersion(base);
      if (compareVersions(latest, VERSION) > 0) {
        process.stdout.write(`ultracode ${VERSION} -> latest ${latest} (update available)\n`);
        return 1;
      }
      process.stdout.write(`up to date (${VERSION})\n`);
      return 0;
    }
    return await performUpdate(opts, receipt, base, env, receiptPath);
  } catch (err) {
    process.stderr.write(`ultracode update: ${errorMessage(err)}\n`);
    return 2;
  }
}

async function performUpdate(
  opts: UpdateOptions,
  receipt: InstallReceipt,
  base: string,
  env: NodeJS.ProcessEnv,
  receiptPath: string,
): Promise<number> {
  let target: string;
  if (opts.to) {
    target = opts.to.replace(/^v/, '');
    if (!SEMVER_RE.test(target)) throw new Error(`--to expects a version like 1.2.3 (got '${opts.to}')`);
  } else {
    target = await latestVersion(base);
  }
  if (target === VERSION) {
    process.stdout.write(`already on ${VERSION} — nothing to update\n`);
    return 0;
  }
  if (!opts.to && compareVersions(target, VERSION) < 0) {
    // Matches --check: when latest.json lags the running build (prerelease,
    // --to-pinned install, or a rolled-back pointer) a bare update must not
    // silently downgrade; only an explicit --to goes backward.
    process.stdout.write(`up to date (${VERSION}; latest is ${target})\n`);
    return 0;
  }
  if (!receipt.installDir || !receipt.binDir) {
    throw new Error(`receipt at ${receiptPath} is missing installDir/binDir`);
  }
  const tmp = mkdtempSync(join(tmpdir(), 'uc-update-'));
  try {
    const scriptFile = join(tmp, 'install.sh');
    writeFileSync(scriptFile, await fetchText(`${base}/install.sh`));
    const res = spawnSync('sh', [scriptFile], {
      stdio: 'inherit',
      env: {
        ...env,
        UC_VERSION: target,
        UC_BASE_URL: base,
        UC_INSTALL_DIR: receipt.installDir,
        UC_BIN_DIR: receipt.binDir,
        // The node running this CLI is the shim-selected one — hand it to the
        // installer so a host whose node lives off PATH doesn't re-provision.
        UC_NODE: env.UC_NODE ?? process.execPath,
      },
    });
    if (res.error) throw res.error;
    if (res.status !== 0) return res.status ?? 1;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  process.stdout.write(
    `updated ${VERSION} -> ${target}\n` +
      "MCP registrations pin the versioned install path — run 'ultracode install codex' (or your host) to refresh them.\n",
  );
  return 0;
}
