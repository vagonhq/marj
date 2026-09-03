import { AlertIcon, ChevronDownIcon, ChevronRightIcon, GitCommitIcon, SparkleFillIcon } from '@primer/octicons-react';
import { useEffect, useState } from 'react';
import type { WorktreeState } from '../../shared/types';
import { api } from '../api.js';
import type { LocationIndex } from '../locations.js';
import { FileCard } from './FileCard.js';

interface Props {
  state: WorktreeState | null;
  author: string;
  view: 'unified' | 'split';
  locationIndex: LocationIndex;
  /** the working tree changed (commit, checkout): reload the diff and this list */
  onChanged: () => void;
  onToast: (title: string, body: string) => void;
  /** send the "commit and push this" request to Claude via the review chat */
  onAskClaude: () => Promise<void>;
  /** true while Claude still owes an answer in the chat */
  claudeBusy: boolean;
}

const noop = () => {};
const noopAsync = async () => {};

/**
 * What is not committed yet, independent of what is being reviewed: the fixes
 * Claude made in this review (expanded, badged) and any pre-existing local edits
 * (folded). Commit or commit-and-push from here. When the working tree is on a
 * different branch than the one under review, say so and offer to switch.
 */
export function UncommittedSection({ state, author, view, locationIndex, onChanged, onToast, onAskClaude, claudeBusy }: Props) {
  const [open, setOpen] = useState(() => {
    try {
      return localStorage.getItem('marj:worktree') !== 'closed';
    } catch {
      return true;
    }
  });
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState<'commit' | 'push' | 'checkout' | 'ask' | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** files whose default fold the user flipped */
  const [flipped, setFlipped] = useState<Set<string>>(new Set());

  useEffect(() => {
    try {
      localStorage.setItem('marj:worktree', open ? 'open' : 'closed');
    } catch {
      /* private mode */
    }
  }, [open]);

  if (!state) return null;
  const { files, branch, reviewedBranch, onReviewedBranch, pr } = state;
  const touched = new Set(state.touched);
  const totals = files.reduce((acc, f) => ({ add: acc.add + f.additions, del: acc.del + f.deletions }), { add: 0, del: 0 });

  // this review's fixes open, older local edits folded; a click flips either
  const collapsedFor = (path: string) => (touched.has(path) ? flipped.has(path) : !flipped.has(path));
  const flip = (path: string) =>
    setFlipped((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });

  const commit = async (push: boolean) => {
    if (!message.trim() || busy) return;
    setBusy(push ? 'push' : 'commit');
    setError(null);
    try {
      const result = await api.commit({ message, push });
      setMessage('');
      const where = `${result.sha.slice(0, 7)} on ${result.branch ?? 'a detached HEAD'}`;
      if (push && result.pushed) onToast('Committed and pushed', where);
      else if (push) onToast('Committed, but not pushed', `${where} — ${result.pushError ?? 'push failed'}`);
      else onToast('Committed', where);
      onChanged();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const checkout = async () => {
    if (busy) return;
    setBusy('checkout');
    setError(null);
    try {
      const result = await api.checkout();
      onToast('Switched branch', `now on ${result.branch} — fixes will land here`);
      onChanged();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const askClaude = async () => {
    if (busy) return;
    setBusy('ask');
    setError(null);
    try {
      await onAskClaude();
      onToast('Asked Claude to commit & push', 'it will write the message and commit — watch the chat');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const checkoutHint = pr !== null ? `gh pr checkout ${pr}` : `git checkout ${reviewedBranch}`;

  return (
    <section className={`worktree${files.length ? '' : ' is-empty'}`}>
      <header className="worktree-head">
        <button className="btn invisible icon-only chevron" onClick={() => setOpen((o) => !o)} aria-label={open ? 'collapse' : 'expand'}>
          {open ? <ChevronDownIcon size={16} /> : <ChevronRightIcon size={16} />}
        </button>
        <GitCommitIcon size={16} className="worktree-icon" />
        <strong>Uncommitted changes</strong>
        <span className="counter">{files.length}</span>
        <span className="muted worktree-branch">
          on <code>{branch ?? 'detached HEAD'}</code>
        </span>
        <span className="spacer" />
        {files.length > 0 && (
          <span className="diffstat">
            <span className="add">+{totals.add}</span>
            <span className="del">−{totals.del}</span>
          </span>
        )}
      </header>

      {open && (
        <div className="worktree-body">
          {!onReviewedBranch && reviewedBranch && (
            <div className="worktree-warn" role="alert">
              <AlertIcon size={16} />
              <div className="worktree-warn-text">
                <strong>
                  You are on <code>{branch ?? 'a detached HEAD'}</code>, but this review is of <code>{reviewedBranch}</code>.
                </strong>{' '}
                A fix made now lands on <code>{branch ?? 'the detached HEAD'}</code> and will not show in the reviewed diff.
                <span className="hint"> ({checkoutHint})</span>
              </div>
              <button className="btn small" disabled={busy !== null} onClick={() => void checkout()}>
                {busy === 'checkout' ? 'Switching…' : `Switch to ${reviewedBranch}`}
              </button>
            </div>
          )}

          {files.length === 0 ? (
            <div className="worktree-empty">Nothing uncommitted. Fixes Claude makes show up here, ready to commit.</div>
          ) : (
            <>
              <div className="worktree-files">
                {files.map((file) => (
                  <FileCard
                    key={file.path}
                    file={file}
                    view={view}
                    threads={[]}
                    author={author}
                    collapsed={collapsedFor(file.path)}
                    viewed={false}
                    onToggle={() => flip(file.path)}
                    onToggleViewed={noop}
                    draft={null}
                    onDraft={noop}
                    onSubmitDraft={noopAsync}
                    onThreadsChanged={noop}
                    locationIndex={locationIndex}
                    scope="worktree"
                    readOnly
                    badge={touched.has(file.path) ? 'changed in this review' : undefined}
                  />
                ))}
              </div>

              <div className="worktree-commit">
                <input
                  className="worktree-message"
                  placeholder="Commit message  (Enter: commit · ⌘Enter: commit & push)"
                  value={message}
                  disabled={busy !== null}
                  onChange={(event) => setMessage(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key !== 'Enter') return;
                    event.preventDefault();
                    void commit(event.metaKey || event.ctrlKey);
                  }}
                />
                <button className="btn" disabled={!message.trim() || busy !== null} onClick={() => void commit(false)}>
                  {busy === 'commit' ? 'Committing…' : 'Commit'}
                </button>
                <button className="btn primary" disabled={!message.trim() || busy !== null} onClick={() => void commit(true)}>
                  {busy === 'push' ? 'Pushing…' : 'Commit & push'}
                </button>
                <span className="worktree-or">or</span>
                <button
                  className="btn ask-claude"
                  title="Claude writes the commit message, commits and pushes"
                  disabled={busy !== null || claudeBusy}
                  onClick={() => void askClaude()}
                >
                  <SparkleFillIcon size={14} /> {busy === 'ask' ? 'Asking…' : claudeBusy ? 'Claude is on it…' : 'Ask Claude to commit & push'}
                </button>
              </div>
            </>
          )}
          {error && <div className="worktree-error">{error}</div>}
        </div>
      )}
    </section>
  );
}
