# Portable project memory

Ultracode implements Claude Code's two-part memory model for agents that do not expose it natively:

1. **Durable instructions** come from `AGENTS.md` and imported Claude instruction/rule files.
2. **Auto memory** is a machine-local `MEMORY.md` index plus detailed topic files that the agent maintains while it works.

Memory is context, not enforcement. The current user request, the closest `AGENTS.md`, and current repository evidence always take precedence.

## Compatibility contract

| Behavior | Contract |
|---|---|
| Project scope | One identity per git common directory, shared by every worktree and subdirectory. Outside git, the launch directory is the identity. |
| Storage | Plain Markdown `MEMORY.md` plus optional topic files. |
| Startup load | First 200 lines or 25KB of `MEMORY.md`, whichever comes first, after stripping YAML frontmatter and block HTML comments. |
| Detailed recall | Topic files are searched/read only when relevant. |
| Auto memory | Agents save durable verified learnings without interrupting the user; transient state, guesses, and secrets are excluded. |
| Rules | Unscoped rules load at startup. `paths` frontmatter uses Claude-compatible glob matching and loads on demand for matching files. |
| Toggle | Auto memory is on by default and can be changed per project. |
| Audit | Every memory artifact is local Markdown that the user can inspect or remove. |

The store lives at:

```text
~/.ultracode/memory/
├── rules/                         # user-global imported instructions/rules
└── projects/<sha256-prefix>/
    ├── project.json               # project identity metadata
    ├── settings.json              # autoMemoryEnabled toggle
    ├── memory/
    │   ├── MEMORY.md              # concise startup index
    │   └── <topic>.md             # detailed on-demand memory
    └── rules/                     # project/local imported rules
```

Set `ULTRACODE_MEMORY_HOME` to move the store for tests or isolated environments.
Set `ULTRACODE_DISABLE_AUTO_MEMORY=1` to disable it for a process. For compatibility,
the Claude Code equivalent `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1` is honored too.

## Install into an agent

```bash
ultracode install codex
ultracode install qoder
ultracode install generic
```

All hosts receive the `ultracode-memory` skill and startup guidance. Codex additionally receives:

- `memory_*` tools from the existing ultracode MCP server;
- a `SessionStart` hook that injects memory on startup, resume, clear, and compaction.

Codex requires the user to review and trust a new or changed non-managed hook. Open `/hooks` after installation when Codex reports that review is needed.

The Codex plugin bundle contains the same skill, MCP registration, and default `hooks/hooks.json`. Qoder and generic hosts load context through their installed rule or `AGENTS.md` guidance and use CLI commands when MCP is unavailable.

## Use memory

Agents normally call the tools automatically. The equivalent human-facing CLI is:

```bash
ultracode memory info
ultracode memory context
ultracode memory search "redis tests"
ultracode memory read debugging
ultracode memory remember "API tests use Redis on port 6380" \
  --topic debugging --summary "API tests use Redis on port 6380."
ultracode memory rules src/api/users.ts
ultracode memory mode off
ultracode memory forget debugging --yes
```

`memory remember` rejects common credential patterns. Memory writes are also disabled inside ultracode workflow workers; the parent agent decides whether a worker result is verified and durable enough to retain.
As in Claude Code, a write that pushes `MEMORY.md` over its startup window is preserved but returns an error telling the agent to consolidate the index immediately.

## Migrate Claude Code

Migration is non-destructive and plans before writing:

```bash
ultracode memory migrate-claude
ultracode memory migrate-claude --apply
```

Automatic detection checks an explicit `--from` path, Claude's `autoMemoryDirectory` settings, the current repository's path-derived directory under `~/.claude/projects/`, and recent Claude transcript metadata. Pass either the Claude project directory or its `memory/` directory when detection is ambiguous:

```bash
ultracode memory migrate-claude \
  --from ~/.claude/projects/<project>/memory --apply
```

The importer handles:

- `MEMORY.md` and sibling topic files;
- user and project `.claude/rules/**/*.md`;
- user, project, `.claude/`, and local `CLAUDE.md` instruction files;
- recursive Claude `@file` imports in instruction files, expanded into the portable copy.

Missing files copy with their original names, identical files are skipped, and differing files are preserved under `claude-*` names. Secret-like files are skipped by default. The source `~/.claude` and repository `.claude/` trees are never changed.

## Codex native memory

Codex also has its own local generated memory subsystem. Ultracode deliberately does not write `~/.codex/memories/`: OpenAI documents that directory as generated state rather than a stable import API. The portable store is separate so the same Markdown and migration behavior works across Codex, Qoder, and generic agents. Users may enable both; explicit instructions and current evidence still win.

## Host limitation

Codex caps each model-visible hook output to roughly 2,500 tokens and stores oversized output as an artifact with a preview. The portable store still preserves Claude's full 200-line/25KB contract; `memory_context` and `memory_recall` provide the complete content when a lifecycle hook cannot inject it all at once.

References: [Claude Code memory](https://code.claude.com/docs/en/memory), [Codex memories](https://learn.chatgpt.com/docs/customization/memories), and [Codex hooks](https://learn.chatgpt.com/docs/hooks).
