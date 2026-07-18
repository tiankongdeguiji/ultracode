/** Claude-compatible unconditional and path-scoped memory-rule loading. */
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { basename, join, relative, resolve } from 'node:path';
import { minimatch } from 'minimatch';
import { MemoryError } from '../engine/errors.js';
import { type MemoryOptions, projectRelativePath, resolveMemoryProject } from './store.js';

export interface MemoryRule {
  name: string;
  path: string;
  patterns: string[];
  body: string;
}

function markdownFilesRecursive(root: string, seen = new Set<string>()): string[] {
  if (!existsSync(root)) return [];
  const target = realpathSync(root);
  if (seen.has(target)) return [];
  seen.add(target);
  const stat = statSync(root);
  if (!stat.isDirectory()) return stat.isFile() && root.endsWith('.md') ? [root] : [];
  const result: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) result.push(...markdownFilesRecursive(path, seen));
    else if (entry.isFile() && entry.name.endsWith('.md')) result.push(path);
    else if (entry.isSymbolicLink()) result.push(...markdownFilesRecursive(path, seen));
  }
  return result;
}

function stripQuotes(value: string): string {
  const trimmed = value.trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function inlinePatterns(value: string): string[] {
  const patterns: string[] = [];
  let current = '';
  let quote = '';
  let depth = 0;
  let escaped = false;
  for (const char of value) {
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }
    if (quote && char === '\\') {
      current += char;
      escaped = true;
      continue;
    }
    if (char === '"' || char === "'") {
      if (!quote) quote = char;
      else if (quote === char) quote = '';
      current += char;
      continue;
    }
    if (!quote && ['{', '[', '('].includes(char)) depth++;
    else if (!quote && ['}', ']', ')'].includes(char)) depth = Math.max(0, depth - 1);
    if (!quote && depth === 0 && char === ',') {
      const pattern = stripQuotes(current);
      if (pattern) patterns.push(pattern);
      current = '';
      continue;
    }
    current += char;
  }
  const pattern = stripQuotes(current);
  if (pattern) patterns.push(pattern);
  return patterns;
}

/** Parse only the Claude rules `paths` frontmatter field; ignore unrelated YAML. */
export function parseMemoryRule(path: string, content: string): MemoryRule {
  const patterns: string[] = [];
  let body = content;
  if (content.startsWith('---\n')) {
    const end = content.indexOf('\n---', 4);
    if (end !== -1) {
      const frontmatter = content.slice(4, end).split('\n');
      let readingPaths = false;
      for (const raw of frontmatter) {
        const key = raw.match(/^paths\s*:\s*(.*)$/);
        if (key) {
          readingPaths = true;
          const inline = key[1]!.trim();
          if (inline.startsWith('[') && inline.endsWith(']')) {
            patterns.push(...inlinePatterns(inline.slice(1, -1)));
          } else if (inline) {
            patterns.push(stripQuotes(inline));
          }
          continue;
        }
        const item = readingPaths ? raw.match(/^\s*-\s+(.+)$/) : null;
        if (item) patterns.push(stripQuotes(item[1]!));
        else if (raw.trim() && !/^\s/.test(raw)) readingPaths = false;
      }
      body = content.slice(end + 4).replace(/^\r?\n/, '');
    }
  }
  return { name: basename(path, '.md'), path, patterns, body: body.trim() };
}

export function listMemoryRules(opts: MemoryOptions = {}): MemoryRule[] {
  const project = resolveMemoryProject(opts);
  return [
    ...markdownFilesRecursive(project.globalRulesDir),
    ...markdownFilesRecursive(project.rulesDir),
  ].map((path) => parseMemoryRule(path, readFileSync(path, 'utf8')));
}

export function rulesForPath(path: string, opts: MemoryOptions = {}): MemoryRule[] {
  const project = resolveMemoryProject(opts);
  const absolute = resolve(project.root, path);
  const rel = projectRelativePath(absolute, project);
  return listMemoryRules(opts).filter((rule) =>
    rule.patterns.length === 0
      || rule.patterns.some((pattern) => {
        try {
          return minimatch(rel, pattern, { dot: true, matchBase: !pattern.includes('/') });
        } catch {
          return false;
        }
      }),
  );
}

export function unconditionalRulesContext(opts: MemoryOptions = {}): string {
  const rules = listMemoryRules(opts);
  const unconditional = rules.filter((rule) => rule.patterns.length === 0 && rule.body);
  const scoped = rules.filter((rule) => rule.patterns.length > 0);
  if (unconditional.length === 0 && scoped.length === 0) return '';
  const sections = unconditional.map((rule) => `## ${rule.name}\nSource: ${rule.path}\n\n${rule.body}`);
  if (scoped.length > 0) {
    sections.push(
      '## Path-scoped rules\n' +
        'Before editing or reviewing a file, call memory_rules with that path. Available mappings:\n' +
        scoped.map((rule) => `- ${rule.patterns.join(', ')} -> ${rule.path}`).join('\n'),
    );
  }
  return ['<ultracode-memory-rules>', ...sections, '</ultracode-memory-rules>'].join('\n\n');
}

export function pathRulesContext(path: string, opts: MemoryOptions = {}): string {
  const project = resolveMemoryProject(opts);
  const rel = relative(project.root, resolve(project.root, path)).replaceAll('\\', '/');
  if (rel.startsWith('../') || rel === '..') throw new MemoryError(`path is outside the project: ${path}`);
  const matching = rulesForPath(path, opts).filter((rule) => rule.patterns.length > 0);
  if (matching.length === 0) return '';
  return [
    `<ultracode-path-rules path="${rel}">`,
    ...matching.map((rule) => `## ${rule.name}\nSource: ${rule.path}\n\n${rule.body}`),
    '</ultracode-path-rules>',
  ].join('\n\n');
}
