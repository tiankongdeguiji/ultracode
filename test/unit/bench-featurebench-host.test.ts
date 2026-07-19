/** FeatureBench production host-policy regression coverage. */
import { describe, expect, it } from 'vitest';
import { validateFeatureBenchHost } from '../../bench/src/featurebench-host.js';

describe('FeatureBench host policy', () => {
  it('accepts Linux x64', () => {
    expect(() => validateFeatureBenchHost('linux', 'x64')).not.toThrow();
  });

  it.each([
    ['darwin', 'x64'],
    ['darwin', 'arm64'],
    ['linux', 'arm64'],
  ] as const)('rejects %s-%s', (platform, arch) => {
    expect(() => validateFeatureBenchHost(platform, arch))
      .toThrow(`FeatureBench requires a Linux x64 host, got ${platform}-${arch}`);
  });
});
