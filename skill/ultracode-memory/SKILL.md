---
name: ultracode-memory
description: Portable Claude Code-compatible project memory for coding agents. Use when a user asks Codex or another agent to remember or forget a project fact, recall prior project knowledge, inspect memory, load path-scoped rules, enable or disable auto memory, or migrate existing Claude Code MEMORY.md topic files and .claude/rules into ultracode.
---

# Ultracode Memory

Use one local memory store across supported agents. Keep required instructions in `AGENTS.md`; treat memory as fallible recall that the current prompt and repository evidence can override.

## Start a task

1. Reuse `<ultracode-memory>` context when a host hook already supplied it.
2. Otherwise call `memory_context` once. If MCP is unavailable, run `ultracode memory context --cwd "$PWD"`.
3. Read detailed topics only when relevant with `memory_recall { topic }` or `memory_recall { query }`.
4. Before editing or reviewing a file named by the path-rule index, call `memory_recall { path }`.

Do not repeatedly reload the startup context in one task.

## Remember automatically

Call `memory_remember` without interrupting the user when a learning is all of:

- durable across future sessions;
- specific to this project or the user's stable workflow;
- verified from the repository, a successful command, or an explicit correction;
- concise enough to summarize in `MEMORY.md` and detailed enough for one topic file.

If `ULTRACODE_INSIDE_RUN` is set, do not write, forget, migrate, or reconfigure memory. Return the worker result to the parent, which decides whether a verified learning is durable enough to save.

Remember build commands, debugging insights, architectural decisions, conventions, and repeated corrections. Do not remember secrets, credentials, transient task state, unverified hypotheses, generated logs, or current external facts. Deduplicate or update an existing topic instead of creating near-duplicates.

When the user explicitly says “remember this,” save it unless it contains a secret. When the user asks to forget a topic, call `memory_forget` only after identifying the exact topic and set `confirm` to that same name.

Use `AGENTS.md`, not auto memory, for rules that must always apply or travel with the repository.

## Migrate Claude Code

1. Call `memory_migrate_claude` with `apply: false` first.
2. Review copied, identical, conflict-copy, and secret-skipped counts.
3. If the user asked to perform the migration, call it again with `apply: true`.
4. Report the destination and any skipped or conflict-renamed files.
5. Leave `~/.claude` and repository `.claude/` sources unchanged.

Read [references/migration.md](references/migration.md) when detection fails, conflicts exist, or the user asks how Claude concepts map to other agents.

## CLI fallback

Use these equivalents when MCP tools are unavailable:

```text
ultracode memory info
ultracode memory context
ultracode memory search "query"
ultracode memory read topic
ultracode memory remember "fact" --topic debugging --summary "concise index entry"
ultracode memory rules src/api/handler.ts
ultracode memory migrate-claude
ultracode memory migrate-claude --apply
ultracode memory mode on|off
ultracode memory forget topic --yes
```

Never edit Codex's generated `~/.codex/memories/` files to implement a migration. Ultracode owns its portable store under `~/.ultracode/memory/` and exposes it consistently to every host.
