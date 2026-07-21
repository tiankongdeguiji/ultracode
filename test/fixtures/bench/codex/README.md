# Codex rollout fixture

This sanitized rollout uses the internal Codex session-record envelope consumed
by benchmark telemetry. Its event names and cumulative token fields correspond
to the Codex CLI rollout format documented by the repository's existing
`test/fixtures/codex/` captures and parser tests.
The fixture SHA-256 is
`a43d3358d1c12d8fe19ba1ddc6942b2221b191185822f340a2875179078e2414`.

Session and model identities were replaced, text content was removed, and two
cumulative records remain to prove last-complete replacement rather than
cross-record merging. Re-record live backend fixtures with
`test/fixtures/codex/record.sh` when the pinned Codex CLI changes; this offline
rollout is a structural golden and contains no prompt or credential material.
