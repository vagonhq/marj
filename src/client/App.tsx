import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { DiffFile, DiffPayload, Intent, Thread } from '../shared/types';
import { api, subscribe } from './api.js';
import { FileCard } from './components/FileCard.js';
import { FileTree } from './components/FileTree.js';
import { Toasts, type Toast } from './components/Toasts.js';
import type { DraftTarget } from './components/types.js';
import { askForNotifications, chime, desktopNotify } from './notify.js';

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
      const current = new Map<string, string>();
      try {
        const raw = JSON.parse(localStorage.getItem(key) ?? '{}') as Record<string, string>;
        for (const file of payload.files) {
          if (raw[file.path] && raw[file.path] === signatureOf(file)) current.set(file.path, raw[file.path]);
        }
      } catch {
        /* private mode */
      }
      if (viewedKey.current !== key) {
        viewedKey.current = key;
        setViewed(current);
        setCollapsed((folded) => new Set([...folded, ...current.keys()]));
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
    const open = () => document.getElementById(`thread-${threadId}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    setThreads((current) => {
      const thread = current.find((t) => t.id === threadId);
      if (thread) setCollapsed((folded) => new Set([...folded].filter((p) => p !== thread.file)));
      return current;
    });
    window.setTimeout(open, 60);
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
      const fresh_replies = replies.filter(({ message }) => message.seq > lastAgentSeq.current);
      lastAgentSeq.current = Math.max(lastAgentSeq.current, highest);
      if (fresh_replies.length === 0 || !alertsRef.current) return;

      chime();
      for (const { thread, message } of fresh_replies) {
        const where = `${thread.file}:${thread.startLine}`;
        const preview = message.body.replace(/\s+/g, ' ').slice(0, 140);
        setToasts((current) =>
          [...current, { id: ++toastId.current, title: `Claude replied on ${where}`, body: preview, threadId: thread.id }].slice(-4),
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

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    remember('marj:theme', theme);
  }, [theme]);

  useEffect(() => remember('marj:view', view), [view]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === 'TEXTAREA' || target.tagName === 'INPUT')) {
        if (event.key === 'Escape') setDraft(null);
        return;
      }
      if (event.key === 'Escape') setDraft(null);
      if (event.key === 'u') setView((current) => (current === 'unified' ? 'split' : 'unified'));
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const threadsByFile = useMemo(() => {
    const map = new Map<string, Thread[]>();
    for (const thread of threads) {
      const list = map.get(thread.file) ?? [];
      list.push(thread);
      map.set(thread.file, list);
    }
    return map;
  }, [threads]);

  const pending = threads.filter(
    (thread) => thread.status !== 'resolved' && thread.messages.at(-1)?.role === 'user',
  ).length;

  const submitDraft = useCallback(
    async (body: string, intent: Intent) => {
      if (!draft) return;
      await api.createThread({
        file: draft.file,
        side: draft.side,
        startLine: draft.startLine,
        endLine: draft.endLine,
        body,
        intent,
      });
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

  const toggleViewed = useCallback(
    (file: DiffFile) => {
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
    },
    [],
  );

  const toggleAlerts = useCallback(async () => {
    const next = !alertsRef.current;
    setAlerts(next);
    remember('marj:alerts', next ? 'on' : 'off');
    if (next) {
      await askForNotifications();
      chime();
    }
  }, []);

  const scrollToFile = useCallback((path: string) => {
    document.getElementById(`file-${path}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, []);

  if (error && !diff) {
    return (
      <div className="fatal">
        <h1>marj</h1>
        <p>{error}</p>
      </div>
    );
  }

  const totals = (diff?.files ?? []).reduce(
    (acc, file) => ({ add: acc.add + file.additions, del: acc.del + file.deletions }),
    { add: 0, del: 0 },
  );

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          marj
          <span className={`live ${pulse ? 'pulse' : ''}`} title="live: the diff refreshes as files change" />
        </div>
        <div className="repo" title={diff?.repoRoot}>
          {repoName}
        </div>
        <div className="mode">{diff?.mode ?? 'loading…'}</div>
        <div className="totals">
          <span className="add">+{totals.add}</span>
          <span className="del">−{totals.del}</span>
          <span className="files">{diff?.files.length ?? 0} files</span>
        </div>
        {diff && diff.files.length > 0 && (
          <div className="progress" title="files marked as reviewed">
            {viewed.size}/{diff.files.length} reviewed
          </div>
        )}
        <div className="spacer" />
        {pending > 0 && <div className="pending">{pending} waiting on Claude</div>}
        <button
          className={`btn icon${alerts ? ' on' : ''}`}
          title={alerts ? 'Chime and notify when Claude replies' : 'Notifications off'}
          onClick={() => void toggleAlerts()}
        >
          {alerts ? '🔔' : '🔕'}
        </button>
        <button className="btn" onClick={() => setView(view === 'unified' ? 'split' : 'unified')}>
          {view === 'unified' ? 'Split' : 'Unified'}
        </button>
        <button className="btn" onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}>
          {theme === 'dark' ? 'Light' : 'Dark'}
        </button>
      </header>

      <div className="workspace">
        <FileTree
          files={diff?.files ?? []}
          threadsByFile={threadsByFile}
          viewed={viewed}
          onSelect={scrollToFile}
        />
        <main className="stream">
          {diff?.files.length === 0 && <div className="empty">No changes to review.</div>}
          {diff?.files.map((file) => (
            <FileCard
              key={file.path}
              file={file}
              view={view}
              threads={threadsByFile.get(file.path) ?? []}
              collapsed={collapsed.has(file.path)}
              viewed={viewed.has(file.path)}
              onToggle={() => toggleFile(file.path)}
              onToggleViewed={() => toggleViewed(file)}
              draft={draft && draft.file === file.path ? draft : null}
              onDraft={setDraft}
              onSubmitDraft={submitDraft}
              onThreadsChanged={loadThreads}
            />
          ))}
        </main>
      </div>

      <Toasts
        toasts={toasts}
        onDismiss={(id) => setToasts((current) => current.filter((toast) => toast.id !== id))}
        onOpen={scrollToThread}
      />
    </div>
  );
}
