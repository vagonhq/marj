import { promises as fs } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { createRepoContext, type RepoContext } from './context.js';
import { GitError, repoRootOf } from './git.js';
import { discoverServers } from './registry.js';
import { MARJ_HOME, migrateLegacyState, normaliseSession, repoStateBase, stateDir } from './state.js';
import type { ServerInfo } from '../shared/types.js';

const CLIENT_DIR = fileURLToPath(new URL('../../client', import.meta.url));

export const HUB_FILE = path.join(MARJ_HOME, 'hub.json');

export interface HubInfo {
  url: string;
  host: string;
  port: number;
  pid: number;
  startedAt: string;
}

export interface HubOptions {
  port?: number;
  host?: string;
  /** exit the process when the last repo is unregistered (the daemon does; tests don't) */
  exitWhenEmpty?: boolean;
}

/** What `marj` in a repo sends the hub to get that repo reviewed. */
export interface RegisterRequest {
  cwd: string;
  positional: string[];
  staged?: boolean;
  exact?: boolean;
  session?: string;
  contextLines?: number;
  stdinDiff?: string;
  watch?: boolean;
  /** an existing entry for the same repo+session gets a fresh auto-named session instead of being reused */
  force?: boolean;
}

export interface RegisterResponse extends ServerInfo {
  id: string;
  reused: boolean;
}

/** /r/<id>: readable, unique per repo path, with the session appended. */
export function contextId(repoRoot: string, session: string | null): string {
  const base = path.basename(repoStateBase(repoRoot));
  return session ? `${base}~${session}` : base;
}

/** The running hub, or null. */
export async function findLiveHub(): Promise<HubInfo | null> {
  let info: HubInfo;
  try {
    info = JSON.parse(await fs.readFile(HUB_FILE, 'utf8')) as HubInfo;
  } catch {
    return null;
  }
  try {
    process.kill(info.pid, 0);
  } catch {
    return null;
  }
  try {
    const res = await fetch(`${info.url}/api/hub`, { signal: AbortSignal.timeout(1500) });
    if (!res.ok) return null;
    const body = (await res.json()) as { pid?: number };
    return body.pid === info.pid ? info : null;
  } catch {
    return null;
  }
}

/**
 * One process, one port, every repo. Each registered repo (or session of one)
 * is a RepoContext mounted under /r/<id>, so the browser switches between
 * repos and worktrees from the header instead of between ports.
 */
export async function startHub(opts: HubOptions = {}): Promise<{ info: HubInfo; close: () => Promise<void> }> {
  const host = opts.host ?? '127.0.0.1';
  const contexts = new Map<string, RepoContext>();
  let info!: HubInfo;

  const listServers = (currentId: string | null) =>
    discoverServers({ live: contexts, hubUrl: info.url, currentId });

  const app = express();

  app.get('/api/hub', (_req, res) => {
    res.json({ pid: process.pid, url: info.url, repos: [...contexts.keys()] });
  });

  app.get('/api/servers', async (_req, res) => res.json(await listServers(null)));

  app.post('/api/repos', express.json({ limit: '16mb' }), async (req, res) => {
    const body = (req.body ?? {}) as RegisterRequest;
    try {
      const repoRoot = await repoRootOf(body.cwd);
      let session = normaliseSession(body.session);
      let id = contextId(repoRoot, session);
      const existing = contexts.get(id);
      if (existing && !body.force) {
        return res.json(describe(existing, true));
      }
      if (existing && body.force) {
        // pick a free s2, s3, … so the second review of the same repo is isolated
        for (let n = 2; ; n++) {
          session = `s${n}`;
          id = contextId(repoRoot, session);
          if (!contexts.has(id)) break;
        }
      }
      await migrateLegacyState(repoRoot);
      await fs.mkdir(repoStateBase(repoRoot), { recursive: true });
      // remembered even after the review stops, so the switcher can still list this repo
      await fs.writeFile(path.join(repoStateBase(repoRoot), 'repo.json'), JSON.stringify({ repoRoot }, null, 2));

      const ctx = await createRepoContext({
        id,
        repoRoot,
        cwd: body.cwd,
        session,
        stateDir: stateDir(repoRoot, session),
        positional: body.positional ?? [],
        staged: body.staged,
        exact: body.exact,
        contextLines: body.contextLines ?? 5,
        stdinDiff: body.stdinDiff,
        watch: body.watch !== false,
        listServers: (current) => listServers(current),
      });
      contexts.set(id, ctx);
      const serverInfo = describe(ctx, false);
      await fs.writeFile(path.join(stateDir(repoRoot, session), 'server.json'), JSON.stringify(serverInfo, null, 2));
      res.status(201).json(serverInfo);
    } catch (err) {
      const status = err instanceof GitError ? 400 : 500;
      res.status(status).json({ error: (err as Error).message });
    }
  });

  app.delete('/api/repos/:id', async (req, res) => {
    const ctx = contexts.get(req.params.id);
    if (!ctx) return res.status(404).json({ error: 'no such repo' });
    await unregister(ctx);
    res.status(204).end();
    if (contexts.size === 0 && opts.exitWhenEmpty) {
      // nothing left to serve: let the response flush, then go
      setTimeout(() => void close().then(() => process.exit(0)), 200);
    }
  });

  // a repo's whole API and UI live under /r/<id>
  app.use('/r/:id', (req, res, next) => {
    const ctx = contexts.get(req.params.id);
    if (!ctx) {
      if (req.path.startsWith('/api/')) return res.status(404).json({ error: `no review registered as ${req.params.id}` });
      return res.redirect('/');
    }
    return ctx.router(req, res, next);
  });
  app.use(express.static(CLIENT_DIR, { index: false }));
  app.get('/r/:id', (_req, res) => res.sendFile(path.join(CLIENT_DIR, 'index.html')));
  app.get('/r/:id/*', (_req, res) => res.sendFile(path.join(CLIENT_DIR, 'index.html')));
  app.get('/', (_req, res) => {
    const first = contexts.keys().next().value as string | undefined;
    if (first) return res.redirect(`/r/${first}/`);
    res
      .status(200)
      .type('text/plain')
      .send('marj is running but no repo is registered yet. Run `marj` inside a repo.\n');
  });

  const server = http.createServer(app);
  const port = await listenFrom(server, host, opts.port ?? 4711);
  info = { url: `http://${host}:${port}`, host, port, pid: process.pid, startedAt: new Date().toISOString() };
  await fs.mkdir(MARJ_HOME, { recursive: true });
  await fs.writeFile(HUB_FILE, JSON.stringify(info, null, 2));

  function describe(ctx: RepoContext, reused: boolean): RegisterResponse {
    return {
      id: ctx.id,
      reused,
      port,
      url: `${info.url}/r/${ctx.id}`,
      pid: process.pid,
      repoRoot: ctx.repoRoot,
      cwd: ctx.cwd,
      mode: ctx.mode(),
      startedAt: ctx.startedAt,
      ...(ctx.session ? { session: ctx.session } : {}),
    };
  }

  async function unregister(ctx: RepoContext): Promise<void> {
    contexts.delete(ctx.id);
    await ctx.close();
    await fs.rm(path.join(stateDir(ctx.repoRoot, ctx.session), 'server.json'), { force: true });
  }

  let closing: Promise<void> | null = null;
  const close = () =>
    (closing ??= (async () => {
      for (const ctx of [...contexts.values()]) await unregister(ctx);
      await new Promise<void>((resolve) => server.close(() => resolve()));
      // only remove the file if it is still ours
      try {
        const current = JSON.parse(await fs.readFile(HUB_FILE, 'utf8')) as HubInfo;
        if (current.pid === process.pid) await fs.rm(HUB_FILE, { force: true });
      } catch {
        /* already gone */
      }
    })());

  return { info, close };
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
