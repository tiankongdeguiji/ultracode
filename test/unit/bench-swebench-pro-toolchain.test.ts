/** Offline trust-boundary tests for the SWE-bench Pro evaluator dependencies. */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createBenchPathRoots } from '../../bench/src/shared/paths.js';
import {
  evaluatorRequirementsForTarget,
  preflightEvaluatorDependencies,
  prepareEvaluatorEnvironment,
  selectEvaluatorDependencyTarget,
  SWEBENCH_PRO_TOOLCHAIN_NATIVE_ASSETS,
  swebenchProToolchainNativeAssetsSha256,
  validateEvaluatorDependencies,
  type EvaluatorCommand,
  type EvaluatorHost,
} from '../../bench/src/suites/swebench-pro/toolchain.js';

interface ProvenanceFixture {
  targets: Array<{ id: string }>;
  roots: string[];
  inactiveRequirements: Array<{ parent: string; name: string; specifier: string; marker: string }>;
  packages: Array<{
    name: string;
    version: string;
    source: string;
    requires: Array<{ name: string; specifier: string }>;
    artifacts: Array<{ filename: string; sha256: string; targets: string[] }>;
  }>;
}

interface CommandCall {
  executable: string;
  argv: readonly string[];
  cwd: string;
}

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const assetRoot = join(projectRoot, 'bench', 'suites', 'swebench-pro');

function loadFixture(): { lock: string; provenance: ProvenanceFixture } {
  return {
    lock: readFileSync(join(assetRoot, 'evaluator-requirements.lock'), 'utf8'),
    provenance: JSON.parse(readFileSync(
      join(assetRoot, 'evaluator-requirements.provenance.json'),
      'utf8',
    )) as ProvenanceFixture,
  };
}

function supportedHost(overrides: Partial<EvaluatorHost> = {}): EvaluatorHost {
  return {
    implementation: 'cpython',
    pythonMinor: '3.11',
    os: 'linux',
    architecture: 'x64',
    pipVersion: '24.2',
    libc: 'glibc',
    osVersion: '2.39',
    ...overrides,
  };
}

describe('SWE-bench Pro evaluator dependency assets', () => {
  it('stages every suite script referenced by the overlay Dockerfile', () => {
    const dockerfile = readFileSync(join(assetRoot, 'Dockerfile'), 'utf8');
    const copiedScripts = [...dockerfile.matchAll(/^COPY .* ([a-z-]+\.(?:sh|mjs))\s+\/opt\/bench\//gmu)]
      .map((match) => match[1]!);
    expect(SWEBENCH_PRO_TOOLCHAIN_NATIVE_ASSETS).toEqual(copiedScripts.map((destination) => ({
      source: `suites/swebench-pro/${destination}`,
      destination,
    })));
  });

  it('rejects a prepared script copy that differs from current policy source', () => {
    const root = mkdtempSync(join(tmpdir(), 'uc-pro-native-assets-'));
    try {
      const sourceRoot = join(root, 'suites/swebench-pro');
      const toolchain = join(root, 'toolchain');
      mkdirSync(sourceRoot, { recursive: true });
      mkdirSync(toolchain);
      for (const asset of SWEBENCH_PRO_TOOLCHAIN_NATIVE_ASSETS) {
        writeFileSync(join(root, asset.source), `${asset.destination}\n`);
        writeFileSync(join(toolchain, asset.destination), `${asset.destination}\n`);
      }
      expect(swebenchProToolchainNativeAssetsSha256(
        createBenchPathRoots(root),
        toolchain,
      )).toMatch(/^[a-f0-9]{64}$/u);
      writeFileSync(join(sourceRoot, 'entrypoint.sh'), 'changed\n');
      expect(() => swebenchProToolchainNativeAssetsSha256(
        createBenchPathRoots(root),
        toolchain,
      )).toThrow(/toolchain asset drifted/u);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('contains the exact reviewed pins, hashes, target partitions, and full closure', () => {
    const { lock, provenance } = loadFixture();
    const dependencies = validateEvaluatorDependencies(lock, provenance);
    expect(Object.fromEntries(dependencies.provenance.packages.map((dependency) => [
      dependency.name,
      dependency.version,
    ]))).toEqual({
      certifi: '2025.6.15',
      'charset-normalizer': '3.4.2',
      docker: '7.1.0',
      idna: '3.15',
      numpy: '2.3.1',
      pandas: '2.3.1',
      'python-dateutil': '2.9.0.post0',
      pytz: '2025.2',
      requests: '2.33.0',
      six: '1.17.0',
      tqdm: '4.67.1',
      tzdata: '2025.2',
      urllib3: '2.7.0',
    });
    expect(dependencies.provenance.roots).toEqual(['docker', 'pandas', 'tqdm']);
    expect(dependencies.provenance.inactiveRequirements).toEqual([
      { parent: 'docker', name: 'pywin32', specifier: '>=304', marker: "sys_platform == 'win32'" },
      { parent: 'tqdm', name: 'colorama', specifier: '*', marker: "platform_system == 'Windows'" },
    ]);
    const edges = dependencies.provenance.packages.flatMap((dependency) => dependency.requires
      .map((requirement) => `${dependency.name}->${requirement.name}${requirement.specifier}`));
    expect(edges).toEqual([
      'docker->requests>=2.26.0',
      'docker->urllib3>=1.26.0',
      'pandas->numpy>=1.23.2',
      'pandas->python-dateutil>=2.8.2',
      'pandas->pytz>=2020.1',
      'pandas->tzdata>=2022.7',
      'python-dateutil->six>=1.5',
      'requests->certifi>=2023.5.7',
      'requests->charset-normalizer>=2,<4',
      'requests->idna>=2.5,<4',
      'requests->urllib3>=1.26,<3',
    ]);
    const lockHashes = [...lock.matchAll(/--hash=sha256:([a-f0-9]{64})/gu)]
      .map((match) => match[1]);
    const approvedHashes = dependencies.provenance.packages
      .flatMap((dependency) => dependency.artifacts.map((artifact) => artifact.sha256));
    expect(lockHashes).toHaveLength(21);
    expect(new Set(lockHashes)).toEqual(new Set(approvedHashes));
    expect(dependencies.provenance.packages.every((dependency) => (
      dependency.source === `https://pypi.org/project/${dependency.name}/${dependency.version}/`
    ))).toBe(true);
  });

  it('renders only hashes approved for each finite supported target', () => {
    const fixture = loadFixture();
    const dependencies = validateEvaluatorDependencies(fixture.lock, fixture.provenance);
    const hosts: EvaluatorHost[] = [
      supportedHost(),
      supportedHost({ architecture: 'arm64' }),
      supportedHost({ os: 'macos', architecture: 'x64', libc: 'none', osVersion: '10.15' }),
      supportedHost({ os: 'macos', architecture: 'arm64', libc: 'none', osVersion: '14.0' }),
    ];
    expect(hosts.map((host) => selectEvaluatorDependencyTarget(dependencies, host).id)).toEqual([
      'cpython-3.11-linux-x64-pip-24.2',
      'cpython-3.11-linux-arm64-pip-24.2',
      'cpython-3.11-macos-x64-pip-24.2',
      'cpython-3.11-macos-arm64-pip-24.2',
    ]);
    for (const host of hosts) {
      const target = selectEvaluatorDependencyTarget(dependencies, host);
      const targetLock = evaluatorRequirementsForTarget(dependencies, target);
      expect(targetLock.trim().split('\n')).toHaveLength(13);
      expect(targetLock).not.toMatch(/\.tar\.gz|\.zip|--no-binary|--report/u);
      const approved = dependencies.provenance.packages.flatMap((dependency) => dependency.artifacts
        .filter((artifact) => artifact.targets.includes(target.id))
        .map((artifact) => artifact.sha256));
      const rendered = [...targetLock.matchAll(/--hash=sha256:([a-f0-9]{64})/gu)]
        .map((match) => match[1]);
      expect(rendered).toHaveLength(approved.length);
      expect(new Set(rendered)).toEqual(new Set(approved));
    }
  });

  it('rejects unsupported implementation, minor, OS, architecture, pip, libc, and OS floor', () => {
    const fixture = loadFixture();
    const dependencies = validateEvaluatorDependencies(fixture.lock, fixture.provenance);
    const unsupported: EvaluatorHost[] = [
      supportedHost({ implementation: 'pypy' }),
      supportedHost({ pythonMinor: '3.12' }),
      supportedHost({ os: 'freebsd' }),
      supportedHost({ architecture: 's390x' }),
      supportedHost({ pipVersion: '24.3' }),
      supportedHost({ libc: 'musl', osVersion: '1.2' }),
      supportedHost({ osVersion: '2.27' }),
      supportedHost({ os: 'macos', architecture: 'arm64', libc: 'none', osVersion: '10.15' }),
    ];
    for (const host of unsupported) {
      expect(() => selectEvaluatorDependencyTarget(dependencies, host)).toThrow(/unsupported/u);
    }
  });

  it('rejects a wrong reviewed hash before installation', () => {
    const fixture = loadFixture();
    const wrongLock = fixture.lock.replace(
      '2e0c7ce7cb5d8f8634ca55d2ba7e6ec2689a2fd6537d8dec1296a477a4910057',
      'f'.repeat(64),
    );
    expect(() => validateEvaluatorDependencies(wrongLock, fixture.provenance)).toThrow(/exactly match/u);
  });

  it('rejects an sdist before any backend process can execute', () => {
    const fixture = loadFixture();
    const provenance = structuredClone(fixture.provenance);
    provenance.packages[0]!.artifacts[0]!.filename = 'certifi-2025.6.15.tar.gz';
    let backendProcessCalls = 0;
    const preflight = (): void => {
      validateEvaluatorDependencies(fixture.lock, provenance);
      backendProcessCalls += 1;
    };
    expect(preflight).toThrow(/not a wheel/u);
    expect(backendProcessCalls).toBe(0);
  });

  it('rejects a missing transitive entry and an entry outside the root closure', () => {
    const fixture = loadFixture();
    const missing = structuredClone(fixture.provenance);
    missing.packages = missing.packages.filter((dependency) => dependency.name !== 'six');
    expect(() => validateEvaluatorDependencies(fixture.lock, missing)).toThrow(/missing six required/u);

    const extra = structuredClone(fixture.provenance);
    extra.packages.splice(-1, 0, {
      name: 'unreachable',
      version: '1.0',
      source: 'https://pypi.org/project/unreachable/1.0/',
      requires: [],
      artifacts: [{
        filename: 'unreachable-1.0-py3-none-any.whl',
        sha256: 'f'.repeat(64),
        targets: extra.targets.map((target) => target.id),
      }],
    });
    expect(() => validateEvaluatorDependencies(fixture.lock, extra)).toThrow(/outside the root closure/u);
  });

  it('rejects internally consistent dependency-edge or wheel-target inventory rewrites', () => {
    const fixture = loadFixture();
    const missingEdge = structuredClone(fixture.provenance);
    const docker = missingEdge.packages.find((dependency) => dependency.name === 'docker')!;
    docker.requires = docker.requires.filter((requirement) => requirement.name !== 'urllib3');
    expect(() => validateEvaluatorDependencies(fixture.lock, missingEdge)).toThrow(/inventory hash/u);

    const incompatibleTarget = structuredClone(fixture.provenance);
    const numpy = incompatibleTarget.packages.find((dependency) => dependency.name === 'numpy')!;
    numpy.artifacts[0]!.targets.unshift('cpython-3.11-macos-arm64-pip-24.2');
    expect(() => validateEvaluatorDependencies(fixture.lock, incompatibleTarget)).toThrow(/target assignment/u);
  });
});

describe('SWE-bench Pro evaluator install process seam', () => {
  it('uses one local interpreter inspection before rejecting an unsupported host', async () => {
    const fixture = loadFixture();
    const dependencies = validateEvaluatorDependencies(fixture.lock, fixture.provenance);
    const calls: CommandCall[] = [];
    const execute: EvaluatorCommand = async (executable, argv, cwd) => {
      calls.push({ executable, argv, cwd });
      return JSON.stringify(supportedHost({ pipVersion: '25.1' }));
    };
    await expect(preflightEvaluatorDependencies(dependencies, '/bench', {}, execute))
      .rejects.toThrow(/unsupported/u);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.executable).toBe('python3');
    expect(calls[0]!.argv).toHaveLength(2);
    expect(calls[0]!.argv[0]).toBe('-c');
    expect(calls[0]!.argv.join(' ')).not.toMatch(/https?:|\bpip\s+install\b|--report/u);
  });

  it('creates a pipless venv, installs the hashed wheel closure without dependencies, then checks it', async () => {
    const calls: CommandCall[] = [];
    const execute: EvaluatorCommand = async (executable, argv, cwd) => {
      calls.push({ executable, argv, cwd });
      return executable.endsWith('/bin/python') ? 'Python 3.11.12' : '';
    };
    const pythonVersion = await prepareEvaluatorEnvironment({
      pythonExecutable: 'python3',
      environmentDirectory: '/cache/environment',
      requirementsPath: '/cache/resolved-requirements.lock',
      pipIndex: 'https://index.example.invalid/simple',
      cwd: '/cache',
      runtime: {},
    }, execute);
    expect(pythonVersion).toBe('Python 3.11.12');
    expect(calls).toEqual([
      {
        executable: 'python3',
        argv: ['-m', 'venv', '--without-pip', '/cache/environment'],
        cwd: '/cache',
      },
      {
        executable: 'python3',
        argv: [
          '-m', 'pip', '--python', '/cache/environment',
          'install', '--disable-pip-version-check', '--no-input',
          '--index-url', 'https://index.example.invalid/simple',
          '--require-hashes', '--only-binary=:all:', '--no-deps',
          '-r', '/cache/resolved-requirements.lock',
        ],
        cwd: '/cache',
      },
      {
        executable: 'python3',
        argv: ['-m', 'pip', '--python', '/cache/environment', 'check'],
        cwd: '/cache',
      },
      {
        executable: '/cache/environment/bin/python',
        argv: ['--version'],
        cwd: '/cache',
      },
    ]);
    expect(calls.flatMap((call) => call.argv)).not.toContain('--report');
  });

  it('stops on a simulated artifact hash failure before pip check or interpreter execution', async () => {
    const calls: CommandCall[] = [];
    const execute: EvaluatorCommand = async (executable, argv, cwd) => {
      calls.push({ executable, argv, cwd });
      if (argv.includes('install')) throw new Error('downloaded wheel hash did not match');
      return '';
    };
    await expect(prepareEvaluatorEnvironment({
      pythonExecutable: 'python3',
      environmentDirectory: '/cache/environment',
      requirementsPath: '/cache/resolved-requirements.lock',
      pipIndex: 'https://index.example.invalid/simple',
      cwd: '/cache',
      runtime: {},
    }, execute)).rejects.toThrow(/hash did not match/u);
    expect(calls).toHaveLength(2);
    expect(calls[1]!.argv).toContain('--require-hashes');
  });

  it.runIf(process.env.UC_OFFLINE_PYTHON_TESTS === '1')(
    'performs a real offline hashed-wheel install into a pipless venv', async () => {
      const root = mkdtempSync(join(tmpdir(), 'uc-pro-wheel-install-'));
      try {
        const wheel = join(root, 'offline_fixture-1.0-py3-none-any.whl');
        writeFileSync(wheel, Buffer.from(
          'UEsDBBQAAAAIAEYs9Vybemt7FgAAABQAAAAbAAAAb2ZmbGluZV9maXh0dXJlL19faW5pdF9fLnB5i48vSy0qzszPi49XsFVQMtQzUOICAFBLAwQUAAAACABGLPVc8OcUPTQAAAA5AAAAJgAAAG9mZmxpbmVfZml4dHVyZS0xLjAuZGlzdC1pbmZvL01FVEFEQVRB800tSUxJLEnUDUstKs7Mz7NSMNIz5PJLzE21UshPS8vJzEvVTcusKCktSuWCKzHUM+ACAFBLAwQUAAAACABGLPVcPwHhBlMAAABVAAAAIwAAAG9mZmxpbmVfZml4dHVyZS0xLjAuZGlzdC1pbmZvL1dIRUVMBcExCoAwDAXQvafoBSKKWy8gbiKic9WPFkoiaTr09r53vECmHVqScPBD17sJDI0mGnzNpvGSG2Qo5lYRo7nQUhU5ncGbVrgtPsF/bSQWBkVu7gdQSwMEFAAAAAgARiz1XAAAAAACAAAAAAAAACQAAABvZmZsaW5lX2ZpeHR1cmUtMS4wLmRpc3QtaW5mby9SRUNPUkQDAFBLAQIUAxQAAAAIAEYs9Vybemt7FgAAABQAAAAbAAAAAAAAAAAAAACAAQAAAABvZmZsaW5lX2ZpeHR1cmUvX19pbml0X18ucHlQSwECFAMUAAAACABGLPVc8OcUPTQAAAA5AAAAJgAAAAAAAAAAAAAAgAFPAAAAb2ZmbGluZV9maXh0dXJlLTEuMC5kaXN0LWluZm8vTUVUQURBVEFQSwECFAMUAAAACABGLPVcPwHhBlMAAABVAAAAIwAAAAAAAAAAAAAAgAHHAAAAb2ZmbGluZV9maXh0dXJlLTEuMC5kaXN0LWluZm8vV0hFRUxQSwECFAMUAAAACABGLPVcAAAAAAIAAAAAAAAAJAAAAAAAAAAAAAAAgAFbAQAAb2ZmbGluZV9maXh0dXJlLTEuMC5kaXN0LWluZm8vUkVDT1JEUEsFBgAAAAAEAAQAQAEAAJ8BAAAAAA==',
          'base64',
        ));
        const digest = createHash('sha256').update(readFileSync(wheel)).digest('hex');
        const simple = join(root, 'simple', 'offline-fixture');
        mkdirSync(simple, { recursive: true });
        writeFileSync(join(simple, 'index.html'), [
          '<!doctype html>',
          `<a href="../../${wheel.split('/').at(-1)}#sha256=${digest}">fixture</a>`,
        ].join('\n'));
        const requirements = join(root, 'requirements.lock');
        writeFileSync(requirements, `offline-fixture==1.0 --hash=sha256:${digest}\n`);
        const execute: EvaluatorCommand = async (executable, argv, cwd) => execFileSync(
          executable,
          [...argv],
          { cwd, encoding: 'utf8', env: { ...process.env, PIP_CONFIG_FILE: '/dev/null' } },
        ).trim();
        await expect(prepareEvaluatorEnvironment({
          pythonExecutable: 'python3',
          environmentDirectory: join(root, 'environment'),
          requirementsPath: requirements,
          pipIndex: `file://${join(root, 'simple')}`,
          cwd: root,
          runtime: {},
        }, execute)).resolves.toMatch(/^Python 3\.11\./u);
        expect(execFileSync(join(root, 'environment', 'bin', 'python'), [
          '-c', 'import offline_fixture; print(offline_fixture.__version__)',
        ], { encoding: 'utf8' }).trim()).toBe('1.0');
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }, 20_000,
  );
});
