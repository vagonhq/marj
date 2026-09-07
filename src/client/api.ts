import type { DiffPayload, Intent, PrListing, ServerEvent, ServerListing, ServerInfo, Thread, WorktreeState } from '../shared/types';

/** The hub serves each review under /r/<id>; every call stays inside that prefix. */
export const BASE = (window.location.pathname.match(/^\/r\/[^/]+/) ?? [''])[0];

async function json<T>(input: string, init?: RequestInit, prefix = BASE): Promise<T> {
  const res = await fetch(`${prefix}${input}`, {
    ...init,
    headers: init?.body ? { 'content-type': 'application/json' } : undefined,
  });
  if (!res.ok) {
    // the server explains a bad target or a missing `gh` in the body; show that, not the status
    const detail = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(detail?.error ?? `${init?.method ?? 'GET'} ${input} → ${res.status}`);
  }
  return (await res.json()) as T;
}

export const api = {
  diff: () => json<DiffPayload>('/api/diff'),
  threads: () => json<{ cursor: number; threads: Thread[] }>('/api/threads'),
  /** one side of a file in full, for expanding context around hunks */
  file: (path: string, side: 'old' | 'new' = 'new') =>
    json<{ path: string; side: string; lines: string[] }>(`/api/file?path=${encodeURIComponent(path)}&side=${side}`),
  createThread: (input: {
    file: string;
    side: string;
    startLine: number;
    endLine: number;
    body: string;
    intent: Intent;
  }) => json<Thread>('/api/threads', { method: 'POST', body: JSON.stringify(input) }),
  reply: (id: string, body: string, intent: Intent) =>
    json<unknown>(`/api/threads/${id}/messages`, {
      method: 'POST',
      body: JSON.stringify({ role: 'user', body, intent }),
    }),
  remove: (id: string) =>
    fetch(`${BASE}/api/threads/${id}`, { method: 'DELETE' }).then((res) => {
      if (!res.ok) throw new Error(`DELETE /api/threads/${id} → ${res.status}`);
    }),
  patch: (id: string, patch: { status?: string }) =>
    json<Thread>(`/api/threads/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),
  refresh: () => json<{ version: number }>('/api/refresh', { method: 'POST' }),
  worktree: () => json<WorktreeState>('/api/worktree'),
  servers: () => json<ServerListing[]>('/api/servers'),
  about: () => json<{ version: string; id: string; repoRoot: string; session: string | null }>('/api/about'),
  commit: (input: { message: string; paths?: string[]; push?: boolean }) =>
    json<{ sha: string; branch: string | null; pushed: boolean; pushError?: string }>('/api/commit', {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  checkout: () => json<{ branch: string; mode: string }>('/api/checkout', { method: 'POST' }),
  /** this repo's pull requests matching what was typed in the picker */
  prs: (query: string) => json<PrListing[]>(`/api/prs?q=${encodeURIComponent(query)}`),
  /**
   * Review a pull request: the hub registers it as its own session of this repo,
   * so the current review keeps its threads. Lives on the hub itself, not under
   * /r/<id>, hence the empty prefix.
   */
  openPr: (cwd: string, number: number) =>
    json<ServerInfo & { id: string; reused: boolean }>(
      '/api/repos',
      { method: 'POST', body: JSON.stringify({ cwd, positional: [`#${number}`], force: true }) },
      '',
    ),
};

/** SSE with automatic reconnect. */
export function subscribe(onEvent: (event: ServerEvent) => void): () => void {
  let source: EventSource | null = null;
  let stopped = false;
  let retry: number | undefined;

  const connect = () => {
    if (stopped) return;
    source = new EventSource(`${BASE}/api/events`);
    source.onmessage = (message) => onEvent(JSON.parse(message.data) as ServerEvent);
    source.onerror = () => {
      source?.close();
      source = null;
      retry = window.setTimeout(connect, 1500);
    };
  };
  connect();

  return () => {
    stopped = true;
    window.clearTimeout(retry);
    source?.close();
  };
}
