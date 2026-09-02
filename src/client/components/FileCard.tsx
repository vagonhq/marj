import { CheckIcon, ChevronDownIcon, ChevronRightIcon, CommentIcon, CopyIcon } from '@primer/octicons-react';
import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import type { DiffFile, DiffHunk, DiffLine, Intent, Side, Thread } from '../../shared/types';
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
  } = props;

  const language = useMemo(() => languageOf(file.path), [file.path]);
  const rows = useMemo(() => buildRows(file, view), [file, view]);

  // syntax colours arrive asynchronously; plain text is shown until then
  const [tokens, setTokens] = useState<Map<string, TokenLine> | null>(null);
  useEffect(() => {
    if (!language || collapsed || file.binary) return;
    let alive = true;
    highlightFile(file, language)
      .then((result) => alive && setTokens(result))
      .catch(() => alive && setTokens(null));
    return () => {
      alive = false;
    };
  }, [file, language, collapsed]);

  const [span, setSpan] = useState<{ side: Side; from: number; to: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  const [copied, setCopied] = useState(false);

  const mine = draft && draft.file === file.path ? draft : null;

  useEffect(() => {
    if (!mine) setSpan(null);
  }, [mine]);

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

  const threadsAt = (side: Side, no: number) =>
    threads.filter((t) => t.status !== 'outdated' && t.side === side && t.endLine === no);

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
    const showDraft = !!mine && composerRow === row.index;
    if (items.length === 0 && !showDraft) return null;
    const header =
      mine && mine.startLine === mine.endLine
        ? `Commenting on line ${mine.startLine}`
        : `Commenting on lines ${mine?.startLine}–${mine?.endLine}`;
    return (
      <tr className="overlay-row">
        <td colSpan={colSpan}>
          {items.map((thread) => (
            <ThreadCard key={thread.id} thread={thread} author={author} onChanged={onThreadsChanged} />
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
        <tr className={`line ${line.type}${selected ? ' selected' : ''}`} onMouseEnter={() => extendSelect(row.index)}>
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
        <tr className="line split">
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
          {outdated.length > 0 && (
            <div className="outdated-block">
              <div className="outdated-title">Outdated — the code these refer to has changed</div>
              {outdated.map((thread) => (
                <ThreadCard key={thread.id} thread={thread} author={author} onChanged={onThreadsChanged} />
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
                {file.hunks.map((hunk, hunkIndex) => (
                  <Fragment key={`h${hunkIndex}`}>
                    <tr className="hunk-head">
                      <td className="hunk-num" colSpan={view === 'unified' ? 2 : 1} />
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
              </tbody>
            </table>
          )}
        </>
      )}
    </section>
  );
}
