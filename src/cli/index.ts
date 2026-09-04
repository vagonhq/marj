#!/usr/bin/env node
import { promises as fs } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { findLiveHub, GitError, LEGACY_DIR, normaliseSession, repoStateBase, startServer, stateDir } from '../server/index.js';
import { repoRootOf } from '../server/git.js';
import { findServer, MarjClient, NoServerError } from './api.js';
import { describeTarget, FILE_LEVEL, isChat, isFileLevel, type AgentEvent, type Thread } from '../shared/types.js';

const HELP = `marj — review local git changes in your browser, with your Claude Code session in the thread

Usage
  marj [<revision>...]            review this repo: joins the hub (starting it if needed), opens the browser
  marj hub                        run the hub in the foreground (normally \`marj\` starts it as a daemon)
  marj watch                      stream new comments, one line each (for agents)
  marj threads [--pending]        list threads
  marj show <id>                  print a thread with its code context
  marj reply <id> [text]          post an agent reply (reads stdin when text is omitted)
  marj reply chat [text]          answer in the review chat (the "Explain these changes" panel)
  marj comment <file> <line> <text>   open a new thread as the agent
  marj comment <file> <text>      open a thread on the file as a whole
  marj resolve <id>               mark a thread resolved
  marj delete <id>...             delete threads permanently
  marj stop [--all]               end this repo's review; --all stops the hub and every review on it
  marj commit -m <msg> [--push] [path...]   commit the uncommitted changes (all, or just these paths)
  marj reload                     sync from the remote (fetch, re-pull a PR) and refresh the diff
  marj reset                      end every review of this repo and delete all its threads/chat

One hub, one port, every repo: each review lives at http://127.0.0.1:4711/r/<repo>/ and the
repo name in the header switches between repos and worktrees.

Sessions (independent reviews of the same repo)
  marj --session <name>           an isolated review: its own threads and chat
  marj <cmd> --session <name>     talk to that review (watch, threads, show, reply, stop, …)
  marj --force                    a second review of a repo already under review (auto-named s2, s3, …)

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
  --port <n>       (hub) preferred port when the hub is started (default 4711)
  --host <h>       (hub) bind address when the hub is started (default 127.0.0.1)
  --context <n>    diff context lines (default 5)
  --no-open        do not open a browser
  --force          a second, isolated review of a repo already under review
  --no-watch       do not refresh when files change
  --json           machine readable output
  --pending        (threads) only unanswered threads
  --session <name> (any command) target an isolated review, not the default one

State lives outside the repo, in ~/.marj/repos/<repo>-<hash>/ (override the root with MARJ_HOME).
  --resolve        (reply) mark the thread resolved afterwards
  --typing         (reply) only flip the "Claude is typing" indicator
  --push           (commit) push after committing (publishes the branch if it has no upstream)
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
  const withValue = new Set(['port', 'host', 'context', 'cursor', 'side', 'timeout', 'session', 'message']);

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
    if (arg === '-m') { flags.message = argv[++i] ?? ''; continue; }
    positional.push(arg);
  }

  const commands = new Set(['watch', 'threads', 'show', 'reply', 'comment', 'resolve', 'delete', 'stop', 'commit', 'reload', 'reset', 'hub', 'serve']);
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

  // marj works on a local clone, from anywhere inside it; it never clones
  try {
    await repoRootOf(process.cwd());
  } catch {
    throw new Error(
      `not inside a git repository (${process.cwd()}). marj reviews a local clone: cd into the repo — any subdirectory works — and run it again. It never clones.`,
    );
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
    session: sessionOf(args.flags),
    force: args.flags.force === true,
  });
  const { info } = running;

  if (args.flags.json) {
    console.log(JSON.stringify(info));
  } else {
    const tag = info.session ? `  [session ${info.session}]` : '';
    const sess = info.session ? ` --session ${info.session}` : '';
    console.log(`${info.reused ? 'already reviewing → ' : 'marj → '}${info.url}  (${info.mode})${tag}`);
    if (running.hubSpawned) {
      console.log(`hub started in the background at ${info.url.replace(/\/r\/.*$/, '')} — every repo shares it; \`marj stop --all\` shuts it down`);
    }
    console.log(`comments reach your agent via \`marj watch${sess}\`; \`marj stop${sess}\` ends this review`);
  }

  if (args.flags.open !== false) {
    const { default: open } = await import('open');
    await open(info.url).catch(() => {});
  }
}

/** The hub process: one port, every repo. `marj` starts it for you as a daemon; this runs it in the foreground. */
async function cmdHub(args: Args): Promise<void> {
  const { startHub } = await import('../server/hub.js');
  const { info, close } = await startHub({
    port: args.flags.port ? num(args.flags.port, 4711) : undefined,
    host: typeof args.flags.host === 'string' ? args.flags.host : undefined,
    exitWhenEmpty: args.flags['exit-when-empty'] !== false,
  });
  console.log(`marj hub → ${info.url}  (pid ${info.pid}); run \`marj\` inside a repo to add it`);
  const shutdown = async () => {
    await close();
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
  if (args.flags.all === true) {
    const hub = await findLiveHub();
    if (!hub) {
      console.log('no marj hub is running');
      return;
    }
    process.kill(hub.pid, 'SIGTERM');
    console.log(`stopped the marj hub (pid ${hub.pid}) and every review on it`);
    return;
  }
  const info = await findServer(process.cwd(), args.flags.port ? num(args.flags.port, 0) : undefined, sessionOf(args.flags));
  const id = info.id ?? info.url.match(/\/r\/([^/]+)/)?.[1];
  if (!id) throw new Error('that server.json predates the hub; use `marj stop --all`');
  const hubUrl = info.url.replace(/\/r\/[^/]+\/?$/, '');
  const res = await fetch(`${hubUrl}/api/repos/${encodeURIComponent(id)}`, { method: 'DELETE' }).catch(() => null);
  if (res && !res.ok && res.status !== 404) throw new Error(`could not stop the review: ${res.status}`);
  await fs.rm(path.join(stateDir(info.repoRoot, normaliseSession(sessionOf(args.flags))), 'server.json'), { force: true });
  const tag = info.session ? ` (session ${info.session})` : '';
  console.log(`stopped the review of ${info.repoRoot}${tag}`);
}

async function cmdCommit(args: Args): Promise<void> {
  // -m given (even blank) means "this is the message"; only without -m do we read a piped heredoc,
  // so a blank -m fails fast instead of hanging on stdin
  const message = typeof args.flags.message === 'string' ? args.flags.message : await readStdin();
  if (!message.trim()) {
    throw new Error('usage: marj commit -m "<message>" [--push] [path...]   (or pipe the message on stdin)');
  }
  const client = await connect(args.flags);
  const result = await client.commit({
    message,
    paths: args.positional.length > 0 ? args.positional : undefined,
    push: args.flags.push === true,
  });
  if (args.flags.json) {
    console.log(JSON.stringify(result));
    return;
  }
  const where = `${result.sha.slice(0, 7)} on ${result.branch ?? 'a detached HEAD'}`;
  if (result.pushed) console.log(`committed ${where} and pushed`);
  else if (args.flags.push) console.log(`committed ${where}, but the push failed: ${result.pushError ?? 'unknown error'}`);
  else console.log(`committed ${where}`);
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

async function cmdReset(args: Args): Promise<void> {
  const repoRoot = await repoRootOf(process.cwd());
  const base = repoStateBase(repoRoot);

  // unregister the default review and every session from the hub, if it is up
  const hub = await findLiveHub();
  const infoPaths = [path.join(base, 'server.json')];
  try {
    for (const name of await fs.readdir(path.join(base, 'sessions'))) infoPaths.push(path.join(base, 'sessions', name, 'server.json'));
  } catch {
    /* no sessions */
  }
  let stopped = 0;
  for (const infoPath of infoPaths) {
    try {
      const info = JSON.parse(await fs.readFile(infoPath, 'utf8')) as { id?: string; url?: string };
      const id = info.id ?? info.url?.match(/\/r\/([^/]+)/)?.[1];
      if (hub && id) {
        const res = await fetch(`${hub.url}/api/repos/${encodeURIComponent(id)}`, { method: 'DELETE' }).catch(() => null);
        if (res?.ok) stopped++;
      }
    } catch {
      /* not running */
    }
  }
  await fs.rm(base, { recursive: true, force: true });
  // and any folder an older marj left inside the repo
  await fs.rm(path.join(repoRoot, LEGACY_DIR), { recursive: true, force: true });

  if (args.flags.json) console.log(JSON.stringify({ reset: true, stopped, cleared: base }));
  else console.log(`reset marj: ended ${stopped} review${stopped === 1 ? '' : 's'} and cleared ${base}`);
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
    case 'hub': return cmdHub(args);
    case 'commit': return cmdCommit(args);
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
