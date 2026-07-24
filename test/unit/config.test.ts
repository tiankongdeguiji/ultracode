import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  backendOverrideWarning,
  loadSubagentConfig,
  MAX_CONFIG_BYTES,
  resolveSubagentProfile,
  validateSubagentProfile,
} from '../../src/config.js';

function put(path: string, value: unknown): void {
  mkdirSync(join(path, '.ultracode'), { recursive: true });
  writeFileSync(join(path, '.ultracode', 'config.json'), JSON.stringify(value));
}

describe('layered subagent config', () => {
  it('returns no defaults when both optional files are absent', () => {
    const root = mkdtempSync(join(tmpdir(), 'uc-config-'));
    expect(loadSubagentConfig(join(root, 'project'), { userHome: join(root, 'home') })).toEqual({});
  });

  it('overlays project fields on user defaults without dropping untouched fields', () => {
    const root = mkdtempSync(join(tmpdir(), 'uc-config-'));
    const home = join(root, 'home');
    const project = join(root, 'project');
    put(home, { subagent: { backend: 'qoder', model: 'auto', effort: 'high', context_window: 200_000 } });
    put(project, { subagent: { model: 'coder', effort: 'xhigh' } });
    expect(loadSubagentConfig(project, { userHome: home })).toEqual({
      backend: 'qoder',
      model: 'coder',
      effort: 'xhigh',
      contextWindow: 200_000,
    });
  });

  it.each([
    ['unknown top-level field', { nope: true }],
    ['unknown subagent field', { subagent: { cli: 'qoder' } }],
    ['unimplemented backend', { subagent: { backend: 'cursor' } }],
    ['empty model', { subagent: { model: ' ' } }],
    ['empty effort', { subagent: { effort: '' } }],
    ['zero context window', { subagent: { context_window: 0 } }],
    ['fractional context window', { subagent: { context_window: 1.5 } }],
  ])('rejects %s with the source path', (_label, value) => {
    const root = mkdtempSync(join(tmpdir(), 'uc-config-'));
    const project = join(root, 'project');
    put(project, value);
    expect(() => loadSubagentConfig(project, { userHome: join(root, 'home') })).toThrow(
      new RegExp(`invalid ultracode config .*${project.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}.*config\\.json`),
    );
  });

  it('rejects malformed JSON with the source path', () => {
    const root = mkdtempSync(join(tmpdir(), 'uc-config-'));
    const project = join(root, 'project');
    mkdirSync(join(project, '.ultracode'), { recursive: true });
    writeFileSync(join(project, '.ultracode', 'config.json'), '{ nope');
    expect(() => loadSubagentConfig(project, { userHome: join(root, 'home') })).toThrow(
      new RegExp(`invalid ultracode config .*${project.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`),
    );
  });

  it('rejects oversized, symlinked, and non-regular project config files', () => {
    const root = mkdtempSync(join(tmpdir(), 'uc-config-'));
    const home = join(root, 'home');

    const oversized = join(root, 'oversized');
    mkdirSync(join(oversized, '.ultracode'), { recursive: true });
    writeFileSync(join(oversized, '.ultracode', 'config.json'), ' '.repeat(MAX_CONFIG_BYTES + 1));
    expect(() => loadSubagentConfig(oversized, { userHome: home })).toThrow(/exceeds 65536 bytes/);

    const linked = join(root, 'linked');
    mkdirSync(join(linked, '.ultracode'), { recursive: true });
    const target = join(root, 'target.json');
    writeFileSync(target, JSON.stringify({ subagent: { backend: 'mock' } }));
    symlinkSync(target, join(linked, '.ultracode', 'config.json'));
    expect(() => loadSubagentConfig(linked, { userHome: home })).toThrow(/invalid ultracode config/);

    const fifoProject = join(root, 'fifo');
    mkdirSync(join(fifoProject, '.ultracode'), { recursive: true });
    const fifo = join(fifoProject, '.ultracode', 'config.json');
    const mk = spawnSync('mkfifo', [fifo]);
    if (mk.status === 0) {
      expect(() => loadSubagentConfig(fifoProject, { userHome: home })).toThrow(/must be a regular file/);
    }
  });
});

describe('subagent profile resolution', () => {
  const configured = {
    backend: 'qoder',
    model: 'Qwen3.8-Max-Preview',
    effort: 'xhigh',
    contextWindow: 1_000_000,
  };

  it('inherits the complete configured profile when backend is omitted', () => {
    expect(resolveSubagentProfile(configured, {})).toEqual({
      profile: configured,
      ignoredDefaults: [],
    });
  });

  it('inherits unspecified controls when the explicit backend is unchanged', () => {
    expect(resolveSubagentProfile(configured, { backend: 'qoder', model: 'coder' })).toEqual({
      profile: { ...configured, model: 'coder' },
      ignoredDefaults: [],
    });
  });

  it('starts a fresh profile and warns when the explicit backend changes', () => {
    const resolved = resolveSubagentProfile(configured, { backend: 'codex' });
    expect(resolved).toEqual({
      profile: {
        backend: 'codex',
        model: undefined,
        effort: undefined,
        contextWindow: undefined,
      },
      ignoredDefaults: ['model', 'effort', 'contextWindow'],
    });
    expect(backendOverrideWarning(configured, resolved)).toBe(
      "backend override 'codex' differs from configured backend 'qoder'; " +
      'not inheriting configured model, effort, contextWindow',
    );
  });

  it('keeps only explicitly supplied controls after a backend switch', () => {
    expect(resolveSubagentProfile(configured, {
      backend: 'codex',
      model: 'gpt-5.6-sol',
      effort: 'ultra',
    })).toEqual({
      profile: {
        backend: 'codex',
        model: 'gpt-5.6-sol',
        effort: 'ultra',
        contextWindow: undefined,
      },
      ignoredDefaults: ['contextWindow'],
    });
  });

  it('rejects controls known to be incompatible with the selected backend', () => {
    expect(() => validateSubagentProfile({ backend: 'codex', contextWindow: 200_000 })).toThrow(
      'contextWindow is supported only by the qoder backend',
    );
    expect(() => validateSubagentProfile({ backend: 'gemini', effort: 'high' })).toThrow(
      'effort is unsupported by the gemini backend',
    );
  });
});
