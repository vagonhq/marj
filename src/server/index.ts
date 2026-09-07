import { promises as fs } from 'node:fs';
import path from 'node:path';
import { GitError, repoRootOf } from './git.js';
import { contextId, findLiveHub, replayRegistrations, spawnHub, type HubInfo, type HubStatus, type RegisterRequest, type RegisterResponse } from './hub.js';
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
  /** end the review when this process exits — the Claude session that asked for it */
  ownerPid?: number;
}

export interface RunningServer {
  info: RegisterResponse;
  /** true when this call had to start the hub daemon */
  hubSpawned: boolean;
  /** set when an older hub kept running because it could not tell us what it serves; how to upgrade */
  hubOutdated?: { hubVersion: string; cliVersion: string };
  /** set when an older hub was replaced and its reviews re-registered on the new one */
  hubUpgraded?: { from: string; to: string; carried: number };
  /** set when a hub of this version was replaced because it could no longer run git */
  hubHealed?: { reason: string; carried: number };
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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const pidAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** The registrations an (up-to-date enough) hub holds, or null when it cannot say. */
async function hubRegistrations(hub: HubInfo): Promise<(RegisterRequest & { id: string })[] | null> {
  try {
    const res = await fetch(`${hub.url}/api/repos`, { signal: AbortSignal.timeout(1500) });
    if (!res.ok) return null;
    return (await res.json()) as (RegisterRequest & { id: string })[];
  } catch {
    return null;
  }
}

/** What the live hub says about itself; null when it does not answer. */
async function hubStatus(hub: HubInfo): Promise<Partial<HubStatus> & { version: string; repos: string[] } | null> {
  try {
    const res = await fetch(`${hub.url}/api/hub`, { signal: AbortSignal.timeout(6000) });
    if (!res.ok) return null;
    const body = (await res.json()) as Partial<HubStatus>;
    return { ...body, version: body.version ?? '0.0.0', repos: body.repos ?? [] };
  } catch {
    return null;
  }
}

/**
 * The running hub, starting it as a detached daemon when there is none.
 *
 * The hub outlives CLI runs, so after an upgrade a newer `marj` can meet an
 * older hub — or a hub of the same version that can no longer run git. Either
 * way it is replaced and every review it served is put back on the new one;
 * only a hub too old to list its reviews is left alone, with `outdated` to
 * warn with.
 */
export async function ensureHub(
  opts: { port?: number; host?: string; onlyRepoId?: string } = {},
): Promise<{
  hub: HubInfo;
  spawned: boolean;
  outdated?: { hubVersion: string; cliVersion: string };
  upgraded?: { from: string; to: string; carried: number };
  /** the hub was replaced because it could not run git any more */
  healed?: { reason: string; carried: number };
}> {
  const live = await findLiveHub();
  let carry: (RegisterRequest & { id: string })[] = [];
  let upgradedFrom: string | null = null;
  let healReason: string | null = null;
  if (live) {
    const status = await hubStatus(live);
    const hubVersion = status?.version ?? live.version ?? '0.0.0';
    const sick = status?.healthy === false;
    if (hubVersion === VERSION && !sick) return { hub: live, spawned: false };

    // an old or sick hub: take its registrations along if it can list them, then replace it
    const listed = await hubRegistrations(live);
    const others = (status?.repos ?? []).filter((id) => id !== opts.onlyRepoId && !id.startsWith(`${opts.onlyRepoId}~`));
    if (others.length > 0 && listed === null) {
      // too old to tell us what it serves; killing it would drop other repos' reviews
      return { hub: live, spawned: false, outdated: { hubVersion, cliVersion: VERSION } };
    }
    carry = (listed ?? []).filter((reg) => reg.id !== opts.onlyRepoId);
    if (hubVersion !== VERSION) upgradedFrom = hubVersion;
    else healReason = status?.health ?? 'unhealthy';
    // keep the same address so open tabs and server.json entries still point somewhere real
    opts = { ...opts, port: opts.port ?? live.port, host: opts.host ?? live.host };
    try {
      process.kill(live.pid, 'SIGTERM');
    } catch {
      /* already gone */
    }
    // wait for the process itself, not just for it to stop answering: the port must be free
    for (let i = 0; i < 80 && pidAlive(live.pid); i++) await sleep(100);
  }

  const hub = await spawnHub({ port: opts.port, host: opts.host }, live?.pid);

  // put the old hub's reviews back so nobody's tab goes dark because of an upgrade
  const carried = await replayRegistrations(hub, carry.map(({ id: _id, ...reg }) => reg));
  if (upgradedFrom) return { hub, spawned: true, upgraded: { from: upgradedFrom, to: VERSION, carried } };
  if (healReason) return { hub, spawned: true, healed: { reason: healReason, carried } };
  return { hub, spawned: true };
}

/**
 * Review this repo: make sure the hub is running, register the repo with it,
 * and hand back where the browser should go. Returns at once; the hub daemon
 * does the serving.
 */
export async function startServer(opts: StartOptions): Promise<RunningServer> {
  const repoRoot = await repoRootOf(opts.cwd); // throws GitError outside a repo
  const { hub, spawned, outdated, upgraded, healed } = await ensureHub({
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
    ownerPid: opts.ownerPid,
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
    ...(upgraded ? { hubUpgraded: upgraded } : {}),
    ...(healed ? { hubHealed: healed } : {}),
    close: async () => {
      await fetch(`${hub.url}/api/repos/${encodeURIComponent(info.id)}`, { method: 'DELETE' }).catch(() => {});
    },
  };
}
