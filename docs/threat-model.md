# Threat model

Current shipped behavior (v0.1.x). Where this document conflicts with the design history in `docs/design/`, this document supersedes it — in particular, the OAuth-detecting concurrency clamp described there was deliberately not implemented (see "Concurrency and backend auth").

## Trust model and the sandbox

Workflow scripts are **trusted input** — model-authored and user-reviewed before running (`ultracode run` prints a summary — name, phases, static `agent()` inventory, backend/permission/budget — and asks for confirmation, which `--yes` skips; reading the script source is a separate, manual step; `--dry-run` rehearses on a mock backend). The `node:vm` sandbox — frozen intrinsics, banned entropy, no fs/net/shell/require, host globals re-wrapped so `.constructor` can't directly reach the host `Function` — is a capability-scoping and determinism device, **not** a hostile-code boundary. Values the host hands back (Promises, timer handles, JSON-parsed results) still expose host-realm constructors, and node:vm cannot preempt a synchronous loop that runs after an `await` (a hung run is killed externally via `ultracode stop`, which SIGKILLs the runner). A genuinely malicious script can therefore escape or hang the runner; true isolation would need a separate OS process (future work). Note `workflow_start` over MCP runs scripts with **no interactive gate**, so only feed it scripts you authored/reviewed. The only sanctioned side-effect channel is `agent()`, and every agent is a subprocess governed by the host CLI's own sandbox. Spawned workers default to the write-scoped `auto` tier — on Codex that is the `workspace-write` OS sandbox; on Claude/Qoder/Gemini it maps to approval modes (`acceptEdits` / `accept_edits` / `auto_edit`), which are policy gates in the host CLI rather than OS sandboxes — and the engine never passes `--yolo` / `danger-full-access` **below the `danger` tier**; `--permission danger` deliberately removes even that (Codex `danger-full-access`, Gemini `--yolo`, Claude/Qoder bypass modes). Do not run workflow scripts you haven't read.

## Concurrency and backend auth

Fan-out concurrency is user-controlled: the default is `min(10, max(2, cores - 2))`, the `ULTRACODE_MAX_CONCURRENCY` env var overrides the default, and an explicit `--max-concurrency` (CLI) or `maxConcurrency` (MCP `workflow_start`) wins over both. The engine never adjusts concurrency based on backend auth; `ultracode doctor` reports each backend's auth mode. The chosen value is stored in the run's config at creation, so a resume inherits it unless overridden explicitly (`resume --max-concurrency` or MCP `maxConcurrency`). Codex: `CODEX_API_KEY` is the parallel-safe auth (ChatGPT-plan OAuth shares one rotating refresh token across workers). Qoder: `QODER_PERSONAL_ACCESS_TOKEN` is stateless and parallel-safe.

## The worker-writable run store

The run store (`.ultracode/runs/**`) lives inside the workspace, so a prompt-injected agent that processes hostile repo content runs as the same user and *can* write there. Artifact writes are `O_NOFOLLOW` (a pre-planted symlink leaf can't redirect them; directory-component symlinks are out of scope), other backends' credentials are scrubbed from each worker's env, and recovery accepts only a bounded set of small regular process records. New records use fixed sequence/attempt paths, so worker-created directory entries cannot hide a sibling record; bounded `agents/**/pgid*` discovery remains only for compatibility. Live pre-token groups from that legacy layout are reported as requiring manual cleanup rather than signaled without authentication. A token-only record is written before spawn and atomically enriched afterward. A persisted process group is signaled only when its live leader matches the recorded OS start-time **and** carries the record's high-entropy lifecycle token plus the expected filesystem-backed run-scope digest in its initial environment. Linux reads those markers and process identity from `/proc`; macOS subtracts a separately queried untruncated argv field from the environment-expanded command, checks only recorded candidate leaders through bounded, adaptively split `/bin/ps` queries, and uses `lstart` as the process-instance identity.

Linux additionally scans same-user procfs entries for token-plus-scope matches, which contains Codex/bwrap descendants that leave the original process group. This sweep is deliberately fail-closed and limited: it cannot discover a process whose `/proc/<pid>/environ` is unreadable, a descendant hidden from the runner's PID namespace, a descendant that replaced or sanitized away either lifecycle marker before leaving the PGID, or a process on a host without procfs. macOS therefore has no authoritative persisted host-wide token sweep. Live cleanup retains bounded host observations and re-authenticates each candidate immediately before signaling; after runner loss, the worker-writable candidate sidecar is only a bounded PID hint and cannot prove inventory completeness, so persisted recovery requires manual absence verification. Repeated settlement sweeps permanently stop targeting a numeric PGID once it is observed absent, preventing a later reused group from becoming a target.

The synchronous uncaught-exception monitor signals only worker identities held in the runner's trusted memory; it never parses the worker-writable recovery store. Handled runner failures, hard-stop, and external stop paths can await the bounded persisted-record recovery described above.

These controls protect signaling decisions made from worker-writable records, but they are **not** a general boundary against arbitrary same-user code. In particular, **`resume` re-executes `script.js`/`config.json` from that worker-writable dir with no review gate** — so a poisoned prior run can influence a later resume (including its `permission`). Treat resuming an untrusted run as running its inputs. Two known replay caveats: a `pipeline()` whose later-stage dispatch order depends on completion timing can lose its cache prefix on resume, and fallback token estimates (no-usage backends) are approximate. Full isolation (control-plane outside the workspace and a separate-process sandbox) is future work.

## Benchmark control plane

The benchmark harness treats suite runners and task containers as native,
potentially task-influenced producers, not as score authorities by themselves.
Host-owned suite-versioned manifests (Pro relay v3; Marathon and FeatureBench
v2) and schema-v2 verifier receipts, plus schema-v3 run-state
ledger heads and segments, live outside task workspaces with private modes and
symlink-safe writes. Ledger records are bounded and hash chained; replay
requires contiguous revisions, indexes, and segment ancestry, and reports bind
the committed chain root. A report accepts a
native score only when the exact official-verifier file, SHA-256, scope,
invocation, role, and record key are bound in the receipt. Repository code can
still consume compute and modify its task workspace; it cannot turn an agent
success signal or a lookalike output into an official score.

Native containers carry the complete `ultracode.benchmark.*` ownership label
tuple. Cleanup filters and reinspects that tuple before deletion; it does not
claim unlabeled or ambiguously labeled Docker resources. Prepared sources,
toolchains, evaluator environments, datasets, patches, images, prompt policy,
and control-plane implementations are pinned or content-addressed and
re-attested at the suite's launch boundary.

SWE-Marathon repository-controlled task code shares a security domain with the
reusable Codex credential needed for that session. Its harness keeps credential
material out of persistent result trees, but cannot prevent malicious task code
from reading or exfiltrating a live credential. Operators must use disposable,
narrowly scoped benchmark accounts and independently restricted egress.

SWE-bench Pro task sessions instead fail closed onto one dedicated internal,
local, non-attachable Docker bridge. The only non-task endpoint is a separately
operated immutable-image Codex Responses relay; the task has no default/WAN
attachment, generic proxy, auth file, or provider API key. The harness attests
the complete network endpoint IDs, the task's sole attachment, relay runtime
identity, and labels declaring exact request paths/model/fixed destination and
no generic forwarding or provider-hosted retrieval. An immutable nonce-bound
gate keeps task-controlled code stopped until the post-create checks pass. A
host policy lock shared across worktrees covers recovery,
preflight, session lifetime, resume,
report/evaluation state access, and cleanup. Relay and network runtime names are
persisted only through manifest/report-bound hashes.

This proves the inspected Docker topology and binds the operator's relay
declaration; it does not prove that the relay image truthfully implements its
labels, that the provider returns a particular information source, or that an
undocumented operator firewall exists. The Docker daemon, host networking after
inspection, relay implementation and credential scope, its fixed upstream
egress, and provider are trusted operator components. A daemon administrator or
compromised/mislabeled relay can violate the guarantee. Missing or drifted
topology, identity, contract, destination, model, or runtime binding terminates
the Pro run, and legacy direct-credential sessions are rejected.

SWE-bench Pro bounds both Docker paths with a frozen, manifest-bound policy.
Session containers use `no-new-privileges`, a 1,024-process limit, manifest
CPU/memory limits, `cap-drop ALL`, and only `CHOWN`, `DAC_OVERRIDE`, `SETGID`,
`SETPCAP`, and `SETUID` for explicit uid-0 immutable setup across base-image
ownership modes. `SETPCAP` is setup-only and permits `setpriv` to drop the
bounding set. Codex, detached task processes, and the
post-task Git-capture helper run as the task uid after the bounding,
inheritable, and ambient capability sets are cleared. Official evaluator
containers use the same process, privilege, and resource bounds with no added
capabilities. The patched evaluator rejects malformed or weakened HostConfig
policy before container creation. A Docker engine that cannot honor these
options, or any evaluator task that fails without a verdict, makes the native
evaluator process fail; partial booleans remain separately attributable and the
harness does not retry with broader privileges.

Container policy, its evaluator translator, the immutable Git helper, and all
launch paths are native manifest assets and contribute to session/evaluator
policy hashes. Offline tests compare exact CLI and Docker SDK projections;
opt-in tests inspect a live daemon's resulting HostConfig using an explicitly
operator-supplied local image. This does not make repository code trusted: it
still controls the task workload, can consume resources within those bounds,
within the model-relay boundary described above.

SWE-bench Pro acquisition similarly treats the mutable dataset service as
untrusted input. A reviewed digest covers dataset, config, split, and complete
codepoint-sorted rows. Fetch verifies before atomic cache replacement, every
load re-verifies, and mismatches preserve prior cache bytes. Renewing the pin
requires two independent captures and reviewer reproduction; the manifest
records the verified canonical digest rather than cache serialization bytes.

Native host processes also inherit a high-entropy lifecycle token plus a
filesystem-backed run scope. The token and direct-child process identity are
persisted before and immediately after spawn, and interrupted runs perform
bounded, identity-checked descendant recovery before state is closed. Linux
can discover marked descendants that escaped the original process group;
macOS recovery is limited to the recorded candidate leaders. Unverifiable
descendants fail recovery rather than authorizing a broader signal target.

FeatureBench has a separate network and credential-broker boundary. Task containers
receive no reusable host credential and run only on a dedicated internal Docker
network. The sole pre-existing endpoint must be a separately managed, running,
immutable-image HTTPS credential broker with the configured public
identity/version labels. A host-wide policy lock covers cleanup, broker-only
network preflight, inference, official evaluation, and final cleanup. Persistent
artifacts contain public identity/version and policy hashes, never the broker
URL, Docker runtime names, credential material, or credential-file paths. The
runtime-only broker URL is written under a private run/arm/nonce-marked home;
normal finalization and the next exact run cleanup remove that home. The
broker remains trusted to scope credentials, validate requests, and control its
own upstream egress; compromise of that broker is outside the task-container
isolation guarantee.

## Related reading

- `docs/design/minimalist-risk.md` — the historical risk register the shipped mitigations grew from (parts superseded by this document).
- `skill/ultracode/references/dialect.md` — caps, timeouts, and concurrency overrides as workflow authors see them.
- `SUPPORTED_VERSIONS.md` — pinned host CLI versions, platform notes, live-test gate.
