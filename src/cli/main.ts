#!/usr/bin/env node
import { Command } from 'commander';
import { VERSION } from '../version.js';
import { runValidateCommand } from './validate.js';

if (process.platform === 'win32') {
  process.stderr.write(
    'ultracode: Windows is not supported in v1 (POSIX process-group semantics required). Use WSL.\n',
  );
  process.exit(1);
}

const program = new Command();

program.name('ultracode').description('Portable dynamic workflow orchestration for coding agents').version(VERSION);

program
  .command('run')
  .argument('<script>', 'workflow script file (*.workflow.js)')
  .description('run a workflow (detached runner; foreground attach by default)')
  .option('--args <json>', 'workflow args (JSON or plain string)')
  .option('--backend <id>', 'default backend for agents', 'mock')
  .option('--max-agents <n>', 'soft lifetime agent cap (hard ceiling 1000)')
  .option('--max-concurrency <n>', 'concurrent agent cap (default min(10, max(2, cores-2)); env ULTRACODE_MAX_CONCURRENCY overrides the default)')
  .option('--budget <spec>', 'token budget: 500k, +500k, 2m (hard dispatch-gate ceiling)')
  .option('--permission <mode>', 'worker sandbox: safe|auto|danger (read-only/workspace-write/full)', 'auto')
  .option('--timeout <minutes>', 'wall-clock cap in minutes (default: unlimited)')
  .option('--dry-run', 'rehearse on the mock backend: no tokens, no run dir')
  .option('--yes', 'skip the review-before-run confirmation')
  .option('--detach', 'print runId and return immediately')
  .option('--json', 'suppress progress; print output.json at the end')
  .option('--plain', 'line-per-event progress instead of the live panel')
  .option('--no-color', 'live panel without colors')
  .option('--home <dir>', 'run-store root (default <cwd>/.ultracode or $ULTRACODE_HOME)')
  .option('--allow-nested', 'start even inside an ultracode worker (ULTRACODE_INSIDE_RUN set)')
  .action(async (script: string, opts: Record<string, string | boolean>) => {
    const { runCommand } = await import('./run.js');
    // commander's --no-color negates a `color` option (true by default)
    process.exit(await runCommand(script, { ...opts, noColor: opts.color === false } as never));
  });

program
  .command('watch')
  .argument('<runId>')
  .description(
    'live progress panel: phases, per-agent tokens/elapsed, budget (Ctrl-C detaches, never stops the run). ' +
      'Interactive on a TTY: up/down or j/k select an agent, enter opens its prompt/activity/outcome detail, esc backs out of the detail (in the overview it clears the selection), q detach',
  )
  .option('--plain', 'line-per-event output instead of the panel')
  .option('--no-color', 'panel without colors')
  .option('--home <dir>')
  .action(async (runId: string, opts: { plain?: boolean; color?: boolean; home?: string }) => {
    const { watchCommand } = await import('./watch.js');
    // commander's --no-color negates a `color` option (true by default)
    process.exit(await watchCommand(runId, { home: opts.home, plain: opts.plain, noColor: opts.color === false }));
  });

program
  .command('status')
  .argument('<runId>')
  .description('show run status (phases, agents, budget)')
  .option('--watch', 'poll until terminal')
  .option('--json')
  .option('--home <dir>')
  .action(async (runId: string, opts: Record<string, string | boolean>) => {
    const { statusCommand } = await import('./lifecycle.js');
    process.exit(await statusCommand(runId, opts as never));
  });

program
  .command('logs')
  .argument('<runId>')
  .description('print run events')
  .option('--follow', 'keep tailing until terminal')
  .option('--home <dir>')
  .action(async (runId: string, opts: Record<string, string | boolean>) => {
    const { logsCommand } = await import('./lifecycle.js');
    process.exit(await logsCommand(runId, opts as never));
  });

program
  .command('resume')
  .argument('<runId>', 'terminal run to resume from')
  .description('resume: completed agents replay from the journal, the rest run live')
  .option('--script <file>', 'edited script (unchanged prefix still replays)')
  .option('--args <json>', 'override args (changes the seed → full re-run)')
  .option('--max-concurrency <n>', 'override the stored concurrency for this resume')
  .option('--detach')
  .option('--json')
  .option('--plain', 'line-per-event progress instead of the live panel')
  .option('--no-color', 'live panel without colors')
  .option('--home <dir>')
  .option('--allow-nested', 'resume even inside an ultracode worker (ULTRACODE_INSIDE_RUN set)')
  .action(async (runId: string, opts: Record<string, string | boolean>) => {
    const { resumeCommand } = await import('./resume.js');
    process.exit(await resumeCommand(runId, { ...opts, noColor: opts.color === false } as never));
  });

program
  .command('stop')
  .argument('<runId>')
  .description('stop a running workflow (SIGTERM → 7s → SIGKILL)')
  .option('--home <dir>')
  .action(async (runId: string, opts: Record<string, string | boolean>) => {
    const { stopCommand } = await import('./lifecycle.js');
    process.exit(await stopCommand(runId, opts as never));
  });

program
  .command('list')
  .description('list runs in the run store')
  .option('--count <n>', 'max runs to show (default 10; also caps --all)')
  .option('--all', 'show every run: no recency filter, uncapped unless --count is given')
  .option('--reap', 'finalize orphaned runs first')
  .option('--json', 'machine-readable JSON (also capped; pass --all for the full store, optionally --count to cap it)')
  .option('--home <dir>')
  .action(async (opts: Record<string, string | boolean>) => {
    const { listCommand } = await import('./lifecycle.js');
    process.exit(listCommand(opts as never));
  });

const memory = program
  .command('memory')
  .description('Claude-compatible project memory: inspect, recall, update, and migrate');

memory
  .command('info')
  .description('show the current project memory location, mode, and topics')
  .option('--cwd <dir>')
  .option('--json')
  .action(async (opts: { cwd?: string; json?: boolean }) => {
    const { memoryInfoCommand } = await import('./memory.js');
    process.exit(memoryInfoCommand(opts));
  });

memory
  .command('context')
  .description('print the startup memory index and unconditional rules')
  .option('--cwd <dir>')
  .option('--json')
  .action(async (opts: { cwd?: string; json?: boolean }) => {
    const { memoryContextCommand } = await import('./memory.js');
    process.exit(memoryContextCommand(opts));
  });

memory
  .command('search')
  .argument('<query>')
  .description('search MEMORY.md and detailed topic files')
  .option('--cwd <dir>')
  .option('--limit <n>')
  .option('--json')
  .action(async (query: string, opts: { cwd?: string; limit?: string; json?: boolean }) => {
    const { memorySearchCommand } = await import('./memory.js');
    process.exit(memorySearchCommand(query, opts));
  });

memory
  .command('read')
  .argument('<topic>')
  .description('read one detailed memory topic (use memory for MEMORY.md)')
  .option('--cwd <dir>')
  .option('--json')
  .action(async (topic: string, opts: { cwd?: string; json?: boolean }) => {
    const { memoryReadCommand } = await import('./memory.js');
    process.exit(memoryReadCommand(topic, opts));
  });

memory
  .command('remember')
  .argument('<text>')
  .description('save one durable, verified project learning')
  .option('--topic <name>', 'detailed topic file', 'general')
  .option('--summary <text>', 'concise MEMORY.md index summary')
  .option('--cwd <dir>')
  .option('--allow-sensitive', 'allow content that resembles a secret (unsafe)')
  .option('--json')
  .action(async (
    text: string,
    opts: { topic?: string; summary?: string; cwd?: string; allowSensitive?: boolean; json?: boolean },
  ) => {
    const { memoryRememberCommand } = await import('./memory.js');
    process.exit(memoryRememberCommand(text, opts));
  });

memory
  .command('forget')
  .argument('<topic>')
  .description('delete one topic and its MEMORY.md index entry')
  .option('--cwd <dir>')
  .option('--yes', 'confirm destructive deletion')
  .option('--json')
  .action(async (topic: string, opts: { cwd?: string; yes?: boolean; json?: boolean }) => {
    const { memoryForgetCommand } = await import('./memory.js');
    process.exit(memoryForgetCommand(topic, opts));
  });

memory
  .command('mode')
  .argument('[value]', 'on | off (omit to print)')
  .description('enable or disable auto memory for the current project')
  .option('--cwd <dir>')
  .action(async (value: string | undefined, opts: { cwd?: string }) => {
    const { memoryModeCommand } = await import('./memory.js');
    process.exit(memoryModeCommand(value, opts));
  });

memory
  .command('rules')
  .argument('<path>')
  .description('load migrated Claude path-scoped rules matching a project file')
  .option('--cwd <dir>')
  .option('--json')
  .action(async (path: string, opts: { cwd?: string; json?: boolean }) => {
    const { memoryRulesCommand } = await import('./memory.js');
    process.exit(memoryRulesCommand(path, opts));
  });

memory
  .command('migrate-claude')
  .description('plan or apply a non-destructive import of Claude Code auto memory and rules')
  .option('--cwd <dir>')
  .option('--from <dir>', 'explicit Claude project or memory directory')
  .option('--apply', 'write the reviewed migration plan')
  .option('--include-sensitive', 'copy memory that resembles secrets (unsafe)')
  .option('--json')
  .action(async (opts: {
    cwd?: string;
    from?: string;
    apply?: boolean;
    includeSensitive?: boolean;
    json?: boolean;
  }) => {
    const { memoryMigrateClaudeCommand } = await import('./memory.js');
    process.exit(memoryMigrateClaudeCommand(opts));
  });

memory
  .command('hook', { hidden: true })
  .description('Codex SessionStart hook adapter')
  .action(async () => {
    const { runMemoryHook } = await import('./memory.js');
    process.exit(runMemoryHook());
  });

program
  .command('install')
  .argument('<host>', 'codex | qoder | generic')
  .description('install workflow orchestration + portable memory skills and host wiring')
  .option('--project', 'install into the current project instead of the user scope')
  .option('--dry-run', 'show what would change without writing')
  .action(async (host: string, opts: { project?: boolean; dryRun?: boolean }) => {
    const { installCommand } = await import('./install.js');
    process.exit(await installCommand(host, opts));
  });

program
  .command('update')
  .description('update ultracode from the release server')
  .option('--check', 'report whether an update is available without installing; exit 1 if one is')
  .option('--to <version>', 'install a specific version instead of the latest')
  .action(async (opts: { check?: boolean; to?: string }) => {
    const { updateCommand } = await import('./update.js');
    process.exit(await updateCommand(opts));
  });

program
  .command('mode')
  .argument('[value]', 'on | off (omit to print)')
  .description('read or set the standing ultracode-mode marker (.ultracode/mode)')
  .option('--home <dir>')
  .action(async (value: string | undefined, opts: { home?: string }) => {
    const { modeCommand } = await import('./mode.js');
    process.exit(modeCommand(value, opts));
  });

program
  .command('doctor')
  .description('probe backends: availability, versions, auth topology')
  .option('--json')
  .action(async (opts: { json?: boolean }) => {
    const { doctorCommand } = await import('./doctor.js');
    process.exit(await doctorCommand(opts));
  });

program
  .command('validate')
  .argument('<script>', 'workflow script file (*.workflow.js)')
  .description('validate meta block, dialect constraints, and compilability')
  .option('--json', 'machine-readable output')
  .action((script: string, opts: { json?: boolean }) => {
    process.exit(runValidateCommand(script, opts));
  });

program
  .command('sync')
  .description('sync canonical .ultracode/workflows into .claude/workflows and .qoder/workflows (stamped copies)')
  .option('--check', 'report drift without writing; exit 1 on drift')
  .option('--adopt <hostFile>', 'reclaim a hand-edited host copy back into the canonical dir')
  .action(async (opts: { check?: boolean; adopt?: string }) => {
    const { syncCommand } = await import('./sync.js');
    process.exit(syncCommand(opts));
  });

program
  .command('lint')
  .argument('<script>', 'workflow script file')
  .description('check a workflow for cross-engine portability (Claude Code / Qoder native / ultracode)')
  .option('--json')
  .action(async (script: string, opts: { json?: boolean }) => {
    const { lintCommand } = await import('./lint.js');
    process.exit(lintCommand(script, opts));
  });

program
  .command('mcp')
  .description('start the ultracode MCP server on stdio (workflow_start/status/result/stop/list)')
  .action(async () => {
    const { mcpMain } = await import('../mcp/server.js');
    await mcpMain();
    process.exit(0);
  });

program
  .command('__runner', { hidden: true })
  .requiredOption('--run-dir <dir>')
  .action(async (opts: { runDir: string }) => {
    const { runnerMain } = await import('./runner.js');
    try {
      process.exit(await runnerMain(opts.runDir));
    } catch (err) {
      process.stderr.write(`runner fatal: ${(err as Error)?.stack ?? err}\n`);
      process.exit(1);
    }
  });

program.parseAsync().catch((err) => {
  process.stderr.write(`ultracode: ${err?.message ?? err}\n`);
  process.exit(1);
});
