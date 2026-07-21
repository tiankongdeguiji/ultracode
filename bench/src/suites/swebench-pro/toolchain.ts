/** Content-addressed preparation of the pinned official Pro evaluator. */
import { randomBytes } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  realpathSync,
  renameSync,
  rmSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import type { BenchPathRoots } from '../../shared/contracts.js';
import type { RuntimeBindings, ToolchainConfig } from '../../shared/config.js';
import {
  ensureRealDirectoryWithin,
  readPrivateJson,
  readRegularFileWithinRoot,
  writePrivateFileAtomic,
  writePrivateJsonAtomic,
} from '../../shared/paths.js';
import { runBenchProcess } from '../../shared/process.js';
import {
  canonicalJson,
  publicLocatorSchema,
  sha256CanonicalJson,
  sha256File,
  sha256Schema,
  sha256Tree,
  type SourceProvenance,
} from '../../shared/provenance.js';
import {
  loadPreparedToolchain,
  prepareSharedToolchain,
  type PreparedToolchain,
  type ToolchainNativeAsset,
} from '../../shared/toolchain.js';
import {
  suiteCacheDir,
  swebenchProCurrentFile,
  swebenchProPreparedDir,
  type SwebenchProConfig,
} from './config.js';

const SPARSE_PATHS = ['/swe_bench_pro_eval.py', '/requirements.txt', '/helper_code', '/run_scripts', '/dockerfiles'];
const CONTENT_MANIFEST = 'content-manifest.json';
const PREPARED_IDENTITY = 'prepared-identity.json';
const RESOLVED_REQUIREMENTS = 'resolved-requirements.lock';
const REQUIREMENTS_LOCK = 'suites/swebench-pro/evaluator-requirements.lock';
const REQUIREMENTS_PROVENANCE = 'suites/swebench-pro/evaluator-requirements.provenance.json';
export const SWEBENCH_PRO_TOOLCHAIN_NATIVE_ASSETS = [
  'entrypoint.sh',
  'session-gate.sh',
  'sanitize-git.sh',
  'capture-git.sh',
].map((destination): ToolchainNativeAsset => ({
  source: `suites/swebench-pro/${destination}`,
  destination,
}));
export const EVALUATOR_DEPENDENCY_PROVENANCE_SHA256 =
  'd9789a12b88dd5faf478d3fbca502e98e9ba7a048523d4cbfe575e5121881ba9';

const packageNameSchema = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
const targetIdSchema = z.string().regex(/^cpython-3\.11-(?:linux|macos)-(?:arm64|x64)-pip-24\.2$/);
const dependencyTargetSchema = z.strictObject({
  id: targetIdSchema,
  implementation: z.literal('cpython'),
  pythonMinor: z.literal('3.11'),
  os: z.enum(['linux', 'macos']),
  architecture: z.enum(['arm64', 'x64']),
  pipVersion: z.literal('24.2'),
  libc: z.enum(['glibc', 'none']),
  minimumOsVersion: z.string().regex(/^\d+(?:\.\d+)+$/),
});
const dependencyRequirementSchema = z.strictObject({
  name: packageNameSchema,
  specifier: z.string().min(1),
});
const dependencyArtifactSchema = z.strictObject({
  filename: z.string().min(1),
  sha256: sha256Schema,
  targets: z.array(targetIdSchema).min(1),
});
const dependencyPackageSchema = z.strictObject({
  name: packageNameSchema,
  version: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9.!+_-]*$/),
  source: z.string().url(),
  requires: z.array(dependencyRequirementSchema),
  artifacts: z.array(dependencyArtifactSchema).min(1),
});
const evaluatorDependencyProvenanceSchema = z.strictObject({
  schemaVersion: z.literal(1),
  kind: z.literal('ultracode-swebench-pro-evaluator-dependencies'),
  audit: z.strictObject({
    reviewedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    primaryIndex: z.literal('https://pypi.org/'),
    metadataUrlTemplate: z.literal('https://pypi.org/pypi/{name}/{version}/json'),
    resolverPipVersion: z.literal('24.2'),
  }),
  targets: z.array(dependencyTargetSchema).min(1),
  roots: z.array(packageNameSchema).min(1),
  inactiveRequirements: z.array(z.strictObject({
    parent: packageNameSchema,
    name: packageNameSchema,
    specifier: z.string().min(1),
    marker: z.string().min(1),
  })),
  packages: z.array(dependencyPackageSchema).min(1),
});
const evaluatorHostSchema = z.strictObject({
  implementation: z.string().min(1),
  pythonMinor: z.string().min(1),
  os: z.string().min(1),
  architecture: z.string().min(1),
  pipVersion: z.string().min(1),
  libc: z.string().min(1),
  osVersion: z.string().min(1),
});
const SUPPORTED_EVALUATOR_DEPENDENCY_TARGETS = [
  {
    id: 'cpython-3.11-macos-arm64-pip-24.2',
    implementation: 'cpython',
    pythonMinor: '3.11',
    os: 'macos',
    architecture: 'arm64',
    pipVersion: '24.2',
    libc: 'none',
    minimumOsVersion: '11.0',
  },
  {
    id: 'cpython-3.11-macos-x64-pip-24.2',
    implementation: 'cpython',
    pythonMinor: '3.11',
    os: 'macos',
    architecture: 'x64',
    pipVersion: '24.2',
    libc: 'none',
    minimumOsVersion: '10.9',
  },
  {
    id: 'cpython-3.11-linux-arm64-pip-24.2',
    implementation: 'cpython',
    pythonMinor: '3.11',
    os: 'linux',
    architecture: 'arm64',
    pipVersion: '24.2',
    libc: 'glibc',
    minimumOsVersion: '2.28',
  },
  {
    id: 'cpython-3.11-linux-x64-pip-24.2',
    implementation: 'cpython',
    pythonMinor: '3.11',
    os: 'linux',
    architecture: 'x64',
    pipVersion: '24.2',
    libc: 'glibc',
    minimumOsVersion: '2.28',
  },
] as const;

function wheelTargets(filename: string): string[] {
  const match = filename.match(/-([A-Za-z0-9.]+)-(none|cp311)-([A-Za-z0-9_.]+)\.whl$/u);
  if (match === null) return [];
  const [, pythonTag = '', abiTag, platformTags = ''] = match;
  if (pythonTag.split('.').includes('py3') && abiTag === 'none' && platformTags === 'any') {
    return SUPPORTED_EVALUATOR_DEPENDENCY_TARGETS.map((target) => target.id);
  }
  if (pythonTag !== 'cp311' || abiTag !== 'cp311') return [];
  const compatible = new Set<string>();
  for (const platformTag of platformTags.split('.')) {
    const macos = platformTag.match(/^macosx_(\d+)_(\d+)_(arm64|universal2|x86_64)$/u);
    if (macos !== null) {
      const floor = `${macos[1]}.${macos[2]}`;
      for (const target of SUPPORTED_EVALUATOR_DEPENDENCY_TARGETS) {
        const architectureMatches = macos[3] === 'universal2'
          || (macos[3] === 'arm64' && target.architecture === 'arm64')
          || (macos[3] === 'x86_64' && target.architecture === 'x64');
        if (target.os === 'macos' && architectureMatches
          && versionAtLeast(target.minimumOsVersion, floor)) compatible.add(target.id);
      }
      continue;
    }
    const manylinux = platformTag.match(/^manylinux_(\d+)_(\d+)_(aarch64|x86_64)$/u);
    const legacyManylinux = platformTag.match(/^manylinux2014_(aarch64|x86_64)$/u);
    if (manylinux !== null || legacyManylinux !== null) {
      const floor = manylinux === null ? '2.17' : `${manylinux[1]}.${manylinux[2]}`;
      const wheelArchitecture = manylinux?.[3] ?? legacyManylinux?.[1];
      const architecture = wheelArchitecture === 'aarch64' ? 'arm64' : 'x64';
      for (const target of SUPPORTED_EVALUATOR_DEPENDENCY_TARGETS) {
        if (target.os === 'linux' && target.architecture === architecture
          && versionAtLeast(target.minimumOsVersion, floor)) compatible.add(target.id);
      }
    }
  }
  return SUPPORTED_EVALUATOR_DEPENDENCY_TARGETS
    .map((target) => target.id)
    .filter((target) => compatible.has(target));
}

const preparedIdentitySchema = z.strictObject({
  schemaVersion: z.literal(3),
  kind: z.literal('ultracode-swebench-pro-prepared-inputs'),
  evaluatorRepository: publicLocatorSchema,
  evaluatorRevision: z.string().regex(/^[a-f0-9]{40}$/),
  evaluatorTreeSha256: sha256Schema,
  evaluatorEnvironmentTreeSha256: sha256Schema,
  evaluatorEnvironmentSha256: sha256Schema,
  pythonVersion: z.string().min(1),
  pythonBinarySha256: sha256Schema,
  evaluatorDependencyTarget: targetIdSchema,
  requirementsSha256: sha256Schema,
  requirementsProvenanceSha256: sha256Schema,
  resolvedRequirementsSha256: sha256Schema,
  ownershipPatchSha256: sha256Schema,
  evaluatorPolicyHelperSha256: sha256Schema,
  containerPolicyFileSha256: sha256Schema,
  toolchainPayloadSha256: sha256Schema,
});

const preparedContentManifestSchema = preparedIdentitySchema.extend({
  payloadSha256: sha256Schema,
}).strict();

type PreparedIdentity = z.infer<typeof preparedIdentitySchema>;
type EvaluatorDependencyProvenance = z.infer<typeof evaluatorDependencyProvenanceSchema>;
export type EvaluatorDependencyTarget = z.infer<typeof dependencyTargetSchema>;
export type EvaluatorHost = z.infer<typeof evaluatorHostSchema>;

export interface ValidatedEvaluatorDependencies {
  provenance: EvaluatorDependencyProvenance;
  reviewedRequirements: string;
}

export type EvaluatorCommand = (
  executable: string,
  argv: readonly string[],
  cwd: string,
  runtime?: RuntimeBindings,
) => Promise<string>;

export interface PreparedSwebenchPro {
  directory: string;
  evaluatorDirectory: string;
  evaluatorEnvironmentDirectory: string;
  evaluatorPythonBinary: string;
  toolchain: PreparedToolchain;
  evaluatorSource: SourceProvenance;
  evaluatorEnvironmentSha256: string;
  pythonVersion: string;
  evaluatorDependencyTarget: string;
  requirementsSha256: string;
  requirementsProvenanceSha256: string;
  resolvedRequirementsSha256: string;
  ownershipPatchSha256: string;
  evaluatorPolicyHelperSha256: string;
  containerPolicyFileSha256: string;
  preparedInputSha256: string;
}

async function command(
  executable: string,
  argv: readonly string[],
  cwd: string,
  runtime: RuntimeBindings = {},
  tailBytes = 64 * 1_024,
  stream = runtime.pipConfigFile === undefined,
): Promise<string> {
  const env: NodeJS.ProcessEnv = {};
  if (runtime.pipConfigFile) env.PIP_CONFIG_FILE = runtime.pipConfigFile;
  const result = await runBenchProcess(executable, argv, {
    cwd,
    env,
    stream,
    tailBytes,
  });
  return result.stdout.trim();
}

function normalizedPackageName(value: string): string {
  return value.toLowerCase().replace(/[-_.]+/gu, '-');
}

function codepointCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function assertSortedUnique(values: readonly string[], description: string): void {
  const sorted = [...values].sort(codepointCompare);
  if (new Set(values).size !== values.length || values.some((value, index) => value !== sorted[index])) {
    throw new Error(`Pro evaluator dependency ${description} must be sorted and unique`);
  }
}

function evaluatorRequirements(
  provenance: EvaluatorDependencyProvenance,
  targetId?: string,
): string {
  const lines = provenance.packages.map((dependency) => {
    const hashes = dependency.artifacts
      .filter((artifact) => targetId === undefined || artifact.targets.includes(targetId))
      .map((artifact) => artifact.sha256)
      .sort(codepointCompare);
    if (hashes.length === 0) {
      throw new Error(`Pro evaluator package ${dependency.name} has no approved artifact for ${targetId}`);
    }
    return `${dependency.name}==${dependency.version} ${hashes
      .map((hash) => `--hash=sha256:${hash}`).join(' ')}`;
  });
  return `${lines.join('\n')}\n`;
}

/** Validate the reviewed lock, complete dependency graph, and wheel target partitions. */
export function validateEvaluatorDependencies(
  reviewedRequirements: string,
  provenanceValue: unknown,
): ValidatedEvaluatorDependencies {
  const provenance = evaluatorDependencyProvenanceSchema.parse(provenanceValue);
  if (canonicalJson(provenance.targets) !== canonicalJson(SUPPORTED_EVALUATOR_DEPENDENCY_TARGETS)) {
    throw new Error('Pro evaluator dependency targets do not match the finite reviewed host matrix');
  }
  assertSortedUnique(provenance.roots, 'roots');
  assertSortedUnique(provenance.packages.map((dependency) => dependency.name), 'packages');
  assertSortedUnique(
    provenance.inactiveRequirements.map((requirement) => `${requirement.parent}:${requirement.name}`),
    'inactive requirements',
  );
  const targetIds = new Set(provenance.targets.map((target) => target.id));
  const targetOrder = new Map(provenance.targets.map((target, index) => [target.id, index]));
  const packages = new Map(provenance.packages.map((dependency) => [dependency.name, dependency]));
  for (const dependency of provenance.packages) {
    if (dependency.name !== normalizedPackageName(dependency.name)) {
      throw new Error(`Pro evaluator package name is not normalized: ${dependency.name}`);
    }
    if (dependency.source !== `https://pypi.org/project/${dependency.name}/${dependency.version}/`) {
      throw new Error(`Pro evaluator package source is not its exact PyPI release: ${dependency.name}`);
    }
    assertSortedUnique(dependency.requires.map((requirement) => requirement.name), `${dependency.name} requirements`);
    assertSortedUnique(dependency.artifacts.map((artifact) => artifact.filename), `${dependency.name} artifacts`);
    if (new Set(dependency.artifacts.map((artifact) => artifact.sha256)).size !== dependency.artifacts.length) {
      throw new Error(`Pro evaluator package has duplicate approved artifacts: ${dependency.name}`);
    }
    for (const requirement of dependency.requires) {
      if (!packages.has(requirement.name)) {
        throw new Error(`Pro evaluator dependency closure is missing ${requirement.name} required by ${dependency.name}`);
      }
    }
    for (const artifact of dependency.artifacts) {
      if (!/^[A-Za-z0-9][A-Za-z0-9._+-]*\.whl$/u.test(artifact.filename)) {
        throw new Error(`Pro evaluator dependency artifact is not a wheel: ${artifact.filename}`);
      }
      const orderedTargets = [...artifact.targets].sort((left, right) => (
        (targetOrder.get(left) ?? Number.MAX_SAFE_INTEGER)
        - (targetOrder.get(right) ?? Number.MAX_SAFE_INTEGER)
      ));
      if (new Set(artifact.targets).size !== artifact.targets.length
        || artifact.targets.some((target, index) => target !== orderedTargets[index])) {
        throw new Error(`Pro evaluator dependency ${artifact.filename} targets must follow the reviewed matrix order`);
      }
      for (const target of artifact.targets) {
        if (!targetIds.has(target)) {
          throw new Error(`Pro evaluator dependency artifact has an unknown target: ${target}`);
        }
      }
      if (canonicalJson(artifact.targets) !== canonicalJson(wheelTargets(artifact.filename))) {
        throw new Error(`Pro evaluator wheel target assignment is incompatible: ${artifact.filename}`);
      }
    }
    for (const target of targetIds) {
      if (!dependency.artifacts.some((artifact) => artifact.targets.includes(target))) {
        throw new Error(`Pro evaluator package ${dependency.name} has no approved wheel for ${target}`);
      }
    }
  }
  for (const root of provenance.roots) {
    if (!packages.has(root)) throw new Error(`Pro evaluator dependency root is missing: ${root}`);
  }
  for (const inactive of provenance.inactiveRequirements) {
    if (!packages.has(inactive.parent) || packages.has(inactive.name)) {
      throw new Error(`Pro evaluator inactive requirement is inconsistent: ${inactive.parent}:${inactive.name}`);
    }
  }
  const closure = new Set<string>();
  const pending = [...provenance.roots];
  while (pending.length > 0) {
    const name = pending.pop();
    if (name === undefined || closure.has(name)) continue;
    closure.add(name);
    const dependency = packages.get(name);
    if (dependency === undefined) throw new Error(`Pro evaluator dependency closure is missing ${name}`);
    pending.push(...dependency.requires.map((requirement) => requirement.name));
  }
  if (closure.size !== provenance.packages.length) {
    const unreachable = provenance.packages.map((dependency) => dependency.name)
      .filter((name) => !closure.has(name));
    throw new Error(`Pro evaluator dependency lock has entries outside the root closure: ${unreachable.join(', ')}`);
  }
  const canonicalRequirements = evaluatorRequirements(provenance);
  if (reviewedRequirements !== canonicalRequirements) {
    throw new Error('Pro evaluator reviewed lock does not exactly match its approved wheel provenance');
  }
  if (sha256CanonicalJson(provenance) !== EVALUATOR_DEPENDENCY_PROVENANCE_SHA256) {
    throw new Error('Pro evaluator dependency provenance does not match the reviewed inventory hash');
  }
  return { provenance, reviewedRequirements: canonicalRequirements };
}

function versionAtLeast(observed: string, minimum: string): boolean {
  const observedParts = observed.split('.').map((part) => Number.parseInt(part, 10));
  const minimumParts = minimum.split('.').map((part) => Number.parseInt(part, 10));
  if (observedParts.some((part) => !Number.isSafeInteger(part))
    || minimumParts.some((part) => !Number.isSafeInteger(part))) return false;
  const length = Math.max(observedParts.length, minimumParts.length);
  for (let index = 0; index < length; index += 1) {
    const left = observedParts[index] ?? 0;
    const right = minimumParts[index] ?? 0;
    if (left !== right) return left > right;
  }
  return true;
}

/** Select one finite reviewed evaluator host target or fail before dependency access. */
export function selectEvaluatorDependencyTarget(
  dependencies: ValidatedEvaluatorDependencies,
  hostValue: unknown,
): EvaluatorDependencyTarget {
  const host = evaluatorHostSchema.parse(hostValue);
  const target = dependencies.provenance.targets.find((candidate) => (
    candidate.implementation === host.implementation
    && candidate.pythonMinor === host.pythonMinor
    && candidate.os === host.os
    && candidate.architecture === host.architecture
    && candidate.pipVersion === host.pipVersion
    && candidate.libc === host.libc
    && versionAtLeast(host.osVersion, candidate.minimumOsVersion)
  ));
  if (target === undefined) {
    throw new Error(`unsupported Pro evaluator dependency host: ${[
      host.implementation,
      host.pythonMinor,
      host.os,
      host.architecture,
      `pip-${host.pipVersion}`,
      `${host.libc}-${host.osVersion}`,
    ].join('/')}`);
  }
  return target;
}

/** Render the reviewed hash lock partition for one already-validated target. */
export function evaluatorRequirementsForTarget(
  dependencies: ValidatedEvaluatorDependencies,
  target: EvaluatorDependencyTarget,
): string {
  return evaluatorRequirements(dependencies.provenance, target.id);
}

const EVALUATOR_HOST_INSPECTION = [
  'import importlib.metadata, json, platform, sys',
  "machine = platform.machine().lower()",
  "architecture = 'arm64' if machine in ('aarch64', 'arm64') else ('x64' if machine in ('amd64', 'x86_64') else machine)",
  "os_name = 'macos' if sys.platform == 'darwin' else sys.platform",
  'libc_name, libc_version = platform.libc_ver()',
  "libc = libc_name.lower() if os_name == 'linux' else 'none'",
  "os_version = platform.mac_ver()[0] if os_name == 'macos' else libc_version",
  "print(json.dumps({'implementation': platform.python_implementation().lower(), 'pythonMinor': f'{sys.version_info.major}.{sys.version_info.minor}', 'os': os_name, 'architecture': architecture, 'pipVersion': importlib.metadata.version('pip'), 'libc': libc, 'osVersion': os_version}, sort_keys=True))",
].join('\n');

/** Inspect the host interpreter without contacting a package index. */
export async function inspectEvaluatorHost(
  cwd: string,
  runtime: RuntimeBindings,
  execute: EvaluatorCommand = command,
): Promise<EvaluatorHost> {
  const output = await execute('python3', ['-c', EVALUATOR_HOST_INSPECTION], cwd, runtime);
  return evaluatorHostSchema.parse(JSON.parse(output) as unknown);
}

/** Complete local evaluator dependency preflight; callers may access toolchain or package networks only afterward. */
export async function preflightEvaluatorDependencies(
  dependencies: ValidatedEvaluatorDependencies,
  cwd: string,
  runtime: RuntimeBindings,
  execute: EvaluatorCommand = command,
): Promise<EvaluatorDependencyTarget> {
  const host = await inspectEvaluatorHost(cwd, runtime, execute);
  return selectEvaluatorDependencyTarget(dependencies, host);
}

export interface PrepareEvaluatorEnvironmentOptions {
  pythonExecutable: string;
  environmentDirectory: string;
  requirementsPath: string;
  pipIndex: string;
  cwd: string;
  runtime: RuntimeBindings;
}

/** Install only reviewed wheels into a pipless environment, then verify its closure. */
export async function prepareEvaluatorEnvironment(
  options: PrepareEvaluatorEnvironmentOptions,
  execute: EvaluatorCommand = command,
): Promise<string> {
  await execute(options.pythonExecutable, [
    '-m', 'venv', '--without-pip', options.environmentDirectory,
  ], options.cwd, options.runtime);
  await execute(options.pythonExecutable, [
    '-m', 'pip', '--python', options.environmentDirectory,
    'install', '--disable-pip-version-check', '--no-input',
    '--index-url', options.pipIndex,
    '--require-hashes', '--only-binary=:all:', '--no-deps',
    '-r', options.requirementsPath,
  ], options.cwd, options.runtime);
  await execute(options.pythonExecutable, [
    '-m', 'pip', '--python', options.environmentDirectory, 'check',
  ], options.cwd, options.runtime);
  return execute(join(options.environmentDirectory, 'bin', 'python'), ['--version'], options.cwd, options.runtime);
}

function evaluatorEnvironmentIdentity(environmentDirectory: string): {
  treeSha256: string;
  pythonBinarySha256: string;
  identitySha256: string;
} {
  const treeSha256 = sha256Tree(environmentDirectory, { excludePythonCacheArtifacts: true });
  const pythonBinarySha256 = sha256File(realpathSync(join(environmentDirectory, 'bin', 'python')));
  return {
    treeSha256,
    pythonBinarySha256,
    identitySha256: sha256CanonicalJson({ treeSha256, pythonBinarySha256 }),
  };
}

function sourceTreeSha256(directory: string): string {
  return sha256Tree(directory, { exclude: ['.git'], excludePythonCacheArtifacts: true });
}

function loadEvaluatorDependencies(roots: BenchPathRoots): ValidatedEvaluatorDependencies {
  const reviewedRequirements = readRegularFileWithinRoot(roots.benchRoot, REQUIREMENTS_LOCK).toString('utf8');
  const provenance = JSON.parse(readRegularFileWithinRoot(
    roots.benchRoot,
    REQUIREMENTS_PROVENANCE,
  ).toString('utf8')) as unknown;
  return validateEvaluatorDependencies(reviewedRequirements, provenance);
}

/** Load and fully re-attest one immutable published evaluator input directory. */
export function loadPreparedSwebenchProInputs(
  directory: string,
  roots: BenchPathRoots,
  config: SwebenchProConfig,
): PreparedSwebenchPro {
  const dependencies = loadEvaluatorDependencies(roots);
  const resolved = resolve(directory);
  const manifest = preparedContentManifestSchema.parse(readPrivateJson(
    resolved,
    join(resolved, CONTENT_MANIFEST),
  ));
  const identity: PreparedIdentity = preparedIdentitySchema.parse(readPrivateJson(
    resolved,
    join(resolved, PREPARED_IDENTITY),
  ));
  const manifestIdentity = { ...manifest };
  delete (manifestIdentity as Partial<typeof manifest>).payloadSha256;
  const payloadSha256 = sha256Tree(resolved, {
    exclude: [CONTENT_MANIFEST],
    excludePythonCacheArtifacts: true,
  });
  if (payloadSha256 !== manifest.payloadSha256
    || resolved !== resolve(resolved, '..', payloadSha256)
    || canonicalJson(identity) !== canonicalJson(preparedIdentitySchema.parse(manifestIdentity))) {
    throw new Error('prepared SWE-bench Pro payload identity drifted');
  }
  if (manifest.evaluatorRepository !== config.evaluator.repository
    || manifest.evaluatorRevision !== config.evaluator.revision) {
    throw new Error('prepared official evaluator does not match the requested configuration');
  }
  const evaluatorDirectory = join(resolved, 'evaluator');
  const evaluatorEnvironmentDirectory = join(resolved, 'environment');
  const requirements = join(roots.benchRoot, ...REQUIREMENTS_LOCK.split('/'));
  const requirementsProvenance = join(roots.benchRoot, ...REQUIREMENTS_PROVENANCE.split('/'));
  const ownershipPatch = join(roots.benchRoot, 'suites', 'swebench-pro', 'evaluator-ownership.patch');
  const evaluatorPolicyHelper = join(roots.benchRoot, 'suites', 'swebench-pro', 'evaluator-policy.py');
  const containerPolicy = join(roots.benchRoot, 'suites', 'swebench-pro', 'container-policy.json');
  const environment = evaluatorEnvironmentIdentity(evaluatorEnvironmentDirectory);
  const dependencyTarget = dependencies.provenance.targets.find((target) => (
    target.id === manifest.evaluatorDependencyTarget
  ));
  if (dependencyTarget === undefined) throw new Error('prepared SWE-bench Pro dependency target is unsupported');
  const resolvedRequirements = readRegularFileWithinRoot(resolved, RESOLVED_REQUIREMENTS).toString('utf8');
  if (sourceTreeSha256(evaluatorDirectory) !== manifest.evaluatorTreeSha256
    || environment.treeSha256 !== manifest.evaluatorEnvironmentTreeSha256
    || environment.pythonBinarySha256 !== manifest.pythonBinarySha256
    || environment.identitySha256 !== manifest.evaluatorEnvironmentSha256
    || resolvedRequirements !== evaluatorRequirementsForTarget(dependencies, dependencyTarget)
    || sha256File(join(resolved, RESOLVED_REQUIREMENTS)) !== manifest.resolvedRequirementsSha256
    || sha256File(requirements) !== manifest.requirementsSha256
    || sha256File(requirementsProvenance) !== manifest.requirementsProvenanceSha256
    || sha256File(ownershipPatch) !== manifest.ownershipPatchSha256
    || sha256File(evaluatorPolicyHelper) !== manifest.evaluatorPolicyHelperSha256
    || sha256File(join(evaluatorDirectory, 'ultracode_evaluator_policy.py')) !== manifest.evaluatorPolicyHelperSha256
    || sha256File(containerPolicy) !== manifest.containerPolicyFileSha256) {
    throw new Error('prepared SWE-bench Pro evaluator provenance drifted');
  }
  return {
    directory: resolved,
    evaluatorDirectory,
    evaluatorEnvironmentDirectory,
    evaluatorPythonBinary: join(evaluatorEnvironmentDirectory, 'bin', 'python'),
    toolchain: loadPreparedToolchain(join(roots.cacheRoot, 'toolchains', manifest.toolchainPayloadSha256)),
    evaluatorSource: {
      repository: manifest.evaluatorRepository,
      revision: manifest.evaluatorRevision,
      treeSha256: manifest.evaluatorTreeSha256,
    },
    evaluatorEnvironmentSha256: manifest.evaluatorEnvironmentSha256,
    pythonVersion: manifest.pythonVersion,
    evaluatorDependencyTarget: manifest.evaluatorDependencyTarget,
    requirementsSha256: manifest.requirementsSha256,
    requirementsProvenanceSha256: manifest.requirementsProvenanceSha256,
    resolvedRequirementsSha256: manifest.resolvedRequirementsSha256,
    ownershipPatchSha256: manifest.ownershipPatchSha256,
    evaluatorPolicyHelperSha256: manifest.evaluatorPolicyHelperSha256,
    containerPolicyFileSha256: manifest.containerPolicyFileSha256,
    preparedInputSha256: manifest.payloadSha256,
  };
}

/** Resolve only the current prep pointer for a fresh run. */
export function loadCurrentPreparedSwebenchProInputs(
  roots: BenchPathRoots,
  config: SwebenchProConfig,
): PreparedSwebenchPro {
  const cache = suiteCacheDir(roots);
  const current = readPrivateJson(cache, swebenchProCurrentFile(roots)) as {
    schemaVersion?: unknown;
    identity?: unknown;
  };
  if (current.schemaVersion !== 3 || typeof current.identity !== 'string'
    || !/^[a-f0-9]{64}$/.test(current.identity)) {
    throw new Error('SWE-bench Pro current preparation pointer is malformed');
  }
  return loadPreparedSwebenchProInputs(swebenchProPreparedDir(roots, current.identity), roots, config);
}

/** Build and publish exact pinned evaluator inputs. This is a networked prep path. */
export async function prepareSwebenchProInputs(
  roots: BenchPathRoots,
  toolchainConfig: ToolchainConfig,
  config: SwebenchProConfig,
  runtime: RuntimeBindings,
): Promise<PreparedSwebenchPro> {
  const dependencies = loadEvaluatorDependencies(roots);
  const targetDependencyPartition = await preflightEvaluatorDependencies(
    dependencies,
    roots.benchRoot,
    runtime,
  );
  const resolvedRequirements = evaluatorRequirementsForTarget(dependencies, targetDependencyPartition);
  const cache = ensureRealDirectoryWithin(roots.cacheRoot, suiteCacheDir(roots));
  const stage = join(cache, `.stage-${process.pid}-${randomBytes(12).toString('hex')}`);
  mkdirSync(stage, { mode: 0o700 });
  const evaluatorDirectory = join(stage, 'evaluator');
  const environmentDirectory = join(stage, 'environment');
  try {
    const toolchain = await prepareSharedToolchain(
      toolchainConfig,
      roots,
      SWEBENCH_PRO_TOOLCHAIN_NATIVE_ASSETS,
    );
    await command('git', ['clone', '--filter=blob:none', '--sparse', config.evaluator.repository, evaluatorDirectory], roots.cacheRoot);
    await command('git', ['-C', evaluatorDirectory, 'sparse-checkout', 'set', '--no-cone', ...SPARSE_PATHS], roots.cacheRoot);
    await command('git', ['-C', evaluatorDirectory, 'fetch', '--depth=1', 'origin', config.evaluator.revision], roots.cacheRoot);
    await command('git', ['-C', evaluatorDirectory, 'checkout', '--detach', config.evaluator.revision], roots.cacheRoot);
    const observedRevision = await command('git', ['-C', evaluatorDirectory, 'rev-parse', 'HEAD'], roots.cacheRoot);
    if (observedRevision !== config.evaluator.revision) throw new Error('official evaluator revision does not match its pin');
    const dirty = await command('git', ['-C', evaluatorDirectory, 'status', '--porcelain', '--untracked-files=all'], roots.cacheRoot);
    if (dirty) throw new Error('fresh official evaluator checkout is unexpectedly dirty');
    const ownershipPatch = join(roots.benchRoot, 'suites', 'swebench-pro', 'evaluator-ownership.patch');
    await command('git', ['-C', evaluatorDirectory, 'apply', '--check', ownershipPatch], roots.cacheRoot);
    await command('git', ['-C', evaluatorDirectory, 'apply', ownershipPatch], roots.cacheRoot);
    await command('git', ['-C', evaluatorDirectory, 'diff', '--check'], roots.cacheRoot);
    const patchedFiles = (await command('git', ['-C', evaluatorDirectory, 'diff', '--name-only'], roots.cacheRoot))
      .split('\n').filter(Boolean);
    if (patchedFiles.length !== 1 || patchedFiles[0] !== 'swe_bench_pro_eval.py') {
      throw new Error('official evaluator ownership patch changed an unexpected file set');
    }
    const evaluatorPolicyHelper = join(roots.benchRoot, 'suites', 'swebench-pro', 'evaluator-policy.py');
    writePrivateFileAtomic(
      evaluatorDirectory,
      join(evaluatorDirectory, 'ultracode_evaluator_policy.py'),
      readRegularFileWithinRoot(roots.benchRoot, 'suites/swebench-pro/evaluator-policy.py'),
    );

    const requirements = join(roots.benchRoot, ...REQUIREMENTS_LOCK.split('/'));
    const requirementsProvenance = join(roots.benchRoot, ...REQUIREMENTS_PROVENANCE.split('/'));
    const containerPolicy = join(roots.benchRoot, 'suites', 'swebench-pro', 'container-policy.json');
    const resolvedRequirementsPath = join(stage, RESOLVED_REQUIREMENTS);
    writePrivateFileAtomic(stage, resolvedRequirementsPath, resolvedRequirements);

    const pythonVersion = await prepareEvaluatorEnvironment({
      pythonExecutable: 'python3',
      environmentDirectory,
      requirementsPath: resolvedRequirementsPath,
      pipIndex: config.evaluator.pipIndex,
      cwd: roots.cacheRoot,
      runtime,
    });
    if (!/^Python 3\.11\.\d+$/u.test(pythonVersion)) {
      throw new Error(`prepared Pro evaluator Python drifted from the reviewed minor: ${pythonVersion}`);
    }
    const environment = evaluatorEnvironmentIdentity(environmentDirectory);
    const manifestWithoutPayload: PreparedIdentity = {
      schemaVersion: 3,
      kind: 'ultracode-swebench-pro-prepared-inputs',
      evaluatorRepository: config.evaluator.repository,
      evaluatorRevision: config.evaluator.revision,
      evaluatorTreeSha256: sourceTreeSha256(evaluatorDirectory),
      evaluatorEnvironmentTreeSha256: environment.treeSha256,
      evaluatorEnvironmentSha256: environment.identitySha256,
      pythonVersion,
      pythonBinarySha256: environment.pythonBinarySha256,
      evaluatorDependencyTarget: targetDependencyPartition.id,
      requirementsSha256: sha256File(requirements),
      requirementsProvenanceSha256: sha256File(requirementsProvenance),
      resolvedRequirementsSha256: sha256File(resolvedRequirementsPath),
      ownershipPatchSha256: sha256File(ownershipPatch),
      evaluatorPolicyHelperSha256: sha256File(evaluatorPolicyHelper),
      containerPolicyFileSha256: sha256File(containerPolicy),
      toolchainPayloadSha256: toolchain.provenance.payloadSha256,
    };
    writePrivateJsonAtomic(stage, join(stage, PREPARED_IDENTITY), manifestWithoutPayload);
    const payloadSha256 = sha256Tree(stage, { excludePythonCacheArtifacts: true });
    writePrivateJsonAtomic(stage, join(stage, CONTENT_MANIFEST), { ...manifestWithoutPayload, payloadSha256 });
    const target = swebenchProPreparedDir(roots, payloadSha256);
    if (existsSync(target)) rmSync(stage, { recursive: true, force: true });
    else renameSync(stage, target);
    writePrivateJsonAtomic(cache, swebenchProCurrentFile(roots), { schemaVersion: 3, identity: payloadSha256 });
    return loadPreparedSwebenchProInputs(target, roots, config);
  } catch (error) {
    rmSync(stage, { recursive: true, force: true });
    throw error;
  }
}
