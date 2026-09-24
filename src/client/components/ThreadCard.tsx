import { CheckIcon, LightBulbIcon, SparkleFillIcon, TrashIcon } from '@primer/octicons-react';
import { useState } from 'react';
import { appliedSuggestionOf, applySuggestionPrompt, type Intent, type Message, type Thread } from '../../shared/types';
import type { LocationIndex } from '../locations.js';
import { api } from '../api.js';
import { splitSuggestions } from '../suggestions.js';
import { Composer } from './Composer.js';
import { MarkdownBody } from './MarkdownBody.js';

interface Props {
  thread: Thread;
  /** git user.name of the reviewer, for the avatar and the "x commented" line */
  author: string;
  onChanged: () => void;
  /** file paths of the diff, for linking `path:line` mentions in replies */
  index: LocationIndex;
  /** jump the diff to a file/line when a location link is clicked */
  onNavigate?: (file: string, line: number | null) => void;
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

type SuggestionState = 'ready' | 'applying' | 'applied';

/** What happened to suggestion `block` of message `messageId`: nothing yet, a fix asked for, or Claude done with it. */
function suggestionState(thread: Thread, messageId: string, block: number): SuggestionState {
  const asked = thread.messages.findIndex((m) => {
    if (m.role !== 'user') return false;
    const ref = appliedSuggestionOf(m.body);
    return ref !== null && ref.messageId === messageId && ref.block === block;
  });
  if (asked === -1) return 'ready';
  return thread.messages.slice(asked + 1).some((m) => m.role === 'agent') ? 'applied' : 'applying';
}

/**
 * A ```suggestion block drawn like GitHub draws one: the commented lines going
 * out, the proposed lines coming in, and a button that asks Claude to make it so.
 */
function Suggestion({
  lines,
  thread,
  state,
  disabled,
  onApply,
}: {
  lines: string[];
  thread: Thread;
  state: SuggestionState;
  disabled: boolean;
  onApply: () => void;
}) {
  const removed = thread.anchor.text;
  const from = thread.startLine === thread.endLine ? `line ${thread.startLine}` : `lines ${thread.startLine}–${thread.endLine}`;
  return (
    <div className="suggestion">
      <div className="suggestion-head">
        <LightBulbIcon size={14} />
        <strong>Suggested change</strong>
        {thread.startLine > 0 && <span className="muted">replaces {from}</span>}
      </div>
      <table className="suggestion-diff">
        <tbody>
          {removed.map((text, i) => (
            <tr key={`d${i}`} className="del">
              <td className="sign">−</td>
              <td className="code">{text}</td>
            </tr>
          ))}
          {lines.map((text, i) => (
            <tr key={`a${i}`} className="add">
              <td className="sign">+</td>
              <td className="code">{text}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="suggestion-foot">
        {state === 'applied' ? (
          <span className="label success">
            <CheckIcon size={12} /> Applied
          </span>
        ) : state === 'applying' ? (
          <span className="label accent pulse">Claude is applying it…</span>
        ) : (
          <button className="btn small primary" disabled={disabled} title="Claude replaces these lines with the suggestion" onClick={onApply}>
            Apply suggestion
          </button>
        )}
      </div>
    </div>
  );
}

export function ThreadCard({ thread, author, onChanged, index, onNavigate }: Props) {
  const [replying, setReplying] = useState(false);
  const waiting = thread.status !== 'resolved' && thread.messages.at(-1)?.role === 'user';
  const resolved = thread.status === 'resolved';

  const reply = async (body: string, intent: Intent) => {
    await api.reply(thread.id, body, intent);
    setReplying(false);
    onChanged();
  };

  const applySuggestion = async (messageId: string, block: number) => {
    await api.reply(thread.id, applySuggestionPrompt(messageId, block), 'fix');
    onChanged();
  };

  /** the body as markdown, with every ```suggestion block turned into a widget */
  const renderBody = (message: Message) => {
    if (message.role !== 'agent') return <MarkdownBody body={message.body} index={index} onNavigate={onNavigate} />;
    const segments = splitSuggestions(message.body);
    if (!segments.some((s) => s.kind === 'suggestion')) {
      return <MarkdownBody body={message.body} index={index} onNavigate={onNavigate} />;
    }
    let block = 0;
    return (
      <>
        {segments.map((segment, i) => {
          if (segment.kind === 'markdown') {
            return <MarkdownBody key={i} body={segment.text} index={index} onNavigate={onNavigate} />;
          }
          const n = ++block;
          return (
            <Suggestion
              key={i}
              lines={segment.lines}
              thread={thread}
              state={suggestionState(thread, message.id, n)}
              disabled={waiting || thread.status === 'outdated'}
              onApply={() => void applySuggestion(message.id, n)}
            />
          );
        })}
      </>
    );
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
            {renderBody(message)}
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
