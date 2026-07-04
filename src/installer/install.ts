/**
 * Host installer: copies the canonical skill and appends a marker-guarded
 * AGENTS.md snippet. Idempotent; merge-not-overwrite (only content between
 * our markers is ever touched in shared files).
 */
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const MARKER_BEGIN = '<!-- ultracode:begin (managed by `ultracode install`; edits inside will be overwritten) -->';
export const MARKER_END = '<!-- ultracode:end -->';

export const AGENTS_SNIPPET = `${MARKER_BEGIN}
## ultracode (dynamic workflow orchestration)

When the user writes "ultracode" anywhere in a message, includes a token budget like "+500k",
or asks to orchestrate / use a workflow / fan out agents: read the \`ultracode\` skill and route
the task through a multi-agent workflow. Treat "ultracode" as a STANDING mode for the rest of
the session until the user says "ultracode off": every substantive task gets a workflow;
only trivial or conversational turns are handled solo. Budget directives are hard ceilings.
${MARKER_END}`;

/** Locate the packaged skill dir (works from src/ under tsx and from dist/). */
export function skillSourceDir(): string {
  const here = dirname(fileURLToPath(import.meta.url)); // .../src/installer or .../dist/installer
  return join(here, '../../skill/ultracode');
}

export interface InstallAction {
  kind: 'copy-skill' | 'upsert-snippet';
  path: string;
  changed: boolean;
  detail: string;
}

export function upsertMarkerBlock(file: string, snippet: string, dryRun: boolean): InstallAction {
  const existing = existsSync(file) ? readFileSync(file, 'utf8') : '';
  const begin = existing.indexOf(MARKER_BEGIN);
  let next: string;
  if (begin === -1) {
    next = existing.length === 0 ? snippet + '\n' : existing.replace(/\n*$/, '\n\n') + snippet + '\n';
  } else {
    const end = existing.indexOf(MARKER_END, begin);
    if (end === -1) {
      // corrupted block: replace from begin to EOF
      next = existing.slice(0, begin) + snippet + '\n';
    } else {
      next = existing.slice(0, begin) + snippet + existing.slice(end + MARKER_END.length);
    }
  }
  const changed = next !== existing;
  if (changed && !dryRun) {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, next, 'utf8');
  }
  return {
    kind: 'upsert-snippet',
    path: file,
    changed,
    detail: begin === -1 ? 'snippet appended' : changed ? 'snippet updated' : 'snippet already current',
  };
}

export function copySkill(destDir: string, dryRun: boolean): InstallAction {
  const src = skillSourceDir();
  if (!existsSync(join(src, 'SKILL.md'))) {
    throw new Error(`packaged skill not found at ${src}`);
  }
  const already = existsSync(join(destDir, 'SKILL.md'));
  if (!dryRun) {
    mkdirSync(destDir, { recursive: true });
    cpSync(src, destDir, { recursive: true, force: true });
  }
  return {
    kind: 'copy-skill',
    path: destDir,
    changed: true,
    detail: already ? 'skill refreshed' : 'skill installed',
  };
}

export interface InstallOptions {
  project?: boolean;
  dryRun?: boolean;
  /** test seams */
  userHome?: string;
  projectRoot?: string;
}

export interface HostInstallPlan {
  skillDirs: string[];
  agentsFiles: string[];
}

export function planFor(host: string, opts: InstallOptions): HostInstallPlan {
  const home = opts.userHome ?? homedir();
  const project = opts.projectRoot ?? process.cwd();
  switch (host) {
    case 'codex':
      // Codex scans repo .agents/skills (cwd→root) and user ~/.agents/skills;
      // AGENTS.md global lives under ~/.codex/, project at the repo root.
      return opts.project
        ? { skillDirs: [join(project, '.agents/skills/ultracode')], agentsFiles: [join(project, 'AGENTS.md')] }
        : { skillDirs: [join(home, '.agents/skills/ultracode')], agentsFiles: [join(home, '.codex/AGENTS.md')] };
    case 'generic':
      // .agents/skills is the cross-host de-facto path (gemini/cursor/amp/
      // crush/opencode/windsurf all scan it); AGENTS.md is near-universal.
      return opts.project
        ? { skillDirs: [join(project, '.agents/skills/ultracode')], agentsFiles: [join(project, 'AGENTS.md')] }
        : { skillDirs: [join(home, '.agents/skills/ultracode')], agentsFiles: [] };
    default:
      throw new Error(`unknown install host '${host}' (available: codex, generic)`);
  }
}

export function installForHost(host: string, opts: InstallOptions): InstallAction[] {
  const plan = planFor(host, opts);
  const actions: InstallAction[] = [];
  for (const dir of plan.skillDirs) actions.push(copySkill(dir, opts.dryRun ?? false));
  for (const file of plan.agentsFiles) actions.push(upsertMarkerBlock(file, AGENTS_SNIPPET, opts.dryRun ?? false));
  return actions;
}
