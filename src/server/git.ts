import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { parseUnifiedDiff } from './diff-parser.js';
import type { DiffFile, DiffPayload } from '../shared/types.js';

const exec = promisify(execFile);
const MAX_BUFFER = 256 * 1024 * 1024;

export class GitError extends Error {}

export async function git(cwd: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await exec('git', args, { cwd, maxBuffer: MAX_BUFFER });
    return stdout;
  } catch (err: unknown) {
    const e = err as { stderr?: string; message?: string };
    throw new GitError((e.stderr || e.message || 'git failed').trim());
  }
}

export async function repoRootOf(cwd: string): Promise<string> {
  const out = await git(cwd, ['rev-parse', '--show-toplevel']);
  return out.trim();
}

/**
 * Where a side's full file content lives: a revision, `:` for the index,
 * `null` for the working tree, `undefined` when there is none (stdin diffs).
 */
export type SideRev = string | null | undefined;

export interface DiffTarget {
  /** arguments appended to `git diff` */
  args: string[];
  /** human readable label shown in the UI */
  mode: string;
  /** working tree diffs also list untracked files */
  includeUntracked: boolean;
  oldRev?: SideRev;
  newRev?: SideRev;
  /** extra `git …` argument sets to run on an explicit reload, e.g. re-fetch a PR head */
  refetch?: string[][];
  /** the branch whose code is on the new side, when the review is of a branch (null: a commit / the working tree) */
  reviewedBranch?: string | null;
  /** pull request number when the review is of a PR */
  pr?: number;
}

const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

async function isCommitish(cwd: string, ref: string): Promise<boolean> {
  try {
    await git(cwd, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
    return true;
  } catch {
    return false;
  }
}

async function isBranch(cwd: string, ref: string): Promise<boolean> {
  for (const prefix of ['refs/heads/', 'refs/remotes/']) {
    try {
      await git(cwd, ['show-ref', '--verify', '--quiet', `${prefix}${ref}`]);
      return true;
    } catch {
      /* not under this prefix */
    }
  }
  return false;
}

async function currentBranch(cwd: string): Promise<string | null> {
  try {
    const name = (await git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
    return name === 'HEAD' ? null : name;
  } catch {
    return null;
  }
}

/**
 * Two revisions, compared the way a pull request is: from their merge base to
 * `b`, so commits that landed on `a` after the branch point do not show up as
 * if the branch had reverted them. `exact` compares the two tips directly.
 */
async function rangeTarget(cwd: string, a: string, b: string, exact: boolean): Promise<DiffTarget> {
  for (const ref of [a, b]) {
    if (!(await isCommitish(cwd, ref))) throw new GitError(`unknown revision: ${ref}`);
  }
  if (exact) return { args: [a, b], mode: `${a} → ${b}`, includeUntracked: false, oldRev: a, newRev: b };
  let base: string;
  try {
    base = (await git(cwd, ['merge-base', a, b])).trim();
  } catch {
    // unrelated histories: there is no branch point, so the tips are all we have
    return { args: [a, b], mode: `${a} → ${b} (no merge base)`, includeUntracked: false, oldRev: a, newRev: b };
  }
  return { args: [`${a}...${b}`], mode: `${a}...${b}`, includeUntracked: false, oldRev: base, newRev: b, reviewedBranch: b };
}

/**
 * Reviewing the branch you are standing on, as a PR into `base`: diff the merge
 * base against the WORKING TREE rather than the branch tip, so the whole branch
 * shows AND uncommitted edits — a [fix] Claude just made — appear live and
 * re-anchor, instead of being invisible until committed. Falls back to a commit
 * range when there is no merge base.
 */
async function liveBranchTarget(cwd: string, base: string, here: string): Promise<DiffTarget> {
  if (!(await isCommitish(cwd, base))) throw new GitError(`unknown revision: ${base}`);
  let mergeBase: string;
  try {
    mergeBase = (await git(cwd, ['merge-base', base, 'HEAD'])).trim();
  } catch {
    return rangeTarget(cwd, base, here, false);
  }
  return {
    args: [mergeBase],
    mode: `${base}...${here} (working tree)`,
    includeUntracked: true,
    oldRev: mergeBase,
    newRev: null,
    reviewedBranch: here,
  };
}

export interface PullRequestRef {
  number: number;
  /** owner/repo when the reference named one */
  repo: string | null;
}

/**
 * `https://github.com/o/r/pull/12`, `o/r#12`, `#12`, `pull/12`, `pr/12`.
 * A bare number is not accepted: it could just as well be a commit prefix.
 */
export function parsePullRequest(arg: string): PullRequestRef | null {
  const url = arg.match(/^(?:https?:\/\/)?(?:www\.)?github\.com\/([^/\s]+\/[^/\s]+)\/pull\/(\d+)(?:[/?#].*)?$/i);
  if (url) return { number: Number(url[2]), repo: url[1].replace(/\.git$/, '') };
  const short = arg.match(/^([^/\s#]+\/[^/\s#]+)#(\d+)$/);
  if (short) return { number: Number(short[2]), repo: short[1] };
  const local = arg.match(/^(?:#|pull\/|pr\/|PR\/)(\d+)$/i);
  if (local) return { number: Number(local[1]), repo: null };
  return null;
}

/** The remote whose URL points at owner/repo, else origin. */
async function remoteFor(cwd: string, repo: string | null): Promise<string> {
  if (!repo) return 'origin';
  const out = await git(cwd, ['remote', '-v']).catch(() => '');
  const needle = repo.toLowerCase();
  for (const line of out.split('\n')) {
    const [name, url] = line.split(/\s+/);
    if (name && url && url.toLowerCase().replace(/\.git$/, '').endsWith(needle)) return name;
  }
  return 'origin';
}

async function defaultBranch(cwd: string, remote: string): Promise<string> {
  try {
    const ref = (await git(cwd, ['symbolic-ref', '--quiet', `refs/remotes/${remote}/HEAD`])).trim();
    return ref.replace(`refs/remotes/${remote}/`, '');
  } catch {
    return 'main';
  }
}

/**
 * Review a GitHub pull request: fetch its head into refs/marj/pr/<n>, ask `gh`
 * for the base branch and title (falling back to the remote's default branch),
 * and diff from the merge base exactly like the PR page does.
 */
async function pullRequestTarget(cwd: string, pr: PullRequestRef, exact: boolean): Promise<DiffTarget> {
  const remote = await remoteFor(cwd, pr.repo);
  const head = `refs/marj/pr/${pr.number}`;
  try {
    await git(cwd, ['fetch', '--quiet', remote, `+refs/pull/${pr.number}/head:${head}`]);
  } catch (err) {
    throw new GitError(`could not fetch pull request #${pr.number} from ${remote}: ${(err as Error).message}`);
  }

  let base = '';
  let title = '';
  let branch = '';
  try {
    const args = ['pr', 'view', String(pr.number), '--json', 'baseRefName,headRefName,title'];
    if (pr.repo) args.push('--repo', pr.repo);
    const { stdout } = await exec('gh', args, { cwd, maxBuffer: MAX_BUFFER });
    const info = JSON.parse(stdout) as { baseRefName: string; headRefName: string; title: string };
    base = info.baseRefName;
    title = info.title;
    branch = info.headRefName;
  } catch {
    base = await defaultBranch(cwd, remote);
  }
  await git(cwd, ['fetch', '--quiet', remote, base]).catch(() => {});

  const target = await rangeTarget(cwd, `${remote}/${base}`, head, exact);
  const label = title ? `PR #${pr.number} · ${title}` : `PR #${pr.number}`;
  // on reload, pull the PR head again (it may have new commits) and the base
  const refetch = [
    ['fetch', '--quiet', remote, `+refs/pull/${pr.number}/head:${head}`],
    ['fetch', '--quiet', remote, base],
  ];
  return {
    ...target,
    mode: `${label}  (${branch || head} → ${base})`,
    refetch,
    reviewedBranch: branch || null,
    pr: pr.number,
  };
}

/* ------------------------------------------------------------------------- */
/* the working tree: what is not committed yet, and committing it            */
/* ------------------------------------------------------------------------- */

/** Everything in the working tree that HEAD does not have: modified, staged and untracked. */
export function worktreeTarget(hasHead: boolean): DiffTarget {
  return hasHead
    ? { args: ['HEAD'], mode: 'uncommitted', includeUntracked: true, oldRev: 'HEAD', newRev: null }
    : { args: [], mode: 'uncommitted', includeUntracked: true, newRev: null };
}

export async function hasHead(cwd: string): Promise<boolean> {
  return isCommitish(cwd, 'HEAD');
}

export async function currentBranchName(cwd: string): Promise<string | null> {
  return currentBranch(cwd);
}

/** Paths among `files` whose on-disk mtime is newer than `since` — i.e. touched during this review. */
export async function touchedSince(repoRoot: string, files: string[], since: Date): Promise<string[]> {
  const out: string[] = [];
  for (const file of files) {
    try {
      const stat = await fs.stat(path.join(repoRoot, file));
      if (stat.mtimeMs > since.getTime()) out.push(file);
    } catch {
      /* deleted in the working tree: nothing to stat */
    }
  }
  return out;
}

export interface CommitInput {
  message: string;
  /** limit the commit to these paths; default: everything uncommitted */
  paths?: string[];
  push?: boolean;
}

export interface CommitResult {
  sha: string;
  branch: string | null;
  pushed: boolean;
  /** set when the commit succeeded but the push did not */
  pushError?: string;
}

/**
 * Stage and commit the working tree (or the given paths), optionally push.
 * The one place marj writes to git; only ever called from an explicit user
 * action in the UI.
 */
export async function commitChanges(repoRoot: string, input: CommitInput): Promise<CommitResult> {
  const message = input.message.trim();
  if (!message) throw new GitError('a commit message is required');

  if (input.paths && input.paths.length > 0) await git(repoRoot, ['add', '-A', '--', ...input.paths]);
  else await git(repoRoot, ['add', '-A']);

  const staged = (await git(repoRoot, ['diff', '--cached', '--name-only'])).trim();
  if (!staged) throw new GitError('nothing to commit');

  await git(repoRoot, ['commit', '--quiet', '-m', message]);
  const sha = (await git(repoRoot, ['rev-parse', 'HEAD'])).trim();
  const branch = await currentBranch(repoRoot);

  if (!input.push) return { sha, branch, pushed: false };
  if (!branch) return { sha, branch, pushed: false, pushError: 'detached HEAD: check out a branch to push' };
  try {
    try {
      await git(repoRoot, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']);
      await git(repoRoot, ['push', '--quiet']);
    } catch {
      // no upstream yet: publish the branch
      await git(repoRoot, ['push', '--quiet', '-u', 'origin', branch]);
    }
    return { sha, branch, pushed: true };
  } catch (err) {
    return { sha, branch, pushed: false, pushError: (err as Error).message };
  }
}

/**
 * Put the working tree on the branch being reviewed so fixes land where they
 * belong. A PR head that only exists as refs/marj/pr/N becomes a local branch.
 */
export async function checkoutReviewed(repoRoot: string, target: DiffTarget): Promise<string> {
  const branch = target.reviewedBranch;
  if (!branch) throw new GitError('this review is not of a branch');
  if (target.pr !== undefined) {
    try {
      await exec('gh', ['pr', 'checkout', String(target.pr)], { cwd: repoRoot, maxBuffer: MAX_BUFFER });
      return (await currentBranch(repoRoot)) ?? branch;
    } catch {
      // no gh: build the branch from the ref we fetched
      await git(repoRoot, ['checkout', '--quiet', '-B', branch, `refs/marj/pr/${target.pr}`]);
      return branch;
    }
  }
  await git(repoRoot, ['checkout', '--quiet', branch]);
  return branch;
}

/**
 * The whole file on one side of the diff, one string per line, or null when
 * there is nothing to read (binary, missing, stdin diff).
 */
export async function readSideFile(repoRoot: string, target: DiffTarget, side: 'old' | 'new', file: string): Promise<string[] | null> {
  const rev = side === 'old' ? target.oldRev : target.newRev;
  if (rev === undefined) return null;
  let content: string;
  try {
    content = rev === null
      ? await fs.readFile(path.join(repoRoot, file), 'utf8')
      : await git(repoRoot, ['show', `${rev}:${file}`]);
  } catch {
    return null;
  }
  if (content.includes('\0')) return null;
  const lines = content.split('\n');
  if (lines.at(-1) === '') lines.pop();
  return lines;
}

/**
 * Turn CLI positionals into git diff arguments.
 *
 *   (none)            working tree vs HEAD, plus untracked files
 *   .                 unstaged changes only
 *   --staged          staged changes only
 *   <branch>          the current branch as a PR into <branch> (merge base → HEAD)
 *   <commit>          that single commit
 *   <a>..<b>          from the merge base of a and b to b, like a GitHub PR
 *   <a> <b>           same as a..b
 *   <a>...<b>         passed to git as written
 *
 * `exact` turns a..b and `a b` into a plain two-tip diff.
 */
export async function resolveTarget(
  cwd: string,
  positional: string[],
  opts: { staged?: boolean; exact?: boolean } = {},
): Promise<DiffTarget> {
  if (opts.staged) {
    return { args: ['--cached'], mode: 'staged changes', includeUntracked: false, oldRev: 'HEAD', newRev: ':' };
  }
  const exact = opts.exact === true;

  if (positional.length === 0) {
    const hasHead = await isCommitish(cwd, 'HEAD');
    return hasHead
      ? { args: ['HEAD'], mode: 'working tree vs HEAD', includeUntracked: true, oldRev: 'HEAD', newRev: null }
      : { args: [], mode: 'working tree (no commits yet)', includeUntracked: true, newRev: null };
  }

  if (positional.length === 1) {
    const arg = positional[0];
    if (arg === '.') return { args: [], mode: 'unstaged changes', includeUntracked: true, oldRev: ':', newRev: null };
    const pr = parsePullRequest(arg);
    if (pr) return pullRequestTarget(cwd, pr, exact);
    if (arg.includes('...')) {
      const [a, b] = arg.split('...');
      return rangeTarget(cwd, a || 'HEAD', b || 'HEAD', false);
    }
    if (arg.includes('..')) {
      const [a, b] = arg.split('..');
      return rangeTarget(cwd, a || 'HEAD', b || 'HEAD', exact);
    }
    // `marj develop` on a feature branch: review the branch as a PR into develop.
    // Live against the working tree so fixes show, unless --exact was asked for.
    const here = await currentBranch(cwd);
    if (here && here !== arg && (await isBranch(cwd, arg))) {
      return exact ? rangeTarget(cwd, arg, here, true) : liveBranchTarget(cwd, arg, here);
    }
    if (await isCommitish(cwd, arg)) {
      const subject = (await git(cwd, ['log', '-1', '--format=%h %s', arg])).trim();
      const hasParent = await isCommitish(cwd, `${arg}^`);
      return {
        args: hasParent ? [`${arg}^`, arg] : [EMPTY_TREE, arg],
        mode: `commit ${subject}`,
        includeUntracked: false,
        oldRev: hasParent ? `${arg}^` : EMPTY_TREE,
        newRev: arg,
      };
    }
    throw new GitError(`unknown revision: ${arg}`);
  }

  const [a, b] = positional;
  return rangeTarget(cwd, a, b, exact);
}

async function untrackedFiles(cwd: string): Promise<string[]> {
  const out = await git(cwd, ['ls-files', '--others', '--exclude-standard', '-z']);
  return out.split('\0').filter(Boolean);
}

/** `git diff --no-index /dev/null <file>` so new files show up as additions. */
async function diffUntracked(cwd: string, file: string, context: number): Promise<DiffFile[]> {
  try {
    await exec('git', ['diff', '--no-color', '--no-index', `-U${context}`, '/dev/null', file], {
      cwd,
      maxBuffer: MAX_BUFFER,
    });
    return [];
  } catch (err: unknown) {
    // --no-index exits 1 when files differ, which is the normal case here
    const e = err as { stdout?: string };
    if (!e.stdout) return [];
    return parseUnifiedDiff(e.stdout).map((f) => ({ ...f, status: 'added' as const }));
  }
}

let versionCounter = 0;

export async function authorName(repoRoot: string): Promise<string> {
  try {
    return (await git(repoRoot, ['config', 'user.name'])).trim() || 'you';
  } catch {
    return 'you';
  }
}

export async function computeDiff(
  repoRoot: string,
  target: DiffTarget,
  context: number,
): Promise<DiffPayload> {
  const args = ['diff', '--no-color', '--find-renames', `-U${context}`, ...target.args];
  const raw = await git(repoRoot, args);
  const files = parseUnifiedDiff(raw);

  if (target.includeUntracked) {
    for (const file of await untrackedFiles(repoRoot)) {
      files.push(...(await diffUntracked(repoRoot, file, context)));
    }
  }

  files.sort((a, b) => a.path.localeCompare(b.path));

  return {
    mode: target.mode,
    args: target.args,
    repoRoot,
    files,
    version: ++versionCounter,
    computedAt: new Date().toISOString(),
    author: await authorName(repoRoot),
  };
}

/** Diff built from stdin rather than from git. */
export async function diffFromRaw(raw: string, repoRoot: string): Promise<DiffPayload> {
  return {
    mode: 'stdin',
    args: [],
    repoRoot,
    files: parseUnifiedDiff(raw),
    version: ++versionCounter,
    computedAt: new Date().toISOString(),
    author: await authorName(repoRoot),
  };
}
