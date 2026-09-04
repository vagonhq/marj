import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GitError, repoRootOf } from './git.js';
import { contextId, findLiveHub, type HubInfo, type RegisterRequest, type RegisterResponse } from './hub.js';
import { MARJ_HOME, normaliseSession, stateDir } from './state.js';
import { VERSION } from './version.js';
import type { ServerInfo } from '../shared/types.js';

export * from './state.js';
export { threadContext } from './context.js';
export { findLiveHub, HUB_FILE, contextId } from './hub.js';
export { GitError };

export interface StartOptions {
  cwd: string;
  positional: string[];
  staged?: boolean;
  /** compare two revisions tip to tip instead of from their merge base */
  exact?: boolean;
  /** hub options; only matter when this call starts the hub */
  port?: number;
  host?: string;
  context?: number;
  /** raw unified diff read from stdin instead of running git */
  stdinDiff?: string;
  watch?: boolean;
  /** an isolated review: its own threads, chat and entry in the hub */
  session?: string;
  /** a second review of the same repo gets a fresh auto-named session instead of reusing */
  force?: boolean;
}

export interface RunningServer {
  info: RegisterResponse;
  /** true when this call had to start the hub daemon */
  hubSpawned: boolean;
  /** set when an older hub kept running because other repos are on it; tells the user how to upgrade */
  hubOutdated?: { hubVersion: string; cliVersion: string };
  /** unregister this repo from the hub */
  close: () => Promise<void>;
}

/**
 * The review of this repo (and session) that the hub is serving, or null.
 * server.json under the repo's state folder points at the hub's /r/<id>.
 */
export async function findLiveServer(repoRoot: string, session: string | null = null): Promise<ServerInfo | null> {
  let info: ServerInfo;
  try {
    info = JSON.parse(await fs.readFile(path.join(stateDir(repoRoot, session), 'server.json'), 'utf8')) as ServerInfo;
  } catch {
    return null;
  }
  try {
    process.kill(info.pid, 0);
  } catch {
    return null; // the hub that wrote it is gone
  }
  try {
    const res = await fetch(`${info.url}/api/diff`, { signal: AbortSignal.timeout(1500) });
    if (!res.ok) return null;
    const payload = (await res.json()) as { repoRoot?: string };
    return payload.repoRoot === repoRoot ? info : null;
  } catch {
    return null;
  }
}

const CLI_ENTRY = fileURLToPath(new URL('../cli/index.js', import.meta.url));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** What the live hub says about itself; null when it does not answer. */
async function hubStatus(hub: HubInfo): Promise<{ version: string; repos: string[] } | null> {
  try {
    const res = await fetch(`${hub.url}/api/hub`, { signal: AbortSignal.timeout(1500) });
    if (!res.ok) return null;
    const body = (await res.json()) as { version?: string; repos?: string[] };
    return { version: body.version ?? '0.0.0', repos: body.repos ?? [] };
  } catch {
    return null;
  }
}

/**
 * The running hub, starting it as a detached daemon when there is none.
 *
 * The hub outlives CLI runs, so after an upgrade a newer `marj` can meet an
 * older hub. If nothing else is registered on it (or only this repo), it is
 * restarted so the upgrade takes effect; otherwise it is left alone and the
 * caller gets `outdated` to warn with.
 */
export async function ensureHub(
  opts: { port?: number; host?: string; onlyRepoId?: string } = {},
): Promise<{ hub: HubInfo; spawned: boolean; outdated?: { hubVersion: string; cliVersion: string } }> {
  const live = await findLiveHub();
  if (live) {
    const status = await hubStatus(live);
    const hubVersion = status?.version ?? live.version ?? '0.0.0';
    if (hubVersion === VERSION) return { hub: live, spawned: false };
    const others = (status?.repos ?? []).filter((id) => id !== opts.onlyRepoId && !id.startsWith(`${opts.onlyRepoId}~`));
    if (others.length > 0) {
      return { hub: live, spawned: false, outdated: { hubVersion, cliVersion: VERSION } };
    }
    // idle (or just us): swap the old process for this version
    try {
      process.kill(live.pid, 'SIGTERM');
    } catch {
      /* already gone */
    }
    for (let i = 0; i < 50 && (await findLiveHub()); i++) await sleep(100);
  }

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
    if (hub) return { hub, spawned: true };
  }
  throw new Error(`the marj hub did not come up within 8s — see ${logPath}`);
}

/**
 * Review this repo: make sure the hub is running, register the repo with it,
 * and hand back where the browser should go. Returns at once; the hub daemon
 * does the serving.
 */
export async function startServer(opts: StartOptions): Promise<RunningServer> {
  const repoRoot = await repoRootOf(opts.cwd); // throws GitError outside a repo
  const { hub, spawned, outdated } = await ensureHub({
    port: opts.port,
    host: opts.host,
    onlyRepoId: contextId(repoRoot, normaliseSession(opts.session)),
  });

  const body: RegisterRequest = {
    cwd: opts.cwd,
    positional: opts.positional,
    staged: opts.staged,
    exact: opts.exact,
    session: normaliseSession(opts.session) ?? undefined,
    contextLines: opts.context,
    stdinDiff: opts.stdinDiff,
    watch: opts.watch,
    force: opts.force,
  };
  const res = await fetch(`${hub.url}/api/repos`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const detail = (await res.json().catch(() => ({}))) as { error?: string };
    throw new GitError(detail.error ?? `the hub refused to register ${repoRoot} (${res.status})`);
  }
  const info = (await res.json()) as RegisterResponse;
  return {
    info,
    hubSpawned: spawned,
    ...(outdated ? { hubOutdated: outdated } : {}),
    close: async () => {
      await fetch(`${hub.url}/api/repos/${encodeURIComponent(info.id)}`, { method: 'DELETE' }).catch(() => {});
    },
  };
}
