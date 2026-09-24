import { CodeReviewIcon, TriangleDownIcon } from '@primer/octicons-react';
import { useEffect, useRef, useState } from 'react';
import { REVIEW_LEVELS, REVIEW_LEVEL_LABELS, type ReviewLevel } from '../../shared/types';

interface Props {
  /** a review is under way: the chat is waiting on Claude's summary */
  reviewing: boolean;
  /** Claude is busy with something else in the chat, so a review would queue behind it */
  busy: boolean;
  onReview: (level: ReviewLevel) => Promise<void>;
}

function storedLevel(): ReviewLevel {
  try {
    const value = localStorage.getItem('marj:review-level') as ReviewLevel | null;
    return value && REVIEW_LEVELS.includes(value) ? value : 'medium';
  } catch {
    return 'medium';
  }
}

/**
 * "Review": asks the Claude session behind this page to review the whole change
 * at a chosen effort level. Findings arrive as Claude's own comments on the
 * lines, each with an "Apply suggestion" button when it proposes code.
 */
export function ReviewButton({ reviewing, busy, onReview }: Props) {
  const [open, setOpen] = useState(false);
  const [level, setLevel] = useState<ReviewLevel>(storedLevel);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const away = (event: MouseEvent) => {
      if (box.current && !box.current.contains(event.target as Node)) setOpen(false);
    };
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', away);
    document.addEventListener('keydown', key);
    return () => {
      document.removeEventListener('mousedown', away);
      document.removeEventListener('keydown', key);
    };
  }, [open]);

  const start = async (pick: ReviewLevel) => {
    setOpen(false);
    setLevel(pick);
    try {
      localStorage.setItem('marj:review-level', pick);
    } catch {
      /* private mode */
    }
    await onReview(pick);
  };

  return (
    <div className="repo-switch review" ref={box}>
      <button
        className="btn primary review-btn"
        title={reviewing ? 'Claude is reviewing…' : `Ask Claude to review the whole change (${REVIEW_LEVEL_LABELS[level].title.toLowerCase()} effort)`}
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={reviewing}
        onClick={() => setOpen((o) => !o)}
      >
        <CodeReviewIcon size={16} />
        {reviewing ? 'Reviewing…' : 'Review'}
        <TriangleDownIcon size={16} />
      </button>

      {open && (
        <div className="repo-menu review-menu" role="menu">
          <div className="repo-menu-head">Review effort</div>
          {REVIEW_LEVELS.map((pick) => (
            <button
              key={pick}
              role="menuitemradio"
              aria-checked={pick === level}
              className={`repo-menu-item${pick === level ? ' current' : ''}`}
              onClick={() => void start(pick)}
            >
              <span className="repo-menu-check">{pick === level && <span className="dot live" />}</span>
              <span className="repo-menu-main">
                <span className="repo-menu-name">{REVIEW_LEVEL_LABELS[pick].title}</span>
                <span className="repo-menu-sub">{REVIEW_LEVEL_LABELS[pick].hint}</span>
              </span>
            </button>
          ))}
          {busy && <div className="repo-menu-note">Claude is still answering in the chat; the review queues after it.</div>}
          <div className="repo-menu-note">Findings land as Claude's comments on the lines, with an “Apply suggestion” button when it proposes code.</div>
        </div>
      )}
    </div>
  );
}
