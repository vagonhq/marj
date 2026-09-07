import path from 'node:path';
import type { RepoContext } from './context.js';
import { git } from './git.js';
import type { ServerListing } from '../shared/types.js';

async function branchOf(repoRoot: string): Promise<string | null> {
  try {
    const name = (await git(repoRoot, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
    return name === 'HEAD' ? null : name;
  } catch {
    return null; // repo moved or deleted
  }
}

/**
 * Every review the hub is serving right now, for the switcher in the header.
 * Two repos side by side, or a repo and its worktrees, each get their own entry.
 */
export async function discoverServers(input: {
  live: Map<string, RepoContext>;
  hubUrl: string;
  currentId: string | null;
}): Promise<ServerListing[]> {
  const out: ServerListing[] = [];
  for (const ctx of input.live.values()) {
    out.push({
      id: ctx.id,
      name: path.basename(ctx.repoRoot),
      repoRoot: ctx.repoRoot,
      session: ctx.session,
      mode: ctx.mode(),
      url: `${input.hubUrl}/r/${ctx.id}/`,
      current: ctx.id === input.currentId,
      branch: await branchOf(ctx.repoRoot),
    });
  }

  // plain alphabetical, so a repo is always where you expect it; the current one
  // is marked, not moved, and a repo's sessions follow it
  return out.sort((a, b) => a.name.localeCompare(b.name) || (a.session ?? '').localeCompare(b.session ?? ''));
}
