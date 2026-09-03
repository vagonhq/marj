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

  it('a bare branch name reviews the current branch into it', async () => {
    const { target, files } = await paths(['main']);
    expect(target.args).toEqual(['main...feature']);
    expect(files).toEqual(['added:feature.txt']);
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
