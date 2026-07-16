# Backend golden fixtures

LIVE captures (re-record with each backend's record.sh where present):
- codex/success-hello.jsonl (codex-cli 0.142.4)
- claude/success-hello.jsonl (Claude Code 2.1.200)

SYNTHETIC (reconstructed from source/SDK research — upstream CLI source and
issue trackers, SDK message envelopes, decompiled Qoder internals — plus docs/design/):
- codex/{schema-rejected,intermediate-messages,reconnect-then-success,turn-failed-usage-limit,tool-usage}.jsonl
- qoder/{success-structured,error-max-turns}.jsonl — SDKMessage envelope + undocumented --json-schema structured_output
- gemini/{success-json,success-plain}.jsonl — init/message/tool_use/tool_result/result
- claude/streaming-usage.jsonl — multi-assistant-message transcript in the
  claude/success-hello.jsonl envelope (per-API-call `message.usage` on assistant
  lines); exercises interim usage ticks vs terminal-only accounting. Its
  assumption that per-message usage sums roughly to the result total has NOT
  been live-verified on a long multi-turn transcript — display-only exposure;
  re-check against a live capture when re-recording (accounting reads only the
  terminal `result` usage either way)
- claude/multiblock-usage.jsonl — one API call split across multiple assistant
  lines (same message.id, identical usage per content block — verified against
  a live claude 2.1.x capture); exercises interim-usage dedup by message id

Re-record live fixtures when a backend's CLI version changes; verify synthetic
fixtures against a live capture before trusting a new parser path.
