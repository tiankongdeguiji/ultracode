// Shared SemVer 2.0.0 guard for the build/version scripts. package.json's
// `version` is the single source of truth for the engine VERSION constant, the
// package-lock version fields, and the plugin manifests; an invalid value would
// otherwise propagate unchecked — interpolated verbatim into src/version.ts by
// sync-version.mjs, or stamped into the plugin manifests by build-plugins.mjs
// (where an `undefined` version would even vanish silently via JSON.stringify) —
// so validate it in one place. Pattern is the official semver.org one (no
// leading zeros, no empty prerelease ids).
export const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*)?(?:\+[0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*)?$/;

// Throws with a stable "version missing or invalid" message (asserted by tests)
// when the value is not a SemVer string; returns it otherwise for chaining.
export function assertSemver(version) {
  if (typeof version !== 'string' || !SEMVER.test(version)) {
    throw new Error(`package.json version missing or invalid: ${JSON.stringify(version)}`);
  }
  return version;
}
