#!/usr/bin/env node
// mnemosync CLI: `mnemosync` starts the viewer,
// `mnemosync summary <session-id|path.jsonl>` prints a text summary (M1).

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { basename } from 'node:path';
import { defaultClaudeDir, listProjects, resolveSessionFile } from './parser/discover.js';
import { parseJsonlFile } from './parser/parse.js';
import { normalize } from './parser/normalize.js';
import { startServer } from './server/index.js';

interface Args {
  claudeDir: string;
  port: number;
  open: boolean;
  lan: boolean;
  command?: string;
  positional: string[];
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    claudeDir: defaultClaudeDir(),
    port: 0,
    open: true,
    lan: false,
    positional: [],
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--claude-dir') args.claudeDir = argv[++i] ?? args.claudeDir;
    else if (a === '--port') args.port = Number(argv[++i]) || 0;
    else if (a === '--no-open') args.open = false;
    else if (a === '--lan') args.lan = true;
    else if (a === '--help' || a === '-h') {
      printHelp();
      process.exit(0);
    } else if (!a.startsWith('-') && !args.command) args.command = a;
    else if (!a.startsWith('-')) args.positional.push(a);
  }
  return args;
}

function printHelp(): void {
  console.log(`mnemosync — replay Claude Code sessions as an animated timeline

Usage:
  mnemosync [options]                 start the viewer (opens browser)
  mnemosync summary <session|file>    print a text summary of a session
  mnemosync list                      list discovered projects/sessions

Options:
  --claude-dir <path>   Claude data dir (default: ~/.claude)
  --port <n>            port (default: random free port)
  --no-open             don't open the browser
  --lan                 also listen on your local network (0.0.0.0).
                        WARNING: anyone on the network can read your
                        session transcripts. Default is 127.0.0.1 only.
`);
}

function openBrowser(url: string): void {
  const cmd =
    process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
  spawn(cmd, [url], { stdio: 'ignore', detached: true, shell: process.platform === 'win32' })
    .on('error', () => console.log(`Open ${url} in your browser.`))
    .unref();
}

async function summarize(args: Args): Promise<void> {
  const target = args.positional[0];
  if (!target) {
    console.error('usage: mnemosync summary <session-id|path.jsonl>');
    process.exit(1);
  }
  let file = target;
  if (!existsSync(file)) {
    const found = resolveSessionFile(args.claudeDir, target);
    if (!found) {
      console.error(`session not found: ${target}`);
      process.exit(1);
    }
    file = found.file;
  }
  const { records, warnings } = await parseJsonlFile(file);
  const t = normalize(records, warnings, { sessionId: basename(file, '.jsonl') });
  const counts: Record<string, number> = {};
  for (const turn of t.turns) for (const ev of turn.events) counts[ev.kind] = (counts[ev.kind] ?? 0) + 1;
  console.log(`session   ${t.meta.sessionId}`);
  console.log(`project   ${t.meta.projectPath}`);
  if (t.meta.summary) console.log(`title     ${t.meta.summary}`);
  if (t.meta.model) console.log(`model     ${t.meta.model}`);
  console.log(`started   ${t.meta.startedAt}`);
  console.log(`turns     ${t.meta.turnCount}`);
  console.log(`events    ${t.meta.eventCount}  (${Object.entries(counts).map(([k, v]) => `${k}:${v}`).join(' ')})`);
  console.log(`files     ${t.meta.filesTouched.length}`);
  for (const f of t.meta.filesTouched.slice(0, 25)) console.log(`  - ${f}`);
  if (t.meta.filesTouched.length > 25) console.log(`  … +${t.meta.filesTouched.length - 25} more`);
  if (t.meta.subagents.length) console.log(`subagents ${t.meta.subagents.length}`);
  if (t.meta.parseWarnings.length) {
    console.log(`warnings  ${t.meta.parseWarnings.length}`);
    for (const w of t.meta.parseWarnings.slice(0, 10)) console.log(`  ! ${w}`);
  }
}

async function listCmd(args: Args): Promise<void> {
  for (const p of listProjects(args.claudeDir)) {
    console.log(`${p.decodedPath}  (${p.sessionCount} sessions)`);
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.command === 'summary') return summarize(args);
  if (args.command === 'list') return listCmd(args);
  if (args.command) {
    console.error(`unknown command: ${args.command}`);
    printHelp();
    process.exit(1);
  }
  const { port } = await startServer({
    claudeDir: args.claudeDir,
    port: args.port,
    host: args.lan ? '0.0.0.0' : '127.0.0.1',
    allowNonLoopback: args.lan,
  });
  const url = `http://127.0.0.1:${port}`;
  console.log(`mnemosync running at ${url}  (claude dir: ${args.claudeDir})`);
  if (args.lan) {
    console.log(
      `--lan: also listening on all interfaces (port ${port}) — anyone on your network can read your session transcripts`,
    );
  }
  if (args.open) openBrowser(url);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
