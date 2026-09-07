import { promises as fs, watch as fsWatch, type FSWatcher } from 'node:fs';
import path from 'node:path';
import chokidar from 'chokidar';

const IGNORED = [
  /(^|[\\/])\.git([\\/]|$)/,
  /(^|[\\/])\.marj([\\/]|$)/,
  /(^|[\\/])node_modules([\\/]|$)/,
  /(^|[\\/])\.next([\\/]|$)/,
  /(^|[\\/])(dist|build|coverage|target|\.turbo|\.venv|__pycache__)([\\/]|$)/,
];

const isIgnored = (target: string) => IGNORED.some((re) => re.test(target));

/**
 * macOS and Windows can watch a whole tree through ONE handle (FSEvents /
 * ReadDirectoryChangesW). chokidar 4 instead opens a kqueue watch per file and
 * directory, which on a big repo means tens of thousands of open descriptors —
 * and past ~16k of them macOS's posix_spawn fails with EBADF, so the hub could
 * no longer run git at all and every diff went stale. Linux inotify has no such
 * cost, and chokidar honours the ignore list there where a recursive fs.watch
 * would not, so it stays.
 */
const NATIVE_RECURSIVE = process.platform === 'darwin' || process.platform === 'win32';

/** The directory holding HEAD and the index: .git itself, or what a worktree's .git file points at. */
async function gitDirOf(repoRoot: string): Promise<string | null> {
  const dotGit = path.join(repoRoot, '.git');
  try {
    const stat = await fs.stat(dotGit);
    if (stat.isDirectory()) return dotGit;
    const m = (await fs.readFile(dotGit, 'utf8')).match(/^gitdir:\s*(.+)$/m);
    return m ? path.resolve(repoRoot, m[1].trim()) : null;
  } catch {
    return null;
  }
}

/**
 * Recompute the diff shortly after the working tree settles. Also watches
 * .git/HEAD and the index so checkouts and commits refresh the view.
 */
export function startWatcher(repoRoot: string, onChange: () => void, debounceMs = 250): () => void {
  let timer: NodeJS.Timeout | null = null;
  const trigger = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      onChange();
    }, debounceMs);
  };

  const closers: Array<() => void> = [];
  let closed = false;

  const nativeWatch = (dir: string, accept: (file: string | null) => boolean): boolean => {
    let watcher: FSWatcher;
    try {
      watcher = fsWatch(dir, { recursive: NATIVE_RECURSIVE, persistent: true }, (_event, file) => {
        const name = file === null ? null : String(file);
        if (accept(name)) trigger();
      });
    } catch {
      return false;
    }
    watcher.on('error', (err) => console.error(`[marj] watcher on ${dir} failed:`, (err as Error).message));
    closers.push(() => watcher.close());
    return true;
  };

  if (!NATIVE_RECURSIVE || !nativeWatch(repoRoot, (file) => file === null || !isIgnored(file))) {
    const watcher = chokidar.watch(repoRoot, {
      ignored: isIgnored,
      ignoreInitial: true,
      persistent: true,
      awaitWriteFinish: { stabilityThreshold: 120, pollInterval: 40 },
    });
    watcher.on('all', trigger);
    closers.push(() => void watcher.close());
  }

  // HEAD is replaced atomically on checkout, so watch the directory it lives in
  // rather than the file, which would be a stale inode after the first switch.
  void gitDirOf(repoRoot).then((gitDir) => {
    if (!gitDir || closed) return;
    const interesting = new Set(['HEAD', 'index', 'ORIG_HEAD', 'packed-refs']);
    let watcher: FSWatcher;
    try {
      watcher = fsWatch(gitDir, { persistent: true }, (_event, file) => {
        if (file === null || interesting.has(String(file))) trigger();
      });
    } catch {
      return;
    }
    watcher.on('error', () => {});
    closers.push(() => watcher.close());
  });

  return () => {
    closed = true;
    if (timer) clearTimeout(timer);
    for (const close of closers) close();
  };
}
