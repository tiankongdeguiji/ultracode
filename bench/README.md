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

## External suites

SWE-Marathon and FeatureBench keep their own pinned runners, task containers, and
official verifiers. They use a separate entry point so the SWE-bench Pro manifest,
selection, evaluation, and frozen-result semantics above remain unchanged:

```bash
npm run bench:external -- prep --suite swe-marathon
npm run bench:external -- run --suite swe-marathon --run-id marathon-a1 \
  --model <model> --effort <effort> --arm a \
  --task-id zstd-decoder --task-id wasm-simd
npm run bench:external -- report --suite swe-marathon --run-id marathon-a1

npm run bench:external -- prep --suite featurebench
npm run bench:external -- run --suite featurebench --run-id feature-b1 \
  --model <model> --effort <effort> --arm b \
  --task-id <featurebench-instance-id>
npm run bench:external -- report --suite featurebench --run-id feature-b1
```

`--run-id`, `--model`, `--effort`, `--arm`, and at least one repeatable
`--task-id` are mandatory, with no model or effort fallback. Suite,
auth-mechanism, source, platform, task, and toolchain preflight completes before
the driver atomically writes private
`results/external/<suite>/<runId>/external-run.json`. The suite namespace keeps
external manifests and generated reports disjoint from both legacy runs and the
other external suite. Repeating an exact manifest resumes native work and skips
only tasks whose receipt still identifies a currently valid exact native-verifier
score; changed inputs or provenance are rejected.

FeatureBench requires `FEATUREBENCH_CREDENTIAL_BROKER_URL` plus a dedicated
Docker-internal `FEATUREBENCH_RESTRICTED_NETWORK` with only the named, labeled
credential-broker container attached; reusable host ChatGPT credentials are
never mounted into task containers. SWE-Marathon selects exactly one runtime auth
mechanism, `CODEX_AUTH_JSON_PATH` or `OPENAI_API_KEY`; an auth-file path is
canonicalized before child use. The manifest freezes only that mechanism and the
effective Arm B workflow-wait seconds, never an API key, auth-file contents, or
auth-file path. Both native runners receive allowlisted environments rather than
the complete host environment.

Provenance includes deterministic Python-environment tree attestations that ignore
only interpreter-created `__pycache__/*.pyc` artifacts. FeatureBench additionally
attests the shared prompt source and exact `ARM_B_PREFIX` value, recording whether
the selected arm used the prefix or the verbatim upstream prompt.

`report` reads preserved Codex rollouts plus only the exact suite-native verifier
paths recorded in the host-owned receipt and writes private `report.json` and
`report.md` files. Each receipt entry binds the verifier file's SHA-256; lexical
escapes, symlinked path ancestors, out-of-root targets, and later content drift are
rejected. Reports distinguish requested
from observed effective effort, host from worker sessions, explicit compactions
from inferred prompt resets, and verified scores from missing results. A score is
never inferred from agent success or absence: without attributable native verifier
output it remains `unverified` with a JSON `null` value. See
[`docs/swe-marathon.md`](docs/swe-marathon.md) and
[`docs/featurebench.md`](docs/featurebench.md) for suite-specific constraints.

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
