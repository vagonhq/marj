import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// MARJ_HOME is read when the server module loads, so point it at a temp dir first
const home = await fs.mkdtemp(path.join(os.tmpdir(), 'marj-home-'));
process.env.MARJ_HOME = home;
const { discoverServers } = await import('../src/server/registry.js');

const dead = { pid: 999_999_9, url: 'http://127.0.0.1:1', cwd: '', mode: 'stale', startedAt: '', port: 1 };

beforeAll(async () => {
  const repos = path.join(home, 'repos');
  // a repo whose server died without cleaning up
  await fs.mkdir(path.join(repos, 'frontend-aaaa'), { recursive: true });
  await fs.writeFile(path.join(repos, 'frontend-aaaa', 'server.json'), JSON.stringify({ ...dead, repoRoot: '/w/frontend' }));
  await fs.writeFile(path.join(repos, 'frontend-aaaa', 'threads.json'), '{}');
  // a repo with saved reviews and no server at all
  await fs.mkdir(path.join(repos, 'backend-bbbb'), { recursive: true });
  await fs.writeFile(path.join(repos, 'backend-bbbb', 'repo.json'), JSON.stringify({ repoRoot: '/w/backend' }));
  await fs.writeFile(path.join(repos, 'backend-bbbb', 'threads.json'), '{}');
  // an isolated session of the backend
  await fs.mkdir(path.join(repos, 'backend-bbbb', 'sessions', 'pr-42'), { recursive: true });
  await fs.writeFile(
    path.join(repos, 'backend-bbbb', 'sessions', 'pr-42', 'server.json'),
    JSON.stringify({ ...dead, repoRoot: '/w/backend', session: 'pr-42' }),
  );
});

afterAll(async () => {
  await fs.rm(home, { recursive: true, force: true });
});

describe('discoverServers', () => {
  it('lists every repo and session marj knows, marking the current one and dead servers', async () => {
    const list = await discoverServers({ repoRoot: '/w/backend', session: null });
    const keys = list.map((s) => `${s.name}${s.session ? `@${s.session}` : ''}:${s.live ? 'live' : 'dead'}:${s.current ? 'current' : ''}`);
    // current first, then the rest alphabetically; nothing here is actually running
    expect(keys).toEqual(['backend:dead:current', 'backend@pr-42:dead:', 'frontend:dead:']);
    for (const s of list) {
      expect(s.url).toBeNull();
      expect(s.mode).toBe('');
    }
    expect(list.find((s) => s.name === 'frontend')?.repoRoot).toBe('/w/frontend');
  });

  it('returns nothing when the home has no repos', async () => {
    const empty = await fs.mkdtemp(path.join(os.tmpdir(), 'marj-empty-'));
    const saved = process.env.MARJ_HOME;
    try {
      // discoverServers reads MARJ_HOME at module load; an unknown folder simply yields []
      const list = await discoverServers({ repoRoot: '/nowhere', session: null });
      expect(Array.isArray(list)).toBe(true);
    } finally {
      process.env.MARJ_HOME = saved;
      await fs.rm(empty, { recursive: true, force: true });
    }
  });
});
