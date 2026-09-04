import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Where marj used to keep state, inside the repo. Only read to migrate it out. */
export const LEGACY_DIR = '.marj';

/** All marj state lives here, outside every repo: ~/.marj (override with MARJ_HOME). */
export const MARJ_HOME = process.env.MARJ_HOME || path.join(os.homedir(), '.marj');

/**
 * The state folder for one repo: ~/.marj/repos/<name>-<hash>. Keyed by the
 * absolute repo path, so two clones of the same project stay separate, and
 * readable enough to find by hand.
 */
export function repoStateBase(repoRoot: string): string {
  const hash = createHash('sha1').update(repoRoot).digest('hex').slice(0, 10);
  return path.join(MARJ_HOME, 'repos', `${path.basename(repoRoot)}-${hash}`);
}

/** valid session name, or null; keeps the name safe as a folder and stable across commands */
export function normaliseSession(name: string | undefined): string | null {
  if (!name) return null;
  const slug = name.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  return slug || null;
}

/** Where a session keeps its threads.json and server.json (the default lives in the repo's base folder). */
export function stateDir(repoRoot: string, session: string | null): string {
  const base = repoStateBase(repoRoot);
  return session ? path.join(base, 'sessions', session) : base;
}

/**
 * Older marj kept everything in <repo>/.marj. Move it out on first start so
 * existing conversations survive and the repo stops carrying the folder.
 */
export async function migrateLegacyState(repoRoot: string): Promise<void> {
  const legacy = path.join(repoRoot, LEGACY_DIR);
  const base = repoStateBase(repoRoot);
  try {
    await fs.access(path.join(legacy, 'threads.json'));
  } catch {
    // nothing to migrate; still drop an empty/stale legacy folder if there is one
    await fs.rm(legacy, { recursive: true, force: true }).catch(() => {});
    return;
  }
  try {
    await fs.access(path.join(base, 'threads.json'));
    return; // the new location already has state; leave the old folder alone rather than clobber
  } catch {
    /* fall through: migrate */
  }
  await fs.mkdir(base, { recursive: true });
  for (const entry of ['threads.json', 'sessions']) {
    await fs.rename(path.join(legacy, entry), path.join(base, entry)).catch(() => {});
  }
  await fs.rm(legacy, { recursive: true, force: true }).catch(() => {});
  console.error(`[marj] moved review state out of the repo: ${legacy} -> ${base}`);
}
