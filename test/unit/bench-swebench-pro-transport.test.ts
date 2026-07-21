/** Deterministic offline coverage for the Pro relay contract and Docker topology. */
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { acquireBenchLock } from '../../bench/src/shared/locks.js';
import { createBenchPathRoots } from '../../bench/src/shared/paths.js';
import { BenchProcessError } from '../../bench/src/shared/process.js';
import { sha256CanonicalJson } from '../../bench/src/shared/provenance.js';
import {
  SWEBENCH_PRO_MODEL_RELAY_CONTRACT,
  SWEBENCH_PRO_MODEL_RELAY_CONTRACT_SHA256,
  SWEBENCH_PRO_NETWORK_POLICY,
  SwebenchProTransportAttestationError,
  inspectSwebenchProSessionAttachment,
  inspectSwebenchProTransportBoundary,
  loadSwebenchProTransportBindings,
  swebenchProTransportPolicyLockFile,
  swebenchProTransportPolicyLockRoot,
} from '../../bench/src/suites/swebench-pro/model-transport.js';
import {
  SwebenchProRunFatalController,
  assertModelTransportProvenance,
  attestModelTransport,
  attestSessionTransportAttachment,
  sessionFailure,
  startAttestedSessionTransport,
} from '../../bench/src/suites/swebench-pro/runner.js';

const RELAY_ID = 'a'.repeat(64);
const SESSION_ID = 'b'.repeat(64);
const IMAGE_ID = `sha256:${'c'.repeat(64)}`;
const RUNTIME_NONCE = 'd'.repeat(64);
const MODEL = 'gpt-test';
const TRUSTED_LOADER = '/opt/bench/node-musl-runtime/ld-musl-x86_64.so.1';
const TRUSTED_BUSYBOX = '/opt/bench/node-musl-runtime/busybox';
const SESSION_GATE = '/opt/bench/session-gate.sh';
const SESSION_COMMAND = [
  TRUSTED_BUSYBOX, 'sh', SESSION_GATE, '/bin/bash', '/opt/bench/entrypoint.sh',
];
const config = {
  relayIdentity: 'relay-public-id',
  relayVersion: 'relay-v1',
  fixedDestination: 'https://api.openai.com/v1',
};
const bindings = {
  relayBaseUrl: 'http://relay.test:8080/v1',
  restrictedNetwork: 'swebench-pro-private',
};
const textHash = (value: string): string => createHash('sha256').update(value, 'utf8').digest('hex');
const destinationHash = sha256CanonicalJson({
  protocol: 'https:', hostname: 'api.openai.com', port: '', pathname: '/v1',
});

function network(containers: Record<string, { Name: string }> = {
  [RELAY_ID]: { Name: 'relay.test' },
}): string {
  return JSON.stringify([{
    Name: bindings.restrictedNetwork,
    Internal: true,
    Driver: 'bridge',
    Scope: 'local',
    Attachable: false,
    Ingress: false,
    Labels: { 'ultracode.egress-policy': SWEBENCH_PRO_NETWORK_POLICY.policyLabel },
    Options: { 'com.docker.network.bridge.enable_ip_masquerade': 'false' },
    IPAM: { Driver: 'default' },
    Containers: containers,
  }]);
}

function relay(
  overrides: Record<string, unknown> = {},
  otherContainers: readonly Record<string, unknown>[] = [],
): string {
  return JSON.stringify([{
    Id: RELAY_ID,
    Name: '/relay.test',
    Image: IMAGE_ID,
    Path: '/relay',
    Args: ['serve'],
    State: { Running: true },
    Config: {
      Image: `relay@sha256:${'d'.repeat(64)}`,
      Labels: {
        'ultracode.model-relay': 'true',
        'ultracode.model-relay.identity': config.relayIdentity,
        'ultracode.model-relay.version': config.relayVersion,
        'ultracode.model-relay.contract-sha256': SWEBENCH_PRO_MODEL_RELAY_CONTRACT_SHA256,
        'ultracode.model-relay.destination-sha256': destinationHash,
        'ultracode.model-relay.model-sha256': textHash(MODEL),
      },
    },
    HostConfig: { Binds: ['/private/provider:/run/provider:ro'], Mounts: [], Tmpfs: {} },
    Mounts: [{ Type: 'bind', Destination: '/run/provider', RW: false }],
    NetworkSettings: { Networks: { 'swebench-pro-private': {}, 'relay-wan': {} } },
    ...overrides,
  }, ...otherContainers]);
}

function session(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify([{
    Id: SESSION_ID,
    Name: '/session-one',
    Image: IMAGE_ID,
    State: { Running: true },
    Config: {
      Image: IMAGE_ID,
      User: '0:0',
      Entrypoint: [TRUSTED_LOADER],
      Cmd: SESSION_COMMAND,
      Labels: {
        'ultracode.benchmark.schema': '2',
        'ultracode.benchmark.suite': 'swebench-pro',
        'ultracode.benchmark.run': 'pilot1',
        'ultracode.benchmark.task': 'task-one',
        'ultracode.benchmark.arm': 'a',
        'ultracode.benchmark.purpose': 'session',
        'ultracode.benchmark.ownership': '1',
        'ultracode.benchmark.runtime': RUNTIME_NONCE,
      },
      Env: [
        'HOME=/runtime/home',
        `BENCH_MODEL_RELAY_BASE_URL=${bindings.relayBaseUrl}`,
        `BENCH_RUNTIME_NONCE=${RUNTIME_NONCE}`,
        'BASH_ENV=',
        'ENV=',
        'LD_PRELOAD=',
        'LD_AUDIT=',
        'LD_LIBRARY_PATH=',
        'NODE_OPTIONS=',
      ],
      Healthcheck: { Test: ['NONE'] },
    },
    HostConfig: {
      AutoRemove: false,
      NetworkMode: bindings.restrictedNetwork,
      Privileged: false,
      ReadonlyRootfs: false,
      PublishAllPorts: false,
      Devices: [],
      PidMode: '',
      IpcMode: 'private',
      RestartPolicy: { Name: 'no', MaximumRetryCount: 0 },
      PidsLimit: 1_024,
      SecurityOpt: ['no-new-privileges'],
      CapDrop: ['ALL'],
      CapAdd: ['CHOWN', 'DAC_OVERRIDE', 'SETGID', 'SETPCAP', 'SETUID'],
      NanoCpus: 1_500_000_000,
      Memory: 2_000_000,
    },
    Mounts: [
      { Type: 'bind', Source: '/run/task-one', Destination: '/bench', RW: true },
      { Type: 'bind', Source: '/runtime/home', Destination: '/runtime/home', RW: true },
      { Type: 'bind', Source: '/runtime/codex-home', Destination: '/runtime/codex-home', RW: true },
      {
        Type: 'bind',
        Source: '/run/task-one/codex-home/sessions',
        Destination: '/runtime/codex-home/sessions',
        RW: true,
      },
    ],
    NetworkSettings: { Networks: { [bindings.restrictedNetwork]: {} } },
    ...overrides,
  }]);
}

const expectedSession = {
  id: SESSION_ID,
  name: 'session-one',
  runId: 'pilot1',
  taskId: 'task-one',
  arm: 'a' as const,
  runtimeNonce: RUNTIME_NONCE,
  imageName: IMAGE_ID,
  imageId: IMAGE_ID,
  running: true,
  containerPolicy: {
    user: '0:0',
    entrypoint: [TRUSTED_LOADER],
    command: SESSION_COMMAND,
    pidsLimit: 1_024,
    securityOpt: ['no-new-privileges'],
    capDrop: ['ALL'],
    capAdd: ['CHOWN', 'DAC_OVERRIDE', 'SETGID', 'SETPCAP', 'SETUID'],
    nanoCpus: 1_500_000_000,
    memoryBytes: 2_000_000,
    mounts: [
      { source: '/run/task-one', destination: '/bench' },
      { source: '/runtime/home', destination: '/runtime/home' },
      { source: '/runtime/codex-home', destination: '/runtime/codex-home' },
      {
        source: '/run/task-one/codex-home/sessions',
        destination: '/runtime/codex-home/sessions',
      },
    ],
  },
};

describe('SWE-bench Pro attested model relay contract', () => {
  it('freezes a Responses-only request and fixed-destination policy', () => {
    expect(SWEBENCH_PRO_MODEL_RELAY_CONTRACT_SHA256)
      .toBe('c4608a577487f503bfd5d26269107511607b8a4b2c7e5c9eb0e14acd77748990');
    expect(SWEBENCH_PRO_MODEL_RELAY_CONTRACT).toMatchObject({
      wireProtocol: 'openai-responses',
      requests: [
        { method: 'POST', path: '/v1/responses' },
        { method: 'POST', path: '/v1/responses/compact' },
      ],
      requestPolicy: {
        body: 'strict-supported-codex-responses-schema',
        providerHostedTools: 'reject',
        remoteMcp: 'reject',
        externalUrlsFileIdsAndVectorStores: 'reject',
        background: 'reject',
        connect: 'reject',
        absoluteForm: 'reject',
        otherMethodsAndPaths: 'reject',
      },
      destinationPolicy: { genericForwarding: 'reject', redirects: 'reject' },
      credentialPolicy: { taskProviderCredential: 'forbidden', inboundAuthorization: 'reject' },
      responsePolicy: {
        contentTypes: ['application/json', 'text/event-stream'],
        hostedToolAndCitationOutputs: 'reject',
      },
    });
  });

  it('requires fresh runtime-only relay and dedicated-network bindings', () => {
    expect(loadSwebenchProTransportBindings({
      SWEBENCH_PRO_MODEL_RELAY_URL: bindings.relayBaseUrl,
      SWEBENCH_PRO_RESTRICTED_NETWORK: bindings.restrictedNetwork,
    })).toEqual(bindings);
    expect(() => loadSwebenchProTransportBindings({})).toThrow(/model relay URL/);
    expect(() => loadSwebenchProTransportBindings({
      SWEBENCH_PRO_MODEL_RELAY_URL: 'http://user:secret@relay.test:8080/v1',
      SWEBENCH_PRO_RESTRICTED_NETWORK: bindings.restrictedNetwork,
    })).toThrow(/without credentials/);
    expect(() => loadSwebenchProTransportBindings({
      SWEBENCH_PRO_MODEL_RELAY_URL: 'http://relay.test:8080/v1?',
      SWEBENCH_PRO_RESTRICTED_NETWORK: bindings.restrictedNetwork,
    })).toThrow(/without credentials, query, or fragment/);
    expect(() => loadSwebenchProTransportBindings({
      SWEBENCH_PRO_MODEL_RELAY_URL: bindings.relayBaseUrl,
      SWEBENCH_PRO_RESTRICTED_NETWORK: 'bridge',
    })).toThrow(/dedicated restricted/);
    for (const hostname of ['localhost', '127.0.0.1', '0.0.0.0', '169.254.1.1', '[::1]']) {
      expect(() => loadSwebenchProTransportBindings({
        SWEBENCH_PRO_MODEL_RELAY_URL: `http://${hostname}:8080/v1`,
        SWEBENCH_PRO_RESTRICTED_NETWORK: bindings.restrictedNetwork,
      })).toThrow(/Docker DNS endpoint name/);
    }
  });

  it('attests the relay-only preflight and a manifest-stable task topology', () => {
    const preflight = inspectSwebenchProTransportBoundary(network(), relay(), config, MODEL, bindings);
    const running = inspectSwebenchProTransportBoundary(network({
      [RELAY_ID]: { Name: 'relay.test' },
      [SESSION_ID]: { Name: 'session-one' },
    }), relay({}, [JSON.parse(session())[0]]), config, MODEL, bindings,
    new Map([['session-one', SESSION_ID]]), new Set(['session-one']));
    expect(running).toEqual(preflight);
    expect(Object.values(preflight).every((value) => /^[a-f0-9]{64}$/.test(value))).toBe(true);
    expect(JSON.stringify(preflight)).not.toMatch(/relay\.test|swebench-pro-private|api\.openai\.com/);
  });

  it('rejects a generic proxy declaration, identity drift, or any extra endpoint', () => {
    const generic = JSON.parse(relay()) as Array<Record<string, unknown>>;
    const genericConfig = generic[0]!.Config as { Labels: Record<string, string> };
    genericConfig.Labels['ultracode.model-relay.contract-sha256'] = '0'.repeat(64);
    expect(() => inspectSwebenchProTransportBoundary(
      network(), JSON.stringify(generic), config, MODEL, bindings,
    )).toThrow(/contract/);
    expect(() => inspectSwebenchProTransportBoundary(
      network(), relay(), { ...config, relayVersion: 'relay-v2' }, MODEL, bindings,
    )).toThrow(/identity/);
    expect(() => inspectSwebenchProTransportBoundary(network({
      [RELAY_ID]: { Name: 'relay.test' },
      [SESSION_ID]: { Name: 'unattested-endpoint' },
    }), relay(), config, MODEL, bindings)).toThrow(/outside the attested allowlist/);
  });

  it('rejects a non-internal, attachable, or non-local network', () => {
    for (const drift of [
      { Internal: false },
      { Attachable: true },
      { Scope: 'swarm' },
    ]) {
      const parsed = JSON.parse(network()) as Array<Record<string, unknown>>;
      Object.assign(parsed[0]!, drift);
      expect(() => inspectSwebenchProTransportBoundary(
        JSON.stringify(parsed), relay(), config, MODEL, bindings,
      )).toThrow(/internal network|dedicated local bridge/);
    }
  });

  it('types every inspect, parse, attachment, and manifest attestation stage as run-fatal', async () => {
    const runnerConfig = { model: MODEL, modelTransport: config } as never;
    const rejecting = (stage: 'network' | 'relay') => async (argv: readonly string[]): Promise<string> => {
      if (argv[0] === 'network') {
        if (stage === 'network') throw new Error('injected network inspect rejection');
        return network();
      }
      if (stage === 'relay') throw new Error('injected relay inspect rejection');
      return relay();
    };
    await expect(attestModelTransport(runnerConfig, bindings, rejecting('network'))).rejects.toMatchObject({
      code: 'transport-attestation-failed',
      stage: 'restricted-network-inspect',
    });
    await expect(attestModelTransport(runnerConfig, bindings, rejecting('relay'))).rejects.toMatchObject({
      code: 'transport-attestation-failed',
      stage: 'model-relay-inspect',
    });
    for (const [networkInspection, relayInspection] of [
      ['{malformed', relay()],
      [JSON.stringify([JSON.parse(network())[0], JSON.parse(network())[0]]), relay()],
      [network(), '{malformed'],
      [network(), JSON.stringify([JSON.parse(relay())[0], JSON.parse(relay())[0]])],
    ]) {
      expect(() => inspectSwebenchProTransportBoundary(
        networkInspection,
        relayInspection,
        config,
        MODEL,
        bindings,
      )).toThrow(expect.objectContaining({
        code: 'transport-attestation-failed',
        stage: 'transport-boundary',
      }));
    }
    await expect(attestModelTransport(
      runnerConfig,
      { ...bindings, relayBaseUrl: 'not-an-absolute-url' },
      async (argv) => {
        if (argv[0] === 'network') return network();
        throw new Error('relay inspection must not receive an invalid name');
      },
    )).rejects.toMatchObject({
      code: 'transport-attestation-failed',
      stage: 'model-relay-inspect',
    });
    await expect(attestSessionTransportAttachment(
      async () => { throw new Error('injected session inspect rejection'); },
      expectedSession,
      bindings,
    )).rejects.toMatchObject({
      code: 'transport-attestation-failed',
      stage: 'session-inspect',
    });
    for (const inspection of [
      '{malformed',
      JSON.stringify([JSON.parse(session())[0], JSON.parse(session())[0]]),
    ]) {
      expect(() => inspectSwebenchProSessionAttachment(
        inspection,
        expectedSession,
        bindings,
      )).toThrow(expect.objectContaining({
        code: 'transport-attestation-failed',
        stage: 'session-attachment',
      }));
    }
    const attestation = inspectSwebenchProTransportBoundary(network(), relay(), config, MODEL, bindings);
    expect(() => assertModelTransportProvenance({
      provenance: { modelTransport: { mechanism: 'attested-model-relay', ...attestation } },
      suiteConfig: {
        modelTransport: {
          mechanism: 'attested-model-relay',
          ...attestation,
          topologySha256: '0'.repeat(64),
        },
      },
    } as never, attestation)).toThrow(expect.objectContaining({
      code: 'transport-attestation-failed',
      stage: 'manifest-transport',
    }));
  });

  it('aborts overlapping work, starts shared cleanup once, and retains descendant cleanup taxonomy', async () => {
    const events: string[] = [];
    const controller = new SwebenchProRunFatalController(async () => {
      events.push('cleanup');
    });
    const pending = () => new Promise<void>(() => {});
    let resolveLate!: () => void;
    const first = controller.race(pending());
    const late = controller.race(new Promise<void>((resolvePromise) => { resolveLate = resolvePromise; }));
    const fatal = new SwebenchProTransportAttestationError(
      'transport-boundary',
      new Error('injected concurrent drift'),
    );
    controller.abort(fatal);
    controller.abort(new SwebenchProTransportAttestationError(
      'model-relay-inspect',
      new Error('later drift'),
    ));
    await expect(first).rejects.toBe(fatal);
    resolveLate();
    await expect(late).rejects.toBe(fatal);
    await controller.settleCleanup();
    expect(controller.signal.aborted).toBe(true);
    expect(controller.failure).toBe(fatal);
    expect(events).toEqual(['cleanup']);

    const descendant = new BenchProcessError('docker descendant cleanup failed', {
      stdout: '', stderr: '', exitCode: 0, signal: null, elapsedMs: 1,
    });
    expect(sessionFailure(new SwebenchProTransportAttestationError(
      'session-inspect',
      descendant,
    ))).toBe('descendant-cleanup-failed');
    expect(sessionFailure(new SwebenchProTransportAttestationError(
      'session-inspect',
      new AggregateError([new Error('outer cleanup'), descendant]),
    ))).toBe('descendant-cleanup-failed');
  });

  it('computes one default host lock path across temp environments and worktrees', async () => {
    const root = mkdtempSync(join(tmpdir(), 'uc-pro-transport-lock-'));
    const second = mkdtempSync(join(tmpdir(), 'uc-pro-transport-lock-'));
    const environmentNames = [
      'TMPDIR', 'TMP', 'TEMP', 'DOCKER_CONTEXT', 'DOCKER_HOST', 'DOCKER_TLS_VERIFY',
    ];
    const originalEnvironment = new Map(
      environmentNames.map((name) => [name, process.env[name]]),
    );
    try {
      const roots = createBenchPathRoots(root);
      const otherRoots = createBenchPathRoots(second);
      const daemonEnvironmentAliases: NodeJS.ProcessEnv[] = [
        {
          DOCKER_CONTEXT: 'shared-daemon',
          SWEBENCH_PRO_RESTRICTED_NETWORK: bindings.restrictedNetwork,
        },
        {
          DOCKER_HOST: 'unix:///var/run/docker.sock',
          SWEBENCH_PRO_RESTRICTED_NETWORK: bindings.restrictedNetwork,
        },
        {
          DOCKER_CONTEXT: 'default',
          DOCKER_HOST: 'unix:///var/run/docker.sock',
          DOCKER_TLS_VERIFY: '',
          SWEBENCH_PRO_RESTRICTED_NETWORK: bindings.restrictedNetwork,
        },
      ];
      process.env.TMPDIR = '/tmp/uc-pro-first-tmpdir';
      process.env.TMP = '/tmp/uc-pro-first-tmp';
      process.env.TEMP = '/tmp/uc-pro-first-temp';
      const firstRoot = swebenchProTransportPolicyLockRoot();
      const firstLock = swebenchProTransportPolicyLockFile(roots, daemonEnvironmentAliases[0]);
      const uid = typeof process.getuid === 'function' ? process.getuid() : 0;
      expect(firstRoot).toBe(join('/tmp', `ultracode-bench-${uid}`));
      process.env.TMPDIR = '/tmp/uc-pro-second-tmpdir';
      process.env.TMP = '/tmp/uc-pro-second-tmp';
      process.env.TEMP = '/tmp/uc-pro-second-temp';
      expect(swebenchProTransportPolicyLockRoot()).toBe(firstRoot);
      for (const source of daemonEnvironmentAliases) {
        expect(swebenchProTransportPolicyLockFile(roots, source)).toBe(firstLock);
        expect(swebenchProTransportPolicyLockFile(otherRoots, source)).toBe(firstLock);
      }
      const moduleUrl = pathToFileURL(join(
        process.cwd(),
        'bench/src/suites/swebench-pro/model-transport.ts',
      )).href;
      for (const [index, source] of daemonEnvironmentAliases.entries()) {
        for (const name of ['DOCKER_CONTEXT', 'DOCKER_HOST', 'DOCKER_TLS_VERIFY']) {
          delete process.env[name];
        }
        Object.assign(process.env, source, {
          TMPDIR: `/tmp/uc-pro-probe-${index}-tmpdir`,
          TMP: `/tmp/uc-pro-probe-${index}-tmp`,
          TEMP: `/tmp/uc-pro-probe-${index}-temp`,
        });
        const probe = await import(`${moduleUrl}?transport-lock-probe=${index}`);
        const probeRoots = createBenchPathRoots(`/tmp/uc-pro-probe-${index}-worktree`);
        expect(probe.swebenchProTransportPolicyLockRoot()).toBe(firstRoot);
        expect(probe.swebenchProTransportPolicyLockFile(probeRoots)).toBe(firstLock);
      }
      expect(firstLock).toContain('swebench-pro-transport-');
      expect(firstLock).not.toContain('pilot1');
      expect(firstLock.startsWith(firstRoot)).toBe(true);
    } finally {
      for (const [name, value] of originalEnvironment) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
      rmSync(root, { recursive: true, force: true });
      rmSync(second, { recursive: true, force: true });
    }
  });

  it('serializes contention only below an explicitly injected coordination root', async () => {
    const root = mkdtempSync(join(tmpdir(), 'uc-pro-transport-worktree-'));
    const second = mkdtempSync(join(tmpdir(), 'uc-pro-transport-worktree-'));
    const coordinationRoot = mkdtempSync(join(tmpdir(), 'uc-pro-transport-coordination-'));
    try {
      const roots = createBenchPathRoots(root);
      const otherRoots = createBenchPathRoots(second);
      const source = {
        DOCKER_CONTEXT: 'shared-daemon',
        SWEBENCH_PRO_RESTRICTED_NETWORK: bindings.restrictedNetwork,
      };
      const lock = swebenchProTransportPolicyLockFile(roots, source, coordinationRoot);
      expect(swebenchProTransportPolicyLockFile(otherRoots, source, coordinationRoot)).toBe(lock);
      expect(lock.startsWith(coordinationRoot)).toBe(true);
      expect(lock.startsWith(swebenchProTransportPolicyLockRoot())).toBe(false);
      const held = await acquireBenchLock(coordinationRoot, lock);
      try {
        await expect(acquireBenchLock(
          coordinationRoot,
          swebenchProTransportPolicyLockFile(otherRoots, source, coordinationRoot),
        )).rejects.toThrow(/lock is already held/);
      } finally {
        held.release();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(second, { recursive: true, force: true });
      rmSync(coordinationRoot, { recursive: true, force: true });
    }
  });

  it('requires an absolute injected coordination root', () => {
    const root = mkdtempSync(join(tmpdir(), 'uc-pro-transport-worktree-'));
    try {
      const roots = createBenchPathRoots(root);
      expect(() => swebenchProTransportPolicyLockRoot('relative-coordination-root'))
        .toThrow(/must be absolute/);
      expect(() => swebenchProTransportPolicyLockFile(
        roots,
        { DOCKER_CONTEXT: 'shared-daemon' },
        'relative-coordination-root',
      )).toThrow(/must be absolute/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects a symlinked injected lock directory', async () => {
    const root = mkdtempSync(join(tmpdir(), 'uc-pro-transport-worktree-'));
    const coordinationRoot = mkdtempSync(join(tmpdir(), 'uc-pro-transport-coordination-'));
    const symlinkTarget = mkdtempSync(join(tmpdir(), 'uc-pro-transport-symlink-target-'));
    try {
      symlinkSync(symlinkTarget, join(coordinationRoot, '.locks'), 'dir');
      const lock = swebenchProTransportPolicyLockFile(
        createBenchPathRoots(root),
        { DOCKER_CONTEXT: 'shared-daemon' },
        coordinationRoot,
      );
      await expect(acquireBenchLock(coordinationRoot, lock)).rejects.toThrow(/real directory/);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(coordinationRoot, { recursive: true, force: true });
      rmSync(symlinkTarget, { recursive: true, force: true });
    }
  });

  it('rejects a non-private injected lock directory', async () => {
    const root = mkdtempSync(join(tmpdir(), 'uc-pro-transport-worktree-'));
    const coordinationRoot = mkdtempSync(join(tmpdir(), 'uc-pro-transport-coordination-'));
    try {
      const lockDirectory = join(coordinationRoot, '.locks');
      mkdirSync(lockDirectory, { mode: 0o700 });
      chmodSync(lockDirectory, 0o755);
      const lock = swebenchProTransportPolicyLockFile(
        createBenchPathRoots(root),
        { DOCKER_CONTEXT: 'shared-daemon' },
        coordinationRoot,
      );
      await expect(acquireBenchLock(coordinationRoot, lock)).rejects.toThrow(/mode 0700/);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(coordinationRoot, { recursive: true, force: true });
    }
  });
});

describe('SWE-bench Pro task attachment', () => {
  it('accepts exactly one restricted network and no provider credential', () => {
    expect(() => inspectSwebenchProSessionAttachment(session(), expectedSession, bindings)).not.toThrow();
  });

  it('attests the complete stopped container policy before startup', () => {
    const parsed = JSON.parse(session()) as Array<Record<string, unknown>>;
    parsed[0]!.State = { Running: false };
    parsed[0]!.NetworkSettings = { Networks: {} };
    expect(() => inspectSwebenchProSessionAttachment(
      JSON.stringify(parsed),
      { ...expectedSession, running: false },
      bindings,
    )).not.toThrow();
  });

  it('never starts or opens the gate around a failed session attestation', async () => {
    const runtimeHome = mkdtempSync(join(tmpdir(), 'uc-pro-gate-order-'));
    try {
      const gate = join(runtimeHome, '.model-transport-attested');
      const stopped = JSON.parse(session()) as Array<Record<string, unknown>>;
      stopped[0]!.State = { Running: false };
      stopped[0]!.NetworkSettings = { Networks: {} };
      const invalidPreStart = structuredClone(stopped) as Array<{
        Config: { Env: string[] };
      }>;
      invalidPreStart[0]!.Config.Env.push('NODE_OPTIONS=--require=/payload.js');
      const preCalls: string[] = [];
      await expect(startAttestedSessionTransport({
        executor: async (argv) => {
          preCalls.push(argv[0]!);
          if (argv[0] === 'inspect') return JSON.stringify(invalidPreStart);
          throw new Error(`unexpected Docker invocation: ${argv.join(' ')}`);
        },
        expected: expectedSession,
        bindings,
        config: { model: MODEL, modelTransport: config } as never,
        manifest: {} as never,
        allowedSessions: new Map([['session-one', SESSION_ID]]),
        runtimeHome,
        timeoutMs: () => 1_000,
      })).rejects.toMatchObject({ stage: 'session-attachment' });
      expect(preCalls).toEqual(['inspect']);
      expect(existsSync(gate)).toBe(false);

      let inspection = 0;
      await expect(startAttestedSessionTransport({
        executor: async (argv) => {
          if (argv[0] === 'start') return `${SESSION_ID}\n`;
          if (argv[0] !== 'inspect') throw new Error(`unexpected Docker invocation: ${argv.join(' ')}`);
          inspection += 1;
          if (inspection === 1) return JSON.stringify(stopped);
          const running = JSON.parse(session()) as Array<{
            HostConfig: { PidsLimit: number };
          }>;
          running[0]!.HostConfig.PidsLimit = 2_048;
          return JSON.stringify(running);
        },
        expected: expectedSession,
        bindings,
        config: { model: MODEL, modelTransport: config } as never,
        manifest: {} as never,
        allowedSessions: new Map([['session-one', SESSION_ID]]),
        runtimeHome,
        timeoutMs: () => 1_000,
      })).rejects.toMatchObject({ stage: 'session-attachment' });
      expect(inspection).toBe(2);
      expect(existsSync(gate)).toBe(false);
    } finally {
      rmSync(runtimeHome, { recursive: true, force: true });
    }
  });

  it('binds the exact runtime nonce and relay URL before opening the task gate', () => {
    for (const drift of ['label nonce', 'environment nonce', 'relay URL'] as const) {
      const parsed = JSON.parse(session()) as Array<{
        Config: { Labels: Record<string, string>; Env: string[] };
      }>;
      if (drift === 'label nonce') {
        parsed[0]!.Config.Labels['ultracode.benchmark.runtime'] = 'e'.repeat(64);
      } else if (drift === 'environment nonce') {
        parsed[0]!.Config.Env = parsed[0]!.Config.Env.map((entry) =>
          entry.startsWith('BENCH_RUNTIME_NONCE=') ? `BENCH_RUNTIME_NONCE=${'e'.repeat(64)}` : entry);
      } else {
        parsed[0]!.Config.Env = parsed[0]!.Config.Env.map((entry) =>
          entry.startsWith('BENCH_MODEL_RELAY_BASE_URL=')
            ? 'BENCH_MODEL_RELAY_BASE_URL=http://other-task:8080/v1'
            : entry);
      }
      expect(() => inspectSwebenchProSessionAttachment(
        JSON.stringify(parsed),
        expectedSession,
        bindings,
      )).toThrow(expect.objectContaining({
        code: 'transport-attestation-failed',
        stage: 'session-attachment',
      }));
    }
  });

  it('rejects inherited startup hooks or a live image healthcheck', () => {
    for (const kind of ['environment', 'node-options', 'healthcheck'] as const) {
      const parsed = JSON.parse(session()) as Array<{ Config: Record<string, unknown> }>;
      if (kind === 'environment') parsed[0]!.Config.Env = ['BASH_ENV=/task/hook'];
      else if (kind === 'node-options') {
        (parsed[0]!.Config.Env as string[]).push('NODE_OPTIONS=--require=/task/payload.js');
      }
      else parsed[0]!.Config.Healthcheck = { Test: ['CMD', '/task/hook'] };
      expect(() => inspectSwebenchProSessionAttachment(
        JSON.stringify(parsed), expectedSession, bindings,
      )).toThrow(/credential-free restricted-network attachment/);
    }
  });

  it.each([
    ['default network', { HostConfig: { NetworkMode: 'bridge' } }],
    ['WAN attachment', { NetworkSettings: { Networks: { [bindings.restrictedNetwork]: {}, bridge: {} } } }],
    ['provider key', {
      Config: {
        Image: 'task-overlay:one',
        Labels: JSON.parse(session())[0].Config.Labels,
        Env: ['OPENAI_API_KEY=provider-secret'],
      },
    }],
    ['provider client secret', {
      Config: {
        Image: 'task-overlay:one',
        Labels: JSON.parse(session())[0].Config.Labels,
        Env: ['AZURE_CLIENT_SECRET=provider-secret'],
      },
    }],
    ['generic proxy', {
      Config: {
        Image: 'task-overlay:one',
        Labels: JSON.parse(session())[0].Config.Labels,
        Env: ['HTTPS_PROXY=http://relay.test:8080'],
      },
    }],
  ])('rejects %s', (_name, drift) => {
    expect(() => inspectSwebenchProSessionAttachment(session(drift), expectedSession, bindings))
      .toThrow(/credential-free restricted-network/);
  });

  it('configures Codex for the unauthenticated Responses relay with no legacy key injection', () => {
    const entrypoint = readFileSync(join(process.cwd(), 'bench/suites/swebench-pro/entrypoint.sh'), 'utf8');
    const gate = readFileSync(join(process.cwd(), 'bench/suites/swebench-pro/session-gate.sh'), 'utf8');
    expect(entrypoint).toContain('model_provider = "swebench_pro_relay"');
    expect(entrypoint).toContain('wire_api = "responses"');
    expect(entrypoint).toContain('requires_openai_auth = false');
    expect(entrypoint).not.toContain('.model-transport-attested');
    expect(gate).toContain(`BUSYBOX=${TRUSTED_BUSYBOX}`);
    expect(gate).toContain('[ "$observed" = "$NONCE" ]');
    expect(gate).toContain('exec "$@"');
    expect(entrypoint).not.toContain('CODEX_API_KEY');
    expect(entrypoint).not.toContain('auth.json');
  });
});
