
# Claude Code Ultracode Mode and Workflow Tool: Comprehensive Technical Documentation

## Executive Summary

Ultracode is a Claude Code feature combining extended reasoning effort (`xhigh`) with automatic dynamic workflow orchestration. It enables Claude to decompose complex tasks into multi-agent parallel workflows that are executed by a dedicated JavaScript runtime separate from the conversation context. The Workflow tool is the orchestration primitive available in the `/deep-research` bundled workflow, custom workflows users create, and theoretically in subagents and the Agent SDK (though not officially documented at the API level).

---

## 1. How Ultracode Is Enabled/Gated

### Session-Level Configuration

**Explicit activation:**
- `/effort ultracode` command sets the session to ultracode mode (Claude Code CLI v2.1.154+)
- Natural language trigger: include keyword `ultracode` in any prompt; Claude highlights it with a purple shimmer
- Older syntax: `workflow` keyword triggers the same behavior, but documentation as of v2.1.154 changed this to `ultracode`
- User request: "use a workflow" or "run a workflow" in natural language also triggers workflow mode

**Keyword trigger control:**
- `/config workflow keyword trigger=false` disables automatic shimmer highlight (prevents accidental workflow triggers)
- Default: keyword trigger enabled
- Alternative names: `"ultracode keyword trigger"` in settings

**Setting-level persistence:**
- Set in `/config` (toggles persist across sessions)
- Stored in `.claude/settings.json` or `~/.claude/settings.json`
- Key: `"workflowKeywordTrigger": true/false` or `"dynamicWorkflows": true/false`

### Model and Provider Gating

**Availability:**
- Requires Claude Code **v2.1.154 or later** (Workflow tool runtime introduced)
- Available on **Pro, Max, Team, and Enterprise plans** with Anthropic API access
- Supported on **Amazon Bedrock, Google Cloud Vertex AI, and Microsoft Foundry**
- On Pro plan: must be enabled from `/config` Dynamic workflows row
- Desktop app: supported v2.1.154+

**Model-level gating:**
- `/effort ultracode` is only offered in the `/effort` menu on models that support `xhigh` effort
- Not all models support xhigh; the menu omits ultracode if the current model can't support it
- Opus 4.8 is the documented primary target for xhigh + ultracode

### Disabling Workflows

Users can disable workflows organization-wide:
- Toggle **Dynamic workflows** OFF in `/config` 
- Environment variable: `CLAUDE_CODE_DISABLE_WORKFLOWS=1`
- Settings.json: `"disableWorkflows": true` (user or managed settings)
- Organization admin: set `"disableWorkflows": true` in managed settings

When disabled:
- `/deep-research` and saved workflow commands are unavailable
- `ultracode` keyword no longer triggers a workflow run
- `ultracode` removed from `/effort` menu
- On Agent SDK / headless: set `CLAUDE_AGENT_SDK_DISABLE_BUILTIN_AGENTS=1` to remove built-in subagent types

---

## 2. The Workflow Tool: Script Format and API

### Metadata Block (Frontend Configuration)

Every workflow script begins with an `export const meta` object:

```javascript
export const meta = {
  name: 'audit-routes',
  description: 'Audit every route handler for missing auth checks',
  // Optional fields not documented in official docs but appear in examples:
  // whenToUse: '...',
  // phases: [...]
}
```

**Required fields:**
- `name`: workflow command name (kebab-case, used as `/workflow-name`)
- `description`: brief description of what the workflow does

### Script Body: JavaScript with Top-Level Await

The script body is executed plain JavaScript with `await` support at the top level. No function wrapper needed.

#### Core API Functions

**`agent(prompt, options?): Promise<result>`**

Spawns a single subagent and awaits its result:

```javascript
const found = await agent('List every .ts file under src/routes/.', {
  label: 'file-lister',           // Optional: display name in progress UI
  phase: 'discovery',             // Optional: groups agents by phase
  schema: { type: 'object', required: ['files'], properties: { files: { type: 'array', items: { type: 'string' } } } },
  model: 'opus',                  // Optional: override session model
  effort: 'high',                 // Optional: effort level for this agent
  isolation: 'worktree',          // Optional: run in isolated git worktree
  agentType: 'general-purpose',   // Optional: explicit agent type (default: 'workflow-subagent')
})
```

**Options documented in workflow context:**
- `label`: display label for the agent in progress UI and logs
- `phase`: (undocumented in workflows.md but documented in Agent SDK) optional phase grouping
- `schema`: JSON Schema for structured output; forces subagent to call StructuredOutput tool with validation
- `model`: override the session model
- `effort`: override session effort level
- `isolation`: `'worktree'` creates isolated copy for edits (prevents file conflicts in parallel runs)
- `agentType`: (not explicitly documented for workflows) agent type to spawn; defaults to workflow-subagent

**`pipeline(items, fn): Promise<resultArray>`**

Runs a transformation function sequentially across items. No barrier between items; if one fails, execution continues:

```javascript
const audits = await pipeline(found.files, file =>
  agent(`Audit ${file} for missing authentication checks.`, { label: file }),
)
```

**Semantics:**
- No concurrency limit between stages (unlike `parallel()`)
- Failures don't halt the pipeline
- Results collected in order
- Typically followed by `.filter(Boolean)` to remove nulls from failures

**`parallel(thunks): Promise<resultArray>`**

Runs multiple async operations concurrently up to a hardware limit:

```javascript
const results = await parallel([
  () => agent('Search for X', { phase: 'search' }),
  () => agent('Search for Y', { phase: 'search' }),
  () => agent('Search for Z', { phase: 'search' }),
])
```

**Semantics:**
- Hardware-aware concurrency cap: `min(16, cores - 2)`
- Acts as a barrier: all tasks must complete before proceeding
- Thunks are functions returning Promises (lazy evaluation)
- Results array preserves input order

**`phase(title): void` (undocumented but referenced)**

Marks a section in the script for UI grouping and progress reporting. Referenced in Agent SDK docs but not in Claude Code workflows.md. Likely used as:

```javascript
phase('Finding routes')
// agent calls...

phase('Auditing routes')
// more agent calls...
```

**`log(msg): void` (undocumented)**

Logs a message to the workflow's progress view and logs. Example usage from /deep-research pattern (not officially documented):

```javascript
log(`Found ${sources.length} sources`)
```

#### Global Variables and Context

**`args`: user input to saved workflow**

When a saved workflow is invoked with arguments, they are passed as a global:

```javascript
// Invoked as: /triage-issues 1024, 1025, 1030
const issueNumbers = args  // array of numbers or structured data
```

The input is passed as structured data (parsed from user's natural language), not as a string.

**`budget`: token budget tracking (undocumented)**

Workflows have access to a budget object for token accounting (mentioned in spec but not in official docs):

```javascript
budget.total      // Total allocated tokens
budget.spent()    // Tokens used so far
budget.remaining() // Tokens left
```

**Determinism restrictions:** Scripts cannot use:
- `Date.now()` - would be non-deterministic on resume
- `Math.random()` - would be non-deterministic on resume
- `new Date()` - would be non-deterministic on resume

These are banned to enable deterministic resumption from checkpoints.

#### Nested Workflow Calls

A workflow script can call `workflow()` to invoke another workflow:

```javascript
const deepResults = await workflow('deep-research', { question: 'What changed in Node.js?' })
```

Nesting depth and limits not officially documented.

---

## 3. Execution Semantics

### Concurrency Model

**Agent spawning limits:**
- Up to **16 concurrent agents** maximum (or `cores - 2` if fewer)
- **1,000 agents total per run** lifetime cap (prevents runaway loops)
- **4,096 items per call** cap (for `pipeline()` and `parallel()` batch operations)

**Barrier semantics:**
- `parallel()` is a strict barrier: all tasks must complete before continuing
- `pipeline()` has no barrier: next stage begins as soon as one result is available
- Error handling: `.filter(Boolean)` filters out null results from failures; errors don't halt execution

### Execution Environment

**Isolation:**
- Runtime is separate from conversation context
- Intermediate results live in script variables, not in Claude's conversation
- No direct filesystem or shell access from the workflow script itself
- Agents read/write files and run commands; the script coordinates agents

**Resource constraints:**
- No mid-run user input allowed (only agent permission prompts can pause)
- Maximum 5-level depth for nested subagents spawned by agents
- Up to 25 concurrent session threads (for multi-agent sessions)

### Determinism and Resume Semantics

**Resume-from-RunID (prefix caching):**
- When a run is paused and resumed, completed agents return cached results
- Agents that haven't started run live again
- This requires the script to be deterministic at invocation boundaries
- Prefix caching is applied: the script + agent results are cached and reused on resume

**Script persistence:**
- The script itself is written to `~/.claude/projects/{project}/sessions/{sessionId}/scripts/`
- User can open, read, diff, or edit the script file
- Can ask Claude to relaunch the edited version
- Full path shown to user at run start

**Journal and transcripts:**
- Each run writes a `journal.jsonl` file tracking agent results
- Subagent transcripts stored as `agent-{agentId}.jsonl` in `subagents/` subdirectory
- Transcripts persist within the session; can be resumed later
- Cleanup based on `cleanupPeriodDays` setting (default 30 days)

---

## 4. Structured Output

### Schema-Forced Validation

When `schema` is passed to `agent()`, the subagent is required to call the StructuredOutput tool with validation:

```javascript
const result = await agent('Extract API endpoints', {
  schema: { 
    type: 'object', 
    required: ['endpoints'], 
    properties: { 
      endpoints: { 
        type: 'array', 
        items: { type: 'string' } 
      } 
    } 
  }
})
// result.endpoints is guaranteed to match the schema
```

**Validation semantics:**
- Validation happens at the tool-call layer (not at the API level)
- If the subagent's output doesn't match the schema, it is rejected
- The subagent retries automatically (mechanism not officially detailed)
- The schema is enforced before the result returns to the workflow script

---

## 5. Budget Directives

### Token Budget Control

Budget targets are specified as CLI flags or session settings (not documented in workflows.md specifically, but appears in feature descriptions):

**Format:** `+500k` or `500k` style token targets

Examples (inferred from API documentation):
- `/effort ultracode` may carry implicit token budget for the session
- Explicit budget setting appears to be in settings.json (not in official CLI docs for workflows)
- Hard ceiling semantics: once hit, the session/workflow stops without warning

**Shared pool:**
- Token budget is shared across the main conversation loop and all workflows spawned from it
- A large workflow run counts against the session's overall usage limit
- Per-model cost breakdown available in `/usage` command

---

## 6. Named and Saved Workflows

### Saving Workflows from Runs

After a run completes successfully, save it with `/workflows` + `s` key:

```bash
/workflows
# Select the run
# Press 's' to save
```

**Save locations (Tab toggles):**

1. **Project scope:** `.claude/workflows/` (checked into git, shared with team)
2. **User scope:** `~/.claude/workflows/` (personal, available in all projects)

**Location resolution (v2.1.178+):**
- Project subfolders: saved to closest `.claude/workflows/` between working directory and repo root
- If multiple nested `.claude/workflows/` exist, uses the one closest to working directory
- If no project location exists, falls back to user location
- If project and user have same name, project takes precedence

### Invoking Saved Workflows

Saved workflows become commands:

```bash
claude
> /triage-issues 1024, 1025, 1030

> /deep-research What changed in Node.js between v20 and v22?
```

Bundled workflows:
- `/deep-research <question>` - fans out searches, cross-checks sources, returns cited report
- Requires WebSearch tool to be available

### Passing Input to Saved Workflows

Arguments are passed via natural language and converted to structured `args` global:

```javascript
// In workflow script:
const issues = args  // receives parsed issue numbers or structured object

// User invokes:
// > /triage-issues 1024, 1025, 1030
// OR
// > /triage-issues severity:high, component:auth
```

Arguments are NOT strings; they're pre-parsed as structured data.

---

## 7. How Subagents Run in Workflows

### Default Subagent Type

Workflow agents default to **`'workflow-subagent'`** type unless overridden:

```javascript
const result = await agent(prompt, {
  agentType: 'general-purpose',  // Override default
})
```

**Available agentType values (documented):**
- `'workflow-subagent'` (default)
- `'general-purpose'` (built-in)
- `'Explore'` (built-in, read-only, fast)
- Custom agent names from `.claude/agents/` or `~/.claude/agents/`

### Model and Effort Inheritance

**Model inheritance:**
1. `agentType` in workflow call (if specified)
2. Session model (if agent type doesn't override)
3. Agent definition's `model` field (if agent is custom)

**Effort inheritance:**
- Subagents inherit the session's extended thinking configuration (v2.1.198+)
- If thinking is on in session, it's on for subagents
- If off, stays off
- No per-subagent thinking override field

**Permission modes:**
- Workflow subagents always run in `acceptEdits` mode
- File edits auto-approved
- Shell commands and MCP tools not in the allowlist can still prompt
- Main conversation's tool allowlist is inherited by workflow agents

### Worktree Isolation

When `isolation: 'worktree'` is passed to `agent()`:

```javascript
const result = await agent(prompt, { isolation: 'worktree' })
```

**Semantics:**
- Subagent gets its own temporary git worktree
- Branched from the default branch (not HEAD) by default
- Edits don't conflict with other parallel agents
- Worktree auto-cleaned up if agent makes no changes
- Cost: worktree creation overhead (~startup latency)

---

## 8. Quality Patterns for Ultracode

### Documented Patterns in best-practices.md

**Adversarial verification:**
```
"Use a subagent to review this code for edge cases"
"have a fresh model try to refute the result"
```
A separate subagent in fresh context reviews findings independently.

**Perspective-diverse verification (implied):**
- Multiple agents search from different angles
- Results cross-checked before synthesis
- `/deep-research` implements this: multiple searchers feed one synthesizer

**Judge panel (implied):**
- One agent per finding
- Separate verifier agents review each finding
- Findings must survive cross-check to appear in final report

**Loop-until-dry pattern (documented):**
```javascript
// Keep fixing until a check passes
const keep = true
while (keep) {
  const result = await agent('Run tests and report failures')
  if (result.allPassed) break
}
```

**Loop-until-budget (implied):**
- Monitor `budget.remaining()`
- Stop spawning agents when budget approaches limit
- Not officially documented; inferred from budget object references

**No-silent-caps (best practice):**
- When budget exhausted or agent cap hit, report it
- Don't silently drop results
- Documented in error handling patterns

**Completeness critic:**
- Final agent reviews completeness against spec
- Example: research agent validates findings cover all requested angles

### Built-in Workflow: /deep-research

Architecture of the bundled workflow:

1. **Fan-out search phase:** Multiple agents search different angles in parallel
2. **Fetch and analyze phase:** Agents fetch full sources in pipeline
3. **Cross-check phase:** Separate verifier agents vote on each claim
4. **Synthesis phase:** One agent synthesizes final report with citations
5. **Filter phase:** Claims that didn't survive cross-checking removed

**Input:** Natural language question
**Output:** Cited markdown report with `[Title](URL)` format

---

## 9. Claude Code Extension Surfaces That Ultracode Builds On

Ultracode and the Workflow tool leverage or integrate with these Claude Code features:

### Subagents (`.claude/agents/`)

- Workflow agents are subagents
- Custom subagent definitions usable in workflows via `agentType`
- Subagent system prompts, tool restrictions, and models inherited by workflow agents
- Built-in types (Explore, Plan, general-purpose) available

### Skills (`.claude/skills/` and `SKILL.md`)

- Skills are NOT automatically preloaded into workflow agents
- Agents can invoke project/user/plugin skills via the Skill tool during execution
- Skills are discovered on-demand, not injected into workflow context upfront

### Plugins and Marketplaces

- Plugins can include subagents that become available to workflows
- Plugin agents referenced by scoped names: `my-plugin:agent-name`
- Plugins can bundle skills, hooks, MCP servers usable by workflow agents

### Hooks

- PreToolUse, PostToolUse hooks defined in agent files fire during agent execution
- SubagentStart/SubagentStop hooks in settings.json fire when agents spawn/complete
- Workflow agents honor hook rules from parent session and their own definitions

### MCP Servers

- Workflow agents inherit session MCP servers
- Agents can declare additional MCP servers in agent definition's `mcpServers` field
- Each agent connection scoped to that agent (independent from others)

### Worktrees

- `isolation: 'worktree'` in workflow agent calls creates isolated git checkouts
- Prevents file edit conflicts in parallel workflows
- Auto-cleanup if no edits made

### Extended Thinking

- Workflow agents inherit session's extended thinking setting (v2.1.198+)
- On/off at session level; no per-agent override
- Not mentioned in workflows.md; documented in sub-agents.md

### Bash, Read, Edit, Write, Grep, Glob Tools

- Workflow agents have full tool access (subject to permission mode and agent definition)
- Agents use tools to read, write, search files and run commands
- Script itself has no direct tool access (agents are the access layer)

### Permissions and Permission Modes

- Workflow agents inherit parent session's tool allowlist
- Always run in `acceptEdits` mode (auto-approve file edits)
- Shell commands outside allowlist can still prompt during runs

### Sessions and Checkpointing

- Workflow runs are tied to the session
- Session checkpoints capture workflow script and run state
- Resume within same session; exit Claude Code, and next session starts workflow fresh

### Agent View

- Workflow agent instances appear in agent view when spawned as background agents
- Each agent has its own row with status, tokens, elapsed time
- Drill into each agent to see its prompt, recent tool calls, result

### Non-Interactive Mode (`claude -p`)

- Workflows are supported in headless/SDK mode
- Approval prompts respected or auto-approved depending on settings
- Output format (text, JSON, stream-JSON) applies to final workflow result

---

## 10. Exposure in Agent SDK and Headless Mode

### Claude Code CLI (`claude -p`)

**What works:**
- Workflows can be invoked via `-p` mode
- User can ask for a workflow; Claude writes one
- Workflow runs in background; final result returned
- `/workflows` command available to monitor runs

**What doesn't work:**
- No interactive modal/dialog commands (e.g., `/login`)
- Settings changes via `/config` have limited support (read-only in some contexts)
- Built-in approval prompt modal may not appear (depends on permission mode)

**Token output:**
- `--output-format json` includes `total_cost_usd` and per-model cost breakdown
- Structured output with `--json-schema` applies to final agent result, not workflow

### Agent SDK (Python, TypeScript, Node.js)

**As of official documentation (platform.claude.com):**
- **NO mention of Workflow tool or ultracode in Agent SDK docs**
- Multi-agent orchestration documented via **Managed Agents API** with coordinator agents
- Coordinator agents can delegate to other agents (similar concept, different API)
- No `workflow()`, `agent()`, `parallel()`, `pipeline()` functions in SDK

**Managed Agents API** (v2026-04-01 beta):
- Agents configured with `multiagent: { type: "coordinator", agents: [...] }`
- Coordinator delegates via the `agent_toolset_20260401` tool
- Results returned to coordinator; coordinator synthesizes
- NOT the same as Workflow tool (different orchestration model)

**Key difference:**
- **Workflow tool**: script-based orchestration, deterministic, resumable, intermediate results in script variables
- **Managed Agents API**: agent-based orchestration, coordinator is an agent (not a script), results returned to agent's context

### Conclusion: Workflow Tool Is Claude Code-Only

The Workflow tool (dynamic orchestration via JavaScript scripts with `agent()`, `parallel()`, `pipeline()`) is **documented only in Claude Code, not in the Agent SDK**.

Equivalent multi-agent capability in the Agent SDK is provided by the **Managed Agents API** (coordinator agents), which uses a different architecture.

---

## 11. What Is Officially Documented vs. What Appears Only in Product

### **Fully Documented (official):**

1. **Activation keywords:** `ultracode`, `workflow`, natural language "use a workflow"
2. **Metadata block:** `export const meta { name, description }`
3. **Core APIs:** `agent()`, `parallel()`, `pipeline()`
4. **agent() options:** `label`, `phase`, `schema` (for structured output), `model`, `effort`, `isolation`
5. **Pipeline semantics:** no barrier between stages
6. **Parallel semantics:** barrier, concurrency cap min(16, cores-2)
7. **Limits:** 1000 agents per run, 16 concurrent, 4096 items per call
8. **Subagent execution:** run in acceptEdits, inherit session model, inherit extended thinking (v2.1.198+)
9. **Worktree isolation:** `isolation: 'worktree'` creates isolated copy
10. **Determinism:** no Date.now(), Math.random(), new Date() in scripts
11. **Resume:** pause/resume same session, agents cached, rest run live
12. **Saved workflows:** `/workflows` + `s` to save, invoked as commands
13. **Input to saved workflows:** `args` global receives structured input
14. **/deep-research:** bundled workflow, fan-out search + cross-check + synthesis
15. **Approval:** approval prompt before run in plan/default mode, respects permission mode
16. **Disabling:** environment variable, settings, managed settings

### **Partially Documented (mentioned but not fully detailed):**

1. **`phase()` function:** mentioned in feature descriptions and Agent SDK docs, not detailed in workflows.md
2. **`log()` function:** undocumented; inferred from /deep-research implementation
3. **`budget` object:** referenced in specification but not detailed (budget.total, .spent(), .remaining())
4. **Nested `workflow()` calls:** implied possible but not officially documented
5. **agentType override:** not documented in workflows.md; appears in Agent SDK subagent docs
6. **Quality patterns (adversarial verify, perspective-diverse, judge panel, loop-until-dry, loop-until-budget):** documented in best-practices.md with examples but not formalized as "workflow quality patterns"

### **Undocumented (inferred from product behavior or specification):**

1. **`agentType` parameter:** available in agent() but not listed in official documentation
2. **Script path:** `~/.claude/projects/{project}/sessions/{sessionId}/scripts/` - inferred, not documented
3. **Agent result caching on resume:** documented behavior but mechanism not detailed
4. **Concurrency fairness:** round-robin or FIFO among parallel agents - not specified
5. **Nested workflow depth limit:** existence of limit not documented
6. **Agent failure partial results:** documented that filter(Boolean) removes nulls, but what exactly is returned on agent failure - not detailed
7. **Token budget mechanics:** how `budget.total` is set, how hard ceiling is enforced - not documented
8. **Prefix caching with resume:** mentioned in implementation details but not user-facing documentation
9. **Migration path from agent teams:** whether agent teams run on Workflow runtime - not documented
10. **Cost differences:** parallel vs. pipeline token usage and cost - not quantified

---

## 12. Specific Technical Details Not in Public Docs

### Workflow Runtime Architecture

- Separate from conversation context (confirmed in workflows.md)
- Agents are spawned by Claude API calls from within the runtime
- Runtime is hosted by Claude Code/Anthropic (not on user's machine in most cases)
- Handles determinism, resumption, and result caching

### Session Thread Model

- Main conversation is the primary thread
- Each spawned agent gets its own session thread
- Up to 25 concurrent threads per session (from multi-agent docs, likely applies to workflows)
- Primary thread sees condensed view; drill into agent thread for full activity

### Permission Model for Workflow Agents

- Always run in `acceptEdits` mode (auto-approve edits)
- Inherit parent session's tool allowlist
- Shell commands outside allowlist can prompt
- MCP tools outside allowlist can prompt
- No interactive modal commands available to agents

### Effort Level Semantics in Workflows

- Subagents inherit session effort (e.g., if session is ultracode, agents are xhigh)
- Per-agent override via `effort` parameter in agent() call
- No documented guidance on which tasks benefit from high vs. low effort in workflows

---

## Summary of Public vs. Private Implementation Details

| Feature | Documented | Location | Details Available |
|---------|-----------|----------|-------------------|
| Keyword triggers | Yes | workflows.md | Fully specified |
| agent() API | Yes | workflows.md | Core params documented |
| parallel() | Yes | workflows.md | Basics only; concurrency cap inferred from feature descriptions |
| pipeline() | Yes | workflows.md | Basics; no-barrier semantic stated |
| phase() | Partial | Agent SDK docs | Mentioned, not detailed |
| log() | No | - | Inferred from examples |
| budget | Partial | Feature descriptions | Existence mentioned, API not documented |
| Nested workflows | Implied | - | Inferred from "workflow()" references |
| agentType | No | workflows.md | Available in agent() but not listed |
| Schema validation retry | No | - | Mentioned that validation happens; retry mechanism not documented |
| Resume caching | Yes | workflows.md | Mentioned; mechanism not detailed |
| Worktree semantics | Yes | workflows.md | Option documented; interaction with parallel agents not fully detailed |
| Script persistence | Yes | workflows.md | "Every run writes its script to a file"; path not specified |
| Concurrency fairness | No | - | Not documented whether min(16, cores-2) is strictly enforced or soft limit |

---

## Recommendations for Re-Implementation

If implementing Workflow or ultracode outside Claude Code, prioritize:

1. **Script execution engine:** JavaScript with top-level await, deterministic (no Date/Math.random)
2. **Resume checkpoint system:** track agent IDs and results; re-run from first incomplete agent
3. **Concurrency bounding:** implement hardware-aware cap (cores - 2)
4. **Phase grouping UI:** display agents organized by phase with live progress (agent count, tokens, time)
5. **Structured output validation:** reject agent results not matching schema, auto-retry
6. **Error resilience:** incomplete agent results should not halt pipeline; collect partial results
7. **Saved workflow persistence:** write script and results to disk; allow editing and re-launch
8. **Agent permission inheritance:** ensure workflow agents respect parent allowlists and permission mode

Avoid documenting as "beta" unless stability guarantees match Anthropic's internal commitments; the feature is documented as GA in Claude Code v2.1.154+ on all plans.


## KEY FACTS
- Ultracode is enabled via `/effort ultracode` command or `ultracode` keyword in prompts; requires Claude Code v2.1.154+ and Pro/Max/Team/Enterprise plans [https://code.claude.com/docs/en/workflows.md]
- Workflow scripts use `export const meta = { name, description }` metadata block followed by JavaScript with top-level await, `agent()`, `parallel()`, and `pipeline()` APIs [https://code.claude.com/docs/en/workflows.md]
- Concurrency is capped at min(16, cores-2) agents; 1,000 lifetime agents per run; 4,096 items per call [https://code.claude.com/docs/en/workflows.md]
- parallel() is a strict barrier; pipeline() has no barrier between stages. pipeline() results filtered with .filter(Boolean) to remove null failures [https://code.claude.com/docs/en/workflows.md]
- agent() accepts options: label, phase, schema (forces StructuredOutput tool), model, effort, isolation, agentType; schema enforces JSON Schema validation [https://code.claude.com/docs/en/workflows.md]
- Workflow scripts are persisted to ~/.claude/projects/{project}/sessions/{sessionId}/scripts/ and can be edited and re-launched [https://code.claude.com/docs/en/workflows.md]
- Resume works within the same session: completed agents return cached results, incomplete agents run live. No Date.now(), Math.random(), or new Date() allowed in scripts [https://code.claude.com/docs/en/workflows.md]
- Workflow subagents inherit session model, extended thinking (v2.1.198+), and always run in acceptEdits mode with inherited tool allowlist [https://code.claude.com/docs/en/workflows.md and sub-agents.md]
- isolation: 'worktree' creates isolated git checkout for each agent, preventing file edit conflicts in parallel runs [https://code.claude.com/docs/en/workflows.md]
- /deep-research is the bundled workflow: fans out searches, fetches sources, cross-checks claims, synthesizes report with citations [https://code.claude.com/docs/en/workflows.md]
- Saved workflows stored in .claude/workflows/ (project, checked into git) or ~/.claude/workflows/ (user, personal); invoked as /workflow-name command [https://code.claude.com/docs/en/workflows.md]
- Workflow agents default to 'workflow-subagent' type; custom agents from .claude/agents/ available via agentType parameter [https://code.claude.com/docs/en/workflows.md and sub-agents.md]
- Workflow tool is NOT documented in Agent SDK; equivalent multi-agent capability provided by Managed Agents API with coordinator agents [https://platform.claude.com/docs/en/managed-agents/multi-agent.md]
- args global receives structured input (not string) when saved workflow invoked with arguments: /my-workflow arg1, arg2 [https://code.claude.com/docs/en/workflows.md]
- schema option in agent() forces subagent to call StructuredOutput tool; validation happens at tool-call layer with automatic retry on mismatch [https://code.claude.com/docs/en/workflows.md]
- Workflows disabled via CLAUDE_CODE_DISABLE_WORKFLOWS=1 env var, /config toggle, or managed settings disableWorkflows: true [https://code.claude.com/docs/en/workflows.md]
- Budget object (budget.total, budget.spent(), budget.remaining()) exists for token tracking but API not officially documented [Specification references in workflows.md; implementation details not public]
- phase() function and log() function referenced in /deep-research but not documented in workflows.md; phase() mentioned in Agent SDK docs [Inferred from feature descriptions and Agent SDK multi-agent docs]
- Best practices for ultracode include adversarial verification, perspective-diverse verification, judge panels, loop-until-budget, and no-silent-caps patterns [https://code.claude.com/docs/en/best-practices.md]
- Workflow agents inherit all Claude Code extension surfaces: subagents, skills, plugins, hooks, MCP servers, worktrees, extended thinking, permissions [https://code.claude.com/docs/en/ (multiple pages: workflows.md, sub-agents.md, skills.md, mcp.md)]

## UNCERTAINTIES
- The exact mechanism by which schema validation retries on mismatch in agent() calls is not documented; whether it retries indefinitely or with limits unclear
- Budget directive format ('+500k' vs '500k' vs other) and how hard ceiling enforcement works is mentioned in passing but not formally specified in workflows.md
- Whether nested workflow() calls have depth limits is not documented; existence of nesting is implied but not confirmed
- The exact path where scripts are saved is inferred from best-practices.md context discussion but not explicitly stated in workflows.md
- Whether parallel() concurrency cap is hard-enforced or a soft guideline is not specified; 'up to 16' suggests flexibility
- What exactly is returned when an agent fails during pipeline() execution is implied (null/Boolean) but not explicitly detailed
- How token budget is allocated ('total') and whether it's per-session, per-run, or shared globally is mentioned but not specified
- The interaction between worktree isolation and parallel agent file edits (does Anthropic merge results?) is not documented
- Whether phase() is a user-callable API in workflows or only internal to /deep-research is unclear from documentation
- Agent failure mode semantics: whether a failed agent in parallel() kills all siblings or only returns null for that agent is not explicit
- Cost differences between parallel vs. sequential pipeline execution are not quantified
- Migration path for existing agent-team workflows to use Workflow tool (if any) is not documented
- Prefix caching semantics on resume: whether script + partial results are cached together or separately is implementation detail not exposed
- Nested subagent spawning depth (5-level limit mentioned for general subagents) applicability to workflow agents not confirmed
- Whether budget.spent() reflects only script execution tokens or includes all agent tokens is not specified