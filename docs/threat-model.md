# Threat model

Current shipped behavior (v0.1.x). Where this document conflicts with the design history in `docs/design/`, this document supersedes it — in particular, the OAuth-detecting concurrency clamp described there was deliberately not implemented (see "Concurrency and backend auth").

## Trust model and the sandbox

Workflow scripts are **trusted input** — model-authored and user-reviewed before running (`ultracode run` prints a summary — name, phases, static `agent()` inventory, backend/permission/budget — and asks for confirmation, which `--yes` skips; reading the script source is a separate, manual step; `--dry-run` rehearses on a mock backend). The `node:vm` sandbox — frozen intrinsics, banned entropy, no fs/net/shell/require, host globals re-wrapped so `.constructor` can't directly reach the host `Function` — is a capability-scoping and determinism device, **not** a hostile-code boundary. Values the host hands back (Promises, timer handles, JSON-parsed results) still expose host-realm constructors, and node:vm cannot preempt a synchronous loop that runs after an `await` (a hung run is killed externally via `ultracode stop`, which SIGKILLs the runner). A genuinely malicious script can therefore escape or hang the runner; true isolation would need a separate OS process (future work). Note `workflow_start` over MCP runs scripts with **no interactive gate**, so only feed it scripts you authored/reviewed. The only sanctioned side-effect channel is `agent()`, and every agent is a subprocess governed by the host CLI's own sandbox. Spawned workers default to the write-scoped `auto` tier — on Codex that is the `workspace-write` OS sandbox; on Claude/Qoder/Gemini it maps to approval modes (`acceptEdits` / `accept_edits` / `auto_edit`), which are policy gates in the host CLI rather than OS sandboxes — and the engine never passes `--yolo` / `danger-full-access` **below the `danger` tier**; `--permission danger` deliberately removes even that (Codex `danger-full-access`, Gemini `--yolo`, Claude/Qoder bypass modes). Do not run workflow scripts you haven't read.

## Concurrency and backend auth

Fan-out concurrency is user-controlled: the default is `min(10, max(2, cores - 2))`, the `ULTRACODE_MAX_CONCURRENCY` env var overrides the default, and an explicit `--max-concurrency` (CLI) or `maxConcurrency` (MCP `workflow_start`) wins over both. The engine never adjusts concurrency based on backend auth; `ultracode doctor` reports each backend's auth mode. The chosen value is stored in the run's config at creation, so a resume inherits it unless overridden explicitly (`resume --max-concurrency` or MCP `maxConcurrency`). Codex: `CODEX_API_KEY` is the parallel-safe auth (ChatGPT-plan OAuth shares one rotating refresh token across workers). Qoder: `QODER_PERSONAL_ACCESS_TOKEN` is stateless and parallel-safe.

## The worker-writable run store

The run store (`.ultracode/runs/**`) lives inside the workspace, so a prompt-injected agent that processes hostile repo content runs as the same user and *can* write there. Artifact writes are `O_NOFOLLOW` (a pre-planted symlink leaf can't redirect them; directory-component symlinks are out of scope), other backends' credentials are scrubbed from each worker's env, and recovery accepts only a bounded set of small regular process records. New records use fixed sequence/attempt paths, so worker-created directory entries cannot hide a sibling record; bounded `agents/**/pgid*` discovery remains only for compatibility. Live pre-token groups from that legacy layout are reported as requiring manual cleanup rather than signaled without authentication. A token-only record is written before spawn and atomically enriched afterward. A persisted process group is signaled only when its live leader matches the recorded OS start-time **and** carries the record's high-entropy lifecycle token plus the expected filesystem-backed run-scope digest in its initial environment. Linux reads those markers and process identity from `/proc`; macOS subtracts a separately queried untruncated argv field from the environment-expanded command, checks only recorded worker leaders through bounded explicit-PID `/bin/ps` queries, and uses `lstart` as the process-instance identity.

Linux additionally scans same-user procfs entries for token-plus-scope matches, which contains Codex/bwrap descendants that leave the original process group. This sweep is deliberately fail-closed and limited: it cannot discover a process whose `/proc/<pid>/environ` is unreadable, a descendant hidden from the runner's PID namespace, a descendant that replaced or sanitized away either lifecycle marker before leaving the PGID, or a process on a host without procfs. macOS therefore has no host-wide token sweep; normal settlement still reaps the known process group, while persisted recovery requires a live authenticated leader. Repeated settlement sweeps permanently stop targeting a numeric PGID once it is observed absent, preventing a later reused group from becoming a target. On macOS, descendants that call `setsid()`, change PGID, or daemonize may escape cleanup; this is an accepted limitation, and recovery does not enumerate the host to find them.

The synchronous uncaught-exception monitor signals only worker identities held in the runner's trusted memory; it never parses the worker-writable recovery store. Handled runner failures, hard-stop, and external stop paths can await the bounded persisted-record recovery described above.

These controls protect signaling decisions made from worker-writable records, but they are **not** a general boundary against arbitrary same-user code. In particular, **`resume` re-executes `script.js`/`config.json` from that worker-writable dir with no review gate** — so a poisoned prior run can influence a later resume (including its `permission`). Treat resuming an untrusted run as running its inputs. Two known replay caveats: a `pipeline()` whose later-stage dispatch order depends on completion timing can lose its cache prefix on resume, and fallback token estimates (no-usage backends) are approximate. Full isolation (control-plane outside the workspace and a separate-process sandbox) is future work.

## Benchmark harness boundaries

The benchmark control plane treats task repositories, task containers, and
native runner output as untrusted producers. Private host-owned manifests,
hash-chained run state, and verifier receipts live outside task workspaces. A
score is accepted only when a receipt binds the exact official-evaluator bytes,
digest, invocation, task/arm scope, role, and native record key. A successful
agent process or a lookalike output file is never score authority.

### SWE-Marathon

SWE-Marathon repository-controlled task code shares a security domain with the
reusable Codex credential needed for that session. The harness does not
intentionally serialize its credential source, but cannot prevent malicious task
code from reading, exfiltrating, logging, or persisting a live credential.
Operators must use disposable, narrowly scoped benchmark accounts and
independently restricted egress, then revoke credentials and treat all streamed
output and retained artifacts as sensitive until scanned.

Prepared Harbor and native bridge assets are content-addressed and must match
their tracked hashes at launch. Container labels and ephemeral credential-home
markers include a canonical run-root scope, preventing equal run/task names in
different worktrees from claiming one another's resources on a shared Docker
daemon. Resume accepts only the exact native job config previously bound to the
manifest-scoped receipt; redo starts from the immutable plan while retaining the
old native tree for cumulative paid-usage accounting. Incomplete verifier output
never becomes score evidence, but an identity-valid trial config is sufficient
to retain telemetry after a crash. Arm B uses the engine's effective status and
copies artifacts only after every run reaches a resumable terminal state;
orphaned or cleanup-failed runs trigger bounded stop/recovery instead of being
treated as settled.

### SWE-bench Pro

Prepared evaluator sources, Python artifacts, dataset rows, task images,
native patches, prompt policy, container policy, and control-plane sources are
pinned or content-addressed and re-attested at launch. Dataset acquisition
verifies the complete configured canonical-row digest before replacing the
cache. The initial Pro pin records integrity against one local capture but has
no retained upstream-commit or independent-reproduction evidence; it is not an
audited provenance claim.
The official evaluator remains trusted for score semantics, but missing,
malformed, stale, or policy-invalid evidence remains unverified.

Task sessions have no direct provider credential, auth file, generic proxy, or
default/WAN network. Each container is created stopped so the host can verify
its immutable image, labels, exact trusted gate command, user, mounts,
capability/resource policy, healthcheck, sanitized environment, and configured
network before startup. Docker then starts only a pinned musl loader and
BusyBox gate; the host re-verifies the running attachment and complete internal
topology before releasing its nonce. The only infrastructure endpoint on that
bridge is a separately operated immutable-image Responses relay. The relay may
retain an explicitly attested upstream attachment; task endpoints may not. A
host-wide policy lock serializes transport inspection, sessions, recovery,
evaluation, and cleanup across worktrees.

The relay proof binds the inspected endpoint inventory, container identity,
image, command, mounts, public identity/version, model, fixed destination, and
strict request contract. It does not prove that the relay image truthfully
implements its labels, that its upstream egress is correctly restricted, or
that the provider returns a particular information source. The Docker daemon,
host networking, relay implementation and credential scope, and provider are
trusted operator components. Missing or drifted topology or identity fails the
run closed.

Session containers use `no-new-privileges`, bounded processes, manifest-bound
CPU and memory, and a minimal immutable-setup capability tuple that is dropped
before Codex or task code runs. Evaluator containers use the same resource and
privilege bounds with no added capabilities. Container cleanup filters by the
complete ownership label tuple and reinspects identity before deletion; it
refuses ambiguous or unowned resources.

## Related reading

- `docs/design/minimalist-risk.md` — the historical risk register the shipped mitigations grew from (parts superseded by this document).
- `skill/ultracode/references/dialect.md` — caps, timeouts, and concurrency overrides as workflow authors see them.
- `SUPPORTED_VERSIONS.md` — pinned host CLI versions, platform notes, live-test gate.
