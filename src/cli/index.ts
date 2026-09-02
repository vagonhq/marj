#!/usr/bin/env node
import { promises as fs } from 'node:fs';
import process from 'node:process';
import { GitError, startServer } from '../server/index.js';
import { findServer, MarjClient, NoServerError } from './api.js';
import type { AgentEvent } from '../shared/types.js';

const HELP = `marj — review local git changes in your browser, with your Claude Code session in the thread

Usage
  marj [<revision>...]            start the review server and open the browser
  marj watch                      stream new comments, one line each (for agents)
  marj threads [--pending]        list threads
  marj show <id>                  print a thread with its code context
  marj reply <id> [text]          post an agent reply (reads stdin when text is omitted)
  marj comment <file> <line> <text>   open a new thread as the agent
  marj resolve <id>               mark a thread resolved
  marj stop                       stop the running server

Targets
  marj                            working tree vs HEAD (plus untracked files)
  marj .                          unstaged changes only
  marj --staged                   staged changes only
  marj a1b2c3d                    a single commit
  marj main..feature              a range
  marj main feature               two revisions
  git diff | marj -               a diff from stdin

Options
  --port <n>       preferred port (default 4711)
  --host <h>       bind address (default 127.0.0.1)
  --context <n>    diff context lines (default 5)
  --no-open        do not open a browser
  --no-watch       do not refresh when files change
  --json           machine readable output
  --pending        (threads) only unanswered threads
  --resolve        (reply) mark the thread resolved afterwards
  --typing         (reply) only flip the "Claude is typing" indicator
  --cursor <n>     (watch) resume from a sequence number
  --no-catch-up    (watch) skip comments that arrived before the watch started
  -h, --help       this text
`;

interface Args {
  command: string;
  positional: string[];
  flags: Record<string, string | boolean>;
}

function parseArgs(argv: string[]): Args {
  const flags: Record<string, string | boolean> = {};
  const positional: string[] = [];
  const withValue = new Set(['port', 'host', 'context', 'cursor', 'side', 'timeout']);

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--') {
      positional.push(...argv.slice(i + 1));
      break;
    }
    if (arg.startsWith('--')) {
      const [name, inline] = arg.slice(2).split('=', 2);
      if (withValue.has(name)) flags[name] = inline ?? argv[++i] ?? '';
      else if (name.startsWith('no-')) flags[name.slice(3)] = false;
      else flags[name] = inline ?? true;
      continue;
    }
    if (arg === '-h') { flags.help = true; continue; }
    positional.push(arg);
  }

  const commands = new Set(['watch', 'threads', 'show', 'reply', 'comment', 'resolve', 'stop', 'serve']);
  const command = commands.has(positional[0]) ? positional.shift()! : 'serve';
  return { command, positional, flags };
}

const num = (value: string | boolean | undefined, fallback: number): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

async function connect(flags: Args['flags']): Promise<MarjClient> {
  const info = await findServer(process.cwd(), flags.port ? num(flags.port, 0) : undefined);
  return new MarjClient(info.url);
}

function formatEvent(event: AgentEvent): string {
  const range = event.startLine === event.endLine ? `${event.startLine}` : `${event.startLine}-${event.endLine}`;
  const body = event.body.replace(/\s*\n+\s*/g, ' ⏎ ').trim();
  const clipped = body.length > 400 ? `${body.slice(0, 397)}...` : body;
  const label = event.kind === 'new-thread' ? 'COMMENT' : 'REPLY';
  return `${label} ${event.threadId} ${event.file}:${range} (${event.side}) — ${clipped}`;
}

async function cmdServe(args: Args): Promise<void> {
  // stdin is only consumed when explicitly asked for with `-`, so running in
  // the background (no tty) does not hang waiting for input
  const stdinDiff = args.positional.includes('-') ? await readStdin() : undefined;
  const positional = args.positional.filter((p) => p !== '-');

  const running = await startServer({
    cwd: process.cwd(),
    positional,
    staged: args.flags.staged === true,
    port: args.flags.port ? num(args.flags.port, 4711) : undefined,
    host: typeof args.flags.host === 'string' ? args.flags.host : undefined,
    context: args.flags.context ? num(args.flags.context, 5) : undefined,
    stdinDiff,
    watch: args.flags.watch !== false,
  });

  if (args.flags.json) {
    console.log(JSON.stringify(running.info));
  } else {
    console.log(`marj → ${running.info.url}  (${running.info.mode})`);
    console.log('comments land in your agent via `marj watch`; Ctrl-C to stop');
  }

  if (args.flags.open !== false) {
    const { default: open } = await import('open');
    await open(running.info.url).catch(() => {});
  }

  const shutdown = async () => {
    await running.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
}

async function cmdWatch(args: Args): Promise<void> {
  const timeout = num(args.flags.timeout, 60);
  let client: MarjClient | null = null;
  let cursor = args.flags.cursor !== undefined ? num(args.flags.cursor, 0) : -1;

  for (;;) {
    try {
      if (!client) {
        client = await connect(args.flags);
        if (cursor === -1) {
          const { cursor: current, events } = await client.queue();
          if (args.flags['catch-up'] !== false) for (const event of events) console.log(formatEvent(event));
          cursor = current;
        }
      }
      const result = await client.wait(cursor, timeout);
      for (const event of result.events) console.log(formatEvent(event));
      cursor = Math.max(cursor, result.cursor);
    } catch (err) {
      if (err instanceof NoServerError) {
        console.log(`SERVER GONE — ${err.message}`);
        return;
      }
      // transient: the server may be restarting
      client = null;
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
}

async function cmdThreads(args: Args): Promise<void> {
  const client = await connect(args.flags);
  const { threads } = await client.threads();
  const filtered = args.flags.pending
    ? threads.filter((t) => t.status === 'open' || t.messages.at(-1)?.role === 'user')
    : threads;

  if (args.flags.json) {
    console.log(JSON.stringify(filtered, null, 2));
    return;
  }
  if (filtered.length === 0) {
    console.log('no threads');
    return;
  }
  for (const thread of filtered) {
    const range = thread.startLine === thread.endLine ? `${thread.startLine}` : `${thread.startLine}-${thread.endLine}`;
    const last = thread.messages.at(-1);
    console.log(`${thread.id.padEnd(5)} ${thread.status.padEnd(9)} ${thread.file}:${range}  (${thread.messages.length} msg)`);
    if (last) console.log(`      ${last.role}: ${last.body.replace(/\n/g, ' ').slice(0, 120)}`);
  }
}

async function cmdShow(args: Args): Promise<void> {
  const id = args.positional[0];
  if (!id) throw new Error('usage: marj show <threadId>');
  const client = await connect(args.flags);
  const { thread, context } = await client.thread(id);

  if (args.flags.json) {
    console.log(JSON.stringify({ thread, context }, null, 2));
    return;
  }
  const range = thread.startLine === thread.endLine ? `${thread.startLine}` : `${thread.startLine}-${thread.endLine}`;
  console.log(`${thread.id}  ${thread.file}:${range} (${thread.side} side, ${thread.status})\n`);
  for (const line of context.lines) {
    const marker = line.type === 'add' ? '+' : line.type === 'del' ? '-' : ' ';
    const pointer = line.commented ? '>' : ' ';
    console.log(`${pointer}${String(line.no).padStart(5)} ${marker}${line.text}`);
  }
  console.log('');
  for (const message of thread.messages) {
    console.log(`--- ${message.role} (${message.createdAt}) ---`);
    console.log(message.body);
  }
}

async function cmdReply(args: Args): Promise<void> {
  const [id, ...rest] = args.positional;
  if (!id) throw new Error('usage: marj reply <threadId> [text]');
  const client = await connect(args.flags);

  if (args.flags.typing) {
    await client.patch(id, { agentTyping: true });
    return;
  }
  const body = rest.length > 0 ? rest.join(' ') : await readStdin();
  if (!body.trim()) throw new Error('empty reply');
  await client.reply(id, body);
  if (args.flags.resolve) await client.patch(id, { status: 'resolved' });
  if (!args.flags.json) console.log(`replied to ${id}`);
}

async function cmdComment(args: Args): Promise<void> {
  const [file, line, ...rest] = args.positional;
  if (!file || !line) throw new Error('usage: marj comment <file> <line[-endLine]> <text>');
  const [start, end] = line.split('-');
  const body = rest.length > 0 ? rest.join(' ') : await readStdin();
  const client = await connect(args.flags);
  const thread = await client.comment({
    file,
    side: typeof args.flags.side === 'string' ? args.flags.side : 'new',
    startLine: Number(start),
    endLine: Number(end ?? start),
    body,
  });
  console.log(args.flags.json ? JSON.stringify(thread) : `opened ${thread.id} on ${file}:${line}`);
}

async function cmdResolve(args: Args): Promise<void> {
  const id = args.positional[0];
  if (!id) throw new Error('usage: marj resolve <threadId>');
  const client = await connect(args.flags);
  await client.patch(id, { status: 'resolved' });
  if (!args.flags.json) console.log(`resolved ${id}`);
}

async function cmdStop(args: Args): Promise<void> {
  const info = await findServer(process.cwd(), args.flags.port ? num(args.flags.port, 0) : undefined);
  if (!info.pid) throw new Error('no pid recorded for the running server');
  process.kill(info.pid, 'SIGTERM');
  await fs.rm(`${info.repoRoot}/.marj/server.json`, { force: true });
  console.log(`stopped marj (pid ${info.pid})`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.flags.help) {
    console.log(HELP);
    return;
  }
  switch (args.command) {
    case 'watch': return cmdWatch(args);
    case 'threads': return cmdThreads(args);
    case 'show': return cmdShow(args);
    case 'reply': return cmdReply(args);
    case 'comment': return cmdComment(args);
    case 'resolve': return cmdResolve(args);
    case 'stop': return cmdStop(args);
    default: return cmdServe(args);
  }
}

main().catch((err: unknown) => {
  const message = err instanceof GitError || err instanceof NoServerError || err instanceof Error
    ? err.message
    : String(err);
  console.error(`marj: ${message}`);
  process.exit(1);
});
