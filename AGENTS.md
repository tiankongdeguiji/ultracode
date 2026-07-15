# ultracode Agent Guide

Canonical instructions for AI coding agents in this repository. `CLAUDE.md` imports this file; keep shared agent guidance here.

## Environment

- npm + Node >= 20 (CI runs Node 22). One-time setup: `npm ci`. The package is ESM throughout (`"type": "module"`).
- No build step is needed to develop: tests import `src/` directly and `npm run dev` runs the CLI from source via tsx. `npm run build` (tsc into the gitignored `dist/`) is only for packaging or `npm link`.
- Linux and macOS only. Windows is unsupported by design (POSIX process-group semantics); do not "fix" the win32 guard in `src/cli/main.ts`.

## Scratch Space

Use the gitignored `agent_space/` directory at the repo root for scratch scripts, throwaway configs, experiment outputs, and working notes. Never commit files from it, and never reference its contents from tracked files (it exists only in the local checkout) — where context is needed, explain it inline instead. Do NOT use `.ultracode/` as scratch — that is the engine's own run store, written at runtime.

## Generated Plugin Bundles

- `dist/` (tsc output) and the copied bundle subtrees (`dist-codex/skills/`, `dist-qoder/{skills,workflows,agents}/`) are gitignored build outputs. Regenerate the bundles from the canonical `skill/`, `workflows/`, and `hostpacks/qoder/agents/` with `npm run build:plugins`; `test/unit/dist.test.ts` rebuilds them itself before asserting, so they can never go stale in CI. Only the hand-maintained plugin manifests and READMEs under `dist-codex/`/`dist-qoder/` are committed — never commit generated copies.
- A version bump must update `package.json`, `src/version.ts`, and the hand-maintained bundle manifests `dist-codex/.codex-plugin/plugin.json` and `dist-qoder/.qoder-plugin/plugin.json` — `build:plugins` does not regenerate the manifests, and no test enforces they match.

## Testing

- Framework: Vitest. Full suite: `npm test`. Single file: `npx vitest run test/unit/dialect.test.ts`; single case: append `-t "name substring"`.
- The default suite is offline and deterministic — no network, no real backend CLIs, 20s per-test timeout; keep it that way. Drive engine behavior through the mock backend (`src/backends/mock.ts`; `MOCK:ok|echo|fail|fail-then-ok|delay|badjson` prompt directives) and assert on run output and `executor.stats`.
- Backend parsers are tested against golden NDJSON fixtures under `test/fixtures/<backend>/`; `test/fixtures/README.md` (plus per-backend READMEs where present) documents each file's provenance (live capture vs synthetic). When a pinned CLI version bumps (`SUPPORTED_VERSIONS.md`), re-record live fixtures via the backend's `record.sh` where one exists (only codex today), and verify synthetic fixtures against a live capture before trusting a new parser path.
- Token-spending live tests belong in `test/live/` (none exist yet; vitest.config.ts excludes the directory from the default suite unconditionally). By convention they self-skip unless `UC_LIVE_TESTS=1` and are run explicitly with `npx vitest run test/live`.
- When manually exercising `ultracode install` / `ultracode sync` (e.g. via `npm run dev -- install`), always point them at a temp directory — project-scoped installs write `AGENTS.md`, `.agents/`, `.qoder/`, and `.claude/workflows/` into the target project, and none of those are gitignored here. Never run them against the repo root.
- Tests live flat in `test/unit/` as `<area>.test.ts` (`.integration.test.ts` suffix for spawn-heavy suites). Isolate through `mkdtempSync(join(tmpdir(), 'uc-...'))`; define small local helpers per file — there is deliberately no shared test-helper module.

## Linting and Type Checking

- Before pushing, make the CI gate pass locally: `npm run typecheck && npm run lint && npm test` (CI runs exactly this on ubuntu + macos).
- There is no formatter; match the existing style by hand: single quotes, semicolons, trailing commas, 2-space indent, numeric separators (`20_000`). Prefix intentionally-unused args with `_` (ESLint enforces).
- `npm run typecheck` covers `src/` only — nothing typechecks `test/` (vitest transpiles without checking, and eslint here is not type-aware), so test-side type mistakes surface only as runtime failures; double-check types in test code by hand.

## Commits and Pull Requests

- Commit subject: Conventional Commits with a scope, lowercase imperative — `feat(engine): ...`, `fix(exec): ...`, `docs: ...`, `chore: ...`, `ci: ...`. The `(#123)` suffix is added by squash merge; do not add it yourself.
- A `fix` commit body must explain the root cause and how the fix works. When a change adds tests, end the body with a `Tests (+N):` line enumerating them.
- The PR body should be clear and informative, with a Test Plan section that describes how you tested the change. If there were multiple potential paths you could have taken, call them out succinctly and justify the one you took.

## Coding Style

- Strict ESM under NodeNext: relative imports always carry the `.js` extension (even in `.ts` files); Node builtins always use the `node:` prefix; use `import type` for type-only imports.
- Naming: camelCase functions/variables, PascalCase classes/types, SCREAMING_SNAKE module constants; filenames lowercase, hyphenated when multiword (`safe-write.ts`, `codex-auth.ts`).
- Doc comments are JSDoc prose without `@param`/`@returns` tags: non-trivial modules open with a `/** */` header stating their role and contract (small single-purpose files may carry the JSDoc on the first export instead — don't retrofit headers into files you aren't otherwise changing); exported symbols get a short behavior-and-rationale line; interface fields get inline `/** */` notes for units, invariants, and provenance. Inline `//` comments are "why"-focused and may cite upstream issues or research notes; densest where security rationale lives.
- No `console.*` in `src/`: CLI code writes to `process.stdout`/`process.stderr`, the engine reports through typed `RunEvent`s via `onEvent`, and workflow scripts use the injected `log()`.
- Errors: extend the `UltracodeError` taxonomy in `src/engine/errors.ts`; use its `errorMessage()` helper for message extraction (vm-context errors fail `instanceof Error`).
- For worker-writable paths, use the symlink-safe write helpers in `src/exec/safe-write.ts`, never plain `writeFileSync`.
- Assume the reader knows Node and TypeScript. Match existing patterns; if uncertain, choose the simpler, more concise implementation.
