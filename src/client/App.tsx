import {
  BellIcon,
  BellSlashIcon,
  ColumnsIcon,
  CommentDiscussionIcon,
  GitCompareIcon,
  MoonIcon,
  RowsIcon,
  SidebarCollapseIcon,
  SidebarExpandIcon,
  SunIcon,
} from '@primer/octicons-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { describeTarget, isChat, type DiffFile, type DiffPayload, type Intent, type Thread } from '../shared/types';
import { api, subscribe } from './api.js';
import { ChatPanel } from './components/ChatPanel.js';
import { FileCard } from './components/FileCard.js';
import { FileTree } from './components/FileTree.js';
import { Toasts, type Toast } from './components/Toasts.js';
import type { DraftTarget } from './components/types.js';
import { jumpTo } from './flash.js';
import { askForNotifications, chime, desktopNotify } from './notify.js';
import { buildLocationIndex } from './locations.js';
import { buildTree, flattenTree } from './tree.js';

type ViewMode = 'unified' | 'split';
type Theme = 'dark' | 'light';

function stored<T extends string>(key: string, fallback: T): T {
  try {
    return (localStorage.getItem(key) as T | null) ?? fallback;
  } catch {
    return fallback;
  }
}

function remember(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* private mode */
  }
}

/** "Viewed" is cleared when the file changes again, like it is on GitHub. */
const signatureOf = (file: DiffFile) => `${file.additions}:${file.deletions}:${file.hunks.length}`;

const PANEL = {
  sidebar: { key: 'marj:sidebar-width', fallback: 300, min: 180, max: 640 },
  chat: { key: 'marj:chat-width', fallback: 420, min: 280, max: 900 },
} as const;

function storedNumber(key: string, fallback: number): number {
  const value = Number(stored(key, ''));
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

/**
 * The drag handle between two panels. The width is written to a CSS variable
 * on the fly and remembered on release; a double-click restores the default.
 */
function Resizer({
  panel,
  onChange,
}: {
  panel: keyof typeof PANEL;
  /** called with the new width while dragging, and with null to reset */
  onChange: (width: number | null) => void;
}) {
  const [active, setActive] = useState(false);
  const start = (event: React.MouseEvent) => {
    if (event.button !== 0) return;
    event.preventDefault();
    const spec = PANEL[panel];
    const el = (event.currentTarget as HTMLElement)[panel === 'sidebar' ? 'previousElementSibling' : 'nextElementSibling'];
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const origin = event.clientX;
    const initial = rect.width;
    setActive(true);
    document.body.classList.add('resizing');
    const move = (e: MouseEvent) => {
      const delta = panel === 'sidebar' ? e.clientX - origin : origin - e.clientX;
      onChange(Math.min(spec.max, Math.max(spec.min, Math.round(initial + delta))));
    };
    const stop = () => {
      setActive(false);
      document.body.classList.remove('resizing');
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', stop);
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', stop);
  };
  return (
    <div
      className={`resizer${active ? ' active' : ''}`}
      role="separator"
      aria-orientation="vertical"
      title="Drag to resize · double-click to reset"
      onMouseDown={start}
      onDoubleClick={() => onChange(null)}
    />
  );
}

export function App() {
  const [diff, setDiff] = useState<DiffPayload | null>(null);
  const [threads, setThreads] = useState<Thread[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<ViewMode>(() => stored<ViewMode>('marj:view', 'unified'));
  const [theme, setTheme] = useState<Theme>(() =>
    stored<Theme>('marj:theme', window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'),
  );
  const [alerts, setAlerts] = useState(() => stored('marj:alerts', 'on') === 'on');
  const [draft, setDraft] = useState<DraftTarget | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [viewed, setViewed] = useState<Map<string, string>>(new Map());
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [pulse, setPulse] = useState(false);
  const [chatOpen, setChatOpen] = useState(() => stored<string>('marj:chat', 'closed') === 'open');
  const [sidebarOpen, setSidebarOpen] = useState(() => stored<string>('marj:sidebar', 'open') === 'open');
  const [sidebarWidth, setSidebarWidth] = useState(() => storedNumber(PANEL.sidebar.key, PANEL.sidebar.fallback));
  const [chatWidth, setChatWidth] = useState(() => storedNumber(PANEL.chat.key, PANEL.chat.fallback));
  /** the file a chat location link last jumped to, highlighted in the sidebar */
  const [activeFile, setActiveFile] = useState<string | null>(null);
  /** a line a chat link asked for; the file card expands to it if the diff does not show it */
  const [reveal, setReveal] = useState<{ file: string; line: number; nonce: number } | null>(null);

  const pulseTimer = useRef<number>();
  const collapsedInitialised = useRef(false);
  const viewedKey = useRef<string | null>(null);
  /** highest agent message seq already seen; -1 until the first load settles */
  const lastAgentSeq = useRef(-1);
  const alertsRef = useRef(alerts);
  alertsRef.current = alerts;
  const toastId = useRef(0);

  const loadDiff = useCallback(async () => {
    try {
      const payload = await api.diff();
      setDiff(payload);

      if (!collapsedInitialised.current) {
        collapsedInitialised.current = true;
        setCollapsed(new Set(payload.files.filter((f) => f.generated).map((f) => f.path)));
      }

      // restore "viewed", dropping files that changed since they were marked
      const key = `marj:viewed:${payload.repoRoot}`;
      const restored = new Map<string, string>();
      try {
        const raw = JSON.parse(localStorage.getItem(key) ?? '{}') as Record<string, string>;
        for (const file of payload.files) {
          if (raw[file.path] && raw[file.path] === signatureOf(file)) restored.set(file.path, raw[file.path]);
        }
      } catch {
        /* private mode */
      }
      if (viewedKey.current !== key) {
        viewedKey.current = key;
        setViewed(restored);
        setCollapsed((folded) => new Set([...folded, ...restored.keys()]));
      } else {
        setViewed((previous) => {
          const next = new Map<string, string>();
          for (const file of payload.files) {
            const signature = previous.get(file.path);
            if (signature && signature === signatureOf(file)) next.set(file.path, signature);
          }
          return next;
        });
      }
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);

  const scrollToThread = useCallback((threadId: string) => {
    if (threadId === 'chat') {
      setChatOpen(true);
      return;
    }
    setThreads((current) => {
      const thread = current.find((t) => t.id === threadId);
      if (thread) setCollapsed((folded) => new Set([...folded].filter((p) => p !== thread.file)));
      return current;
    });
    window.setTimeout(() => jumpTo(`thread-${threadId}`, 'center'), 60);
  }, []);

  const loadThreads = useCallback(async () => {
    try {
      const { threads: fresh } = await api.threads();
      setThreads(fresh);

      // announce answers that arrived since the last look
      const replies = fresh
        .flatMap((thread) => thread.messages.filter((m) => m.role === 'agent').map((m) => ({ thread, message: m })))
        .sort((a, b) => a.message.seq - b.message.seq);
      const highest = replies.at(-1)?.message.seq ?? 0;

      if (lastAgentSeq.current === -1) {
        lastAgentSeq.current = highest;
        return;
      }
      const unseen = replies.filter(({ message }) => message.seq > lastAgentSeq.current);
      lastAgentSeq.current = Math.max(lastAgentSeq.current, highest);
      if (unseen.length === 0 || !alertsRef.current) return;

      chime();
      for (const { thread, message } of unseen) {
        const where = isChat(thread) ? 'the review chat' : describeTarget(thread);
        const preview = message.body.replace(/\s+/g, ' ').slice(0, 140);
        setToasts((current) =>
          [...current, { id: ++toastId.current, title: `Claude replied in ${where}`, body: preview, threadId: thread.id }].slice(-4),
        );
        desktopNotify(`Claude replied · ${where}`, preview, `marj-${thread.id}`, () => scrollToThread(thread.id));
      }
    } catch (err) {
      setError((err as Error).message);
    }
  }, [scrollToThread]);

  useEffect(() => {
    void loadDiff();
    void loadThreads();
    return subscribe((event) => {
      if (event.type === 'diff:changed') {
        void loadDiff();
        setPulse(true);
        window.clearTimeout(pulseTimer.current);
        pulseTimer.current = window.setTimeout(() => setPulse(false), 900);
      }
      if (event.type === 'threads:changed') void loadThreads();
    });
  }, [loadDiff, loadThreads]);

  const repoName = diff?.repoRoot.split('/').filter(Boolean).pop() ?? '';
  useEffect(() => {
    if (repoName) document.title = `${repoName} · ${diff?.mode ?? ''} — marj`;
  }, [repoName, diff?.mode]);

  // Primer's tokens key off these attributes; index.html sets them before first paint
  useEffect(() => {
    document.documentElement.setAttribute('data-color-mode', theme);
    remember('marj:theme', theme);
  }, [theme]);

  useEffect(() => remember('marj:view', view), [view]);
  useEffect(() => remember('marj:chat', chatOpen ? 'open' : 'closed'), [chatOpen]);
  useEffect(() => remember('marj:sidebar', sidebarOpen ? 'open' : 'closed'), [sidebarOpen]);
  useEffect(() => remember(PANEL.sidebar.key, String(sidebarWidth)), [sidebarWidth]);
  useEffect(() => remember(PANEL.chat.key, String(chatWidth)), [chatWidth]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === 'TEXTAREA' || target.tagName === 'INPUT')) {
        if (event.key === 'Escape') setDraft(null);
        return;
      }
      if (event.key === 'Escape') setDraft(null);
      // never hijack a modifier chord like ⌘C (copy) or ⌘U (view source)
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.key === 'u') setView((current) => (current === 'unified' ? 'split' : 'unified'));
      if (event.key === 'b') setSidebarOpen((open) => !open);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const chat = useMemo(() => threads.find(isChat) ?? null, [threads]);

  const threadsByFile = useMemo(() => {
    const map = new Map<string, Thread[]>();
    for (const thread of threads) {
      if (isChat(thread)) continue;
      const list = map.get(thread.file) ?? [];
      list.push(thread);
      map.set(thread.file, list);
    }
    return map;
  }, [threads]);

  const pending = threads.filter((t) => t.status !== 'resolved' && t.messages.at(-1)?.role === 'user').length;

  const submitDraft = useCallback(
    async (body: string, intent: Intent) => {
      if (!draft) return;
      await api.createThread({ ...draft, body, intent });
      setDraft(null);
      void loadThreads();
    },
    [draft, loadThreads],
  );

  const toggleFile = useCallback((path: string) => {
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);

  const toggleViewed = useCallback((file: DiffFile) => {
    setViewed((current) => {
      const next = new Map(current);
      if (next.has(file.path)) next.delete(file.path);
      else next.set(file.path, signatureOf(file));
      if (viewedKey.current) remember(viewedKey.current, JSON.stringify(Object.fromEntries(next)));
      setCollapsed((folded) => {
        const updated = new Set(folded);
        if (next.has(file.path)) updated.add(file.path);
        else updated.delete(file.path);
        return updated;
      });
      return next;
    });
  }, []);

  const toggleAlerts = useCallback(async () => {
    const next = !alertsRef.current;
    setAlerts(next);
    remember('marj:alerts', next ? 'on' : 'off');
    if (next) {
      await askForNotifications();
      chime();
    }
  }, []);

  const scrollToFile = useCallback((path: string) => jumpTo(`file-${path}`, 'start'), []);

  /**
   * A `path:line` link in the chat. Unfold the file, land on the line if the
   * diff shows it (new side first, old side for deletions), else on the file
   * header, and mark the file in the sidebar.
   */
  const revealNonce = useRef(0);
  const navigate = useCallback((path: string, line: number | null) => {
    setActiveFile(path);
    setCollapsed((folded) => new Set([...folded].filter((p) => p !== path)));
    document.getElementById(`tree-${path}`)?.scrollIntoView({ block: 'nearest' });
    if (line === null) {
      window.setTimeout(() => jumpTo(`file-${path}`, 'start'), 60);
      return;
    }
    // the card owns the jump: it may have to fetch the file and expand the hunk first
    setReveal({ file: path, line, nonce: ++revealNonce.current });
  }, []);

  if (error && !diff) {
    return (
      <div className="fatal">
        <h1>marj</h1>
        <p>{error}</p>
      </div>
    );
  }

  // the cards follow the sidebar's order (folders first, alphabetical), not raw path order
  const files = useMemo(() => flattenTree(buildTree(diff?.files ?? [])), [diff]);
  const locationIndex = useMemo(() => buildLocationIndex(files.map((f) => f.path)), [files]);
  const totals = files.reduce((acc, f) => ({ add: acc.add + f.additions, del: acc.del + f.deletions }), { add: 0, del: 0 });
  const progress = files.length ? Math.round((viewed.size / files.length) * 100) : 0;

  return (
    <div className="app">
      <header className="pagehead">
        <div className="pagehead-row title-row">
          <span className="brand">
            <span className="brand-mark">m</span>
            marj
          </span>
          <span className="crumb-sep">/</span>
          <span className="repo" title={diff?.repoRoot}>
            {repoName || '…'}
          </span>
          <span className="crumb-sep">/</span>
          <span className="mode">{diff?.mode ?? 'loading'}</span>
          <span className={`live${pulse ? ' pulse' : ''}`} title="live — the diff refreshes as files change" />
          <span className="spacer" />
          {pending > 0 && <span className="label accent large">{pending} waiting on Claude</span>}
          <button
            className={`btn invisible chat-toggle${chatOpen ? ' fg-accent' : ''}`}
            title={chatOpen ? 'Hide the review chat' : 'Chat with Claude about the whole change'}
            onClick={() => setChatOpen((open) => !open)}
          >
            <CommentDiscussionIcon size={16} />
            Chat
            {chat && chat.messages.length > 0 && <span className="counter">{chat.messages.length}</span>}
          </button>
          <button
            className={`btn invisible icon-only${alerts ? ' fg-accent' : ''}`}
            title={alerts ? 'Chime + notify when Claude replies (on)' : 'Notifications off'}
            onClick={() => void toggleAlerts()}
          >
            {alerts ? <BellIcon size={16} /> : <BellSlashIcon size={16} />}
          </button>
          <button
            className="btn invisible icon-only"
            title={theme === 'dark' ? 'Switch to light' : 'Switch to dark'}
            onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
          >
            {theme === 'dark' ? <SunIcon size={16} /> : <MoonIcon size={16} />}
          </button>
        </div>

        <div className="pagehead-row toolbar">
          <button
            className="btn invisible icon-only"
            title={sidebarOpen ? 'Hide the file tree (b)' : 'Show the file tree (b)'}
            onClick={() => setSidebarOpen((open) => !open)}
          >
            {sidebarOpen ? <SidebarCollapseIcon size={16} /> : <SidebarExpandIcon size={16} />}
          </button>
          <span className="tab selected">
            <GitCompareIcon size={16} />
            Files changed
            <span className="counter">{files.length}</span>
          </span>
          <span className="diffstat">
            <span className="add">+{totals.add}</span>
            <span className="del">−{totals.del}</span>
          </span>
          <span className="spacer" />
          {files.length > 0 && (
            <div className="progress" title="files marked as viewed">
              <span>
                {viewed.size} / {files.length} files viewed
              </span>
              <span className="bar">
                <i style={{ width: `${progress}%` }} />
              </span>
            </div>
          )}
          <div className="segmented" role="group" aria-label="diff layout">
            <button className={view === 'unified' ? 'selected' : ''} onClick={() => setView('unified')} title="Unified (u)">
              <RowsIcon size={14} /> Unified
            </button>
            <button className={view === 'split' ? 'selected' : ''} onClick={() => setView('split')} title="Split (u)">
              <ColumnsIcon size={14} /> Split
            </button>
          </div>
        </div>
      </header>

      <div
        className="workspace"
        style={{ '--sidebar-width': `${sidebarWidth}px`, '--chat-width': `${chatWidth}px` } as React.CSSProperties}
      >
        {sidebarOpen && (
          <>
            <FileTree files={files} threadsByFile={threadsByFile} viewed={viewed} active={activeFile} onSelect={scrollToFile} />
            <Resizer panel="sidebar" onChange={(w) => setSidebarWidth(w ?? PANEL.sidebar.fallback)} />
          </>
        )}
        <main className="stream">
          {diff && files.length === 0 && <div className="empty">No changes to review.</div>}
          {files.map((file) => (
            <FileCard
              key={file.path}
              file={file}
              view={view}
              threads={threadsByFile.get(file.path) ?? []}
              author={diff?.author ?? 'you'}
              collapsed={collapsed.has(file.path)}
              viewed={viewed.has(file.path)}
              onToggle={() => toggleFile(file.path)}
              onToggleViewed={() => toggleViewed(file)}
              draft={draft && draft.file === file.path ? draft : null}
              onDraft={setDraft}
              onSubmitDraft={submitDraft}
              onThreadsChanged={loadThreads}
              reveal={reveal && reveal.file === file.path ? reveal : null}
              locationIndex={locationIndex}
              onNavigate={navigate}
            />
          ))}
        </main>
        {chatOpen && (
          <Resizer panel="chat" onChange={(w) => setChatWidth(w ?? PANEL.chat.fallback)} />
        )}
        {chatOpen && (
          <ChatPanel
            chat={chat}
            files={files}
            author={diff?.author ?? 'you'}
            onClose={() => setChatOpen(false)}
            onChanged={loadThreads}
            onNavigate={navigate}
          />
        )}
      </div>

      <Toasts
        toasts={toasts}
        onDismiss={(id) => setToasts((current) => current.filter((t) => t.id !== id))}
        onOpen={scrollToThread}
      />
    </div>
  );
}
