/** Strict v2 discriminated manifest and resume-equality coverage. */
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  assertManifestResumeEquality,
  loadBenchRunManifest,
  parseBenchRunManifest,
  writeBenchRunManifest,
} from '../../bench/src/shared/manifest.js';
import {
  artifactKey,
  createBenchPathRoots,
  createPrivateRunDirectory,
  manifestFile,
  runDir,
  runStateFile,
  verifierReceiptFile,
  writePrivateJsonAtomic,
} from '../../bench/src/shared/paths.js';
import { sha256CanonicalJson, sha256File } from '../../bench/src/shared/provenance.js';
import { loadStoredReportEvidence } from '../../bench/src/shared/report.js';

const HASH = 'a'.repeat(64);
const REVISION = 'b'.repeat(40);
const TASK = 'task-one';
const KEY = artifactKey(TASK);
const roots: string[] = [];

const temporary = (): string => {
  const root = mkdtempSync(join(tmpdir(), 'uc-bench-manifest-'));
  roots.push(root);
  return root;
};

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function provenance(): object {
  return {
    toolchain: {
      payloadSha256: HASH,
      manifestSha256: HASH,
      treeSha256: HASH,
      node: {
        version: '22.14.0',
        platform: 'linux-x64',
        archiveSha256: HASH,
        checksumManifestSha256: HASH,
        treeSha256: HASH,
        muslArchiveSha256: HASH,
        muslChecksumManifestSha256: HASH,
        muslTreeSha256: HASH,
        muslRuntimeImageDigest: `node@sha256:${HASH}`,
      },
      codex: { version: '1.2.3', binarySha256: HASH },
      ultracode: { revision: REVISION, releaseSha256: HASH, treeSha256: HASH },
    },
    controlPlane: {
      manifestPolicySha256: HASH,
      metricsPolicySha256: HASH,
      failurePolicySha256: HASH,
      reportPolicySha256: HASH,
      adapterPolicySha256: HASH,
    },
    suiteSource: {
      repository: 'https://example.test/suite.git',
      revision: REVISION,
      treeSha256: HASH,
    },
    dataset: { identity: 'dataset', revision: REVISION, split: 'test', snapshotSha256: HASH },
    environment: {
      platform: 'linux',
      architecture: 'x64',
      nodeVersion: '22.14.0',
      pythonVersion: '3.13.5',
      environmentSha256: HASH,
    },
    nativeAssets: [{ path: 'native/assets', sha256: HASH }],
    tasks: [{ taskId: TASK, sourceSha256: HASH, image: null }],
  };
}

function common(): Record<string, unknown> {
  return {
    schemaVersion: 2,
    kind: 'ultracode-benchmark-run',
    runId: 'pilot1',
    createdAt: '2026-07-20T12:00:00.000Z',
    experiment: { model: 'gpt-test', requestedEffort: 'high', arm: 'a', taskIds: [TASK] },
    limits: {
      hostTaskTimeoutMs: 60_000,
      hostVerifierTimeoutMs: 60_000,
      taskConcurrency: 1,
      verifierConcurrency: 1,
    },
    metricsPolicy: {
      parserContractVersion: 2,
      cachedInputWeight: 0.1,
      compactionRule: 'max-event-record',
      resetMinDropTokens: 16_000,
      resetRetainedFraction: 0.5,
      workflowDedupeRule: 'run-id',
      implementationSha256: HASH,
    },
    pricing: {
      currency: 'USD',
      model: 'gpt-test',
      uncachedInputPerMTokens: 1,
      cachedInputPerMTokens: 0.1,
      outputPerMTokens: 2,
    },
    provenance: provenance(),
  };
}

function proManifest(): Record<string, unknown> {
  const row = { instance_id: TASK, base_commit: REVISION };
  const base = common();
  (base.provenance as { tasks: unknown[] }).tasks = [{
    taskId: TASK,
    sourceSha256: sha256CanonicalJson(row),
    image: {
      requested: 'example/image:task',
      resolvedDigest: `example/image@sha256:${HASH}`,
      base: { localId: `sha256:${HASH}`, platform: 'linux/amd64' },
      overlay: { name: 'example/overlay:task', localId: `sha256:${HASH}`, platform: 'linux/amd64' },
    },
  }];
  return {
    ...base,
    suite: 'swebench-pro',
    experiment: { model: 'gpt-test', requestedEffort: 'high', arm: 'both', taskIds: [TASK] },
    artifacts: {
      nativeRoot: 'native',
      runState: 'run-state.json',
      verifierReceipt: 'verifier-receipt.json',
      reportJson: 'report.json',
      reportMarkdown: 'report.md',
      executions: [
        { taskId: TASK, arm: 'b', key: KEY, nativeRoot: `native/tasks/${KEY}/b` },
        { taskId: TASK, arm: 'a', key: KEY, nativeRoot: `native/tasks/${KEY}/a` },
      ],
    },
    suiteConfig: {
      preparedInputSha256: HASH,
      selection: { mode: 'explicit', seed: null, count: 1, stratifyBy: null, requestedTaskIds: [TASK] },
      instances: [{ taskId: TASK, row, rowSha256: sha256CanonicalJson(row) }],
      armOrder: [{ taskId: TASK, arms: ['b', 'a'] }],
      auth: { mechanism: 'chatgpt', publicIdentitySha256: HASH },
      policies: {
        sessionSha256: HASH,
        historySha256: HASH,
        cleanupSha256: HASH,
        evaluatorSha256: HASH,
        adapterSha256: HASH,
      },
      attempts: 1,
      retries: 0,
      evaluator: { workers: 2, watchdogMs: 60_000 },
      docker: { cpus: 4, memoryBytes: 8_000_000_000, keepImages: false },
    },
  };
}

function marathonManifest(): Record<string, unknown> {
  return {
    ...common(),
    suite: 'swe-marathon',
    artifacts: {
      nativeRoot: 'native',
      runState: 'run-state.json',
      verifierReceipt: 'verifier-receipt.json',
      reportJson: 'report.json',
      reportMarkdown: 'report.md',
      executions: [{ taskId: TASK, arm: 'a', key: KEY, nativeRoot: `native/tasks/${KEY}` }],
    },
    suiteConfig: {
      preparedInputSha256: HASH,
      auth: { mechanism: 'api-key', publicIdentitySha256: HASH },
      workflowWaitMs: 5_000,
      bridgeClass: 'ArmBCodexAgent',
      oneTaskPerJob: true,
      attempts: 1,
      retries: 0,
      policies: {
        excludedTasksSha256: HASH,
        tasksSha256: HASH,
        resourcesSha256: HASH,
        bridgeSha256: HASH,
        adapterSha256: HASH,
      },
    },
  };
}

function featureManifest(): Record<string, unknown> {
  return {
    ...common(),
    suite: 'featurebench',
    artifacts: {
      nativeRoot: 'native',
      runState: 'run-state.json',
      verifierReceipt: 'verifier-receipt.json',
      reportJson: 'report.json',
      reportMarkdown: 'report.md',
      executions: [{ taskId: TASK, arm: 'a', key: KEY, nativeRoot: 'native' }],
    },
    suiteConfig: {
      preparedInputSha256: HASH,
      authMechanism: 'credential-broker',
      runtime: 'cpu',
      publicBrokerIdentitySha256: HASH,
      publicBrokerVersionSha256: HASH,
      restrictedNetworkPolicySha256: HASH,
      attempts: 1,
      retries: 0,
      inference: { concurrency: 1, timeoutMs: 60_000 },
      evaluation: { concurrency: 1, timeoutMs: 60_000 },
      resources: { cpus: 2, memoryBytes: 4_000_000_000 },
      policies: { promptSha256: HASH, patchSha256: HASH, datasetMapSha256: HASH, adapterSha256: HASH },
    },
  };
}

describe('strict v2 manifest validation', () => {
  it('accepts all three suite discriminants with one common envelope', () => {
    expect(parseBenchRunManifest(proManifest()).suite).toBe('swebench-pro');
    expect(parseBenchRunManifest(marathonManifest()).suite).toBe('swe-marathon');
    expect(parseBenchRunManifest(featureManifest()).suite).toBe('featurebench');
  });

  it('rejects legacy versions, unknown nested keys, invalid arm policy, and row drift', () => {
    expect(() => parseBenchRunManifest({ ...proManifest(), schemaVersion: 1 })).toThrow();
    const unknown = structuredClone(featureManifest());
    (unknown.limits as Record<string, unknown>).cpu = 8;
    expect(() => parseBenchRunManifest(unknown)).toThrow();
    const both = structuredClone(marathonManifest());
    (both.experiment as Record<string, unknown>).arm = 'both';
    expect(() => parseBenchRunManifest(both)).toThrow(/requires one arm/);
    const drift = structuredClone(proManifest());
    const config = drift.suiteConfig as { instances: Array<{ rowSha256: string }> };
    config.instances[0]!.rowSha256 = 'c'.repeat(64);
    expect(() => parseBenchRunManifest(drift)).toThrow(/row hash/);
  });

  it('rejects credentials and secret-bearing source URLs', () => {
    const secret = structuredClone(featureManifest());
    const source = (secret.provenance as { suiteSource: { repository: string } }).suiteSource;
    source.repository = 'https://user:password@example.test/repo.git';
    expect(() => parseBenchRunManifest(secret)).toThrow(/source locator/);

    const nested = structuredClone(featureManifest());
    (nested.provenance as { dataset: { identity: string } }).dataset.identity =
      'https://dataset.example.test/snapshot?access_token=secret';
    expect(() => parseBenchRunManifest(nested)).toThrow(/secret-bearing URLs/);
  });

  it('enforces the native evaluator task identity domain per suite', () => {
    const feature = structuredClone(featureManifest());
    (feature.experiment as { taskIds: string[] }).taskIds = ['../escape'];
    expect(() => parseBenchRunManifest(feature)).toThrow(/unsafe featurebench task identity/);

    const marathon = structuredClone(marathonManifest());
    (marathon.experiment as { taskIds: string[] }).taskIds = ['UPPER_case'];
    expect(() => parseBenchRunManifest(marathon)).toThrow(/unsafe swe-marathon task identity/);
  });

  it('rejects ambiguous or malformed persisted Docker identities', () => {
    const shortId = structuredClone(proManifest());
    const shortImage = (shortId.provenance as {
      tasks: Array<{ image: { base: { localId: string } } }>;
    }).tasks[0]!.image;
    shortImage.base.localId = HASH;
    expect(() => parseBenchRunManifest(shortId)).toThrow();

    const nonLinux = structuredClone(proManifest());
    const nonLinuxImage = (nonLinux.provenance as {
      tasks: Array<{ image: { overlay: { platform: string } } }>;
    }).tasks[0]!.image;
    nonLinuxImage.overlay.platform = 'darwin/amd64';
    expect(() => parseBenchRunManifest(nonLinux)).toThrow();

    const controlCharacter = structuredClone(proManifest());
    const controlImage = (controlCharacter.provenance as {
      tasks: Array<{ image: { requested: string } }>;
    }).tasks[0]!.image;
    controlImage.requested = 'example/image:task\nspoofed';
    expect(() => parseBenchRunManifest(controlCharacter)).toThrow();
  });
});

describe('manifest resume equality and storage', () => {
  it('ignores regenerated creation time but fails closed on common and suite inputs', () => {
    const frozen = marathonManifest();
    const later = structuredClone(frozen);
    later.createdAt = '2026-07-21T12:00:00.000Z';
    expect(() => assertManifestResumeEquality(frozen, later)).not.toThrow();
    const commonDrift = structuredClone(later);
    (commonDrift.limits as { taskConcurrency: number }).taskConcurrency = 2;
    expect(() => assertManifestResumeEquality(frozen, commonDrift)).toThrow(/resume inputs/);
    const suiteDrift = structuredClone(later);
    (suiteDrift.suiteConfig as { workflowWaitMs: number }).workflowWaitMs = 10_000;
    expect(() => assertManifestResumeEquality(frozen, suiteDrift)).toThrow(/resume inputs/);
  });

  it('writes and loads only manifest.json under an exact suite/run identity', () => {
    const paths = createBenchPathRoots(temporary());
    createPrivateRunDirectory(paths, 'featurebench', 'pilot1');
    const written = writeBenchRunManifest(paths, featureManifest());
    expect(written.suite).toBe('featurebench');
    expect(loadBenchRunManifest(paths, 'featurebench', 'pilot1')).toEqual(written);
    expect(statSync(manifestFile(paths, 'featurebench', 'pilot1')).mode & 0o777).toBe(0o600);
    expect(() => writeBenchRunManifest(paths, featureManifest())).toThrow(/already exists/);
    expect(() => loadBenchRunManifest(paths, 'swe-marathon', 'pilot1')).toThrow();
  });

  it('loads report evidence only when state, receipt, invocation, and native bytes are exactly bound', () => {
    const paths = createBenchPathRoots(temporary());
    const directory = createPrivateRunDirectory(paths, 'featurebench', 'pilot1');
    writeBenchRunManifest(paths, featureManifest());
    const manifestSha256 = sha256File(manifestFile(paths, 'featurebench', 'pilot1'));
    const invocationId = '11111111-1111-4111-8111-111111111111';
    const evidencePath = join(directory, 'native', 'evidence.json');
    mkdirSync(join(directory, 'native'), { mode: 0o700 });
    writeFileSync(evidencePath, '{"resolved":true}\n');
    writePrivateJsonAtomic(directory, runStateFile(paths, 'featurebench', 'pilot1'), {
      schemaVersion: 2,
      kind: 'ultracode-benchmark-run-state',
      suite: 'featurebench',
      runId: 'pilot1',
      manifestSha256,
      revision: 1,
      invocations: [{
        invocationId,
        command: 'run',
        startedAt: '2026-07-20T12:00:00.000Z',
        endedAt: '2026-07-20T12:01:00.000Z',
        activeElapsedMs: 60_000,
        exitCode: 0,
        signal: null,
        lifecycleProcesses: [],
        failure: null,
        nativeInvocation: 'native',
      }],
      attempts: [],
    });
    const receipt = {
      schemaVersion: 2,
      kind: 'ultracode-benchmark-verifier-receipt',
      suite: 'featurebench',
      runId: 'pilot1',
      manifestSha256,
      revision: 1,
      updatedAt: '2026-07-20T12:01:00.000Z',
      bindings: [{
        invocationId,
        scope: { kind: 'task-arm', taskId: TASK, arm: 'a' },
        role: 'native-result',
        path: 'native/evidence.json',
        sha256: sha256File(evidencePath),
        nativeRecordKey: TASK,
      }],
    };
    writePrivateJsonAtomic(directory, verifierReceiptFile(paths, 'featurebench', 'pilot1'), receipt);
    expect(loadStoredReportEvidence(paths, 'featurebench', 'pilot1').manifestSha256).toBe(manifestSha256);

    writeFileSync(evidencePath, '{"resolved":false}\n');
    expect(() => loadStoredReportEvidence(paths, 'featurebench', 'pilot1')).toThrow(/artifact drifted/);
    writeFileSync(evidencePath, '{"resolved":true}\n');
    writePrivateJsonAtomic(directory, verifierReceiptFile(paths, 'featurebench', 'pilot1'), {
      ...receipt,
      bindings: [{ ...receipt.bindings[0]!, invocationId: '22222222-2222-4222-8222-222222222222' }],
    });
    expect(() => loadStoredReportEvidence(paths, 'featurebench', 'pilot1')).toThrow(/unknown invocation/);
    expect(runDir(paths, 'featurebench', 'pilot1')).toBe(directory);
  });
});
