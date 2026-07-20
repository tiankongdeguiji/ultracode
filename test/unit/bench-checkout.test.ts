/** Immutable checkout command planning without shell-string execution. */
import { describe, expect, it } from 'vitest';
import {
  planPinnedCheckout,
  planPinnedClone,
  planPinnedUpdate,
} from '../../bench/src/shared/checkout.js';

const PIN = '0123456789abcdef0123456789abcdef01234567';

describe('pinned checkout plans', () => {
  it('builds argv arrays for a new clone', () => {
    expect(planPinnedClone('https://example.test/repo.git', PIN, '/tmp/checkout')).toEqual([
      ['git', 'clone', '--filter=blob:none', '--no-checkout', '--no-tags', '--', 'https://example.test/repo.git', '/tmp/checkout'],
      ['git', '-C', '/tmp/checkout', 'fetch', '--filter=blob:none', '--depth=1', '--no-tags', 'origin', PIN],
      ['git', '-C', '/tmp/checkout', 'checkout', '--detach', PIN],
    ]);
  });

  it('plans only fetch and detached checkout for an existing clone', () => {
    const update = planPinnedUpdate('/tmp/repo with spaces', PIN);
    expect(planPinnedCheckout({
      repository: 'unused',
      pin: PIN,
      directory: '/tmp/repo with spaces',
      existing: true,
    })).toEqual(update);
    expect(update.every((argv) => argv[0] === 'git')).toBe(true);
  });

  it('requires a full immutable object id and valid argv values', () => {
    expect(() => planPinnedUpdate('/tmp/repo', 'main')).toThrow(/full 40- or 64-character/);
    expect(() => planPinnedClone('', PIN, '/tmp/repo')).toThrow(/repository/);
    expect(() => planPinnedClone('repo', PIN, 'bad\0dir')).toThrow(/checkout directory/);
  });
});
