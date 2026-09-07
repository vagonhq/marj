import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { GitError } from './git.js';
import type { PrListing } from '../shared/types.js';

const exec = promisify(execFile);
const MAX_BUFFER = 16 * 1024 * 1024;

/** What the picker needs from `gh pr list`, in gh's own field spelling. */
export const PR_FIELDS = 'number,title,author,headRefName,isDraft,state,updatedAt,url';

/**
 * The `gh` arguments that answer what was typed in the picker. Nothing typed
 * means "the open pull requests"; anything else is handed to GitHub's own
 * search across every state, so `login`, `author:kemal` and `12` all work.
 * The text stays one argument, so a leading `--` can never become a flag.
 */
export function ghPrListArgs(query: string): string[] {
  const q = query.trim();
  const args = ['pr', 'list', '--state', q ? 'all' : 'open', '--limit', '30'];
  if (q) args.push('--search', q);
  args.push('--json', PR_FIELDS);
  return args;
}

interface GhPr {
  number?: number;
  title?: string;
  author?: { login?: string } | null;
  headRefName?: string;
  isDraft?: boolean;
  state?: string;
  updatedAt?: string;
  url?: string;
}

/** `gh --json` output as the picker's listings; entries without a number are skipped. */
export function parsePrList(stdout: string): PrListing[] {
  const text = stdout.trim();
  if (!text) return [];
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new GitError(`could not read the pull request list from gh: ${text.slice(0, 200)}`);
  }
  if (!Array.isArray(raw)) return [];
  return (raw as GhPr[])
    .filter((pr) => typeof pr.number === 'number')
    .map((pr) => ({
      number: pr.number as number,
      title: pr.title ?? '',
      author: pr.author?.login ?? null,
      branch: pr.headRefName ?? null,
      draft: pr.isDraft === true,
      state: (pr.state ?? '').toLowerCase(),
      updatedAt: pr.updatedAt ?? null,
      url: pr.url ?? null,
    }));
}

/**
 * The repo's pull requests matching what was typed, via the GitHub CLI. `gh` is
 * how marj already reads a PR, so a missing or unauthenticated `gh` is reported
 * as such — the picker shows it instead of a bare ENOENT.
 */
export async function searchPullRequests(
  repoRoot: string,
  query: string,
  opts: { command?: string } = {},
): Promise<PrListing[]> {
  const command = opts.command ?? 'gh';
  try {
    const { stdout } = await exec(command, ghPrListArgs(query), { cwd: repoRoot, maxBuffer: MAX_BUFFER });
    return parsePrList(stdout);
  } catch (err) {
    if (err instanceof GitError) throw err;
    const e = err as { code?: string; stderr?: string; message?: string };
    if (e.code === 'ENOENT') {
      throw new GitError('searching pull requests needs the GitHub CLI (`gh`) on your PATH');
    }
    const detail = (e.stderr || e.message || 'gh failed').trim();
    if (/auth login|not logged|authentication/i.test(detail)) {
      throw new GitError(`the GitHub CLI (\`gh\`) is not logged in: ${detail}`);
    }
    throw new GitError(detail);
  }
}
