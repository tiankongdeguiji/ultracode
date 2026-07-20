/** Native SWE-bench Pro rows, session evidence, and task artifacts. */
import type { FailureCode } from '../../shared/contracts.js';

export interface SwebenchProInstance {
  /** Complete source row frozen into the v2 manifest. */
  row: Record<string, unknown>;
  instanceId: string;
  repo: string;
  repoLanguage: string;
  baseCommit: string;
  problemStatement: string;
  requirements: string | null;
  interface: string | null;
  failToPass: string;
  passToPass: string;
  dockerhubTag: string;
  beforeRepoSetCmd: string;
  selectedTestFilesToRun: string;
  goldPatch: string;
  testPatch: string;
}

export interface SwebenchProDatasetSnapshot {
  schemaVersion: 1;
  kind: 'ultracode-swebench-pro-dataset-descriptor';
  dataset: 'ScaleAI/SWE-bench_Pro';
  config: 'default';
  split: 'test';
  rows: Record<string, unknown>[];
}

export interface SessionMeta {
  codexExit: number;
  startedAt: number;
  endedAt: number;
  baseSha: string;
  expectedBase: string;
  patchBytes: number;
  applyCheck: boolean | null;
  ucRuns: { runId: string; status: string }[];
  waitedForTerminalMs: number;
  preDirtyPaths?: number;
  binaryHunksStripped?: number;
  failure: FailureCode | null;
}

export type TaskPhase = 'pending' | 'image-ready' | 'session-done' | 'patched' | 'evaluated';

export interface TaskStatus {
  schemaVersion: 2;
  phase: TaskPhase;
  failure: FailureCode | null;
  startedAt?: string;
  endedAt?: string;
  codexExit?: number;
  wallClockMs?: number;
  patchBytes?: number;
  applyCheck?: boolean | null;
  annotations: string[];
}

export interface EvalPrediction {
  instance_id: string;
  patch: string;
  prefix: string;
}

/** Security-sensitive result of inspecting and, when bounded, reading a native patch. */
export type PatchArtifactRead =
  | { kind: 'missing'; patchBytes: 0 }
  | { kind: 'empty'; patchBytes: 0 }
  | { kind: 'patch'; patch: string; patchBytes: number }
  | { kind: 'too-large'; patchBytes: number }
  | { kind: 'unsafe'; failure: unknown };

export interface DockerImageAttestation {
  requested: string;
  resolvedDigest: string;
  baseLocalId: string;
  basePlatform: string;
  overlayName: string;
  overlayLocalId: string;
  overlayPlatform: string;
}
