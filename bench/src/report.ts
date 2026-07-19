/**
 * Report generation for the A/B benchmark: statistics (Wilson interval, exact
 * McNemar) and report.json / report.md assembly. All aggregation lives in the
 * pure `buildReport` so tests can drive it on in-memory fixtures; the thin
 * `generateReport` wrapper does the run-directory IO (manifest, per-arm
 * status/metrics, eval verdicts) and writes both report files. Partial runs
 * are tolerated: instances missing metrics or eval verdicts drop out of the
 * affected aggregates and surface via the taxonomy/annotation sections.
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { armDir, instancesFile, runDir, runManifestFile } from './config.js';
import { readEvalResults } from './eval.js';
import { readStatus } from './state.js';
import type { Arm, ArmMetrics, ArmStatus, BenchInstance, FailureKind, RunManifest } from './types.js';

/* ------------------------------------------------------------- statistics -- */

const Z = 1.96;

/** Wilson score interval for k successes in n trials at 95% (z = 1.96); n = 0 -> [0, 1]. */
export function wilson(k: number, n: number): { lo: number; hi: number } {
  if (n === 0) return { lo: 0, hi: 1 };
  const p = k / n;
  const z2 = Z * Z;
  const denom = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / denom;
  const half = (Z / denom) * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n));
  return { lo: Math.max(0, center - half), hi: Math.min(1, center + half) };
}

/**
 * Exact two-sided binomial McNemar p-value on the discordant counts:
 * p = min(1, 2 * P(X <= min(b, c)) with X ~ Binom(b + c, 0.5)); n = 0 -> 1.
 * Terms build by incremental products so n up to ~800 stays finite
 * (0.5^800 is still a normal double).
 */
export function mcnemarExact(b: number, c: number): number {
  const n = b + c;
  if (n === 0) return 1;
  let term = Math.pow(0.5, n);
  let sum = term;
  const m = Math.min(b, c);
  for (let k = 0; k < m; k++) {
    term *= (n - k) / (k + 1);
    sum += term;
  }
  return Math.min(1, 2 * sum);
}

const sum = (xs: number[]): number => xs.reduce((acc, x) => acc + x, 0);
const mean = (xs: number[]): number | null => (xs.length === 0 ? null : sum(xs) / xs.length);

function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((x, y) => x - y);
  const hi = s[s.length >> 1] ?? 0;
  if (s.length % 2 === 1) return hi;
  return ((s[(s.length >> 1) - 1] ?? 0) + hi) / 2;
}

/* ----------------------------------------------------------------- inputs -- */

/** Everything known about one instance x arm; null fields mean "not produced yet". */
export interface ArmInputs {
  status: ArmStatus | null;
  metrics: ArmMetrics | null;
  /** eval verdict; null = this instance x arm has not been evaluated */
  resolved: boolean | null;
}

export interface InstanceInputs {
  instanceId: string;
  /** dataset repo_language; null when the instances cache is unavailable */
  language: string | null;
  a: ArmInputs;
  b: ArmInputs;
}

/** In-memory picture of a run, assembled by `generateReport` or a test fixture. */
export interface ReportInputs {
  manifest: RunManifest;
  instances: InstanceInputs[];
  /** sanity-prefix verdicts keyed by instance id, when those evals ran */
  gold: Record<string, boolean> | null;
  nullcheck: Record<string, boolean> | null;
  /** requested/default/effective reasoning effort provenance from run artifacts */
  reasoningEffort?: ReasoningEffortAudit;
}

/* ------------------------------------------------------------ report shape -- */

export interface ArmSummary {
  arm: Arm;
  /** instances with an eval verdict for this arm */
  evaluated: number;
  resolved: number;
  rate: number | null;
  ci: { lo: number; hi: number };
  tokens: { total: number; mean: number | null; median: number | null };
  wallClockMs: { total: number; mean: number | null; median: number | null };
  compactions: number;
  contextPeakMax: number | null;
  /** instances whose metrics meet the long-context pressure criterion */
  contextPressured: number;
  /** sum of metrics.costUSD where present; null when no metrics carried it */
  costUSD: number | null;
}

export interface PairedStats {
  /** instances where both arms have an eval verdict */
  n: number;
  bothResolved: number;
  /** b of McNemar: resolved by A only */
  aOnly: number;
  /** c of McNemar: resolved by B only */
  bOnly: number;
  neither: number;
  p: number;
}

export interface StratumStats {
  n: number;
  aResolved: number;
  bResolved: number;
  aRate: number | null;
  bRate: number | null;
  /** bRate - aRate; null when the stratum is empty */
  delta: number | null;
}

export interface ThesisCut {
  criterion: string;
  inside: StratumStats;
  outside: StratumStats;
  /** paired instances lacking arm-a metrics — cannot be classified */
  unclassified: number;
}

export interface InstanceRow {
  instanceId: string;
  language: string | null;
  aResolved: boolean | null;
  bResolved: boolean | null;
  aTokens: number | null;
  bTokens: number | null;
  aWallClockMs: number | null;
  bWallClockMs: number | null;
  aCompactions: number | null;
  bAgentCount: number | null;
  aFailure: string | null;
  bFailure: string | null;
  /** union of status+metrics annotations, prefixed `a:`/`b:` */
  annotations: string[];
}

export interface ReasoningEffortAudit {
  /** null means the frozen config deliberately left the setting to Codex */
  requested: string | null;
  /** distinct defaults advertised for the pinned model by the per-arm model caches */
  modelDefaults: string[];
  /** inferred effective effort per rollout session, grouped by arm */
  sessions: { a: Record<string, number>; b: Record<string, number> };
}

export interface ReportJson {
  runId: string;
  createdAt: string;
  model: string;
  /** Frozen config value retained for backward-compatible consumers. */
  effort: string;
  reasoningEffort: ReasoningEffortAudit;
  config: RunManifest['config'];
  reproducibility: {
    ultracodeSha: string;
    codexVersion: string;
    codexSha256: string;
    harnessRepo: string;
    harnessPin: string;
    datasetSize: number;
  };
  arms: { a: ArmSummary; b: ArmSummary };
  paired: PairedStats;
  thesisCut: ThesisCut;
  instances: InstanceRow[];
  /** failure-kind -> count, per arm */
  taxonomy: { a: Record<string, number>; b: Record<string, number> };
  /** annotation -> count across arm-b statuses+metrics (degenerate-orchestration audit) */
  armBAnnotations: Record<string, number>;
  sanity: {
    gold: { evaluated: number; resolved: number } | null;
    nullcheck: { evaluated: number; resolved: number } | null;
  };
}

/* ------------------------------------------------------------ aggregation -- */

const armInputs = (inst: InstanceInputs, arm: Arm): ArmInputs => (arm === 'a' ? inst.a : inst.b);

/** The pre-registered long-context stratum criterion, evaluated on one arm's metrics. */
function underContextPressure(m: ArmMetrics): boolean {
  return m.compactionEvents > 0 || (m.contextWindow !== null && m.contextPeak > 0.8 * m.contextWindow);
}

function summarizeArm(arm: Arm, instances: InstanceInputs[]): ArmSummary {
  const metrics = instances
    .map((i) => armInputs(i, arm).metrics)
    .filter((m): m is ArmMetrics => m !== null);
  const verdicts = instances
    .map((i) => armInputs(i, arm).resolved)
    .filter((r): r is boolean => r !== null);
  const evaluated = verdicts.length;
  const resolved = verdicts.filter(Boolean).length;
  const tokens = metrics.map((m) => m.totalUsage.total);
  const walls = metrics.map((m) => m.wallClockMs);
  const costs = metrics.map((m) => m.costUSD).filter((c): c is number => typeof c === 'number');
  const peaks = metrics.map((m) => m.contextPeak);
  return {
    arm,
    evaluated,
    resolved,
    rate: evaluated === 0 ? null : resolved / evaluated,
    ci: wilson(resolved, evaluated),
    tokens: { total: sum(tokens), mean: mean(tokens), median: median(tokens) },
    wallClockMs: { total: sum(walls), mean: mean(walls), median: median(walls) },
    compactions: sum(metrics.map((m) => m.compactionEvents)),
    contextPeakMax: peaks.length === 0 ? null : Math.max(...peaks),
    contextPressured: metrics.filter(underContextPressure).length,
    costUSD: costs.length === 0 ? null : sum(costs),
  };
}

function pairedStats(instances: InstanceInputs[]): PairedStats {
  let bothResolved = 0;
  let aOnly = 0;
  let bOnly = 0;
  let neither = 0;
  for (const inst of instances) {
    const ra = inst.a.resolved;
    const rb = inst.b.resolved;
    if (ra === null || rb === null) continue;
    if (ra && rb) bothResolved++;
    else if (ra) aOnly++;
    else if (rb) bOnly++;
    else neither++;
  }
  const n = bothResolved + aOnly + bOnly + neither;
  return { n, bothResolved, aOnly, bOnly, neither, p: mcnemarExact(aOnly, bOnly) };
}

const THESIS_CRITERION =
  'arm A metrics: compactionEvents > 0 OR (contextWindow non-null AND contextPeak > 0.8 * contextWindow)';

function stratum(insts: InstanceInputs[]): StratumStats {
  const n = insts.length;
  const aResolved = insts.filter((i) => i.a.resolved === true).length;
  const bResolved = insts.filter((i) => i.b.resolved === true).length;
  const aRate = n === 0 ? null : aResolved / n;
  const bRate = n === 0 ? null : bResolved / n;
  const delta = aRate === null || bRate === null ? null : bRate - aRate;
  return { n, aResolved, bResolved, aRate, bRate, delta };
}

function thesisCut(instances: InstanceInputs[]): ThesisCut {
  const inside: InstanceInputs[] = [];
  const outside: InstanceInputs[] = [];
  let unclassified = 0;
  for (const inst of instances) {
    if (inst.a.resolved === null || inst.b.resolved === null) continue;
    if (inst.a.metrics === null) {
      unclassified++;
      continue;
    }
    (underContextPressure(inst.a.metrics) ? inside : outside).push(inst);
  }
  return { criterion: THESIS_CRITERION, inside: stratum(inside), outside: stratum(outside), unclassified };
}

function countFailures(instances: InstanceInputs[], arm: Arm): Record<string, number> {
  const out: Record<string, number> = {};
  for (const inst of instances) {
    const f = armInputs(inst, arm).status?.failure ?? null;
    if (f !== null) out[f] = (out[f] ?? 0) + 1;
  }
  return out;
}

function armAnnotations(inputs: ArmInputs): string[] {
  return [...new Set([...(inputs.status?.annotations ?? []), ...(inputs.metrics?.annotations ?? [])])];
}

function countArmBAnnotations(instances: InstanceInputs[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const inst of instances) {
    for (const note of armAnnotations(inst.b)) out[note] = (out[note] ?? 0) + 1;
  }
  return out;
}

function instanceRow(inst: InstanceInputs): InstanceRow {
  return {
    instanceId: inst.instanceId,
    language: inst.language,
    aResolved: inst.a.resolved,
    bResolved: inst.b.resolved,
    aTokens: inst.a.metrics?.totalUsage.total ?? null,
    bTokens: inst.b.metrics?.totalUsage.total ?? null,
    aWallClockMs: inst.a.metrics?.wallClockMs ?? null,
    bWallClockMs: inst.b.metrics?.wallClockMs ?? null,
    aCompactions: inst.a.metrics?.compactionEvents ?? null,
    bAgentCount: inst.b.metrics?.uc?.agentCount ?? null,
    aFailure: inst.a.status?.failure ?? null,
    bFailure: inst.b.status?.failure ?? null,
    annotations: [
      ...armAnnotations(inst.a).map((s) => `a:${s}`),
      ...armAnnotations(inst.b).map((s) => `b:${s}`),
    ],
  };
}

function sanityCounts(verdicts: Record<string, boolean> | null): { evaluated: number; resolved: number } | null {
  if (verdicts === null) return null;
  const vals = Object.values(verdicts);
  return { evaluated: vals.length, resolved: vals.filter(Boolean).length };
}

/** Pure core: aggregate a run picture into the machine + human report pair. */
export function buildReport(inputs: ReportInputs): { json: ReportJson; md: string } {
  const { manifest, instances } = inputs;
  const reasoningEffort = inputs.reasoningEffort ?? {
    requested: manifest.config.effort || null,
    modelDefaults: [],
    sessions: { a: {}, b: {} },
  };
  const json: ReportJson = {
    runId: manifest.runId,
    createdAt: manifest.createdAt,
    model: manifest.config.model,
    effort: manifest.config.effort,
    reasoningEffort,
    config: manifest.config,
    reproducibility: {
      ultracodeSha: manifest.ultracodeSha,
      codexVersion: manifest.codexVersion,
      codexSha256: manifest.codexSha256,
      harnessRepo: manifest.config.harness.repo,
      harnessPin: manifest.config.harness.pin,
      datasetSize: manifest.instanceIds.length,
    },
    arms: { a: summarizeArm('a', instances), b: summarizeArm('b', instances) },
    paired: pairedStats(instances),
    thesisCut: thesisCut(instances),
    instances: instances.map(instanceRow),
    taxonomy: { a: countFailures(instances, 'a'), b: countFailures(instances, 'b') },
    armBAnnotations: countArmBAnnotations(instances),
    sanity: { gold: sanityCounts(inputs.gold), nullcheck: sanityCounts(inputs.nullcheck) },
  };
  return { json, md: renderMd(json) };
}

/* -------------------------------------------------------------- markdown -- */

export const SUMMARY_TABLE_HEADER =
  '| arm | resolved | 95% CI | mean tokens | median tokens | mean wall-clock | compactions |';

export const POWER_DISCLAIMER =
  'paired n < 100: the exact McNemar test is underpowered at this sample size — treat p as descriptive, not confirmatory.';

const pctOf = (x: number | null): string => (x === null ? '—' : `${(100 * x).toFixed(1)}%`);
const fmtCi = (ci: { lo: number; hi: number }): string =>
  `${(100 * ci.lo).toFixed(1)}–${(100 * ci.hi).toFixed(1)}%`;
const fmtInt = (x: number | null): string =>
  x === null ? '—' : Math.round(x).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
const fmtMins = (ms: number | null): string => (ms === null ? '—' : `${(ms / 60_000).toFixed(1)} min`);
const fmtVerdict = (r: boolean | null): string => (r === null ? '—' : r ? 'yes' : 'no');
const fmtDelta = (d: number | null): string =>
  d === null ? '—' : `${d >= 0 ? '+' : ''}${(100 * d).toFixed(1)}%`;

function mdHeader(json: ReportJson): string {
  const cfg = json.config;
  const effort = json.reasoningEffort;
  const requested = effort.requested === null ? 'unset' : `\`${effort.requested}\``;
  const defaults = effort.modelDefaults.length === 0
    ? 'unknown'
    : effort.modelDefaults.map((value) => `\`${value}\``).join(', ');
  const sessionCounts = (arm: Arm): string => {
    const entries = Object.entries(effort.sessions[arm]);
    if (entries.length === 0) return 'none';
    return entries.map(([value, count]) => `${value}×${count}`).join(', ');
  };
  return [
    `# SWE-bench Pro A/B report — ${json.runId}`,
    '',
    `Run \`${json.runId}\` created ${json.createdAt}.`,
    '',
    `- model: \`${json.model}\``,
    `- reasoning effort: requested ${requested}; model default(s): ${defaults}; inferred sessions: A ${sessionCounts('a')}, B ${sessionCounts('b')}`,
    `- arms: ${cfg.arms}; instances: ${json.reproducibility.datasetSize}; parallel instances: ${cfg.parallel.instances}`,
    `- session timeout: ${cfg.timeouts.sessionSecs}s; auth: ${cfg.auth.mode}; sanitizeGitHistory: ${cfg.sanitizeGitHistory}`,
    '',
    '## Reproducibility',
    '',
    `- ultracode: \`${json.reproducibility.ultracodeSha}\``,
    `- codex: \`${json.reproducibility.codexVersion}\` (sha256 \`${json.reproducibility.codexSha256}\`)`,
    `- eval harness: ${json.reproducibility.harnessRepo} @ \`${json.reproducibility.harnessPin}\``,
    `- dataset size: ${json.reproducibility.datasetSize} instances`,
  ].join('\n');
}

function mdSummaryRow(label: string, s: ArmSummary): string {
  const resolved = s.evaluated === 0 ? '0/0' : `${s.resolved}/${s.evaluated} (${pctOf(s.rate)})`;
  return `| ${label} | ${resolved} | ${fmtCi(s.ci)} | ${fmtInt(s.tokens.mean)} | ${fmtInt(s.tokens.median)} | ${fmtMins(s.wallClockMs.mean)} | ${s.compactions} |`;
}

function mdSummary(json: ReportJson): string {
  const { paired } = json;
  const lines = [
    '## Summary',
    '',
    SUMMARY_TABLE_HEADER,
    '| --- | --- | --- | --- | --- | --- | --- |',
    mdSummaryRow('A (codex solo)', json.arms.a),
    mdSummaryRow('B (ultracode)', json.arms.b),
    '',
    `McNemar exact on the paired subset (n=${paired.n}; A-only b=${paired.aOnly}, B-only c=${paired.bOnly}): p = ${paired.p.toFixed(4)}.`,
  ];
  if (paired.n < 100) lines.push('', `Note: ${POWER_DISCLAIMER}`);
  if (json.arms.a.costUSD !== null || json.arms.b.costUSD !== null) {
    const usd = (x: number | null): string => (x === null ? '—' : `$${x.toFixed(2)}`);
    lines.push('', `Cost: A ${usd(json.arms.a.costUSD)}, B ${usd(json.arms.b.costUSD)} (instances with costUSD only).`);
  }
  return lines.join('\n');
}

function mdInstanceTable(json: ReportJson): string {
  const lines = [
    '## Per-instance',
    '',
    '| instance | lang | A resolved | B resolved | A tokens | B tokens | A wall | B wall | A compactions | B agents | annotations |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
  ];
  for (const r of json.instances) {
    lines.push(
      `| ${r.instanceId} | ${r.language ?? '—'} | ${fmtVerdict(r.aResolved)} | ${fmtVerdict(r.bResolved)} | ${fmtInt(r.aTokens)} | ${fmtInt(r.bTokens)} | ${fmtMins(r.aWallClockMs)} | ${fmtMins(r.bWallClockMs)} | ${r.aCompactions ?? '—'} | ${r.bAgentCount ?? '—'} | ${r.annotations.join(', ') || '—'} |`,
    );
  }
  return lines.join('\n');
}

function mdTaxonomy(json: ReportJson): string {
  const kinds = [...new Set([...Object.keys(json.taxonomy.a), ...Object.keys(json.taxonomy.b)])].sort();
  const lines = ['## Failure taxonomy', ''];
  if (kinds.length === 0) {
    lines.push('No failures recorded.');
  } else {
    lines.push('| failure | arm A | arm B |', '| --- | --- | --- |');
    for (const kind of kinds) {
      lines.push(`| ${kind} | ${json.taxonomy.a[kind] ?? 0} | ${json.taxonomy.b[kind] ?? 0} |`);
    }
  }
  lines.push('', '### Arm B annotations', '');
  const notes = Object.entries(json.armBAnnotations).sort(([x], [y]) => x.localeCompare(y));
  if (notes.length === 0) lines.push('None.');
  else for (const [note, count] of notes) lines.push(`- ${note}: ${count}`);
  return lines.join('\n');
}

function mdStratumRow(label: string, s: StratumStats): string {
  return `| ${label} | ${s.n} | ${s.aResolved} (${pctOf(s.aRate)}) | ${s.bResolved} (${pctOf(s.bRate)}) | ${fmtDelta(s.delta)} |`;
}

function mdThesisCut(json: ReportJson): string {
  const cut = json.thesisCut;
  const lines = [
    '## Thesis cut — long-context stratum',
    '',
    `Stratum criterion — ${cut.criterion}.`,
    '',
    '| stratum | n | A resolved | B resolved | Δ (B − A) |',
    '| --- | --- | --- | --- | --- |',
    mdStratumRow('inside (context pressure)', cut.inside),
    mdStratumRow('outside', cut.outside),
  ];
  if (cut.unclassified > 0) {
    lines.push('', `${cut.unclassified} paired instance(s) lack arm-A metrics and are unclassified.`);
  }
  return lines.join('\n');
}

function mdSanity(json: ReportJson): string | null {
  const { gold, nullcheck } = json.sanity;
  if (gold === null && nullcheck === null) return null;
  const lines = ['## Sanity evals', ''];
  if (gold !== null) lines.push(`- gold: ${gold.resolved}/${gold.evaluated} resolved (expected: all)`);
  if (nullcheck !== null) lines.push(`- nullcheck: ${nullcheck.resolved}/${nullcheck.evaluated} resolved (expected: none)`);
  return lines.join('\n');
}

function renderMd(json: ReportJson): string {
  const sections = [
    mdHeader(json),
    mdSummary(json),
    mdInstanceTable(json),
    mdTaxonomy(json),
    mdThesisCut(json),
    mdSanity(json),
  ].filter((s): s is string => s !== null);
  return `${sections.join('\n\n')}\n`;
}

/* --------------------------------------------------------------------- io -- */

function tryEvalResults(runId: string, prefix: string): Record<string, boolean> | null {
  try {
    return readEvalResults(runId, prefix);
  } catch {
    return null;
  }
}

function readJsonIfPresent<T>(path: string): T | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch {
    return null;
  }
}

function rolloutFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  const walk = (path: string): void => {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const child = join(path, entry.name);
      if (entry.isDirectory()) walk(child);
      else if (entry.isFile() && /^rollout-.*\.jsonl$/.test(entry.name)) out.push(child);
    }
  };
  walk(dir);
  return out.sort();
}

function modelDefault(dir: string, model: string): string | null {
  const cache = readJsonIfPresent<{ models?: unknown }>(join(dir, 'codex-home', 'models_cache.json'));
  if (!Array.isArray(cache?.models)) return null;
  for (const candidate of cache.models) {
    if (candidate === null || typeof candidate !== 'object') continue;
    const row = candidate as Record<string, unknown>;
    if (row.slug === model && typeof row.default_reasoning_level === 'string') {
      return row.default_reasoning_level;
    }
  }
  return null;
}

function rolloutEffort(file: string): string | null {
  let effort: string | null = null;
  let content: string;
  try {
    content = readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (parsed === null || typeof parsed !== 'object') continue;
    const record = parsed as Record<string, unknown>;
    if (record.type !== 'turn_context' || record.payload === null || typeof record.payload !== 'object') continue;
    const payload = record.payload as Record<string, unknown>;
    if (typeof payload.effort === 'string') {
      effort = payload.effort;
      continue;
    }
    const collaboration = payload.collaboration_mode;
    if (collaboration === null || typeof collaboration !== 'object') continue;
    const settings = (collaboration as Record<string, unknown>).settings;
    if (settings === null || typeof settings !== 'object') continue;
    const nested = (settings as Record<string, unknown>).reasoning_effort;
    if (typeof nested === 'string') effort = nested;
  }
  return effort;
}

function reasoningEffortFromDisk(manifest: RunManifest): ReasoningEffortAudit {
  const requested = manifest.config.effort || null;
  const defaults = new Set<string>();
  const sessions: ReasoningEffortAudit['sessions'] = { a: {}, b: {} };
  for (const iid of manifest.instanceIds) {
    for (const arm of ['a', 'b'] as const) {
      const dir = armDir(manifest.runId, iid, arm);
      const fallback = modelDefault(dir, manifest.config.model);
      if (fallback !== null) defaults.add(fallback);
      for (const file of rolloutFiles(join(dir, 'codex-home', 'sessions'))) {
        const effective = rolloutEffort(file) ?? requested ?? fallback ?? 'unknown';
        sessions[arm][effective] = (sessions[arm][effective] ?? 0) + 1;
      }
    }
  }
  return { requested, modelDefaults: [...defaults].sort(), sessions };
}

/** repo_language by instance id from the instances cache; empty map when absent. */
function languageMap(): Map<string, string> {
  const map = new Map<string, string>();
  const parsed = readJsonIfPresent<unknown>(instancesFile());
  const rows = Array.isArray(parsed) ? parsed : (parsed as { instances?: unknown } | null)?.instances;
  if (!Array.isArray(rows)) return map;
  for (const row of rows as BenchInstance[]) map.set(row.instanceId, row.repoLanguage);
  return map;
}

/** Failures the agent could have avoided — pre-registered as losses, not exclusions. */
const AGENT_AVOIDABLE_LOSSES = new Set<FailureKind>([
  'empty-patch', 'patch-too-large', 'unapplyable-diff', 'timeout', 'agent-crash', 'unmerged-workspace',
]);

/**
 * The verdict an instance x arm contributes to the primary rates. Once an
 * arm's eval has run (verdicts non-null), an instance the harness never scored
 * because the agent produced no usable patch counts as a LOSS — dropping it
 * would inflate whichever arm fails to patch. Infra failures stay null and
 * drop the pair, per the taxonomy in types.ts.
 */
export function effectiveResolved(
  verdicts: Record<string, boolean> | null,
  iid: string,
  status: ArmStatus | null,
): boolean | null {
  const v = verdicts?.[iid];
  if (v !== undefined) return v;
  if (verdicts === null) return null;
  if (status?.failure && AGENT_AVOIDABLE_LOSSES.has(status.failure)) return false;
  return null;
}

function armInputsFromDisk(
  runId: string,
  iid: string,
  arm: Arm,
  verdicts: Record<string, boolean> | null,
): ArmInputs {
  const dir = armDir(runId, iid, arm);
  const status = readStatus(dir);
  return {
    status,
    metrics: readJsonIfPresent<ArmMetrics>(join(dir, 'metrics.json')),
    resolved: effectiveResolved(verdicts, iid, status),
  };
}

/** Read a run's on-disk state, aggregate it, and write report.json + report.md. */
export function generateReport(runId: string): { jsonPath: string; mdPath: string } {
  const manifest = readJsonIfPresent<RunManifest>(runManifestFile(runId));
  if (manifest === null) {
    throw new Error(
      `no readable run manifest at ${runManifestFile(runId)} — has \`npm run bench -- --suite swebench-pro run\` been started for ${runId}?`,
    );
  }
  const languages = languageMap();
  const evalA = tryEvalResults(runId, 'armA');
  const evalB = tryEvalResults(runId, 'armB');
  const instances: InstanceInputs[] = manifest.instanceIds.map((iid) => ({
    instanceId: iid,
    language: languages.get(iid) ?? null,
    a: armInputsFromDisk(runId, iid, 'a', evalA),
    b: armInputsFromDisk(runId, iid, 'b', evalB),
  }));
  const { json, md } = buildReport({
    manifest,
    instances,
    gold: tryEvalResults(runId, 'gold'),
    nullcheck: tryEvalResults(runId, 'nullcheck'),
    reasoningEffort: reasoningEffortFromDisk(manifest),
  });
  const jsonPath = join(runDir(runId), 'report.json');
  const mdPath = join(runDir(runId), 'report.md');
  writeFileSync(jsonPath, `${JSON.stringify(json, null, 2)}\n`);
  writeFileSync(mdPath, md);
  return { jsonPath, mdPath };
}
