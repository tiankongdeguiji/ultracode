# Planted bugs (parity demo ground truth)

The `uc-review` workflow should find BOTH of these when run against this repo on
any backend. The assertion script (`examples/assert-review.mjs`) checks that a
review result mentions each.

1. **Auth bypass in `tokensMatch` / `verifySession`** (`src/auth.js`):
   loose `==` comparison that treats two missing/empty tokens as a match, so a
   request with no token can authenticate. (Also not constant-time.)

2. **Privilege escalation in `authorize`** (`src/auth.js`):
   `role` is taken from the client-supplied `req.body.role` and trusted, so any
   caller can grant themselves `admin`.
