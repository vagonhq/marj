import { SparkleFillIcon, TrashIcon, XIcon } from '@primer/octicons-react';
import { useEffect, useMemo, useRef } from 'react';
import { CHAT_THREAD, EXPLAIN_PROMPT, type DiffFile, type Intent, type Thread } from '../../shared/types';
import { api } from '../api.js';
import { buildLocationIndex } from '../locations.js';
import { Composer } from './Composer.js';
import { MarkdownBody } from './MarkdownBody.js';
import { Avatar } from './ThreadCard.js';

interface Props {
  chat: Thread | null;
  files: DiffFile[];
  author: string;
  onClose: () => void;
  onChanged: () => void;
  /** jump the diff (and the sidebar) to a file, optionally a line in it */
  onNavigate: (file: string, line: number | null) => void;
}

export function ChatPanel({ chat, files, author, onClose, onChanged, onNavigate }: Props) {
  const messages = chat?.messages ?? [];
  const index = useMemo(() => buildLocationIndex(files.map((f) => f.path)), [files]);
  const waiting = messages.at(-1)?.role === 'user';
  const scroller = useRef<HTMLDivElement>(null);

  // keep the newest message in view as replies arrive
  useEffect(() => {
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages.length, chat?.agentTyping]);

  const send = async (body: string, intent: Intent) => {
    await api.reply(CHAT_THREAD, body, intent);
    onChanged();
  };

  const clear = async () => {
    if (!chat || !window.confirm('Clear the review chat?')) return;
    await api.remove(CHAT_THREAD);
    onChanged();
  };

  return (
    <aside className="chat-panel">
      <div className="chat-head">
        <SparkleFillIcon size={14} className="fg-accent" />
        <strong>Review chat</strong>
        <span className="spacer" />
        {messages.length > 0 && (
          <button className="btn invisible icon-only" title="Clear chat" onClick={() => void clear()}>
            <TrashIcon size={14} />
          </button>
        )}
        <button className="btn invisible icon-only" title="Close" onClick={onClose}>
          <XIcon size={16} />
        </button>
      </div>

      <div className="chat-scroll" ref={scroller}>
        {messages.length === 0 && (
          <div className="chat-empty">
            <p>Ask Claude about the change as a whole. Answers reference code as clickable locations.</p>
          </div>
        )}
        {messages.map((message) => (
          <div key={message.id} className={`comment ${message.role}`}>
            <Avatar role={message.role} author={author} />
            <div className="comment-box">
              <div className="comment-header">
                <strong>{message.role === 'agent' ? 'Claude' : author}</strong>
                {message.intent === 'fix' && (
                  <span className="label accent" title="Claude was asked to change the code">
                    fix requested
                  </span>
                )}
              </div>
              <MarkdownBody body={message.body} index={index} onNavigate={onNavigate} />
            </div>
          </div>
        ))}
        {(chat?.agentTyping || waiting) && (
          <div className="chat-status">
            {chat?.agentTyping ? (
              <span className="label accent pulse">Claude is typing…</span>
            ) : (
              <span className="label accent">Waiting for Claude</span>
            )}
          </div>
        )}
      </div>

      <div className="chat-foot">
        <button
          className="btn explain"
          title="Ask Claude to walk through the whole change, file by file"
          disabled={waiting}
          onClick={() => void send(EXPLAIN_PROMPT, 'ask')}
        >
          <SparkleFillIcon size={14} /> Explain these changes
        </button>
        <Composer placeholder="Ask about the change…" submitLabel="Send" onSubmit={send} />
      </div>
    </aside>
  );
}
