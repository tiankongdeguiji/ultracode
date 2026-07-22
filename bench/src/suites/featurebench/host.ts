/** Production host policy for the pinned FeatureBench container runtime. */

/** Require the only host platform supported by the pinned native runner. */
export function validateFeatureBenchHost(platform: NodeJS.Platform, architecture: string): void {
  if (platform !== 'linux' || architecture !== 'x64') {
    throw new Error(`FeatureBench requires a Linux x64 host, got ${platform}-${architecture}`);
  }
}

export function requireFeatureBenchHost(): void {
  validateFeatureBenchHost(process.platform, process.arch);
}
