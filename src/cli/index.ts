#!/usr/bin/env node
import { promises as fs } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { findLiveServer, GitError, MARJ_DIR, normaliseSession, startServer, stateDir } from '../server/index.js';
import { repoRootOf } from '../server/git.js';
import { findServer, MarjClient, NoServerError } from './api.js';
import { describeTarget, FILE_LEVEL, isChat, isFileLevel, type AgentEvent, type Thread } from '../shared/types.js';

const HELP = `marj — review local git changes in your browser, with your Claude Code session in the thread

Usage
  marj [<revision>...]            start the review server and open the browser
  marj watch                      stream new comments, one line each (for agents)
  marj threads [--pending]        list threads
  marj show <id>                  print a thread with its code context
  marj reply <id> [text]          post an agent reply (reads stdin when text is omitted)
  marj reply chat [text]          answer in the review chat (the "Explain these changes" panel)
  marj comment <file> <line> <text>   open a new thread as the agent
  marj comment <file> <text>      open a thread on the file as a whole
  marj resolve <id>               mark a thread resolved
  marj delete <id>...             delete threads permanently
  marj stop                       stop the running server
  marj reload                     sync from the remote (fetch, re-pull a PR) and refresh the diff
  marj reset                      stop every server for this repo and delete all threads/chat (.marj)

Sessions (independent reviews in the same repo)
  marj --session <name>           start an isolated server: its own threads, chat and port
  marj <cmd> --session <name>     talk to that server (watch, threads, show, reply, stop, …)
  marj --force                    start another server without a name (auto: s2, s3, …)

Targets
  marj                            working tree vs HEAD (plus untracked files)
  marj .                          unstaged changes only
  marj --staged                   staged changes only
  marj a1b2c3d                    a single commit
  marj develop                    the current branch as a PR into develop
  marj develop..feature           feature as a PR into develop (from the merge base, like GitHub)
  marj develop feature            same
  marj https://github.com/o/r/pull/12   a GitHub pull request (also o/r#12, #12, pull/12)
  git diff | marj -               a diff from stdin

Options
  --exact          compare two revisions tip to tip instead of from their merge base
  --port <n>       preferred port (default 4711)
  --host <h>       bind address (default 127.0.0.1)
  --context <n>    diff context lines (default 5)
  --no-open        do not open a browser
  --force          start a second server for a repo that already has one
  --no-watch       do not refresh when files change
  --json           machine readable output
  --pending        (threads) only unanswered threads
  --session <name> (any command) target an isolated review, not the default one
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
  const withValue = new Set(['port', 'host', 'context', 'cursor', 'side', 'timeout', 'session']);

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

  const commands = new Set(['watch', 'threads', 'show', 'reply', 'comment', 'resolve', 'delete', 'stop', 'reload', 'reset', 'serve']);
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

function sessionOf(flags: Args['flags']): string | undefined {
  return typeof flags.session === 'string' && flags.session.trim() ? flags.session : undefined;
}

async function connect(flags: Args['flags']): Promise<MarjClient> {
  const info = await findServer(process.cwd(), flags.port ? num(flags.port, 0) : undefined, sessionOf(flags));
  return new MarjClient(info.url);
}

/** Pick a free `s2`, `s3`, … under .marj/sessions so `--force` never clobbers the default. */
async function autoSession(repoRoot: string): Promise<string> {
  for (let n = 2; ; n++) {
    const name = `s${n}`;
    if (!(await findLiveServer(repoRoot, name))) return name;
  }
}

function formatEvent(event: AgentEvent): string {
  const body = event.body.replace(/\s*\n+\s*/g, ' ⏎ ').trim();
  const clipped = body.length > 400 ? `${body.slice(0, 397)}...` : body;
  if (event.kind === 'chat') return `CHAT ${event.threadId} [${event.intent}] — ${clipped}`;
  const label = event.kind === 'new-thread' ? 'COMMENT' : 'REPLY';
  return `${label} ${event.threadId} ${whereIs({ ...event, id: event.threadId })} [${event.intent}] — ${clipped}`;
}

function whereIs(target: Pick<Thread, 'id' | 'file' | 'startLine' | 'endLine'>): string {
  if (isChat(target)) return 'review chat';
  return isFileLevel(target) ? `${target.file} (whole file)` : describeTarget(target);
}

async function cmdServe(args: Args): Promise<void> {
  // stdin is only consumed when explicitly asked for with `-`, so running in
  // the background (no tty) does not hang waiting for input
  const stdinDiff = args.positional.includes('-') ? await readStdin() : undefined;
  const positional = args.positional.filter((p) => p !== '-');

  const repoRoot = await repoRootOf(process.cwd());
  let session = normaliseSession(sessionOf(args.flags)) ?? undefined;

  // one server per (repo, session); reuse an existing one rather than doubling up
  const existing = await findLiveServer(repoRoot, session ?? null);
  if (existing) {
    if (args.flags.force === true) {
      // an explicit second server for the same target gets its own isolated session
      session = await autoSession(repoRoot);
    } else {
      if (args.flags.json) {
        console.log(JSON.stringify({ ...existing, reused: true }));
      } else {
        const label = existing.session ? `session "${existing.session}"` : 'this repo';
        console.log(`marj is already running for ${label} → ${existing.url}  (${existing.mode})`);
        console.log('`marj stop` to shut it down, or `marj --session <name>` for an isolated one');
      }
      if (args.flags.open !== false) {
        const { default: open } = await import('open');
        await open(existing.url).catch(() => {});
      }
      return;
    }
  }

  const running = await startServer({
    cwd: process.cwd(),
    positional,
    staged: args.flags.staged === true,
    exact: args.flags.exact === true,
    port: args.flags.port ? num(args.flags.port, 4711) : undefined,
    host: typeof args.flags.host === 'string' ? args.flags.host : undefined,
    context: args.flags.context ? num(args.flags.context, 5) : undefined,
    stdinDiff,
    watch: args.flags.watch !== false,
    session,
  });

  if (args.flags.json) {
    console.log(JSON.stringify(running.info));
  } else {
    const tag = running.info.session ? `  [session ${running.info.session}]` : '';
    console.log(`marj → ${running.info.url}  (${running.info.mode})${tag}`);
    const watch = running.info.session ? `marj watch --session ${running.info.session}` : 'marj watch';
    console.log(`comments land in your agent via \`${watch}\`; Ctrl-C to stop`);
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
    const last = thread.messages.at(-1);
    console.log(`${thread.id.padEnd(5)} ${thread.status.padEnd(9)} ${whereIs(thread)}  (${thread.messages.length} msg)`);
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
  const side = isChat(thread) || isFileLevel(thread) ? '' : `${thread.side} side, `;
  console.log(`${thread.id}  ${whereIs(thread)} (${side}${thread.status})\n`);
  for (const line of context.lines) {
    const marker = line.type === 'add' ? '+' : line.type === 'del' ? '-' : ' ';
    const pointer = line.commented ? '>' : ' ';
    console.log(`${pointer}${String(line.no).padStart(5)} ${marker}${line.text}`);
  }
  if (context.lines.length > 0) console.log('');
  for (const message of thread.messages) {
    const intent = message.intent ? ` asked for: ${message.intent}` : '';
    console.log(`--- ${message.role}${intent} (${message.createdAt}) ---`);
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
  const [file, ...rest] = args.positional;
  if (!file) throw new Error('usage: marj comment <file> [<line[-endLine]>] <text>');

  // a leading "12" or "12-15" targets lines; anything else means the whole file
  const lineArg = /^\d+(-\d+)?$/.test(rest[0] ?? '') ? rest.shift()! : null;
  const [start, end] = lineArg ? lineArg.split('-').map(Number) : [FILE_LEVEL, FILE_LEVEL];
  const body = rest.length > 0 ? rest.join(' ') : await readStdin();
  if (!body.trim()) throw new Error('empty comment');

  const client = await connect(args.flags);
  const thread = await client.comment({
    file,
    side: typeof args.flags.side === 'string' ? args.flags.side : 'new',
    startLine: start,
    endLine: end ?? start,
    body,
  });
  const where = lineArg ? `${file}:${lineArg}` : `${file} (whole file)`;
  console.log(args.flags.json ? JSON.stringify(thread) : `opened ${thread.id} on ${where}`);
}

async function cmdResolve(args: Args): Promise<void> {
  const id = args.positional[0];
  if (!id) throw new Error('usage: marj resolve <threadId>');
  const client = await connect(args.flags);
  await client.patch(id, { status: 'resolved' });
  if (!args.flags.json) console.log(`resolved ${id}`);
}

async function cmdDelete(args: Args): Promise<void> {
  if (args.positional.length === 0) throw new Error('usage: marj delete <threadId>...');
  const client = await connect(args.flags);
  for (const id of args.positional) {
    await client.remove(id);
    if (!args.flags.json) console.log(`deleted ${id}`);
  }
}

async function cmdStop(args: Args): Promise<void> {
  const info = await findServer(process.cwd(), args.flags.port ? num(args.flags.port, 0) : undefined, sessionOf(args.flags));
  if (!info.pid) throw new Error('no pid recorded for the running server');
  process.kill(info.pid, 'SIGTERM');
  await fs.rm(path.join(stateDir(info.repoRoot, normaliseSession(sessionOf(args.flags))), 'server.json'), { force: true });
  const tag = info.session ? ` (session ${info.session})` : '';
  console.log(`stopped marj${tag} (pid ${info.pid})`);
}

async function cmdReload(args: Args): Promise<void> {
  const client = await connect(args.flags);
  const result = await client.reload();
  if (args.flags.json) {
    console.log(JSON.stringify(result));
    return;
  }
  if (result.fetched) console.log('reloaded: fetched from the remote and refreshed the diff');
  else console.log(`refreshed the diff (fetch had problems: ${(result.errors ?? []).join('; ') || 'offline?'})`);
}

/** Wait until a process is gone, or give up after `ms`. */
async function waitForExit(pid: number, ms: number): Promise<void> {
  const until = Date.now() + ms;
  for (;;) {
    try {
      process.kill(pid, 0);
    } catch {
      return; // gone
    }
    if (Date.now() > until) return;
    await new Promise((r) => setTimeout(r, 50));
  }
}

async function cmdReset(args: Args): Promise<void> {
  const repoRoot = await repoRootOf(process.cwd());
  const marjDir = `${repoRoot}/${MARJ_DIR}`;

  // collect the default server and every session server, kill them all
  const infoPaths = [`${marjDir}/server.json`];
  try {
    const sessions = await fs.readdir(`${marjDir}/sessions`);
    for (const name of sessions) infoPaths.push(`${marjDir}/sessions/${name}/server.json`);
  } catch {
    /* no sessions */
  }
  const pids: number[] = [];
  for (const infoPath of infoPaths) {
    try {
      const info = JSON.parse(await fs.readFile(infoPath, 'utf8')) as { pid?: number };
      if (info.pid) pids.push(info.pid);
    } catch {
      /* not running */
    }
  }
  for (const pid of pids) {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      /* already gone */
    }
  }
  // let them flush and exit before we delete, so a late save can't recreate state
  await Promise.all(pids.map((pid) => waitForExit(pid, 2000)));
  await fs.rm(marjDir, { recursive: true, force: true });

  if (args.flags.json) console.log(JSON.stringify({ reset: true, stopped: pids.length }));
  else console.log(`reset marj: stopped ${pids.length} server${pids.length === 1 ? '' : 's'} and cleared ${MARJ_DIR}/`);
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
    case 'delete': return cmdDelete(args);
    case 'stop': return cmdStop(args);
    case 'reload': return cmdReload(args);
    case 'reset': return cmdReset(args);
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
