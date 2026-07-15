/**
 * Codex auth-mode detection — the fan-out safety gate.
 *
 * ChatGPT OAuth refresh tokens are single-use and auth.json writes are
 * non-atomic (source-verified): N parallel codex exec processes race the
 * refresh and can invalidate the whole token family. Fan-out is only safe
 * on CODEX_API_KEY / CODEX_ACCESS_TOKEN (env, exec-only, bypasses auth.json).
 */
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export type CodexAuthMode = 'api-key-env' | 'access-token-env' | 'api-key-file' | 'chatgpt-oauth' | 'none';

export const OAUTH_FANOUT_DEFAULT = 1;
export const OAUTH_FANOUT_FORCED_CAP = 3;

export function codexHome(): string {
  const fromEnv = process.env.CODEX_HOME;
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

export function isFanoutSafe(mode: CodexAuthMode): boolean {
  return mode === 'api-key-env' || mode === 'access-token-env' || mode === 'api-key-file';
}

export interface ConcurrencyPolicy {
  maxConcurrency: number;
  warning?: string;
}

/** Cap codex concurrency on OAuth auth; --force-oauth-fanout raises to 3, never more. */
export function codexConcurrencyPolicy(
  requested: number,
  mode: CodexAuthMode,
  forceOauthFanout: boolean,
): ConcurrencyPolicy {
  if (isFanoutSafe(mode) || requested <= 1) return { maxConcurrency: requested };
  if (mode === 'none') {
    return { maxConcurrency: requested, warning: 'codex auth not detected — run `codex login` or set CODEX_API_KEY' };
  }
  if (forceOauthFanout) {
    const cap = Math.min(requested, OAUTH_FANOUT_FORCED_CAP);
    return {
      maxConcurrency: cap,
      warning: `ChatGPT-OAuth fan-out forced: concurrency capped at ${cap} (refresh-token races can invalidate your login; prefer CODEX_API_KEY)`,
    };
  }
  return {
    maxConcurrency: OAUTH_FANOUT_DEFAULT,
    warning:
      'codex is authenticated via ChatGPT OAuth: parallel fan-out is unsafe (single-use refresh tokens) — concurrency capped at 1. Set CODEX_API_KEY for parallelism, or pass --force-oauth-fanout to cap at 3.',
  };
}
