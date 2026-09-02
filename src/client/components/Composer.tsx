import { useEffect, useRef, useState } from 'react';
import type { Intent } from '../../shared/types';

interface Props {
  placeholder: string;
  autoFocus?: boolean;
  /** "Comment" for a new thread, "Reply" inside one */
  submitLabel?: string;
  onSubmit: (body: string, intent: Intent) => Promise<void>;
  onCancel?: () => void;
}

export function Composer({ placeholder, autoFocus, submitLabel = 'Comment', onSubmit, onCancel }: Props) {
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
      <textarea
        ref={ref}
        value={value}
        placeholder={placeholder}
        rows={Math.min(10, Math.max(2, value.split('\n').length))}
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={(event) => {
          if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
            event.preventDefault();
            void submit(event.shiftKey ? 'fix' : 'ask');
          }
        }}
      />
      <div className="composer-actions">
        <span className="hint">⌘↵ answer · ⌘⇧↵ fix</span>
        {onCancel && (
          <button className="ghost" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
        )}
        <button
          className="ghost"
          title="Claude answers here without touching the code"
          onClick={() => void submit('ask')}
          disabled={busy || !value.trim()}
        >
          {busy ? 'Sending…' : submitLabel}
        </button>
        <button
          className="primary"
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
