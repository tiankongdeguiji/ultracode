# Claude Code migration mapping

## Scope mapping

| Claude Code source | Ultracode destination | Behavior |
|---|---|---|
| `~/.claude/projects/<project>/memory/MEMORY.md` | `~/.ultracode/memory/projects/<id>/memory/MEMORY.md` | First 200 lines or 25KB load at task start. |
| Topic files beside `MEMORY.md` | Same names beside the destination index | Load on demand through recall/search. |
| `~/.claude/CLAUDE.md` and `~/.claude/rules/**/*.md` | `~/.ultracode/memory/rules/claude/` | Global instructions load for every project before project rules. |
| `<repo>/.claude/rules/**/*.md` | `<project>/rules/project/` in the portable store | `paths` frontmatter remains path-scoped. |
| `<repo>/CLAUDE.md` and `<repo>/.claude/CLAUDE.md` | `<project>/rules/project/` in the portable store | Unconditional instructions load at task start; file imports are expanded. |
| `<repo>/CLAUDE.local.md` | `<project>/rules/local/` in the portable store | Stays machine-local and never enters the repository. |

The project id hashes the git common directory so all worktrees and subdirectories share one store. Outside git, the launch directory is the project identity.

## Detection

Search in this order:

1. An explicit `source` / `--from` directory.
2. `autoMemoryDirectory` in project-local, project, then user Claude settings.
3. The path-derived directory under `~/.claude/projects/`.
4. Claude project directories whose recent transcript metadata names the current repository root.

Pass the directory containing `MEMORY.md`, or its parent project directory, when automatic detection cannot disambiguate it.

## Non-destructive conflicts

- Copy missing files with their original names.
- Skip byte-identical files.
- Preserve both differing files by writing the import as `claude-<name>` (with a numeric suffix when needed).
- Skip files that resemble credentials unless the user deliberately uses the CLI's `--include-sensitive` escape hatch.
- Never delete or modify the Claude source.

After a conflict import, inspect the two topics and consolidate them deliberately. Do not silently choose one version.

## Host limits

The storage and read limits match Claude Code: `MEMORY.md` is capped to the first 200 lines or 25KB at startup, while topic files load on demand. A host may impose a smaller lifecycle-hook output limit; when that happens, use `memory_context` or `memory_recall` to fetch the full stored content.
