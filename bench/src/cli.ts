/**
 * Bench CLI: `npm run bench -- <command>`. Commands mirror the run lifecycle —
 * fetch (dataset cache), prep (toolchain + eval harness), run (agent sessions),
 * eval (official harness), report, status, clean. `run` freezes its config +
 * instance selection into results/<runId>/run.json so resumes never re-sample.
 */
import { Command } from 'commander';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { basename, resolve } from 'node:path';
import {
  BENCH_ROOT, armDir, evalDir, loadConfig, runDir, runManifestFile, validateForRun,
} from './config.js';
import type { Arm, BenchConfig, BenchInstance, RunManifest } from './types.js';
import { fetchInstances, loadInstances, selectInstances } from './instances.js';
import { prepareToolchain, toolchainInfo } from './toolchain.js';
import { removeOverlays } from './image.js';
import { runBatch } from './session.js';
import {
  collectPredictions, goldPredictions, nullPredictions, prepareHarness, runEval,
} from './eval.js';
import { generateReport } from './report.js';
import { readStatus, writeStatus } from './state.js';

const out = (s: string): void => void process.stdout.write(`${s}\n`);

interface RunFlags {
  runId: string;
  model?: string;
  effort?: string;
  arms?: string;
  count?: string;
  seed?: string;
  ids?: string;
  parallel?: string;
  timeoutSecs?: string;
  auth?: string;
  resume?: boolean;
  redo?: string;
}

function numFlag(name: string, value: string): number {
  const n = Number(value);
  if (!Number.isFinite(n)) throw new Error(`--${name} must be a number, got '${value}'`);
  return n;
}

function overridesFromFlags(f: RunFlags): Partial<BenchConfig> {
  const o: Record<string, unknown> = {};
  if (f.model !== undefined) o.model = f.model;
  if (f.effort !== undefined) o.effort = f.effort;
  if (f.arms !== undefined) o.arms = f.arms;
  if (f.auth !== undefined) o.auth = { mode: f.auth };
  const inst: Record<string, unknown> = {};
  if (f.count !== undefined) inst.count = numFlag('count', f.count);
  if (f.seed !== undefined) inst.seed = numFlag('seed', f.seed);
  if (f.ids !== undefined) inst.ids = f.ids.split(',').map((s) => s.trim()).filter(Boolean);
  if (Object.keys(inst).length) o.instances = inst;
  if (f.parallel !== undefined) o.parallel = { instances: numFlag('parallel', f.parallel) };
  if (f.timeoutSecs !== undefined) o.timeouts = { sessionSecs: numFlag('timeout-secs', f.timeoutSecs) };
  return o as Partial<BenchConfig>;
}

/** djb2 over the id, mixed with the seed — stable per-instance arm order. */
function armOrderFor(seed: number, iid: string): Arm[] {
  let h = 5381 ^ seed;
  for (const c of iid) h = ((h * 33) ^ c.charCodeAt(0)) >>> 0;
  return h % 2 === 0 ? ['a', 'b'] : ['b', 'a'];
}

function loadOrCreateManifest(cfg: BenchConfig, runId: string, resume: boolean): RunManifest {
  const file = runManifestFile(runId);
  if (existsSync(file)) {
    const m = JSON.parse(readFileSync(file, 'utf8')) as RunManifest;
    if (!resume) {
      throw new Error(`run ${runId} already exists — pass --resume to continue it (its config and instance set are frozen)`);
    }
    return m;
  }
  validateForRun(cfg);
  const selected = selectInstances(loadInstances(), cfg.instances);
  const info = toolchainInfo();
  const manifest: RunManifest = {
    runId,
    createdAt: new Date().toISOString(),
    config: cfg,
    instanceIds: selected.map((i) => i.instanceId),
    armOrder: Object.fromEntries(selected.map((i) => [i.instanceId, armOrderFor(cfg.instances.seed, i.instanceId)])),
    ultracodeSha: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: resolve(BENCH_ROOT, '..'), encoding: 'utf8' }).trim(),
    codexVersion: info.codexVersion,
    codexSha256: info.codexSha256,
  };
  mkdirSync(runDir(runId), { recursive: true });
  writeFileSync(file, JSON.stringify(manifest, null, 2));
  return manifest;
}

function manifestInstances(m: RunManifest): BenchInstance[] {
  const byId = new Map(loadInstances().map((i) => [i.instanceId, i]));
  return m.instanceIds.map((id) => {
    const inst = byId.get(id);
    if (!inst) throw new Error(`instance ${id} from run.json is missing from the dataset cache — re-run \`bench fetch\``);
    return inst;
  });
}

const program = new Command();
program.name('bench').description('SWE-bench Pro A/B harness: codex alone vs codex + ultracode');

program.command('fetch').description('cache the SWE-bench Pro dataset (731 rows) from HuggingFace').action(async () => {
  const n = await fetchInstances();
  out(`cached ${n} instances`);
});

program.command('prep').description('assemble the container toolchain and the pinned eval harness').action(async () => {
  const cfg = loadConfig();
  await prepareToolchain(cfg);
  out('toolchain ready');
  await prepareHarness(cfg);
  out('eval harness ready');
});

program.command('run')
  .description('run agent sessions for the selected instances')
  .requiredOption('--run-id <id>')
  .option('--model <model>').option('--effort <effort>').option('--arms <arms>')
  .option('--count <n>').option('--seed <n>').option('--ids <ids>')
  .option('--parallel <n>').option('--timeout-secs <n>').option('--auth <mode>')
  .option('--resume').option('--redo <ids>')
  .action(async (f: RunFlags) => {
    const fresh = loadConfig(overridesFromFlags(f));
    const manifest = loadOrCreateManifest(fresh, f.runId, f.resume ?? false);
    const cfg: BenchConfig = { ...manifest.config };
    if (f.parallel !== undefined) cfg.parallel = { ...cfg.parallel, instances: numFlag('parallel', f.parallel) };
    const redo = f.redo ? f.redo.split(',').map((s) => s.trim()).filter(Boolean) : undefined;
    const instances = manifestInstances(manifest);
    out(`run ${manifest.runId}: ${instances.length} instances, arms=${cfg.arms}, model=${cfg.model}, parallel=${cfg.parallel.instances}`);
    await runBatch(cfg, manifest, instances, { redo });
    out('batch complete — next: `npm run bench -- eval --run-id ' + manifest.runId + '`');
  });

program.command('eval')
  .description('score captured patches with the official SWE-bench Pro harness')
  .requiredOption('--run-id <id>')
  .option('--gold', 'evaluate the dataset gold patches (pipeline smoke)')
  .option('--null', 'evaluate a benign no-op patch (flags instances whose tests already pass)')
  .action(async (f: { runId: string; gold?: boolean; null?: boolean }) => {
    const manifest = JSON.parse(readFileSync(runManifestFile(f.runId), 'utf8')) as RunManifest;
    const cfg = manifest.config;
    const instances = manifestInstances(manifest);
    mkdirSync(evalDir(f.runId), { recursive: true });
    if (f.gold || f.null) {
      const prefix = f.gold ? 'gold' : 'nullcheck';
      const preds = f.gold ? goldPredictions(instances) : nullPredictions(instances);
      const results = await runEval(cfg, f.runId, prefix, preds, instances);
      const ok = Object.values(results).filter(Boolean).length;
      out(`${prefix}: ${ok}/${instances.length} resolved`);
      return;
    }
    for (const arm of (cfg.arms === 'both' ? ['a', 'b'] as const : [cfg.arms])) {
      const prefix = arm === 'a' ? 'armA' : 'armB';
      const preds = collectPredictions(f.runId, arm, instances);
      out(`${prefix}: evaluating ${preds.length}/${instances.length} non-empty patches`);
      if (preds.length === 0) continue; // the harness ZeroDivisionErrors on an empty set
      const results = await runEval(cfg, f.runId, prefix, preds, instances);
      for (const iid of Object.keys(results)) {
        const dir = armDir(f.runId, iid, arm);
        const st = readStatus(dir);
        if (st.phase === 'patched') writeStatus(dir, { ...st, phase: 'evaled' });
      }
      const ok = Object.values(results).filter(Boolean).length;
      out(`${prefix}: ${ok}/${instances.length} resolved`);
    }
    out('next: `npm run bench -- report --run-id ' + f.runId + '`');
  });

program.command('report').description('aggregate statuses, metrics, and eval verdicts into report.md/json')
  .requiredOption('--run-id <id>')
  .action((f: { runId: string }) => {
    const { jsonPath, mdPath } = generateReport(f.runId);
    out(`wrote ${jsonPath}`);
    out(`wrote ${mdPath}`);
  });

program.command('status').description('per instance x arm progress for a run')
  .requiredOption('--run-id <id>')
  .action((f: { runId: string }) => {
    const manifest = JSON.parse(readFileSync(runManifestFile(f.runId), 'utf8')) as RunManifest;
    for (const iid of manifest.instanceIds) {
      for (const arm of manifest.armOrder[iid] ?? (['a', 'b'] as Arm[])) {
        const dir = armDir(f.runId, iid, arm);
        const st = readStatus(dir);
        let tokens = '';
        try {
          const m = JSON.parse(readFileSync(`${dir}/metrics.json`, 'utf8'));
          tokens = ` ${Math.round((m.totalUsage?.total ?? 0) / 1000)}k tok`;
        } catch { /* not collected yet */ }
        const failure = st.failure ? ` FAIL:${st.failure}` : '';
        const notes = st.annotations.length ? ` [${st.annotations.join(', ')}]` : '';
        out(`${iid} ${arm}: ${st.phase}${failure}${tokens}${notes}`);
      }
    }
  });

program.command('clean').description('remove leftover bench containers (and overlay images with --images)')
  .option('--images')
  .action(async (f: { images?: boolean }) => {
    const ps = execFileSync('docker', ['ps', '-aq', '--filter', 'name=ucbench-'], { encoding: 'utf8' }).trim();
    if (ps) {
      execFileSync('docker', ['rm', '-f', ...ps.split('\n')], { stdio: 'ignore' });
      out(`removed ${ps.split('\n').length} containers`);
    }
    if (f.images) out(`removed ${await removeOverlays()} overlay images`);
    rmSync(resolve(BENCH_ROOT, '.cache/release-stage'), { recursive: true, force: true });
  });

program.parseAsync(process.argv).catch((err: unknown) => {
  process.stderr.write(`${basename(process.argv[1] ?? 'bench')}: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exitCode = 1;
});
