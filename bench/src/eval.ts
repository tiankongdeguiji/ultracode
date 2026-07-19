/**
 * Official SWE-bench Pro eval-harness integration: prepares a sparse, pinned
 * checkout of scaleapi/SWE-bench_Pro-os plus a python venv, generates the
 * raw-samples JSONL and prediction sets, and drives swe_bench_pro_eval.py in
 * local-docker mode under a watchdog that stops runaway eval containers.
 * Verdicts come back as Record<instance_id, boolean> parsed from the
 * harness's eval_results.json (a flat instance_id -> bool dict); a stopped
 * container yields a missing output.json which the harness records as
 * unresolved, so the watchdog never turns an infra stall into a crash.
 */
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { armDir, BASE_IMAGE_REPO, evalDir, harnessDir, venvDir } from './config.js';
import { readStatus } from './state.js';
import type { Arm, BenchConfig, BenchInstance, EvalPrediction } from './types.js';

/**
 * Paths the harness needs; blob-less sparse checkout keeps the clone small.
 * Leading slashes + --no-cone are required: cone mode silently ignores file
 * patterns and drops these directories (observed live against the pin).
 */
const SPARSE_PATHS = ['/swe_bench_pro_eval.py', '/requirements.txt', '/helper_code', '/run_scripts', '/dockerfiles'];
const VENV_PACKAGES = ['pandas', 'tqdm', 'docker'];
const DOCKERHUB_USERNAME = 'jefzda';
const WATCHDOG_INTERVAL_MS = 60_000;
const STDERR_TAIL_BYTES = 8_192;

/** execFileSync with captured output; failures rethrow with the stderr text. */
function exec(cmd: string, args: string[], cwd?: string): string {
  try {
    return execFileSync(cmd, args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (err) {
    const e = err as { stderr?: string; message?: string };
    const detail = e.stderr?.toString().trim() || e.message || String(err);
    throw new Error(`${cmd} ${args.join(' ')} failed: ${detail}`);
  }
}

/**
 * Idempotent: sparse-clone the harness repo at cfg.harness.pin (re-pinning an
 * existing checkout when HEAD drifted) and create the venv with the eval
 * dependencies. Safe to call before every eval run.
 */
export async function prepareHarness(cfg: BenchConfig): Promise<void> {
  const dir = harnessDir();
  if (!existsSync(dir)) {
    mkdirSync(dirname(dir), { recursive: true });
    exec('git', ['clone', '--filter=blob:none', '--sparse', cfg.harness.repo, dir]);
    exec('git', ['-C', dir, 'sparse-checkout', 'set', '--no-cone', ...SPARSE_PATHS]);
    exec('git', ['-C', dir, 'checkout', cfg.harness.pin]);
  } else if (exec('git', ['-C', dir, 'rev-parse', 'HEAD']).trim() !== cfg.harness.pin) {
    exec('git', ['-C', dir, 'fetch', 'origin']);
    exec('git', ['-C', dir, 'checkout', cfg.harness.pin]);
  }
  if (!existsSync(join(dir, 'run_scripts'))) {
    // heal clones made before the --no-cone fix (cone mode dropped the dirs)
    exec('git', ['-C', dir, 'sparse-checkout', 'set', '--no-cone', ...SPARSE_PATHS]);
    if (!existsSync(join(dir, 'run_scripts'))) {
      throw new Error(
        `harness checkout at ${dir} is missing run_scripts/ — delete it and re-run \`npm run bench -- --suite swebench-pro prep\``,
      );
    }
  }
  const venv = venvDir();
  if (!existsSync(venv)) {
    exec('python3', ['-m', 'venv', venv]);
    exec(join(venv, 'bin', 'pip'), ['install', '-i', cfg.pipIndex, ...VENV_PACKAGES]);
  }
}

/**
 * Write the raw-samples JSONL the harness joins predictions against. We
 * generate our own instead of shipping the helper JSONL because the latter
 * uses uppercase F2P keys, which silently breaks the harness's resolved
 * computation. failToPass/passToPass are raw python list-literal strings and
 * pass through verbatim — the harness eval()s them itself.
 */
export function generateRawSamples(instances: BenchInstance[], outFile: string): void {
  mkdirSync(dirname(outFile), { recursive: true });
  const lines = instances.map((inst) =>
    JSON.stringify({
      instance_id: inst.instanceId,
      repo: inst.repo,
      base_commit: inst.baseCommit,
      before_repo_set_cmd: inst.beforeRepoSetCmd,
      selected_test_files_to_run: inst.selectedTestFilesToRun,
      fail_to_pass: inst.failToPass,
      pass_to_pass: inst.passToPass,
    }),
  );
  writeFileSync(outFile, `${lines.join('\n')}\n`);
}

/**
 * Predictions for one arm: every instance with a non-empty captured patch,
 * minus those whose status says 'patch-too-large'. Unapplyable diffs are
 * included on purpose — the harness scores them unresolved, and the failure
 * taxonomy already recorded them.
 */
export function collectPredictions(runId: string, arm: Arm, instances: BenchInstance[]): EvalPrediction[] {
  const prefix = arm === 'a' ? 'armA' : 'armB';
  const out: EvalPrediction[] = [];
  for (const inst of instances) {
    const dir = armDir(runId, inst.instanceId, arm);
    const patchFile = join(dir, 'out', 'patch.diff');
    if (!existsSync(patchFile)) continue;
    const patch = readFileSync(patchFile, 'utf8');
    if (patch.trim() === '') continue;
    if (readStatus(dir).failure === 'patch-too-large') continue;
    out.push({ instance_id: inst.instanceId, patch, prefix });
  }
  return out;
}

/** Gold-patch predictions — the harness-sanity upper bound (never prompted). */
export function goldPredictions(instances: BenchInstance[]): EvalPrediction[] {
  return instances.map((inst) => ({ instance_id: inst.instanceId, patch: inst.goldPatch, prefix: 'gold' }));
}

const NULL_PATCH = [
  'diff --git a/ucbench-null-check.txt b/ucbench-null-check.txt',
  'new file mode 100644',
  '--- /dev/null',
  '+++ b/ucbench-null-check.txt',
  '@@ -0,0 +1 @@',
  '+ucbench null check',
  '',
].join('\n');

/**
 * No-op predictions — a self-contained new-file diff that git-applies in any
 * repo, establishing the resolved-rate floor (flaky tests surface here).
 */
export function nullPredictions(instances: BenchInstance[]): EvalPrediction[] {
  return instances.map((inst) => ({ instance_id: inst.instanceId, patch: NULL_PATCH, prefix: 'nullcheck' }));
}

/**
 * Run the official harness over one prediction set. Writes the raw samples
 * and <prefix>.patches.json under evalDir(runId), spawns the pinned
 * swe_bench_pro_eval.py in local-docker mode (cwd = harness checkout — its
 * dockerfiles/ reads are relative), and polls a watchdog that stops sweap
 * containers older than cfg.timeouts.evalWatchdogSecs (local eval has no
 * timeout of its own). Non-zero python exit is an infra failure and throws
 * with the stderr tail; instances absent from eval_results.json come back
 * false.
 */
export async function runEval(
  cfg: BenchConfig,
  runId: string,
  prefix: string,
  predictions: EvalPrediction[],
  instances: BenchInstance[],
): Promise<Record<string, boolean>> {
  const dir = evalDir(runId);
  mkdirSync(dir, { recursive: true });
  const rawFile = join(dir, 'raw_samples.jsonl');
  generateRawSamples(instances, rawFile);
  const patchesFile = join(dir, `${prefix}.patches.json`);
  writeFileSync(patchesFile, `${JSON.stringify(predictions, null, 2)}\n`);
  const outputDir = join(dir, prefix);
  mkdirSync(outputDir, { recursive: true });

  const python = join(venvDir(), 'bin', 'python');
  const args = [
    'swe_bench_pro_eval.py',
    '--use_local_docker',
    '--num_workers', String(cfg.parallel.evalWorkers),
    '--raw_sample_path', rawFile,
    '--patch_path', patchesFile,
    '--output_dir', outputDir,
    '--scripts_dir', 'run_scripts',
    '--dockerhub_username', DOCKERHUB_USERNAME,
  ];
  await new Promise<void>((resolveDone, reject) => {
    const child = spawn(python, args, { cwd: harnessDir(), stdio: ['ignore', 'inherit', 'pipe'] });
    let tail = '';
    child.stderr?.on('data', (chunk: Buffer) => {
      process.stderr.write(chunk);
      tail = (tail + chunk.toString()).slice(-STDERR_TAIL_BYTES);
    });
    const watchdog = setInterval(() => stopStaleEvalContainers(cfg.timeouts.evalWatchdogSecs), WATCHDOG_INTERVAL_MS);
    child.once('error', (err) => {
      clearInterval(watchdog);
      reject(new Error(
        `failed to spawn ${python}: ${err.message} — did \`npm run bench -- --suite swebench-pro prep\` build the venv?`,
      ));
    });
    child.once('close', (code) => {
      clearInterval(watchdog);
      if (code === 0) resolveDone();
      else reject(new Error(`swe_bench_pro_eval.py exited ${code}; stderr tail:\n${tail.trim()}`));
    });
  });

  const results = parseResults(join(outputDir, 'eval_results.json')) ?? {};
  const verdicts: Record<string, boolean> = {};
  for (const inst of instances) verdicts[inst.instanceId] = results[inst.instanceId] === true;
  return verdicts;
}

/** Stop sweap eval containers older than maxAgeSecs; every failure here is swallowed — the watchdog retries in a minute. */
function stopStaleEvalContainers(maxAgeSecs: number): void {
  let listing: string;
  try {
    listing = execFileSync('docker', ['ps', '--format', '{{.ID}} {{.Image}} {{.CreatedAt}}'], {
      encoding: 'utf8',
      maxBuffer: 8 * 1024 * 1024,
    });
  } catch {
    return;
  }
  const now = Date.now();
  for (const line of listing.split('\n')) {
    // CreatedAt renders as "2026-07-18 06:21:33 +0000 UTC"; the zone name is redundant with the offset.
    const [id, image, date, time, offset] = line.trim().split(/\s+/);
    if (!id || !image?.startsWith(BASE_IMAGE_REPO)) continue;
    const created = Date.parse(`${date} ${time} ${offset}`);
    if (Number.isNaN(created) || (now - created) / 1_000 <= maxAgeSecs) continue;
    try {
      execFileSync('docker', ['stop', id], { encoding: 'utf8' });
    } catch {
      // already gone — the harness sees a missing output.json either way
    }
  }
}

/** Persisted verdicts of a finished eval pass; null when that prefix never completed. */
export function readEvalResults(runId: string, prefix: string): Record<string, boolean> | null {
  return parseResults(join(evalDir(runId), prefix, 'eval_results.json'));
}

function parseResults(file: string): Record<string, boolean> | null {
  if (!existsSync(file)) return null;
  const parsed = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
  const out: Record<string, boolean> = {};
  for (const [k, v] of Object.entries(parsed)) out[k] = v === true;
  return out;
}
