import { promises as fs } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { buildAnchor, numbered, reanchorAll, sideLines, type NumberedLine } from './anchor.js';
import {
  checkoutReviewed,
  commitChanges,
  computeDiff,
  currentBranchName,
  diffFromRaw,
  git,
  GitError,
  hasHead,
  readSideFile,
  repoRootOf,
  resolveTarget,
  touchedSince,
  worktreeTarget,
  type DiffTarget,
} from './git.js';
import { ThreadStore } from './threads.js';
import { startWatcher } from './watch.js';
import { FILE_LEVEL, type DiffFile, type DiffPayload, type ServerEvent, type ServerInfo, type WorktreeState } from '../shared/types.js';

const CLIENT_DIR = fileURLToPath(new URL('../../client', import.meta.url));

export interface StartOptions {
  cwd: string;
  positional: string[];
  staged?: boolean;
  /** compare two revisions tip to tip instead of from their merge base */
  exact?: boolean;
  port?: number;
  host?: string;
  context?: number;
  /** raw unified diff read from stdin instead of running git */
  stdinDiff?: string;
  watch?: boolean;
  /** an isolated review: its own threads, chat and server registration */
  session?: string;
}

export interface RunningServer {
  info: ServerInfo;
  close: () => Promise<void>;
}

export const MARJ_DIR = '.marj';

/** valid session name, or null; keeps the name safe as a folder and stable across commands */
export function normaliseSession(name: string | undefined): string | null {
  if (!name) return null;
  const slug = name.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  return slug || null;
}

/** Where a session keeps its threads.json and server.json (the default lives in .marj itself). */
export function stateDir(repoRoot: string, session: string | null): string {
  return session ? path.join(repoRoot, MARJ_DIR, 'sessions', session) : path.join(repoRoot, MARJ_DIR);
}

/**
 * A marj already serving this repo (and this session), or null. Repos and
 * sessions each keep their own server.json, so they never overwrite each other.
 */
export async function findLiveServer(repoRoot: string, session: string | null = null): Promise<ServerInfo | null> {
  const infoPath = path.join(stateDir(repoRoot, session), 'server.json');
  let info: ServerInfo;
  try {
    info = JSON.parse(await fs.readFile(infoPath, 'utf8')) as ServerInfo;
  } catch {
    return null;
  }
  try {
    process.kill(info.pid, 0);
  } catch {
    return null; // recorded process is gone
  }
  try {
    const res = await fetch(`${info.url}/api/diff`, { signal: AbortSignal.timeout(1500) });
    if (!res.ok) return null;
    const payload = (await res.json()) as { repoRoot?: string };
    return payload.repoRoot === repoRoot ? info : null;
  } catch {
    return null; // port recorded but nothing answering
  }
}

export async function startServer(opts: StartOptions): Promise<RunningServer> {
  const context = opts.context ?? 5;
  const host = opts.host ?? '127.0.0.1';
  const repoRoot = await repoRootOf(opts.cwd);
  const session = normaliseSession(opts.session);
  const marjDir = stateDir(repoRoot, session);
  await fs.mkdir(marjDir, { recursive: true });
  await ensureGitExclude(repoRoot);

  const store = await ThreadStore.load(path.join(marjDir, 'threads.json'));
  /** files modified after this are the fixes of this review, not pre-existing local edits */
  const startedAt = new Date();

  let target: DiffTarget = { args: [], mode: 'stdin', includeUntracked: false };
  if (!opts.stdinDiff) {
    target = await resolveTarget(repoRoot, opts.positional, { staged: opts.staged, exact: opts.exact });
  }

  let diff: DiffPayload = opts.stdinDiff
    ? await diffFromRaw(opts.stdinDiff, repoRoot)
    : await computeDiff(repoRoot, target, context);

  // whole-file content per side, read once per diff version
  let fileCache = new Map<string, Promise<string[] | null>>();
  const fileLines = (side: 'old' | 'new', file: string): Promise<string[] | null> => {
    const key = `${side}:${file}`;
    let pending = fileCache.get(key);
    if (!pending) {
      pending = readSideFile(repoRoot, target, side, file);
      fileCache.set(key, pending);
    }
    return pending;
  };
  const linesFor = async (file: DiffFile, side: 'old' | 'new'): Promise<NumberedLine[] | null> => {
    const path = side === 'old' ? file.oldPath ?? file.path : file.path;
    const lines = await fileLines(side, path);
    return lines ? numbered(lines) : null;
  };
  await reanchorAll(store, diff, linesFor);

  const clients = new Set<express.Response>();
  const broadcast = (event: ServerEvent) => {
    const payload = `data: ${JSON.stringify(event)}\n\n`;
    for (const res of clients) res.write(payload);
  };

  const refresh = async () => {
    if (opts.stdinDiff) return;
    try {
      diff = await computeDiff(repoRoot, target, context);
      fileCache = new Map();
      await reanchorAll(store, diff, linesFor);
      broadcast({ type: 'diff:changed', version: diff.version });
    } catch (err) {
      console.error('[marj] diff refresh failed:', (err as Error).message);
    }
  };

  store.onChange(() => broadcast({ type: 'threads:changed', cursor: store.cursor }));

  const app = express();
  app.use(express.json({ limit: '4mb' }));

  app.get('/api/diff', (_req, res) => res.json(diff));

  app.get('/api/threads', (_req, res) => res.json({ cursor: store.cursor, threads: store.list() }));

  app.get('/api/threads/:id', async (req, res) => {
    const thread = store.get(req.params.id);
    if (!thread) return res.status(404).json({ error: 'no such thread' });
    const diffFile = diff.files.find((f) => f.path === thread.file || f.oldPath === thread.file);
    const full = diffFile ? await linesFor(diffFile, thread.side) : null;
    res.json({ thread, context: threadContext(diff, thread.file, thread.side, thread.startLine, thread.endLine, 6, full) });
  });

  /** One side of a file in full, so the browser can expand the lines around a hunk. */
  app.get('/api/file', async (req, res) => {
    const file = String(req.query.path ?? '');
    const side = req.query.side === 'old' ? 'old' : 'new';
    const known = diff.files.some((f) => f.path === file || f.oldPath === file);
    if (!file || !known) return res.status(404).json({ error: 'file is not part of this diff' });
    const lines = await fileLines(side, file);
    if (!lines) return res.status(404).json({ error: 'no content for this side' });
    res.json({ path: file, side, lines });
  });

  app.post('/api/threads', async (req, res) => {
    const { file, side, startLine, endLine, body, role, intent } = req.body ?? {};
    if (typeof file !== 'string' || typeof body !== 'string' || !body.trim()) {
      return res.status(400).json({ error: 'file and body are required' });
    }
    // no line (or 0) means the comment is about the file as a whole
    const start = Number(startLine ?? FILE_LEVEL) || FILE_LEVEL;
    const end = Number(endLine ?? start) || start;
    const diffFile = diff.files.find((f) => f.path === file || f.oldPath === file);
    const which = side === 'old' ? 'old' : 'new';
    const full = diffFile && start !== FILE_LEVEL ? await linesFor(diffFile, which) : null;
    const anchor =
      diffFile && start !== FILE_LEVEL ? buildAnchor(diffFile, which, start, end, full ?? undefined) : undefined;
    const thread = store.createThread({
      file,
      side: side === 'old' ? 'old' : 'new',
      startLine: start,
      endLine: Math.max(start, end),
      body,
      anchor,
      role: role === 'agent' ? 'agent' : 'user',
      intent: intent === 'fix' ? 'fix' : 'ask',
    });
    res.status(201).json(thread);
  });

  app.post('/api/threads/:id/messages', (req, res) => {
    const { role, body, intent } = req.body ?? {};
    if (typeof body !== 'string' || !body.trim()) return res.status(400).json({ error: 'body is required' });
    try {
      const message = store.addMessage(
        req.params.id,
        role === 'agent' ? 'agent' : 'user',
        body,
        intent === 'fix' ? 'fix' : 'ask',
      );
      res.status(201).json({ message, thread: store.get(req.params.id) });
    } catch (err) {
      res.status(404).json({ error: (err as Error).message });
    }
  });

  app.patch('/api/threads/:id', (req, res) => {
    const { status, agentTyping } = req.body ?? {};
    try {
      res.json(store.patch(req.params.id, { status, agentTyping }));
    } catch (err) {
      res.status(404).json({ error: (err as Error).message });
    }
  });

  app.delete('/api/threads/:id', (req, res) => {
    if (!store.remove(req.params.id)) return res.status(404).json({ error: 'no such thread' });
    res.status(204).end();
  });

  app.get('/api/agent/queue', (_req, res) => {
    res.json({ cursor: store.cursor, events: store.queue() });
  });

  app.get('/api/agent/wait', async (req, res) => {
    const cursor = Number(req.query.cursor ?? 0) || 0;
    const timeout = Math.min(Math.max(Number(req.query.timeout ?? 60), 1), 300) * 1000;
    const result = await store.wait(cursor, timeout);
    res.json(result);
  });

  app.get('/api/events', (req, res) => {
    res.set({
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    });
    res.flushHeaders?.();
    clients.add(res);
    res.write(`data: ${JSON.stringify({ type: 'hello', cursor: store.cursor, version: diff.version })}\n\n`);
    const heartbeat = setInterval(() => res.write(': ping\n\n'), 25_000);
    req.on('close', () => {
      clearInterval(heartbeat);
      clients.delete(res);
    });
  });

  app.post('/api/refresh', async (_req, res) => {
    await refresh();
    res.json({ version: diff.version });
  });

  /**
   * What is not committed yet: HEAD -> working tree (+ untracked). Independent
   * of the review target, so a fix shows here whatever is being reviewed, and
   * so do pre-existing local edits. Also says whether the working tree is on
   * the branch under review — if not, a fix would land somewhere else.
   */
  app.get('/api/worktree', async (_req, res) => {
    const empty: WorktreeState = { branch: null, reviewedBranch: null, onReviewedBranch: true, pr: null, files: [], touched: [], version: diff.version };
    if (opts.stdinDiff) return res.json(empty);
    try {
      const head = await hasHead(repoRoot);
      const wt = await computeDiff(repoRoot, worktreeTarget(head), context);
      const branch = await currentBranchName(repoRoot);
      const reviewedBranch = target.reviewedBranch ?? null;
      const onReviewedBranch = !reviewedBranch || target.newRev === null || reviewedBranch === branch;
      const touched = await touchedSince(repoRoot, wt.files.map((f) => f.path), startedAt);
      const state: WorktreeState = { branch, reviewedBranch, onReviewedBranch, pr: target.pr ?? null, files: wt.files, touched, version: diff.version };
      res.json(state);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  /** Commit (and optionally push) the working tree, from an explicit click in the UI. */
  app.post('/api/commit', async (req, res) => {
    const { message, paths, push } = req.body ?? {};
    if (typeof message !== 'string' || !message.trim()) return res.status(400).json({ error: 'a commit message is required' });
    try {
      const result = await commitChanges(repoRoot, {
        message,
        paths: Array.isArray(paths) ? paths.filter((p): p is string => typeof p === 'string') : undefined,
        push: push === true,
      });
      await refresh();
      res.json(result);
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  /** Put the working tree on the branch under review so fixes land there, then re-resolve the diff. */
  app.post('/api/checkout', async (_req, res) => {
    try {
      const branch = await checkoutReviewed(repoRoot, target);
      if (!opts.stdinDiff) {
        target = await resolveTarget(repoRoot, opts.positional, { staged: opts.staged, exact: opts.exact });
      }
      await refresh();
      res.json({ branch, mode: diff.mode });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  /** Sync from the remote (fetch, plus a PR head re-fetch) then recompute. */
  app.post('/api/reload', async (_req, res) => {
    if (opts.stdinDiff) return res.json({ version: diff.version, fetched: false });
    const errors: string[] = [];
    for (const cmd of [['fetch', '--all', '--prune', '--quiet'], ...(target.refetch ?? [])]) {
      try {
        await git(repoRoot, cmd);
      } catch (err) {
        errors.push((err as Error).message);
      }
    }
    await refresh();
    res.json({ version: diff.version, fetched: errors.length === 0, errors });
  });

  app.use(express.static(CLIENT_DIR, { index: 'index.html' }));
  app.get('*', (_req, res) => res.sendFile(path.join(CLIENT_DIR, 'index.html')));

  // probing for a free port then binding it is racy when two repos start at
  // once, so treat EADDRINUSE as "try the next one"
  const server = http.createServer(app);
  const port = await listenFrom(server, host, opts.port ?? 4711);

  const stopWatching = opts.stdinDiff || opts.watch === false
    ? () => {}
    : startWatcher(repoRoot, () => void refresh());

  const info: ServerInfo = {
    port,
    url: `http://${host}:${port}`,
    pid: process.pid,
    repoRoot,
    cwd: opts.cwd,
    mode: diff.mode,
    startedAt: new Date().toISOString(),
    ...(session ? { session } : {}),
  };
  const infoPath = path.join(marjDir, 'server.json');
  await fs.writeFile(infoPath, JSON.stringify(info, null, 2));

  const close = async () => {
    stopWatching();
    store.close();
    await store.save();
    for (const res of clients) res.end();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await fs.rm(infoPath, { force: true });
  };

  return { info, close };
}

/**
 * Lines around a thread, straight from the diff, for the agent to read. A
 * file-level thread gets the file's whole diff with nothing marked.
 */
export function threadContext(
  diff: DiffPayload,
  file: string,
  side: 'old' | 'new',
  startLine: number,
  endLine: number,
  pad = 6,
  full: NumberedLine[] | null = null,
): { file: string; lines: { no: number; text: string; type: string; commented: boolean }[] } {
  const diffFile: DiffFile | undefined = diff.files.find((f) => f.path === file || f.oldPath === file);
  if (!diffFile) return { file, lines: [] };
  const numbered = full ?? sideLines(diffFile, side);
  const typeOf = new Map<number, string>();
  for (const hunk of diffFile.hunks) {
    for (const line of hunk.lines) {
      const no = side === 'old' ? line.oldNo : line.newNo;
      if (no !== null) typeOf.set(no, line.type);
    }
  }
  const wholeFile = startLine === FILE_LEVEL;
  const lines = numbered
    .filter((l) => wholeFile || (l.no >= startLine - pad && l.no <= endLine + pad))
    .map((l) => ({
      no: l.no,
      text: l.text,
      type: typeOf.get(l.no) ?? 'context',
      commented: !wholeFile && l.no >= startLine && l.no <= endLine,
    }));
  return { file: diffFile.path, lines };
}

async function ensureGitExclude(repoRoot: string): Promise<void> {
  const excludePath = path.join(repoRoot, '.git', 'info', 'exclude');
  try {
    const current = await fs.readFile(excludePath, 'utf8');
    if (current.split('\n').some((l) => l.trim() === '.marj/')) return;
    await fs.appendFile(excludePath, `${current.endsWith('\n') ? '' : '\n'}.marj/\n`);
  } catch {
    // worktrees, bare repos, permissions — not worth failing over
  }
}

async function listenFrom(server: http.Server, host: string, preferred: number): Promise<number> {
  for (let port = preferred; port < preferred + 50; port++) {
    const bound = await new Promise<boolean>((resolve, reject) => {
      const onError = (err: NodeJS.ErrnoException) => {
        server.removeListener('listening', onListening);
        if (err.code === 'EADDRINUSE' || err.code === 'EACCES') resolve(false);
        else reject(err);
      };
      const onListening = () => {
        server.removeListener('error', onError);
        resolve(true);
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(port, host);
    });
    if (bound) return port;
  }
  throw new Error(`no free port between ${preferred} and ${preferred + 49}`);
}

export { GitError };
