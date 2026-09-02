import { promises as fs } from 'node:fs';
import path from 'node:path';
import type {
  AgentEvent,
  Anchor,
  Message,
  Role,
  Side,
  Thread,
  ThreadStatus,
  WaitResponse,
} from '../shared/types.js';

interface Persisted {
  version: 1;
  seq: number;
  nextThreadId: number;
  threads: Thread[];
  events: AgentEvent[];
}

interface Waiter {
  cursor: number;
  resolve: (value: WaitResponse) => void;
  timer: NodeJS.Timeout;
}

export interface CreateThreadInput {
  file: string;
  side: Side;
  startLine: number;
  endLine: number;
  body: string;
  anchor?: Anchor;
  role?: Role;
}

/**
 * Review threads plus the agent inbox.
 *
 * Every user message appends an AgentEvent with a globally increasing seq, so
 * `marj watch` can long-poll with a cursor and never miss or reorder a comment.
 */
export class ThreadStore {
  private threads = new Map<string, Thread>();
  private events: AgentEvent[] = [];
  private seq = 0;
  private nextThreadId = 1;
  private waiters: Waiter[] = [];
  private listeners = new Set<() => void>();
  private saveTimer: NodeJS.Timeout | null = null;
  private saving: Promise<void> = Promise.resolve();

  constructor(private readonly file: string) {}

  static async load(file: string): Promise<ThreadStore> {
    const store = new ThreadStore(file);
    try {
      const raw = await fs.readFile(file, 'utf8');
      const data = JSON.parse(raw) as Persisted;
      for (const thread of data.threads ?? []) store.threads.set(thread.id, thread);
      store.events = data.events ?? [];
      store.seq = data.seq ?? 0;
      store.nextThreadId = data.nextThreadId ?? store.threads.size + 1;
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
    return store;
  }

  get cursor(): number {
    return this.seq;
  }

  list(): Thread[] {
    return [...this.threads.values()];
  }

  get(id: string): Thread | undefined {
    return this.threads.get(id);
  }

  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  createThread(input: CreateThreadInput): Thread {
    const now = new Date().toISOString();
    const id = `t${this.nextThreadId++}`;
    const thread: Thread = {
      id,
      file: input.file,
      side: input.side,
      startLine: input.startLine,
      endLine: input.endLine,
      anchor: input.anchor ?? { text: [], before: [], after: [] },
      status: 'open',
      agentTyping: false,
      createdAt: now,
      updatedAt: now,
      messages: [],
      anchoredVersion: 0,
    };
    this.threads.set(id, thread);
    this.appendMessage(thread, input.role ?? 'user', input.body, 'new-thread');
    return thread;
  }

  addMessage(threadId: string, role: Role, body: string): Message {
    const thread = this.threads.get(threadId);
    if (!thread) throw new Error(`no such thread: ${threadId}`);
    return this.appendMessage(thread, role, body, 'reply');
  }

  private appendMessage(
    thread: Thread,
    role: Role,
    body: string,
    kind: 'new-thread' | 'reply',
  ): Message {
    const seq = ++this.seq;
    const message: Message = {
      id: `${thread.id}m${thread.messages.length + 1}`,
      role,
      body,
      createdAt: new Date().toISOString(),
      seq,
    };
    thread.messages.push(message);
    thread.updatedAt = message.createdAt;

    if (role === 'user') {
      thread.status = 'open';
      this.events.push({
        seq,
        threadId: thread.id,
        messageId: message.id,
        kind,
        file: thread.file,
        side: thread.side,
        startLine: thread.startLine,
        endLine: thread.endLine,
        body,
        status: thread.status,
        createdAt: message.createdAt,
      });
    } else {
      thread.agentTyping = false;
      if (thread.status === 'open') thread.status = 'answered';
    }

    this.changed();
    return message;
  }

  patch(threadId: string, patch: { status?: ThreadStatus; agentTyping?: boolean }): Thread {
    const thread = this.threads.get(threadId);
    if (!thread) throw new Error(`no such thread: ${threadId}`);
    if (patch.status !== undefined) thread.status = patch.status;
    if (patch.agentTyping !== undefined) thread.agentTyping = patch.agentTyping;
    thread.updatedAt = new Date().toISOString();
    this.changed();
    return thread;
  }

  /** Replace anchoring info after the diff was recomputed. */
  reanchor(threadId: string, update: Partial<Pick<Thread, 'startLine' | 'endLine' | 'status' | 'anchoredVersion'>>): void {
    const thread = this.threads.get(threadId);
    if (!thread) return;
    Object.assign(thread, update);
    this.changed();
  }

  /** Events newer than `cursor`, oldest first. */
  since(cursor: number): AgentEvent[] {
    return this.events.filter((e) => e.seq > cursor);
  }

  /** User messages that have no agent reply after them, oldest first. */
  queue(): AgentEvent[] {
    return this.events.filter((event) => {
      const thread = this.threads.get(event.threadId);
      if (!thread || thread.status === 'resolved') return false;
      return !thread.messages.some((m) => m.role === 'agent' && m.seq > event.seq);
    });
  }

  /** Long-poll: resolve as soon as there is anything after `cursor`. */
  wait(cursor: number, timeoutMs: number): Promise<WaitResponse> {
    const ready = this.since(cursor);
    if (ready.length > 0) return Promise.resolve({ cursor: this.seq, events: ready });

    return new Promise<WaitResponse>((resolve) => {
      const waiter: Waiter = {
        cursor,
        resolve,
        timer: setTimeout(() => {
          this.waiters = this.waiters.filter((w) => w !== waiter);
          resolve({ cursor: this.seq, events: [] });
        }, timeoutMs),
      };
      this.waiters.push(waiter);
    });
  }

  private changed(): void {
    const waiters = this.waiters;
    this.waiters = [];
    for (const waiter of waiters) {
      clearTimeout(waiter.timer);
      waiter.resolve({ cursor: this.seq, events: this.since(waiter.cursor) });
    }
    for (const listener of this.listeners) listener();
    this.scheduleSave();
  }

  private scheduleSave(): void {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      void this.save();
    }, 100);
  }

  async save(): Promise<void> {
    const data: Persisted = {
      version: 1,
      seq: this.seq,
      nextThreadId: this.nextThreadId,
      threads: this.list(),
      events: this.events,
    };
    const body = JSON.stringify(data, null, 2);
    this.saving = this.saving.then(async () => {
      await fs.mkdir(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.${process.pid}.tmp`;
      await fs.writeFile(tmp, body, 'utf8');
      await fs.rename(tmp, this.file);
    });
    return this.saving;
  }

  /** Resolve every pending waiter, used on shutdown. */
  close(): void {
    for (const waiter of this.waiters) {
      clearTimeout(waiter.timer);
      waiter.resolve({ cursor: this.seq, events: [] });
    }
    this.waiters = [];
  }
}
