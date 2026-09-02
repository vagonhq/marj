import type { DiffPayload, ServerEvent, Thread } from '../shared/types';

async function json<T>(input: string, init?: RequestInit): Promise<T> {
  const res = await fetch(input, {
    ...init,
    headers: init?.body ? { 'content-type': 'application/json' } : undefined,
  });
  if (!res.ok) throw new Error(`${init?.method ?? 'GET'} ${input} → ${res.status}`);
  return (await res.json()) as T;
}

export const api = {
  diff: () => json<DiffPayload>('/api/diff'),
  threads: () => json<{ cursor: number; threads: Thread[] }>('/api/threads'),
  createThread: (input: {
    file: string;
    side: string;
    startLine: number;
    endLine: number;
    body: string;
  }) => json<Thread>('/api/threads', { method: 'POST', body: JSON.stringify(input) }),
  reply: (id: string, body: string) =>
    json<unknown>(`/api/threads/${id}/messages`, {
      method: 'POST',
      body: JSON.stringify({ role: 'user', body }),
    }),
  patch: (id: string, patch: { status?: string }) =>
    json<Thread>(`/api/threads/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),
  refresh: () => json<{ version: number }>('/api/refresh', { method: 'POST' }),
};

/** SSE with automatic reconnect. */
export function subscribe(onEvent: (event: ServerEvent) => void): () => void {
  let source: EventSource | null = null;
  let stopped = false;
  let retry: number | undefined;

  const connect = () => {
    if (stopped) return;
    source = new EventSource('/api/events');
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
