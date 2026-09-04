import { GitBranchIcon, GitPullRequestIcon, SearchIcon, TriangleDownIcon } from '@primer/octicons-react';
import { useEffect, useRef, useState } from 'react';
import type { PrListing } from '../../shared/types';
import { api } from '../api.js';

interface Props {
  /** repo root of the review this page shows; the hub needs it to register the PR */
  cwd?: string;
}

/**
 * Find a pull request of this repo from the header and review it. Picking one
 * asks the hub to register it as its own session of the same repo, so the
 * review you are in keeps its threads and the new tab starts clean.
 *
 * An empty box lists the open pull requests; anything typed goes to GitHub's
 * own search over every state, so `login`, `author:kemal` and `12` all work.
 */
export function PrSearch({ cwd }: Props) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [items, setItems] = useState<PrListing[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [opening, setOpening] = useState<number | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    input.current?.focus();
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

  // one request per typing pause, and none at all while the menu is closed
  useEffect(() => {
    if (!open) return;
    let live = true;
    const timer = window.setTimeout(() => {
      setError(null);
      api
        .prs(query)
        .then((prs) => live && setItems(prs))
        .catch((err: Error) => live && setError(err.message));
    }, query ? 250 : 0);
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
  }, [open, query]);

  const pick = async (pr: PrListing) => {
    if (!cwd || opening !== null) return;
    setOpening(pr.number);
    setError(null);
    try {
      // fetching the PR head can take a few seconds, so the row stays busy until we navigate
      const server = await api.openPr(cwd, pr.number);
      window.location.assign(server.url);
    } catch (err) {
      setError((err as Error).message);
      setOpening(null);
    }
  };

  return (
    <div className="repo-switch pr-search" ref={box}>
      <button
        className="repo-switch-btn"
        title="Find a pull request of this repo and review it"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <GitPullRequestIcon size={16} />
        <span>PRs</span>
        <TriangleDownIcon size={16} />
      </button>

      {open && (
        <div className="repo-menu pr-menu" role="menu">
          <div className="pr-search-field">
            <SearchIcon size={14} />
            <input
              ref={input}
              value={query}
              placeholder="search pull requests — text, 12, author:me"
              aria-label="search pull requests"
              onChange={(event) => setQuery(event.target.value)}
            />
          </div>
          {error && <div className="repo-menu-note">{error}</div>}
          {!error && items === null && <div className="repo-menu-note">searching…</div>}
          {!error && items?.length === 0 && (
            <div className="repo-menu-note">{query ? 'no pull request matches.' : 'no open pull requests.'}</div>
          )}
          {items?.map((pr) => (
            <button
              key={pr.number}
              role="menuitem"
              className="repo-menu-item"
              disabled={!cwd || opening !== null}
              title={pr.url ?? `PR #${pr.number}`}
              onClick={() => void pick(pr)}
            >
              <span className="repo-menu-check">
                <GitPullRequestIcon size={14} />
              </span>
              <span className="repo-menu-main">
                <span className="repo-menu-name">
                  <span className="pr-number">#{pr.number}</span>
                  <span className="pr-title">{pr.title}</span>
                  {pr.draft && <span className="label">draft</span>}
                  {pr.state && pr.state !== 'open' && <span className="label">{pr.state}</span>}
                </span>
                <span className="repo-menu-sub">
                  {pr.author && <>{pr.author}</>}
                  {pr.branch && (
                    <>
                      {pr.author ? ' · ' : ''}
                      <GitBranchIcon size={12} /> {pr.branch}
                    </>
                  )}
                  {opening === pr.number && ' · fetching…'}
                </span>
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
