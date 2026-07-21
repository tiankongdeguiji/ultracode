/**
 * Attests the external Codex Responses relay and the task-only internal Docker
 * topology. Relay behavior remains an explicit operator trust contract.
 */
import { createHash } from 'node:crypto';
import { isIP } from 'node:net';
import { isAbsolute, join, resolve } from 'node:path';
import type { BenchPathRoots } from '../../shared/contracts.js';
import {
  dockerObject,
  inspectInternalDockerNetwork,
  oneDockerInspectRow,
} from '../../shared/docker-isolation.js';
import { canonicalHostPath, validatePortableComponent } from '../../shared/paths.js';
import { sha256CanonicalJson } from '../../shared/provenance.js';

const sha256Text = (value: string): string => createHash('sha256').update(value, 'utf8').digest('hex');

export const SWEBENCH_PRO_MODEL_RELAY_CONTRACT = Object.freeze({
  schemaVersion: 1,
  wireProtocol: 'openai-responses',
  requests: [
    { method: 'POST', path: '/v1/responses' },
    { method: 'POST', path: '/v1/responses/compact' },
  ],
  requestPolicy: {
    model: 'exact-operator-configured-model',
    contentType: 'application/json',
    headers: 'allowlist-content-negotiation-and-codex-tracing',
    body: 'strict-supported-codex-responses-schema',
    providerHostedTools: 'reject',
    remoteMcp: 'reject',
    externalUrlsFileIdsAndVectorStores: 'reject',
    background: 'reject',
    absoluteForm: 'reject',
    connect: 'reject',
    redirects: 'reject',
    otherMethodsAndPaths: 'reject',
  },
  destinationPolicy: {
    baseUrl: 'exact-operator-configured-https-destination',
    pathMapping: 'identity',
    redirects: 'reject',
    genericForwarding: 'reject',
  },
  credentialPolicy: {
    taskProviderCredential: 'forbidden',
    inboundAuthorization: 'reject',
    providerCredential: 'relay-only',
  },
  responsePolicy: {
    contentTypes: ['application/json', 'text/event-stream'],
    hostedToolAndCitationOutputs: 'reject',
  },
});

export const SWEBENCH_PRO_MODEL_RELAY_CONTRACT_SHA256 =
  'c4608a577487f503bfd5d26269107511607b8a4b2c7e5c9eb0e14acd77748990';

if (sha256CanonicalJson(SWEBENCH_PRO_MODEL_RELAY_CONTRACT)
  !== SWEBENCH_PRO_MODEL_RELAY_CONTRACT_SHA256) {
  throw new Error('SWE-bench Pro model relay contract does not match its reviewed canonical hash');
}

export const SWEBENCH_PRO_NETWORK_POLICY = Object.freeze({
  schemaVersion: 1,
  dockerNetwork: 'dedicated-internal-local-bridge',
  policyLabel: 'codex-responses-via-attested-relay-v1',
  onlyNonTaskEndpoint: 'attested-model-relay',
  taskNetworks: 1,
  taskProviderCredentials: 0,
  hostGatewayReachability: 'bridge-ip-inhibited',
});

export const SWEBENCH_PRO_NETWORK_POLICY_SHA256 = sha256CanonicalJson(SWEBENCH_PRO_NETWORK_POLICY);

export interface SwebenchProModelTransportConfig {
  relayIdentity: string;
  relayVersion: string;
  fixedDestination: string;
}

export interface SwebenchProTransportBindings {
  relayBaseUrl: string;
  restrictedNetwork: string;
}

export interface SwebenchProTransportAttestation {
  contractSha256: string;
  relayIdentitySha256: string;
  relayVersionSha256: string;
  fixedDestinationSha256: string;
  modelSha256: string;
  relayRuntimeSha256: string;
  topologySha256: string;
}

export type SwebenchProTransportAttestationStage =
  | 'restricted-network-inspect'
  | 'model-relay-inspect'
  | 'transport-boundary'
  | 'session-inspect'
  | 'session-attachment'
  | 'manifest-transport';

/** Typed fail-closed rejection for every runtime model-transport proof stage. */
export class SwebenchProTransportAttestationError extends Error {
  readonly code = 'transport-attestation-failed';

  constructor(
    readonly stage: SwebenchProTransportAttestationStage,
    cause: unknown,
  ) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    super(`SWE-bench Pro transport attestation failed during ${stage}: ${detail}`, { cause });
    this.name = 'SwebenchProTransportAttestationError';
  }
}

/** Preserve the first attestation stage while wrapping arbitrary inspect failures. */
export function transportAttestationFailure(
  stage: SwebenchProTransportAttestationStage,
  error: unknown,
): SwebenchProTransportAttestationError {
  return error instanceof SwebenchProTransportAttestationError
    ? error
    : new SwebenchProTransportAttestationError(stage, error);
}

interface DockerRelayInspection {
  Id?: unknown;
  Image?: unknown;
  Path?: unknown;
  Args?: unknown;
  State?: { Running?: unknown };
  Config?: { Image?: unknown; Labels?: unknown };
  HostConfig?: { Binds?: unknown; Mounts?: unknown; Tmpfs?: unknown };
  Mounts?: unknown;
  NetworkSettings?: { Networks?: unknown };
}

interface DockerSessionInspection {
  Id?: unknown;
  Name?: unknown;
  Image?: unknown;
  Config?: {
    Image?: unknown;
    Labels?: unknown;
    Env?: unknown;
    Healthcheck?: { Test?: unknown };
    User?: unknown;
    Entrypoint?: unknown;
    Cmd?: unknown;
  };
  State?: { Running?: unknown };
  HostConfig?: {
    AutoRemove?: unknown;
    NetworkMode?: unknown;
    Privileged?: unknown;
    ReadonlyRootfs?: unknown;
    PublishAllPorts?: unknown;
    Devices?: unknown;
    PidMode?: unknown;
    IpcMode?: unknown;
    RestartPolicy?: { Name?: unknown; MaximumRetryCount?: unknown };
    PidsLimit?: unknown;
    SecurityOpt?: unknown;
    CapDrop?: unknown;
    CapAdd?: unknown;
    NanoCpus?: unknown;
    Memory?: unknown;
  };
  Mounts?: unknown;
  NetworkSettings?: { Networks?: unknown };
}

interface DockerNetworkEndpointSnapshot {
  Containers?: unknown;
}

export interface SwebenchProSessionContainerPolicy {
  user: string;
  entrypoint: readonly string[];
  command: readonly string[];
  pidsLimit: number;
  securityOpt: readonly string[];
  capDrop: readonly string[];
  capAdd: readonly string[];
  nanoCpus: number;
  memoryBytes: number;
  mounts: readonly { source: string; destination: string }[];
}

export interface SwebenchProSessionAttachment {
  id: string;
  name: string;
  runId: string;
  taskId: string;
  arm: 'a' | 'b';
  runtimeNonce: string;
  imageName: string;
  imageId: string;
  running: boolean;
  containerPolicy: SwebenchProSessionContainerPolicy;
}

function relayBaseUrl(value: string): URL {
  let parsed: URL;
  try { parsed = new URL(value); } catch {
    throw new Error('SWE-bench Pro model relay URL must be an absolute HTTP(S) URL');
  }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password
    || parsed.search || parsed.hash || value.includes('?') || value.includes('#')
    || parsed.pathname !== '/v1') {
    throw new Error('SWE-bench Pro model relay URL must be an HTTP(S) /v1 base without credentials, query, or fragment');
  }
  const host = parsed.hostname.replace(/^\[|\]$/gu, '');
  if (isIP(host) !== 0 || host === 'localhost' || host.endsWith('.localhost')) {
    throw new Error('SWE-bench Pro model relay hostname must be an inspected Docker DNS endpoint name, not localhost or an IP literal');
  }
  validatePortableComponent(parsed.hostname, 'SWE-bench Pro model relay hostname');
  return parsed;
}

function destinationSha256(config: SwebenchProModelTransportConfig): string {
  const parsed = new URL(config.fixedDestination);
  return sha256CanonicalJson({
    protocol: parsed.protocol,
    hostname: parsed.hostname,
    port: parsed.port,
    pathname: parsed.pathname,
  });
}

/** Load runtime-only Docker names; neither value is persisted in cleartext. */
export function loadSwebenchProTransportBindings(
  source: NodeJS.ProcessEnv = process.env,
): SwebenchProTransportBindings {
  const relay = relayBaseUrl(source.SWEBENCH_PRO_MODEL_RELAY_URL ?? '');
  const restrictedNetwork = source.SWEBENCH_PRO_RESTRICTED_NETWORK ?? '';
  validatePortableComponent(restrictedNetwork, 'SWEBENCH_PRO_RESTRICTED_NETWORK');
  if (['bridge', 'host', 'default', 'none'].includes(restrictedNetwork)) {
    throw new Error('SWE-bench Pro requires a dedicated restricted Docker network');
  }
  return { relayBaseUrl: relay.href.replace(/\/$/u, ''), restrictedNetwork };
}

/** Stable UID-scoped host root, with an explicit isolated-root seam for tests. */
export function swebenchProTransportPolicyLockRoot(coordinationRoot?: string): string {
  const uid = typeof process.getuid === 'function' ? process.getuid() : 0;
  const root = coordinationRoot ?? join('/tmp', `ultracode-bench-${uid}`);
  if (!isAbsolute(root)) {
    throw new Error('SWE-bench Pro transport coordination root must be absolute');
  }
  return resolve(root);
}

/** One host policy identity serializing transport use across separate worktrees. */
export function swebenchProTransportPolicyLockFile(
  _roots: BenchPathRoots,
  _source: NodeJS.ProcessEnv = process.env,
  coordinationRoot: string = swebenchProTransportPolicyLockRoot(),
): string {
  return join(
    swebenchProTransportPolicyLockRoot(coordinationRoot),
    '.locks',
    `swebench-pro-transport-${SWEBENCH_PRO_NETWORK_POLICY_SHA256}.lock`,
  );
}

function relayLabels(
  config: SwebenchProModelTransportConfig,
  model: string,
): Record<string, string> {
  return {
    'ultracode.model-relay': 'true',
    'ultracode.model-relay.identity': config.relayIdentity,
    'ultracode.model-relay.version': config.relayVersion,
    'ultracode.model-relay.contract-sha256': SWEBENCH_PRO_MODEL_RELAY_CONTRACT_SHA256,
    'ultracode.model-relay.destination-sha256': destinationSha256(config),
    'ultracode.model-relay.model-sha256': sha256Text(model),
  };
}

/**
 * Validate the complete internal-network endpoint set and bind the relay's
 * immutable image, declared strict contract, command, mounts, and networks.
 */
function inspectSwebenchProTransportBoundaryUnchecked(
  networkStdout: string,
  relayStdout: string,
  config: SwebenchProModelTransportConfig,
  model: string,
  bindings: SwebenchProTransportBindings,
  allowedSessions: ReadonlyMap<string, string> = new Map(),
  requiredSessionNames: ReadonlySet<string> = new Set(),
): SwebenchProTransportAttestation {
  const endpoint = relayBaseUrl(bindings.relayBaseUrl);
  const expectedNames = new Set([endpoint.hostname, ...allowedSessions.keys()]);
  const requiredNames = new Set([endpoint.hostname, ...requiredSessionNames]);
  const network = inspectInternalDockerNetwork(networkStdout, relayStdout, {
    description: 'SWE-bench Pro restricted network',
    networkName: bindings.restrictedNetwork,
    policyLabel: SWEBENCH_PRO_NETWORK_POLICY.policyLabel,
    expectedEndpointNames: expectedNames,
    requiredEndpointNames: requiredNames,
    allowAdditionalNetworkEndpointNames: new Set([endpoint.hostname]),
    dedicatedLocalBridge: true,
  });
  const networkOptions = dockerObject(network.inspection.Options);
  if (networkOptions['com.docker.network.bridge.inhibit_ipv4'] !== 'true') {
    throw new Error('SWE-bench Pro restricted network must inhibit the host bridge IP');
  }
  const relayEntry = network.containers.filter(([, value]) => value.Name === endpoint.hostname);
  if (relayEntry.length !== 1) {
    throw new Error('SWE-bench Pro restricted network must contain exactly one named model relay');
  }
  for (const [id, value] of network.containers) {
    if (value.Name === endpoint.hostname) continue;
    if (typeof value.Name !== 'string' || allowedSessions.get(value.Name) !== id) {
      throw new Error('SWE-bench Pro task endpoint identity does not match the active session');
    }
  }
  const relay = network.containerInspections.find(([id]) => id === relayEntry[0]![0])?.[1] as
    DockerRelayInspection | undefined;
  if (relay === undefined) throw new Error('SWE-bench Pro model relay inspection is missing');
  const labels = dockerObject(relay.Config?.Labels);
  const expectedLabels = relayLabels(config, model);
  const networks = Object.keys(dockerObject(relay.NetworkSettings?.Networks)).sort();
  if (relay.State?.Running !== true || typeof relay.Id !== 'string' || !/^[a-f0-9]{64}$/.test(relay.Id)
    || relay.Id !== relayEntry[0]![0]
    || typeof relay.Image !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(relay.Image)
    || Object.entries(expectedLabels).some(([key, value]) => labels[key] !== value)
    || !networks.includes(bindings.restrictedNetwork)) {
    throw new Error('SWE-bench Pro model relay identity, contract, state, destination, model, or immutable image is invalid');
  }
  const relayRuntimeSha256 = sha256CanonicalJson({
    image: relay.Image,
    configuredImage: relay.Config?.Image ?? null,
    path: relay.Path ?? null,
    args: relay.Args ?? null,
    binds: relay.HostConfig?.Binds ?? null,
    configuredMounts: relay.HostConfig?.Mounts ?? null,
    runtimeMounts: relay.Mounts ?? null,
    tmpfs: relay.HostConfig?.Tmpfs ?? null,
    networksSha256: sha256CanonicalJson(networks),
    labels: expectedLabels,
  });
  const networkLabels = dockerObject(network.inspection.Labels);
  const stableNetworkRuntimeSha256 = sha256CanonicalJson({
    internal: network.inspection.Internal ?? null,
    driver: network.inspection.Driver ?? null,
    scope: network.inspection.Scope ?? null,
    attachable: network.inspection.Attachable ?? null,
    ingress: network.inspection.Ingress ?? null,
    options: network.inspection.Options ?? null,
    ipam: network.inspection.IPAM ?? null,
    policyLabel: networkLabels['ultracode.egress-policy'] ?? null,
    relayEndpointId: relayEntry[0]![0],
  });
  return {
    contractSha256: SWEBENCH_PRO_MODEL_RELAY_CONTRACT_SHA256,
    relayIdentitySha256: sha256Text(config.relayIdentity),
    relayVersionSha256: sha256Text(config.relayVersion),
    fixedDestinationSha256: destinationSha256(config),
    modelSha256: sha256Text(model),
    relayRuntimeSha256,
    topologySha256: sha256CanonicalJson({
      networkPolicySha256: SWEBENCH_PRO_NETWORK_POLICY_SHA256,
      networkRuntimeSha256: stableNetworkRuntimeSha256,
      selectedNetworkSha256: sha256Text(bindings.restrictedNetwork),
      relayBaseUrlSha256: sha256CanonicalJson({
        protocol: endpoint.protocol,
        hostname: endpoint.hostname,
        port: endpoint.port,
        pathname: endpoint.pathname,
      }),
      relayRuntimeSha256,
    }),
  };
}

/** Parse and attest one relay/network snapshot as a typed run-fatal proof. */
export function inspectSwebenchProTransportBoundary(
  networkStdout: string,
  relayStdout: string,
  config: SwebenchProModelTransportConfig,
  model: string,
  bindings: SwebenchProTransportBindings,
  allowedSessions: ReadonlyMap<string, string> = new Map(),
  requiredSessionNames: ReadonlySet<string> = new Set(),
): SwebenchProTransportAttestation {
  try {
    return inspectSwebenchProTransportBoundaryUnchecked(
      networkStdout,
      relayStdout,
      config,
      model,
      bindings,
      allowedSessions,
      requiredSessionNames,
    );
  } catch (error) {
    throw transportAttestationFailure('transport-boundary', error);
  }
}

/** Select only endpoints present in this network snapshot from the tracked allowlist. */
export function swebenchProCurrentEndpointIds(
  networkStdout: string,
  bindings: SwebenchProTransportBindings,
  allowedSessions: ReadonlyMap<string, string> = new Map(),
  requiredSessionNames: ReadonlySet<string> = new Set(),
): string[] {
  try {
    const relayName = relayBaseUrl(bindings.relayBaseUrl).hostname;
    const inspection = oneDockerInspectRow<DockerNetworkEndpointSnapshot>(
      networkStdout,
      'SWE-bench Pro restricted network',
    );
    const endpoints = Object.entries(dockerObject(inspection.Containers));
    const names = new Set<string>();
    let relayCount = 0;
    for (const [id, value] of endpoints) {
      const name = dockerObject(value).Name;
      if (!/^[a-f0-9]{64}$/.test(id) || typeof name !== 'string' || names.has(name)) {
        throw new Error('SWE-bench Pro restricted network contains an invalid endpoint snapshot');
      }
      names.add(name);
      if (name === relayName) relayCount += 1;
      else if (allowedSessions.get(name) !== id) {
        throw new Error('SWE-bench Pro restricted network contains an endpoint outside the tracked allowlist');
      }
    }
    if (relayCount !== 1) {
      throw new Error('SWE-bench Pro restricted network must contain exactly one model relay');
    }
    for (const required of requiredSessionNames) {
      if (!names.has(required)) {
        throw new Error(`SWE-bench Pro restricted network is missing required session ${required}`);
      }
    }
    return endpoints.map(([id]) => id);
  } catch (error) {
    throw transportAttestationFailure('transport-boundary', error);
  }
}

const FORBIDDEN_TASK_ENV = /^(?:[A-Z0-9_]*(?:API_KEY|ACCESS_TOKEN|AUTH_TOKEN|SESSION_TOKEN|CLIENT_SECRET|SECRET_ACCESS_KEY|APPLICATION_CREDENTIALS|PRIVATE_KEY|PASSWORD)|CODEX_AUTH_JSON_PATH|HTTP_PROXY|HTTPS_PROXY|ALL_PROXY)=/i;
const SANITIZED_BOOTSTRAP_ENV = [
  'BASH_ENV', 'ENV', 'LD_PRELOAD', 'LD_AUDIT', 'LD_LIBRARY_PATH', 'NODE_OPTIONS',
] as const;

function exactStringArray(value: unknown, expected: readonly string[]): boolean {
  return Array.isArray(value) && value.length === expected.length
    && value.every((entry, index) => entry === expected[index]);
}

function exactStringSet(value: unknown, expected: readonly string[]): boolean {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string')
    && JSON.stringify([...value].sort()) === JSON.stringify([...expected].sort());
}

function exactSessionMounts(value: unknown, expected: SwebenchProSessionContainerPolicy['mounts']): boolean {
  if (!Array.isArray(value) || value.length !== expected.length) return false;
  const observed = value.flatMap((entry) => {
    if (entry === null || typeof entry !== 'object') return [];
    const mount = entry as Record<string, unknown>;
    return mount.Type === 'bind' && typeof mount.Source === 'string'
      && typeof mount.Destination === 'string' && mount.RW === true
      ? [{ source: canonicalHostPath(mount.Source), destination: mount.Destination }]
      : [];
  }).sort((left, right) => left.destination.localeCompare(right.destination));
  const wanted = expected.map((mount) => ({
    source: canonicalHostPath(mount.source),
    destination: mount.destination,
  })).sort((left, right) => left.destination.localeCompare(right.destination));
  return observed.length === wanted.length && JSON.stringify(observed) === JSON.stringify(wanted);
}

/** Prove one launched task has only its internal network and no provider key/proxy environment. */
function inspectSwebenchProSessionAttachmentUnchecked(
  stdout: string,
  expected: SwebenchProSessionAttachment,
  bindings: SwebenchProTransportBindings,
): void {
  const session = oneDockerInspectRow<DockerSessionInspection>(stdout, 'SWE-bench Pro session attachment');
  const labels = dockerObject(session.Config?.Labels);
  const networks = Object.keys(dockerObject(session.NetworkSettings?.Networks));
  const env = Array.isArray(session.Config?.Env) ? session.Config.Env : null;
  const exactEnv = (name: string, value: string): boolean => env !== null
    && env.filter((entry) => entry === `${name}=${value}`).length === 1
    && !env.some((entry) => typeof entry === 'string'
      && entry.startsWith(`${name}=`) && entry !== `${name}=${value}`);
  const sanitizedBootstrap = env !== null && SANITIZED_BOOTSTRAP_ENV.every((name) =>
    env.filter((entry) => entry === `${name}=`).length === 1
    && !env.some((entry) => typeof entry === 'string' && entry.startsWith(`${name}=`) && entry !== `${name}=`));
  const host = session.HostConfig;
  const policy = expected.containerPolicy;
  const devices = host?.Devices;
  if (!/^[a-f0-9]{64}$/.test(expected.runtimeNonce)
    || session.Id !== expected.id || session.Name !== `/${expected.name}`
    || session.Image !== expected.imageId || session.Config?.Image !== expected.imageName
    || labels['ultracode.benchmark.schema'] !== '2'
    || labels['ultracode.benchmark.suite'] !== 'swebench-pro'
    || labels['ultracode.benchmark.run'] !== expected.runId
    || labels['ultracode.benchmark.task'] !== expected.taskId
    || labels['ultracode.benchmark.arm'] !== expected.arm
    || labels['ultracode.benchmark.purpose'] !== 'session'
    || labels['ultracode.benchmark.ownership'] !== '1'
    || labels['ultracode.benchmark.runtime'] !== expected.runtimeNonce
    || session.State?.Running !== expected.running
    || session.Config?.User !== policy.user
    || !exactStringArray(session.Config?.Entrypoint, policy.entrypoint)
    || !exactStringArray(session.Config?.Cmd, policy.command)
    || host?.AutoRemove !== false
    || host?.Privileged !== false || host.ReadonlyRootfs !== false || host.PublishAllPorts !== false
    || !(devices === null || (Array.isArray(devices) && devices.length === 0))
    || host.PidMode !== '' || !['', 'private'].includes(String(host.IpcMode ?? ''))
    || host.RestartPolicy?.Name !== 'no' || host.RestartPolicy.MaximumRetryCount !== 0
    || host.PidsLimit !== policy.pidsLimit
    || !exactStringSet(host.SecurityOpt, policy.securityOpt)
    || !exactStringSet(host.CapDrop, policy.capDrop)
    || !exactStringSet(host.CapAdd, policy.capAdd)
    || host.NanoCpus !== policy.nanoCpus || host.Memory !== policy.memoryBytes
    || !exactSessionMounts(session.Mounts, policy.mounts)
    || session.HostConfig?.NetworkMode !== bindings.restrictedNetwork
    || (expected.running && (networks.length !== 1 || networks[0] !== bindings.restrictedNetwork))
    || env === null || env.some((entry) => typeof entry !== 'string' || FORBIDDEN_TASK_ENV.test(entry))
    || !exactEnv('BENCH_RUNTIME_NONCE', expected.runtimeNonce)
    || !exactEnv('BENCH_MODEL_RELAY_BASE_URL', bindings.relayBaseUrl)
    || !sanitizedBootstrap
    || JSON.stringify(session.Config?.Healthcheck?.Test) !== JSON.stringify(['NONE'])) {
    throw new Error('SWE-bench Pro session lacks the exact policy-bound credential-free restricted-network attachment');
  }
}

/** Parse and attest one task attachment as a typed run-fatal proof. */
export function inspectSwebenchProSessionAttachment(
  stdout: string,
  expected: SwebenchProSessionAttachment,
  bindings: SwebenchProTransportBindings,
): void {
  try {
    inspectSwebenchProSessionAttachmentUnchecked(stdout, expected, bindings);
  } catch (error) {
    throw transportAttestationFailure('session-attachment', error);
  }
}
