# FeatureBench adapter

`bench/src/featurebench.ts` is a deliberately narrow adapter for a reproducible
FeatureBench Codex experiment. It is selected through the shared
`npm run bench` dispatcher, but FeatureBench still owns native preparation,
inference image selection, execution, patch capture, verification, resume, and
reporting.

## Reproducibility contract

- FeatureBench source is detached at
  `445dcbaec0b2e136061b0acb54e753c0a9f1888e` from
  `LiberCoders/FeatureBench`.
- The `LiberCoders/FeatureBench` dataset is loaded at revision
  `e99d6efdfe511ea832c1b5735c536129561ec96a`.
- The initial policy is the `fast` split, CPU-only containers, one attempt, no
  adapter retries, 8 CPUs, 24 GiB memory, four inference workers, and a 43,200
  second task timeout. Planning rejects GPU execution, another split, multiple
  attempts, retries, and API-key auth rather than silently changing the trial.
- Task IDs are individual values following `--task-id`; they are never treated
  as filenames or rewritten as host paths, and they must exist in the pinned
  dataset.
- Evaluation is the official upstream `fb eval` command against the pinned
  dataset. The adapter does not replace FeatureBench grading.

`prepareFeatureBench()` clones into a caller-selected cache directory, checks
out the exact source revision, requires a clean checkout, runs `git apply
--check` against the tracked full-index patch, applies it, and runs the locked
`uv sync` under exact Python 3.13.5, and pre-pulls the split images. A new clone
is prepared under a temporary sibling and renamed only after every step passes.
A checkout with an already-applied exact patch is accepted for idempotence.
Tracked drift and every unexpected untracked or ignored file fail closed. The
only generated checkout content allowed by attestation is `.venv/**`; native
Python preparation, inference, and evaluation children receive
`PYTHONDONTWRITEBYTECODE=1` so they do not create ignored bytecode elsewhere.
The virtual environment is rebuilt during preparation and the whole checkout is
re-attested after that rebuild and before each run.
Preparation also materializes the pinned task-to-image map under the checkout's
Git metadata, so pre-manifest run checks only read and hash local state instead
of invoking a dataset loader that could mutate a cache.

The tracked patch adds the experiment plumbing FeatureBench lacked:

- a read-only mount for the prepared Linux-x64 Codex binary; reusable host
  credentials are never mounted into repository-controlled task containers;
- immutable per-task image digests and a Docker-internal network whose
  `ultracode.egress-policy=openai-via-credential-broker` label identifies the
  sole pre-existing endpoint: a running, immutable, separately labeled OpenAI
  credential-broker container;
- Docker CPU and memory limits and an explicit rejection of GPU-requiring tasks;
- Codex's current `--dangerously-bypass-approvals-and-sandbox` execution flag;
- a dataset revision passed to both inference and the upstream evaluator;
- direct copying of `/root/.codex/sessions` from each container in Codex's
  `post_run_hook` and failure hook, before teardown;
- for Arm B, the same task preceded by the literal ultracode trigger plus a
  read-only toolchain mount, Codex MCP registration, and installed ultracode
  skill. The hook polls every workflow manifest to a terminal state before
  copying outputs; expiry stops and awaits stragglers and fails the attempt.
  Arm A receives the upstream task unchanged.

## External broker and network contract

This repository does **not** contain, launch, configure, or credential an OpenAI
broker. Before `run`, the operator must provision and keep running an external
broker container and a dedicated Docker network satisfying all of these checks:

- `FEATUREBENCH_RESTRICTED_NETWORK` names a Docker `--internal` network labeled
  `ultracode.egress-policy=openai-via-credential-broker`.
- Exactly one container is attached to that network at preflight: the broker.
  Its Docker container name is exactly the hostname in
  `FEATUREBENCH_CREDENTIAL_BROKER_URL`, and it has the label
  `ultracode.credential-broker=true`. The broker may also use a separate network
  for its own upstream egress. During inference, FeatureBench attaches the task
  containers to this shared network too; concurrent task containers may therefore
  be mutually reachable even though no other pre-existing service is allowed.
- The URL is an absolute HTTPS OpenAI-compatible Responses API base URL. It has
  no userinfo, query, or fragment, its certificate is trusted by every selected
  task image, and its hostname matches that certificate. The adapter passes no
  API key or reusable ChatGPT credential to task containers, so the broker must
  accept requests from the restricted network, inject its own upstream
  credential, and implement any desired request validation, rate limiting, and
  credential scoping itself.
- Docker exposes the broker as a running container backed by an immutable image
  ID. The run manifest records a SHA-256 attestation over the broker image,
  resolved command and arguments, mount configuration, attached network names,
  and labels. It deliberately excludes environment variables and mount contents
  and persists only the hash, never credential material. Changing any attested
  runtime configuration prevents an exact-manifest resume.

Provisioning the broker, its trusted TLS certificate, its upstream connectivity,
and its credential is an operator prerequisite, not a command supplied by this
repository. An internal Docker network isolates task containers from ordinary
egress; the broker is the explicit trust boundary and sole pre-existing service
endpoint, not a per-task network-isolation mechanism.

Before the broker-only network assertion, preflight removes containers carrying
the exact `ultracode.external-run=<runOwner>` label. This targeted deletion also
removes stale network endpoints left by an interrupted run, allowing an exact
resume to re-establish the one-broker attachment invariant. The same cleanup runs
on exit; containers with any other owner label are untouched.

Callers also provide the prepared checkout, private result root, and pinned Codex
binary. The native runner receives an allowlisted host environment, so unrelated
GitHub, npm, cloud, SSH-agent, and similar credentials are not inherited.

## Artifacts

For each invocation, the adapter creates a private temporary directory, writes
the runtime TOML with mode `0600`, and removes the directory in `finally` after
inference and evaluation. The result root and timestamped run directory have
mode `0700`. FeatureBench still records its normal `output.jsonl`, reports,
per-attempt logs, patches, Codex events, and copied Codex session JSONL under
that private result tree. Do not commit results, auth files, runtime TOML, source
clones, or local cache directories.

The intended host flow is:

```bash
npm run bench -- prep --suite featurebench
npm run bench -- run --suite featurebench --run-id <fresh-id> \
  --model <model> --effort <effort> --arm <a|b> \
  --task-id <instance-id> [--task-id <instance-id> ...]
npm run bench -- report --suite featurebench --run-id <fresh-id>
```

The explicit selector routes these commands to FeatureBench; omitting it selects
SWE-bench Pro. Routing is the only shared layer. The suite manifest remains at
`bench/results/external/featurebench/<runId>/external-run.json`, separate from
SWE-bench Pro's `bench/results/<runId>/run.json` and SWE-Marathon's external
namespace.

The CLI requires `--model`, `--effort`, and `--run-id` (used as `runOwner`)
explicitly; none has a fallback. Set
`FEATUREBENCH_CREDENTIAL_BROKER_URL` and `FEATUREBENCH_RESTRICTED_NETWORK` before
`run`, after externally provisioning the contract above. Source,
dataset-membership, toolchain, network-policy, broker-runtime, and image-digest
checks pass before the secret-free manifest claims the run ID. The manifest
records executable, adapter, Node, ultracode, broker-runtime, and image hashes.
The equivalent lower-level host flow is:

```ts
await prepareFeatureBench({ sourceDir });
await runFeatureBench({
  sourceDir,
  outputDir,
  codexBin,
  credentialBrokerUrl,
  restrictedNetwork,
  runOwner,
  arm: 'a',
  model,
  effort,
  taskIds,
});
```

Arm B additionally requires the toolchain directory built by the existing bench
toolchain preparation. Repeating `run` with the exact same manifest resumes the
native FeatureBench directory and skips completed attempts/evaluations; any input
or provenance difference is rejected. At the lower-level API, `model`, `effort`,
and `runOwner` are likewise mandatory. `planFeatureBenchRun()`,
`planFeatureBenchEval()`, `featureBenchRuntimeConfig()`,
`composeFeatureBenchPrompt()`, and `validateFeatureBenchRun()` are pure seams for
review and offline tests.

## Observed plumbing run

An exploratory five-task Arm A run on 2026-07-19 was reported by upstream
FeatureBench as **4/5 resolved**. A separate polling snapshot watcher observed
five rollout files and **0 compaction events**. This is historical plumbing
evidence only: it did not exercise the current direct-copy, pinned-dataset,
credential-broker, digest, resume, or lifecycle-wait implementation. It is not
an A/B result, model-quality claim, or statistically meaningful benchmark.
