import {
  CheckIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  CommentDiscussionIcon,
  CommentIcon,
  CopyIcon,
  FoldDownIcon,
  FoldUpIcon,
  UnfoldIcon,
} from '@primer/octicons-react';
import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api.js';
import { addRange, expandFile, gapsOf, STEP, type Gap, type Range } from '../expand.js';
import { flashElement, lineRow } from '../flash.js';
import type { LocationIndex } from '../locations.js';
import {
  FILE_LEVEL,
  isFileLevel,
  type DiffFile,
  type DiffHunk,
  type DiffLine,
  type Intent,
  type Side,
  type Thread,
} from '../../shared/types';
import { highlightFile, languageOf, lineKey, type TokenLine } from '../highlight.js';
import { Composer } from './Composer.js';
import { ThreadCard } from './ThreadCard.js';
import type { DraftTarget } from './types.js';

interface Props {
  file: DiffFile;
  view: 'unified' | 'split';
  threads: Thread[];
  author: string;
  collapsed: boolean;
  viewed: boolean;
  onToggle: () => void;
  onToggleViewed: () => void;
  draft: DraftTarget | null;
  onDraft: (draft: DraftTarget | null) => void;
  onSubmitDraft: (body: string, intent: Intent) => Promise<void>;
  onThreadsChanged: () => void;
  /** a line a chat link wants shown: expand around it if needed, then flash it */
  reveal?: { line: number; nonce: number } | null;
  /** file paths of the diff, for linking `path:line` mentions in replies */
  locationIndex: LocationIndex;
  /** jump the diff to a file/line when a reply's location link is clicked */
  onNavigate?: (file: string, line: number | null) => void;
}

/**
 * One selectable row of the rendered diff. Selection works on row order rather
 * than line numbers so a drag can cross deletions and additions the way it does
 * on GitHub; the numbers that end up on the thread are the ones belonging to the
 * side the drag started on.
 */
interface Row {
  index: number;
  hunkIndex: number;
  line?: DiffLine;
  left?: DiffLine | null;
  right?: DiffLine | null;
  oldNo: number | null;
  newNo: number | null;
}

function splitPairs(hunk: DiffHunk): { left: DiffLine | null; right: DiffLine | null }[] {
  const rows: { left: DiffLine | null; right: DiffLine | null }[] = [];
  let dels: DiffLine[] = [];
  let adds: DiffLine[] = [];
  const flush = () => {
    for (let i = 0; i < Math.max(dels.length, adds.length); i++) {
      rows.push({ left: dels[i] ?? null, right: adds[i] ?? null });
    }
    dels = [];
    adds = [];
  };
  for (const line of hunk.lines) {
    if (line.type === 'del') dels.push(line);
    else if (line.type === 'add') adds.push(line);
    else {
      flush();
      rows.push({ left: line, right: line });
    }
  }
  flush();
  return rows;
}

function buildRows(file: DiffFile, view: 'unified' | 'split'): Row[] {
  const rows: Row[] = [];
  file.hunks.forEach((hunk, hunkIndex) => {
    if (view === 'unified') {
      for (const line of hunk.lines) {
        rows.push({ index: rows.length, hunkIndex, line, oldNo: line.oldNo, newNo: line.newNo });
      }
    } else {
      for (const pair of splitPairs(hunk)) {
        rows.push({
          index: rows.length,
          hunkIndex,
          left: pair.left,
          right: pair.right,
          oldNo: pair.left && pair.left.type !== 'add' ? pair.left.oldNo : null,
          newNo: pair.right && pair.right.type !== 'del' ? pair.right.newNo : null,
        });
      }
    }
  });
  return rows;
}

const numberOn = (row: Row, side: Side) => (side === 'old' ? row.oldNo : row.newNo);

export function FileCard(props: Props) {
  const {
    file,
    view,
    threads,
    author,
    collapsed,
    viewed,
    onToggle,
    onToggleViewed,
    draft,
    onDraft,
    onSubmitDraft,
    onThreadsChanged,
    reveal,
    locationIndex,
    onNavigate,
  } = props;

  const language = useMemo(() => languageOf(file.path), [file.path]);

  // ---- expanding context around hunks ----
  // `full` is the whole new-side file once fetched; `ranges` are the lines the
  // reviewer asked for. The diff shown is the original plus those lines.
  const [full, setFull] = useState<string[] | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const [ranges, setRanges] = useState<Range[]>([]);
  const fetching = useRef<Promise<void> | null>(null);
  /** threads whose hidden lines were already pulled into view */
  const revealed = useRef(new Set<string>());

  // the file was rewritten: line numbers moved, so start over
  const signature = `${file.additions}:${file.deletions}:${file.hunks.length}`;
  useEffect(() => {
    setFull(null);
    setRanges([]);
    setUnavailable(false);
    fetching.current = null;
    revealed.current.clear();
  }, [signature, file.path]);

  const canExpand = !file.binary && file.status !== 'deleted' && !unavailable;

  const expand = (range: Range) => {
    if (!canExpand) return;
    setRanges((current) => addRange(current, range));
    if (!full && !fetching.current) {
      fetching.current = api
        .file(file.path)
        .then(({ lines }) => setFull(lines))
        .catch(() => setUnavailable(true));
    }
  };

  const shown = useMemo(() => expandFile(file, full, ranges), [file, full, ranges]);
  const gaps = useMemo(() => (canExpand ? gapsOf(shown, full ? full.length : null) : []), [shown, full, canExpand]);
  const rows = useMemo(() => buildRows(shown, view), [shown, view]);
  const hasNewLine = (no: number) => shown.hunks.some((h) => h.lines.some((l) => l.newNo === no));

  // threads on lines outside the hunks (left on expanded context) get their lines back
  useEffect(() => {
    for (const thread of threads) {
      if (thread.status === 'outdated' || thread.side !== 'new' || thread.startLine === 0) continue;
      if (hasNewLine(thread.endLine) || revealed.current.has(thread.id)) continue;
      revealed.current.add(thread.id);
      expand([thread.startLine - 3, thread.endLine + 3]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [threads, shown]);

  const revealTried = useRef(-1);
  useEffect(() => {
    if (!reveal) return;
    const row = lineRow(file.path, reveal.line);
    if (row) {
      flashElement(row, 'center');
      return;
    }
    if (revealTried.current === reveal.nonce) return;
    revealTried.current = reveal.nonce;
    expand([reveal.line - 5, reveal.line + 5]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reveal, shown]);

  // syntax colours arrive asynchronously; plain text is shown until then
  const [tokens, setTokens] = useState<Map<string, TokenLine> | null>(null);
  useEffect(() => {
    if (!language || collapsed || file.binary) return;
    let alive = true;
    highlightFile(shown, language)
      .then((result) => alive && setTokens(result))
      .catch(() => alive && setTokens(null));
    return () => {
      alive = false;
    };
  }, [shown, language, collapsed]);

  const [span, setSpan] = useState<{ side: Side; from: number; to: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  const [copied, setCopied] = useState(false);

  const mine = draft && draft.file === file.path ? draft : null;
  const fileDraft = !!mine && isFileLevel(mine);

  useEffect(() => {
    if (!mine || fileDraft) setSpan(null);
  }, [mine, fileDraft]);

  /** comment on the file as a whole; the composer sits above the diff, so unfold a collapsed card */
  const draftOnFile = () => {
    if (collapsed) onToggle();
    onDraft({ file: file.path, side: 'new', startLine: FILE_LEVEL, endLine: FILE_LEVEL });
  };

  /** turn a row span into the line range the thread will carry */
  const publish = (side: Side, from: number, to: number) => {
    const lo = Math.min(from, to);
    const hi = Math.max(from, to);
    const numbers = rows
      .slice(lo, hi + 1)
      .map((row) => numberOn(row, side))
      .filter((no): no is number => no !== null);
    if (numbers.length === 0) return;
    onDraft({ file: file.path, side, startLine: Math.min(...numbers), endLine: Math.max(...numbers) });
  };

  // the composer only appears once the drag ends: opening it mid-drag would
  // push the rows out from under the cursor
  const spanRef = useRef(span);
  spanRef.current = span;
  useEffect(() => {
    if (!dragging) return;
    const stop = () => {
      setDragging(false);
      const current = spanRef.current;
      if (current) publish(current.side, current.from, current.to);
    };
    window.addEventListener('mouseup', stop);
    window.addEventListener('blur', stop);
    return () => {
      window.removeEventListener('mouseup', stop);
      window.removeEventListener('blur', stop);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dragging]);

  const startSelect = (event: React.MouseEvent, side: Side, index: number) => {
    if (event.button !== 0) return;
    event.preventDefault();
    if (event.shiftKey && span && span.side === side) {
      setSpan({ ...span, to: index });
      publish(side, span.from, index);
      return;
    }
    setSpan({ side, from: index, to: index });
    setDragging(true);
  };

  /** the side comes from where the drag started, not from the row under the cursor */
  const extendSelect = (index: number, expect?: Side) => {
    if (!dragging || !span) return;
    if (expect && span.side !== expect) return;
    if (span.to === index) return;
    setSpan({ ...span, to: index });
  };

  const selectedRow = (index: number) =>
    !!span && (dragging || !!mine) && index >= Math.min(span.from, span.to) && index <= Math.max(span.from, span.to);

  const composerRow = span && !dragging ? Math.max(span.from, span.to) : -1;

  // file-level threads have endLine 0, which no diff row carries, so they never land in a row overlay
  const threadsAt = (side: Side, no: number) =>
    threads.filter((t) => t.status !== 'outdated' && t.side === side && t.endLine === no);
  const fileThreads = threads.filter((t) => t.status !== 'outdated' && isFileLevel(t));

  const gutterButton = (side: Side, no: number, index: number) => (
    <button
      className="add-comment"
      title="Comment — drag down the gutter or shift-click to select more lines"
      aria-label={`Comment on line ${no}`}
      onMouseDown={(event) => startSelect(event, side, index)}
    >
      +
    </button>
  );

  const overlay = (row: Row, colSpan: number) => {
    const items = [
      ...(row.oldNo !== null ? threadsAt('old', row.oldNo) : []),
      ...(row.newNo !== null ? threadsAt('new', row.newNo) : []),
    ];
    const showDraft = !!mine && !fileDraft && composerRow === row.index;
    if (items.length === 0 && !showDraft) return null;
    const header =
      mine && mine.startLine === mine.endLine
        ? `Commenting on line ${mine.startLine}`
        : `Commenting on lines ${mine?.startLine}–${mine?.endLine}`;
    return (
      <tr className="overlay-row">
        <td colSpan={colSpan}>
          {items.map((thread) => (
            <ThreadCard key={thread.id} thread={thread} author={author} onChanged={onThreadsChanged} index={locationIndex} onNavigate={onNavigate} />
          ))}
          {showDraft && <Composer header={header} autoFocus onCancel={() => onDraft(null)} onSubmit={onSubmitDraft} />}
        </td>
      </tr>
    );
  };

  const renderCode = (side: Side, no: number | null, text: string) => {
    const line = no !== null ? tokens?.get(lineKey(side, no)) : undefined;
    if (!line || line.length === 0) return <span className="code">{text === '' ? ' ' : text}</span>;
    return (
      <span className="code">
        {line.map((token, index) => (
          <span key={index} className="tok" style={token.style as React.CSSProperties}>
            {token.text}
          </span>
        ))}
      </span>
    );
  };

  const unifiedRow = (row: Row) => {
    const line = row.line!;
    const side: Side = line.type === 'del' ? 'old' : 'new';
    const no = numberOn(row, side);
    const selected = selectedRow(row.index);
    return (
      <Fragment key={`u${row.index}`}>
        <tr
          className={`line ${line.type}${selected ? ' selected' : ''}`}
          data-file={file.path}
          data-old={line.oldNo ?? undefined}
          data-new={line.newNo ?? undefined}
          onMouseEnter={() => extendSelect(row.index)}
        >
          <td className="num old" onMouseDown={(e) => no !== null && startSelect(e, side, row.index)}>
            {no !== null && gutterButton(side, no, row.index)}
            <span className="n">{line.oldNo ?? ''}</span>
          </td>
          <td className="num new" onMouseDown={(e) => no !== null && startSelect(e, side, row.index)}>
            <span className="n">{line.newNo ?? ''}</span>
          </td>
          <td className="content">
            <span className="marker">{line.type === 'add' ? '+' : line.type === 'del' ? '-' : ' '}</span>
            {renderCode(side, no, line.text)}
          </td>
        </tr>
        {overlay(row, 3)}
      </Fragment>
    );
  };

  const splitRow = (row: Row) => {
    const selected = selectedRow(row.index);
    const leftSelected = selected && span?.side === 'old';
    const rightSelected = selected && span?.side === 'new';
    return (
      <Fragment key={`s${row.index}`}>
        <tr className="line split" data-file={file.path} data-old={row.oldNo ?? undefined} data-new={row.newNo ?? undefined}>
          <td
            className={`num old${leftSelected ? ' selected' : ''}`}
            onMouseDown={(e) => row.oldNo !== null && startSelect(e, 'old', row.index)}
            onMouseEnter={() => extendSelect(row.index, 'old')}
          >
            {row.oldNo !== null && row.left?.type === 'del' && gutterButton('old', row.oldNo, row.index)}
            <span className="n">{row.oldNo ?? ''}</span>
          </td>
          <td
            className={`content ${row.left ? row.left.type : 'filler'}${leftSelected ? ' selected' : ''}`}
            onMouseEnter={() => extendSelect(row.index, 'old')}
          >
            {row.left ? renderCode('old', row.oldNo, row.left.text) : null}
          </td>
          <td
            className={`num new${rightSelected ? ' selected' : ''}`}
            onMouseDown={(e) => row.newNo !== null && startSelect(e, 'new', row.index)}
            onMouseEnter={() => extendSelect(row.index, 'new')}
          >
            {row.newNo !== null && gutterButton('new', row.newNo, row.index)}
            <span className="n">{row.newNo ?? ''}</span>
          </td>
          <td
            className={`content ${row.right ? row.right.type : 'filler'}${rightSelected ? ' selected' : ''}`}
            onMouseEnter={() => extendSelect(row.index, 'new')}
          >
            {row.right ? renderCode('new', row.newNo, row.right.text) : null}
          </td>
        </tr>
        {overlay(row, 4)}
      </Fragment>
    );
  };

  /**
   * The buttons on a hunk header. A short gap opens in one click; a long one
   * opens twenty lines at a time from either end, like GitHub.
   */
  const expander = (gap: Gap | undefined) => {
    if (!gap) return null;
    const size = gap.end === null ? null : gap.end - gap.start + 1;
    const first = gap.before === 0;
    const tail = gap.before === shown.hunks.length;
    if (size !== null && size <= STEP) {
      return (
        <button className="expander" title={`Show ${size} hidden line${size === 1 ? '' : 's'}`} onClick={() => expand([gap.start, gap.end!])}>
          <UnfoldIcon size={16} />
        </button>
      );
    }
    const down = (
      <button
        key="down"
        className="expander"
        title={`Show ${STEP} more lines below`}
        onClick={() => expand([gap.start, gap.start + STEP - 1])}
      >
        <FoldDownIcon size={16} />
      </button>
    );
    const up = (
      <button
        key="up"
        className="expander"
        title={`Show ${STEP} more lines above`}
        onClick={() => expand([gap.end! - STEP + 1, gap.end!])}
      >
        <FoldUpIcon size={16} />
      </button>
    );
    if (first) return up;
    if (tail || gap.end === null) return down;
    return (
      <span className="expander-pair">
        {down}
        {up}
      </span>
    );
  };

  const copyPath = async () => {
    try {
      await navigator.clipboard.writeText(file.path);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    } catch {
      /* clipboard blocked */
    }
  };

  const outdated = threads.filter((t) => t.status === 'outdated');
  const colSpan = view === 'unified' ? 3 : 4;

  return (
    <section className={`file-card${viewed ? ' is-viewed' : ''}`} id={`file-${file.path}`}>
      <header className="file-head">
        <button className="btn invisible icon-only chevron" onClick={onToggle} aria-label={collapsed ? 'expand' : 'collapse'}>
          {collapsed ? <ChevronRightIcon size={16} /> : <ChevronDownIcon size={16} />}
        </button>
        <span className="file-path">
          {file.oldPath && file.oldPath !== file.path && <span className="old-path">{file.oldPath} → </span>}
          {file.path}
        </span>
        <button className="btn invisible icon-only copy" onClick={() => void copyPath()} title="Copy path">
          {copied ? <CheckIcon size={14} className="fg-success" /> : <CopyIcon size={14} />}
        </button>
        {file.status !== 'modified' && <span className={`label ${file.status}`}>{file.status}</span>}
        {file.generated && <span className="label">generated</span>}
        <span className="spacer" />
        {threads.length > 0 && (
          <span className="file-comments" title={`${threads.length} comment threads`}>
            <CommentIcon size={14} /> {threads.length}
          </span>
        )}
        <button
          className={`btn invisible icon-only file-comment${fileDraft ? ' fg-accent' : ''}`}
          title="Comment on the whole file"
          aria-label={`Comment on ${file.path}`}
          onClick={draftOnFile}
        >
          <CommentDiscussionIcon size={16} />
        </button>
        <span className="diffstat">
          <span className="add">+{file.additions}</span>
          <span className="del">−{file.deletions}</span>
        </span>
        <label className="viewed-toggle" title="Mark as viewed and collapse">
          <input type="checkbox" checked={viewed} onChange={onToggleViewed} />
          Viewed
        </label>
      </header>

      {!collapsed && (
        <>
          {(fileThreads.length > 0 || fileDraft) && (
            <div className="file-threads">
              {fileThreads.map((thread) => (
                <ThreadCard key={thread.id} thread={thread} author={author} onChanged={onThreadsChanged} index={locationIndex} onNavigate={onNavigate} />
              ))}
              {fileDraft && (
                <Composer
                  header={`Commenting on ${file.path} as a whole`}
                  autoFocus
                  onCancel={() => onDraft(null)}
                  onSubmit={onSubmitDraft}
                />
              )}
            </div>
          )}

          {outdated.length > 0 && (
            <div className="outdated-block">
              <div className="outdated-title">Outdated — the code these refer to has changed</div>
              {outdated.map((thread) => (
                <ThreadCard key={thread.id} thread={thread} author={author} onChanged={onThreadsChanged} index={locationIndex} onNavigate={onNavigate} />
              ))}
            </div>
          )}

          {file.binary ? (
            <div className="notice">Binary file not shown</div>
          ) : file.hunks.length === 0 ? (
            <div className="notice">No textual changes</div>
          ) : (
            <table className={`diff ${view}${dragging ? ' selecting' : ''}`}>
              <colgroup>
                {view === 'unified' ? (
                  <>
                    <col className="num-col" />
                    <col className="num-col" />
                    <col />
                  </>
                ) : (
                  <>
                    <col className="num-col" />
                    <col style={{ width: 'calc(50% - 50px)' }} />
                    <col className="num-col" />
                    <col />
                  </>
                )}
              </colgroup>
              <tbody>
                {shown.hunks.map((hunk, hunkIndex) => (
                  <Fragment key={`h${hunkIndex}`}>
                    <tr className="hunk-head">
                      <td className="hunk-num" colSpan={view === 'unified' ? 2 : 1}>
                        {expander(gaps.find((g) => g.before === hunkIndex))}
                      </td>
                      <td colSpan={view === 'unified' ? 1 : 3}>
                        @@ -{hunk.oldStart},{hunk.oldLines} +{hunk.newStart},{hunk.newLines} @@
                        {hunk.section && <span className="section"> {hunk.section}</span>}
                      </td>
                    </tr>
                    {rows
                      .filter((row) => row.hunkIndex === hunkIndex)
                      .map((row) => (view === 'unified' ? unifiedRow(row) : splitRow(row)))}
                  </Fragment>
                ))}
                {gaps.some((g) => g.before === shown.hunks.length) && (
                  <tr className="hunk-head tail">
                    <td className="hunk-num" colSpan={view === 'unified' ? 2 : 1}>
                      {expander(gaps.find((g) => g.before === shown.hunks.length))}
                    </td>
                    <td colSpan={view === 'unified' ? 1 : 3} />
                  </tr>
                )}
              </tbody>
            </table>
          )}
        </>
      )}
    </section>
  );
}
