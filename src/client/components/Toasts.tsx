import { SparkleFillIcon, XIcon } from '@primer/octicons-react';
import { useEffect } from 'react';

export interface Toast {
  id: number;
  title: string;
  body: string;
  threadId: string;
}

interface Props {
  toasts: Toast[];
  onDismiss: (id: number) => void;
  onOpen: (threadId: string) => void;
}

const LIFETIME_MS = 12_000;

export function Toasts({ toasts, onDismiss, onOpen }: Props) {
  useEffect(() => {
    if (toasts.length === 0) return;
    const timers = toasts.map((toast) => window.setTimeout(() => onDismiss(toast.id), LIFETIME_MS));
    return () => timers.forEach(window.clearTimeout);
  }, [toasts, onDismiss]);

  if (toasts.length === 0) return null;

  return (
    <div className="toasts">
      {toasts.map((toast) => (
        <div
          key={toast.id}
          className="toast"
          role="status"
          onClick={() => {
            onOpen(toast.threadId);
            onDismiss(toast.id);
          }}
        >
          <span className="avatar claude small">
            <SparkleFillIcon size={12} />
          </span>
          <div className="toast-text">
            <strong>{toast.title}</strong>
            <span>{toast.body}</span>
          </div>
          <button
            className="btn invisible icon-only"
            aria-label="dismiss"
            onClick={(event) => {
              event.stopPropagation();
              onDismiss(toast.id);
            }}
          >
            <XIcon size={16} />
          </button>
        </div>
      ))}
    </div>
  );
}
