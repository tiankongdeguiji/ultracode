# SWE-bench Pro provenance and containment

## Prerequisites and authentication

SWE-bench Pro uses the shared Node 20+, Git, Docker, and configured Codex
toolchain prerequisites. Its evaluator preparation additionally requires
CPython 3.11, pip 24.2, and `venv`. The finite reviewed matrix covers x64 and
arm64 on glibc 2.28-or-newer Linux, macOS 10.9-or-newer on x64, and macOS
11-or-newer on arm64. Other implementations, Python minors, operating systems,
architectures, pip versions, musl, and older OS floors fail preflight before a
dependency index or other preparation network path is reached. The suite does
not use or require `uv` or GNU `patch`; those tools belong to other suites.
Preparation and native runs can access the network and remain manual.

Select one runtime mechanism in the private operator config and supply it again
for every run invocation:

- `chatgpt`: set `CODEX_AUTH_JSON_PATH` to a current-user-owned, singly-linked
  regular ChatGPT auth file no larger than 4 MiB whose mode is exactly `0600`.
- `api-key`: set `CODEX_API_KEY` to a non-empty key.

These variables are specific to SWE-bench Pro. In particular, SWE-Marathon
API-key mode uses `OPENAI_API_KEY` instead of `CODEX_API_KEY`. Credentials and
auth paths are runtime-only and are not stored in manifests or reports.

The evaluator source is not operator-selectable. Configuration accepts only
`https://github.com/scaleapi/SWE-bench_Pro-os` at revision
`ca10a60a5fcae51e6948ffe1485d4153d421e6c5`; mirrors, forks, and alternate
revisions fail schema validation before preparation.

## Evaluator dependency trust

`evaluator-requirements.lock` is the canonical full 13-package active closure,
not a three-root resolver input. Every line is an exact pin with SHA-256 hashes.
`evaluator-requirements.provenance.json` records the exact PyPI release source,
active dependency edges, inactive Windows markers, finite host targets, and the
approved wheel filename and SHA-256 partitions for those targets. Its complete
canonical JSON has a separately reviewed hash in the TypeScript implementation,
so an internally consistent edge or artifact rewrite is rejected. Wheel tags
are parsed locally and must map to exactly the declared OS, architecture, ABI,
and minimum-OS partitions. Both files are strict native assets and are bound
into prepared inputs and run manifests.

Preparation parses and validates both assets locally, proves root reachability
of every entry, proves that every active edge has an entry and every target has
an approved wheel, and derives a target-only lock. It does not run pip's
resolver, create a resolver environment, request an install report, accept an
sdist, or execute a build backend. The host venv is created with
`--without-pip`; the first dependency install is performed by the preflighted
host pip with `--require-hashes --only-binary=:all: --no-deps`, followed by
`pip check`. A missing package, unexpected candidate hash, or unsatisfied edge
is fatal.

This trust contract uses prepared-input schema 3 and `current-v3.json`.
Schema-2 evaluator environments were assembled through the removed resolver
bootstrap and are intentionally not migrated or accepted; prepare them again on
a supported host before creating a fresh run.

The prepared environment tree hash, Python binary hash, and target-lock hash
describe the exact result assembled on one host. They are reproducibility and
drift provenance only; they are not evidence of upstream authorship. Upstream
artifact approval comes from review of the exact wheel filename and digest in
the official PyPI release metadata, plus PyPI publication attestations when the
release provides them.

The reviewed host CPython, pip installation, standard library, dynamic loader,
and operating-system libraries are the preparation and execution trusted
computing base. They are preflighted by implementation/version/platform, but
are intentionally not represented as portable upstream artifact attestations;
the prepared hashes must not be described as an end-to-end host supply-chain
proof. Clean, managed hosts are required for preparation and evaluation.

### Audited lock renewal

Renewal is a deliberate networked maintenance operation outside normal `prep`:

1. Create an ignored `agent_space/evaluator-lock-<date>/` audit directory.
   Record the requested root versions, CPython/pip versions, all target tags,
   command output, official release JSON URLs, and reviewer identity. Do not
   add the scratch directory or downloaded wheels to tracked files.
2. Use CPython 3.11 and verify `python3 -m pip --version` reports exactly 24.2.
   For each of `manylinux_2_28_x86_64`, `manylinux_2_28_aarch64`,
   `macosx_10_9_x86_64`, and `macosx_11_0_arm64`, resolve only in the audit
   directory with this command, substituting the target and destination:

   ```bash
   python3 -m pip download --only-binary=:all: \
     --implementation cp --python-version 311 --abi cp311 \
     --platform <target> --dest <audit-directory>/<target> \
     -r <audit-directory>/evaluator-roots.in
   ```

   This discovery command may resolve dependencies but may download wheels
   only. Any sdist request, missing wheel, or build-backend action invalidates
   the candidate.
3. Read each wheel's `*.dist-info/METADATA` with a ZIP reader, without importing
   or installing it. Evaluate every `Requires-Dist` marker against all four
   targets, record excluded markers explicitly, and independently prove the
   complete root closure. Include every compatible wheel pip may select for a
   target, not only the resolver's preferred candidate.
4. Query `https://pypi.org/pypi/<name>/<version>/json` for every exact pin.
   Match filename, wheel type, SHA-256, yanked state, and `Requires-Python`;
   inspect the PyPI publication attestation when present. Independently hash
   every downloaded wheel with `sha256sum` on Linux or `shasum -a 256` on
   macOS and require exact equality.
5. Update the provenance JSON first, then render the lock from its sorted
   packages and unique sorted approved hashes. Run the offline toolchain test;
   its exact-lock check must reject any hand-edited divergence. Review the
   dependency/marker diff and every added or removed artifact with a second
   reviewer.
6. Run `npm run typecheck && npm run lint && npm test`. Cross-platform index
   installation checks remain explicit, opt-in maintenance validation; they
   must use clean hosts matching the reviewed matrix and must never run a
   benchmark. Record their commands and results in the review evidence.

The tracked provenance asset is not a substitute for those renewal records.
A renewal is incomplete until the command output, wheel `METADATA`, independent
wheel hashes, advisory assessment, reviewer identities, and second-review
result are attached to the change review. The opt-in real offline installer
test uses `UC_OFFLINE_PYTHON_TESTS=1`; it never contacts an index outside its
temporary local `file://` fixture.

If metadata, hashes, dependency edges, target compatibility, or independent
review cannot be reconciled, stop the renewal. Never relax hash mode, binary
mode, `--no-deps`, the host matrix, or closure validation to publish a lock.

## Dataset pin and acquisition

The cache is not the dataset authority. `dataset-pin.json` commits the reviewed
SHA-256 of one version-1 canonical descriptor with exactly these fields:

```text
schemaVersion, kind, dataset, config, split, rows
```

`rows` contains each complete datasets-server `entry.row`, sorted by
`instance_id` with a codepoint comparison. The descriptor is canonicalized by
recursively sorting object keys while preserving array order, then SHA-256 is
computed over the UTF-8 canonical JSON bytes. The current pin covers 731 rows
from `ScaleAI/SWE-bench_Pro`, config `default`, split `test`, at descriptor
digest `067bd23ae664ba2113b70d24803e04bb95242ff7c15a7c92642c482544fce0d2`.

`fetch` downloads into memory, validates every complete row, constructs and
verifies that descriptor, and only then atomically replaces the cache. A count
or digest mismatch reports both observed values and leaves any existing cache
bytes untouched. Every cache load repeats schema, ordering, row, count, and
digest verification. Fresh manifests record this canonical descriptor digest,
not the serialization hash of the cache file.

### Audit and pin renewal

Pin renewal is an explicit reviewed operation, never a normal `fetch` side
effect:

1. Record the upstream dataset commit and obtain the complete `default/test`
   rows twice through independent paths: all datasets-server pages and the
   Parquet artifact at that exact commit. Do not use a mutable `main` artifact
   as the second source.
2. Convert both captures to the descriptor above without projecting columns.
   Check stable declared totals on every page, exact row equality between the
   captures, unique valid `instance_id` values, and codepoint row order.
3. Compute both digests with `canonicalDatasetDescriptor()` and
   `sha256CanonicalJson()`. They must match. Review the complete added, removed,
   and changed row identities and preserve the upstream commit in the audit
   record or PR description.
4. Update only `rowCount` and `descriptorSha256` in `dataset-pin.json`. Have a
   second reviewer reproduce the digest from their independent capture.
5. Run the dataset unit tests, then run `fetch` against both an empty cache and
   a cache containing sentinel bytes. The approved candidate must publish; a
   one-byte row mutation must fail without changing the sentinel.
6. Run the full benchmark CI gate. Commit the pin, audit explanation, and any
   intentional schema handling together. Dataset captures and caches remain
   untracked.

If either acquisition path cannot reproduce the candidate, stop. Do not
temporarily weaken validation, reorder with locale-sensitive comparison, drop
unknown columns, or publish the mismatching candidate to the cache.

## Container policy

`container-policy.json` freezes the process, privilege, and capability policy
for the session, evaluator, and reclamation Docker paths.
CPU and memory values are instead derived from
the immutable run manifest. Session containers have a
1,024-process cgroup
bound, `no-new-privileges`, `cap-drop ALL`, those manifest-derived CPU and
memory limits, and only
`CHOWN`, `DAC_OVERRIDE`, `SETGID`, `SETPCAP`, and `SETUID` for an explicit uid-0
immutable setup over base-image files that may not be root-writable. `SETPCAP`
exists only so `setpriv` can drop the capability bounding set during the uid
transition. Codex, detached task work, and the immutable post-task Git capture
run as the task uid with bounding, inheritable, and ambient capability sets
cleared.

Root ownership reclamation runs only in a deterministic helper named from the
validated run, task, and arm. It carries the complete common ownership labels
with `purpose=reclamation`, the host artifact uid/gid, and the session runtime
nonce whenever runtime homes are mounted. Its frozen policy is network mode
`none`, a 64-process cgroup bound, `no-new-privileges`, `cap-drop ALL`, only
`CHOWN`, `DAC_OVERRIDE`, and `FOWNER`, uid/gid `0:0`, and the same
manifest-derived CPU and memory limits. The helper mounts exactly the task
artifact directory and, when present, that session's `home` and `codex-home`.

Every reclamation attempt queries its exact Docker name before launch and after
the Docker client settles. A same-name container is actionable only after
inspection proves the exact full ID and name, ownership-label namespace, local
attested image, command, user, capability and resource policy, auto-remove,
non-privileged/device-free namespace and restart settings, and bind sources and
destinations. A valid survivor is stopped and either proven auto-removed or
reinspected, removed, and proven absent before reclamation is rerun idempotently. A spoofed or otherwise
unprovable same-name container is retained and terminates the command as
`ownership-unsafe`. Session cleanup, run-wide cleanup, root fatal cleanup,
artifact reset, and runtime-home deletion cannot complete until exact helper
absence is proven.

Official evaluator containers have the same static process and privilege
bounds with `cap-drop ALL`, an empty capability-add tuple, and the same
manifest-derived CPU and memory values. The patched evaluator consumes the
host-written `evaluator-policy.json`; its checked-in Python translator requires
the exact top-level and nested schemas, the reviewed canonical static-policy
hash, and a host-supplied digest of the complete generated policy before every
Docker SDK call. Any task-level evaluator exception or
container rejection makes the evaluator process fail after preserving partial
native booleans for attribution. Policy files, translators, Git helpers,
patches, and their hashes are native manifest assets and prepared-input
provenance.

Offline unit tests assert exact session and reclamation argv, lifecycle
reconciliation, and evaluator Docker SDK options.
Live daemon parity is intentionally opt-in and never pulls an image:

```bash
UC_LIVE_TESTS=1 UC_DOCKER_PARITY_IMAGE=<already-local-image> \
  npx vitest run --config vitest.live.config.ts test/live/bench-swebench-pro-docker.test.ts
```

Setting `UC_DOCKER_RECLAMATION_IMAGE` to an already-local compatible SWE-bench
overlay additionally exercises a genuinely running `--rm` reclamation-helper
survivor, its exact inspection proof, stop-triggered auto-removal, absence
check, and idempotent rerun. The live test
does not pull an image or launch a benchmark.

If the local Docker engine rejects the minimal tuple or cannot prove the
inspected `HostConfig`, the parity test fails. Capability sets must not be
broadened to make a task pass; investigate and renew the reviewed policy with
evidence from real session and evaluator operations.
