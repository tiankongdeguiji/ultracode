# Invoking workflows per host

**Worker guard (applies to every route below):** if the `ULTRACODE_INSIDE_RUN`
environment variable is set, you are a worker inside an ultracode run — never
dispatch workflows by ANY route (CLI, MCP, native tool). Do your assigned task
directly. The routes below are for interactive hosts orchestrating on a user's
behalf.

## Dispatch order

1. **Qoder native Workflow tool** (qodercli / Qoder IDE with the tool registered): invoke it directly, or install the script to `.qoder/workflows/<name>.js` and run by name. Native resume: `resumeFromRunId: "wf_..."`. Caveats: `budget` global is stubbed (`{total:null}`) — pass `args.budgetTokens` and gate manually; no per-call `effort` (define a subagent in `.qoder/agents/` with frontmatter `effort:` and use `agentType`); never name anything `Workflow`, `workflows`, or `deep-research`.
2. **ultracode MCP tools** (`workflow_start` / `workflow_status` / `workflow_result` / `workflow_stop` / `workflow_list`):
   - `workflow_start {script | scriptPath, backend, args?, budget?, maxConcurrency?, resumeFromRunId?}` → returns `{runId}` in <1s. The run survives your turn because the MCP **server process** owns it — which makes this the only reliable route from a sandboxed host shell. **`backend` is required for a fresh start** (mock|codex|qoder|claude|gemini); `mock` returns fabricated stubs for rehearsal only, so always pass a real backend for real work. (Resume inherits the prior run's backend.)
   - Poll `workflow_status {runId, waitSeconds: 25, sinceEventOffset}` — long-poll; returns fresh log tail + `nextEventOffset`. **A timed-out poll is harmless: re-poll with the same runId.**
   - `workflow_result {runId}` when status is terminal → full output (result, failures, usage, artifact paths).
3. **Shell CLI**:
   ```bash
   ultracode validate my.workflow.js          # meta + dialect + compile check
   ultracode run my.workflow.js --dry-run     # free rehearsal on the mock backend
   ultracode run my.workflow.js --backend codex --yes [--budget <ONLY if the user specified one>] [--detach]
   ultracode watch <runId>                    # live panel; status <runId> --watch for script-friendly output
   ultracode logs <runId> --follow | stop <runId>
   ultracode resume <runId> [--script edited.js]
   ultracode doctor                           # backend availability + auth mode table
   ```
   `--detach` is for **persistent shells only** — see lifecycle discipline below.

## Backend notes (ultracode engine workers)

| backend | worker CLI | structured output | parallel-safe auth |
|---|---|---|---|
| codex | `codex exec --json` (+ rollout sidecar for live tokens/model) | native `--output-schema` (strict subset) | `CODEX_API_KEY` |
| qoder | `qodercli --print` | native `--json-schema` (+ engine revalidation) | `QODER_PERSONAL_ACCESS_TOKEN` (beware stored /login creds) |
| claude | `claude -p` | native `--json-schema` | CLI-managed |
| gemini | `gemini -p` | emulated (prompt contract + validate/retry) | `GEMINI_API_KEY` |
| mock | built-in | schema-aware stubs | n/a — free, use for --dry-run |

Permission is user-controlled: default to `--permission auto` and pass a user-specified permission verbatim. `--permission safe` is backend-asymmetric: codex maps it to a read-only **sandbox** (workers still execute commands — queries and profilers work, writes/network blocked); claude (`default`) and qoder (`dont_ask`) map it to headless **permission modes** that auto-reject every tool call — those workers can only read files and reason. A workflow whose agents must run read-only commands breaks SILENTLY when switched from codex to claude/qoder under `safe`: agents report "unverified"/empty results and there is NO engine warning (the "actions auto-rejected" warning is codex-only — its adapter is the only one that emits declined tool events). If the user asked for `safe` and workers need to execute read-only commands, tell the user and embed the evidence in prompts instead.

## Workflow lifecycle discipline

- Always `validate` then `--dry-run` before spending tokens: dialect errors, cap misconfigurations, and schema mistakes surface for free.
- **Sandboxed host shells kill detached runs.** If your shell commands run inside a sandbox (Codex workspace-write exec, any per-command jail), a `--detach`ed runner CANNOT outlive your tool call: the sandbox's PID namespace is torn down when the command returns and the kernel SIGKILLs everything inside — no logs, no finalization. Symptom: `status` shows `orphaned` within seconds, manifest `pid` ≤ 64, empty runner.log. Route through the MCP server instead, or ask the user to launch from a persistent shell / escalate the command. (Also: codex workers cannot spawn inside Codex's own sandbox — `~/.codex` state is read-only there and network is off — so from a Codex host either use MCP or a non-codex worker backend.)
- **After ANY launch, verify liveness before doing anything else**: first `workflow_status` poll or `ultracode status <runId>`. `orphaned` at launch = the run is dead; diagnose (see above), don't wait on it. Then keep polling until terminal — never abandon a started run, and never do the subtask work inline yourself while it runs.
- Long runs: `--detach` (persistent shells only), then `ultracode watch <runId>` / poll `status`. The watch panel is interactive on a TTY: ↑/↓ (j/k) select an agent, ⏎ opens its detail view (prompt, tool activity, outcome), esc backs out (overview: clears selection), q detach. The run store (`.ultracode/runs/<runId>/`) holds `output.json`, `journal.jsonl`, `events.jsonl`, and per-agent `agents/<seq>-<label>/{prompt.md, result.json, transcript.jsonl}` — cite these paths when reporting (`prompt.md` lands at agent start, `result.json` at settle). The dir name zero-pads seq to 4 and slugifies the label, e.g. `agents/0003-audit-src-foo-ts/`.
- On failure: read `output.json` `failures[]` first (every cap trip, declined action, and agent error lands there), then `resume` — completed agents replay free.
- Report faithfully: surface `failures[]` and warnings to the user even when the run "succeeded".
