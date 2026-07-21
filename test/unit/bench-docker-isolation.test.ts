/** Docker egress-attestation coverage for the shared benchmark control plane. */
import { describe, expect, it } from 'vitest';
import {
  inspectInternalDockerNetwork,
  type DockerNetworkInspection,
} from '../../bench/src/shared/docker-isolation.js';

const RUNNER_ID = 'a'.repeat(64);
const PROXY_ID = 'b'.repeat(64);
const contract = {
  description: 'benchmark network',
  policyLabel: 'offline',
  expectedEndpointNames: new Set(['runner', 'proxy']),
  requiredEndpointNames: new Set(['runner']),
  dedicatedLocalBridge: true,
};

function validInspection(): DockerNetworkInspection {
  return {
    Internal: true,
    Driver: 'bridge',
    Scope: 'local',
    Attachable: false,
    Ingress: false,
    Labels: { 'ultracode.egress-policy': 'offline' },
    Options: {},
    IPAM: {},
    Containers: {
      [RUNNER_ID]: { Name: 'runner' },
      [PROXY_ID]: { Name: 'proxy' },
    },
  };
}

function inspect(inspection: DockerNetworkInspection) {
  return inspectInternalDockerNetwork(JSON.stringify([inspection]), contract);
}

describe('Docker network isolation attestation', () => {
  it('accepts only the complete labeled internal endpoint set', () => {
    const attestation = inspect(validInspection());
    expect(attestation.containers.map(([, endpoint]) => endpoint.Name)).toEqual(['runner', 'proxy']);
    expect(attestation.runtimeSha256).toMatch(/^[a-f0-9]{64}$/u);
  });

  it.each([
    ['non-internal network', { Internal: false }],
    ['mislabeled network', { Labels: { 'ultracode.egress-policy': 'online' } }],
    ['non-bridge network', { Driver: 'overlay' }],
    ['non-local network', { Scope: 'swarm' }],
    ['attachable network', { Attachable: true }],
    ['ingress network', { Ingress: true }],
  ])('rejects a %s', (_description, override) => {
    expect(() => inspect({ ...validInspection(), ...override })).toThrow();
  });

  it('rejects unexpected, duplicate, missing, and malformed endpoints', () => {
    const unexpected = validInspection();
    unexpected.Containers = { [RUNNER_ID]: { Name: 'runner' }, [PROXY_ID]: { Name: 'database' } };
    expect(() => inspect(unexpected)).toThrow(/outside the attested allowlist/u);

    const duplicate = validInspection();
    duplicate.Containers = { [RUNNER_ID]: { Name: 'runner' }, [PROXY_ID]: { Name: 'runner' } };
    expect(() => inspect(duplicate)).toThrow(/duplicate endpoint names/u);

    const missing = validInspection();
    missing.Containers = { [PROXY_ID]: { Name: 'proxy' } };
    expect(() => inspect(missing)).toThrow(/missing required endpoint runner/u);

    const malformed = validInspection();
    malformed.Containers = { short: { Name: 'runner' } };
    expect(() => inspect(malformed)).toThrow(/invalid endpoint identity/u);
  });
});
