import { execFile, spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { createRepoContext, type RepoContext } from './context.js';
import { GitError, repoRootOf } from './git.js';
import { discoverServers } from './registry.js';
import { MARJ_HOME, migrateLegacyState, normaliseSession, repoStateBase, stateDir } from './state.js';
import { VERSION } from './version.js';
import type { ServerInfo } from '../shared/types.js';

const CLIENT_DIR = fileURLToPath(new URL('../../client', import.meta.url));
const CLI_ENTRY = fileURLToPath(new URL('../cli/index.js', import.meta.url));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const pidAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

export const HUB_FILE = path.join(MARJ_HOME, 'hub.json');

export interface HubInfo {
  url: string;
  host: string;
  port: number;
  pid: number;
  startedAt: string;
  /** marj version the hub process runs */
  version: string;
}

export interface HubOptions {
  port?: number;
  host?: string;
  /** exit the process when the last repo is unregistered (the daemon does; tests don't) */
  exitWhenEmpty?: boolean;
  /**
   * When this process can no longer run git (EBADF/EMFILE: descriptors exhausted),
   * hand every review to a fresh hub on the same port and exit. The daemon does;
   * tests don't.
   */
  selfHeal?: boolean;
  /** how often to check that owners (see RegisterRequest.ownerPid) are still alive */
  ownerCheckMs?: number;
}

/** What /api/hub answers: who is serving, what, and whether it still can. */
export interface HubStatus {
  pid: number;
  url: string;
  version: string;
  repos: string[];
  /** false when the hub process cannot run git any more — its diffs are stale */
  healthy: boolean;
  /** why it is unhealthy */
  health: string | null;
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
  /**
   * The process this review lives and dies with — the Claude Code session that
   * started it. When it is gone the hub ends the review (and exits once nothing
   * is left), so no review outlives the conversation it belonged to.
   */
  ownerPid?: number;
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

/**
 * Errors that mean this *process* is broken, not the command: it has run out of
 * file descriptors (or hit macOS's posix_spawn limit on them), so no child can be
 * started until it is replaced.
 */
export function isSpawnFailure(err: unknown): boolean {
  const e = err as { code?: string; message?: string };
  if (e.code && ['EBADF', 'EMFILE', 'ENFILE', 'EAGAIN'].includes(e.code)) return true;
  return /spawn (EBADF|EMFILE|ENFILE|EAGAIN)/.test(e.message ?? '');
}

/** Can this process still run git? The one thing every diff depends on. */
export function checkGit(): Promise<{ ok: true } | { ok: false; error: string }> {
  return new Promise((resolve) => {
    execFile('git', ['--version'], { timeout: 5000 }, (err) => {
      if (!err) return resolve({ ok: true });
      const e = err as { code?: string; message: string };
      resolve({ ok: false, error: e.code === 'ENOENT' ? 'git is not on PATH' : e.message.split('\n')[0] });
    });
  });
}

/**
 * Start a hub daemon (detached, logging to ~/.marj/hub.log) and wait for it to
 * publish itself in hub.json. `notPid` is the hub being replaced, so a stale
 * hub.json is not mistaken for the new one.
 */
export async function spawnHub(opts: { port?: number; host?: string }, notPid?: number): Promise<HubInfo> {
  await fs.mkdir(MARJ_HOME, { recursive: true });
  const logPath = path.join(MARJ_HOME, 'hub.log');
  const log = await fs.open(logPath, 'a');
  const args = [CLI_ENTRY, 'hub'];
  if (opts.port) args.push('--port', String(opts.port));
  if (opts.host) args.push('--host', opts.host);
  const child = spawn(process.execPath, args, { detached: true, stdio: ['ignore', log.fd, log.fd], env: process.env });
  child.unref();
  await log.close();

  for (let i = 0; i < 80; i++) {
    await sleep(100);
    const hub = await findLiveHub();
    if (hub && hub.pid !== notPid) return hub;
  }
  throw new Error(`the marj hub did not come up within 8s — see ${logPath}`);
}

/** Register `regs` on `hub` again; returns how many it accepted. */
export async function replayRegistrations(hub: HubInfo, regs: RegisterRequest[]): Promise<number> {
  let carried = 0;
  for (const reg of regs) {
    try {
      const res = await fetch(`${hub.url}/api/repos`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(reg),
      });
      if (res.ok) carried++;
    } catch {
      /* that repo may be gone; the switcher will show it greyed out */
    }
  }
  return carried;
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
  /** how each review was asked for, so a newer marj can restart this hub and put them all back */
  const registrations = new Map<string, RegisterRequest>();
  /** review id -> the process it belongs to; the review ends when that process does */
  const owners = new Map<string, number>();
  let info!: HubInfo;

  const listServers = (currentId: string | null) =>
    discoverServers({ live: contexts, hubUrl: info.url, currentId });

  const app = express();

  /**
   * Replace this process with a fresh hub on the same port, every review re-registered.
   * The browsers' event streams drop for a second and reconnect to the new one.
   */
  let handingOver: Promise<void> | null = null;
  const handOver = (reason: string) =>
    (handingOver ??= (async () => {
      console.error(`[marj] hub ${process.pid} is restarting itself: ${reason}`);
      const regs = [...registrations.entries()].map(([id, reg]) => ({ id, ...reg }));
      await close(); // frees the port and removes hub.json
      try {
        const next = await spawnHub({ port, host }, process.pid);
        const carried = await replayRegistrations(next, regs);
        console.error(`[marj] handed ${carried}/${regs.length} review${regs.length === 1 ? '' : 's'} to hub ${next.pid}`);
      } catch (err) {
        console.error(`[marj] could not start a replacement hub: ${(err as Error).message}`);
      }
      process.exit(0);
    })());

  /** a review's refresh died because this process cannot spawn any more: hand over */
  const onRefreshError = (err: unknown) => {
    if (opts.selfHeal && isSpawnFailure(err)) void handOver(`cannot run git (${(err as Error).message})`);
  };

  app.get('/api/hub', async (_req, res) => {
    const git = await checkGit();
    const status: HubStatus = {
      pid: process.pid,
      url: info.url,
      version: VERSION,
      repos: [...contexts.keys()],
      healthy: git.ok,
      health: git.ok ? null : git.error,
    };
    res.json(status);
    if (!git.ok && opts.selfHeal && isSpawnFailure({ message: git.error })) void handOver(`cannot run git (${git.error})`);
  });

  /** ask the hub to replace itself (a newer CLI does when the hub is sick) */
  app.post('/api/hub/restart', (_req, res) => {
    if (!opts.selfHeal) return res.status(409).json({ error: 'this hub does not restart itself' });
    res.status(202).json({ restarting: true });
    setTimeout(() => void handOver('asked to'), 100);
  });

  app.get('/api/servers', async (_req, res) => res.json(await listServers(null)));

  /** Every registration as it was made — what an upgrading CLI replays into the new hub. */
  app.get('/api/repos', (_req, res) => {
    res.json([...registrations.entries()].map(([id, reg]) => ({ id, ...reg })));
  });

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
      // a review opened from the browser (the PR picker) belongs to whoever owns the review it was opened from
      let ownerPid = body.ownerPid;
      if (ownerPid === undefined) {
        for (const other of contexts.values()) {
          if (other.repoRoot === repoRoot && owners.has(other.id)) {
            ownerPid = owners.get(other.id);
            break;
          }
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
        onRefreshError,
      });
      contexts.set(id, ctx);
      registrations.set(id, { ...body, session: session ?? undefined, force: false, ownerPid });
      if (ownerPid !== undefined) owners.set(id, ownerPid);
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
  info = { url: `http://${host}:${port}`, host, port, pid: process.pid, startedAt: new Date().toISOString(), version: VERSION };
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
      version: VERSION,
      ...(ctx.session ? { session: ctx.session } : {}),
      ...(ctx.notice() ? { notice: ctx.notice() } : {}),
      ...(owners.has(ctx.id) ? { ownerPid: owners.get(ctx.id) } : {}),
    };
  }

  async function unregister(ctx: RepoContext): Promise<void> {
    contexts.delete(ctx.id);
    registrations.delete(ctx.id);
    owners.delete(ctx.id);
    await ctx.close();
    await fs.rm(path.join(stateDir(ctx.repoRoot, ctx.session), 'server.json'), { force: true });
  }

  // a review whose owner — the Claude session that started it — has exited ends here
  let sweeping = false;
  const sweepOwners = async () => {
    if (sweeping || closing) return;
    sweeping = true;
    try {
      let ended = 0;
      for (const [id, pid] of [...owners]) {
        if (pidAlive(pid)) continue;
        const ctx = contexts.get(id);
        if (!ctx) continue;
        console.error(`[marj] ${id}: the session that started it (pid ${pid}) is gone; ending the review`);
        await unregister(ctx);
        ended++;
      }
      // the hub goes with the last review — but never before the first one has arrived
      if (ended > 0 && contexts.size === 0 && opts.exitWhenEmpty) {
        setTimeout(() => void close().then(() => process.exit(0)), 200);
      }
    } finally {
      sweeping = false;
    }
  };
  const ownerTimer = setInterval(() => void sweepOwners(), opts.ownerCheckMs ?? 3000);
  ownerTimer.unref();

  let closing: Promise<void> | null = null;
  const close = () =>
    (closing ??= (async () => {
      clearInterval(ownerTimer);
      for (const ctx of [...contexts.values()]) await unregister(ctx);
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        // keep-alive sockets (browsers, the CLI's fetch) would otherwise hold close() open for seconds
        server.closeAllConnections();
      });
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
