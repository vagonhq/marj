import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { ServerInfo, ServerListing } from '../shared/types.js';
import { MARJ_HOME } from './index.js';
import { git } from './git.js';

async function readJson<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8')) as T;
  } catch {
    return null;
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Ask a server what it is showing; null when it does not answer quickly. */
async function probe(url: string): Promise<{ mode: string; repoRoot: string } | null> {
  try {
    const res = await fetch(`${url}/api/diff`, { signal: AbortSignal.timeout(700) });
    if (!res.ok) return null;
    const payload = (await res.json()) as { mode?: string; repoRoot?: string };
    return { mode: payload.mode ?? '', repoRoot: payload.repoRoot ?? '' };
  } catch {
    return null;
  }
}

async function branchOf(repoRoot: string): Promise<string | null> {
  try {
    const name = (await git(repoRoot, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
    return name === 'HEAD' ? null : name;
  } catch {
    return null; // repo moved or deleted
  }
}

/**
 * Every repo marj knows about — from the state folders under ~/.marj/repos —
 * with its running server (default and sessions) when there is one. Two
 * repos side by side, or a repo and its worktrees, each get their own entry,
 * so the browser can jump between them.
 */
export async function discoverServers(current: { repoRoot: string; session: string | null }): Promise<ServerListing[]> {
  const reposDir = path.join(MARJ_HOME, 'repos');
  let folders: string[] = [];
  try {
    folders = await fs.readdir(reposDir);
  } catch {
    return [];
  }

  const out: ServerListing[] = [];
  const seen = new Set<string>();

  const add = async (info: ServerInfo | null, fallbackRoot: string | null, session: string | null) => {
    const repoRoot = info?.repoRoot ?? fallbackRoot;
    if (!repoRoot) return;
    const key = `${repoRoot}::${session ?? ''}`;
    if (seen.has(key)) return;
    seen.add(key);

    let live = false;
    let mode = info?.mode ?? '';
    if (info && pidAlive(info.pid)) {
      const answer = await probe(info.url);
      if (answer && (!answer.repoRoot || answer.repoRoot === repoRoot)) {
        live = true;
        mode = answer.mode || mode;
      }
    }
    out.push({
      name: path.basename(repoRoot),
      repoRoot,
      session,
      mode: live ? mode : '',
      url: live && info ? info.url : null,
      live,
      current: repoRoot === current.repoRoot && (session ?? null) === (current.session ?? null),
      branch: await branchOf(repoRoot),
    });
  };

  for (const folder of folders) {
    const base = path.join(reposDir, folder);
    const info = await readJson<ServerInfo>(path.join(base, 'server.json'));
    // repo.json is written on every start and never removed, so a stopped repo still has a path
    const meta = await readJson<{ repoRoot?: string }>(path.join(base, 'repo.json'));
    const root = info?.repoRoot ?? meta?.repoRoot ?? null;
    const hasThreads = await fs
      .access(path.join(base, 'threads.json'))
      .then(() => true)
      .catch(() => false);
    // a repo with saved threads but no server is still worth listing (greyed out)
    if (root && (info || hasThreads)) await add(info, root, null);

    let sessions: string[] = [];
    try {
      sessions = await fs.readdir(path.join(base, 'sessions'));
    } catch {
      /* none */
    }
    for (const name of sessions) {
      const sInfo = await readJson<ServerInfo>(path.join(base, 'sessions', name, 'server.json'));
      if (sInfo) await add(sInfo, sInfo.repoRoot, sInfo.session ?? name);
    }
  }

  // the one you're on first, then running servers, then the rest, alphabetical
  return out.sort(
    (a, b) =>
      Number(b.current) - Number(a.current) ||
      Number(b.live) - Number(a.live) ||
      a.name.localeCompare(b.name) ||
      (a.session ?? '').localeCompare(b.session ?? ''),
  );
}
