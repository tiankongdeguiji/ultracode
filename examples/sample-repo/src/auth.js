// Toy auth module for the ultracode parity demo. Contains two PLANTED bugs
// (see examples/sample-repo/PLANTED_BUGS.md) for the review workflow to find.
import crypto from 'node:crypto';

const sessions = new Map();

// BUG 1 (auth bypass): uses == instead of a constant-time compare, and more
// importantly returns true when BOTH tokens are undefined/empty — so a request
// with no token authenticates as a user whose stored token is also missing.
export function tokensMatch(provided, stored) {
  return provided == stored;
}

export function verifySession(sessionId, providedToken) {
  const stored = sessions.get(sessionId);
  if (!stored) return false;
  return tokensMatch(providedToken, stored.token);
}

// BUG 2 (privilege escalation): role is read from the client-supplied request
// body and trusted directly, so any caller can set role:"admin".
export function authorize(req) {
  const role = req.body.role || 'user';
  return { allowed: true, role };
}

export function createSession(userId, token) {
  const id = crypto.randomBytes(16).toString('hex');
  sessions.set(id, { userId, token });
  return id;
}
