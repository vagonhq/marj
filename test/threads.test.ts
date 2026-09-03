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

  it('carries the reviewer intent onto the message and the agent event', async () => {
    const store = await ThreadStore.load(file);
    const thread = store.createThread({ ...input, intent: 'fix' });
    expect(thread.messages[0].intent).toBe('fix');
    expect(store.queue()[0].intent).toBe('fix');

    store.addMessage(thread.id, 'agent', 'done');
    store.addMessage(thread.id, 'user', 'and here?');
    expect(store.queue()[0].intent).toBe('ask');
    // agent messages never carry an intent
    expect(thread.messages[1].intent).toBeUndefined();
  });

  it('defaults to ask when no intent is given', async () => {
    const store = await ThreadStore.load(file);
    const thread = store.createThread(input);
    expect(thread.messages[0].intent).toBe('ask');
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

describe('deleting threads', () => {
  it('removes the thread and its queued work', async () => {
    const store = await ThreadStore.load(file);
    const thread = store.createThread(input);
    expect(store.queue()).toHaveLength(1);

    expect(store.remove(thread.id)).toBe(true);
    expect(store.list()).toHaveLength(0);
    expect(store.queue()).toHaveLength(0);
    expect(store.since(0)).toHaveLength(0);
  });

  it('reports an unknown id', async () => {
    const store = await ThreadStore.load(file);
    expect(store.remove('t99')).toBe(false);
  });
});

describe('file-level threads', () => {
  it('keep line 0 on the thread and on the agent event', async () => {
    const store = await ThreadStore.load(file);
    const thread = store.createThread({ ...input, startLine: 0, endLine: 0, body: 'this file should be split' });
    expect(thread.startLine).toBe(0);
    expect(thread.endLine).toBe(0);
    expect(store.queue()[0]).toMatchObject({ file: 'app.js', startLine: 0, endLine: 0 });
  });
});

describe('review chat', () => {
  it('is created on the first message and tags its events as chat', async () => {
    const store = await ThreadStore.load(file);
    expect(store.get('chat')).toBeUndefined();
    store.addMessage('chat', 'user', 'what does this change do?');
    const chat = store.get('chat');
    expect(chat?.file).toBe('');
    expect(chat?.messages).toHaveLength(1);
    expect(store.queue()[0]).toMatchObject({ threadId: 'chat', kind: 'chat', intent: 'ask' });

    store.addMessage('chat', 'agent', 'it adds a chat panel');
    expect(store.queue()).toHaveLength(0);
    expect(store.get('chat')?.status).toBe('answered');
  });

  it('never hands out the chat id to a line thread', async () => {
    const store = await ThreadStore.load(file);
    store.addMessage('chat', 'user', 'hi');
    expect(store.createThread(input).id).toBe('t1');
  });
});
