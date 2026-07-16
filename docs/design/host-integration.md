# Ultracode Host-Integration Architecture (per-host delivery surfaces)

> **Design history (predates the keyword-only narrowing in PR #10, 2026-07-17).** Throughout this
> document (§2, §2.3, the Qoder rule at §5, etc.), the current-tense descriptions of what *arms*
> ultracode mode — the keyword, a budget like "+500k", "use a workflow" / "fan out" phrasing,
> `.ultracode/mode`, task decomposability — and the "default budget 300k" reflect an earlier design.
> The shipped doctrine now arms the mode ONLY on the literal keyword "ultracode" written as the
> user's own request; budgets are opt-in (uncapped default). Read the arming/budget prose below as
> historical, not current behavior.

## 0. The one-line answer to "plugin? command? skill?"

**All three, in distinct layers — and the layering is the design:**

| Layer | Artifact | Why this form |
|---|---|---|
| **Doctrine** (when/how to orchestrate, dialect, quality patterns) | **A Skill** — `ultracode/SKILL.md` + `references/`, one canonical copy, installed to `.agents/skills/` (Codex, Gemini, Cursor, Amp, Crush, opencode, Windsurf), `.qoder/skills/` (Qoder), `.claude/skills/` (Claude Code) | Skills are the only surface with (a) cross-host convergence (agentskills.io, 40+ clients), (b) model-triggered implicit invocation (keyword emulation), (c) progressive disclosure so the doctrine costs ~100 tokens until needed |
| **Engine** (workflow runtime, subagent fan-out, journal/resume) | **An MCP server + CLI in one npm package** (`ultracode`), exposing the `workflow_start / workflow_status / workflow_result / workflow_cancel` triad over stdio | A skill cannot host a long-running process; a single blocking MCP tool dies at 300–600 s host timeouts (research: no host extends on progress, Tasks unsupported everywhere, `taskSupport:"required"` actively breaks Qoder) — so the engine is a process, reached by start/poll/result |
| **Delivery** (getting skill + engine registration + templates onto disk) | **A plugin where the host has plugins** (Codex plugin via `codex plugin add`; Qoder plugin via `.qoder-plugin/plugin.json`), **an installer command everywhere else** (`ultracode install <host>`) | Plugins are the only host-native bundle format that carries skills + MCP registration + saved workflows in one `add` operation; other hosts have no plugin system, so the npm CLI writes the per-host files |
| **Command** (explicit invocation) | **Free, emergent** — `$ultracode` in Codex (skills are `$name`-invocable), `/ultracode` in Qoder (a dir containing SKILL.md registers as a slash command), `/skill-name` in Cursor/Kiro/Copilot | No separate command artifact is authored; the skill *is* the command on every host that maps skills to slash/dollar commands |

On **Qoder**, the engine layer is mostly *not ours*: qodercli natively ships a faithful ultracode Workflow-tool port (same dialect, hash-chain journal, `resumeFromRunId`). There we ride the native tool and use our engine only as a feature-gate fallback.

---

## 1. Repository / package layout (single source of truth)

```
ultracode/                                # the git repo (this project) → npm package `ultracode`
├── package.json                          # bin: { ultracode: "bin/ultracode.js" }
├── bin/ultracode.js
├── src/
│   ├── engine/                           # workflow runtime (other subagent's design area)
│   ├── mcp/server.ts                     # `ultracode mcp` — stdio MCP server (triad tools)
│   ├── hosts/                            # codex.ts, qoder.ts, claude.ts, gemini.ts, cursor.ts,
│   │   └── ...                           #   copilot.ts, opencode.ts, amp.ts  (headless adapters)
│   └── installer/
│       ├── install.ts                    # `ultracode install <host>` behavior matrix (§6)
│       ├── sync.ts                       # `ultracode sync` — workflow-script fan-out (§7)
│       └── doctor.ts                     # `ultracode doctor` — probes (§6.4)
├── skill/                                # CANONICAL skill — single source of truth
│   └── ultracode/
│       ├── SKILL.md                      # §2 outline below
│       └── references/
│           ├── dialect.md                # full workflow-script API reference
│           ├── patterns.md               # quality patterns with runnable code
│           ├── invoking.md               # per-host engine invocation mechanics
│           └── portability.md            # cross-host shims, budget-via-args, naming rules
├── workflows/                            # canonical portable templates (shared dialect)
│   ├── uc-deep-verify.workflow.js        # adversarial + perspective-diverse verify
│   ├── uc-sweep.workflow.js              # multi-modal repo sweep (grep+semantic+test angles)
│   ├── uc-judge-panel.workflow.js
│   └── uc-fix-until-green.workflow.js    # loop-until-dry
├── dist-codex/                           # BUILD OUTPUT (fully generated, gitignored) → marketplace repo mirror
│   └── ...                               # §3 tree
├── dist-qoder/                           # BUILD OUTPUT → qoder marketplace mirror
│   └── ...                               # §4 tree
└── snippets/
    ├── AGENTS.ultracode.md               # the AGENTS.md block the installer appends (§2.3)
    └── mcp/                              # per-host MCP config JSON/TOML fragments
```

Two thin distribution repos, **generated by CI from `dist-codex/` and `dist-qoder/`, never hand-edited**: `ultracode-marketplace-codex` (for `codex plugin marketplace add owner/ultracode-marketplace-codex`) and `ultracode-marketplace-qoder` (for `qodercli plugins marketplace add ...`). Git history in the main repo is the provenance; the mirrors carry a `GENERATED-FROM: <commit-sha>` file.

---

## 2. The ULTRACODE SKILL (doctrine layer)

### 2.1 Progressive-disclosure budget
- **Level 1 (always loaded, ~100 tokens):** frontmatter `name` + `description`. Codex budgets the whole initial skills list to min(2% context, 8000 chars) — the description must carry the trigger conditions alone.
- **Level 2 (on activation, target ≤4.5k tokens / ≤450 lines):** SKILL.md body. Contains the mode semantics, the decision rubric, the *dispatch table* (which engine path on which host), a minimal authoring skeleton, and a one-line index of every quality pattern. Everything else is a pointer.
- **Level 3 (on demand):** `references/*.md` — the full dialect reference (~3k tokens), full pattern code (~3k), per-host invocation mechanics (~2k), portability shims (~1k).

### 2.2 SKILL.md full outline

```markdown
---
name: ultracode
description: >-
  Dynamic multi-agent workflow orchestration. Trigger when the user writes the
  keyword "ultracode" or "workflow", gives a token budget like "+500k", asks to
  fan out / parallelize / verify with multiple agents, or when ultracode mode is
  on (see .ultracode/mode) and the task decomposes into 3+ independent subtasks
  (audits, migrations, multi-file sweeps, research, adversarial verification).
  Authors a deterministic JS workflow script and runs it on the ultracode engine
  (native Workflow tool on Qoder; ultracode MCP server elsewhere), which fans
  out subagents in parallel with schema-validated results, journaling, and resume.
---
# Ultracode: dynamic multi-agent workflows

## 1. What this is
One paragraph: you (the host agent) become an ORCHESTRATION AUTHOR. You write a
short JavaScript workflow script in a fixed dialect; an external engine executes
it, spawning parallel subagents with structured (JSON-Schema-validated) results,
a resumable journal, and a token budget. You never do the subtask work inline
when a workflow is running — you design, launch, monitor, and synthesize.

## 2. Ultracode mode (standing opt-in)
- The keyword "ultracode" ANYWHERE in a user message is a standing opt-in: from
  that message onward, route every substantive task in this session through a
  workflow unless the user says "ultracode off" or the task is trivially small.
- Key sentence: "Treat mode as sticky for the session; on every task, check the
  mode before deciding to work inline."
- Durable mode: if the file `.ultracode/mode` exists and contains `on`, mode is
  on for every session in this repo (the AGENTS.md snippet repeats this so it
  survives context compaction). Toggle with `ultracode mode on|off` (CLI) or by
  writing the file. When you enable mode from a keyword, ALSO write the file if
  you can, and say "ultracode mode: on (persisted)".
- Budget directives: a token like "+500k" / "+2m" in the user message sets the
  run budget (500_000 / 2_000_000 tokens). Pass it as `budget` to the engine
  (Qoder: pass as `args.budgetTokens` — see §5 shim). Default budget if
  unstated: 300k. Never silently stop at a cap (§7).

## 3. When to orchestrate (rubric)
- YES: ≥3 independent subtasks; per-item work over ≥10 items; any "audit/sweep/
  migrate/verify everything" phrasing; research questions needing multi-source
  cross-check; verification of your own or another agent's large diff.
- NO: single-file edits, questions answerable from context, tasks < ~2 min of
  agent time, tasks requiring mid-run user input (workflows cannot ask).
- Key sentence: "When mode is on, the burden of proof flips: default to a
  workflow and justify inline work, not the reverse."

## 4. Running a workflow (dispatch table)
| Your host | Primary path | Fallback |
|---|---|---|
| Qoder CLI/IDE | Native `Workflow` tool: pass `script` (or `name` for saved), `args`. Fire-and-forget; completion arrives as a task notification. Resume: same `scriptPath` + `resumeFromRunId`. | If tool answers "Workflow feature gate is disabled." → MCP triad below |
| Codex, Gemini, Cursor, Copilot, opencode, Amp, Claude-as-guest | MCP tools `workflow_start` → loop `workflow_status(run_id, wait_seconds=50)` until terminal → `workflow_result`. NEVER abandon a started run; keep polling. A timed-out poll call is harmless — poll again with the same run_id. | CLI: `ultracode run <file> --args-json '…' --json` (blocking; only for short runs) |
| Codex quick fan-out exception | For ≤3 trivially parallel READ-ONLY lookups with no schema/journal needs, native spawn_agent is acceptable. Everything else: engine. | — |
- Key sentence: "workflow_start returns in <1s; the run continues server-side even
  if your turn ends — resume monitoring with workflow_status in the next turn."

## 5. Authoring quickstart (skeleton + 8 rules)
```js
export const meta = { name: 'uc-audit-auth', description: '…', phases: [
  { title: 'Discover' }, { title: 'Audit' }, { title: 'Verify' }] }
const B = (budget.total ?? args?.budgetTokens ?? null)   // portability shim
phase('Discover')
const found = await agent('List every route handler…', { label: 'lister',
  schema: { type:'object', required:['files'], additionalProperties:false,
            properties:{ files:{ type:'array', items:{type:'string'} } } } })
phase('Audit')
const audits = (await pipeline(found.files,
  (f) => agent(`Audit ${f} for missing auth…`, { label:f, phase:'Audit', schema: A }),
  (r, f) => r && agent(`Adversarially refute: ${JSON.stringify(r)}`,
                       { label:`verify:${f}`, phase:'Verify', schema: V })
)).filter(Boolean)
return { findings: audits, dropped: found.files.length - audits.length }
```
Rules (one line each): meta must be a pure literal; no Date.now/new Date()/
Math.random (engine throws — pass timestamps via args); parallel() takes THUNKS
and is a barrier (failures → null); pipeline() has no inter-stage barrier,
stage(prev, originalItem, index), throw/null drops the item; always
.filter(Boolean); schema roots must be type:"object", all properties required,
additionalProperties:false (Codex strict-subset — the portable safe subset);
set `phase` inside pipeline/parallel stages, not global phase(); prefix saved
workflow names with `uc-` (never `deep-research` — collides with built-ins).
→ Full API: references/dialect.md. → Cross-host shims: references/portability.md.

## 6. Quality patterns (index — code in references/patterns.md)
- adversarial-verify: every finding is re-derived by a fresh agent told to refute it.
- perspective-diverse-verify: N verifiers with different lenses (security/perf/API-contract); keep only findings surviving ≥2.
- judge-panel: 3 judges score candidate outputs against rubric schema; median wins.
- loop-until-dry: re-run find-fix cycles until an iteration yields zero new items (cap by budget, not iteration count).
- loop-until-budget: keep spawning refinement waves while budget.remaining() (or args-budget minus engine-reported spend) > reserve.
- multi-modal-sweep: same target hunted via ≥3 modalities (grep, type-graph, tests, git-history) then union+dedupe.
- completeness-critic: final agent diffs the result against the original request and lists gaps; gaps loop back once.
- no-silent-caps: see §7.

## 7. Reporting discipline
- Always surface: agents used vs 1000 cap, budget spent vs total, items dropped
  by pipeline failures, phases skipped. Key sentence: "If any cap truncated the
  work, the FIRST line of your synthesis says so."
- Synthesize workflow output yourself; never paste raw journal.
```

### 2.3 Standing opt-in: the persistence mechanism (decision)

Three cooperating carriers, weakest-to-strongest:
1. **In-context (skill instruction):** keyword → sticky-for-session rule in SKILL.md §2. Works everywhere, dies on compaction.
2. **`.ultracode/mode` state file** (contains `on` or `off`, plus optional `budget: 500000` default): checked by the skill, toggled by `ultracode mode on|off`. Machine-readable, survives everything, but only consulted when the skill is active.
3. **AGENTS.md snippet (the durable trigger)** — installed by `ultracode install --agents-md` (appended between `<!-- ultracode:begin -->/<!-- ultracode:end -->` markers for idempotent updates), ~8 lines:
   ```markdown
   ## Ultracode
   If the file .ultracode/mode exists and contains "on", ultracode mode is active:
   route every substantive task through the `ultracode` skill (multi-agent workflow
   orchestration) instead of working inline. The keyword "ultracode" or a budget
   token like "+500k" in any user message also activates it. See the ultracode skill.
   ```
   AGENTS.md is loaded every session on Codex/Qoder/Cursor/Copilot/opencode/Amp (Gemini needs `contextFileName` — installer handles it, §6). This is what makes mode survive sessions and compaction on hosts with no `/effort`.
No env-var carrier: `ULTRACODE_MODE=1` is honored by the engine CLI but is NOT the doctrine mechanism (hosts don't reliably surface env to the model).

---

## 3. CODEX delivery: a Codex plugin

### 3.1 File tree (`dist-codex/`, mirrored to `ultracode-marketplace-codex`)

```
ultracode-codex/                          # codex plugin add <path> / marketplace add
├── plugin.json                           # name "ultracode", version, description
├── skills/
│   └── ultracode/                        # verbatim copy of canonical skill
│       ├── SKILL.md
│       ├── references/{dialect,patterns,invoking,portability}.md
│       └── agents/openai.yaml            # interface: display_name "Ultracode",
│                                         #   default_prompt; policy:
│                                         #   allow_implicit_invocation: true;
│                                         #   dependencies.tools: [{type: mcp,
│                                         #     value: ultracode, transport: stdio}]
├── mcp/                                  # plugin-bundled MCP registration
│   └── config.toml fragment →            # [mcp_servers.ultracode]
│                                         # command = "ultracode", args = ["mcp"]
│                                         # startup_timeout_sec = 20
│                                         # tool_timeout_sec = 90        # long-poll 50s + margin
│                                         # instructions injected by server (≤512c):
│                                         # "Ultracode workflow engine. workflow_start
│                                         #  returns run_id fast; poll workflow_status
│                                         #  (wait_seconds<=50) until terminal, then
│                                         #  workflow_result. Runs survive your turn."
└── docs/
    └── SETUP.md                          # config recommendations (below), CODEX_API_KEY note
```

`skills/ultracode/agents/openai.yaml` `dependencies.tools` matters: Codex auto-prompts/installs missing MCP deps (`features.skill_mcp_dependency_install` on by default), so even a user who only installs the skill gets steered to the engine.

- **Invocation surfaces:** implicit (description match / ultracode keyword), explicit `$ultracode`, and `/skills`. No custom-prompt file (deprecated surface; skills replaced it). No separate command artifact.
- **AGENTS.md:** plugins can't write AGENTS.md; SETUP.md + the skill instruct: run `ultracode install codex --agents-md` once per repo (or `$skill-installer` flow). Snippet as §2.3.
- **Hooks: deliberately none.** Non-managed hooks require interactive trust per hook hash — friction with zero payoff since the engine journals server-side.

### 3.2 Worker-spawn configuration (engine-side, documented in SETUP.md)

The engine spawns Codex workers as:
```
CODEX_API_KEY=$KEY codex exec --json --cd <worktree|cwd> \
  --sandbox workspace-write -a never --skip-git-repo-check \
  [-c model_reasoning_effort=<effort>] [-m <model>] \
  [--output-schema <tmp/schema.json> -o <tmp/last.json>] "<prompt>"
```
- **Auth (from parallel-safety research):** shared `CODEX_HOME` + per-process `CODEX_API_KEY` is the only orchestrator-grade topology. ChatGPT-OAuth fan-out is officially discouraged (single-use refresh tokens, torn auth.json writes, #10332 closed not-planned). `ultracode doctor` warns hard if no `CODEX_API_KEY`/`CODEX_ACCESS_TOKEN` and caps effective concurrency at 2 with a pre-warm run under OAuth.
- **Schemas:** engine pre-validates against the strict subset locally (400 `invalid_json_schema` is deterministic and unretryable); takes the LAST `agent_message` (issue #19816); deletes stale `-o` files before each run; success = exit 0 + `turn.completed`.
- **Resume:** engine records `thread_id` from `thread.started` in its journal → `codex exec resume <thread_id>` for schema-repair turns.

### 3.3 Native subagents (spawn_agent) — decision: **do NOT use them for workflows**

Rationale: `max_threads` 6 (vs 16), `max_depth` 1, no journal/resume/prefix-cache, no per-agent JSON-schema enforcement (only CSV batch tool has schemas, wrong shape), results flow through the parent's context (defeating the "intermediate results live in script variables" property), and orchestration state dies with the turn. The skill carves ONE exception (§4 dispatch table): ≤3 read-only parallel lookups needing no schema and no durability, where saving an engine round-trip is worth it. Everything else — including all quality patterns — goes through the engine. This keeps a single journaled execution model and makes budget accounting truthful.

---

## 4. QODER delivery: ride the native Workflow tool

### 4.1 File tree (`dist-qoder/`)

```
ultracode-qoder/
├── .qoder-plugin/
│   └── plugin.json                       # { "name": "ultracode", version, description, … }
├── skills/
│   └── ultracode/                        # canonical skill, verbatim (also registers /ultracode)
│       ├── SKILL.md
│       └── references/…
├── workflows/                            # plugin workflow registry (source label plugin:ultracode)
│   ├── uc-deep-verify.js                 # canonical templates, shared dialect
│   ├── uc-sweep.js
│   ├── uc-judge-panel.js
│   └── uc-fix-until-green.js
├── agents/                               # effort routing: no per-call effort in Qoder agent(),
│   ├── uc-xhigh.md                       #   so agentType carries it. Frontmatter: effort: xhigh
│   └── uc-verifier.md                    #   read-leaning tools, effort: high — used by templates
└── .mcp.json                             # {"mcpServers":{"ultracode":{"command":"ultracode",
                                          #   "args":["mcp"]}}}  ← fallback engine, always registered
```

Installer additionally writes (plugins can't bundle rules):
```
.qoder/rules/ultracode.md                 # frontmatter: trigger: always_on   (~12 lines)
```
Rule content = keyword-trigger emulation (this substitutes for Claude Code's shimmer/keyword gate, which Qoder lacks):
> When a user message contains the word "ultracode" or a budget token like "+500k", or `.ultracode/mode` contains `on`: activate the `ultracode` skill and orchestrate the task with the native `Workflow` tool (prefer saved `uc-*` workflows; author a script otherwise). Pass budgets as `args.budgetTokens`. If the Workflow tool replies "Workflow feature gate is disabled.", use the `ultracode` MCP server's workflow_start/status/result tools instead.

`always_on` costs ~150 tokens of the 100k rules cap — acceptable; it is the only reliable keyword→behavior wire in Qoder.

### 4.2 Native-tool usage contract (encoded in references/invoking.md)

- Launch: `Workflow` tool with `script` (engine-authored) or `name: "uc-…"`. Fire-and-forget; completion arrives as a queued task-notification prompt. Headless: requires `Workflow(uc-*)` allow rules + pre-allowlisted child tools ("ask" throws inside workflows) or `--yolo`.
- Resume: re-invoke with same `scriptPath` + `resumeFromRunId: wf_…` (skill quotes the recovery text Qoder itself emits on failure).
- **Budget stub workaround:** Qoder's `budget` is `{total:null}` (host never wires it). All templates and the authoring skeleton use the shim `const B = budget.total ?? args?.budgetTokens ?? null`, and spend tracking inside scripts uses agent-count/waves rather than tokens; the skill tells the model to pass `budgetTokens` in `args`. When Qoder wires budget for real, the shim degrades to native automatically.
- **Namespacing (defensive):** all saved workflows `uc-*`; never define `deep-research`; never name anything `Workflow`/`workflows`/`workflow-tasks`; engine state lives in `.ultracode/`, never `.qoder/sessions/*/workflows/`.
- **Per-call effort:** not supported by Qoder `agent()` → templates use `agentType: 'uc-xhigh'` (bundled agent defs carry `effort:` frontmatter).

### 4.3 Feature-gate fallback

`ultracode doctor qoder` probes: `qodercli -p 'Invoke the Workflow tool with name "uc-noop"' --output-format stream-json --max-turns 2` and greps for `"Workflow feature gate is disabled."`. Gate off → doctor flips `.ultracode/config.json` `qoder.engine: "mcp"`, and the rule/skill dispatch table sends the model to the MCP triad (the `.mcp.json` registration is already present from the plugin). Engine workers on Qoder run `qodercli -p --output-format stream-json --json-schema '<schema>' --permission-mode dont_ask` with `QODER_PERSONAL_ACCESS_TOKEN` (stateless-safe for any N; doctor warns about the `/login`-beats-env-PAT precedence trap and exit code 41 = auth).

---

## 5. Engine MCP surface (shared by every non-Qoder host, and Qoder fallback)

Four tools, shaped by the timeout research (no host extends deadlines on progress; long-poll must sit under the worst default of 300 s Codex / 600 s others; server-side persistence mandatory because Codex orphans timed-out calls without cancellation):

```
workflow_start({ script? , name?, args?, budget?, cwd?, worker_host? })
  → { run_id, journal_path, script_path }            // returns < 1 s
workflow_status({ run_id, wait_seconds? })            // wait clamped to 50
  → { status: running|completed|failed|cancelled, phase, agents:{running,done,failed},
      spent_tokens, budget_total, log_tail: string[≤20] }
workflow_result({ run_id })
  → { result, failures[], usage:{agents,tokens,tool_calls,duration_ms},
      artifacts:{ output_path, journal_path } }       // error if not terminal
workflow_cancel({ run_id, reason? })
```
Run state persisted under `~/.ultracode/runs/<run_id>/{manifest.json, journal.jsonl, output.json}` (survives host restarts and Codex's silent orphaning). Server emits `notifications/progress` during any blocking window (free UX on Qoder/Gemini; Codex just logs). **No `execution.taskSupport` declaration at all** (`required` breaks Qoder client-side; `optional` buys nothing today). Server `instructions` field ≤512 chars, self-contained (Codex injects first 512).

---

## 6. Generic hosts + the installer behavior matrix

### 6.1 `ultracode install <host>` matrix

| Host | Skill destination | MCP registration written | AGENTS/context wiring | Notes |
|---|---|---|---|---|
| `codex` | `.agents/skills/ultracode/` (repo) or `~/.agents/skills/` with `--user` | `~/.codex/config.toml` `[mcp_servers.ultracode]` (TOML merge, tool_timeout_sec=90) — skipped if the plugin is detected | append §2.3 block to `AGENTS.md` (`--agents-md`) | suggests `codex plugin marketplace add` as the richer path |
| `qoder` | via plugin (`qodercli plugins install`), else `.qoder/skills/ultracode/` | `.mcp.json` mcpServers.ultracode | `.qoder/rules/ultracode.md` (always_on) + AGENTS.md block | also copies `workflows/uc-*.js` → `.qoder/workflows/` (§7) |
| `claude` | `.claude/skills/ultracode/` | none — native Workflow tool exists | AGENTS.md/CLAUDE.md block | copies `workflows/` → `.claude/workflows/` |
| `gemini` | `.agents/skills/ultracode/` (alias honored) | `.gemini/settings.json` `mcpServers.ultracode` (timeout: 90000) | sets `contextFileName: ["GEMINI.md","AGENTS.md"]` in `.gemini/settings.json`, then AGENTS.md block | JSON-merge, never clobber |
| `cursor` | `.cursor/skills/ultracode/` (or `.agents/skills/`) | `.cursor/mcp.json` | AGENTS.md block (read natively) | `/ultracode` works via skill |
| `copilot` | `.agents/skills/ultracode/` (agents-dir compat) | `~/.copilot/mcp-config.json` (user-level; per-repo via `--additional-mcp-config` documented) | AGENTS.md block | |
| `opencode` | `.opencode/skills/` or `.agents/skills/` | `opencode.json` `mcp` key | AGENTS.md block (native) | |
| `amp` | `.agents/skills/ultracode/` | `~/.config/amp/settings.json` `amp.mcpServers` | AGENTS.md block | workspace MCP needs `amp mcp approve ultracode` — installer prints the command |
| `all` | `.agents/skills/` once + every detected host's MCP config | detection = which config dirs/binaries exist | one AGENTS.md block | idempotent; marker-comment guarded |

All writes are **merge-not-overwrite** (JSON/TOML parsed, key added, formatting preserved where feasible), idempotent (re-run = update in place), and `--dry-run` prints the diff. `--user` vs default project scope flag on every host.

### 6.2 Zero → running, per host
- **Codex:** `npm i -g ultracode` → `codex plugin marketplace add <org>/ultracode-marketplace-codex && codex plugin add ultracode` → in-repo `ultracode install codex --agents-md` → type `ultracode audit our auth +500k` (or `$ultracode …`).
- **Qoder:** `npm i -g ultracode` → `qodercli plugins marketplace add <org>/ultracode-marketplace-qoder && qodercli plugins install ultracode@ultracode` → `ultracode install qoder` (rules + AGENTS.md + workflow sync) → `ultracode fix all flaky tests`.
- **Others:** `npm i -g ultracode && ultracode install <host> --agents-md` → done.
- npm package is the one mandatory install everywhere (it ships the engine the MCP entries point at). Plugins without the npm package degrade gracefully: skill loads, MCP server fails to start, doctor message tells the user to `npm i -g ultracode`.

### 6.3 `ultracode doctor`
Probes and prints a table: engine binary on PATH & version; MCP registration present per detected host; Codex auth mode (API key vs OAuth → concurrency warning); Qoder feature gate (live probe, §4.3); Qoder `/login`-vs-PAT trap; skill present & frontmatter valid (`skills-ref validate` semantics); AGENTS.md block present; workflow copies in sync (§7).

---

## 7. Workflow-script portability (single source of truth + sync)

- **Canonical location:** `<repo>/.ultracode/workflows/*.workflow.js` (user-authored) and the package's `workflows/` (templates). Canonical files are the only ones edited by hand.
- **`ultracode sync`** copies (real copies, not symlinks — Windows + unverified symlink handling in Qoder/Claude registries) canonical scripts into `.claude/workflows/` and `.qoder/workflows/`, strips the `.workflow` infix (`uc-sweep.workflow.js` → `uc-sweep.js`), and stamps a header comment `// GENERATED by ultracode sync from .ultracode/workflows/… — edit the source, not this copy. sha256:<hash>`. Drift detection: `sync --check` (also run by `doctor`) compares hashes both ways; a hand-edited copy is reported, `sync --adopt <file>` pulls it back into canonical.
- **`ultracode lint`** enforces the portable dialect subset before sync: `meta` pure-literal with name/description; no `Date.now`/`new Date()`/`Math.random`; no reliance on `budget.total` without the args shim; schemas within the Codex strict subset (root object, all required, `additionalProperties:false` — the intersection that also satisfies Qoder/engine validation); no per-call `effort` option (use `agentType`); name matches `uc-[a-z0-9-]+`; ≤512 KB (Qoder cap).
- **The dialect itself is the portability layer:** the same script text runs on Claude Code's Workflow tool, Qoder's Workflow tool, and the external engine because all three implement the identical surface (`agent/parallel/pipeline/phase/log/args/budget/workflow`, allSettled barrier, drop-on-throw pipeline, determinism bans). The engine implements the spec's semantics bit-for-bit precisely so scripts are indistinguishable across substrates; `references/portability.md` documents the three known divergences (Qoder budget stub, Qoder no per-call effort, Claude-only agentTypes) and their shims.


## KEY DECISIONS
- **Answer to 'plugin vs command vs skill': layered — the doctrine is a Skill (canonical, agentskills.io-compliant, copied per host), the engine is an npm-shipped MCP server + CLI, delivery is a Plugin on Codex and Qoder and an installer command elsewhere, and the slash/dollar command surface is emergent from skills ($ultracode, /ultracode) with no separate command artifact authored.** — Skills are the only cross-host surface with implicit model-triggered invocation and progressive disclosure; an engine needs a process (skills can't host one, single blocking MCP calls die at 300-600s host timeouts); plugins are the only one-command bundle format and exist only on Codex/Qoder; every target host already maps skills to invocable commands. (rejected: A pure MCP server with no skill (model never learns the doctrine or dialect, no keyword trigger); custom prompts on Codex (officially deprecated); per-host bespoke command files (duplicated maintenance, no implicit triggering).)
- **MCP engine surface is a start/status/result/cancel triad with workflow_status long-poll clamped to 50 seconds, server-side run persistence under ~/.ultracode/runs/, and NO execution.taskSupport declaration.** — Source-verified research: no target host extends MCP timeouts on progress notifications (Codex 300s default, Qoder/Gemini 600s), MCP Tasks are unsupported in all targets, Codex orphans timed-out calls without notifications/cancelled, and taskSupport:'required' makes tools unusable in Qoder client-side. 50s sits under every default including legacy 60s Codex. (rejected: Single blocking workflow tool (dies on any run >5 min); MCP Tasks extension (breaks Qoder, ignored by Codex which pins protocol 2025-06-18); asking users to raise tool_timeout_sec (user-hostile, undocumented key on Qoder, still orphans work on Codex).)
- **On Qoder, ride the NATIVE Workflow tool as primary (plugin ships uc-* workflow templates, skill, uc-* agent defs for effort routing, rules snippet); the external MCP engine is registered but used only when the remote 'workflows' feature gate is off (detected by a doctor probe).** — Qoder 1.0.37 is a faithful ultracode port (same dialect, schema enforcement, hash-chain journal resume, 16/1000 caps) — replacing it would duplicate a native, UI-integrated runtime and lose /workflows monitoring, per-agent skip/retry, and permission integration. (rejected: Always-external engine on Qoder (worse UX, fights the native task-notification loop, wastes the deepest native integration available); native-only with no fallback (remote feature gate can be off per account).)
- **On Codex, ALL workflow execution goes through the external engine; native subagents (spawn_agent) are permitted only for a narrow exception — up to 3 read-only, schema-free, non-durable parallel lookups — written into the skill's dispatch table.** — Native subagents cap at max_threads 6 / depth 1, have no journal, no resume/prefix-cache, no per-agent JSON-schema enforcement, and results flow through the parent context, breaking ultracode's core properties (16-way concurrency, deterministic resume, schema-validated returns, intermediate results outside the conversation). A single execution model also keeps budget accounting truthful. (rejected: Hybrid routing by task size (two execution models with divergent semantics, journal gaps, confusing failure modes); pure native subagents (cannot implement pipeline/judge-panel/loop-until-budget patterns at fidelity).)
- **Standing opt-in ('ultracode mode') = three cooperating carriers: sticky-for-session rule in the skill, a .ultracode/mode state file toggled by CLI or the model, and an idempotent marker-guarded AGENTS.md snippet (plus a Qoder always_on rule) as the durable trigger that survives sessions and compaction.** — No target host has /effort or a session-mode primitive; AGENTS.md is loaded every session on effectively all hosts (Gemini via contextFileName which the installer sets), making it the only reliable cross-host persistence wire; the state file gives a machine-readable toggle the snippet can reference. (rejected: Env var as primary carrier (hosts don't reliably surface env to the model); SessionStart hooks injecting context (Codex hook-trust friction, no hooks on several hosts); skill-only persistence (dies on compaction).)
- **Single npm package `ultracode` is the source of truth (engine + MCP server + installer + canonical skill + templates); Codex and Qoder marketplace repos are CI-generated read-only mirrors of dist-codex/ and dist-qoder/ build outputs.** — One place to edit the skill and templates; marketplace formats demand standalone git repos, so mirrors are mechanical; the npm binary is required everywhere anyway because every MCP registration points at `ultracode mcp`. (rejected: Monorepo-only with users cloning for plugins (breaks codex plugin marketplace add UX); three independently versioned repos (skill drift across hosts is the #1 failure mode of this design).)
- **Workflow-script portability via one canonical dir (.ultracode/workflows/*.workflow.js) + `ultracode sync` making real stamped copies into .claude/workflows/ and .qoder/workflows/, guarded by `ultracode lint` enforcing the portable dialect subset (pure-literal meta, determinism bans, Codex-strict schemas, budget-via-args shim, uc- prefix, no per-call effort).** — The dialect is identical across Claude/Qoder/engine so copies are byte-identical; copies beat symlinks (Windows, unverified registry symlink handling); hash-stamped headers plus sync --check make drift detectable and --adopt reversible; lint catches the three real divergences (Qoder budget stub, no per-call effort, agentType namespaces) before they ship. (rejected: Symlinks (Windows, Qoder/Claude registry behavior unverified); host dirs as authoritative with no canonical copy (three-way drift); a transpilation step (dialect is already shared — transforms would add failure surface for zero delta).)
- **Worker auth topology baked into engine defaults and doctor warnings: Codex = shared CODEX_HOME + per-process CODEX_API_KEY (hard warning + concurrency clamp to 2 under ChatGPT OAuth); Qoder = shared home + QODER_PERSONAL_ACCESS_TOKEN with an explicit /login-precedence-trap check.** — Source-verified: Codex OAuth refresh tokens are single-use with non-atomic auth.json writes (race closed as not-planned upstream, official docs prohibit concurrent sharing), while CODEX_API_KEY bypasses auth.json entirely; Qoder PATs are stateless per-process but a stored /login credential silently overrides the env PAT. (rejected: Per-worker CODEX_HOME with auth.json copies (mutually invalidating, upstream closed as not-planned); ignoring auth mode (fleet-wide 401 cascades and possible token-family revocation mid-run).)

## RISKS
- Qoder's --json-schema flag, per-server MCP 'timeout' key, and the Workflow tool's undocumented options are all bundle-derived, not documented; qodercli ships near-daily releases, so any of them can drift — the engine's Qoder adapter needs a version pin + doctor probe, and orchestrator-side schema validation must stay on even where native enforcement exists.
- The Qoder remote 'workflows' feature gate is server-controlled per account; the primary Qoder path can silently degrade for some users, and the doctor probe itself costs a model turn — gate state should be cached with a TTL in .ultracode/config.json.
- AGENTS.md-based mode persistence is advisory: a host model can ignore the snippet, and Qoder's own .qoder/rules take precedence over AGENTS.md on conflict — keyword-trigger fidelity will be lower than Claude Code's native shimmer gate, especially on weaker models; the always_on Qoder rule mitigates only on Qoder.
- Codex plugin MCP bundling and skill agents/openai.yaml dependency auto-install are new surfaces (skills default-on only since Dec 2025); exact plugin manifest schema for bundled MCP registration should be re-verified against a live `codex plugin add` before freezing dist-codex/ layout.
- Skill triggering conflicts: hosts that read multiple skill dirs (.agents/skills + .claude/skills + .cursor/skills) will show duplicate 'ultracode' entries if a user installs both a plugin copy and a .agents/skills copy — Codex explicitly does NOT dedupe same-name skills; the installer must detect and refuse double-install per host.
- Long-poll workflow_status depends on the host model faithfully re-polling across turns; if a model abandons a run after workflow_start, work completes server-side but is never synthesized — mitigation is the instructions field, skill discipline text, and workflow_list/doctor surfacing orphaned completed runs, but it cannot be fully enforced.
- ChatGPT-plan Codex users (no API key) get a severely degraded parallel experience (concurrency 2, refresh-race exposure, issue #26303 shows even sequential batches can be killed server-side) — this is a hard external constraint, and messaging must set expectations or users will blame ultracode.
- The 32 KiB project_doc_max_bytes cap on Codex AGENTS.md concatenation means the ultracode snippet competes with existing project docs; in doc-heavy monorepos the snippet may be truncated — installer should warn when the concatenated size approaches the cap.
- Marketplace mirror repos generated by CI can lag the npm package after a release-pipeline failure, producing skill/engine version skew; the MCP server should report its version in init instructions and the skill should tolerate one minor-version drift.

## OPEN QUESTIONS
- Does `qodercli -p` stay alive until a background native Workflow run completes (the task-notification enqueue suggests yes, unverified)? Determines whether headless Qoder CI usage of the native path needs the MCP engine instead — needs one live test in implementation phase.
- Exact Codex plugin.json manifest schema for bundling MCP server registrations (docs say plugins bundle 'skills + MCP + hooks + prompts' but the field layout was not captured) — verify with `codex plugin add` on a scratch plugin before freezing dist-codex/.
- Should the AGENTS.md snippet be written at user scope too (~/.codex/AGENTS.md, ~/.qoder/AGENTS.md) for users who want ultracode mode machine-wide, or is project scope + --user skill install sufficient for v1?
- Cursor and Copilot skill-as-slash-command behavior for a skill named 'ultracode' with references/ subdirs (progressive disclosure depth) is documented but untested — confirm references load on demand rather than inline on those hosts.
- Whether the engine should expose a fifth MCP tool workflow_list (for orphaned-run recovery and multi-run sessions) in v1 or keep the surface minimal — leaning yes since abandonment is a named risk, but it grows the tool count every host must carry.
- Qoder plugin `agents/` dir: confirmed for CLI plugins, but whether plugin-bundled agent definitions are visible to the native Workflow tool's agentType registry (needed for uc-xhigh effort routing) is inferred from the registry precedence docs, not proven — verify, else fall back to installer-written .qoder/agents/ files.
- For Gemini CLI, is mutating the user's .gemini/settings.json contextFileName acceptable UX, or should the installer instead write a GEMINI.md containing just the ultracode block (leaving AGENTS.md wiring alone)?
- Version/name of the npm package: is plain `ultracode` available on npm, and is the unscoped name worth squatting risk vs @scope/ultracode with a longer install command?