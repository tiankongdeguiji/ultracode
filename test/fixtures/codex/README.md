# codex exec --json golden fixtures

- `success-hello.jsonl` — LIVE capture, codex-cli 0.142.4, 2026-07-04:
  `echo 'Reply with exactly the word: hello' | codex exec --json --skip-git-repo-check -s read-only -`
- `schema-rejected.jsonl` — SYNTHETIC, reconstructed from openai/codex issue #16552 +
  exec_events.rs (rust-v0.142.4): the deterministic HTTP-400 invalid_json_schema path. Exit 1.
- `intermediate-messages.jsonl` — SYNTHETIC per issue #19816: with --output-schema, intermediate
  agent_message items are ALSO schema-shaped; consumers must take the LAST. Exit 0.
- `reconnect-then-success.jsonl` — SYNTHETIC: benign {"type":"error"} retry notices
  ("Reconnecting...") followed by a successful turn. Exit 0.
- `turn-failed-usage-limit.jsonl` — SYNTHETIC: usage-limit turn failure. Exit 1.
- `tool-usage.jsonl` — SYNTHETIC: command_execution + web_search item lifecycle events.

Re-record live fixtures: test/fixtures/codex/record.sh
