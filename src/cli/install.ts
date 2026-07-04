import { installForHost } from '../installer/install.js';

export async function installCommand(
  host: string,
  opts: { project?: boolean; dryRun?: boolean },
): Promise<number> {
  try {
    const actions = installForHost(host, opts);
    for (const a of actions) {
      const prefix = opts.dryRun ? 'would ' : '';
      process.stdout.write(`${a.changed ? '✓' : '·'} ${prefix}${a.detail}: ${a.path}\n`);
    }
    if (!opts.dryRun) {
      process.stdout.write(
        `\nDone. Say "ultracode: <task>" (or "+500k") in ${host} to trigger orchestration.\n` +
          `The MCP triad registration lands with \`ultracode install ${host}\` after \`ultracode mcp\` ships.\n`,
      );
    }
    return 0;
  } catch (err) {
    process.stderr.write(`ultracode: ${(err as Error).message}\n`);
    return 1;
  }
}
