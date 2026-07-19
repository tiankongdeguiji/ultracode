# ultracode Agent Guide

Canonical instructions for AI coding agents here. `CLAUDE.md` imports this file; keep shared guidance here.

## Environment

- npm + Node >= 20 (CI runs Node 22). One-time: `npm ci`. Pure ESM (`"type": "module"`); no build needed to develop — tests import `src/` directly, `npm run dev` runs the CLI via tsx, `npm run build` (tsc → gitignored `dist/`) is only for packaging / `npm link`.
- Linux and macOS only. Windows is unsupported by design (POSIX process groups); do not "fix" the win32 guard in `src/cli/main.ts`.

## Worktrees & Scratch

- Work in a new git worktree branched from `origin/main` (fetch first), not the primary checkout, and open the PR from that branch. A fresh worktree has no `node_modules` — run `npm ci` in it before testing.
- Use the gitignored `agent_space/` for scratch (scripts, notes, experiment output); never commit it or reference it from tracked files — explain inline instead. Do NOT scratch in `.ultracode/` (the engine's runtime run store). Before removing a worktree, copy anything worth keeping from its `agent_space/` into the main checkout's.

## Bench Harness

- `bench/` contains the SWE-bench Pro, SWE-Marathon, and FeatureBench A/B benchmarks (codex alone vs codex + ultracode); see `bench/README.md`. They share one public dispatcher: `npm run bench -- <command> [options] [--suite <suite>]`. Omitting `--suite` selects SWE-bench Pro, as does explicit `--suite swebench-pro`; its commands remain `fetch|prep|run|eval|report|status|clean`. The pinned SWE-Marathon and FeatureBench adapters require `--suite swe-marathon` or `--suite featurebench` and retain their independent `prep|run|report` lifecycles, native preparation, execution, verification, resume, and reporting semantics. Keep their artifacts independent: SWE-bench Pro uses `bench/results/<runId>/run.json`, while external suites use `bench/results/external/<suite>/<runId>/external-run.json`; do not change manifests or frozen results. The bench harness is outside the CI typecheck gate — `npm run bench:check` typechecks it, and its pure logic is covered by offline `test/unit/bench-*.test.ts` which run in `npm test`. `bench/.cache/` and `bench/results/` are gitignored artifacts — never commit them. Live bench runs spend real tokens and are manual-only.

## Generated Plugin Bundles

- `dist/` and the `dist-codex/`/`dist-qoder/` bundles are gitignored build outputs — never commit them. `npm run build:plugins` assembles bundles from canonical sources (`skill/`, `workflows/`, `hostpacks/<host>/`); `test/unit/dist.test.ts` rebuilds them before asserting, so they never go stale.
- Bump only via `npm version <patch|minor|major|x.y.z> --no-git-tag-version`: npm updates `package.json` + both `package-lock.json` version fields, and the `version` hook regenerates `src/version.ts`. `package.json` is the single source of truth; `dist.test.ts` guards every mirror (the `VERSION` constant, both lock fields, bundle manifests) against it. Never hand-edit a mirror; repair a hand-edited `package.json` with `npm version <that-version> --allow-same-version --no-git-tag-version` (the `--no-git-tag-version` is required — the hand-edit leaves the tree dirty, which npm's default clean-tree check would otherwise reject). For a tagged release, drop `--no-git-tag-version` and pass `-m 'chore: bump version to %s'`. The bump needs npm scripts enabled to run the hook — if your `.npmrc` sets `ignore-scripts=true`, add `--ignore-scripts=false` or the mirrors silently go stale (`dist.test.ts` still catches the drift in CI).

## Testing

- Vitest. Full: `npm test`; single file `npx vitest run test/unit/<x>.test.ts`; single case append `-t "name"`. Keep the suite offline and deterministic (no network / real backends, 20s timeout): drive behavior through the mock backend (`src/backends/mock.ts`; `MOCK:ok|echo|fail|fail-then-ok|delay|tools|badjson`) and assert on run output and `executor.stats`.
- Backend parsers test against golden NDJSON fixtures in `test/fixtures/<backend>/` (provenance in the READMEs); when a pinned CLI bumps (`SUPPORTED_VERSIONS.md`), re-record live fixtures via `record.sh` (codex only) and verify synthetics against a live capture. Token-spending tests go in `test/live/` (self-skip unless `UC_LIVE_TESTS=1`; excluded from the default suite).
- Tests live flat in `test/unit/` as `<area>.test.ts` (`.integration.test.ts` for spawn-heavy); isolate via `mkdtempSync(join(tmpdir(), 'uc-...'))` with small local helpers (no shared helper module). Point any `ultracode install` / `sync` exercise at a temp dir — never the repo root.

## CI Gate

- Before pushing, pass the gate locally: `npm run typecheck && npm run lint && npm test` (CI runs exactly this on ubuntu + macos). `typecheck` covers `src/` only — `test/` is not typechecked, so verify test-side types by hand.
- No formatter — match style by hand: single quotes, semicolons, trailing commas, 2-space indent, numeric separators (`20_000`), `_`-prefix intentionally-unused args (ESLint enforces).

## Commits & PRs

- Conventional Commits, scoped, lowercase imperative: `feat(engine): ...`, `fix(exec): ...`, `docs: ...`, `chore: ...`, `ci: ...`. The `(#123)` suffix is added by squash merge — don't add it. A `fix` body explains root cause + fix; a change adding tests ends with a `Tests (+N):` line enumerating them.
- PR titles and bodies must be written in English.
- PR body: clear, with a Test Plan; when several paths were possible, call out and justify the one taken.

## Coding Style

- Strict ESM / NodeNext: relative imports carry `.js` (even in `.ts`); Node builtins use the `node:` prefix; `import type` for type-only imports.
- Naming: camelCase vars/functions, PascalCase types/classes, SCREAMING_SNAKE module constants; filenames lowercase, hyphenated when multiword (`safe-write.ts`).
- Doc comments are JSDoc prose (no `@param`/`@returns`): non-trivial modules open with a `/** */` header stating role + contract (small single-purpose files may put it on the first export); exported symbols get a behavior-and-rationale line; interface fields get inline `/** */` notes for units, invariants, provenance.
- Code comments must be written in English.
- Inline `//` comments are minimized: code should be self-explanatory; comment only non-obvious "why" context, one short line. No commented-out code, no change-history or tombstone comments. Use `// TODO(username): ...` and `// NOTE: ...`; do not introduce `FIXME`/`XXX`/`HACK`.
- No `console.*` in `src/`: CLI writes to `process.stdout`/`stderr`, the engine emits typed `RunEvent`s via `onEvent`, workflow scripts use the injected `log()`.
- Errors: extend the `UltracodeError` taxonomy in `src/engine/errors.ts` and use its `errorMessage()` helper (vm-context errors fail `instanceof Error`). For worker-writable paths use the symlink-safe helpers in `src/exec/safe-write.ts`, never plain `writeFileSync`.
- Assume the reader knows Node and TypeScript; match existing patterns; when uncertain, choose the simpler, more concise implementation.
