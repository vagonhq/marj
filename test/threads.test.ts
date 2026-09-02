import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ThreadStore } from '../src/server/threads.js';

let dir: string;
let file: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'marj-test-'));
  file = path.join(dir, 'threads.json');
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

const input = {
  file: 'app.js',
  side: 'new' as const,
  startLine: 4,
  endLine: 4,
  body: 'is this null-safe?',
};

describe('ThreadStore', () => {
  it('assigns increasing sequence numbers and queues user messages', async () => {
    const store = await ThreadStore.load(file);
    const thread = store.createThread(input);
    expect(thread.id).toBe('t1');
    expect(store.cursor).toBe(1);
    expect(store.queue()).toHaveLength(1);

    store.addMessage(thread.id, 'agent', 'yes, fixed');
    expect(store.queue()).toHaveLength(0);
    expect(store.get(thread.id)?.status).toBe('answered');

    store.addMessage(thread.id, 'user', 'and the other call site?');
    expect(store.queue()).toHaveLength(1);
    expect(store.get(thread.id)?.status).toBe('open');
  });

  it('replays only events after the cursor', async () => {
    const store = await ThreadStore.load(file);
    store.createThread(input);
    const afterFirst = store.cursor;
    store.createThread({ ...input, startLine: 9, endLine: 9, body: 'second' });

    expect(store.since(0)).toHaveLength(2);
    expect(store.since(afterFirst)).toHaveLength(1);
    expect(store.since(afterFirst)[0].body).toBe('second');
  });

  it('wakes a waiter as soon as a comment arrives', async () => {
    const store = await ThreadStore.load(file);
    const pending = store.wait(store.cursor, 5000);
    store.createThread(input);
    const result = await pending;
    expect(result.events).toHaveLength(1);
    expect(result.events[0].kind).toBe('new-thread');
    expect(result.cursor).toBe(1);
  });

  it('returns immediately when the cursor is already behind', async () => {
    const store = await ThreadStore.load(file);
    store.createThread(input);
    const result = await store.wait(0, 5000);
    expect(result.events).toHaveLength(1);
  });

  it('times out with no events', async () => {
    const store = await ThreadStore.load(file);
    const result = await store.wait(store.cursor, 20);
    expect(result.events).toEqual([]);
  });

  it('agent replies do not enqueue work for the agent', async () => {
    const store = await ThreadStore.load(file);
    const thread = store.createThread({ ...input, role: 'agent', body: 'nit: rename this' });
    expect(store.queue()).toHaveLength(0);
    expect(thread.messages[0].role).toBe('agent');
  });

  it('survives a reload', async () => {
    const store = await ThreadStore.load(file);
    const thread = store.createThread(input);
    store.addMessage(thread.id, 'agent', 'done');
    await store.save();

    const reloaded = await ThreadStore.load(file);
    expect(reloaded.list()).toHaveLength(1);
    expect(reloaded.cursor).toBe(2);
    expect(reloaded.get('t1')?.messages).toHaveLength(2);
    // ids keep counting up rather than colliding with the restored thread
    expect(reloaded.createThread(input).id).toBe('t2');
  });

  it('resolved threads drop out of the queue', async () => {
    const store = await ThreadStore.load(file);
    const thread = store.createThread(input);
    store.patch(thread.id, { status: 'resolved' });
    expect(store.queue()).toHaveLength(0);
  });
});
