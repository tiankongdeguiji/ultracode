import { describe, it, expect } from 'vitest';
import { mkdtempSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AGENTS_SNIPPET,
  MARKER_BEGIN,
  MARKER_END,
  QODER_RULE,
  codexMcpToml,
  installForHost,
  memorySkillSourceDir,
  planFor,
  skillSourceDir,
  upsertMarkerBlock,
} from '../../src/installer/install.js';

function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'uc-install-'));
}

describe('codex MCP registration', () => {
  it('writes the quiet-monitor hold budget and headless pre-approval', () => {
    const block = codexMcpToml(
      ['/usr/bin/node', '/x/main.js', 'mcp'],
      ['/usr/bin/node', '/x/main.js', 'memory', 'hook'],
    );
    expect(block).toContain('[mcp_servers.ultracode]');
    expect(block).toContain('command = "/usr/bin/node"');
    expect(block).toContain('args = ["/x/main.js","mcp"]');
    // 3600 is the quiet monitor's hold ceiling (workflow_status until='terminal',
    // doctrine waitSeconds=3300) — codex never extends tool timeouts on progress.
    expect(block).toContain('tool_timeout_sec = 3600');
    expect(block).toContain('default_tools_approval_mode = "approve"');
    expect(block).toContain('[[hooks.SessionStart]]');
    expect(block).toContain('startup|resume|clear|compact');
    expect(block).toContain("'/usr/bin/node' '/x/main.js' 'memory' 'hook'");
  });

  it('installForHost replaces a stale pre-quiet-monitor block (tool_timeout_sec = 90) instead of appending', () => {
    const home = tmp();
    const cmd = ['/usr/bin/node', '/x/main.js', 'mcp'];
    const configPath = join(home, '.codex/config.toml');
    mkdirSync(join(home, '.codex'), { recursive: true });
    writeFileSync(
      configPath,
      'sandbox_mode = "read-only"\n\n' + codexMcpToml(cmd).replace('tool_timeout_sec = 3600', 'tool_timeout_sec = 90') + '\n',
    );

    const actions = installForHost('codex', { userHome: home, mcpCommand: cmd });
    const config = readFileSync(configPath, 'utf8');
    expect(config).toContain('sandbox_mode = "read-only"'); // user content outside the markers untouched
    expect(config).toContain('tool_timeout_sec = 3600');
    expect(config).not.toContain('tool_timeout_sec = 90');
    expect(config.match(/\[mcp_servers\.ultracode\]/g)).toHaveLength(1); // replaced in place, not appended
    expect(actions.find((a) => a.path === configPath)?.changed).toBe(true);

    const again = installForHost('codex', { userHome: home, mcpCommand: cmd });
    expect(again.find((a) => a.path === configPath)?.changed).toBe(false); // idempotent once current
  });
});

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

  it('packaged memory skill exists with migration guidance and UI metadata', () => {
    const src = memorySkillSourceDir();
    expect(readFileSync(join(src, 'SKILL.md'), 'utf8')).toMatch(/^---\nname: ultracode-memory\n/);
    expect(readFileSync(join(src, 'references/migration.md'), 'utf8')).toContain('Claude Code migration mapping');
    expect(readFileSync(join(src, 'agents/openai.yaml'), 'utf8')).toContain('$ultracode-memory');
  });
});

describe('keyword-only arming is pinned to the doctrine', () => {
  // The whole point of this doctrine: ONLY the literal keyword "ultracode" arms
  // ultracode mode. A budget like "+500k" sizes the fleet once armed but never
  // arms it. No other test asserts this, so without these tripwires a regression
  // re-coupling budget/workflow syntax to arming would pass every existing case.
  // Positive checks pin the slogan; negative checks reject re-adding an arming clause.
  const flat = (text: string) => text.toLowerCase().replace(/\s+/g, ' ');

  it('installed trigger texts name the keyword as the ONLY trigger', () => {
    for (const text of [AGENTS_SNIPPET, QODER_RULE]) {
      expect(flat(text)).toContain('the keyword is the only trigger');
      // the former arming clauses (a budget / a workflow request as a trigger) stay removed
      expect(flat(text)).not.toContain('includes a token budget');
      expect(flat(text)).not.toContain('asks to orchestrate');
    }
  });

  it('the skill activates on the literal keyword only, never a budget', () => {
    const skill = readFileSync(join(skillSourceDir(), 'SKILL.md'), 'utf8');
    const description = (skill.match(/description: (.*)\n/)?.[1] ?? '').toLowerCase();
    // the skill-activation trigger (description) is keyword-gated and must never list a budget
    expect(description).toContain('use only when the user writes the keyword "ultracode"');
    expect(description).not.toContain('budget');
    expect(description).not.toContain('+500k');
    // and the mode-semantics rule states keyword exclusivity
    expect(flat(skill)).toContain('only the keyword "ultracode"');
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
    expect(existsSync(join(home, '.agents/skills/ultracode-memory/SKILL.md'))).toBe(true);
    const agents = readFileSync(join(home, '.codex/AGENTS.md'), 'utf8');
    expect(agents).toContain('STANDING mode');
    expect(agents).toContain('ultracode memory (portable project memory)');
    expect(actions.map((a) => a.kind)).toEqual(['copy-skill', 'copy-skill', 'upsert-snippet']);
  });

  it('codex project scope: skill → .agents/skills, snippet → project AGENTS.md (merged)', () => {
    const project = tmp();
    writeFileSync(join(project, 'AGENTS.md'), '# Project conventions\n');
    installForHost('codex', { project: true, projectRoot: project });
    expect(existsSync(join(project, '.agents/skills/ultracode/SKILL.md'))).toBe(true);
    expect(existsSync(join(project, '.agents/skills/ultracode-memory/SKILL.md'))).toBe(true);
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
