import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { DiffPayload, Thread } from '../shared/types';
import { api, subscribe } from './api.js';
import { FileCard } from './components/FileCard.js';
import { FileList } from './components/FileList.js';
import type { DraftTarget } from './components/types.js';

type ViewMode = 'unified' | 'split';
type Theme = 'dark' | 'light';

function stored<T extends string>(key: string, fallback: T): T {
  try {
    return (localStorage.getItem(key) as T | null) ?? fallback;
  } catch {
    return fallback;
  }
}

export function App() {
  const [diff, setDiff] = useState<DiffPayload | null>(null);
  const [threads, setThreads] = useState<Thread[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<ViewMode>(() => stored<ViewMode>('marj:view', 'unified'));
  const [theme, setTheme] = useState<Theme>(() =>
    stored<Theme>('marj:theme', window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'),
  );
  const [draft, setDraft] = useState<DraftTarget | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [pulse, setPulse] = useState(false);
  const pulseTimer = useRef<number>();
  const collapsedInitialised = useRef(false);

  const loadDiff = useCallback(async () => {
    try {
      const payload = await api.diff();
      setDiff(payload);
      // generated files (lockfiles, dist output) start folded, once
      if (!collapsedInitialised.current) {
        collapsedInitialised.current = true;
        setCollapsed(new Set(payload.files.filter((f) => f.generated).map((f) => f.path)));
      }
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);

  const loadThreads = useCallback(async () => {
    try {
      setThreads((await api.threads()).threads);
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);

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

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try {
      localStorage.setItem('marj:theme', theme);
    } catch {
      /* private mode */
    }
  }, [theme]);

  useEffect(() => {
    try {
      localStorage.setItem('marj:view', view);
    } catch {
      /* private mode */
    }
  }, [view]);

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
    async (body: string) => {
      if (!draft) return;
      await api.createThread({
        file: draft.file,
        side: draft.side,
        startLine: draft.startLine,
        endLine: draft.endLine,
        body,
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
        <div className="mode" title={diff?.repoRoot}>
          {diff?.mode ?? 'loading…'}
        </div>
        <div className="totals">
          <span className="add">+{totals.add}</span>
          <span className="del">-{totals.del}</span>
          <span className="files">{diff?.files.length ?? 0} files</span>
        </div>
        <div className="spacer" />
        {pending > 0 && <div className="pending">{pending} waiting on Claude</div>}
        <button className="ghost" onClick={() => setView(view === 'unified' ? 'split' : 'unified')}>
          {view === 'unified' ? 'Split' : 'Unified'}
        </button>
        <button className="ghost" onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}>
          {theme === 'dark' ? 'Light' : 'Dark'}
        </button>
      </header>

      <div className="workspace">
        <FileList
          files={diff?.files ?? []}
          threadsByFile={threadsByFile}
          collapsed={collapsed}
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
              onToggle={() => toggleFile(file.path)}
              draft={draft && draft.file === file.path ? draft : null}
              onDraft={setDraft}
              onSubmitDraft={submitDraft}
              onThreadsChanged={loadThreads}
            />
          ))}
        </main>
      </div>
    </div>
  );
}
