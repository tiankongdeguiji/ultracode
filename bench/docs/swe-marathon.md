# SWE-Marathon adapter

This adapter runs reproducible Codex versus Codex + ultracode trials through
upstream Harbor. It is selected through the shared `npm run bench` dispatcher,
but SWE-Marathon still owns its task containers and native preparation,
execution, verification, resume, and reporting lifecycle.

## Reproducibility contract

| Component | Pin |
| --- | --- |
| `abundant-ai/swe-marathon` | `6d6855af390226f6eca607d63818fe076e57ea8c` |
| Harbor | `0.17.1` |
| Python | `3.13.5` |

`prepareMarathon()` checks out the exact commit, runs the locked `uv` sync
under Python 3.13.5, verifies the resulting Harbor version, prepares the
normal bench toolchain, and pulls each task's digest-pinned image. Its default checkout is
`bench/.cache/swe-marathon`; generated checkouts, environments, and trial
results remain ignored artifacts.

The run contract is intentionally conservative:

- one selected task per Harbor job;
- one concurrent trial and one concurrent agent phase;
- one attempt and zero Harbor retries;
- the task's official verifier always runs;
- server-side web search is disabled;
- every bench toolchain bind mount is read-only.
- Linux x64 is required because the mounted Codex and Node executables run in
  Linux amd64 task containers.

Task ids are checked against the selected upstream pin as well as a strict
lowercase slug grammar, so a path or an unknown task cannot become a Harbor
selection.

## Arms

Arm A uses Harbor's built-in `codex` adapter and mounts only the pinned bench
Codex executable. Arm B uses the tracked
`bench/external/swe-marathon/arm_b_codex.py` bridge, the canonical `ultracode`
prompt prefix, the tracked skill, and the read-only Node and ultracode runtime
from `bench/.cache/toolchain`.

The bridge does not choose a model or reasoning effort. Harbor supplies those
from the run plan. It registers the MCP server, keeps the host Codex home
separate from the worker home, waits for workflow terminal states while the
Harbor agent lifecycle remains open, merges all available host and worker
rollouts, and preserves the complete ultracode store. A workflow wait deadline
is fail-closed: the bridge stops and awaits stragglers, preserves artifacts, and
then raises so Harbor cannot begin official verification against a moving tree.
Arm B also fails before verification if the host did not start any ultracode
run, if the worker session store or ultracode run store is absent, or if Harbor
reports a nonzero return code while waiting or preserving those required
telemetry artifacts. After Harbor downloads the logs, `arm_b_metrics.json` records
per-session context and token metrics.
Mock workflows are explicitly non-billable and contribute zero billable
workflow tokens.

## Cohorts and exclusions

The following four tasks are a **post-hoc context-pressure stress cohort**, not
a pre-registered representative benchmark sample:

- `find-network-alignments`
- `kubernetes-rust-rewrite`
- `nextjs-vite-rewrite`
- `rust-java-lsp`

They were selected after observing unusually high Arm A context pressure.
Results for this cohort should therefore be described as stress evidence and
must not be presented as an unbiased confirmatory estimate.

The exploratory CUA runs for `excel-clone`, `mastodon-clone`, `s3-clone`, and
`slack-clone` did not complete official verification. They are excluded from
the adapter's runnable task set and from reported A/B results.

## Usage

Authentication is runtime-only. Put either `CODEX_AUTH_JSON_PATH` or
`OPENAI_API_KEY` in the environment of the Node process that calls the adapter.
`runMarathon()` selects exactly one mechanism and passes an allowlisted
environment to Harbor. Unrelated host tokens, cloud credentials, SSH agent
sockets, and package-manager credentials are excluded. Planning functions never
include auth, and Harbor argv never contains an auth setting.
`CODEX_AUTH_JSON_PATH` is validated as a regular file and normalized to its
absolute path before Harbor changes directory. The Harbor Python process also
runs with bytecode writes disabled. `OPENAI_API_KEY` remains supported: Harbor
creates and links the host Codex `auth.json` before the Arm B bridge copies that
file into the isolated worker home.

The supported command-line lifecycle is:

```bash
npm run bench -- prep --suite swe-marathon
npm run bench -- run --suite swe-marathon --run-id <fresh-id> \
  --model <model> --effort <effort> --arm <a|b> \
  --task-id <task> [--task-id <task> ...]
npm run bench -- report --suite swe-marathon --run-id <fresh-id>
```

The explicit selector routes these commands to SWE-Marathon; omitting it selects
SWE-bench Pro. Routing is the only shared layer. The suite manifest remains at
`bench/results/external/swe-marathon/<runId>/external-run.json`, separate from
SWE-bench Pro's `bench/results/<runId>/run.json` and FeatureBench's external
namespace.

Model and effort are mandatory CLI inputs; environment variables are not used
as fallbacks by the suite driver. Each task becomes one sequential Harbor job
under the private run directory. Repeating the exact command with the same run
ID skips receipt-complete tasks and invokes Harbor's native `job resume` for an
incomplete job. Input or provenance drift is rejected. The lower-level adapter
API retains explicit argument or environment injection for programmatic callers.
Resume validation compares Harbor 0.17.1's exact `task.path`, `agent.name`,
`agent.model_name`, and `agent.kwargs.reasoning_effort` fields; unrelated config
text cannot satisfy an immutable input check.

Before manifest creation, the driver re-attests checkout HEAD/origin/dirtiness,
exact Python and Harbor binaries, task config and image digests, the Arm B
bridge, Codex, Node, and ultracode. It rehashes again immediately before each
launch. Reports trust only the exact direct-child Harbor trial `result.json`
recorded in the host-owned native receipt; recursively discovered reward files
are never score authority.

Model, effort, and host paths can be arguments or environment variables:

| Setting | Environment variable |
| --- | --- |
| model | `SWE_MARATHON_MODEL` |
| reasoning effort | `SWE_MARATHON_EFFORT` |
| upstream checkout | `SWE_MARATHON_REPO_DIR` |
| results directory | `SWE_MARATHON_RESULTS_DIR` |
| bench toolchain | `SWE_MARATHON_TOOLCHAIN_DIR` |
| Python bridge directory | `SWE_MARATHON_BRIDGE_DIR` |
| ultracode skill directory | `SWE_MARATHON_SKILL_DIR` |
| `uv` executable | `SWE_MARATHON_UV_BIN` |
| Harbor executable | `SWE_MARATHON_HARBOR_BIN` |
| Arm B post-host wait | `SWE_MARATHON_WORKFLOW_WAIT_SECONDS` |

The pure functions are useful for review or scheduling without executing
anything:

```ts
import {
  planMarathonPrep,
  planMarathonRun,
  prepareMarathon,
  runMarathon,
} from '../src/marathon.js';

const prepPlan = planMarathonPrep();
const runPlan = planMarathonRun(
  { taskName: 'kubernetes-rust-rewrite', arm: 'b' },
  process.env,
);

await prepareMarathon();
await runMarathon({ taskName: 'kubernetes-rust-rewrite', arm: 'b' });
```

For an explicit argument-based run, pass `model`, `effort`, any path overrides,
and a unique `jobName` in the `runMarathon()` options. Run Arm A and Arm B as
separate jobs; the one-task default avoids concurrent trials competing for the
same local CPU, memory, or account limits.
