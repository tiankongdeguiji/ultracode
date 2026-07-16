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

When the user writes "ultracode" as a request in a message, includes a token budget like "+500k",
or asks to orchestrate / use a workflow / fan out agents: read the \`ultracode\` skill and route
the task through a multi-agent workflow. Treat "ultracode" as a STANDING mode for the rest of
the session until the user says "ultracode off": every substantive task gets a workflow;
only trivial or conversational turns are handled solo. Never set a token budget the user did not
ask for — default to uncapped; only a user directive like "+500k" sets a hard ceiling.

Worker guard: the trigger is the user's word to YOU — "ultracode" appearing inside file or
directory names, paths, code, or quoted logs never arms the mode. If the environment variable
\`ULTRACODE_INSIDE_RUN\` is set, you ARE a worker inside an ultracode run: never start workflows
by any route (ultracode CLI, workflow_start MCP tool, a native Workflow tool) — do your assigned
task directly and return.
${MARKER_END}`;

/** Locate the packaged skill dir (works from src/ under tsx and from dist/). */
export function skillSourceDir(): string {
  const here = dirname(fileURLToPath(import.meta.url)); // .../src/installer or .../dist/installer
  return join(here, '../../skill/ultracode');
}

export function packagedDir(rel: string): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, '../..', rel);
}

/**
 * Qoder rides its NATIVE Workflow tool (a faithful port of the same dialect) —
 * this rule provides the standing-mode trigger Qoder lacks.
 */
export const QODER_RULE = `---
trigger: always_on
---

# ultracode mode

When the user writes "ultracode" as a request in a message, includes a token budget like "+500k",
or asks to orchestrate / use a workflow / fan out agents: read the \`ultracode\` skill and route
the task through the NATIVE Workflow tool (dynamic workflows). Treat "ultracode" as a STANDING
mode for the rest of the session until the user says "ultracode off": every substantive task gets
a workflow; only trivial or conversational turns are handled solo. Never set a token budget the user
did not ask for — default to uncapped; only a user directive like "+500k" sets a hard ceiling (the
native \`budget\` global is stubbed, so pass a user-given budget via args.budgetTokens and gate in-script).
Saved templates: uc-review, uc-research (in .qoder/workflows or ~/.qoder/workflows).

Worker guard: the trigger is the user's word to YOU — "ultracode" inside file or directory names,
paths, code, or quoted logs never arms the mode. If the environment variable \`ULTRACODE_INSIDE_RUN\`
is set, you are a worker inside an ultracode run: never start workflows by any route (Workflow tool,
ultracode CLI, workflow_start) — do your assigned task directly and return.
`;

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
  /** files written verbatim (marker-free, fully managed by us) */
  managedFiles?: { path: string; content: string; label: string }[];
  /** packaged dirs copied file-by-file (workflow templates, agent defs) */
  copyDirs?: { src: string; dest: string; label: string }[];
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
    case 'qoder': {
      // Rides the NATIVE Workflow tool: skill + always_on rule (project) or
      // AGENTS.md snippet (user) + uc-* templates + effort-routing agent defs.
      const base = opts.project ? join(project, '.qoder') : join(home, '.qoder');
      const plan: HostInstallPlan = {
        skillDirs: [join(base, 'skills/ultracode')],
        agentsFiles: opts.project ? [] : [join(home, '.qoder/AGENTS.md')],
        copyDirs: [
          { src: packagedDir('workflows'), dest: join(base, 'workflows'), label: 'uc-* workflow templates' },
          { src: packagedDir('hostpacks/qoder/agents'), dest: join(base, 'agents'), label: 'uc-* agent definitions' },
        ],
      };
      if (opts.project) {
        plan.managedFiles = [{ path: join(base, 'rules/ultracode-mode.md'), content: QODER_RULE, label: 'always_on rule' }];
      }
      return plan;
    }
    case 'generic':
      // .agents/skills is the cross-host de-facto path (gemini/cursor/amp/
      // crush/opencode/windsurf all scan it); AGENTS.md is near-universal.
      return opts.project
        ? { skillDirs: [join(project, '.agents/skills/ultracode')], agentsFiles: [join(project, 'AGENTS.md')] }
        : { skillDirs: [join(home, '.agents/skills/ultracode')], agentsFiles: [] };
    default:
      throw new Error(`unknown install host '${host}' (available: codex, qoder, generic)`);
  }
}

export function installForHost(host: string, opts: InstallOptions): InstallAction[] {
  const plan = planFor(host, opts);
  const dryRun = opts.dryRun ?? false;
  const actions: InstallAction[] = [];
  for (const dir of plan.skillDirs) actions.push(copySkill(dir, dryRun));
  for (const file of plan.agentsFiles) actions.push(upsertMarkerBlock(file, AGENTS_SNIPPET, dryRun));
  for (const mf of plan.managedFiles ?? []) {
    const same = existsSync(mf.path) && readFileSync(mf.path, 'utf8') === mf.content;
    if (!same && !dryRun) {
      mkdirSync(dirname(mf.path), { recursive: true });
      writeFileSync(mf.path, mf.content, 'utf8');
    }
    actions.push({ kind: 'upsert-snippet', path: mf.path, changed: !same, detail: same ? `${mf.label} already current` : `${mf.label} written` });
  }
  for (const cd of plan.copyDirs ?? []) {
    if (!dryRun) {
      mkdirSync(cd.dest, { recursive: true });
      cpSync(cd.src, cd.dest, { recursive: true, force: true });
    }
    actions.push({ kind: 'copy-skill', path: cd.dest, changed: true, detail: `${cd.label} installed` });
  }

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
