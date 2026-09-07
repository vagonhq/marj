import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const home = await fs.mkdtemp(path.join(os.tmpdir(), 'marj-hub-home-'));
process.env.MARJ_HOME = home;
const { startHub } = await import('../src/server/hub.js');

let frontend: string;
let backend: string;
let hub: Awaited<ReturnType<typeof startHub>>;
const port = 46000 + Math.floor(Math.random() * 1000);

function mkRepo(name: string, file: string): string {
  const dir = path.join(home, name);
  execFileSync('git', ['init', '-q', '-b', 'main', dir]);
  const git = (...a: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd: dir });
  execFileSync('sh', ['-c', `printf 'a\\n' > ${file}`], { cwd: dir });
  git('add', '.');
  git('commit', '-q', '-m', 'init');
  execFileSync('sh', ['-c', `printf 'a\\nb\\n' > ${file}`], { cwd: dir }); // an uncommitted change to review
  return dir;
}

const post = (url: string, body: unknown) =>
  fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

beforeAll(async () => {
  // git reports the real path; on macOS the tmpdir is a symlink into /private
  frontend = await fs.realpath(mkRepo('frontend', 'app.tsx'));
  backend = await fs.realpath(mkRepo('backend', 'server.rb'));
  hub = await startHub({ port, exitWhenEmpty: false, ownerCheckMs: 100 });
});

afterAll(async () => {
  await hub.close();
  await fs.rm(home, { recursive: true, force: true });
});

describe('reviews tied to the session that started them', () => {
  it('ends the review once its owner process is gone', async () => {
    const { spawn } = await import('node:child_process');
    const owner = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
    await new Promise((r) => owner.once('spawn', r));

    const reg = (await (await post(`${hub.info.url}/api/repos`, { cwd: backend, positional: [], watch: false, force: true, ownerPid: owner.pid })).json()) as {
      id: string;
      ownerPid?: number;
    };
    expect(reg.ownerPid).toBe(owner.pid);
    const before = (await (await fetch(`${hub.info.url}/api/hub`)).json()) as { repos: string[] };
    expect(before.repos).toContain(reg.id);

    owner.kill('SIGKILL');
    await new Promise((r) => owner.once('exit', r));
    let repos: string[] = [];
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 100));
      repos = ((await (await fetch(`${hub.info.url}/api/hub`)).json()) as { repos: string[] }).repos;
      if (!repos.includes(reg.id)) break;
    }
    expect(repos).not.toContain(reg.id);
  });

  it('a review started by hand has no owner and stays', async () => {
    const reg = (await (await post(`${hub.info.url}/api/repos`, { cwd: backend, positional: [], watch: false, force: true })).json()) as {
      id: string;
      ownerPid?: number;
    };
    expect(reg.ownerPid).toBeUndefined();
    await new Promise((r) => setTimeout(r, 300));
    const status = (await (await fetch(`${hub.info.url}/api/hub`)).json()) as { repos: string[] };
    expect(status.repos).toContain(reg.id);
    await fetch(`${hub.info.url}/api/repos/${encodeURIComponent(reg.id)}`, { method: 'DELETE' });
  });
});

describe('hub health', () => {
  it('/api/hub says whether the process can still run git', async () => {
    const status = (await (await fetch(`${hub.info.url}/api/hub`)).json()) as { healthy: boolean; health: string | null; pid: number };
    expect(status.pid).toBe(process.pid);
    expect(status.healthy).toBe(true);
    expect(status.health).toBeNull();
  });

  it('tells descriptor exhaustion apart from an ordinary failed command', async () => {
    const { isSpawnFailure } = await import('../src/server/hub.js');
    expect(isSpawnFailure(Object.assign(new Error('spawn EBADF'), { code: 'EBADF' }))).toBe(true);
    expect(isSpawnFailure(new Error('spawn EMFILE'))).toBe(true); // wrapped by git(): only the message survives
    expect(isSpawnFailure(new Error('fatal: not a git repository'))).toBe(false);
    expect(isSpawnFailure(Object.assign(new Error('spawn gh ENOENT'), { code: 'ENOENT' }))).toBe(false);
  });

  it('a hub that does not self-heal refuses to be restarted', async () => {
    const res = await fetch(`${hub.info.url}/api/hub/restart`, { method: 'POST' });
    expect(res.status).toBe(409);
  });
});

describe('the hub', () => {
  it('serves several repos on one port, each under /r/<id>', async () => {
    const fe = (await (await post(`${hub.info.url}/api/repos`, { cwd: frontend, positional: [], watch: false })).json()) as {
      id: string;
      url: string;
      repoRoot: string;
      reused: boolean;
    };
    const be = (await (await post(`${hub.info.url}/api/repos`, { cwd: backend, positional: [], watch: false })).json()) as typeof fe;
    expect(fe.reused).toBe(false);
    expect(fe.url.startsWith(`${hub.info.url}/r/`)).toBe(true);
    expect(fe.id).not.toBe(be.id);

    const feDiff = (await (await fetch(`${fe.url}/api/diff`)).json()) as { repoRoot: string; files: { path: string }[] };
    const beDiff = (await (await fetch(`${be.url}/api/diff`)).json()) as typeof feDiff;
    expect(feDiff.repoRoot).toBe(frontend);
    expect(feDiff.files.map((f) => f.path)).toEqual(['app.tsx']);
    expect(beDiff.files.map((f) => f.path)).toEqual(['server.rb']);
  });

  it('reuses an existing review of the same repo, or isolates it with --force', async () => {
    const again = (await (await post(`${hub.info.url}/api/repos`, { cwd: frontend, positional: [], watch: false })).json()) as {
      reused: boolean;
      session?: string;
    };
    expect(again.reused).toBe(true);
    const forced = (await (await post(`${hub.info.url}/api/repos`, { cwd: frontend, positional: [], watch: false, force: true })).json()) as typeof again;
    expect(forced.reused).toBe(false);
    expect(forced.session).toBe('s2');
  });

  it('lists every review for the switcher, marking the one asked from', async () => {
    const list = (await (await fetch(`${hub.info.url}/api/servers`)).json()) as { name: string; session: string | null }[];
    expect(list.map((s) => `${s.name}${s.session ? `@${s.session}` : ''}`).sort()).toEqual([
      'backend',
      'frontend',
      'frontend@s2',
    ]);
    const feId = (await (await fetch(`${hub.info.url}/api/hub`)).json()) as { repos: string[] };
    const id = feId.repos.find((r) => r.startsWith('frontend') && !r.includes('~'))!;
    const fromFe = (await (await fetch(`${hub.info.url}/r/${id}/api/servers`)).json()) as { id: string; current: boolean }[];
    expect(fromFe.find((s) => s.current)?.id).toBe(id);
  });

  it('lists its registrations so an upgrading CLI can replay them', async () => {
    const regs = (await (await fetch(`${hub.info.url}/api/repos`)).json()) as { id: string; cwd: string; positional: string[]; session?: string }[];
    expect(regs.map((r) => r.cwd).sort()).toEqual([backend, frontend, frontend].sort());
    expect(regs.find((r) => r.session === 's2')?.cwd).toBe(frontend);
    for (const r of regs) expect(Array.isArray(r.positional)).toBe(true);
  });

  it('unregisters a repo and 404s its api afterwards', async () => {
    const before = (await (await fetch(`${hub.info.url}/api/hub`)).json()) as { repos: string[] };
    const id = before.repos.find((r) => r.startsWith('backend'))!;
    expect((await fetch(`${hub.info.url}/api/repos/${id}`, { method: 'DELETE' })).status).toBe(204);
    const after = (await (await fetch(`${hub.info.url}/api/hub`)).json()) as { repos: string[] };
    expect(after.repos).not.toContain(id);
    expect((await fetch(`${hub.info.url}/r/${id}/api/diff`)).status).toBe(404);
  });

  it('refuses a directory that is not a repo with a clear error', async () => {
    const res = await post(`${hub.info.url}/api/repos`, { cwd: os.tmpdir(), positional: [] });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/not a git repository/);
  });
});
