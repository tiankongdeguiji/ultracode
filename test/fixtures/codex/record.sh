#!/usr/bin/env bash
# Re-record live fixtures (serial, tiny prompts; ChatGPT-plan safe).
set -euo pipefail
cd "$(dirname "$0")"
echo 'Reply with exactly the word: hello' | codex exec --json --skip-git-repo-check -s read-only - > success-hello.jsonl
echo "recorded success-hello.jsonl with $(codex --version)"
