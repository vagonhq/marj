import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { computeDiff, resolveTarget } from '../src/server/git.js';

let repo: string;

const run = (...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: repo, stdio: 'pipe' })
    .toString()
    .trim();

/**
 *   main:     A ── C
 *                \
 *   feature:      B
 *
 * A: base.txt · B: feature.txt (on feature) · C: main.txt (on main, after the branch point)
 */
beforeAll(async () => {
  repo = await fs.mkdtemp(path.join(os.tmpdir(), 'marj-git-'));
  run('init', '-q', '-b', 'main');
  // commitChanges runs plain `git commit`; CI runners have no global identity
  run('config', 'user.name', 't');
  run('config', 'user.email', 't@t');
  await fs.writeFile(path.join(repo, 'base.txt'), 'base\n');
  run('add', '.');
  run('commit', '-q', '-m', 'A');
  run('checkout', '-q', '-b', 'feature');
  await fs.writeFile(path.join(repo, 'feature.txt'), 'feature\n');
  run('add', '.');
  run('commit', '-q', '-m', 'B');
  run('checkout', '-q', 'main');
  await fs.writeFile(path.join(repo, 'main.txt'), 'main\n');
  run('add', '.');
  run('commit', '-q', '-m', 'C');
  run('checkout', '-q', 'feature');
});

afterAll(async () => {
  await fs.rm(repo, { recursive: true, force: true });
});

const paths = async (positional: string[], opts?: { exact?: boolean }) => {
  const target = await resolveTarget(repo, positional, opts);
  const diff = await computeDiff(repo, target, 3);
  return { target, files: diff.files.map((f) => `${f.status}:${f.path}`) };
};

describe('review targets', () => {
  it('a..b shows only what the branch added, like a pull request', async () => {
    const { target, files } = await paths(['main..feature']);
    expect(target.args).toEqual(['main...feature']);
    expect(files).toEqual(['added:feature.txt']);
  });

  it('two revisions behave like a..b', async () => {
    const { target } = await paths(['main', 'feature']);
    expect(target.args).toEqual(['main...feature']);
  });

  it('--exact compares the tips and shows main.txt as removed', async () => {
    const { target, files } = await paths(['main..feature'], { exact: true });
    expect(target.args).toEqual(['main', 'feature']);
    expect(files).toEqual(['added:feature.txt', 'deleted:main.txt']);
  });

  it('a bare branch name reviews the current branch live against the working tree', async () => {
    const { target, files } = await paths(['main']);
    // merge base -> working tree, so uncommitted fixes show; not a commit range
    expect(target.newRev).toBeNull();
    expect(target.includeUntracked).toBe(true);
    expect(target.mode).toMatch(/\(working tree\)$/);
    expect(files).toEqual(['added:feature.txt']);
  });

  it('shows an uncommitted fix on the current branch immediately', async () => {
    await fs.appendFile(path.join(repo, 'feature.txt'), 'a fix Claude just made\n');
    await fs.writeFile(path.join(repo, 'untracked.txt'), 'brand new\n');
    try {
      const { files } = await paths(['main']);
      const feature = (await computeDiff(repo, await resolveTarget(repo, ['main']), 3)).files.find((f) => f.path === 'feature.txt');
      expect(feature?.hunks.some((h) => h.lines.some((l) => l.text.includes('a fix Claude just made')))).toBe(true);
      expect(files).toContain('added:untracked.txt');
    } finally {
      run('checkout', '--', 'feature.txt');
      await fs.rm(path.join(repo, 'untracked.txt'), { force: true });
    }
  });

  it('--exact on a bare branch still compares the tips', async () => {
    const { target } = await paths(['main'], { exact: true });
    expect(target.args).toEqual(['main', 'feature']);
    expect(target.newRev).toBe('feature');
  });

  it('a commit hash is still a single commit', async () => {
    const sha = run('rev-parse', 'main');
    const { target, files } = await paths([sha]);
    expect(target.mode).toMatch(/^commit /);
    expect(files).toEqual(['added:main.txt']);
  });

  it('three dots are passed through as written', async () => {
    const { target } = await paths(['main...feature']);
    expect(target.args).toEqual(['main...feature']);
  });
});

describe('pull request references', () => {
  it('understands URLs, owner/repo#n and local shorthands', async () => {
    const { parsePullRequest } = await import('../src/server/git.js');
    expect(parsePullRequest('https://github.com/sezeristif/marj/pull/12')).toEqual({ number: 12, repo: 'sezeristif/marj' });
    expect(parsePullRequest('github.com/sezeristif/marj/pull/12/files')).toEqual({ number: 12, repo: 'sezeristif/marj' });
    expect(parsePullRequest('sezeristif/marj#7')).toEqual({ number: 7, repo: 'sezeristif/marj' });
    expect(parsePullRequest('#7')).toEqual({ number: 7, repo: null });
    expect(parsePullRequest('pull/7')).toEqual({ number: 7, repo: null });
    expect(parsePullRequest('pr/7')).toEqual({ number: 7, repo: null });
  });

  it('leaves revisions alone', async () => {
    const { parsePullRequest } = await import('../src/server/git.js');
    for (const arg of ['7', 'main', 'a1b2c3d', 'main..feature', 'origin/main']) expect(parsePullRequest(arg)).toBeNull();
  });
});

describe('the working tree and committing it', () => {
  it('worktreeTarget lists uncommitted edits plus untracked files, independent of the review', async () => {
    const { worktreeTarget, touchedSince } = await import('../src/server/git.js');
    const before = new Date(Date.now() - 60_000);
    await fs.writeFile(path.join(repo, 'feature.txt'), 'feature\nedited\n');
    await fs.writeFile(path.join(repo, 'new.txt'), 'new\n');
    try {
      const diff = await computeDiff(repo, worktreeTarget(true), 3);
      expect(diff.files.map((f) => `${f.status}:${f.path}`).sort()).toEqual(['added:new.txt', 'modified:feature.txt']);
      // both were written just now, so both count as touched during the review
      const touched = await touchedSince(repo, diff.files.map((f) => f.path), before);
      expect(touched.sort()).toEqual(['feature.txt', 'new.txt']);
      // an older mtime is not "touched"
      const later = new Date(Date.now() + 60_000);
      expect(await touchedSince(repo, ['feature.txt'], later)).toEqual([]);
    } finally {
      run('checkout', '--', 'feature.txt');
      await fs.rm(path.join(repo, 'new.txt'), { force: true });
    }
  });

  it('commitChanges stages everything, commits, and leaves the tree clean', async () => {
    const { commitChanges, worktreeTarget } = await import('../src/server/git.js');
    const headBefore = run('rev-parse', 'HEAD');
    await fs.writeFile(path.join(repo, 'feature.txt'), 'feature\ncommitted fix\n');
    await fs.writeFile(path.join(repo, 'extra.txt'), 'extra\n');

    const result = await commitChanges(repo, { message: 'apply review fix' });
    expect(result.sha).not.toBe(headBefore);
    expect(result.sha).toBe(run('rev-parse', 'HEAD'));
    expect(result.branch).toBe('feature');
    expect(result.pushed).toBe(false);
    expect(run('log', '-1', '--format=%s')).toBe('apply review fix');
    // nothing left uncommitted
    const after = await computeDiff(repo, worktreeTarget(true), 3);
    expect(after.files).toEqual([]);
  });

  it('commitChanges refuses an empty message and an empty tree', async () => {
    const { commitChanges } = await import('../src/server/git.js');
    await expect(commitChanges(repo, { message: '   ' })).rejects.toThrow(/message/);
    await expect(commitChanges(repo, { message: 'nothing here' })).rejects.toThrow(/nothing to commit/);
  });

  it('commitChanges can limit itself to given paths', async () => {
    const { commitChanges, worktreeTarget } = await import('../src/server/git.js');
    await fs.writeFile(path.join(repo, 'only-this.txt'), 'a\n');
    await fs.writeFile(path.join(repo, 'not-this.txt'), 'b\n');
    try {
      await commitChanges(repo, { message: 'partial', paths: ['only-this.txt'] });
      const left = await computeDiff(repo, worktreeTarget(true), 3);
      expect(left.files.map((f) => f.path)).toEqual(['not-this.txt']);
    } finally {
      await fs.rm(path.join(repo, 'not-this.txt'), { force: true });
    }
  });
});
