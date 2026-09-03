import { useEffect, useRef } from 'react';
import { linkifyLocations, type LocationIndex } from '../locations.js';
import { renderMarkdown } from '../markdown.js';

interface Props {
  body: string;
  /** file paths of the diff, for resolving `path:line` mentions */
  index: LocationIndex;
  /** click handler for a location link; when omitted, mentions are not linked */
  onNavigate?: (file: string, line: number | null) => void;
}

/**
 * A rendered markdown comment whose `path:line` mentions become links that jump
 * the diff. Shared by the review chat and the line threads so both behave the
 * same. The HTML is written imperatively so linkify can walk real text nodes.
 */
export function MarkdownBody({ body, index, onNavigate }: Props) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.innerHTML = renderMarkdown(body);
    if (onNavigate) linkifyLocations(el, index);
  }, [body, index, onNavigate]);

  const onClick = (event: React.MouseEvent) => {
    if (!onNavigate) return;
    const anchor = (event.target as HTMLElement).closest('a.loc') as HTMLAnchorElement | null;
    if (!anchor) return;
    event.preventDefault();
    onNavigate(anchor.dataset.file!, anchor.dataset.line ? Number(anchor.dataset.line) : null);
  };

  return <div ref={ref} className="comment-body markdown" onClick={onClick} />;
}
