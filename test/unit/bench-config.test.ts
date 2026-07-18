/** Bench run validation pins model and effort so comparisons cannot drift. */
import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, validateForRun } from '../../bench/src/config.js';

describe('validateForRun', () => {
  it('requires an explicit model', () => {
    expect(() => validateForRun({ ...DEFAULT_CONFIG, effort: 'low' })).toThrow('config.model is required');
  });

  it('requires an explicit reasoning effort', () => {
    expect(() => validateForRun({ ...DEFAULT_CONFIG, model: 'test-model' })).toThrow('config.effort is required');
  });

  it('accepts a pinned model and effort', () => {
    expect(() => validateForRun({ ...DEFAULT_CONFIG, model: 'test-model', effort: 'low' })).not.toThrow();
  });
});
