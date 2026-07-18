/**
 * Container-lifecycle driver for the bench harness. `runInstanceArm` takes one
 * instance x arm from an empty arm dir to a written `status.json`: prepare the
 * dir (auth, prompt), build the overlay image, run /opt/bench/entrypoint.sh in
 * a resource-capped detached container, wait with a JS backstop over the
 * in-container timeout, then post-process /bench/out (secret scrub, patch
 * validation, outcome classification, metrics) — it throws only for driver-side
 * faults (missing auth, docker run failure). `runBatch` pools instances at
 * cfg.parallel.instances (arms sequential per instance, manifest order), skips
 * already-terminal arms unless redone, and converts per-instance throws into
 * 'harness-error' statuses so one failure never kills the batch.
 */
import { execFile } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { armDir, CONTAINER_BENCH_DIR } from './config.js';
import { buildOverlay } from './image.js';
import { composePrompt } from './prompt.js';
import { classifyOutcome, readStatus, validatePatch, writeStatus } from './state.js';
import { collectMetrics } from './metrics.js';
import type {
  Arm,
  ArmMetrics,
  ArmStatus,
  BenchConfig,
  BenchInstance,
  BenchPhase,
  RunManifest,
  SessionMeta,
} from './types.js';

/** Grace on top of the in-container `timeout`: entrypoint needs time for arm-b straggler waits + patch capture. */
const BACKSTOP_EXTRA_SECS = 900;

const TERMINAL_PHASES = new Set<BenchPhase>(['session-done', 'patched', 'evaled']);

interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Run docker, resolving (never rejecting) with exit code + captured output. */
function docker(args: string[]): Promise<ExecResult> {
  return new Promise((resolve) => {
    execFile('docker', args, { maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({
        code: err ? ((err as { code?: number }).code ?? 1) : 0,
        stdout: String(stdout),
        stderr: String(stderr),
      });
    });
  });
}

/** Container-name-safe slug of an instance id (names allow [a-zA-Z0-9_.-]). */
function iidSlug(instanceId: string): string {
  return instanceId.toLowerCase().replace(/[^a-z0-9-]+/g, '-').slice(0, 60);
}

function containerName(runId: string, instanceId: string, arm: Arm): string {
  return `ucbench-${runId}-${iidSlug(instanceId)}-${arm}`;
}

/** Results dirs outlive the run and may be shared — never leave credentials in them. */
function scrubSecrets(dir: string, annotations: string[]): void {
  rmSync(join(dir, 'codex-home', 'auth.json'), { force: true });
  const configToml = join(dir, 'codex-home', 'config.toml');
  if (!existsSync(configToml)) return;
  try {
    const scrubbed = readFileSync(configToml, 'utf8')
      .split('\n')
      .map((line) => (/^\s*CODEX_API_KEY\s*=/.test(line) ? 'CODEX_API_KEY = "REDACTED"' : line))
      .join('\n');
    rmSync(configToml, { force: true }); // container-written file may be root-owned; replace, don't truncate
    writeFileSync(configToml, scrubbed);
  } catch {
    rmSync(configToml, { force: true }); // never keep a file we could not scrub
    annotations.push('config-toml-dropped');
  }
}

/**
 * Drive one instance x arm end to end; returns the final ArmStatus (also
 * persisted to the arm dir). Throws on driver-side faults the caller must
 * classify (missing host auth, docker run refusal); an overlay build failure
 * is absorbed into an 'image-failed' status instead.
 */
export async function runInstanceArm(
  cfg: BenchConfig,
  manifest: RunManifest,
  inst: BenchInstance,
  arm: Arm,
): Promise<ArmStatus> {
  const dir = armDir(manifest.runId, inst.instanceId, arm);
  // A fresh attempt owns the whole arm dir: stale rollouts/uc runs from a prior
  // attempt would double-count in metrics, and a stale config.toml breaks codex.
  rmSync(dir, { recursive: true, force: true });
  for (const sub of ['codex-home', 'uc', 'logs', 'out']) {
    mkdirSync(join(dir, sub), { recursive: true });
  }
  if (cfg.auth.mode === 'chatgpt') {
    const hostAuth = join(homedir(), '.codex', 'auth.json');
    if (!existsSync(hostAuth)) {
      throw new Error(
        `auth.mode is 'chatgpt' but ${hostAuth} does not exist — run \`codex login\` on the host, or set auth.mode to 'api-key'`,
      );
    }
    copyFileSync(hostAuth, join(dir, 'codex-home', 'auth.json'));
  }
  writeFileSync(join(dir, 'prompt.txt'), composePrompt(inst, arm));

  let overlayImage: string;
  try {
    overlayImage = await buildOverlay(inst);
  } catch (err) {
    const status: ArmStatus = {
      phase: 'pending',
      failure: 'image-failed',
      annotations: [`image-failed: ${err instanceof Error ? err.message : String(err)}`],
    };
    writeStatus(dir, status);
    return status;
  }
  writeStatus(dir, { phase: 'image-ready', failure: null, annotations: [] });

  const env: Record<string, string> = {
    BENCH_ARM: arm,
    BENCH_TIMEOUT_SECS: String(cfg.timeouts.sessionSecs),
    BENCH_MODEL: cfg.model,
    BENCH_EFFORT: cfg.effort,
    BENCH_BASE_COMMIT: inst.baseCommit,
    BENCH_CHOWN: `${process.getuid?.() ?? 0}:${process.getgid?.() ?? 0}`,
    BENCH_SANITIZE: cfg.sanitizeGitHistory ? '1' : '0',
    CODEX_HOME: `${CONTAINER_BENCH_DIR}/codex-home`,
    ULTRACODE_HOME: `${CONTAINER_BENCH_DIR}/uc`,
  };
  if (cfg.auth.mode === 'api-key') {
    const key = process.env.CODEX_API_KEY;
    if (!key) {
      throw new Error("auth.mode is 'api-key' but CODEX_API_KEY is not set in the driver environment");
    }
    env.CODEX_API_KEY = key;
  }

  const name = containerName(manifest.runId, inst.instanceId, arm);
  await docker(['rm', '-f', name]); // leftover of a killed/--redo attempt must not collide

  const runArgs = ['run', '-d', '--name', name, '--label', `ucbench=${manifest.runId}`, '-v', `${dir}:${CONTAINER_BENCH_DIR}`];
  for (const [k, v] of Object.entries(env)) runArgs.push('-e', `${k}=${v}`);
  runArgs.push(
    '--cpus', String(cfg.docker.cpus),
    '--memory', `${cfg.docker.memoryGb}g`,
    '--entrypoint', '/bin/bash',
    overlayImage,
    '/opt/bench/entrypoint.sh',
  );
  const startedAtMs = Date.now();
  let endedAtMs = startedAtMs;
  let meta: SessionMeta | null = null;
  const driverAnnotations: string[] = [];
  try {
    const started = await docker(runArgs);
    if (started.code !== 0) {
      throw new Error(`docker run failed for ${name}: ${started.stderr.trim() || started.stdout.trim()}`);
    }
    const waited = docker(['wait', name]);
    let timer: NodeJS.Timeout | undefined;
    const backstop = new Promise<'backstop'>((resolve) => {
      timer = setTimeout(resolve, (cfg.timeouts.sessionSecs + BACKSTOP_EXTRA_SECS) * 1_000, 'backstop');
    });
    const first = await Promise.race([waited.then(() => 'exited' as const), backstop]);
    clearTimeout(timer);
    endedAtMs = Date.now();
    if (first === 'backstop') {
      driverAnnotations.push('backstop-kill');
      await docker(['rm', '-f', name]);
      await waited; // resolves once the container is gone
    }
  } finally {
    // Even on a driver fault the container must die and secrets must go — the
    // scrub cannot run while the container lives (codex re-reads auth.json to
    // refresh tokens mid-session), so the rm -f (idempotent) comes first.
    await docker(['rm', '-f', name]);
    scrubSecrets(dir, driverAnnotations);
  }

  const metaFile = join(dir, 'out', 'meta.json');
  if (existsSync(metaFile)) {
    try {
      meta = JSON.parse(readFileSync(metaFile, 'utf8')) as SessionMeta;
    } catch {
      driverAnnotations.push('meta-unreadable');
    }
  }

  const patchFile = join(dir, 'out', 'patch.diff');
  const patch = existsSync(patchFile) ? readFileSync(patchFile, 'utf8') : '';
  const validation = validatePatch(patch);
  const outcome = classifyOutcome(meta, validation);

  const metrics = collectMetrics(dir, arm, { pricing: cfg.pricing, meta });
  writeFileSync(join(dir, 'metrics.json'), JSON.stringify(metrics, null, 2));

  const status: ArmStatus = {
    phase: patch.length > 0 ? 'patched' : 'session-done',
    failure: outcome.failure,
    startedAt: new Date(startedAtMs).toISOString(),
    endedAt: new Date(endedAtMs).toISOString(),
    wallClockMs: endedAtMs - startedAtMs,
    patchBytes: Buffer.byteLength(patch),
    applyCheck: meta?.applyCheck ?? null,
    annotations: [...new Set([...outcome.annotations, ...metrics.annotations, ...driverAnnotations])],
  };
  if (meta) status.codexExit = meta.codexExit;
  writeStatus(dir, status);
  return status;
}

/**
 * Run all instances through their arms with cfg.parallel.instances workers.
 * Instance order follows manifest.instanceIds; within an instance the arms run
 * sequentially in manifest.armOrder (filtered by cfg.arms). Arms already at a
 * terminal phase are skipped unless their failure is 'image-failed' or the
 * instance is listed in opts.redo. Per-instance errors become 'harness-error'
 * statuses; the batch always runs to completion.
 */
export async function runBatch(
  cfg: BenchConfig,
  manifest: RunManifest,
  instances: BenchInstance[],
  opts?: { redo?: string[] },
): Promise<void> {
  const redo = new Set(opts?.redo ?? []);
  const byId = new Map(instances.map((i) => [i.instanceId, i]));
  const ordered = manifest.instanceIds
    .map((id) => byId.get(id))
    .filter((i): i is BenchInstance => i !== undefined);
  for (const id of manifest.instanceIds) {
    for (const arm of ['a', 'b'] as const) {
      // leftovers of a driver killed mid-session (its finally never ran)
      rmSync(join(armDir(manifest.runId, id, arm), 'codex-home', 'auth.json'), { force: true });
    }
  }
  let cursor = 0;
  const workers = Array.from({ length: Math.max(1, cfg.parallel.instances) }, async () => {
    for (;;) {
      const inst = ordered[cursor++];
      if (inst === undefined) return;
      await runArms(cfg, manifest, inst, redo);
    }
  });
  await Promise.all(workers);
}

/** All arms of one instance, sequentially; throws are absorbed into 'harness-error'. */
async function runArms(cfg: BenchConfig, manifest: RunManifest, inst: BenchInstance, redo: Set<string>): Promise<void> {
  const stored = manifest.armOrder[inst.instanceId] ?? (['a', 'b'] as Arm[]);
  const arms = cfg.arms === 'both' ? stored : stored.filter((a) => a === cfg.arms);
  for (const arm of arms) {
    const dir = armDir(manifest.runId, inst.instanceId, arm);
    let status = readStatus(dir);
    const done = TERMINAL_PHASES.has(status.phase) && status.failure !== 'image-failed' && !redo.has(inst.instanceId);
    if (!done) {
      try {
        status = await runInstanceArm(cfg, manifest, inst, arm);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        status = { phase: readStatus(dir).phase, failure: 'harness-error', annotations: [`harness-error: ${message}`] };
        try {
          writeStatus(dir, status);
        } catch {
          // status write is best-effort here; the progress line still reports it
        }
      }
    }
    process.stdout.write(progressLine(inst.instanceId, arm, status, dir));
  }
}

function progressLine(instanceId: string, arm: Arm, status: ArmStatus, dir: string): string {
  const state = status.failure ? `${status.phase}/${status.failure}` : status.phase;
  const mins = Math.round((status.wallClockMs ?? 0) / 60_000);
  let tokens = 0;
  try {
    const metrics = JSON.parse(readFileSync(join(dir, 'metrics.json'), 'utf8')) as ArmMetrics;
    tokens = metrics.totalUsage.total;
  } catch {
    // no metrics written for this arm (yet)
  }
  return `[${instanceId}] arm ${arm}: ${state} (${mins}m, ${tokens} tokens)\n`;
}
