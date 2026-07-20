# SWE-bench Pro provenance and containment

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

`container-policy.json` is the single frozen policy for both Docker launch
paths. Session containers have a 1,024-process cgroup bound,
`no-new-privileges`, `cap-drop ALL`, manifest CPU/memory limits, and only
`CHOWN`, `DAC_OVERRIDE`, `SETGID`, `SETPCAP`, and `SETUID` for an explicit uid-0
immutable setup over base-image files that may not be root-writable. `SETPCAP`
exists only so `setpriv` can drop the capability bounding set during the uid
transition. Codex, detached task work, and the immutable post-task Git capture
run as the task uid with bounding, inheritable, and ambient capability sets
cleared.

Official evaluator containers have the same process, privilege, and
CPU/memory bounds with `cap-drop ALL` and an empty capability-add tuple. The
patched evaluator consumes the host-written `evaluator-policy.json`; its
checked-in Python translator rejects any missing, extra, or weakened policy
field before calling the Docker SDK. Any task-level evaluator exception or
container rejection makes the evaluator process fail after preserving partial
native booleans for attribution. Policy files, translators, Git helpers,
patches, and their hashes are native manifest assets and prepared-input
provenance.

Offline unit tests assert exact session argv and evaluator Docker SDK options.
Live daemon parity is intentionally opt-in and never pulls an image:

```bash
UC_LIVE_TESTS=1 UC_DOCKER_PARITY_IMAGE=<already-local-image> \
  npx vitest run --config vitest.live.config.ts test/live/bench-swebench-pro-docker.test.ts
```

If the local Docker engine rejects the minimal tuple or cannot prove the
inspected `HostConfig`, the parity test fails. Capability sets must not be
broadened to make a task pass; investigate and renew the reviewed policy with
evidence from real session and evaluator operations.
