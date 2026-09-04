import { CheckIcon, GitBranchIcon, RepoIcon, TriangleDownIcon } from '@primer/octicons-react';
import { useEffect, useRef, useState } from 'react';
import type { ServerListing } from '../../shared/types';
import { api } from '../api.js';

interface Props {
  /** repo folder name of the server this page talks to */
  name: string;
  repoRoot?: string;
}

/**
 * The repo name in the header, as a menu of every repo and worktree marj knows
 * about. Each has its own server, so picking one navigates this tab to it and
 * you see only that repo's diff. Repos with saved reviews but no running server
 * are listed greyed out, so you know where to start marj.
 */
export function RepoSwitcher({ name, repoRoot }: Props) {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<ServerListing[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    setItems(null);
    setError(null);
    api
      .servers()
      .then(setItems)
      .catch((err: Error) => setError(err.message));
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

  const go = (item: ServerListing) => {
    if (!item.live || !item.url || item.current) return;
    window.location.assign(item.url);
  };

  const others = items?.filter((i) => !i.current) ?? [];

  return (
    <div className="repo-switch" ref={box}>
      <button
        className="repo-switch-btn"
        title={repoRoot ? `${repoRoot} — switch repo / worktree` : 'switch repo / worktree'}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <RepoIcon size={16} />
        <span className="repo">{name}</span>
        <TriangleDownIcon size={16} />
      </button>

      {open && (
        <div className="repo-menu" role="menu">
          <div className="repo-menu-head">Repos &amp; worktrees marj knows</div>
          {error && <div className="repo-menu-note">couldn't list servers: {error}</div>}
          {items && items.length === 0 && <div className="repo-menu-note">Only this one.</div>}
          {items?.map((item) => (
            <button
              key={`${item.repoRoot}::${item.session ?? ''}`}
              role="menuitem"
              className={`repo-menu-item${item.current ? ' current' : ''}${item.live ? '' : ' dead'}`}
              disabled={!item.live || item.current}
              title={item.live ? item.url ?? '' : `not running — start marj in ${item.repoRoot}`}
              onClick={() => go(item)}
            >
              <span className="repo-menu-check">{item.current ? <CheckIcon size={14} /> : <span className={`dot${item.live ? ' live' : ''}`} />}</span>
              <span className="repo-menu-main">
                <span className="repo-menu-name">
                  {item.name}
                  {item.session && <span className="label">{item.session}</span>}
                </span>
                <span className="repo-menu-sub">
                  {item.branch && (
                    <>
                      <GitBranchIcon size={12} /> {item.branch}
                    </>
                  )}
                  {item.live ? (item.mode ? ` · ${item.mode}` : '') : ' · not running'}
                </span>
              </span>
            </button>
          ))}
          {items && others.length > 0 && others.every((i) => !i.live) && (
            <div className="repo-menu-note">Greyed repos have saved reviews but no server. Run `marj` (or `/marj:review`) inside them.</div>
          )}
        </div>
      )}
    </div>
  );
}
