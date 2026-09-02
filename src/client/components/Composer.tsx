import { useEffect, useRef, useState } from 'react';

interface Props {
  placeholder: string;
  autoFocus?: boolean;
  submitLabel?: string;
  onSubmit: (body: string) => Promise<void>;
  onCancel?: () => void;
}

export function Composer({ placeholder, autoFocus, submitLabel = 'Comment', onSubmit, onCancel }: Props) {
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (autoFocus) ref.current?.focus();
  }, [autoFocus]);

  const submit = async () => {
    const body = value.trim();
    if (!body || busy) return;
    setBusy(true);
    try {
      await onSubmit(body);
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
            void submit();
          }
        }}
      />
      <div className="composer-actions">
        <span className="hint">⌘↵ to send</span>
        {onCancel && (
          <button className="ghost" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
        )}
        <button className="primary" onClick={() => void submit()} disabled={busy || !value.trim()}>
          {busy ? 'Sending…' : submitLabel}
        </button>
      </div>
    </div>
  );
}
