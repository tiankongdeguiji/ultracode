/** Shared strict parsing for suite-owned Docker isolation attestations. */
import { sha256CanonicalJson } from './provenance.js';

export interface DockerNetworkInspection {
  Internal?: unknown;
  Driver?: unknown;
  Scope?: unknown;
  Attachable?: unknown;
  Ingress?: unknown;
  Labels?: unknown;
  Options?: unknown;
  IPAM?: unknown;
  Containers?: unknown;
}

/** Parse exactly one Docker inspect record and reject malformed ambiguity. */
export function oneDockerInspectRow<T>(stdout: string, description: string): T {
  let rows: unknown;
  try { rows = JSON.parse(stdout) as unknown; } catch {
    throw new Error(`Docker returned malformed ${description} inspection`);
  }
  if (!Array.isArray(rows) || rows.length !== 1) {
    throw new Error(`Docker returned ambiguous ${description} inspection`);
  }
  if (rows[0] === null || typeof rows[0] !== 'object' || Array.isArray(rows[0])) {
    throw new Error(`Docker returned malformed ${description} inspection`);
  }
  return rows[0] as T;
}

/** Read an untrusted Docker object field without accepting arrays or null. */
export function dockerObject(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

export interface InternalNetworkContract {
  description: string;
  policyLabel: string;
  expectedEndpointNames: ReadonlySet<string>;
  requiredEndpointNames?: ReadonlySet<string>;
  dedicatedLocalBridge?: boolean;
}

export interface InternalNetworkAttestation {
  inspection: DockerNetworkInspection;
  containers: Array<[string, Record<string, unknown>]>;
  runtimeSha256: string;
}

/** Validate one internal network and its complete endpoint-name allowlist. */
export function inspectInternalDockerNetwork(
  stdout: string,
  contract: InternalNetworkContract,
): InternalNetworkAttestation {
  const inspection = oneDockerInspectRow<DockerNetworkInspection>(stdout, contract.description);
  const labels = dockerObject(inspection.Labels);
  const containers = Object.entries(dockerObject(inspection.Containers)).map(([id, value]) => {
    if (!/^[a-f0-9]{64}$/.test(id)) {
      throw new Error(`${contract.description} contains an invalid endpoint identity`);
    }
    return [id, dockerObject(value)] as [string, Record<string, unknown>];
  });
  const names = containers.map(([, endpoint]) => endpoint.Name);
  if (inspection.Internal !== true || labels['ultracode.egress-policy'] !== contract.policyLabel) {
    throw new Error(`${contract.description} is not the required labeled internal network`);
  }
  if (contract.dedicatedLocalBridge === true
    && (inspection.Driver !== 'bridge' || inspection.Scope !== 'local'
      || inspection.Attachable !== false || inspection.Ingress !== false)) {
    throw new Error(`${contract.description} is not a non-attachable dedicated local bridge`);
  }
  if (names.some((name) => typeof name !== 'string' || !contract.expectedEndpointNames.has(name))) {
    throw new Error(`${contract.description} contains an endpoint outside the attested allowlist`);
  }
  if (new Set(names).size !== names.length) {
    throw new Error(`${contract.description} contains duplicate endpoint names`);
  }
  for (const required of contract.requiredEndpointNames ?? []) {
    if (!names.includes(required)) throw new Error(`${contract.description} is missing required endpoint ${required}`);
  }
  return {
    inspection,
    containers,
    runtimeSha256: sha256CanonicalJson({
      internal: inspection.Internal ?? null,
      driver: inspection.Driver ?? null,
      scope: inspection.Scope ?? null,
      attachable: inspection.Attachable ?? null,
      ingress: inspection.Ingress ?? null,
      options: inspection.Options ?? null,
      ipam: inspection.IPAM ?? null,
      policyLabel: labels['ultracode.egress-policy'] ?? null,
    }),
  };
}
