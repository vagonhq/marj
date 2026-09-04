import { describe, expect, it } from 'vitest';
import { ghPrListArgs, parsePrList, PR_FIELDS } from '../src/server/prs.js';

describe('the gh query for the PR picker', () => {
  it('lists the open pull requests when nothing is typed', () => {
    expect(ghPrListArgs('')).toEqual(['pr', 'list', '--state', 'open', '--limit', '30', '--json', PR_FIELDS]);
    expect(ghPrListArgs('   ')).toEqual(ghPrListArgs(''));
  });

  it('searches every state once something is typed', () => {
    expect(ghPrListArgs('login redirect')).toEqual([
      'pr',
      'list',
      '--state',
      'all',
      '--limit',
      '30',
      '--search',
      'login redirect',
      '--json',
      PR_FIELDS,
    ]);
  });

  it('passes a typed number through as a search term, not as a flag', () => {
    // gh takes the search text as one argument, so `--foo` can never become a flag
    expect(ghPrListArgs('--repo other/repo')).toContain('--repo other/repo');
    expect(ghPrListArgs(' 12 ')).toContain('12');
  });
});

describe('reading what gh returns', () => {
  it('maps a listing, keeping the number, title, branch and draft state', () => {
    const listings = parsePrList(
      JSON.stringify([
        {
          number: 12,
          title: 'fix login redirect',
          author: { login: 'kemal' },
          headRefName: 'fix/login',
          isDraft: false,
          state: 'OPEN',
          updatedAt: '2026-09-01T10:00:00Z',
          url: 'https://github.com/vagonhq/marj/pull/12',
        },
      ]),
    );
    expect(listings).toEqual([
      {
        number: 12,
        title: 'fix login redirect',
        author: 'kemal',
        branch: 'fix/login',
        draft: false,
        state: 'open',
        updatedAt: '2026-09-01T10:00:00Z',
        url: 'https://github.com/vagonhq/marj/pull/12',
      },
    ]);
  });

  it('survives a missing author, branch and url', () => {
    const [pr] = parsePrList(JSON.stringify([{ number: 3, title: 'x', isDraft: true, state: 'MERGED' }]));
    expect(pr).toEqual({ number: 3, title: 'x', author: null, branch: null, draft: true, state: 'merged', updatedAt: null, url: null });
  });

  it('ignores entries without a number and empty output', () => {
    expect(parsePrList(JSON.stringify([{ title: 'no number' }, { number: 4, title: 'ok' }]))).toHaveLength(1);
    expect(parsePrList('')).toEqual([]);
    expect(parsePrList('null')).toEqual([]);
  });

  it('reports unreadable output as a git-style error', () => {
    expect(() => parsePrList('not json')).toThrow(/could not read/i);
  });
});

describe('searching without gh installed', () => {
  it('says gh is needed instead of leaking an ENOENT', async () => {
    const { searchPullRequests } = await import('../src/server/prs.js');
    await expect(searchPullRequests(process.cwd(), '', { command: 'gh-that-does-not-exist' })).rejects.toThrow(
      /GitHub CLI \(`gh`\)/,
    );
  });
});
