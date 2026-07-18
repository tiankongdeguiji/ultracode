/** Import Claude Code auto memory and rules without modifying the source setup. */
import {
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  realpathSync,
  statSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { MemoryError } from '../engine/errors.js';
import { writeFileAtomicNoFollow } from '../exec/safe-write.js';
import {
  ensureRulesDir,
  looksSensitive,
  type MemoryOptions,
  resolveMemoryProject,
} from './store.js';

export interface ClaudeMigrationOptions extends MemoryOptions {
  source?: string;
  apply?: boolean;
  includeSensitive?: boolean;
  claudeHome?: string;
}

export interface ClaudeMigrationFile {
  source: string;
  destination: string;
  action: 'copy' | 'same' | 'conflict-copy' | 'skip-sensitive';
}

export interface ClaudeMigrationResult {
  applied: boolean;
  sourceMemoryDir: string;
  destinationMemoryDir: string;
  files: ClaudeMigrationFile[];
  rules: ClaudeMigrationFile[];
  instructions: ClaudeMigrationFile[];
}

function readJson(path: string): Record<string, unknown> | undefined {
  if (!existsSync(path) || !lstatSync(path).isFile()) return undefined;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function expandHome(path: string, home: string): string {
  if (path === '~') return home;
  if (path.startsWith('~/')) return join(home, path.slice(2));
  return path;
}

function hasMemoryIndex(path: string): boolean {
  return existsSync(join(path, 'MEMORY.md')) && lstatSync(join(path, 'MEMORY.md')).isFile();
}

function memoryDirCandidate(path: string): string | undefined {
  const absolute = resolve(path);
  if (hasMemoryIndex(absolute)) return absolute;
  if (hasMemoryIndex(join(absolute, 'memory'))) return join(absolute, 'memory');
  return undefined;
}

function encodedProjectNames(root: string): string[] {
  return [
    root.replace(/[^A-Za-z0-9_-]/g, '-'),
    root.replaceAll('\\', '-').replaceAll('/', '-').replaceAll(':', '-'),
  ].filter((value, index, all) => value && all.indexOf(value) === index);
}

function readPrefix(path: string, maxBytes = 128_000): string {
  const fd = openSync(path, 'r');
  try {
    const buffer = Buffer.alloc(maxBytes);
    const bytes = readSync(fd, buffer, 0, maxBytes, 0);
    return buffer.subarray(0, bytes).toString('utf8');
  } finally {
    closeSync(fd);
  }
}

function transcriptMatchesProject(projectDir: string, root: string): boolean {
  const canonicalRoot = resolve(root);
  for (const entry of readdirSync(projectDir, { withFileTypes: true }).slice(0, 20)) {
    if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
    try {
      const prefix = readPrefix(join(projectDir, entry.name));
      for (const line of prefix.split('\n').slice(0, 20)) {
        const parsed = JSON.parse(line) as { cwd?: unknown };
        if (typeof parsed.cwd === 'string' && resolve(parsed.cwd) === canonicalRoot) return true;
      }
    } catch {
      /* keep probing other transcripts */
    }
  }
  return false;
}

/** Locate the current project's Claude memory, including custom settings paths. */
export function findClaudeMemoryDir(opts: ClaudeMigrationOptions = {}): string {
  const project = resolveMemoryProject(opts);
  const userHome = opts.userHome ?? homedir();
  const claudeHome = opts.claudeHome ?? join(userHome, '.claude');
  if (opts.source) {
    const explicit = memoryDirCandidate(expandHome(opts.source, userHome));
    if (!explicit) throw new MemoryError(`Claude memory source has no MEMORY.md: ${opts.source}`);
    return explicit;
  }

  for (const settingsPath of [
    join(project.root, '.claude', 'settings.local.json'),
    join(project.root, '.claude', 'settings.json'),
    join(claudeHome, 'settings.json'),
  ]) {
    const configured = readJson(settingsPath)?.autoMemoryDirectory;
    if (typeof configured !== 'string') continue;
    const candidate = memoryDirCandidate(expandHome(configured, userHome));
    if (candidate) return candidate;
  }

  const projectsDir = join(claudeHome, 'projects');
  for (const name of encodedProjectNames(project.root)) {
    const candidate = memoryDirCandidate(join(projectsDir, name));
    if (candidate) return candidate;
  }
  if (existsSync(projectsDir) && lstatSync(projectsDir).isDirectory()) {
    for (const entry of readdirSync(projectsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const candidateRoot = join(projectsDir, entry.name);
      const candidate = memoryDirCandidate(candidateRoot);
      if (candidate && transcriptMatchesProject(candidateRoot, project.root)) return candidate;
    }
  }
  throw new MemoryError(
    `no Claude Code auto memory found for ${project.root}; pass --from ~/.claude/projects/<project>/memory`,
  );
}

function uniqueConflictPath(destination: string, prefix: string): string {
  const dir = dirname(destination);
  const name = basename(destination);
  let candidate = join(dir, `${prefix}-${name}`);
  for (let index = 2; existsSync(candidate); index++) candidate = join(dir, `${prefix}-${index}-${name}`);
  return candidate;
}

function planFile(
  source: string,
  destination: string,
  options: ClaudeMigrationOptions,
  suppliedContent?: string,
): ClaudeMigrationFile {
  const content = suppliedContent ?? readFileSync(source, 'utf8');
  if (!options.includeSensitive && looksSensitive(content)) {
    return { source, destination, action: 'skip-sensitive' };
  }
  if (!existsSync(destination)) {
    if (options.apply) writeFileAtomicNoFollow(destination, content);
    return { source, destination, action: 'copy' };
  }
  const stat = lstatSync(destination);
  if (!stat.isFile()) throw new MemoryError(`refusing to replace non-regular destination: ${destination}`);
  if (readFileSync(destination, 'utf8') === content) return { source, destination, action: 'same' };
  const conflict = uniqueConflictPath(destination, 'claude');
  if (options.apply) writeFileAtomicNoFollow(conflict, content);
  return { source, destination: conflict, action: 'conflict-copy' };
}

function markdownFiles(root: string): string[] {
  if (!existsSync(root)) return [];
  const result: string[] = [];
  const seen = new Set<string>();
  const visit = (dir: string): void => {
    const target = realpathSync(dir);
    if (seen.has(target)) return;
    seen.add(target);
    if (!statSync(dir).isDirectory()) {
      if (dir.endsWith('.md')) result.push(dir);
      return;
    }
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile() && entry.name.endsWith('.md')) result.push(path);
      else if (entry.isSymbolicLink()) visit(path);
    }
  };
  visit(root);
  return result;
}

function ruleSources(
  projectRoot: string,
  claudeHome: string,
  globalRulesDir: string,
  projectRulesDir: string,
): { root: string; destination: string }[] {
  return [
    { root: join(claudeHome, 'rules'), destination: join(globalRulesDir, 'claude') },
    { root: join(projectRoot, '.claude', 'rules'), destination: join(projectRulesDir, 'project') },
  ];
}

function expandClaudeImports(path: string, depth = 0, seen = new Set<string>()): string {
  const target = realpathSync(path);
  if (seen.has(target)) return `<!-- circular Claude import skipped: ${path} -->`;
  if (depth >= 5) return `<!-- Claude import depth exceeded: ${path} -->`;
  seen.add(target);
  const lines = readFileSync(path, 'utf8').split('\n');
  let fenced = false;
  const expanded = lines.map((line) => {
    if (/^\s*(```|~~~)/.test(line)) {
      fenced = !fenced;
      return line;
    }
    if (fenced) return line;
    const pieces = line.split('`');
    return pieces.map((piece, index) => {
      if (index % 2 === 1) return piece;
      return piece.replace(/(^|\s)@((?:~\/|\/?|\.\.?\/)?[A-Za-z0-9._/-]+)/g, (match, prefix: string, ref: string) => {
        const candidate = ref.startsWith('~/')
          ? join(homedir(), ref.slice(2))
          : isAbsolutePath(ref)
            ? ref
            : resolve(dirname(path), ref);
        if (!existsSync(candidate) || !statSync(candidate).isFile()) return match;
        return `${prefix}<!-- imported from ${candidate} -->\n${expandClaudeImports(candidate, depth + 1, new Set(seen))}`;
      });
    }).join('`');
  });
  return expanded.join('\n');
}

function isAbsolutePath(path: string): boolean {
  return path.startsWith('/') || /^[A-Za-z]:[\\/]/.test(path);
}

function instructionSources(projectRoot: string, claudeHome: string, project: ReturnType<typeof resolveMemoryProject>) {
  return [
    { source: join(claudeHome, 'CLAUDE.md'), destination: join(project.globalRulesDir, 'claude', 'CLAUDE.md') },
    { source: join(projectRoot, 'CLAUDE.md'), destination: join(project.rulesDir, 'project', 'CLAUDE.md') },
    { source: join(projectRoot, '.claude', 'CLAUDE.md'), destination: join(project.rulesDir, 'project', 'dot-claude-CLAUDE.md') },
    { source: join(projectRoot, 'CLAUDE.local.md'), destination: join(project.rulesDir, 'local', 'CLAUDE.local.md') },
  ];
}

/** Plan by default; --apply copies memory and rules without deleting or overwriting either side. */
export function migrateClaudeMemory(opts: ClaudeMigrationOptions = {}): ClaudeMigrationResult {
  if (opts.apply && process.env.ULTRACODE_INSIDE_RUN) {
    throw new MemoryError('project memory writes are disabled inside an ultracode worker');
  }
  const project = resolveMemoryProject(opts);
  const userHome = opts.userHome ?? homedir();
  const claudeHome = opts.claudeHome ?? join(userHome, '.claude');
  const sourceMemoryDir = findClaudeMemoryDir(opts);
  if (opts.apply) ensureRulesDir(opts);
  const files = readdirSync(sourceMemoryDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((entry) => {
      const source = join(sourceMemoryDir, entry.name);
      const destination = join(project.memoryDir, entry.name);
      if (opts.apply) mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
      return planFile(source, destination, opts);
    });

  const rules: ClaudeMigrationFile[] = [];
  for (const source of ruleSources(project.root, claudeHome, project.globalRulesDir, project.rulesDir)) {
    for (const file of markdownFiles(source.root)) {
      const rel = relative(source.root, file);
      const destination = join(source.destination, rel);
      if (opts.apply) mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
      rules.push(planFile(file, destination, opts));
    }
  }
  const instructions = instructionSources(project.root, claudeHome, project)
    .filter((entry) => existsSync(entry.source) && statSync(entry.source).isFile())
    .map((entry) => {
      if (opts.apply) mkdirSync(dirname(entry.destination), { recursive: true, mode: 0o700 });
      return planFile(entry.source, entry.destination, opts, expandClaudeImports(entry.source));
    });
  return {
    applied: opts.apply === true,
    sourceMemoryDir,
    destinationMemoryDir: project.memoryDir,
    files,
    rules,
    instructions,
  };
}
