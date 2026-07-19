/** FeatureBench host policy kept separate from effectful adapter execution. */

/** Require the production host platform and architecture supported by FeatureBench. */
export function validateFeatureBenchHost(platform: NodeJS.Platform, arch: string): void {
  if (platform !== 'linux' || arch !== 'x64') {
    throw new Error(`FeatureBench requires a Linux x64 host, got ${platform}-${arch}`);
  }
}

/** Validate the current process host before any FeatureBench lifecycle effects. */
export function requireFeatureBenchHost(): void {
  validateFeatureBenchHost(process.platform, process.arch);
}
