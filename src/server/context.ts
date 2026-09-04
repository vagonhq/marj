import { promises as fs } from 'node:fs';
import path from 'node:path';
import express, { type Request, type Response } from 'express';
import { buildAnchor, numbered, reanchorAll, sideLines, type NumberedLine } from './anchor.js';
import {
  checkoutReviewed,
  commitChanges,
  computeDiff,
  currentBranchName,
  diffFromRaw,
  git,
  hasHead,
  readSideFile,
  resolveTarget,
  touchedSince,
  worktreeTarget,
  type DiffTarget,
} from './git.js';
import { ThreadStore } from './threads.js';
import { startWatcher } from './watch.js';
import {
  FILE_LEVEL,
  type DiffFile,
  type DiffPayload,
  type ServerEvent,
  type ServerListing,
  type WorktreeState,
} from '../shared/types.js';

export interface ContextOptions {
  /** stable id the hub mounts this context under: /r/<id> */
  id: string;
  repoRoot: string;
  cwd: string;
  session: string | null;
  /** where threads.json lives for this repo/session */
  stateDir: string;
  positional: string[];
  staged?: boolean;
  exact?: boolean;
  contextLines: number;
  stdinDiff?: string;
  watch: boolean;
  /** the hub asks this for the repo switcher; the context adds which entry is itself */
  listServers: (currentId: string) => Promise<ServerListing[]>;
}

/**
 * One repo (or one isolated session of it) under review: its diff target,
 * threads, file watcher, SSE clients and the whole /api surface. The hub keeps
 * one of these per registered repo and mounts each under /r/<id>.
 */
export interface RepoContext {
  id: string;
  repoRoot: string;
  cwd: string;
  session: string | null;
  startedAt: string;
  router: express.Router;
  mode(): string;
  close(): Promise<void>;
}

export async function createRepoContext(opts: ContextOptions): Promise<RepoContext> {
  const { id, repoRoot, session, contextLines } = opts;
  await fs.mkdir(opts.stateDir, { recursive: true });
  const store = await ThreadStore.load(path.join(opts.stateDir, 'threads.json'));
  /** files modified after this are the fixes of this review, not pre-existing local edits */
  const startedAt = new Date();

  let target: DiffTarget = { args: [], mode: 'stdin', includeUntracked: false };
  if (!opts.stdinDiff) {
    target = await resolveTarget(repoRoot, opts.positional, { staged: opts.staged, exact: opts.exact });
  }

  let diff: DiffPayload = opts.stdinDiff
    ? await diffFromRaw(opts.stdinDiff, repoRoot)
    : await computeDiff(repoRoot, target, contextLines);

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
    const p = side === 'old' ? file.oldPath ?? file.path : file.path;
    const lines = await fileLines(side, p);
    return lines ? numbered(lines) : null;
  };
  await reanchorAll(store, diff, linesFor);

  const clients = new Set<Response>();
  const broadcast = (event: ServerEvent) => {
    const payload = `data: ${JSON.stringify(event)}\n\n`;
    for (const res of clients) res.write(payload);
  };

  const refresh = async () => {
    if (opts.stdinDiff) return;
    try {
      diff = await computeDiff(repoRoot, target, contextLines);
      fileCache = new Map();
      await reanchorAll(store, diff, linesFor);
      broadcast({ type: 'diff:changed', version: diff.version });
    } catch (err) {
      console.error(`[marj] ${id}: diff refresh failed:`, (err as Error).message);
    }
  };

  store.onChange(() => broadcast({ type: 'threads:changed', cursor: store.cursor }));

  const router = express.Router();
  router.use(express.json({ limit: '4mb' }));

  router.get('/api/diff', (_req, res) => res.json(diff));

  router.get('/api/threads', (_req, res) => res.json({ cursor: store.cursor, threads: store.list() }));

  router.get('/api/threads/:id', async (req, res) => {
    const thread = store.get(req.params.id);
    if (!thread) return res.status(404).json({ error: 'no such thread' });
    const diffFile = diff.files.find((f) => f.path === thread.file || f.oldPath === thread.file);
    const full = diffFile ? await linesFor(diffFile, thread.side) : null;
    res.json({ thread, context: threadContext(diff, thread.file, thread.side, thread.startLine, thread.endLine, 6, full) });
  });

  /** One side of a file in full, so the browser can expand the lines around a hunk. */
  router.get('/api/file', async (req, res) => {
    const file = String(req.query.path ?? '');
    const side = req.query.side === 'old' ? 'old' : 'new';
    const known = diff.files.some((f) => f.path === file || f.oldPath === file);
    if (!file || !known) return res.status(404).json({ error: 'file is not part of this diff' });
    const lines = await fileLines(side, file);
    if (!lines) return res.status(404).json({ error: 'no content for this side' });
    res.json({ path: file, side, lines });
  });

  router.post('/api/threads', async (req, res) => {
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

  router.post('/api/threads/:id/messages', (req, res) => {
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

  router.patch('/api/threads/:id', (req, res) => {
    const { status, agentTyping } = req.body ?? {};
    try {
      res.json(store.patch(req.params.id, { status, agentTyping }));
    } catch (err) {
      res.status(404).json({ error: (err as Error).message });
    }
  });

  router.delete('/api/threads/:id', (req, res) => {
    if (!store.remove(req.params.id)) return res.status(404).json({ error: 'no such thread' });
    res.status(204).end();
  });

  router.get('/api/agent/queue', (_req, res) => {
    res.json({ cursor: store.cursor, events: store.queue() });
  });

  router.get('/api/agent/wait', async (req, res) => {
    const cursor = Number(req.query.cursor ?? 0) || 0;
    const timeout = Math.min(Math.max(Number(req.query.timeout ?? 60), 1), 300) * 1000;
    res.json(await store.wait(cursor, timeout));
  });

  router.get('/api/events', (req: Request, res: Response) => {
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

  router.post('/api/refresh', async (_req, res) => {
    await refresh();
    res.json({ version: diff.version });
  });

  /**
   * What is not committed yet: HEAD -> working tree (+ untracked). Independent
   * of the review target, so a fix shows here whatever is being reviewed, and
   * so do pre-existing local edits. Also says whether the working tree is on
   * the branch under review — if not, a fix would land somewhere else.
   */
  router.get('/api/worktree', async (_req, res) => {
    const empty: WorktreeState = { branch: null, reviewedBranch: null, onReviewedBranch: true, pr: null, files: [], touched: [], version: diff.version };
    if (opts.stdinDiff) return res.json(empty);
    try {
      const head = await hasHead(repoRoot);
      const wt = await computeDiff(repoRoot, worktreeTarget(head), contextLines);
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
  router.post('/api/commit', async (req, res) => {
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
  router.post('/api/checkout', async (_req, res) => {
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

  /** Every repo/worktree marj knows, with this one marked, for the switcher in the header. */
  router.get('/api/servers', async (_req, res) => {
    res.json(await opts.listServers(id));
  });

  /** Sync from the remote (fetch, plus a PR head re-fetch) then recompute. */
  router.post('/api/reload', async (_req, res) => {
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

  const stopWatching = opts.stdinDiff || !opts.watch ? () => {} : startWatcher(repoRoot, () => void refresh());

  return {
    id,
    repoRoot,
    cwd: opts.cwd,
    session,
    startedAt: startedAt.toISOString(),
    router,
    mode: () => diff.mode,
    close: async () => {
      stopWatching();
      store.close();
      await store.save();
      for (const res of clients) res.end();
    },
  };
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
  const lines = full ?? sideLines(diffFile, side);
  const typeOf = new Map<number, string>();
  for (const hunk of diffFile.hunks) {
    for (const line of hunk.lines) {
      const no = side === 'old' ? line.oldNo : line.newNo;
      if (no !== null) typeOf.set(no, line.type);
    }
  }
  const wholeFile = startLine === FILE_LEVEL;
  return {
    file: diffFile.path,
    lines: lines
      .filter((l) => wholeFile || (l.no >= startLine - pad && l.no <= endLine + pad))
      .map((l) => ({
        no: l.no,
        text: l.text,
        type: typeOf.get(l.no) ?? 'context',
        commented: !wholeFile && l.no >= startLine && l.no <= endLine,
      })),
  };
}
