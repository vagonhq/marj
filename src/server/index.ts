import { promises as fs } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { buildAnchor, reanchorAll, sideLines } from './anchor.js';
import { computeDiff, diffFromRaw, GitError, repoRootOf, resolveTarget, type DiffTarget } from './git.js';
import { ThreadStore } from './threads.js';
import { startWatcher } from './watch.js';
import type { DiffFile, DiffPayload, ServerEvent, ServerInfo } from '../shared/types.js';

const CLIENT_DIR = fileURLToPath(new URL('../../client', import.meta.url));

export interface StartOptions {
  cwd: string;
  positional: string[];
  staged?: boolean;
  port?: number;
  host?: string;
  context?: number;
  /** raw unified diff read from stdin instead of running git */
  stdinDiff?: string;
  watch?: boolean;
}

export interface RunningServer {
  info: ServerInfo;
  close: () => Promise<void>;
}

export const MARJ_DIR = '.marj';

export async function startServer(opts: StartOptions): Promise<RunningServer> {
  const context = opts.context ?? 5;
  const host = opts.host ?? '127.0.0.1';
  const repoRoot = await repoRootOf(opts.cwd);
  const marjDir = path.join(repoRoot, MARJ_DIR);
  await fs.mkdir(marjDir, { recursive: true });
  await ensureGitExclude(repoRoot);

  const store = await ThreadStore.load(path.join(marjDir, 'threads.json'));

  let target: DiffTarget = { args: [], mode: 'stdin', includeUntracked: false };
  if (!opts.stdinDiff) target = await resolveTarget(repoRoot, opts.positional, { staged: opts.staged });

  let diff: DiffPayload = opts.stdinDiff
    ? diffFromRaw(opts.stdinDiff, repoRoot)
    : await computeDiff(repoRoot, target, context);
  reanchorAll(store, diff);

  const clients = new Set<express.Response>();
  const broadcast = (event: ServerEvent) => {
    const payload = `data: ${JSON.stringify(event)}\n\n`;
    for (const res of clients) res.write(payload);
  };

  const refresh = async () => {
    if (opts.stdinDiff) return;
    try {
      diff = await computeDiff(repoRoot, target, context);
      reanchorAll(store, diff);
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

  app.get('/api/threads/:id', (req, res) => {
    const thread = store.get(req.params.id);
    if (!thread) return res.status(404).json({ error: 'no such thread' });
    res.json({ thread, context: threadContext(diff, thread.file, thread.side, thread.startLine, thread.endLine) });
  });

  app.post('/api/threads', (req, res) => {
    const { file, side, startLine, endLine, body, role, intent } = req.body ?? {};
    if (typeof file !== 'string' || typeof body !== 'string' || !body.trim()) {
      return res.status(400).json({ error: 'file and body are required' });
    }
    const start = Number(startLine);
    const end = Number(endLine ?? startLine);
    const diffFile = diff.files.find((f) => f.path === file || f.oldPath === file);
    const anchor = diffFile ? buildAnchor(diffFile, side === 'old' ? 'old' : 'new', start, end) : undefined;
    const thread = store.createThread({
      file,
      side: side === 'old' ? 'old' : 'new',
      startLine: start,
      endLine: Number.isFinite(end) ? end : start,
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

  app.use(express.static(CLIENT_DIR, { index: 'index.html' }));
  app.get('*', (_req, res) => res.sendFile(path.join(CLIENT_DIR, 'index.html')));

  const port = await pickPort(host, opts.port ?? 4711);
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(port, host, resolve));

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

/** Lines around a thread, straight from the diff, for the agent to read. */
export function threadContext(
  diff: DiffPayload,
  file: string,
  side: 'old' | 'new',
  startLine: number,
  endLine: number,
  pad = 6,
): { file: string; lines: { no: number; text: string; type: string; commented: boolean }[] } {
  const diffFile: DiffFile | undefined = diff.files.find((f) => f.path === file || f.oldPath === file);
  if (!diffFile) return { file, lines: [] };
  const numbered = sideLines(diffFile, side);
  const typeOf = new Map<number, string>();
  for (const hunk of diffFile.hunks) {
    for (const line of hunk.lines) {
      const no = side === 'old' ? line.oldNo : line.newNo;
      if (no !== null) typeOf.set(no, line.type);
    }
  }
  const lines = numbered
    .filter((l) => l.no >= startLine - pad && l.no <= endLine + pad)
    .map((l) => ({
      no: l.no,
      text: l.text,
      type: typeOf.get(l.no) ?? 'context',
      commented: l.no >= startLine && l.no <= endLine,
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

async function pickPort(host: string, preferred: number): Promise<number> {
  for (let port = preferred; port < preferred + 50; port++) {
    if (await isFree(host, port)) return port;
  }
  return 0;
}

function isFree(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const tester = net
      .createServer()
      .once('error', () => resolve(false))
      .once('listening', () => tester.close(() => resolve(true)))
      .listen(port, host);
  });
}

export { GitError };
