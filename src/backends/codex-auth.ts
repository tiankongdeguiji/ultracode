/**
 * Codex auth-mode detection, reported by `ultracode doctor`. Detection is
 * informational only: the engine never derives concurrency from auth —
 * `--max-concurrency` / ULTRACODE_MAX_CONCURRENCY are entirely user-controlled.
 */
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export type CodexAuthMode = 'api-key-env' | 'access-token-env' | 'api-key-file' | 'chatgpt-oauth' | 'none';

/** Codex's config root; an empty CODEX_HOME means unset (codex semantics). The
 *  `env` seam exists for tests — every production caller uses process.env. */
export function codexHome(env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = env.CODEX_HOME;
  return fromEnv && fromEnv.length > 0 ? fromEnv : join(homedir(), '.codex');
}

export function detectCodexAuth(home = codexHome()): CodexAuthMode {
  if (process.env.CODEX_API_KEY) return 'api-key-env';
  if (process.env.CODEX_ACCESS_TOKEN) return 'access-token-env';
  const authFile = join(home, 'auth.json');
  if (!existsSync(authFile)) return 'none';
  try {
    const auth = JSON.parse(readFileSync(authFile, 'utf8')) as Record<string, unknown>;
    if (typeof auth.OPENAI_API_KEY === 'string' && auth.OPENAI_API_KEY.length > 0) return 'api-key-file';
    if (auth.tokens || auth.access_token || auth.refresh_token) return 'chatgpt-oauth';
    return 'none';
  } catch {
    return 'none';
  }
}
