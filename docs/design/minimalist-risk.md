# Ultracode-Portable — Minimalist v1 Design & Risk Architecture

> **Design history (predates the keyword-only narrowing in PR #10, 2026-07-17).** Passages below —
> e.g. the `.qoder/rules/ultracode.md` sketch describing `trigger: model_decision` arming on "the
> user says 'ultracode' or the task is parallelizable across >3 independent units" — reflect an
> earlier design. The shipped doctrine now arms ultracode mode ONLY on the literal keyword
> "ultracode" written as the user's own request (no task-shape auto-arm; budgets are opt-in, uncapped
> default). Read those arming descriptions as historical.

## 0. The one-sentence answer to "plugin? command? skill?"

**v1 is a standalone CLI engine (`ultracode`) delivered to hosts as an Agent Skill, plus a zero-engine native pack for Qoder.** Concretely:

- **Codex**: `.agents/skills/ultracode/SKILL.md` (default-on, repo- and user-scoped, the primary reusable surface per OpenAI's own deprecation of custom prompts) teaches Codex to author a workflow script and run `ultracode run <file>` via its shell tool. The engine is a plain Node CLI. **No MCP server in v1** (see §2 cut list).
- **Qoder**: **no engine at all.** Qoder natively ships the identical Workflow tool. v1 ships `.qoder/workflows/*.js` files (shared dialect), a `.qoder/skills/ultracode/SKILL.md` + `.qoder/rules/ultracode.md` carrying the auto-orchestration doctrine that Qoder lacks, and a gate-probe note. The external engine as Qoder fallback is v2.
- **v2 packaging**: Codex *plugin* (`codex plugin add`) bundling the skill + an MCP start/status/result triad; Qoder *plugin* (`.qoder-plugin/plugin.json`) bundling workflows+skills+rules. A "command" alone is the wrong surface everywhere: Codex custom prompts are deprecated; Qoder commands can't carry doctrine or scripts.

Rationale: the skill path is the only surface that is (a) cross-host de facto standard (`.agents/skills/` read by Codex, Gemini, Cursor, Amp, Crush, opencode, Windsurf), (b) carries the *doctrine* (which is most of ultracode's value, see §6), and (c) requires zero host-integration code to demo.

## 1. Strict v1 scope (what the first demo needs, nothing else)

**Definition of the first demo**: user types "ultracode: review this repo for auth bugs" into Codex; Codex writes `review.workflow.js`; user reviews it; Codex runs `ultracode run review.workflow.js`; 5 codex-exec subagents fan out (discover → per-file review pipeline → adversarial verifier → synthesis); a typed, validated findings report lands in `output.json` and on stdout. Same script file, dropped into `.qoder/workflows/`, runs natively under qodercli. That is parity.

### v1 KEEPS (each justified against the demo)
| Feature | Why v1 |
|---|---|
| Dialect: `export const meta {name,description,phases}` pure-literal (acorn-validated), top-level await/return | It IS the product; source-compatibility with Qoder/Claude is the parity claim |
| `agent(prompt,{label,phase,schema,model,cwd})`, `parallel` (allSettled→null), `pipeline` (no barrier, `stage(prev,item,i)`, throw/null drops item), `phase()`, `log()`, `args`, `console` | Demo uses all of these |
| Determinism bans (Date.now/Math.random/no-arg Date throw), frozen intrinsics, delete WebAssembly/ShadowRealm | ~60 lines, exact-message fidelity, and scripts stay v2-resume-ready from day one |
| Semaphore `min(16,max(2,cpus-2))`, lifetime agent cap, 4096 items/call | Trivial; also a safety cap |
| `schema` → backend-native structured output + **local ajv validation against the original schema always** + 1 repair-resume retry | Typed results are the core differentiator vs "just run 5 tmux panes" |
| Journal.jsonl **write path only** (hash-chain keys computed and recorded) | Cheap, gives debuggability, and makes v2 resume a pure read-path addition |
| `budget` global wired: `{total, spent(), remaining()}` from accumulated `turn.completed.usage`; agent() throws on exhaustion | Not fidelity — a cost kill-switch (risk d). Qoder's own budget is a stub, so we exceed native parity here for ~80 lines |
| Backends: **mock** + **codex** only | Mock = the test substrate; codex = the only host with no native engine |
| `ultracode doctor` preflight | Risk mitigations a/b live here |
| Skill + doctrine files for both hosts | See §6 — this is where the "ultracode-ness" actually lives |

### v1 CUTS (deferred, with the argument)
| Cut | Why the demo doesn't need it | Lands in |
|---|---|---|
| **Resume / prefix-replay cache** | Demo is a 5–15 min run; a failed run is cheaply re-run. Journal is already written, so resume is additive. Danger of building it now: it doubles engine test surface before one live agent has ever run | v2 (read path over existing journal; `--resume <runId>`) |
| **MCP server (start/status/result triad)** | Blocking foreground CLI is fine for ≤15 min; Codex's own shell + `unified_exec` background terminals cover longer runs. The triad drags in run persistence, long-poll plumbing, orphan supervision across host restarts — the single largest complexity item in the whole project. CLI-first also sidesteps every MCP timeout finding (no host extends deadlines on progress; Codex orphans work on timeout) | v2 |
| **Fire-and-forget + completion notification** | Same as above; v1 is synchronous with live progress on stderr | v2 (with MCP triad) |
| **Nested `workflow()`** | No demo scenario needs it; throws `"workflow(): not supported in v1"` | v2 |
| **`isolation:'worktree'`** | Demo is read-only review (codex `--sandbox read-only`). Parallel *mutation* is genuinely dangerous and deserves its own design pass | v2 (git worktree per agent, `worktree remove` on cleanup) |
| **qodercli backend adapter** | Qoder path is native in v1. The adapter exists only as a fallback for gate-off accounts and to triangulate the Backend abstraction | v1.5/v2 |
| **Other hosts (Gemini/Cursor/Copilot/Amp/opencode)** | Their NDJSON streams are near-isomorphic — the Backend interface (§3) is designed for them, but each adapter is real work (auth, flags, quirks). Two hosts prove portability; eight prove nothing extra | v3, demand-driven |
| **`agentType`/`effort` per call** | Codex has no session-inherited subagent registry to reference; map `effort` → `-c model_reasoning_effort=` later. v1 accepts and warns-ignores unknown options rather than erroring (scripts stay portable) | v2 |
| **Windows** | Dev box is Linux; process-group kill semantics differ fundamentally. Declare unsupported loudly | v3 |
| **quickjs/SES sandbox** | Trust model is Qoder's own: model-authored + user review-before-run. node:vm hardened identically to Qoder is honest parity. Upgrade only if third-party workflow *sharing* emerges (untrusted authors) | v3 |
| **1000-agent default cap** | v1 default `--max-agents 50` (override to 1000 with a flag). No-silent-caps: hitting it prints `CAP REACHED: 50 agents (raise with --max-agents)` and appears in failures[] | policy, not code |

## 2. Architecture & module layout

```
ultracode/
├── package.json               # ESM, node>=20; deps: acorn, ajv (+ ajv-formats), nothing else heavy
├── bin/ultracode.js
├── src/
│   ├── cli.js                 # subcommands: run | parse | doctor | version
│   ├── engine/
│   │   ├── load.js            # parseWorkflow(src) -> {meta, bodyStart}; acorn ecmaVersion latest,
│   │   │                      #   sourceType module, allowAwaitOutsideFunction/ReturnOutsideFunction;
│   │   │                      #   meta must be pure literal; name/description required
│   │   ├── sandbox.js         # makeContext({hostFns}) -> vm context; bootstrap freezes 28 intrinsics,
│   │   │                      #   bans Date.now/new Date()/Date()/Math.random (exact Qoder messages),
│   │   │                      #   deletes WebAssembly/ShadowRealm; body wrapped (async()=>{...})();
│   │   │                      #   runInContext({timeout:30000}) for sync phase
│   │   ├── run.js             # runWorkflow({source, args, backend, limits, runDir, signal})
│   │   │                      #   -> {result, logs, failures, agentCount, totalTokens, durationMs, error?}
│   │   ├── helpers.js         # agent/parallel/pipeline/phase/log impls; semaphore over agent();
│   │   │                      #   parallel = allSettled, throw->null + failures[]; pipeline per spec
│   │   ├── journal.js         # append({type,...}); key_n = "v2:"+sha256(key_{n-1}+"\0"+prompt+"\0"+
│   │   │                      #   stableStringify({agentType,isolation,model,schema}))  (write-only in v1)
│   │   └── schema.js          # normalizeForCodex(schema) -> {ok, schema}|{ok:false, reason};
│   │                          #   validateOutput(original, value) via ajv
│   ├── backends/
│   │   ├── types.d.ts         # Backend = { name, capabilities(): {nativeSchema, resume, maxConcurrency?},
│   │   │                      #   preflight(): Diag[],
│   │   │                      #   runAgent(req: {prompt, schema?, model?, cwd?, label, signal, timeoutMs})
│   │   │                      #     -> Promise<{ok, text?, structured?, usage:{in,out}, sessionRef?,
│   │   │                      #                 failure?: {kind:'permanent'|'transient'|'auth'|'cap', msg}}> }
│   │   ├── mock.js            # deterministic: reads tests/fixtures/mock-plan.json or hashes prompt;
│   │   │                      #   can inject throw/null/delay/badjson per-call for fault tests
│   │   └── codex.js           # spawn: codex exec --json --skip-git-repo-check --sandbox <mode>
│   │                          #   -a never [--model m] [--output-schema f -o out] "<prompt>", execFile
│   │                          #   (never shell), CODEX_API_KEY passthrough; parse JSONL: thread.started
│   │                          #   ->sessionRef, accumulate turn.completed.usage, result = LAST
│   │                          #   item.completed agent_message (bug #19816); failure classification:
│   │                          #   turn.failed authoritative, bare "error" events ignored (reconnects);
│   │                          #   grep invalid_json_schema -> permanent; exit1-no-turn.failed -> transient;
│   │                          #   delete stale -o file before each run; repair: codex exec resume
│   │                          #   <sessionRef> --output-schema ... (once)
│   ├── safety/
│   │   ├── procgroup.js       # spawn detached w/ setsid; pids.json in runDir; killGroup(SIGTERM->SIGKILL);
│   │   │                      #   process.on(SIGINT/SIGTERM/exit) -> kill all groups
│   │   └── limits.js          # budget tokens, maxAgents, wallClockMs, perAgentTimeoutMs (default 20 min)
│   └── doctor.js              # see §4 risk mitigations
├── skills/ultracode/          # installable to .agents/skills/ and ~/.agents/skills/
│   ├── SKILL.md               # name: ultracode; description tuned for keyword + implicit trigger
│   └── references/
│       ├── dialect.md         # full script API, worked examples, self-contained-prompt rules
│       └── patterns.md        # the doctrine: adversarial verify, perspective-diverse verify, judge
│                              #   panel, loop-until-dry, completeness critic, no-silent-caps, budget use
├── qoder-pack/                # `ultracode install --qoder` copies into a repo:
│   ├── workflows/review.js …  # -> .qoder/workflows/  (names never 'deep-research'; nothing named Workflow)
│   ├── skills/ultracode/      # -> .qoder/skills/     (doctrine + "invoke the native Workflow tool" guidance)
│   └── rules/ultracode.md     # -> .qoder/rules/ trigger: model_decision — the auto-orchestration mode
│                              #   Qoder natively lacks ("when the user says 'ultracode' or the task is
│                              #   parallelizable across >3 independent units, use the Workflow tool…")
├── examples/
│   ├── hello.workflow.js
│   ├── review.workflow.js     # the 5-agent demo (runs on BOTH engines unmodified)
│   └── sample-repo/           # tiny express app with 2 planted auth bugs
└── tests/
    ├── engine/*.test.js       # vitest; all against mock backend
    ├── backends/codex-parse.test.js   # golden JSONL fixtures
    ├── fixtures/*.jsonl + record.sh   # re-record against live CLIs on version bump
    └── live/smoke.test.js     # gated by UC_LIVE_TESTS=1
```

**CLI surface (frozen for v1):**
```
ultracode run <file> [--args '<json>'] [--backend codex|mock] [--model <m>]
              [--sandbox read-only|workspace-write] [--budget 500k] [--max-agents 50]
              [--concurrency N] [--per-agent-timeout 20m] [--wall-clock 60m]
              [--dry-run] [--yes] [--run-dir .ultracode/runs]
ultracode parse <file>          # meta + static agent-call inventory, no execution
ultracode doctor [--live]       # env/auth/version preflight; --live burns ~1 cent on probes
ultracode install --qoder|--codex [--user]   # copies skill/pack files, never overwrites silently
```
`--dry-run` runs the script on the mock backend and prints the agent plan (labels, phases, prompt heads, schemas) — the review-before-run artifact and the zero-token test mode in one flag.

**On-disk run layout** (deliberately outside `.qoder/sessions/` and `~/.codex/`):
`.ultracode/runs/<uc_runId>/{manifest.json, journal.jsonl, output.json, pids.json, agents/<n>-<label>.jsonl, agents/<n>-schema.json}`. `output.json` shape matches Qoder's (`result, logs, failures, agentCount, totalTokens, totalToolCalls, durationMs, error?`) so tooling can treat native-Qoder and external runs uniformly.

**Data flow (one agent call):** script `agent()` → semaphore acquire → journal `attempt_started` (hash-chain key) → budget check → backend.runAgent (execFile in own process group, JSONL streamed to `agents/<n>.jsonl`, per-agent timeout kills group) → schema: ajv-validate `structured` against ORIGINAL schema (regardless of backend claims) → on fail, one repair-resume → journal `result`/`error` → return validated object | text | throw (retries exhausted; recorded in failures[]).

## 3. Risk register & mitigations (the core of this document)

**(a) Undocumented-flag drift** (`qodercli --json-schema`, hidden MCP `timeout` key, `codex --json` event names).
- *Pin*: `SUPPORTED_VERSIONS.md` + a `knownGood` map in each adapter (`codex: >=0.142 <0.150 tested`, `qodercli: 1.0.33–1.0.37 tested`). `doctor` runs `codex --version` / `qodercli --version` and prints tested/untested status; untested = warn, not block.
- *Probe, don't assume*: `doctor --live` runs one 1-cent probe per backend (trivial prompt + trivial schema on the cheapest model) and caches `{cliVersion, nativeSchemaWorks: bool}` in `~/.ultracode/capabilities.json` keyed by version. Adapter consults cache.
- *Degrade*: every native-schema path has a prompt-injection fallback ("reply ONLY with JSON matching this schema") + local ajv validation + repair retry. Since we ALWAYS validate locally, flag drift downgrades quality (more retries), never correctness. This is the single most important design rule in the project.
- *Don't touch the hidden Qoder MCP timeout key at all in v1* (no MCP server → no exposure).

**(b) Auth misconfiguration** (ChatGPT OAuth fan-out mutually-invalidates single-use refresh tokens; Qoder `/login` beats env PAT).
- `doctor` hard checks, run automatically at the start of every `run`:
  - Codex: if `CODEX_API_KEY`/`CODEX_ACCESS_TOKEN` unset AND `$CODEX_HOME/auth.json` holds ChatGPT OAuth tokens → **refuse fan-out**: cap concurrency to 1 and print the exact failure mode ("OAuth refresh-token races; see issues #10332/#26303; set CODEX_API_KEY"). `--force-oauth-fanout` overrides with concurrency ≤3 and a pre-warm (one serial agent completes before the fleet spawns, so no worker starts inside the 5-min refresh window).
  - Never write or copy auth.json. Never set per-worker CODEX_HOME for auth reasons (shared home + env key is the verified-safe topology).
  - Qoder (v2 adapter): warn if env PAT is set but an interactive `/login` credential exists (probe: run `qodercli status`-equivalent with env stripped; if still authed, the trap is live).

**(c) Orphaned workers / client death mid-run.**
- v1's foreground-CLI choice makes this tractable: every backend process spawns via `setsid` into its own process group; `pids.json` (pgid + start-time to detect PID reuse) written before spawn; SIGINT/SIGTERM/uncaughtException handlers kill all groups (SIGTERM, 5 s, SIGKILL). Per-agent wall-clock timeout (default 20 min) kills the group — the stallMs analog.
- SIGKILL of the orchestrator itself leaves orphans: next `ultracode run`/`doctor` scans `.ultracode/runs/*/pids.json`, checks liveness+start-time, offers `--reap`.
- The nasty variant of this risk — MCP host timing out and Codex silently dropping the call while our server keeps spending money — is *deferred along with the MCP server*. When v2 adds the triad, runs get a heartbeat lease: no `workflow_status` poll for 10 min → auto-pause (kill workers, journal intact, resumable).

**(d) Runaway cost.**
- Layered hard caps, all on by default: `--max-agents 50`, `--budget` (token target; agent() throws "Workflow budget exceeded" at ≤0), `--wall-clock 60m`, `--per-agent-timeout 20m`, concurrency semaphore. `+500k`-style directives in the user's prompt are translated by the SKILL into `--budget 500k` (doctrine text tells the model to do this).
- **No silent caps**: every cap trip goes to failures[] and the final report ("stopped: budget 500k exhausted after 412k spent, 3 pipeline items unprocessed").
- `--dry-run` = free rehearsal; skill doctrine instructs the model to dry-run before any workflow expected to exceed 10 agents.
- Live cost line on stderr every agent completion: `[7/23 agents] 148k tokens (~$0.41)`.
- Kill switch = Ctrl-C (clean group kill, journal preserved, partial output.json written with `error:'stopped'`).

**(e) Sandbox escape blast radius — honest accounting.**
- What the script can do *inside the box*: nothing (no fs/net/process/require; frozen intrinsics; wrapped timers). What an *escape* yields: arbitrary code in the unsandboxed orchestrator process on the user's machine. node:vm is explicitly not a security boundary — but this matches Qoder's shipped trust model exactly: scripts are model-authored in-session and user-reviewed before run. We enforce the review: `run` prints meta + the `parse` agent-inventory and requires confirmation unless `--yes` (the skill tells the model to show the script to the user first).
- The larger *real* blast radius is legitimate: subagents run codex with `--sandbox workspace-write -a never` and can edit files by design. Default is `--sandbox read-only`; `workspace-write` must be explicit per run. The engine never passes `--yolo`/`danger-full-access`; if a user wants that inside a container, they set it via `-c` passthrough and own it.
- Backend spawn is `execFile` with argv arrays only — no shell, no interpolation; the only binaries ever spawned are the configured backend CLIs (allowlist of two).
- Documented threat-model paragraph in README; quickjs-emscripten migration is the v3 answer if workflow *distribution* (untrusted authors) ever becomes a feature.

**(f) Schema-strictness mismatch** (Codex = OpenAI strict subset enforced server-side w/ deterministic 400; Qoder = Claude-lineage permissive; future backends = who knows).
- `schema.js` is a *downgrade + verify* layer, never a silent transformer:
  1. `normalizeForCodex(s)`: checks root `type:'object'`; injects `additionalProperties:false` where absent; moves optional properties to `required` + union-`null` type **only when semantically lossless**; rejects unsupported keywords (`patternProperties`, remote `$ref`, `format` beyond the supported set) with a **fail-fast parse-time error naming the offending path** — before any tokens burn (a 400 costs a whole agent attempt otherwise, and it recurs deterministically on every retry).
  2. The transformed schema goes to `--output-schema`; the **original** schema is what ajv validates the result against. Any gap between the two surfaces as a local validation failure → repair-resume → null, never a wrong-shaped success.
  3. Classification: `invalid_json_schema` in turn.failed → `permanent` (no retry, actionable error); this is the one failure the engine must never loop on.
- Doc rule for workflow authors (in dialect.md): "keep schemas to the strict subset and they run everywhere; the parser will tell you when you haven't."

**(g) Cross-platform.**
- v1: Linux (dev box) + macOS (POSIX process groups, `setsid` semantics identical enough; CI adds a macos runner at commit 7). Windows: `process.platform==='win32'` → explicit error at startup ("v1 unsupported; track issue #N"), because a half-working kill path is worse than none (orphaned codex processes billing silently). v3 does the `taskkill /T` + Job Objects work.
- No symlinks in the repo or install paths (Windows + some CI). All paths via `path.join`; JSONL parsing tolerant of `\r\n`.

**(h) (Unrequested but top-3 by severity) Silent edit-rejection in codex exec.** In exec mode all approval requests are auto-rejected and **the turn still completes with exit 0** — a write-tasked agent can "succeed" having done nothing. Mitigation: adapter surfaces `permission_denials`-analogous signals from the item stream (declined `command_execution`/`file_change` statuses) into the agent result as `failure:{kind:'cap', msg:'N actions auto-rejected — wrong sandbox mode?'}`; doctrine tells authors to give mutating agents a schema with a `changed_files` field and verify it.

## 4. Verification strategy (token-free by default)

1. **Mock backend as first-class citizen.** Every engine semantic — semaphore fairness, allSettled null-mapping, pipeline drop-and-skip, `stage(prev, item, index)` signature, failures[] wording, determinism throws (exact messages), budget exhaustion, cap reporting, journal hash-chain values — is unit-tested against `mock.js` with fault injection (`{on: 3, do: 'throw'|'delay:5000'|'badjson'|'null'}`). Target: the whole engine suite runs in <10 s with zero network.
2. **Golden JSONL fixtures.** `tests/fixtures/` holds real captured streams: codex success, codex schema-400, codex turn.failed-with-reconnect-noise, codex interrupted; qodercli result-success-with-structured_output, `error_max_structured_output_retries`, exit-41 auth. Parser tests replay them byte-for-byte. `fixtures/record.sh` re-records against live CLIs (cheapest models) when a version bump lands — fixture diffs ARE the drift detector for risk (a).
3. **Determinism test**: same script + args twice on mock → byte-identical journal key chains. This locks the v2 resume contract before resume exists.
4. **Per-backend live smoke** (CI-optional, `UC_LIVE_TESTS=1`, ~$0.05): one 1-agent text run, one 1-agent schema run, one deliberately-bad-schema run asserting fail-fast (no API call at all — parse-time rejection), per backend on the cheapest model (`gpt-5.3-codex-spark`; qoder `lite` when the adapter lands).
5. **E2E parity demo** (`examples/review.workflow.js` on `examples/sample-repo/` with 2 planted auth bugs): discovery agent (schema `{files[]}`) → pipeline: per-file reviewer (schema `{findings:[{file,line,severity,claim}]}`) → adversarial verifier agent re-checks every finding against source (`{verdict}` per finding, judge-panel doctrine) → synthesis agent. Assertion script checks both planted bugs appear CONFIRMED. Run (i) via `ultracode run --backend codex`, (ii) unmodified via `.qoder/workflows/` + `qodercli -p "run the review workflow" --output-format stream-json` polling `output.json`. Recorded as the README asciinema/demo.
6. **One live micro-experiment early** (before building on inference): confirm `qodercli -p` waits for background workflow completion (the reports flag this unverified). If it doesn't, the qoder-pack docs pivot to `/workflows`-interactive + output.json polling. Budget: one $0.02 run at commit 9.

## 5. Milestone plan — progressive commits (each leaves repo green & demoable)

| # | Commit message | Contents | Demoable after |
|---|---|---|---|
| 1 | `chore: scaffold engine package with CI and test harness` | package.json, vitest, eslint, GitHub Actions (lint+test, linux), empty src tree, README stub stating the plugin/command/skill answer | `npm test` green |
| 2 | `feat(engine): workflow parser with pure-literal meta and determinism-ready sandbox` | load.js (acorn), sandbox.js (freeze/bans/exact messages), `ultracode parse`; unit tests incl. every ban message | `ultracode parse examples/hello.workflow.js` |
| 3 | `feat(engine): agent/parallel/pipeline/phase/log with mock backend, semaphore, caps` | helpers.js, mock.js, run.js, limits.js; the full semantics test suite | `ultracode run --backend mock examples/hello.workflow.js` |
| 4 | `feat(engine): run directory, hash-chained journal, output.json (Qoder-compatible shape)` | journal.js, manifest, determinism-of-keys test | inspect `.ultracode/runs/<id>/` |
| 5 | `feat(codex): codex exec backend adapter with golden-fixture parser tests` | codex.js, fixtures + record.sh, failure classification, LAST-agent-message rule, stale `-o` handling | first live 1-agent run |
| 6 | `feat(schema): strict-subset downgrade layer, ajv validation, repair-resume retry` | schema.js, fail-fast parse-time rejection, live schema smoke | typed `agent({schema})` live on Codex |
| 7 | `feat(safety): process groups, budget, dry-run, doctor preflight` | procgroup.js, doctor.js (auth checks incl. OAuth fan-out refusal), `--dry-run`, Ctrl-C test, macOS CI runner added | Ctrl-C mid-fan-out kills everything cleanly; `ultracode doctor` |
| 8 | `feat(skill): ultracode Agent Skill with dialect reference and quality-pattern doctrine` | skills/ultracode/* , `ultracode install --codex`, AGENTS.md snippet | full loop: prompt Codex "ultracode: …" → it authors+dry-runs+runs a workflow |
| 9 | `feat(qoder): native integration pack (workflows, skill, rules, gate probe)` | qoder-pack/*, `ultracode install --qoder`, the §4.6 live micro-experiment, namespacing guards | same review.workflow.js runs natively in qodercli |
| 10 | `docs+feat(examples): 5-agent code-review parity demo and threat-model README` | review.workflow.js, sample-repo, assertion script, README (decision doc, cost table, supported versions) | the parity demo, end to end |

v2 track (separate commits, post-demo): `feat(engine): resume via prefix-replay` → `feat(qoder): qodercli fallback backend` → `feat(mcp): start/status/result triad server with run leases` → `feat(engine): worktree isolation` → `feat: nested workflow()` → `feat(codex): plugin packaging`. v3: more hosts, Windows, quickjs.

## 6. Sanity check — where naive re-implementation visibly diverges, and why doctrine outranks engine

1. **Context inheritance is the big lie to avoid telling.** Real ultracode subagents inherit the session's model, permission allowlist, MCP servers, and CWD context. Our codex-exec subagents are amnesiac fresh processes. Users notice immediately when an agent asks "which repo?". This cannot be engineered away in v1 — it must be *doctrinally* compensated: dialect.md's #1 rule is "prompts must be self-contained: embed file paths, acceptance criteria, and repo facts; the subagent knows nothing." The skill teaches the model to write prompts that way. Skipping this doc work makes the engine look broken even when it's correct.
2. **Blocking vs fire-and-forget.** Real ultracode returns immediately and notifies on completion. v1 blocks the host's shell tool. Acceptable for the demo; must be stated honestly in the README ("v1 runs synchronously; long runs: use your host's background terminal") rather than half-imitated.
3. **acceptEdits vs auto-reject** (risk h): the most likely "it silently did nothing" report. Adapter-level surfacing + doctrine ("give mutating agents a changed_files schema") is mandatory, not optional polish.
4. **pipeline() micro-semantics** (no inter-stage barrier; `null` return drops the item and skips remaining stages; `stage(prev, originalItem, index)`) are exactly the details a casual port gets wrong and exactly what makes scripts source-compatible with Qoder. The fault-injection suite exists to pin them.
5. **Doctrine > engine — the strongest evidence is Qoder itself**: it shipped a *complete, faithful* engine and the feature is inert in practice because nothing tells the model *when and how* to orchestrate (no keyword mode, no quality patterns). Conversely Claude's ultracode value is mostly the standing opt-in + patterns (adversarial verify, judge panel, perspective diversity, loop-until-dry, completeness critic, no-silent-caps, budget-aware looping). Those are ~3 markdown files. Budget allocation should reflect this: skill/doctrine content deserves the same review rigor as engine code, including "when NOT to orchestrate" (single-file edits, <3 independent units, tasks needing shared mutable state) — over-triggering is how the feature gets disabled by annoyed users.
6. **Don't chase engine fidelity that no one can observe**: exact 30 s vm sync timeout, 1000-entry log cap, `teamName`/`stallMs` options — implement lazily. Chase fidelity users CAN observe: dialect surface, error messages that scripts might match on, output.json shape, cap/failure reporting.

## KEY DECISIONS
- **v1 delivery = standalone `ultracode` CLI engine + Agent Skill (.agents/skills/ultracode) for Codex; zero-engine native pack (.qoder/workflows + skill + rules) for Qoder; no MCP server in v1** — Skills are the only cross-host, default-on, doctrine-carrying surface (Codex deprecated custom prompts in favor of skills); Qoder already ships a faithful engine so re-implementing it there is pure waste — its actual gap is the auto-orchestration doctrine, which is markdown; the MCP triad is the single largest complexity item (long-poll, persistence, orphan supervision) and the first demo works without it via a blocking CLI call. (rejected: MCP-server-first (drags in every host-timeout/orphaning problem the research documented, before one agent has run); Codex-plugin-first (plugins wrap skills anyway — packaging, not capability; do it in v2); external engine for Qoder in v1 (duplicates a shipped native feature and pollutes its namespace).)
- **Cut from v1: resume/prefix-replay (but WRITE the hash-chained journal from day one), MCP triad, fire-and-forget, nested workflow(), worktree isolation, qodercli fallback adapter, hosts beyond Codex+Qoder, Windows** — None are needed for the parity demo; each roughly doubles some test surface. Writing the journal (cheap) while deferring the replay read-path keeps v2 resume additive and lets a determinism test lock the cache-key contract now. (rejected: Full-fidelity v1 (matches the real feature list but ships nothing for weeks and multiplies live-API test cost); cutting the journal too (would force a breaking run-format change when resume lands).)
- **Keep in v1 despite minimalism: budget wiring (spent/remaining from usage events, throw on exhaustion), --max-agents 50 default, per-agent timeout, --dry-run, process-group kill, doctor preflight** — These are cost/safety kill-switches, not fidelity features — the risk architect's non-negotiables. Runaway spend or orphaned billing processes on the first demo would kill the project's credibility. Notably this exceeds Qoder's own (stubbed) budget support for ~80 lines of code. (rejected: Matching Qoder's stub budget ({total:null}) for strict parity — parity with a known gap is not a virtue when the gap is a safety hole.)
- **Always validate structured output locally with ajv against the ORIGINAL schema, regardless of backend-native enforcement; native flags (codex --output-schema, qodercli --json-schema) are treated as accelerators, never as the source of truth** — qodercli --json-schema is undocumented (SDK-source-only) and codex enforcement is server-side on OpenAI models only (--oss providers may ignore it); local validation makes flag drift degrade gracefully (more retries) instead of corrupting results. Codex strict-subset incompatibilities are rejected at parse time (deterministic 400s must never be retried). (rejected: Trusting native enforcement (breaks silently on flag drift and on --oss); pure prompt-injection everywhere (wastes the strong native paths and increases retry cost).)
- **Sandbox = hardened node:vm (frozen intrinsics, determinism bans, WebAssembly/ShadowRealm deleted), same as Qoder ships; review-before-run enforced by CLI (--yes to skip) and by skill doctrine; execFile-only spawning of an allowlisted set of backend binaries** — The trust model is model-authored + user-reviewed scripts — identical to what Qoder ships in production with node:vm. quickjs-emscripten's WASM boundary only pays off if untrusted third-party workflow distribution becomes a feature (v3). The dominant real blast radius is the subagents' legitimate file access, controlled via default --sandbox read-only. (rejected: quickjs-emscripten in v1 (async host-call fan-out through Asyncify is real engineering for zero demo value under the current trust model); vm2 (CVE-2026-22709, dead); isolated-vm (native dep + maintenance-mode posture).)
- **Auth policy enforced by doctor at every run start: Codex fan-out requires CODEX_API_KEY/CODEX_ACCESS_TOKEN; ChatGPT-OAuth credentials cap concurrency to 1 unless --force-oauth-fanout (≤3, with pre-warm); never copy auth.json or create per-worker CODEX_HOME for auth** — Single-use OAuth refresh tokens + non-atomic auth.json writes make OAuth fan-out range from transient 401s to family-revoked logins (issues #10332 closed-not-planned, #26303); per-worker copies are strictly worse. Shared home + env key is the source-verified safe topology and preserves centralized config/sessions. (rejected: Per-worker CODEX_HOME with copied auth.json (officially unsupported, mutually invalidating); silently allowing OAuth fan-out with a docs-only warning (users don't read docs before their login gets revoked).)
- **Testing is mock-first: full engine semantics against a fault-injecting mock backend; golden JSONL fixtures (with a re-record script) pin parsers and double as the version-drift detector; live tests are opt-in, cheapest-model, ~$0.05** — Every engine semantic (allSettled nulls, pipeline drop, cap reporting, journal keys, determinism throws) is checkable without tokens; fixtures turn 'undocumented flag changed' from a production surprise into a failing diff at record time. (rejected: Live-API integration tests as the default suite (slow, flaky, costly, and unusable in CI forks without secrets).)
- **v1 default --max-agents 50 (not 1000) with loud no-silent-caps reporting; --sandbox read-only default for subagents** — 1000 agents on a first-run misconfigured workflow is a three-digit bill; the doctrine explicitly requires reporting caps rather than hiding them, so a conservative default with an override flag is doctrine-compliant. Read-only default makes the demo (a review) safe and forces an explicit decision before parallel mutation. (rejected: 1000 default for spec fidelity (fidelity to a limit nobody hits in a demo, at real financial risk).)

## RISKS
- Undocumented-surface drift: qodercli --json-schema and the stream-json envelope are SDK-source-only and Qoder ships near-daily releases; codex exec JSONL/flags shift across the 0.14x rearchitecture. Mitigated by version pinning + doctor probes + fixture re-record diffs + always-local ajv validation, but a breaking qodercli change can still brick the Qoder fallback adapter with zero notice.
- Qoder remote feature gate: the native Workflow tool is gated by an account-level config-service flag; if the user's account has it off, the entire zero-engine Qoder v1 story collapses to 'wait for v2 fallback adapter'. Must probe at install time (tool returns 'Workflow feature gate is disabled.') and set expectations in README.
- Silent no-op subagents on Codex: exec auto-rejects all approvals yet exits 0, so write-tasked agents can 'succeed' having changed nothing; if the adapter's declined-action surfacing misses a case, users get confidently empty results — the most trust-damaging failure mode.
- ChatGPT-OAuth users are a large cohort who get a degraded (concurrency-1) experience by policy; some will --force-oauth-fanout and hit token-family revocation anyway, and the resulting 'ultracode broke my Codex login' reports land on this project.
- node:vm is not a security boundary: a hostile workflow script (e.g. pasted from the internet, bypassing the model-authored assumption) that escapes gets orchestrator-process privileges. Review-before-run is procedural, not technical; the threat model must be documented bluntly and revisited if workflow sharing emerges.
- Cost estimation is soft: budget counts tokens from usage events, but ChatGPT-plan 'local messages' and Qoder credits don't map 1:1 to tokens; a 5-hour-window rate-limit exhaustion mid-run (Codex Plus) looks like a spray of transient failures rather than a clean budget stop.
- Blocking v1 execution can collide with host-side shell timeouts or user impatience on runs >15 min; without the MCP triad there is no reattach story — Ctrl-C + re-run (no resume in v1) re-spends the full run cost.
- Maintenance treadmill: two fast-moving closed/semi-closed CLIs (codex ~weekly, qodercli ~daily) times fixtures, capability cache, and SUPPORTED_VERSIONS must be re-verified on every bump; this recurring cost is easy to underestimate against the one-time build cost.
- Doctrine miscalibration: an over-eager skill description makes the model orchestrate trivial tasks (cost + annoyance → user uninstalls); an under-eager one makes the feature invisible. Needs iterative tuning against real prompts, which is unbudgeted-by-default work.
- Parity-claim erosion: the shared dialect drifts (Qoder adds runtime options like stallMs/teamName; Claude evolves the spec); scripts written against our engine may stop being drop-in for Qoder or vice versa; the parity test in CI only covers the constructs the demo uses.

## OPEN QUESTIONS
- Does `qodercli -p` keep the process alive until a background Workflow-tool run completes (report flags this as unverified)? Determines whether the Qoder headless demo is single-command or command + output.json polling — settle with one $0.02 live run at milestone 9.
- Is the 'workflows' remote feature gate ON for the user's actual Qoder account/org? If off, does the project pull the v2 qodercli fallback adapter forward into v1.5?
- What auth does the user run Codex with (API key vs ChatGPT plan)? If ChatGPT-only, the concurrency-1 policy neuters the demo and we need an explicit decision on --force-oauth-fanout defaults or an API-key requirement in the README.
- Should `ultracode install` target user scope (~/.agents/skills, all repos) or repo scope (.agents/skills, committable) by default? Affects team-sharing story and the plugin-vs-skill answer's emphasis.
- Budget directive semantics: is '+500k' a hard ceiling (kill mid-agent) or a soft target (finish in-flight agents, stop spawning)? Real ultracode's enforcement is undocumented; propose soft-target + loud report, but this changes loop-until-budget doctrine wording.
- Node.js as a runtime prerequisite for Codex users: acceptable, or should v2 ship a single-file bundle (bun/pkg) so the skill works on Node-less machines?
- How much divergence from Qoder's exact dialect is tolerable when Qoder ships undocumented options (retries, stallMs, skip) — mirror them for script portability, or hold to the documented Claude surface only?
- Is there appetite to upstream the doctrine pack (skill/rules) to Qoder as a community plugin once stable, which would change v2 packaging priorities?