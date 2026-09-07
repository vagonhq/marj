import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startWatcher } from '../src/server/watch.js';

let repo: string;
let stop: () => void = () => {};

beforeEach(async () => {
  repo = await fs.mkdtemp(path.join(os.tmpdir(), 'marj-watch-'));
  await fs.mkdir(path.join(repo, '.git'));
  await fs.mkdir(path.join(repo, 'node_modules', 'dep'), { recursive: true });
  await fs.mkdir(path.join(repo, 'src'));
});

afterEach(async () => {
  stop();
  await fs.rm(repo, { recursive: true, force: true });
});

/** resolves once the watcher fires, or with 'silent' after `ms` */
const fired = (register: (cb: () => void) => void, ms: number) =>
  new Promise<'fired' | 'silent'>((resolve) => {
    const t = setTimeout(() => resolve('silent'), ms);
    register(() => {
      clearTimeout(t);
      resolve('fired');
    });
  });

describe('the working tree watcher', () => {
  it('fires once the tree settles after an edit', async () => {
    let hit = () => {};
    stop = startWatcher(repo, () => hit(), 50);
    await new Promise((r) => setTimeout(r, 200)); // let the watch attach
    const seen = fired((cb) => (hit = cb), 3000);
    await fs.writeFile(path.join(repo, 'src', 'a.ts'), 'a\n');
    expect(await seen).toBe('fired');
  });

  it('a checkout — .git/HEAD rewritten — refreshes too', async () => {
    let hit = () => {};
    stop = startWatcher(repo, () => hit(), 50);
    await new Promise((r) => setTimeout(r, 200));
    const seen = fired((cb) => (hit = cb), 3000);
    await fs.writeFile(path.join(repo, '.git', 'HEAD'), 'ref: refs/heads/other\n');
    expect(await seen).toBe('fired');
  });

  it('ignores node_modules', async () => {
    let hit = () => {};
    stop = startWatcher(repo, () => hit(), 50);
    await new Promise((r) => setTimeout(r, 200));
    const seen = fired((cb) => (hit = cb), 700);
    await fs.writeFile(path.join(repo, 'node_modules', 'dep', 'index.js'), 'x\n');
    expect(await seen).toBe('silent');
  });
});
