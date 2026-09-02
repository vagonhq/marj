import { promises as fs } from 'node:fs';
import path from 'node:path';
import { repoRootOf } from '../server/git.js';
import { MARJ_DIR } from '../server/index.js';
import type { AgentEvent, ServerInfo, Thread, WaitResponse } from '../shared/types.js';

export class NoServerError extends Error {}

export async function findServer(cwd: string, portOverride?: number): Promise<ServerInfo> {
  if (portOverride) {
    return {
      port: portOverride,
      url: `http://127.0.0.1:${portOverride}`,
      pid: 0,
      repoRoot: cwd,
      cwd,
      mode: 'unknown',
      startedAt: '',
    };
  }
  let repoRoot: string;
  try {
    repoRoot = await repoRootOf(cwd);
  } catch {
    throw new NoServerError('not inside a git repository');
  }
  const infoPath = path.join(repoRoot, MARJ_DIR, 'server.json');
  try {
    const info = JSON.parse(await fs.readFile(infoPath, 'utf8')) as ServerInfo;
    return info;
  } catch {
    throw new NoServerError(`no marj server running for ${repoRoot} (start one with \`marj\`)`);
  }
}

export class MarjClient {
  constructor(private readonly baseUrl: string) {}

  private async request<T>(method: string, route: string, body?: unknown): Promise<T> {
    const res = await fetch(`${this.baseUrl}${route}`, {
      method,
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`${method} ${route} → ${res.status} ${detail.slice(0, 200)}`);
    }
    return (await res.json()) as T;
  }

  threads(): Promise<{ cursor: number; threads: Thread[] }> {
    return this.request('GET', '/api/threads');
  }

  thread(id: string): Promise<{
    thread: Thread;
    context: { file: string; lines: { no: number; text: string; type: string; commented: boolean }[] };
  }> {
    return this.request('GET', `/api/threads/${encodeURIComponent(id)}`);
  }

  queue(): Promise<{ cursor: number; events: AgentEvent[] }> {
    return this.request('GET', '/api/agent/queue');
  }

  wait(cursor: number, timeoutSeconds: number): Promise<WaitResponse> {
    return this.request('GET', `/api/agent/wait?cursor=${cursor}&timeout=${timeoutSeconds}`);
  }

  reply(id: string, body: string): Promise<unknown> {
    return this.request('POST', `/api/threads/${encodeURIComponent(id)}/messages`, { role: 'agent', body });
  }

  comment(input: { file: string; side: string; startLine: number; endLine: number; body: string }): Promise<Thread> {
    return this.request('POST', '/api/threads', { ...input, role: 'agent' });
  }

  patch(id: string, patch: { status?: string; agentTyping?: boolean }): Promise<Thread> {
    return this.request('PATCH', `/api/threads/${encodeURIComponent(id)}`, patch);
  }
}
