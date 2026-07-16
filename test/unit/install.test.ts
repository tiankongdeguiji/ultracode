import { describe, it, expect } from 'vitest';
import { mkdtempSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AGENTS_SNIPPET,
  MARKER_BEGIN,
  MARKER_END,
  QODER_RULE,
  installForHost,
  planFor,
  skillSourceDir,
  upsertMarkerBlock,
} from '../../src/installer/install.js';

function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'uc-install-'));
}

describe('skill source', () => {
  it('packaged skill exists with valid frontmatter and references', () => {
    const src = skillSourceDir();
    const skill = readFileSync(join(src, 'SKILL.md'), 'utf8');
    expect(skill).toMatch(/^---\nname: ultracode\n/);
    const description = skill.match(/description: (.*)\n/)?.[1] ?? '';
    expect(description.length).toBeGreaterThan(0);
    expect(description.length).toBeLessThanOrEqual(1024); // agentskills spec cap
    for (const ref of ['dialect.md', 'patterns.md', 'invoking.md', 'portability.md']) {
      expect(existsSync(join(src, 'references', ref))).toBe(true);
    }
    // progressive-disclosure budget: body should stay well under ~5k tokens
    expect(skill.length).toBeLessThan(20_000);
  });
});

describe('keyword-only arming is pinned to the doctrine', () => {
  // The whole point of this doctrine: ONLY the literal keyword "ultracode" arms
  // ultracode mode. A budget like "+500k" sizes the fleet once armed but never
  // arms it. No other test asserts this, so without these tripwires a regression
  // that re-couples budget syntax to arming ("+500k arms orchestration") would
  // pass every existing case.
  const flat = (text: string) => text.toLowerCase().replace(/\s+/g, ' ');

  it('installed trigger texts name the keyword as the ONLY trigger', () => {
    for (const text of [AGENTS_SNIPPET, QODER_RULE]) {
      expect(flat(text)).toContain('the keyword is the only trigger');
    }
  });

  it('the skill gates activation on the literal keyword only', () => {
    const skill = flat(readFileSync(join(skillSourceDir(), 'SKILL.md'), 'utf8'));
    expect(skill).toContain('use only when the user writes the keyword "ultracode"');
    expect(skill).toContain('only the keyword "ultracode"');
  });
});

describe('worker anti-nesting doctrine', () => {
  // Workers see these texts (trusted-cwd codex workers load user AGENTS.md and
  // the skill catalog; qoder always_on rules load into --print workers). Each
  // must carry the self-disarming guard, or workers recursively launch runs —
  // the 2026-07-16 fork-bomb was triggered by a DIRECTORY NAME containing the
  // keyword.
  const flat = (text: string) => text.toLowerCase().replace(/\s+/g, ' ');

  it('every installed trigger text carries the ULTRACODE_INSIDE_RUN worker guard', () => {
    for (const text of [AGENTS_SNIPPET, QODER_RULE]) {
      expect(text).toContain('ULTRACODE_INSIDE_RUN');
      expect(flat(text)).toContain('never start workflows');
      expect(flat(text)).toContain('file or directory names'); // path mentions are not triggers
    }
    const skill = readFileSync(join(skillSourceDir(), 'SKILL.md'), 'utf8');
    const description = skill.match(/description: (.*)\n/)?.[1] ?? '';
    expect(description).toContain('ULTRACODE_INSIDE_RUN'); // guard in the ANNOUNCED text
    expect(skill.split('ULTRACODE_INSIDE_RUN').length).toBeGreaterThan(2); // and in the body
    const invoking = readFileSync(join(skillSourceDir(), 'references/invoking.md'), 'utf8');
    expect(invoking).toContain('ULTRACODE_INSIDE_RUN');
  });

  it('qoder worker agent definitions forbid starting workflows', () => {
    for (const agent of ['uc-verifier.md', 'uc-xhigh.md']) {
      const text = readFileSync(join(skillSourceDir(), '../../hostpacks/qoder/agents', agent), 'utf8');
      expect(flat(text)).toContain('never start workflows');
    }
  });
});

describe('upsertMarkerBlock', () => {
  it('appends to a fresh file, preserves existing content, and is idempotent', () => {
    const dir = tmp();
    const file = join(dir, 'AGENTS.md');
    writeFileSync(file, '# My project\n\nExisting instructions.\n');

    const first = upsertMarkerBlock(file, AGENTS_SNIPPET, false);
    expect(first.changed).toBe(true);
    const after = readFileSync(file, 'utf8');
    expect(after).toContain('# My project');
    expect(after).toContain('Existing instructions.');
    expect(after).toContain(MARKER_BEGIN);
    expect(after.split(MARKER_BEGIN)).toHaveLength(2); // exactly one block

    const second = upsertMarkerBlock(file, AGENTS_SNIPPET, false);
    expect(second.changed).toBe(false);
    expect(readFileSync(file, 'utf8')).toBe(after);
  });

  it('replaces an outdated block in place', () => {
    const dir = tmp();
    const file = join(dir, 'AGENTS.md');
    writeFileSync(file, `intro\n${MARKER_BEGIN}\nOLD CONTENT\n${MARKER_END}\ntrailing\n`);
    upsertMarkerBlock(file, AGENTS_SNIPPET, false);
    const after = readFileSync(file, 'utf8');
    expect(after).toContain('intro');
    expect(after).toContain('trailing');
    expect(after).not.toContain('OLD CONTENT');
    expect(after).toContain('STANDING mode');
  });

  it('creates the file (and parents) when missing; dry-run writes nothing', () => {
    const dir = tmp();
    const file = join(dir, 'nested/AGENTS.md');
    const dry = upsertMarkerBlock(file, AGENTS_SNIPPET, true);
    expect(dry.changed).toBe(true);
    expect(existsSync(file)).toBe(false);
    upsertMarkerBlock(file, AGENTS_SNIPPET, false);
    expect(readFileSync(file, 'utf8')).toContain(MARKER_BEGIN);
  });
});

describe('installForHost', () => {
  it('codex user scope: skill → ~/.agents/skills, snippet → ~/.codex/AGENTS.md', () => {
    const home = tmp();
    const actions = installForHost('codex', { userHome: home });
    expect(existsSync(join(home, '.agents/skills/ultracode/SKILL.md'))).toBe(true);
    expect(existsSync(join(home, '.agents/skills/ultracode/references/patterns.md'))).toBe(true);
    expect(readFileSync(join(home, '.codex/AGENTS.md'), 'utf8')).toContain('STANDING mode');
    expect(actions.map((a) => a.kind)).toEqual(['copy-skill', 'upsert-snippet']);
  });

  it('codex project scope: skill → .agents/skills, snippet → project AGENTS.md (merged)', () => {
    const project = tmp();
    writeFileSync(join(project, 'AGENTS.md'), '# Project conventions\n');
    installForHost('codex', { project: true, projectRoot: project });
    expect(existsSync(join(project, '.agents/skills/ultracode/SKILL.md'))).toBe(true);
    const agents = readFileSync(join(project, 'AGENTS.md'), 'utf8');
    expect(agents).toContain('# Project conventions');
    expect(agents).toContain(MARKER_BEGIN);
  });

  it('re-install refreshes the skill in place', () => {
    const home = tmp();
    installForHost('codex', { userHome: home });
    const target = join(home, '.agents/skills/ultracode/SKILL.md');
    writeFileSync(target, 'stale local edit');
    installForHost('codex', { userHome: home });
    expect(readFileSync(target, 'utf8')).toContain('name: ultracode');
  });

  it('generic host plan has no user AGENTS.md target; unknown hosts error', () => {
    const home = tmp();
    expect(planFor('generic', { userHome: home }).agentsFiles).toEqual([]);
    expect(() => planFor('windsurf', {})).toThrow(/unknown install host/);
  });

  it('dry-run performs no writes', () => {
    const home = tmp();
    mkdirSync(join(home, '.agents'), { recursive: true });
    installForHost('codex', { userHome: home, dryRun: true });
    expect(existsSync(join(home, '.agents/skills'))).toBe(false);
    expect(existsSync(join(home, '.codex'))).toBe(false);
  });
});
