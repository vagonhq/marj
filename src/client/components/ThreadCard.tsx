import { useState } from 'react';
import type { Thread } from '../../shared/types';
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
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)}h ago`;
  return new Date(iso).toLocaleDateString();
}

export function ThreadCard({ thread, onChanged }: Props) {
  const [replying, setReplying] = useState(false);
  const waiting = thread.status !== 'resolved' && thread.messages.at(-1)?.role === 'user';

  const reply = async (body: string) => {
    await api.reply(thread.id, body);
    setReplying(false);
    onChanged();
  };

  const setStatus = async (status: string) => {
    await api.patch(thread.id, { status });
    onChanged();
  };

  return (
    <div className={`thread ${thread.status}`}>
      <div className="thread-head">
        <span className="thread-id">{thread.id}</span>
        <span className={`chip ${thread.status}`}>{thread.status}</span>
        {waiting && !thread.agentTyping && <span className="chip waiting">waiting for Claude</span>}
        {thread.agentTyping && <span className="chip typing">Claude is typing…</span>}
        <span className="spacer" />
        {thread.status !== 'resolved' ? (
          <button className="ghost small" onClick={() => void setStatus('resolved')}>
            Resolve
          </button>
        ) : (
          <button className="ghost small" onClick={() => void setStatus('open')}>
            Reopen
          </button>
        )}
      </div>

      {thread.messages.map((message) => (
        <div key={message.id} className={`message ${message.role}`}>
          <div className="avatar">{message.role === 'agent' ? '✦' : '🧑'}</div>
          <div className="bubble">
            <div className="meta">
              <strong>{message.role === 'agent' ? 'Claude' : 'You'}</strong>
              <span>{timeAgo(message.createdAt)}</span>
            </div>
            <div className="body" dangerouslySetInnerHTML={{ __html: renderMarkdown(message.body) }} />
          </div>
        </div>
      ))}

      {replying ? (
        <Composer
          placeholder="Reply…"
          autoFocus
          submitLabel="Reply"
          onSubmit={reply}
          onCancel={() => setReplying(false)}
        />
      ) : (
        <button className="ghost small reply-open" onClick={() => setReplying(true)}>
          Reply
        </button>
      )}
    </div>
  );
}
