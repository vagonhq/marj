import { useEffect, useRef, useState } from 'react';
import type { Intent } from '../../shared/types';

interface Props {
  /** small grey line above the textarea, e.g. "Commenting on lines 12–15" */
  header?: string;
  placeholder?: string;
  autoFocus?: boolean;
  /** "Comment" for a new thread, "Reply" inside one */
  submitLabel?: string;
  /** chat-style: plain Enter sends, Shift+Enter is a newline */
  enterToSend?: boolean;
  onSubmit: (body: string, intent: Intent) => Promise<void>;
  onCancel?: () => void;
}

export function Composer({
  header,
  placeholder = 'Leave a comment',
  autoFocus,
  submitLabel = 'Comment',
  enterToSend,
  onSubmit,
  onCancel,
}: Props) {
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (autoFocus) ref.current?.focus();
  }, [autoFocus]);

  const submit = async (intent: Intent) => {
    const body = value.trim();
    if (!body || busy) return;
    setBusy(true);
    try {
      await onSubmit(body, intent);
      setValue('');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="composer">
      <div className="composer-head">
        <span className="composer-tab">Write</span>
        {header && <span className="composer-context">{header}</span>}
      </div>
      <textarea
        ref={ref}
        value={value}
        placeholder={placeholder}
        rows={Math.min(14, Math.max(3, value.split('\n').length + 1))}
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={(event) => {
          if (event.key !== 'Enter' || event.nativeEvent.isComposing) return;
          if (event.metaKey || event.ctrlKey) {
            // ⌘↵ answer · ⌘⇧↵ fix, everywhere
            event.preventDefault();
            void submit(event.shiftKey ? 'fix' : 'ask');
          } else if (enterToSend && !event.shiftKey) {
            // chat: plain Enter sends, Shift+Enter drops a newline
            event.preventDefault();
            void submit('ask');
          }
        }}
      />
      <div className="composer-actions">
        <span className="hint">
          Markdown is supported · <kbd>⌘↵</kbd> answer · <kbd>⌘⇧↵</kbd> fix
        </span>
        {onCancel && (
          <button className="btn" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
        )}
        <button
          className="btn"
          title="Claude answers here without touching the code"
          onClick={() => void submit('ask')}
          disabled={busy || !value.trim()}
        >
          {busy ? 'Sending…' : submitLabel}
        </button>
        <button
          className="btn primary"
          title="Claude changes the code, then answers here"
          onClick={() => void submit('fix')}
          disabled={busy || !value.trim()}
        >
          {submitLabel} &amp; fix
        </button>
      </div>
    </div>
  );
}
