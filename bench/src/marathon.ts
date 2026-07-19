/**
 * SWE-Marathon integration for reproducible Harbor A/B trials. Planning is
 * pure and deliberately excludes the child environment, while the executable
 * helpers pin the upstream checkout and pass authentication only at spawn time.
 */
import { execFile } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { BENCH_ROOT, loadConfig } from './config.js';
import {
  allowlistedEnvironment,
  runOwnedProcess,
  sha256File,
  sha256Tree,
  validatePortableComponent,
} from './external-common.js';
import { prepareToolchain } from './toolchain.js';

export type MarathonArm = 'a' | 'b';

export const SWE_MARATHON_REPO = 'https://github.com/abundant-ai/swe-marathon.git';
export const SWE_MARATHON_PIN = '6d6855af390226f6eca607d63818fe076e57ea8c';
export const SWE_MARATHON_PYTHON = '3.13.5';
export const SWE_MARATHON_HARBOR = '0.17.1';

/** Tasks whose CUA verifier was not run in the source experiment. */
export const EXCLUDED_CUA_TASKS = [
  'excel-clone',
  'mastodon-clone',
  's3-clone',
  'slack-clone',
] as const;

/** Post-hoc cohort selected from Arm A for unusually high context pressure. */
export const CONTEXT_PRESSURE_STRESS_TASKS = [
  'find-network-alignments',
  'kubernetes-rust-rewrite',
  'nextjs-vite-rewrite',
  'rust-java-lsp',
] as const;

export const SWE_MARATHON_TASKS = [
  'biofabric-rust-rewrite',
  'embedding-eval',
  'excel-clone',
  'find-network-alignments',
  'jax-pytorch-rewrite',
  'kubernetes-rust-rewrite',
  'mastodon-clone',
  'nextjs-vite-rewrite',
  'parameter-golf',
  'post-train-ifeval-gpu',
  'ruby-rust-port',
  'rust-c-compiler',
  'rust-java-lsp',
  's3-clone',
  'slack-clone',
  'stripe-clone',
  'trimul-cuda',
  'vliw-kernel-optimization',
  'wasm-simd',
  'zstd-decoder',
] as const;

const TASK_NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const TASK_SET = new Set<string>(SWE_MARATHON_TASKS);
const CUA_TASK_SET = new Set<string>(EXCLUDED_CUA_TASKS);
const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
const WORKSPACE_ROOT = resolve(BENCH_ROOT, '..');
const DEFAULT_BRIDGE_DIR = resolve(MODULE_DIR, '../external/swe-marathon');
const execFileAsync = promisify(execFile);

export interface MarathonPaths {
  repoDir: string;
  resultsDir: string;
  toolchainDir: string;
  bridgeDir: string;
  skillDir: string;
}

export interface MarathonPathOptions {
  repoDir?: string;
  resultsDir?: string;
  toolchainDir?: string;
  bridgeDir?: string;
  skillDir?: string;
}

export interface ArgvPlan {
  file: string;
  argv: string[];
  cwd?: string;
}

export interface MarathonMount {
  type: 'bind';
  source: string;
  target: string;
  read_only: true;
}

export interface MarathonPrepOptions extends MarathonPathOptions {
  uvBin?: string;
  prepareBenchToolchain?: boolean;
}

export interface MarathonPrepPlan {
  repo: string;
  pin: string;
  python: string;
  harbor: string;
  paths: MarathonPaths;
  clone: ArgvPlan;
  fetch: ArgvPlan;
  checkout: ArgvPlan;
  sync: ArgvPlan;
  verifyPin: ArgvPlan;
  verifyPython: ArgvPlan;
  verifyHarbor: ArgvPlan;
  prepareBenchToolchain: boolean;
}

export interface MarathonRunOptions extends MarathonPathOptions {
  taskName: string;
  arm: MarathonArm;
  model?: string;
  effort?: string;
  jobName?: string;
  harborBin?: string;
  workflowWaitSeconds?: number;
  /** Resume an existing native Harbor job with its frozen configuration. */
  resume?: boolean;
}

export interface MarathonRunPlan {
  taskName: string;
  arm: MarathonArm;
  model: string;
  effort: string;
  jobName: string;
  officialVerification: true;
  attempts: 1;
  retries: 0;
  concurrentTrials: 1;
  mounts: MarathonMount[];
  command: ArgvPlan;
  paths: MarathonPaths;
}

export interface MarathonRunResult extends MarathonRunPlan {
  /** Exact Harbor-authored trial result used as verifier authority. */
  verifierResultPath: string;
}

export interface MarathonProvenance {
  sourceRevision: string;
  pythonVersion: string;
  pythonSha256: string;
  harborVersion: string;
  harborSha256: string;
  environmentSha256: string;
  taskConfigSha256: string;
  taskImage: string;
  bridgeSha256: string | null;
  skillSha256: string | null;
}

/** Resolve all host paths without consulting the filesystem. */
export function resolveMarathonPaths(
  options: MarathonPathOptions = {},
  env: NodeJS.ProcessEnv = {},
): MarathonPaths {
  return {
    repoDir: resolve(options.repoDir ?? env.SWE_MARATHON_REPO_DIR ?? join(BENCH_ROOT, '.cache/swe-marathon')),
    resultsDir: resolve(options.resultsDir ?? env.SWE_MARATHON_RESULTS_DIR ?? join(BENCH_ROOT, 'results/swe-marathon')),
    toolchainDir: resolve(options.toolchainDir ?? env.SWE_MARATHON_TOOLCHAIN_DIR ?? join(BENCH_ROOT, '.cache/toolchain')),
    bridgeDir: resolve(options.bridgeDir ?? env.SWE_MARATHON_BRIDGE_DIR ?? DEFAULT_BRIDGE_DIR),
    skillDir: resolve(options.skillDir ?? env.SWE_MARATHON_SKILL_DIR ?? join(WORKSPACE_ROOT, 'skill/ultracode')),
  };
}

/** Reject path-like, unknown, and deliberately excluded unverified task ids. */
export function validateMarathonTaskName(taskName: string): string {
  if (!TASK_NAME_RE.test(taskName)) {
    throw new Error(`unsafe SWE-Marathon task name '${taskName}'`);
  }
  if (!TASK_SET.has(taskName)) {
    throw new Error(`unknown SWE-Marathon task '${taskName}' at pin ${SWE_MARATHON_PIN}`);
  }
  if (CUA_TASK_SET.has(taskName)) {
    throw new Error(`SWE-Marathon task '${taskName}' is excluded because its CUA result is unverified`);
  }
  return taskName;
}

function required(name: string, value: string | undefined): string {
  if (!value?.trim()) throw new Error(`${name} is required (pass it as an argument or child environment variable)`);
  if (value.includes('\0')) throw new Error(`${name} must not contain a NUL byte`);
  return value;
}

function positiveInteger(name: string, value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
  return value;
}

/** Build the deterministic checkout and Python environment command plan. */
export function planMarathonPrep(
  options: MarathonPrepOptions = {},
  env: NodeJS.ProcessEnv = {},
): MarathonPrepPlan {
  const paths = resolveMarathonPaths(options, env);
  const uv = required('uv binary', options.uvBin ?? env.SWE_MARATHON_UV_BIN ?? 'uv');
  const venvBin = join(paths.repoDir, '.venv/bin');
  return {
    repo: SWE_MARATHON_REPO,
    pin: SWE_MARATHON_PIN,
    python: SWE_MARATHON_PYTHON,
    harbor: SWE_MARATHON_HARBOR,
    paths,
    clone: {
      file: 'git',
      argv: ['clone', '--filter=blob:none', '--no-checkout', SWE_MARATHON_REPO, paths.repoDir],
    },
    fetch: {
      file: 'git',
      argv: ['-C', paths.repoDir, 'fetch', '--depth=1', 'origin', SWE_MARATHON_PIN],
    },
    checkout: {
      file: 'git',
      argv: ['-C', paths.repoDir, 'checkout', '--detach', SWE_MARATHON_PIN],
    },
    sync: {
      file: uv,
      argv: ['sync', '--python', SWE_MARATHON_PYTHON, '--frozen'],
      cwd: paths.repoDir,
    },
    verifyPin: { file: 'git', argv: ['-C', paths.repoDir, 'rev-parse', 'HEAD'] },
    verifyPython: { file: join(venvBin, 'python'), argv: ['--version'] },
    verifyHarbor: { file: join(venvBin, 'harbor'), argv: ['--version'] },
    prepareBenchToolchain: options.prepareBenchToolchain ?? true,
  };
}

function mount(source: string, target: string): MarathonMount {
  return { type: 'bind', source, target, read_only: true };
}

/** Build one official-verification Harbor trial; no secret is part of the plan. */
export function planMarathonRun(
  options: MarathonRunOptions,
  env: NodeJS.ProcessEnv = {},
): MarathonRunPlan {
  const taskName = validateMarathonTaskName(options.taskName);
  if (options.arm !== 'a' && options.arm !== 'b') throw new Error(`invalid SWE-Marathon arm '${String(options.arm)}'`);
  const model = required('SWE-Marathon model', options.model ?? env.SWE_MARATHON_MODEL);
  const effort = required('SWE-Marathon effort', options.effort ?? env.SWE_MARATHON_EFFORT);
  const paths = resolveMarathonPaths(options, env);
  const jobName = validatePortableComponent(
    required('SWE-Marathon job name', options.jobName ?? env.SWE_MARATHON_JOB_NAME ?? `${taskName}-arm-${options.arm}`),
    'SWE-Marathon job name',
  );
  const harborBin = options.harborBin ?? env.SWE_MARATHON_HARBOR_BIN ?? join(paths.repoDir, '.venv/bin/harbor');
  const mounts = [mount(join(paths.toolchainDir, 'codex'), '/usr/local/bin/codex')];
  if (options.arm === 'b') {
    mounts.push(
      mount(join(paths.toolchainDir, 'node-sel'), '/opt/bench/node-sel'),
      mount(join(paths.toolchainDir, 'node'), '/opt/bench/node'),
      mount(join(paths.toolchainDir, 'node-musl'), '/opt/bench/node-musl'),
      mount(join(paths.toolchainDir, 'node-musl-runtime'), '/opt/bench/node-musl-runtime'),
      mount(join(paths.toolchainDir, 'ultracode'), '/opt/bench/ultracode'),
    );
  }

  const argv = options.resume ? [
    'job',
    'resume',
    '--path', join(paths.resultsDir, jobName),
  ] : [
    'run',
    '--path', 'tasks',
    '--include-task-name', taskName,
    '--agent', options.arm === 'a' ? 'codex' : 'arm_b_codex:ArmBCodex',
    '--model', model,
    '--agent-kwarg', `reasoning_effort=${effort}`,
    '--agent-kwarg', 'web_search=disabled',
  ];
  if (!options.resume && options.arm === 'b') {
    const workflowWaitSeconds = positiveInteger(
      'workflowWaitSeconds',
      options.workflowWaitSeconds ?? Number(env.SWE_MARATHON_WORKFLOW_WAIT_SECONDS ?? 3_300),
    );
    argv.push(
      '--agent-kwarg', `workflow_wait_seconds=${workflowWaitSeconds}`,
      '--skill', paths.skillDir,
    );
  }
  if (!options.resume) argv.push(
    '--allow-agent-host', 'api.openai.com',
    '--allow-agent-host', 'chatgpt.com',
    '--allow-agent-host', 'auth.openai.com',
    '--env', 'docker',
    '--mounts', JSON.stringify(mounts),
    '--n-concurrent', '1',
    '--n-concurrent-agents', '1',
    '--n-attempts', '1',
    '--max-retries', '0',
    '--jobs-dir', paths.resultsDir,
    '--job-name', jobName,
    '--yes',
  );

  return {
    taskName,
    arm: options.arm,
    model,
    effort,
    jobName,
    officialVerification: true,
    attempts: 1,
    retries: 0,
    concurrentTrials: 1,
    mounts,
    command: { file: harborBin, argv, cwd: paths.repoDir },
    paths,
  };
}

async function execute(plan: ArgvPlan, sourceEnv: NodeJS.ProcessEnv = process.env): Promise<string> {
  try {
    const { stdout, stderr } = await execFileAsync(plan.file, plan.argv, {
      cwd: plan.cwd,
      env: allowlistedEnvironment(sourceEnv),
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    });
    return `${stdout}${stderr}`.trim();
  } catch (err) {
    const failure = err as { stderr?: string; message?: string };
    throw new Error(`${plan.file} failed: ${failure.stderr?.trim() || failure.message || String(err)}`);
  }
}

/** Prepare the pinned suite and the existing bench toolchain idempotently. */
export async function prepareMarathon(
  options: MarathonPrepOptions = {},
  env: NodeJS.ProcessEnv = process.env,
): Promise<MarathonPrepPlan> {
  if (process.platform !== 'linux' || process.arch !== 'x64') {
    throw new Error(`SWE-Marathon requires a Linux x64 host, got ${process.platform}-${process.arch}`);
  }
  const plan = planMarathonPrep(options, env);
  const daemonPlatform = await execute({
    file: 'docker',
    argv: ['info', '--format', '{{.OSType}}/{{.Architecture}}'],
  }, env);
  if (daemonPlatform !== 'linux/x86_64' && daemonPlatform !== 'linux/amd64') {
    throw new Error(`SWE-Marathon requires a Linux amd64 Docker daemon, got ${daemonPlatform || '(empty)'}`);
  }
  if (plan.prepareBenchToolchain) await prepareToolchain(loadConfig());

  if (!existsSync(join(plan.paths.repoDir, '.git'))) {
    if (existsSync(plan.paths.repoDir)) {
      throw new Error(`SWE-Marathon repo path exists but is not a git checkout: ${plan.paths.repoDir}`);
    }
    mkdirSync(dirname(plan.paths.repoDir), { recursive: true });
    await execute(plan.clone, env);
  } else {
    const origin = await execute({
      file: 'git',
      argv: ['-C', plan.paths.repoDir, 'remote', 'get-url', 'origin'],
    }, env);
    if (origin.replace(/\/$/, '') !== SWE_MARATHON_REPO) {
      throw new Error(`SWE-Marathon origin mismatch: expected ${SWE_MARATHON_REPO}, got ${origin}`);
    }
    const dirty = await execute({
      file: 'git',
      argv: ['-C', plan.paths.repoDir, 'status', '--porcelain', '--untracked-files=all'],
    }, env);
    if (dirty) throw new Error(`SWE-Marathon checkout has tracked or untracked changes: ${plan.paths.repoDir}`);
  }

  await execute(plan.fetch, env);
  await execute(plan.checkout, env);
  await execute(plan.sync, env);
  const head = await execute(plan.verifyPin, env);
  if (head !== SWE_MARATHON_PIN) throw new Error(`SWE-Marathon pin mismatch after prep: ${head}`);
  const python = await execute(plan.verifyPython, env);
  if (python !== `Python ${SWE_MARATHON_PYTHON}`) throw new Error(`expected Python ${SWE_MARATHON_PYTHON}, got ${python}`);
  const harbor = await execute(plan.verifyHarbor, env);
  if (harbor !== SWE_MARATHON_HARBOR) throw new Error(`expected Harbor ${SWE_MARATHON_HARBOR}, got ${harbor}`);
  for (const taskName of SWE_MARATHON_TASKS) {
    if (CUA_TASK_SET.has(taskName)) continue;
    const taskConfig = readFileSync(join(plan.paths.repoDir, 'tasks', taskName, 'task.toml'), 'utf8');
    await execute({ file: 'docker', argv: ['pull', taskImageReference(taskConfig)] }, env);
  }
  return plan;
}

function verifyRunnablePlan(plan: MarathonRunPlan): void {
  const requiredPaths = [
    plan.command.file,
    join(plan.paths.repoDir, 'tasks', plan.taskName, 'task.toml'),
    ...plan.mounts.map((entry) => entry.source),
  ];
  if (plan.arm === 'b') requiredPaths.push(join(plan.paths.bridgeDir, 'arm_b_codex.py'), plan.paths.skillDir);
  const missing = requiredPaths.filter((path) => !existsSync(path));
  if (missing.length) {
    throw new Error(
      `SWE-Marathon prep is incomplete; missing: ${missing.join(', ')} — run \`npm run bench -- --suite swe-marathon prep\``,
    );
  }
}

function privateResultsDirectory(path: string): void {
  const resolved = resolve(path);
  if (existsSync(resolved)) {
    const info = lstatSync(resolved);
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new Error(`SWE-Marathon resultsDir must be a real directory: ${resolved}`);
    }
  } else {
    mkdirSync(resolved, { recursive: true, mode: 0o700 });
  }
  chmodSync(resolved, 0o700);
}

function taskImageReference(taskConfig: string): string {
  const match = /^docker_image\s*=\s*"([^"\r\n]+)"\s*$/mu.exec(taskConfig);
  if (!match) throw new Error('SWE-Marathon task must declare environment.docker_image for digest pinning');
  const image = match[1]!;
  if (!/^[^\s@]+@sha256:[0-9a-f]{64}$/u.test(image)) {
    throw new Error('SWE-Marathon task image must already be an immutable sha256 digest at the pinned source revision');
  }
  return image;
}

/** Re-attest the pinned checkout, toolchain-facing bridge, and task image. */
export async function preflightMarathon(
  options: MarathonRunOptions,
  env: NodeJS.ProcessEnv = process.env,
): Promise<MarathonProvenance> {
  if (process.platform !== 'linux' || process.arch !== 'x64') {
    throw new Error(`SWE-Marathon requires a Linux x64 host, got ${process.platform}-${process.arch}`);
  }
  const plan = planMarathonRun(options, env);
  verifyRunnablePlan(plan);
  if (plan.arm === 'b') {
    const skillInfo = lstatSync(plan.paths.skillDir);
    if (skillInfo.isSymbolicLink() || !skillInfo.isDirectory()) {
      throw new Error(`SWE-Marathon skillDir must be a real directory: ${plan.paths.skillDir}`);
    }
  }
  const head = await execute({ file: 'git', argv: ['-C', plan.paths.repoDir, 'rev-parse', 'HEAD'] }, env);
  if (head !== SWE_MARATHON_PIN) throw new Error(`SWE-Marathon source pin mismatch: ${head}`);
  const origin = await execute({
    file: 'git',
    argv: ['-C', plan.paths.repoDir, 'remote', 'get-url', 'origin'],
  }, env);
  if (origin.replace(/\/$/u, '') !== SWE_MARATHON_REPO) {
    throw new Error(`SWE-Marathon origin mismatch: expected ${SWE_MARATHON_REPO}, got ${origin}`);
  }
  const dirty = await execute({
    file: 'git',
    argv: ['-C', plan.paths.repoDir, 'status', '--porcelain', '--untracked-files=all'],
  }, env);
  if (dirty) throw new Error(`SWE-Marathon checkout has tracked or untracked drift: ${plan.paths.repoDir}`);
  const daemonPlatform = await execute({
    file: 'docker',
    argv: ['info', '--format', '{{.OSType}}/{{.Architecture}}'],
  }, env);
  if (daemonPlatform !== 'linux/x86_64' && daemonPlatform !== 'linux/amd64') {
    throw new Error(`SWE-Marathon requires a Linux amd64 Docker daemon, got ${daemonPlatform || '(empty)'}`);
  }
  const pythonVersion = await execute({
    file: join(plan.paths.repoDir, '.venv/bin/python'),
    argv: ['--version'],
  }, env);
  if (pythonVersion !== `Python ${SWE_MARATHON_PYTHON}`) {
    throw new Error(`expected Python ${SWE_MARATHON_PYTHON}, got ${pythonVersion}`);
  }
  const harborVersion = await execute({ file: plan.command.file, argv: ['--version'] }, env);
  if (harborVersion !== SWE_MARATHON_HARBOR) {
    throw new Error(`expected Harbor ${SWE_MARATHON_HARBOR}, got ${harborVersion}`);
  }
  const taskConfigPath = join(plan.paths.repoDir, 'tasks', plan.taskName, 'task.toml');
  const taskConfig = readFileSync(taskConfigPath, 'utf8');
  const taskImage = taskImageReference(taskConfig);
  const imageDigest = await execute({
    file: 'docker',
    argv: ['image', 'inspect', '--format', '{{ index .RepoDigests 0 }}', taskImage],
  }, env);
  if (!/^[^\s@]+@sha256:[0-9a-f]{64}$/u.test(imageDigest)) {
    throw new Error(
      `SWE-Marathon image ${taskImage} is not locally resolved to one immutable digest; rerun \`npm run bench -- --suite swe-marathon prep\``,
    );
  }
  if (imageDigest !== taskImage) {
    throw new Error(`SWE-Marathon local image identity drifted: expected ${taskImage}, got ${imageDigest}`);
  }
  return {
    sourceRevision: head,
    pythonVersion,
    pythonSha256: sha256File(join(plan.paths.repoDir, '.venv/bin/python')),
    harborVersion,
    harborSha256: sha256File(plan.command.file),
    environmentSha256: sha256Tree(
      join(plan.paths.repoDir, '.venv'),
      { excludePythonCacheArtifacts: true },
    ),
    taskConfigSha256: sha256File(taskConfigPath),
    taskImage: imageDigest,
    bridgeSha256: plan.arm === 'b' ? sha256File(join(plan.paths.bridgeDir, 'arm_b_codex.py')) : null,
    skillSha256: plan.arm === 'b' ? sha256Tree(plan.paths.skillDir) : null,
  };
}

function harborTrialResult(jobRoot: string): string {
  const candidates = readdirSync(jobRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(jobRoot, entry.name, 'result.json'))
    .filter((path) => existsSync(path));
  if (candidates.length !== 1) {
    throw new Error(`expected one exact Harbor trial result under ${jobRoot}, found ${candidates.length}`);
  }
  const result = candidates[0]!;
  const info = lstatSync(result);
  if (info.isSymbolicLink() || !info.isFile()) throw new Error(`Harbor trial result must be a regular file: ${result}`);
  return result;
}

function objectRecord(value: unknown, field: string): Record<string, unknown> {
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  throw new Error(`existing Harbor job config must define object field ${field}`);
}

/** Validate the immutable Harbor 0.17.1 trial inputs before native resume. */
export function validateHarborResumeConfig(jobRoot: string, plan: MarathonRunPlan): void {
  const configPath = join(jobRoot, 'config.json');
  const info = lstatSync(configPath);
  if (info.isSymbolicLink() || !info.isFile()) throw new Error(`Harbor resume config must be a regular file: ${configPath}`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(configPath, 'utf8')) as unknown;
  } catch (error) {
    throw new Error(`Harbor resume config must be valid JSON: ${configPath}`, { cause: error });
  }
  const config = objectRecord(parsed, 'config');
  const task = objectRecord(config.task, 'task');
  const agent = objectRecord(config.agent, 'agent');
  const kwargs = objectRecord(agent.kwargs, 'agent.kwargs');
  const expectedAgent = plan.arm === 'a' ? 'codex' : 'arm_b_codex:ArmBCodex';
  const fields = [
    ['task.path', task.path, join('tasks', plan.taskName)],
    ['agent.name', agent.name, expectedAgent],
    ['agent.model_name', agent.model_name, plan.model],
    ['agent.kwargs.reasoning_effort', kwargs.reasoning_effort, plan.effort],
  ] as const;
  for (const [field, actual, expected] of fields) {
    if (actual !== expected) {
      throw new Error(
        `existing Harbor job config field ${field} does not match immutable run input: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
      );
    }
  }
}

/** Build Harbor's minimal runtime environment and validate path-based auth. */
export function marathonChildEnvironment(
  source: NodeJS.ProcessEnv,
  bridgeDir: string,
  arm: MarathonArm,
  runtimeHome: string,
): NodeJS.ProcessEnv {
  if (source.CODEX_AUTH_JSON_PATH !== undefined && source.OPENAI_API_KEY !== undefined) {
    throw new Error('SWE-Marathon auth is ambiguous; select only CODEX_AUTH_JSON_PATH or OPENAI_API_KEY');
  }
  const authName = source.CODEX_AUTH_JSON_PATH !== undefined
    ? 'CODEX_AUTH_JSON_PATH'
    : source.OPENAI_API_KEY !== undefined ? 'OPENAI_API_KEY' : null;
  if (authName === null) {
    throw new Error('SWE-Marathon requires exactly one selected auth mechanism: CODEX_AUTH_JSON_PATH or OPENAI_API_KEY');
  }
  const env = allowlistedEnvironment(source, [authName]);
  if (authName === 'CODEX_AUTH_JSON_PATH') {
    const authPath = resolve(required('CODEX_AUTH_JSON_PATH', source.CODEX_AUTH_JSON_PATH));
    const info = lstatSync(authPath);
    if (info.isSymbolicLink() || !info.isFile()) {
      throw new Error(`CODEX_AUTH_JSON_PATH must be a regular file: ${authPath}`);
    }
    env.CODEX_AUTH_JSON_PATH = authPath;
  }
  env.HOME = runtimeHome;
  env.XDG_CONFIG_HOME = join(runtimeHome, '.config');
  env.HARBOR_TELEMETRY = 'off';
  env.PYTHONDONTWRITEBYTECODE = '1';
  if (arm === 'b') env.PYTHONPATH = bridgeDir;
  return env;
}

/** Spawn Harbor for one task and inherit auth only through the child process. */
export async function runMarathon(
  options: MarathonRunOptions,
  childEnv: NodeJS.ProcessEnv = process.env,
  beforeLaunch?: () => Promise<void>,
): Promise<MarathonRunResult> {
  await preflightMarathon(options, childEnv);
  const initialPlan = planMarathonRun(options, childEnv);
  privateResultsDirectory(initialPlan.paths.resultsDir);
  const jobRoot = join(initialPlan.paths.resultsDir, initialPlan.jobName);
  if (existsSync(jobRoot)) {
    const existingJob = lstatSync(jobRoot);
    if (existingJob.isSymbolicLink() || !existingJob.isDirectory()) {
      throw new Error(`existing Harbor job root must be a real directory: ${jobRoot}`);
    }
    validateHarborResumeConfig(jobRoot, initialPlan);
  }
  const plan = existsSync(jobRoot)
    ? planMarathonRun({ ...options, resume: true }, childEnv)
    : initialPlan;
  const runtimeHome = mkdtempSync(join(tmpdir(), 'uc-marathon-home-'));
  chmodSync(runtimeHome, 0o700);
  try {
    const env = marathonChildEnvironment(childEnv, plan.paths.bridgeDir, plan.arm, runtimeHome);
    await beforeLaunch?.();
    await runOwnedProcess(plan.command.file, plan.command.argv, {
      cwd: plan.command.cwd,
      env,
      stream: true,
    });
  } finally {
    rmSync(runtimeHome, { recursive: true, force: true });
  }
  const jobInfo = lstatSync(jobRoot);
  if (jobInfo.isSymbolicLink() || !jobInfo.isDirectory()) {
    throw new Error(`Harbor job root must be a real directory: ${jobRoot}`);
  }
  chmodSync(jobRoot, 0o700);
  return { ...plan, verifierResultPath: harborTrialResult(jobRoot) };
}
