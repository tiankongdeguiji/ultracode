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

const preparedIdentitySchema = z.strictObject({
  schemaVersion: z.literal(2),
  kind: z.literal('ultracode-swebench-pro-prepared-inputs'),
  evaluatorRepository: publicLocatorSchema,
  evaluatorRevision: z.string().regex(/^[a-f0-9]{40}$/),
  evaluatorTreeSha256: sha256Schema,
  evaluatorEnvironmentTreeSha256: sha256Schema,
  evaluatorEnvironmentSha256: sha256Schema,
  pythonVersion: z.string().min(1),
  pythonBinarySha256: sha256Schema,
  requirementsSha256: sha256Schema,
  resolvedRequirementsSha256: sha256Schema,
  ownershipPatchSha256: sha256Schema,
  toolchainPayloadSha256: sha256Schema,
});

const preparedContentManifestSchema = preparedIdentitySchema.extend({
  payloadSha256: sha256Schema,
}).strict();

type PreparedIdentity = z.infer<typeof preparedIdentitySchema>;

export interface PreparedSwebenchPro {
  directory: string;
  evaluatorDirectory: string;
  evaluatorEnvironmentDirectory: string;
  evaluatorPythonBinary: string;
  toolchain: PreparedToolchain;
  evaluatorSource: SourceProvenance;
  evaluatorEnvironmentSha256: string;
  pythonVersion: string;
  requirementsSha256: string;
  resolvedRequirementsSha256: string;
  ownershipPatchSha256: string;
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

/** Reduce pip's ephemeral install report to a credential-free full hash lock. */
export function resolvedRequirementsFromPipReport(value: unknown): string {
  const report = z.object({
    install: z.array(z.object({
      download_info: z.object({
        archive_info: z.object({
          hashes: z.record(z.string(), z.string()),
        }).passthrough(),
      }).passthrough(),
      metadata: z.object({
        name: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/),
        version: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9.!+_-]*$/),
      }).passthrough(),
    }).passthrough()).min(1),
  }).passthrough().parse(value);
  const entries = report.install.map((entry) => ({
    name: normalizedPackageName(entry.metadata.name),
    version: entry.metadata.version,
    hash: entry.download_info.archive_info.hashes.sha256,
  })).sort((left, right) => left.name.localeCompare(right.name));
  if (entries.some((entry) => entry.hash === undefined || !/^[a-f0-9]{64}$/.test(entry.hash))) {
    throw new Error('Pro evaluator dependency resolution contains an unhashed artifact');
  }
  if (new Set(entries.map((entry) => entry.name)).size !== entries.length) {
    throw new Error('Pro evaluator dependency resolution contains duplicate package identities');
  }
  return `${entries.map((entry) => `${entry.name}==${entry.version} --hash=sha256:${entry.hash}`).join('\n')}\n`;
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

/** Load and fully re-attest one immutable published evaluator input directory. */
export function loadPreparedSwebenchProInputs(
  directory: string,
  roots: BenchPathRoots,
  config: SwebenchProConfig,
): PreparedSwebenchPro {
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
  const requirements = join(roots.benchRoot, 'suites', 'swebench-pro', 'evaluator-requirements.lock');
  const ownershipPatch = join(roots.benchRoot, 'suites', 'swebench-pro', 'evaluator-ownership.patch');
  const environment = evaluatorEnvironmentIdentity(evaluatorEnvironmentDirectory);
  if (sourceTreeSha256(evaluatorDirectory) !== manifest.evaluatorTreeSha256
    || environment.treeSha256 !== manifest.evaluatorEnvironmentTreeSha256
    || environment.pythonBinarySha256 !== manifest.pythonBinarySha256
    || environment.identitySha256 !== manifest.evaluatorEnvironmentSha256
    || sha256File(join(resolved, RESOLVED_REQUIREMENTS)) !== manifest.resolvedRequirementsSha256
    || sha256File(requirements) !== manifest.requirementsSha256
    || sha256File(ownershipPatch) !== manifest.ownershipPatchSha256) {
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
    requirementsSha256: manifest.requirementsSha256,
    resolvedRequirementsSha256: manifest.resolvedRequirementsSha256,
    ownershipPatchSha256: manifest.ownershipPatchSha256,
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
  if (current.schemaVersion !== 2 || typeof current.identity !== 'string'
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
  const cache = ensureRealDirectoryWithin(roots.cacheRoot, suiteCacheDir(roots));
  const stage = join(cache, `.stage-${process.pid}-${randomBytes(12).toString('hex')}`);
  mkdirSync(stage, { mode: 0o700 });
  const evaluatorDirectory = join(stage, 'evaluator');
  const environmentDirectory = join(stage, 'environment');
  const resolverDirectory = join(stage, '.resolver');
  try {
    const toolchain = await prepareSharedToolchain(toolchainConfig, roots);
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

    const requirements = join(roots.benchRoot, 'suites', 'swebench-pro', 'evaluator-requirements.lock');
    await command('python3', ['-m', 'venv', resolverDirectory], roots.cacheRoot, runtime);
    const resolverReport = await command(join(resolverDirectory, 'bin', 'pip'), [
      'install', '--quiet', '--disable-pip-version-check', '--index-url', config.evaluator.pipIndex,
      '--report', '-', '-r', requirements,
    ], roots.cacheRoot, runtime, 16 * 1_024 * 1_024, false);
    const resolvedRequirements = resolvedRequirementsFromPipReport(JSON.parse(resolverReport) as unknown);
    rmSync(resolverDirectory, { recursive: true, force: true });
    const resolvedRequirementsPath = join(stage, RESOLVED_REQUIREMENTS);
    writePrivateFileAtomic(stage, resolvedRequirementsPath, resolvedRequirements);

    await command('python3', ['-m', 'venv', environmentDirectory], roots.cacheRoot, runtime);
    await command(join(environmentDirectory, 'bin', 'pip'), [
      'install', '--disable-pip-version-check', '--index-url', config.evaluator.pipIndex,
      '--require-hashes', '-r', resolvedRequirementsPath,
    ], roots.cacheRoot, runtime);
    await command(join(environmentDirectory, 'bin', 'pip'), ['check'], roots.cacheRoot, runtime);
    const pythonVersion = await command(join(environmentDirectory, 'bin', 'python'), ['--version'], roots.cacheRoot);
    const environment = evaluatorEnvironmentIdentity(environmentDirectory);
    const manifestWithoutPayload: PreparedIdentity = {
      schemaVersion: 2,
      kind: 'ultracode-swebench-pro-prepared-inputs',
      evaluatorRepository: config.evaluator.repository,
      evaluatorRevision: config.evaluator.revision,
      evaluatorTreeSha256: sourceTreeSha256(evaluatorDirectory),
      evaluatorEnvironmentTreeSha256: environment.treeSha256,
      evaluatorEnvironmentSha256: environment.identitySha256,
      pythonVersion,
      pythonBinarySha256: environment.pythonBinarySha256,
      requirementsSha256: sha256File(requirements),
      resolvedRequirementsSha256: sha256File(resolvedRequirementsPath),
      ownershipPatchSha256: sha256File(ownershipPatch),
      toolchainPayloadSha256: toolchain.provenance.payloadSha256,
    };
    writePrivateJsonAtomic(stage, join(stage, PREPARED_IDENTITY), manifestWithoutPayload);
    const payloadSha256 = sha256Tree(stage, { excludePythonCacheArtifacts: true });
    writePrivateJsonAtomic(stage, join(stage, CONTENT_MANIFEST), { ...manifestWithoutPayload, payloadSha256 });
    const target = swebenchProPreparedDir(roots, payloadSha256);
    if (existsSync(target)) rmSync(stage, { recursive: true, force: true });
    else renameSync(stage, target);
    writePrivateJsonAtomic(cache, swebenchProCurrentFile(roots), { schemaVersion: 2, identity: payloadSha256 });
    return loadPreparedSwebenchProInputs(target, roots, config);
  } catch (error) {
    rmSync(stage, { recursive: true, force: true });
    throw error;
  }
}
