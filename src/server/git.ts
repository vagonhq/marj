import { execFile } from 'node:child_process';
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

export interface DiffTarget {
  /** arguments appended to `git diff` */
  args: string[];
  /** human readable label shown in the UI */
  mode: string;
  /** working tree diffs also list untracked files */
  includeUntracked: boolean;
}

async function isCommitish(cwd: string, ref: string): Promise<boolean> {
  try {
    await git(cwd, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Turn CLI positionals into git diff arguments.
 *
 *   (none)            working tree vs HEAD, plus untracked files
 *   .                 unstaged changes only
 *   --staged          staged changes only
 *   <commit>          that single commit
 *   <a>..<b>          range
 *   <a> <b>           two revisions
 */
export async function resolveTarget(
  cwd: string,
  positional: string[],
  opts: { staged?: boolean } = {},
): Promise<DiffTarget> {
  if (opts.staged) return { args: ['--cached'], mode: 'staged changes', includeUntracked: false };

  if (positional.length === 0) {
    const hasHead = await isCommitish(cwd, 'HEAD');
    return hasHead
      ? { args: ['HEAD'], mode: 'working tree vs HEAD', includeUntracked: true }
      : { args: [], mode: 'working tree (no commits yet)', includeUntracked: true };
  }

  if (positional.length === 1) {
    const arg = positional[0];
    if (arg === '.') return { args: [], mode: 'unstaged changes', includeUntracked: true };
    if (arg.includes('..')) return { args: [arg], mode: arg, includeUntracked: false };
    if (await isCommitish(cwd, arg)) {
      const subject = (await git(cwd, ['log', '-1', '--format=%h %s', arg])).trim();
      const hasParent = await isCommitish(cwd, `${arg}^`);
      return {
        args: hasParent ? [`${arg}^`, arg] : ['4b825dc642cb6eb9a060e54bf8d69288fbee4904', arg],
        mode: `commit ${subject}`,
        includeUntracked: false,
      };
    }
    throw new GitError(`unknown revision: ${arg}`);
  }

  const [a, b] = positional;
  for (const ref of [a, b]) {
    if (!(await isCommitish(cwd, ref))) throw new GitError(`unknown revision: ${ref}`);
  }
  return { args: [a, b], mode: `${a} → ${b}`, includeUntracked: false };
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
  };
}

/** Diff built from stdin rather than from git. */
export function diffFromRaw(raw: string, repoRoot: string): DiffPayload {
  return {
    mode: 'stdin',
    args: [],
    repoRoot,
    files: parseUnifiedDiff(raw),
    version: ++versionCounter,
    computedAt: new Date().toISOString(),
  };
}
