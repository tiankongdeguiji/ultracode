/** Offline ownership cleanup tests for ambiguous Docker removal outcomes. */
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createBenchPathRoots } from '../../bench/src/shared/paths.js';
import {
  OwnershipUnsafeCleanupError,
  cleanupActiveReclamationHelpers,
} from '../../bench/src/suites/swebench-pro/cleanup.js';
import {
  loadSwebenchProContainerPolicy,
  sessionTaskIdentity,
} from '../../bench/src/suites/swebench-pro/container-policy.js';
import {
  reclaimSessionOwnership,
  reclamationContainerName,
  reclamationDockerRunArgv,
  ownedRunContainerIds,
  proveManifestReclamationNamesAbsent,
  stopPersistedSessionContainer,
  settleSessionWorkers,
  type SessionDockerExecutor,
} from '../../bench/src/suites/swebench-pro/runner.js';

const temporaryRoots: string[] = [];
const policy = loadSwebenchProContainerPolicy(createBenchPathRoots(join(process.cwd(), 'bench')));
const docker = { cpus: 1, memoryBytes: 1_000_000, keepImages: false };

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function sessionFixture(taskId = 'task-a') {
  const runtime = mkdtempSync(join(tmpdir(), 'uc-bench-pro-runtime-'));
  temporaryRoots.push(runtime);
  const taskDirectory = mkdtempSync(join(tmpdir(), 'uc-bench-pro-task-'));
  temporaryRoots.push(taskDirectory);
  mkdirSync(join(taskDirectory, 'codex-home', 'sessions'), { recursive: true, mode: 0o700 });
  const runtimeHome = join(runtime, 'home');
  const runtimeCodex = join(runtime, 'codex-home');
  mkdirSync(runtimeHome, { mode: 0o700 });
  mkdirSync(runtimeCodex, { mode: 0o700 });
  const runtimeNonce = 'a'.repeat(64);
  writeFileSync(join(runtime, 'ownership.json'), `${JSON.stringify({
    schemaVersion: 2,
    kind: 'ultracode-swebench-pro-session-runtime',
    runId: 'pilot1',
    taskId,
    arm: 'a',
    runtimeNonce,
  })}\n`, { mode: 0o600 });
  const id = 'b'.repeat(64);
  const image = {
    overlayName: 'ultracode-swebench-pro:test',
    overlayLocalId: `sha256:${'c'.repeat(64)}`,
  } as never;
  const artifactOwner = {
    uid: typeof process.getuid === 'function' ? process.getuid() : 0,
    gid: typeof process.getgid === 'function' ? process.getgid() : 0,
  };
  const taskIdentity = sessionTaskIdentity(artifactOwner);
  const inspect = JSON.stringify([{
    Id: id,
    Image: image.overlayLocalId,
    Config: { Image: image.overlayName, Labels: {
      'ultracode.benchmark.schema': '2',
      'ultracode.benchmark.suite': 'swebench-pro',
      'ultracode.benchmark.run': 'pilot1',
      'ultracode.benchmark.task': 'task-a',
      'ultracode.benchmark.arm': 'a',
      'ultracode.benchmark.purpose': 'session',
      'ultracode.benchmark.ownership': '1',
      'ultracode.benchmark.runtime': runtimeNonce,
      'ultracode.benchmark.task-uid': String(taskIdentity.uid),
      'ultracode.benchmark.task-gid': String(taskIdentity.gid),
      'ultracode.benchmark.artifact-uid': String(artifactOwner.uid),
      'ultracode.benchmark.artifact-gid': String(artifactOwner.gid),
    } },
    State: { Running: false },
    Mounts: [
      { Type: 'bind', Source: taskDirectory, Destination: '/bench' },
      { Type: 'bind', Source: runtimeHome, Destination: '/runtime/home' },
      { Type: 'bind', Source: runtimeCodex, Destination: '/runtime/codex-home' },
      {
        Type: 'bind',
        Source: join(taskDirectory, 'codex-home', 'sessions'),
        Destination: '/runtime/codex-home/sessions',
      },
    ],
  }]);
  return {
    runtime,
    taskDirectory,
    id,
    inspect,
    image,
    artifactOwner,
    reclamation: { docker, policy },
  };
}

function isReclamationQuery(argv: readonly string[]): boolean {
  return argv.some((entry) => entry.includes('ucbench-reclaim-'));
}

function reclamationFixture(taskId = 'task-a') {
  const fixture = sessionFixture(taskId);
  const name = reclamationContainerName('pilot1', taskId, 'a');
  const options = {
    runId: 'pilot1',
    taskId,
    arm: 'a' as const,
    taskDirectory: fixture.taskDirectory,
    runtimeDirectory: fixture.runtime,
    runtimeNonce: 'a'.repeat(64),
    artifactOwner: fixture.artifactOwner,
    image: fixture.image,
    docker,
    policy,
  };
  const argv = reclamationDockerRunArgv({ ...options, name });
  const labels: Record<string, string> = {};
  const mounts: Array<{ Type: string; Source: string; Destination: string; RW: boolean }> = [];
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--label') {
      const [key, ...value] = argv[index + 1]!.split('=');
      labels[key!] = value.join('=');
    }
    if (argv[index] === '--mount') {
      const fields = Object.fromEntries(argv[index + 1]!.split(',').map((field) => field.split('=')));
      mounts.push({ Type: 'bind', Source: fields.src!, Destination: fields.dst!, RW: true });
    }
  }
  const imageIndex = argv.indexOf(fixture.image.overlayLocalId);
  const command = argv.slice(imageIndex + 1);
  const id = 'd'.repeat(64);
  const record = {
    Id: id,
    Name: `/${name}`,
    Image: fixture.image.overlayLocalId,
    Path: '/bin/bash',
    Args: command,
    Config: {
      Image: fixture.image.overlayLocalId,
      Labels: labels,
      User: '0:0',
      Entrypoint: ['/bin/bash'],
      Cmd: command,
    },
    HostConfig: {
      AutoRemove: true,
      NetworkMode: 'none',
      Privileged: false,
      ReadonlyRootfs: false,
      PublishAllPorts: false,
      Devices: [],
      PidMode: '',
      IpcMode: 'private',
      RestartPolicy: { Name: 'no', MaximumRetryCount: 0 },
      PidsLimit: 64,
      SecurityOpt: ['no-new-privileges'],
      CapDrop: ['ALL'],
      CapAdd: ['CHOWN', 'DAC_OVERRIDE', 'FOWNER'],
      NanoCpus: 1_000_000_000,
      Memory: 1_000_000,
    },
    State: { Running: false },
    Mounts: mounts,
  };
  return { ...fixture, name, options, argv, id, record };
}

describe('SWE-bench Pro ownership cleanup', () => {
  it('reclaims artifacts and runtime homes after the owned container vanished', async () => {
    const { runtime, taskDirectory, image, artifactOwner, reclamation } = sessionFixture();
    const calls: string[][] = [];
    const executor: SessionDockerExecutor = async (argv) => {
      calls.push([...argv]);
      if (argv[0] === 'ps') return '';
      if (argv[0] === 'run') return '';
      throw new Error(`unexpected Docker invocation: ${argv.join(' ')}`);
    };
    await stopPersistedSessionContainer(
      'session-name',
      'pilot1',
      'task-a',
      'a',
      {},
      executor,
      { taskDirectory, image, artifactOwner, runtimeDirectory: runtime, ...reclamation },
    );
    expect(calls.map((argv) => argv[0])).toEqual(['ps', 'ps', 'run', 'ps']);
    expect(calls[2]).toContain('FOWNER');
    expect(existsSync(runtime)).toBe(false);
    expect(statSync(taskDirectory).mode & 0o777).toBe(0o700);
  });

  it('accepts an ambiguous rm failure only after the exact name is proven absent', async () => {
    const { runtime, taskDirectory, id, inspect, image, artifactOwner, reclamation } = sessionFixture();
    const calls: string[][] = [];
    let listed = true;
    const executor: SessionDockerExecutor = async (argv) => {
      calls.push([...argv]);
      if (argv[0] === 'ps') {
        if (isReclamationQuery(argv)) return '';
        if (listed) return id;
        return '';
      }
      if (argv[0] === 'inspect') return inspect;
      if (argv[0] === 'run') return '';
      if (argv[0] === 'rm') {
        listed = false;
        throw new Error('daemon connection ended after accepting removal');
      }
      throw new Error(`unexpected Docker invocation: ${argv.join(' ')}`);
    };
    await expect(stopPersistedSessionContainer(
      'session-name', 'pilot1', 'task-a', 'a', {}, executor,
      { taskDirectory, image, artifactOwner, ...reclamation },
    )).resolves.toBeUndefined();
    expect(calls.map((argv) => argv[0])).toEqual([
      'ps', 'inspect', 'ps', 'run', 'ps', 'rm', 'ps',
    ]);
    expect(existsSync(runtime)).toBe(false);
  });

  it('retains the runtime and raises a typed command-fatal error while the name remains', async () => {
    const { runtime, taskDirectory, id, inspect, image, artifactOwner, reclamation } = sessionFixture();
    const executor: SessionDockerExecutor = async (argv) => {
      if (argv[0] === 'ps') return isReclamationQuery(argv) ? '' : id;
      if (argv[0] === 'inspect') return inspect;
      if (argv[0] === 'run') return '';
      if (argv[0] === 'rm') throw new Error('removal failed');
      throw new Error(`unexpected Docker invocation: ${argv.join(' ')}`);
    };
    const rejection = stopPersistedSessionContainer(
      'session-name', 'pilot1', 'task-a', 'a', {}, executor,
      { taskDirectory, image, artifactOwner, ...reclamation },
    );
    await expect(rejection).rejects.toBeInstanceOf(OwnershipUnsafeCleanupError);
    await expect(rejection).rejects.toMatchObject({ code: 'ownership-unsafe' });
    expect(existsSync(runtime)).toBe(true);
  });

  it('reclaims trusted writable mounts before removing a running crash survivor', async () => {
    const { runtime, taskDirectory, id, inspect, image, artifactOwner, reclamation } = sessionFixture();
    const artifact = join(taskDirectory, 'task-output.txt');
    writeFileSync(artifact, 'result');
    chmodSync(taskDirectory, 0o000);
    let running = true;
    const calls: Array<{ argv: string[]; timeoutMs: number | undefined }> = [];
    let listed = true;
    const executor: SessionDockerExecutor = async (argv, _lifecycle, timeoutMs) => {
      calls.push({ argv: [...argv], timeoutMs });
      if (argv[0] === 'ps') return isReclamationQuery(argv) ? '' : listed ? id : '';
      if (argv[0] === 'inspect') {
        return JSON.stringify([{ ...JSON.parse(inspect)[0], State: { Running: running } }]);
      }
      if (argv[0] === 'stop') {
        running = false;
        return '';
      }
      if (argv[0] === 'run') {
        chmodSync(taskDirectory, 0o700);
        return '';
      }
      if (argv[0] === 'rm') {
        listed = false;
        return '';
      }
      throw new Error(`unexpected Docker invocation: ${argv.join(' ')}`);
    };
    await stopPersistedSessionContainer(
      'session-name',
      'pilot1',
      'task-a',
      'a',
      {},
      executor,
      {
        attemptDeadline: performance.now() + 60_000,
        taskDirectory,
        image,
        artifactOwner,
        ...reclamation,
      },
    );
    expect(calls.map(({ argv }) => argv[0])).toEqual([
      'ps', 'inspect', 'stop', 'inspect', 'ps', 'run', 'ps', 'rm', 'ps',
    ]);
    expect(calls[5]!.argv).toContain(image.overlayLocalId);
    expect(calls.every(({ timeoutMs }) => typeof timeoutMs === 'number' && timeoutMs > 0)).toBe(true);
    const timeouts = calls.map(({ timeoutMs }) => timeoutMs!);
    expect(timeouts.every((timeoutMs, index) => index === 0 || timeoutMs <= timeouts[index - 1]!)).toBe(true);
    expect(statSync(taskDirectory).mode & 0o777).toBe(0o700);
    expect(statSync(artifact).mode & 0o777).toBe(0o600);
    expect(existsSync(runtime)).toBe(false);
  });

  it('fails ownership-unsafe before Docker when the cleanup deadline is exhausted', async () => {
    let calls = 0;
    const executor: SessionDockerExecutor = async () => {
      calls += 1;
      return '';
    };
    const rejection = stopPersistedSessionContainer(
      'session-name',
      'pilot1',
      'task-a',
      'a',
      {},
      executor,
      { attemptDeadline: performance.now() },
    );
    await expect(rejection).rejects.toMatchObject({ code: 'ownership-unsafe' });
    expect(calls).toBe(0);
  });

  it('retains the container when writable mount ownership is not exactly bounded', async () => {
    const { runtime, taskDirectory, id, inspect, image, artifactOwner } = sessionFixture();
    const parsed = JSON.parse(inspect);
    parsed[0].State = { Running: true };
    parsed[0].Mounts.push({ Type: 'bind', Source: '/untrusted', Destination: '/bench/nested' });
    const calls: string[] = [];
    const executor: SessionDockerExecutor = async (argv) => {
      calls.push(argv[0]!);
      if (argv[0] === 'ps') return id;
      if (argv[0] === 'inspect') return JSON.stringify(parsed);
      throw new Error('ownership reclamation must not run');
    };
    await expect(stopPersistedSessionContainer(
      'session-name', 'pilot1', 'task-a', 'a', {}, executor, { taskDirectory, image, artifactOwner },
    )).rejects.toMatchObject({ code: 'ownership-unsafe' });
    expect(calls).toEqual(['ps', 'inspect']);
    expect(existsSync(runtime)).toBe(true);
  });

  it('rejects a spoofed image or runtime source before stopping or reclaiming as root', async () => {
    const { taskDirectory, id, inspect, image, artifactOwner } = sessionFixture();
    const parsed = JSON.parse(inspect);
    parsed[0].State = { Running: true };
    parsed[0].Mounts.find((mount: { Destination: string }) =>
      mount.Destination === '/runtime/home').Source = '/untrusted';
    const calls: string[] = [];
    const executor: SessionDockerExecutor = async (argv) => {
      calls.push(argv[0]!);
      if (argv[0] === 'ps') return id;
      if (argv[0] === 'inspect') return JSON.stringify(parsed);
      throw new Error('privileged recovery must not run');
    };
    await expect(stopPersistedSessionContainer(
      'session-name',
      'pilot1',
      'task-a',
      'a',
      {},
      executor,
      { taskDirectory, image, artifactOwner },
    )).rejects.toMatchObject({ code: 'ownership-unsafe' });
    expect(calls).toEqual(['ps', 'inspect']);
  });

  it('reconciles daemon acceptance followed by client failure and reruns reclamation idempotently', async () => {
    const { options, argv: expectedArgv, id, record } = reclamationFixture('task-client-failure');
    const calls: string[][] = [];
    let present = false;
    let launches = 0;
    const executor: SessionDockerExecutor = async (argv) => {
      calls.push([...argv]);
      if (argv[0] === 'ps') return present ? id : '';
      if (argv[0] === 'inspect') return JSON.stringify([record]);
      if (argv[0] === 'rm') {
        present = false;
        return '';
      }
      if (argv[0] === 'run') {
        expect(argv).toEqual(expectedArgv);
        launches += 1;
        if (launches === 1) {
          present = true;
          throw new Error('daemon accepted helper before client disconnect');
        }
        return '';
      }
      throw new Error(`unexpected Docker invocation: ${argv.join(' ')}`);
    };
    await expect(reclaimSessionOwnership(options, {}, executor)).resolves.toBeUndefined();
    expect(calls.map((argv) => argv[0])).toEqual([
      'ps', 'run', 'ps', 'inspect', 'rm', 'ps', 'run', 'ps',
    ]);
    expect(launches).toBe(2);
  });

  it('stops and removes a valid prior survivor before rerunning reclamation', async () => {
    const { options, id, record } = reclamationFixture('task-survivor');
    const calls: string[][] = [];
    let present = true;
    let running = true;
    const executor: SessionDockerExecutor = async (argv) => {
      calls.push([...argv]);
      if (argv[0] === 'ps') return present ? id : '';
      if (argv[0] === 'inspect') return JSON.stringify([{ ...record, State: { Running: running } }]);
      if (argv[0] === 'stop') {
        running = false;
        return '';
      }
      if (argv[0] === 'rm') {
        present = false;
        return '';
      }
      if (argv[0] === 'run') return '';
      throw new Error(`unexpected Docker invocation: ${argv.join(' ')}`);
    };
    await reclaimSessionOwnership(options, {}, executor);
    expect(calls.map((argv) => argv[0])).toEqual([
      'ps', 'inspect', 'stop', 'ps', 'inspect', 'rm', 'ps', 'run', 'ps',
    ]);
  });

  it('accepts stop-triggered auto-removal of a running --rm survivor', async () => {
    const { options, id, record } = reclamationFixture('task-auto-remove');
    const calls: string[] = [];
    let present = true;
    const executor: SessionDockerExecutor = async (argv) => {
      calls.push(argv[0]!);
      if (argv[0] === 'ps') return present ? id : '';
      if (argv[0] === 'inspect') return JSON.stringify([{ ...record, State: { Running: true } }]);
      if (argv[0] === 'stop') {
        present = false;
        return '';
      }
      if (argv[0] === 'run') return '';
      throw new Error(`unexpected Docker invocation: ${argv.join(' ')}`);
    };
    await expect(reclaimSessionOwnership(options, {}, executor)).resolves.toBeUndefined();
    expect(calls).toEqual(['ps', 'inspect', 'stop', 'ps', 'run', 'ps']);
  });

  it('retains and rejects a spoofed same-name reclamation container', async () => {
    const { options, id, record } = reclamationFixture('task-spoof');
    const spoof = structuredClone(record);
    spoof.Config.Labels['ultracode.benchmark.purpose'] = 'session';
    const calls: string[] = [];
    const executor: SessionDockerExecutor = async (argv) => {
      calls.push(argv[0]!);
      if (argv[0] === 'ps') return id;
      if (argv[0] === 'inspect') return JSON.stringify([spoof]);
      throw new Error('spoofed helper must be retained');
    };
    await expect(reclaimSessionOwnership(options, {}, executor)).rejects.toMatchObject({
      code: 'ownership-unsafe',
    });
    expect(calls).toEqual(['ps', 'inspect']);
  });

  it('admits run-wide reclamation cleanup only under the complete helper proof', () => {
    const { options, id, record, taskDirectory, image, artifactOwner } =
      reclamationFixture('task-run-cleanup');
    const evidence = {
      taskDirectories: new Map([[`${options.taskId}\0${options.arm}`, taskDirectory]]),
      imageAttestations: new Map([[options.taskId, image]]),
      artifactOwner,
      docker,
      policy,
    };
    expect(ownedRunContainerIds(
      [record],
      options.runId,
      new Set([options.taskId]),
      new Set(),
      undefined,
      evidence,
    )).toEqual([id]);
    expect(ownedRunContainerIds(
      [{ ...record, HostConfig: { ...record.HostConfig, NetworkMode: 'bridge' } }],
      options.runId,
      new Set([options.taskId]),
      new Set(),
      undefined,
      evidence,
    )).toEqual([]);
  });

  it('queries every immutable reclamation name instead of trusting run labels', async () => {
    const manifest = {
      runId: 'pilot1',
      artifacts: { executions: [
        { taskId: 'task-a', arm: 'a' },
        { taskId: 'task-b', arm: 'b' },
      ] },
    } as never;
    const queries: string[][] = [];
    await expect(proveManifestReclamationNamesAbsent(manifest, async (argv) => {
      queries.push([...argv]);
      return '';
    }, () => 1_000)).resolves.toBeUndefined();
    expect(queries).toHaveLength(2);
    expect(queries[0]).toContain(`name=^/${reclamationContainerName('pilot1', 'task-a', 'a')}$`);
    expect(queries[1]).toContain(`name=^/${reclamationContainerName('pilot1', 'task-b', 'b')}$`);

    await expect(proveManifestReclamationNamesAbsent(manifest, async () => 'e'.repeat(64), () => 1_000))
      .rejects.toThrow(/name remains occupied/);
  });

  it('registers an in-flight helper for exact root fatal cleanup', async () => {
    const { options, id, record } = reclamationFixture('task-active-registry');
    let present = false;
    let running = false;
    let releaseLaunch!: () => void;
    const launchReleased = new Promise<void>((resolvePromise) => { releaseLaunch = resolvePromise; });
    let announceLaunch!: () => void;
    const launchAnnounced = new Promise<void>((resolvePromise) => { announceLaunch = resolvePromise; });
    const executor: SessionDockerExecutor = async (argv) => {
      if (argv[0] === 'ps') return present ? id : '';
      if (argv[0] === 'inspect') return JSON.stringify([{ ...record, State: { Running: running } }]);
      if (argv[0] === 'run') {
        present = true;
        running = true;
        announceLaunch();
        await launchReleased;
        return '';
      }
      if (argv[0] === 'stop') {
        running = false;
        return '';
      }
      if (argv[0] === 'rm') {
        present = false;
        return '';
      }
      throw new Error(`unexpected Docker invocation: ${argv.join(' ')}`);
    };
    const reclaiming = reclaimSessionOwnership(options, {}, executor);
    await launchAnnounced;
    await expect(cleanupActiveReclamationHelpers()).resolves.toBe(1);
    expect(present).toBe(false);
    releaseLaunch();
    await expect(reclaiming).resolves.toBeUndefined();
    await expect(cleanupActiveReclamationHelpers()).resolves.toBe(0);
  });

  it('gives retained-helper mandatory cleanup a fresh deadline and releases its registry key', async () => {
    const { options, id, record } = reclamationFixture('task-fresh-cleanup-deadline');
    let present = false;
    let timeoutCalls = 0;
    const executor: SessionDockerExecutor = async (argv, _lifecycle, timeoutMs) => {
      expect(timeoutMs).toBeGreaterThan(0);
      if (argv[0] === 'ps') return present ? id : '';
      if (argv[0] === 'inspect') return JSON.stringify([record]);
      if (argv[0] === 'run') {
        present = true;
        throw new Error('daemon accepted helper after the original deadline');
      }
      if (argv[0] === 'rm') {
        present = false;
        return '';
      }
      throw new Error(`unexpected Docker invocation: ${argv.join(' ')}`);
    };
    const exhausted = (): number => {
      timeoutCalls++;
      if (timeoutCalls >= 3) throw new Error('original deadline exhausted');
      return 1;
    };
    const failed = reclaimSessionOwnership(options, {}, executor, exhausted);
    await expect(settleSessionWorkers([failed])).rejects.toMatchObject({ code: 'ownership-unsafe' });
    expect(present).toBe(false);
    await expect(cleanupActiveReclamationHelpers()).resolves.toBe(0);
  });

  it.each([
    ['name', (record: ReturnType<typeof reclamationFixture>['record']) => { record.Name = '/other'; }],
    ['image', (record: ReturnType<typeof reclamationFixture>['record']) => { record.Image = `sha256:${'0'.repeat(64)}`; }],
    ['command', (record: ReturnType<typeof reclamationFixture>['record']) => { record.Args = ['-c', 'true']; }],
    ['user', (record: ReturnType<typeof reclamationFixture>['record']) => { record.Config.User = '1000:1000'; }],
    ['capabilities', (record: ReturnType<typeof reclamationFixture>['record']) => { record.HostConfig.CapAdd = ['CHOWN']; }],
    ['auto-remove', (record: ReturnType<typeof reclamationFixture>['record']) => { record.HostConfig.AutoRemove = false; }],
    ['privileged', (record: ReturnType<typeof reclamationFixture>['record']) => { record.HostConfig.Privileged = true; }],
    ['devices', (record: ReturnType<typeof reclamationFixture>['record']) => { record.HostConfig.Devices = [{ PathOnHost: '/dev/kvm' }]; }],
    ['pid mode', (record: ReturnType<typeof reclamationFixture>['record']) => { record.HostConfig.PidMode = 'host'; }],
    ['ipc mode', (record: ReturnType<typeof reclamationFixture>['record']) => { record.HostConfig.IpcMode = 'host'; }],
    ['restart', (record: ReturnType<typeof reclamationFixture>['record']) => { record.HostConfig.RestartPolicy = { Name: 'always', MaximumRetryCount: 0 }; }],
    ['network', (record: ReturnType<typeof reclamationFixture>['record']) => { record.HostConfig.NetworkMode = 'bridge'; }],
    ['pids', (record: ReturnType<typeof reclamationFixture>['record']) => { record.HostConfig.PidsLimit = 65; }],
    ['cpu', (record: ReturnType<typeof reclamationFixture>['record']) => { record.HostConfig.NanoCpus = 2; }],
    ['memory', (record: ReturnType<typeof reclamationFixture>['record']) => { record.HostConfig.Memory = 2; }],
    ['mount source', (record: ReturnType<typeof reclamationFixture>['record']) => { record.Mounts[0]!.Source = '/other'; }],
    ['mount destination', (record: ReturnType<typeof reclamationFixture>['record']) => { record.Mounts[0]!.Destination = '/other'; }],
    ['read-only mount', (record: ReturnType<typeof reclamationFixture>['record']) => { record.Mounts[0]!.RW = false; }],
  ] as const)('rejects reclamation helper %s drift before root execution', async (_name, mutate) => {
    const { options, id, record } = reclamationFixture(`task-policy-${_name.replace(' ', '-')}`);
    mutate(record);
    const calls: string[] = [];
    const executor: SessionDockerExecutor = async (argv) => {
      calls.push(argv[0]!);
      if (argv[0] === 'ps') return id;
      if (argv[0] === 'inspect') return JSON.stringify([record]);
      throw new Error('mutated helper must be retained');
    };
    await expect(reclaimSessionOwnership(options, {}, executor)).rejects.toMatchObject({
      code: 'ownership-unsafe',
    });
    expect(calls).toEqual(['ps', 'inspect']);
  });

  it('retains runtime and artifacts until reclamation-helper absence is proven', async () => {
    const { runtime, taskDirectory, options, id, record, image, artifactOwner, reclamation } =
      reclamationFixture('task-ordering');
    const sentinel = join(taskDirectory, 'sentinel.txt');
    writeFileSync(sentinel, 'retained');
    let helperPresent = false;
    let sessionQuery = true;
    const executor: SessionDockerExecutor = async (argv) => {
      if (argv[0] === 'ps' && !isReclamationQuery(argv) && sessionQuery) {
        sessionQuery = false;
        return '';
      }
      if (argv[0] === 'ps') return helperPresent ? id : '';
      if (argv[0] === 'inspect') return JSON.stringify([record]);
      if (argv[0] === 'run') {
        helperPresent = true;
        throw new Error('client failed after daemon acceptance');
      }
      if (argv[0] === 'rm') throw new Error('helper removal failed');
      throw new Error(`unexpected Docker invocation: ${argv.join(' ')}`);
    };
    await expect(stopPersistedSessionContainer(
      'session-ordering',
      options.runId,
      options.taskId,
      options.arm,
      {},
      executor,
      {
        taskDirectory,
        runtimeDirectory: runtime,
        image,
        artifactOwner,
        ...reclamation,
      },
    )).rejects.toMatchObject({ code: 'ownership-unsafe' });
    expect(existsSync(runtime)).toBe(true);
    expect(existsSync(sentinel)).toBe(true);
  });

  it('settles workers, performs one mandatory retry, and still propagates the retained aggregate', async () => {
    const events: string[] = [];
    const fatal = Promise.resolve().then(() => {
      events.push('fatal-worker');
      throw new OwnershipUnsafeCleanupError('initial cleanup ambiguity', [new Error('rm failed')]);
    });
    const settling = Promise.resolve().then(() => {
      events.push('other-worker-settled');
    });
    let caught: unknown;
    try {
      await settleSessionWorkers([fatal, settling], async () => {
        events.push('mandatory-retry');
      });
    } catch (error) {
      caught = error;
    }
    expect(events).toEqual(['fatal-worker', 'other-worker-settled', 'mandatory-retry']);
    expect(caught).toBeInstanceOf(OwnershipUnsafeCleanupError);
    expect(caught).toMatchObject({
      code: 'ownership-unsafe',
      failures: [expect.objectContaining({ message: 'rm failed' })],
    });
  });
});
