# Architecture — how ultracode is delivered

Current-state description of the shipped v0.1.x layering; the rationale and design history live in `docs/design/`.

## Plugin, command, or skill? All three — layered

| Layer | Artifact | Why |
|---|---|---|
| **Doctrine** | An Agent Skill (`skill/ultracode/`) | The only cross-host surface with implicit model-triggered invocation and progressive disclosure. Teaches the model *when* to orchestrate, the workflow dialect, and the quality patterns (adversarial verify, judge panel, loop-until-dry, completeness critic). |
| **Engine** | This npm package: CLI (`ultracode run/...`) + MCP server (`ultracode mcp`) | A skill can't host a process, and no host extends MCP tool timeouts on progress, so the MCP surface is a `workflow_start` / `workflow_status` (long-poll) / `workflow_result` triad (plus `workflow_stop` / `workflow_list`) over a durable on-disk run store. `workflow_status until="terminal"` is the quiet monitor — one long hold parks the host until the run ends (the codex hostpack raises `tool_timeout_sec` to 3600 → ~55 min/hold, ~1 turn/hour); `until="phase"` adds milestone wakes. |
| **Delivery** | Plugin where plugins exist (Codex, Qoder); `ultracode install <host>` everywhere else | Bundles carry the doctrine (Codex: skill only; Qoder adds the `uc-*` templates + agent defs); the installer writes the host wiring — the AGENTS.md trigger snippet and, for codex user scope, MCP registration. |
| **Command** | Emergent — skills auto-register as `$ultracode` / `/ultracode` | No separate command artifact needed. |

On **Qoder**, the native Workflow tool ships the same engine already — the pack rides it (skill + rule + `uc-*` templates) instead of replacing it.

## v1 scope (shipped)

In: engine (sandbox, dialect, journal/resume, budget, watchdogs), 5 backends (mock/codex/qoder/claude/gemini), CLI, MCP triad, codex+qoder+generic installers, worktree isolation, one-level nested workflows. Deferred: Windows, cursor/copilot/opencode/amp adapters, npm publish + marketplace repos (internal-first), MCP Tasks (unsupported by target hosts). Per-cut rationale: `docs/design/judge.md` (MILESTONES / V1 CUTS).

## What's proven

End-to-end on real backends: the `uc-review` workflow (3 dimension finders → per-finding adversarial verification → synthesis) run on **Codex** against `examples/sample-repo` found both planted auth bugs — with constructed exploit inputs as evidence — plus a real unplanted one (`examples/parity-demo-output.json`, 12 agents). A typed-schema workflow verified on **Claude**. Codex drove the full `workflow_start → status → result` MCP loop. 200+ offline tests (mock backend + golden fixtures) cover the dialect contract, sandbox bans, journal determinism, resume, structured-output, safety rails, all five adapters, worktree isolation, nested workflows, and the exec-layer hardening (O_NOFOLLOW writers, pgid kill-guard, resume path confinement).

## Related reading

- `docs/design/host-integration.md` — fuller per-host delivery detail (design history).
- `docs/design/judge.md` — the rulings behind this layering.
- `skill/ultracode/SKILL.md` — the doctrine layer itself.
