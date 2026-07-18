import { describe, it, expect } from 'vitest';
import { ARM_B_PREFIX, composePrompt, composeTaskBody } from '../../bench/src/prompt.js';
import type { BenchInstance } from '../../bench/src/types.js';

const makeInstance = (over: Partial<BenchInstance> = {}): BenchInstance => ({
  instanceId: 'INSTANCE_ID_SENTINEL',
  repo: 'REPO_SENTINEL',
  repoLanguage: 'js',
  baseCommit: 'BASE_COMMIT_SENTINEL',
  problemStatement: 'PROBLEM_STATEMENT_SENTINEL',
  requirements: 'REQUIREMENTS_SENTINEL',
  interface: 'INTERFACE_SENTINEL',
  failToPass: '["FAIL_SENTINEL"]',
  passToPass: '["PASS_SENTINEL"]',
  dockerhubTag: 'DOCKERHUB_TAG_SENTINEL',
  beforeRepoSetCmd: 'BEFORE_REPO_SET_CMD_SENTINEL',
  selectedTestFilesToRun: 'SELECTED_TEST_FILES_SENTINEL',
  goldPatch: 'GOLD_PATCH_SENTINEL',
  testPatch: 'TEST_PATCH_SENTINEL',
  ...over,
});

const LEAK_SENTINELS = ['GOLD_PATCH_SENTINEL', 'TEST_PATCH_SENTINEL', 'FAIL_SENTINEL', 'PASS_SENTINEL'];

describe('composeTaskBody', () => {
  it('includes problem statement, requirements, and interface verbatim', () => {
    const body = composeTaskBody(makeInstance());
    expect(body).toContain('PROBLEM_STATEMENT_SENTINEL');
    expect(body).toContain('## Requirements\nREQUIREMENTS_SENTINEL');
    expect(body).toContain('## Interface\nINTERFACE_SENTINEL');
    expect(body).toContain('## Instructions\n');
  });

  it('omits section headers when requirements/interface are null or empty', () => {
    for (const empty of [null, '']) {
      const body = composeTaskBody(makeInstance({ requirements: empty, interface: empty }));
      expect(body).not.toContain('## Requirements');
      expect(body).not.toContain('## Interface');
      expect(body).toContain('PROBLEM_STATEMENT_SENTINEL');
      expect(body).toContain('## Instructions\n');
    }
  });
});

describe('composePrompt', () => {
  it('never leaks gold patch, test patch, or test lists into either arm', () => {
    for (const arm of ['a', 'b'] as const) {
      const prompt = composePrompt(makeInstance(), arm);
      for (const sentinel of LEAK_SENTINELS) expect(prompt).not.toContain(sentinel);
    }
  });

  it('arm a is exactly the task body', () => {
    const inst = makeInstance();
    expect(composePrompt(inst, 'a')).toBe(composeTaskBody(inst));
  });

  it('arm b is exactly the prefix plus the arm-a body, and starts with "ultracode"', () => {
    const inst = makeInstance();
    const armA = composePrompt(inst, 'a');
    const armB = composePrompt(inst, 'b');
    expect(armB).toBe(ARM_B_PREFIX + armA);
    expect(armB.slice(ARM_B_PREFIX.length)).toBe(armA);
    expect(armB.startsWith('ultracode')).toBe(true);
  });
});
