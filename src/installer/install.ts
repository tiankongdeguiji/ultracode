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

export function upsertMarkerBlock(
  file: string,
  snippet: string,
  dryRun: boolean,
  markers: { begin: string; end: string } = { begin: MARKER_BEGIN, end: MARKER_END },
): InstallAction {
  const existing = existsSync(file) ? readFileSync(file, 'utf8') : '';
  const begin = existing.indexOf(markers.begin);
  let next: string;
  if (begin === -1) {
    next = existing.length === 0 ? snippet + '\n' : existing.replace(/\n*$/, '\n\n') + snippet + '\n';
  } else {
    const end = existing.indexOf(markers.end, begin);
    if (end === -1) {
      // corrupted block: replace from begin to EOF
      next = existing.slice(0, begin) + snippet + '\n';
    } else {
      next = existing.slice(0, begin) + snippet + existing.slice(end + markers.end.length);
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

export const TOML_MARKER_BEGIN = '# ultracode:begin (managed by `ultracode install`; edits inside will be overwritten)';
export const TOML_MARKER_END = '# ultracode:end';

/**
 * codex MCP registration: appended as a marker-guarded TOML block. Appending
 * a table at EOF is a safe TOML operation; we never parse or rewrite the
 * rest of the user's config.toml. tool_timeout_sec=90 gives comfortable
 * headroom over the ≤50s long-poll.
 */
export function codexMcpToml(command: string[], schemaNote = ''): string {
  const [bin, ...args] = command;
  return [
    TOML_MARKER_BEGIN,
    schemaNote,
    '[mcp_servers.ultracode]',
    `command = ${JSON.stringify(bin)}`,
    `args = ${JSON.stringify(args)}`,
    'tool_timeout_sec = 90',
    // Without pre-approval, headless codex exec auto-rejects every MCP call
    // ("user cancelled MCP tool call") — live-verified on 0.142.4.
    'default_tools_approval_mode = "approve"',
    TOML_MARKER_END,
  ]
    .filter((l) => l.length > 0)
    .join('\n');
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
  /** argv for launching `ultracode mcp` (resolved by the CLI; enables codex MCP registration) */
  mcpCommand?: string[];
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

  // MCP registration (codex, user scope only — project .codex/config.toml
  // needs a trusted project; keep the user-scope path deterministic).
  if (host === 'codex' && !opts.project && opts.mcpCommand) {
    const home = opts.userHome ?? homedir();
    const action = upsertMarkerBlock(
      join(home, '.codex/config.toml'),
      codexMcpToml(opts.mcpCommand),
      opts.dryRun ?? false,
      { begin: TOML_MARKER_BEGIN, end: TOML_MARKER_END },
    );
    actions.push({ ...action, detail: `MCP registration ${action.detail.replace('snippet ', '')}` });
  }
  return actions;
}
