import path from 'node:path';
import chokidar from 'chokidar';

const IGNORED = [
  /(^|[\\/])\.git([\\/]|$)/,
  /(^|[\\/])\.marj([\\/]|$)/,
  /(^|[\\/])node_modules([\\/]|$)/,
  /(^|[\\/])\.next([\\/]|$)/,
  /(^|[\\/])(dist|build|coverage|target|\.turbo|\.venv|__pycache__)([\\/]|$)/,
];

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

  const watcher = chokidar.watch(repoRoot, {
    ignored: (target: string) => IGNORED.some((re) => re.test(target)),
    ignoreInitial: true,
    persistent: true,
    awaitWriteFinish: { stabilityThreshold: 120, pollInterval: 40 },
  });
  watcher.on('all', trigger);

  const gitWatcher = chokidar.watch(
    [path.join(repoRoot, '.git', 'HEAD'), path.join(repoRoot, '.git', 'index')],
    { ignoreInitial: true, persistent: true },
  );
  gitWatcher.on('all', trigger);

  return () => {
    if (timer) clearTimeout(timer);
    void watcher.close();
    void gitWatcher.close();
  };
}
