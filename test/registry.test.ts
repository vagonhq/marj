import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RepoContext } from '../src/server/context.js';

// MARJ_HOME is read when the state module loads, so point it at a temp dir first
const home = await fs.mkdtemp(path.join(os.tmpdir(), 'marj-home-'));
process.env.MARJ_HOME = home;
const { discoverServers } = await import('../src/server/registry.js');

const fakeContext = (id: string, repoRoot: string, session: string | null, mode: string): RepoContext => ({
  id,
  repoRoot,
  cwd: repoRoot,
  session,
  startedAt: '',
  router: (() => {}) as unknown as RepoContext['router'],
  mode: () => mode,
  close: async () => {},
});

beforeAll(async () => {
  const repos = path.join(home, 'repos');
  // frontend is being served by the hub; its folder exists too
  await fs.mkdir(path.join(repos, 'frontend-aaaa'), { recursive: true });
  await fs.writeFile(path.join(repos, 'frontend-aaaa', 'repo.json'), JSON.stringify({ repoRoot: '/w/frontend' }));
  await fs.writeFile(path.join(repos, 'frontend-aaaa', 'threads.json'), '{}');
  // backend has saved reviews (default + a session) but nothing running
  await fs.mkdir(path.join(repos, 'backend-bbbb', 'sessions', 'pr-42'), { recursive: true });
  await fs.writeFile(path.join(repos, 'backend-bbbb', 'repo.json'), JSON.stringify({ repoRoot: '/w/backend' }));
  await fs.writeFile(path.join(repos, 'backend-bbbb', 'threads.json'), '{}');
  await fs.writeFile(path.join(repos, 'backend-bbbb', 'sessions', 'pr-42', 'threads.json'), '{}');
  // a folder without repo.json (pre-switcher state) is skipped rather than listed with no path
  await fs.mkdir(path.join(repos, 'orphan-cccc'), { recursive: true });
  await fs.writeFile(path.join(repos, 'orphan-cccc', 'threads.json'), '{}');
});

afterAll(async () => {
  await fs.rm(home, { recursive: true, force: true });
});

describe('discoverServers', () => {
  it('lists live reviews from the hub and stopped repos from disk, current first', async () => {
    const live = new Map<string, RepoContext>([
      ['frontend-aaaa', fakeContext('frontend-aaaa', '/w/frontend', null, 'working tree vs HEAD')],
    ]);
    const list = await discoverServers({ live, hubUrl: 'http://127.0.0.1:4711', currentId: 'frontend-aaaa' });
    const keys = list.map((s) => `${s.name}${s.session ? `@${s.session}` : ''}:${s.live ? 'live' : 'dead'}${s.current ? ':current' : ''}`);
    expect(keys).toEqual(['frontend:live:current', 'backend:dead', 'backend@pr-42:dead']);

    const fe = list[0];
    expect(fe.id).toBe('frontend-aaaa');
    expect(fe.url).toBe('http://127.0.0.1:4711/r/frontend-aaaa/');
    expect(fe.mode).toBe('working tree vs HEAD');

    const be = list.find((s) => s.name === 'backend' && !s.session)!;
    expect(be.id).toBeNull();
    expect(be.url).toBeNull();
    expect(be.repoRoot).toBe('/w/backend');
  });

  it('does not list a live repo twice when its folder is on disk as well', async () => {
    const live = new Map<string, RepoContext>([
      ['backend-bbbb', fakeContext('backend-bbbb', '/w/backend', null, 'develop...feature (working tree)')],
    ]);
    const list = await discoverServers({ live, hubUrl: 'http://127.0.0.1:4711', currentId: null });
    expect(list.filter((s) => s.name === 'backend' && !s.session)).toHaveLength(1);
    expect(list.find((s) => s.name === 'backend' && !s.session)?.live).toBe(true);
    // the other backend session is still listed as stopped
    expect(list.find((s) => s.session === 'pr-42')?.live).toBe(false);
  });
});
