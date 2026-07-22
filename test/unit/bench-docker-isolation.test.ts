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
  networkName: 'ucbench-internal',
  policyLabel: 'offline',
  expectedEndpointNames: new Set(['runner', 'proxy']),
  requiredEndpointNames: new Set(['runner']),
  dedicatedLocalBridge: true,
};

function validInspection(): DockerNetworkInspection {
  return {
    Internal: true,
    Name: contract.networkName,
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
  const containers = Object.entries(inspection.Containers ?? {}).map(([id, endpoint]) => ({
    Id: id,
    Name: `/${(endpoint as { Name: string }).Name}`,
    HostConfig: { NetworkMode: contract.networkName },
    NetworkSettings: { Networks: { [contract.networkName]: {} } },
  }));
  return inspectInternalDockerNetwork(JSON.stringify([inspection]), JSON.stringify(containers), contract);
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

  it('rejects unbound container identities and extra network attachments', () => {
    const inspection = validInspection();
    const rows = [{
      Id: RUNNER_ID,
      Name: '/runner',
      HostConfig: { NetworkMode: contract.networkName },
      NetworkSettings: { Networks: { [contract.networkName]: {}, bridge: {} } },
    }, {
      Id: PROXY_ID,
      Name: '/proxy',
      HostConfig: { NetworkMode: contract.networkName },
      NetworkSettings: { Networks: { [contract.networkName]: {} } },
    }];
    expect(() => inspectInternalDockerNetwork(
      JSON.stringify([inspection]),
      JSON.stringify(rows),
      contract,
    )).toThrow(/unattested network attachment/u);
    rows[0]!.NetworkSettings = { Networks: { [contract.networkName]: {} } };
    rows[0]!.Id = 'c'.repeat(64);
    expect(() => inspectInternalDockerNetwork(
      JSON.stringify([inspection]),
      JSON.stringify(rows),
      contract,
    )).toThrow(/unbound container inspection/u);
  });

  it('permits an explicitly trusted infrastructure endpoint to retain upstream egress', () => {
    const inspection = validInspection();
    const rows = [{
      Id: RUNNER_ID,
      Name: '/runner',
      HostConfig: { NetworkMode: contract.networkName },
      NetworkSettings: { Networks: { [contract.networkName]: {} } },
    }, {
      Id: PROXY_ID,
      Name: '/proxy',
      HostConfig: { NetworkMode: 'upstream' },
      NetworkSettings: { Networks: { [contract.networkName]: {}, upstream: {} } },
    }];
    expect(() => inspectInternalDockerNetwork(
      JSON.stringify([inspection]),
      JSON.stringify(rows),
      { ...contract, allowAdditionalNetworkEndpointNames: new Set(['proxy']) },
    )).not.toThrow();
  });
});
