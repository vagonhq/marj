import { useState } from 'react';
import type { Intent, Thread } from '../../shared/types';
import { api } from '../api.js';
import { renderMarkdown } from '../markdown.js';
import { Composer } from './Composer.js';

interface Props {
  thread: Thread;
  onChanged: () => void;
}

function timeAgo(iso: string): string {
  const seconds = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.round(seconds / 60)} minutes ago`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)} hours ago`;
  return new Date(iso).toLocaleDateString();
}

export function ThreadCard({ thread, onChanged }: Props) {
  const [replying, setReplying] = useState(false);
  const waiting = thread.status !== 'resolved' && thread.messages.at(-1)?.role === 'user';

  const reply = async (body: string, intent: Intent) => {
    await api.reply(thread.id, body, intent);
    setReplying(false);
    onChanged();
  };

  const setStatus = async (status: string) => {
    await api.patch(thread.id, { status });
    onChanged();
  };

  const remove = async () => {
    if (!window.confirm(`Delete ${thread.id} and its replies?`)) return;
    await api.remove(thread.id);
    onChanged();
  };

  return (
    <div className={`thread ${thread.status}`}>
      <div className="thread-bar">
        <span className="thread-id">{thread.id}</span>
        {thread.status === 'resolved' && <span className="chip">Resolved</span>}
        {thread.status === 'outdated' && <span className="chip">Outdated</span>}
        {thread.agentTyping ? (
          <span className="chip typing">Claude is typing…</span>
        ) : (
          waiting && <span className="chip waiting">Waiting for Claude</span>
        )}
        <span className="spacer" />
        <button
          className="btn tiny"
          onClick={() => void setStatus(thread.status === 'resolved' ? 'open' : 'resolved')}
        >
          {thread.status === 'resolved' ? 'Unresolve' : 'Resolve'}
        </button>
        <button className="btn tiny danger" title="Delete this thread" onClick={() => void remove()}>
          Delete
        </button>
      </div>

      {thread.messages.map((message) => (
        <div key={message.id} className={`comment ${message.role}`}>
          <div className="comment-head">
            <span className="avatar">{message.role === 'agent' ? '✦' : '🧑'}</span>
            <strong>{message.role === 'agent' ? 'Claude' : 'You'}</strong>
            <span className="muted">commented {timeAgo(message.createdAt)}</span>
            {message.intent === 'fix' && (
              <span className="chip fix" title="asked Claude to change the code">
                fix
              </span>
            )}
          </div>
          <div
            className="comment-body"
            dangerouslySetInnerHTML={{ __html: renderMarkdown(message.body) }}
          />
        </div>
      ))}

      <div className="thread-foot">
        {replying ? (
          <Composer
            placeholder="Reply…"
            autoFocus
            submitLabel="Reply"
            onSubmit={reply}
            onCancel={() => setReplying(false)}
          />
        ) : (
          <button className="btn" onClick={() => setReplying(true)}>
            Reply
          </button>
        )}
      </div>
    </div>
  );
}
