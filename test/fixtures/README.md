# Backend golden fixtures

LIVE captures (re-record with each backend's record.sh where present):
- codex/success-hello.jsonl (codex-cli 0.142.4)
- claude/success-hello.jsonl (Claude Code 2.1.200)

SYNTHETIC (reconstructed from source/SDK research in docs/research/ + docs/design/):
- codex/{schema-rejected,intermediate-messages,reconnect-then-success,turn-failed-usage-limit,tool-usage}.jsonl
- qoder/{success-structured,error-max-turns}.jsonl — SDKMessage envelope + undocumented --json-schema structured_output
- gemini/{success-json,success-plain}.jsonl — init/message/tool_use/tool_result/result

Re-record live fixtures when a backend's CLI version changes; verify synthetic
fixtures against a live capture before trusting a new parser path.
