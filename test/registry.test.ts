import { describe, expect, it } from 'vitest';
import type { RepoContext } from '../src/server/context.js';
import { discoverServers } from '../src/server/registry.js';

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

describe('discoverServers', () => {
  it('lists the reviews the hub is serving, alphabetically, with the current one marked in place', async () => {
    const live = new Map<string, RepoContext>([
      ['frontend-aaaa', fakeContext('frontend-aaaa', '/w/frontend', null, 'working tree vs HEAD')],
      ['backend-pr42', fakeContext('backend-pr42', '/w/backend', 'pr-42', 'PR #42')],
      ['backend-bbbb', fakeContext('backend-bbbb', '/w/backend', null, 'develop...feature (working tree)')],
    ]);
    const list = await discoverServers({ live, hubUrl: 'http://127.0.0.1:4711', currentId: 'frontend-aaaa' });
    const keys = list.map((s) => `${s.name}${s.session ? `@${s.session}` : ''}${s.current ? ':current' : ''}`);
    expect(keys).toEqual(['backend', 'backend@pr-42', 'frontend:current']);

    const fe = list.find((s) => s.name === 'frontend')!;
    expect(fe.id).toBe('frontend-aaaa');
    expect(fe.url).toBe('http://127.0.0.1:4711/r/frontend-aaaa/');
    expect(fe.mode).toBe('working tree vs HEAD');
    expect(fe.repoRoot).toBe('/w/frontend');
  });

  it('lists nothing when the hub serves nothing', async () => {
    expect(await discoverServers({ live: new Map(), hubUrl: 'http://127.0.0.1:4711', currentId: null })).toEqual([]);
  });
});
