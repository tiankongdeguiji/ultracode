# bench/ — SWE-bench Pro A/B harness: codex alone vs codex + ultracode

Does multi-agent orchestration help on long-horizon software-engineering tasks that
strain a single context window? This harness runs [SWE-bench Pro](https://github.com/scaleapi/SWE-bench_Pro-os)
(public set, 731 tasks, 11 repos, python/js/go) two ways per instance and compares:

- **arm A** — stock `codex exec` on the task prompt
- **arm B** — the same prompt prefixed with the `ultracode` keyword, with the ultracode
  MCP server + skill installed, so the codex host session orchestrates parallel codex
  workers through a workflow

Scoring uses the **official** eval harness (pinned commit, local-Docker mode): an
instance is resolved iff every `fail_to_pass` and `pass_to_pass` test passes. Alongside
resolved rate the harness records a per-session token 4-tuple (input/cached/output/reasoning),
wall-clock, and **context pressure** — compaction events and the context high-water mark
vs the model's window — which is the instrument for the "exceeds one context" thesis.

## Prerequisites

- Linux with Docker (tested 26.x), ~5 GB disk per instance (base image + overlay), plenty of RAM
- `codex` CLI on PATH (the static binary is copied into the containers; pinned + hashed in the toolchain manifest)
- Node >= 20 (`npm ci` at the repo root), `python3` + venv, `git`, `xz`
- codex auth: either `~/.codex/auth.json` (default `auth.mode: "chatgpt"`) or `CODEX_API_KEY`
  (`auth.mode: "api-key"`). API-key mode is the parallel-safe choice; a ChatGPT-plan login
  works but concurrent token refresh across parallel containers can race, and plan rate
  limits will throttle a batch — smoke one instance first.

## Quickstart

```bash
npm run bench -- fetch                      # cache the 731-row dataset from HuggingFace
npm run bench -- prep                       # node + codex + ultracode toolchain, eval harness clone + venv
cp bench/bench.example.config.json bench/bench.config.json   # then set "model"

# smoke the official eval pipeline first — zero agent tokens, expect ~100% resolved:
npm run bench -- run --run-id pilot1 --count 20 --seed 7 --model <model>   # agent sessions (the expensive part)
npm run bench -- eval --run-id pilot1 --gold
npm run bench -- eval --run-id pilot1       # score both arms' patches
npm run bench -- report --run-id pilot1     # report.md + report.json
npm run bench -- status --run-id pilot1     # progress / taxonomy at any time
```

`run` is resumable: `--resume` skips finished instance×arms; `--redo id1,id2` forces
re-runs; the instance selection and config are frozen in `results/<runId>/run.json` at
first launch, so a resumed run never re-samples.

## How a session runs

Per instance×arm the driver builds a COPY-only overlay image over the instance's
`jefzda/sweap-images` base, bind-mounts `results/<runId>/instances/<iid>/<arm>` at
`/bench`, and starts `bench/entrypoint.sh`, which:

1. audits + sanitizes git history (the images ship full history — `origin/master`
   reaches the gold fix; remotes/foreign branches/tags/reflog are stripped, audit saved)
2. commits a **pre-session snapshot** (images carry untracked runtime state — redis AOFs,
   caches — which must not leak into the patch)
3. seeds an isolated `CODEX_HOME` from the arm template (arm B additionally gets the
   skill, the arming AGENTS.md, and an `[mcp_servers.ultracode.env]` table — codex spawns
   MCP servers with a sanitized env, so `ULTRACODE_HOME`/`CODEX_HOME` must ride the config)
4. runs `codex exec` under `timeout` with `--dangerously-bypass-approvals-and-sandbox`
   (the container is the sandbox; codex's Landlock sandbox is unavailable in Docker on
   older kernels) — same flags for both arms
5. arm B: waits for detached ultracode runs to reach a terminal state after the host
   session exits (they outlive it by design), stopping stragglers at the deadline
6. captures the patch: `git add -A`, un-stages pre-dirty paths, diffs against the
   snapshot, strips binary hunks (mirroring the official harness), and records a
   `git apply --check` verdict against the pristine base tree

Tokens for **both** arms come from one collector reading every codex rollout file under
the session's `CODEX_HOME` (arm B: host + all workers), taking the last cumulative
`token_count` per session — never mixed with engine-side numbers. The ultracode run
store (`/bench/uc`) is kept as the arm-B cross-check (engine totals, agent counts,
kept-worktree detection).

## Config

See `bench.example.config.json`. Notable knobs: `model` and `effort` (both required,
with no silent defaults), `auth.mode`, `arms` (a|b|both), `timeouts.sessionSecs` (default 43200 = 12 h
per instance×arm; an explicit bench cap — the ultracode engine itself stays uncapped),
`parallel.instances` (default 4), `instances.{ids,count,seed,stratifyBy}`,
`sanitizeGitHistory`, optional `pricing` ($/M-token per model → USD column in the report).

## Failure taxonomy

Recorded per instance×arm in `status.json`, aggregated in the report: `empty-patch`,
`unapplyable-diff`, `timeout`, `agent-crash`, `patch-too-large`, `toolchain-incompatible`,
`no-app-dir`, `image-failed`, `eval-fail`, `harness-error` (infra kinds drop the pair
from the primary comparison; agent-avoidable kinds count as losses). Arm-B degeneracies
are annotations, not failures: `no-orchestration` (keyword never armed / host soloed),
`mock-backend`, `monitor-abandoned`, `unmerged-workspace`, `cwd-mismatch`.

## Disclosed limitations

- **No egress restriction**: sessions need API access, so full network is open. Mitigations:
  `web_search` disabled in both arms, git history sanitized (audit file kept per instance),
  and transcripts are archived for cheat auditing. Both arms share the condition.
- **Arm A's environment differs by more than the keyword**: it has no MCP tools or skill
  in context at all (by design — it is the stock-codex control).
- **Arm B is structurally more tokens.** The headline is resolved rate reported next to
  cost; a cost-matched control (best-of-k with a non-oracle judge) is future work.
- Binary-file solutions are stripped from patches — same behavior as the official harness.
- At N=20 the paired McNemar test only detects very large effects; the pilot validates
  plumbing and direction, not significance (the report prints this disclaimer itself).

## Troubleshooting

- `docker pull` rate limits: pulls retry with backoff; pre-pull with `docker login` if
  anonymous limits bite. Eval falls back to the locally-present image.
- Linux images may use glibc or musl. `prep` ships both pinned Node builds and the
  matching musl C++ runtime (from `node:<nodeVersion>-alpine3.20`); `node-sel`
  chooses at container start. Truly incompatible images self-report as
  `toolchain-incompatible`.
- Auth expiry mid-batch (chatgpt mode): re-login on the host, then `run --resume`.
- A wedged eval container: the watchdog stops eval containers older than
  `timeouts.evalWatchdogSecs`; the harness records the instance unresolved.
- Everything a session produced lives under `results/<runId>/instances/<iid>/<arm>/`
  (prompt, host JSONL, rollouts, ultracode run store, patch, logs, metrics) — nothing
  of value is inside the container when it dies.
