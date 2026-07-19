/**
 * Docker image management for the bench harness: ensures pinned SWE-bench Pro
 * base images are present locally (pull with retry/backoff), builds the thin
 * per-instance `ucbench:*` overlay from the prepped toolchain context, reads
 * base-image digests for run provenance, and prunes overlays after eval.
 * Every docker invocation goes through execFile argv arrays (never a shell)
 * with a generous maxBuffer, since pull/build output can be large.
 */
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { BASE_IMAGE_REPO, BENCH_ROOT, overlayImageName, toolchainDir } from './config.js';
import type { BenchInstance } from './types.js';

const execFileP = promisify(execFile);

const DOCKER_MAX_BUFFER = 64 * 1024 * 1024;
/** Sleep after failed pull attempt i; attempts = schedule length, last failure throws. */
const PULL_BACKOFF_MS = [10_000, 30_000, 90_000];
const STDERR_TAIL_CHARS = 2_000;

async function docker(args: string[]): Promise<string> {
  const { stdout } = await execFileP('docker', args, { maxBuffer: DOCKER_MAX_BUFFER });
  return stdout;
}

/** Last chunk of a failed execFile's stderr — enough to diagnose without dumping a full pull log. */
function stderrTail(err: unknown): string {
  const stderr =
    err !== null && typeof err === 'object' && typeof (err as { stderr?: unknown }).stderr === 'string'
      ? (err as { stderr: string }).stderr
      : '';
  const text = (stderr.trim() !== '' ? stderr : String(err)).trim();
  return text.length > STDERR_TAIL_CHARS ? `...${text.slice(-STDERR_TAIL_CHARS)}` : text;
}

const sleep = (ms: number): Promise<void> => new Promise((res) => setTimeout(res, ms));

/** Make BASE_IMAGE_REPO:tag available locally: no-op if present, else pull with backoff. */
export async function ensureBaseImage(tag: string): Promise<void> {
  const full = `${BASE_IMAGE_REPO}:${tag}`;
  try {
    await docker(['image', 'inspect', full]);
    return;
  } catch {
    // not local — fall through to pull
  }
  let lastTail = '';
  for (let attempt = 0; attempt < PULL_BACKOFF_MS.length; attempt++) {
    try {
      await docker(['pull', full]);
      return;
    } catch (err) {
      lastTail = stderrTail(err);
      if (attempt < PULL_BACKOFF_MS.length - 1) await sleep(PULL_BACKOFF_MS[attempt] ?? 0);
    }
  }
  throw new Error(`docker pull ${full} failed after ${PULL_BACKOFF_MS.length} attempts: ${lastTail}`);
}

/**
 * Build the per-instance overlay image (toolchain COPYed over the pulled base)
 * and return its name. Requires a prepped toolchain context; fails fast before
 * the potentially long base pull when it is missing.
 */
export async function buildOverlay(inst: BenchInstance): Promise<string> {
  const context = toolchainDir();
  if (!existsSync(join(context, 'manifest.json'))) {
    throw new Error(
      `toolchain context is not prepared (${join(context, 'manifest.json')} is missing) — run \`npm run bench -- --suite swebench-pro prep\` first`,
    );
  }
  await ensureBaseImage(inst.dockerhubTag);
  const base = `${BASE_IMAGE_REPO}:${inst.dockerhubTag}`;
  const overlay = overlayImageName(inst.instanceId);
  try {
    await docker([
      'build',
      '-f', join(BENCH_ROOT, 'Dockerfile'),
      '--build-arg', `BASE_IMAGE=${base}`,
      '-t', overlay,
      context,
    ]);
  } catch (err) {
    throw new Error(`docker build ${overlay} (base ${base}) failed: ${stderrTail(err)}`);
  }
  return overlay;
}

/** First RepoDigest of the local base image, for run provenance; null when unavailable. */
export async function baseImageDigest(tag: string): Promise<string | null> {
  try {
    const out = await docker([
      'image', 'inspect', '--format', '{{index .RepoDigests 0}}', `${BASE_IMAGE_REPO}:${tag}`,
    ]);
    const digest = out.trim();
    return digest === '' ? null : digest;
  } catch {
    return null;
  }
}

/** Remove all local `ucbench:*` overlay images; per-image failures (in use, already gone) are skipped. */
export async function removeOverlays(): Promise<number> {
  let listed: string;
  try {
    listed = await docker(['images', 'ucbench', '--format', '{{.Repository}}:{{.Tag}}']);
  } catch (err) {
    throw new Error(`docker images ucbench failed: ${stderrTail(err)}`);
  }
  const names = listed
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.endsWith(':<none>'));
  let removed = 0;
  for (const name of names) {
    try {
      await docker(['rmi', name]);
      removed++;
    } catch {
      // dangling or in use by a live container — leave it for docker prune
    }
  }
  return removed;
}
