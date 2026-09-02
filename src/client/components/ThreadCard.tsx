import { CheckIcon, SparkleFillIcon, TrashIcon } from '@primer/octicons-react';
import { useState } from 'react';
import type { Intent, Message, Thread } from '../../shared/types';
import { api } from '../api.js';
import { renderMarkdown } from '../markdown.js';
import { Composer } from './Composer.js';

interface Props {
  thread: Thread;
  /** git user.name of the reviewer, for the avatar and the "x commented" line */
  author: string;
  onChanged: () => void;
}

function timeAgo(iso: string): string {
  const seconds = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.round(seconds / 60)} minutes ago`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)} hours ago`;
  return new Date(iso).toLocaleDateString();
}

export function Avatar({ role, author, small }: { role: Message['role']; author: string; small?: boolean }) {
  if (role === 'agent') {
    return (
      <span className={`avatar claude${small ? ' small' : ''}`} title="Claude">
        <SparkleFillIcon size={small ? 12 : 14} />
      </span>
    );
  }
  return (
    <span className={`avatar${small ? ' small' : ''}`} title={author}>
      {author.trim().charAt(0).toUpperCase() || '?'}
    </span>
  );
}

export function ThreadCard({ thread, author, onChanged }: Props) {
  const [replying, setReplying] = useState(false);
  const waiting = thread.status !== 'resolved' && thread.messages.at(-1)?.role === 'user';
  const resolved = thread.status === 'resolved';

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
    <div className={`thread ${thread.status}`} id={`thread-${thread.id}`}>
      {thread.messages.map((message) => (
        <div key={message.id} className={`comment ${message.role}`}>
          <Avatar role={message.role} author={author} />
          <div className="comment-box">
            <div className="comment-header">
              <strong>{message.role === 'agent' ? 'Claude' : author}</strong>
              <span className="muted">commented {timeAgo(message.createdAt)}</span>
              {message.intent === 'fix' && (
                <span className="label accent" title="Claude was asked to change the code">
                  fix requested
                </span>
              )}
            </div>
            <div className="comment-body markdown" dangerouslySetInnerHTML={{ __html: renderMarkdown(message.body) }} />
          </div>
        </div>
      ))}

      <div className="thread-footer">
        {replying ? (
          <Composer placeholder="Reply…" autoFocus submitLabel="Reply" onSubmit={reply} onCancel={() => setReplying(false)} />
        ) : (
          <div className="thread-footer-row">
            <Avatar role="user" author={author} small />
            <button className="reply-field" onClick={() => setReplying(true)}>
              Reply…
            </button>
          </div>
        )}
        <div className="thread-status">
          <span className="thread-id" title="thread id, for `marj show`">
            {thread.id}
          </span>
          {thread.agentTyping && <span className="label accent pulse">Claude is typing…</span>}
          {!thread.agentTyping && waiting && <span className="label accent">Waiting for Claude</span>}
          {thread.status === 'outdated' && <span className="label">Outdated</span>}
          {resolved && (
            <span className="label success">
              <CheckIcon size={12} /> Resolved
            </span>
          )}
          <span className="spacer" />
          <button className="btn small" onClick={() => void setStatus(resolved ? 'open' : 'resolved')}>
            {resolved ? 'Unresolve conversation' : 'Resolve conversation'}
          </button>
          <button className="btn small invisible icon-only danger" title="Delete thread" onClick={() => void remove()}>
            <TrashIcon size={14} />
          </button>
        </div>
      </div>
    </div>
  );
}
