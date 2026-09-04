import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { RepoContext } from './context.js';
import { git } from './git.js';
import { MARJ_HOME } from './state.js';
import type { ServerListing } from '../shared/types.js';

async function readJson<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8')) as T;
  } catch {
    return null;
  }
}

const exists = (file: string) =>
  fs
    .access(file)
    .then(() => true)
    .catch(() => false);

async function branchOf(repoRoot: string): Promise<string | null> {
  try {
    const name = (await git(repoRoot, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
    return name === 'HEAD' ? null : name;
  } catch {
    return null; // repo moved or deleted
  }
}

/**
 * Every repo marj knows about, for the switcher in the header: the reviews the
 * hub is serving right now (live), plus repos with saved reviews under
 * ~/.marj/repos that nobody has started this time (greyed out). Two repos side
 * by side, or a repo and its worktrees, each get their own entry.
 */
export async function discoverServers(input: {
  live: Map<string, RepoContext>;
  hubUrl: string;
  currentId: string | null;
}): Promise<ServerListing[]> {
  const out: ServerListing[] = [];
  const seen = new Set<string>();

  for (const ctx of input.live.values()) {
    seen.add(`${ctx.repoRoot}::${ctx.session ?? ''}`);
    out.push({
      id: ctx.id,
      name: path.basename(ctx.repoRoot),
      repoRoot: ctx.repoRoot,
      session: ctx.session,
      mode: ctx.mode(),
      url: `${input.hubUrl}/r/${ctx.id}/`,
      live: true,
      current: ctx.id === input.currentId,
      branch: await branchOf(ctx.repoRoot),
    });
  }

  let folders: string[] = [];
  try {
    folders = await fs.readdir(path.join(MARJ_HOME, 'repos'));
  } catch {
    /* no state yet */
  }
  for (const folder of folders) {
    const base = path.join(MARJ_HOME, 'repos', folder);
    const meta = await readJson<{ repoRoot?: string }>(path.join(base, 'repo.json'));
    const repoRoot = meta?.repoRoot;
    if (!repoRoot) continue;

    const dead = async (session: string | null) => {
      const key = `${repoRoot}::${session ?? ''}`;
      if (seen.has(key)) return;
      seen.add(key);
      out.push({
        id: null,
        name: path.basename(repoRoot),
        repoRoot,
        session,
        mode: '',
        url: null,
        live: false,
        current: false,
        branch: await branchOf(repoRoot),
      });
    };

    if (await exists(path.join(base, 'threads.json'))) await dead(null);
    let sessions: string[] = [];
    try {
      sessions = await fs.readdir(path.join(base, 'sessions'));
    } catch {
      /* none */
    }
    for (const name of sessions) {
      if (await exists(path.join(base, 'sessions', name, 'threads.json'))) await dead(name);
    }
  }

  // plain alphabetical, so a repo is always where you expect it; the current one
  // is marked, not moved, and a repo's sessions follow it
  return out.sort((a, b) => a.name.localeCompare(b.name) || (a.session ?? '').localeCompare(b.session ?? ''));
}
