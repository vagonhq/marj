import { GitBranchIcon, GitCommitIcon, TriangleDownIcon } from '@primer/octicons-react';
import { useEffect, useRef, useState } from 'react';
import type { ChainPosition, CommitChain, CommitListing, WorktreeState } from '../../shared/types';
import { api } from '../api.js';

interface Props {
  /** where the review sits on a chain right now; undefined when it is something else (a single commit, stdin) */
  chain: ChainPosition | undefined;
  /** what the review shows, named in a note when it is not a row of the chain */
  mode: string;
  /** HEAD → working tree, for the row above HEAD */
  worktree: WorktreeState | null;
  /** the review was re-pointed and the diff is being recomputed */
  onTargetChanged: () => void;
}

const PAGE = 50;

function timeAgo(iso: string): string {
  const seconds = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)}h ago`;
  if (seconds < 86400 * 30) return `${Math.round(seconds / 86400)}d ago`;
  return new Date(iso).toLocaleDateString();
}

/**
 * The branch in the header, as the chain of its own commits: from the commit
 * it was created from (its merge base with the base branch, at the bottom)
 * up to HEAD, with the uncommitted changes sitting on top. Pick a commit and
 * the review is the branch up to it — fork point → commit, like a PR; pick
 * the top row and it is the whole branch live against the working tree. The
 * review is re-pointed in place: same address, same threads, re-anchored.
 */
export function BranchView({ chain, mode, worktree, onTargetChanged }: Props) {
  const [open, setOpen] = useState(false);
  const [list, setList] = useState<CommitChain | null>(null);
  /** the branch the chain is measured from; null until the server picks the default */
  const [base, setBase] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  /** the row being switched to, until the new diff arrives */
  const [picking, setPicking] = useState<string | null>(null);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    let live = true;
    setError(null);
    setLoading(true);
    api
      .commits(base, 0, PAGE)
      .then((c) => live && setList(c))
      .catch((err: Error) => live && setError(err.message))
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, [open, base]);

  useEffect(() => {
    if (!open) return;
    const away = (event: MouseEvent) => {
      if (box.current && !box.current.contains(event.target as Node)) setOpen(false);
    };
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', away);
    document.addEventListener('keydown', key);
    return () => {
      document.removeEventListener('mousedown', away);
      document.removeEventListener('keydown', key);
    };
  }, [open]);

  const more = async () => {
    if (!list || loading) return;
    setLoading(true);
    try {
      const next = await api.commits(base, list.commits.length, PAGE);
      setList({ ...next, commits: [...list.commits, ...next.commits] });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  };

  const pick = async (positional: string[], key: string) => {
    if (picking !== null) return;
    setPicking(key);
    setError(null);
    try {
      await api.setTarget(positional);
      onTargetChanged();
      setOpen(false);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setPicking(null);
    }
  };

  const branch = list?.branch ?? worktree?.branch ?? null;
  const fork = list?.base ?? null;
  // the review is on this chain only when it starts where the chain does
  const onChain = !!chain && !!fork && chain.base === fork.sha;
  const selected = onChain ? chain.to ?? 'worktree' : null;
  const selectedIndex = list && selected && selected !== 'worktree' ? list.commits.findIndex((c) => c.sha === selected) : -1;
  // from the fork point up to the picked row is what the diff contains
  const inRange = (index: number) => selected === 'worktree' || (selectedIndex >= 0 && index > selectedIndex);
  const uncommitted = worktree?.files.length ?? 0;
  const totals = (worktree?.files ?? []).reduce((acc, f) => ({ add: acc.add + f.additions, del: acc.del + f.deletions }), { add: 0, del: 0 });
  // standing on the base branch itself, the whole branch live is just the working tree vs HEAD
  const wholeBranch = fork && fork.ref !== branch ? [fork.ref] : [];
  const bases = list ? (fork && !list.bases.includes(fork.ref) ? [fork.ref, ...list.bases] : list.bases) : [];

  const row = (commit: CommitListing, index: number) => {
    const isSelected = selected === commit.sha;
    const isHead = commit.sha === list?.head;
    return (
      <button
        key={commit.sha}
        role="menuitemradio"
        aria-checked={isSelected}
        className={`repo-menu-item chain-row${isSelected ? ' current selected' : ''}${inRange(index) ? ' in-range' : ''}`}
        disabled={picking !== null || !fork}
        title={isSelected ? `reviewing the branch up to ${commit.short}` : `review ${fork?.ref ?? 'the fork point'} → ${commit.short}`}
        onClick={() => fork && void pick([`${fork.ref}...${commit.short}`], commit.sha)}
      >
        <span className="chain-rail">
          <span className="chain-dot" />
        </span>
        <span className="repo-menu-main">
          <span className="repo-menu-name">
            <code className="chain-sha">{commit.short}</code>
            <span className="chain-subject">{commit.subject}</span>
            {isHead && <span className="label accent">HEAD</span>}
            {commit.refs.filter((r) => r !== 'HEAD' && r !== branch).map((r) => (
              <span key={r} className="label">{r}</span>
            ))}
          </span>
          <span className="repo-menu-sub">
            {commit.author} · {timeAgo(commit.date)}
            {picking === commit.sha && ' · switching…'}
          </span>
        </span>
      </button>
    );
  };

  return (
    <div className="repo-switch branch-view" ref={box}>
      <button
        className="repo-switch-btn"
        title="The branch's commits since it was created — pick one to review the branch up to it"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <GitBranchIcon size={16} />
        <span>{branch ?? 'detached HEAD'}</span>
        <TriangleDownIcon size={16} />
      </button>

      {open && (
        <div className="repo-menu chain-menu" role="menu">
          <div className="repo-menu-head chain-head">
            <span>Pick where the review ends · measured from</span>
            <select
              className="chain-base"
              aria-label="base branch"
              value={fork?.ref ?? base ?? ''}
              disabled={!list || picking !== null}
              onChange={(event) => setBase(event.target.value)}
            >
              {!fork && <option value="">— no base branch —</option>}
              {bases.map((b) => (
                <option key={b} value={b}>{b}</option>
              ))}
            </select>
          </div>
          {error && <div className="repo-menu-note">{error}</div>}

          <button
            role="menuitemradio"
            aria-checked={selected === 'worktree'}
            className={`repo-menu-item chain-row chain-worktree${selected === 'worktree' ? ' current selected' : ''}`}
            disabled={picking !== null || !list}
            title={fork ? `review the whole branch since ${fork.ref}, live against the working tree` : 'review the working tree vs HEAD'}
            onClick={() => void pick(wholeBranch, 'worktree')}
          >
            <span className="chain-rail">
              <span className="chain-dot hollow" />
            </span>
            <span className="repo-menu-main">
              <span className="repo-menu-name">
                <GitCommitIcon size={14} />
                <span className="chain-subject">Uncommitted changes</span>
                <span className="counter">{uncommitted}</span>
              </span>
              <span className="repo-menu-sub">
                {uncommitted > 0 ? (
                  <span className="diffstat">
                    <span className="add">+{totals.add}</span>
                    <span className="del">−{totals.del}</span>
                  </span>
                ) : (
                  'nothing uncommitted'
                )}
                {picking === 'worktree' && ' · switching…'}
              </span>
            </span>
          </button>

          {list?.commits.map(row)}

          {!error && list === null && <div className="repo-menu-note">reading the log…</div>}
          {list && fork && list.commits.length === 0 && (
            <div className="repo-menu-note">no commits of its own since {fork.ref} — the branch is at its fork point.</div>
          )}
          {list && !fork && <div className="repo-menu-note">no base branch to measure from.</div>}
          {list?.more && (
            <button className="repo-menu-item chain-more" disabled={loading} onClick={() => void more()}>
              <span className="chain-rail">
                <span className="chain-ellipsis">⋮</span>
              </span>
              <span className="repo-menu-sub">{loading ? 'loading…' : 'older commits'}</span>
            </button>
          )}
          {fork && (
            <div className={`repo-menu-item chain-row chain-fork${selected ? ' in-range' : ''}`} title={`${fork.ref} and ${branch ?? 'HEAD'} last shared this commit`}>
              <span className="chain-rail">
                <span className="chain-dot fork" />
              </span>
              <span className="repo-menu-main">
                <span className="repo-menu-name">
                  <code className="chain-sha">{fork.short}</code>
                  <span className="chain-subject">{fork.subject}</span>
                  <span className="label">{fork.ref}</span>
                </span>
                <span className="repo-menu-sub">where {branch ?? 'this branch'} was created from</span>
              </span>
            </div>
          )}
          {chain === undefined && (
            <div className="repo-menu-note chain-origin">
              Reviewing <strong>{mode}</strong> — picking a row replaces it with a range on this branch.
            </div>
          )}
        </div>
      )}
    </div>
  );
}
