# Script portability across engines

One script text should run on Claude Code native, Qoder native, and the ultracode engine. The dialect is the portability layer; these rules keep you inside the shared subset.

## The portable subset

1. **Pure-literal `meta`** as the first statement; `name` matching `[a-zA-Z0-9._:-]+` with a `uc-` prefix (avoids colliding with hosts' built-in workflows — never `deep-research`).
2. **No entropy**: no `Date.now()` / `Math.random()` / no-arg `new Date()` (they throw everywhere); timestamps and seeds come in via `args`.
3. **Schemas in the codex strict subset**: root `type:"object"`; no `oneOf`/`allOf`/`not`/`if`/`patternProperties`; no map-style `additionalProperties`; `anyOf` is fine. This is the safe intersection — a schema that satisfies codex strict validates everywhere.
4. **Budget via args shim** for Qoder native (its `budget` global is stubbed):
   ```js
   const budgetTokens = (budget && budget.total) ?? (args && args.budgetTokens) ?? null
   ```
5. **No per-call `effort` or `contextWindow`** (ultracode-engine-only): route effort via `agentType` definitions where the host supports them, or `model`; there is no portable native equivalent for `contextWindow`.
6. **No `backend:` option** in scripts meant for Claude Code / Qoder native (ultracode-engine-only concept). Use it only in engine-targeted scripts.
7. **Self-contained prompts** (rule #1 of authoring): subagents share no context with you or each other. Inline the facts; never write "as discussed above".
8. **Don't branch on completion order**; resume replay reproduces dispatch order, not completion order.

## Where scripts live

| engine | project scope | user scope |
|---|---|---|
| ultracode engine | `.ultracode/workflows/` | — |
| Claude Code | `.claude/workflows/` | `~/.claude/workflows/` |
| Qoder native | `.qoder/workflows/` | `~/.qoder/workflows/` |

`ultracode sync` maintains stamped copies from the canonical `.ultracode/workflows/` into the host dirs (`--check` for drift, `--adopt` to reclaim a hand-edited copy). Don't hand-edit the copies.

## Run-store hygiene

The ultracode engine keeps its state in `.ultracode/` — deliberately OUTSIDE `.qoder/sessions/**` and `.claude/**`. Never write into another engine's session directories.
