import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import type { DiffFile, DiffHunk, DiffLine, Intent, Side, Thread } from '../../shared/types';
import { highlightLine, languageOf } from '../highlight.js';
import { Composer } from './Composer.js';
import { ThreadCard } from './ThreadCard.js';
import type { DraftTarget } from './types.js';

interface Props {
  file: DiffFile;
  view: 'unified' | 'split';
  threads: Thread[];
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
  /** unified: the single line. split: the two halves. */
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

const STATUS_LABEL: Record<DiffFile['status'], string> = {
  added: 'added',
  deleted: 'deleted',
  modified: 'modified',
  renamed: 'renamed',
};

export function FileCard(props: Props) {
  const {
    file,
    view,
    threads,
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

  /** the visual span of the selection being drawn, in row indices */
  const [span, setSpan] = useState<{ side: Side; from: number; to: number } | null>(null);
  const [dragging, setDragging] = useState(false);

  const mine = draft && draft.file === file.path ? draft : null;

  // the draft can be cancelled from anywhere (Escape, another file) — drop the span with it
  useEffect(() => {
    if (!mine) setSpan(null);
  }, [mine]);

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

  /** turn a row span into the line range the thread will carry */
  const publish = (side: Side, from: number, to: number) => {
    const lo = Math.min(from, to);
    const hi = Math.max(from, to);
    const numbers = rows
      .slice(lo, hi + 1)
      .map((row) => numberOn(row, side))
      .filter((no): no is number => no !== null);
    if (numbers.length === 0) return;
    onDraft({
      file: file.path,
      side,
      startLine: Math.min(...numbers),
      endLine: Math.max(...numbers),
    });
  };

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

  /**
   * The side comes from where the drag started, not from the row under the
   * cursor — otherwise a drag that crosses a deleted line into added ones would
   * stop dead. `expect` guards the split view, where each column is one side.
   */
  const extendSelect = (index: number, expect?: Side) => {
    if (!dragging || !span) return;
    if (expect && span.side !== expect) return;
    if (span.to === index) return;
    setSpan({ ...span, to: index });
  };

  const selectedRow = (index: number) =>
    !!span &&
    (dragging || !!mine) &&
    index >= Math.min(span.from, span.to) &&
    index <= Math.max(span.from, span.to);

  /** the composer sits under the last row of the visual span */
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
            <ThreadCard key={thread.id} thread={thread} onChanged={onThreadsChanged} />
          ))}
          {showDraft && (
            <Composer header={header} autoFocus onCancel={() => onDraft(null)} onSubmit={onSubmitDraft} />
          )}
        </td>
      </tr>
    );
  };

  const renderCode = (text: string) => (
    <span className="code" dangerouslySetInnerHTML={{ __html: highlightLine(text, language) || '&nbsp;' }} />
  );

  const unifiedRow = (row: Row) => {
    const line = row.line!;
    const side: Side = line.type === 'del' ? 'old' : 'new';
    const no = numberOn(row, side);
    const selected = selectedRow(row.index);
    return (
      <Fragment key={`u${row.index}`}>
        <tr
          className={`line ${line.type}${selected ? ' selected' : ''}`}
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
            {renderCode(line.text)}
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
            {row.left ? renderCode(row.left.text) : null}
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
            {row.right ? renderCode(row.right.text) : null}
          </td>
        </tr>
        {overlay(row, 4)}
      </Fragment>
    );
  };

  const outdated = threads.filter((t) => t.status === 'outdated');
  const colSpan = view === 'unified' ? 3 : 4;

  return (
    <section className="file-card" id={`file-${file.path}`}>
      <header className={`file-head${viewed ? ' viewed' : ''}`}>
        <button
          className="chevron"
          onClick={onToggle}
          aria-label={collapsed ? 'expand file' : 'collapse file'}
          title={collapsed ? 'Expand' : 'Collapse'}
        >
          <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
            <path
              fill="currentColor"
              d={
                collapsed
                  ? 'M6.22 3.22a.75.75 0 0 1 1.06 0l4.25 4.25a.75.75 0 0 1 0 1.06l-4.25 4.25a.75.75 0 1 1-1.06-1.06L9.94 8 6.22 4.28a.75.75 0 0 1 0-1.06Z'
                  : 'M12.78 6.22a.75.75 0 0 1 0 1.06l-4.25 4.25a.75.75 0 0 1-1.06 0L3.22 7.28a.75.75 0 0 1 1.06-1.06L8 9.94l3.72-3.72a.75.75 0 0 1 1.06 0Z'
              }
            />
          </svg>
        </button>
        <span className="file-path">
          {file.oldPath && file.oldPath !== file.path && <span className="old-path">{file.oldPath} → </span>}
          {file.path}
        </span>
        {file.status !== 'modified' && <span className="chip">{STATUS_LABEL[file.status]}</span>}
        {file.generated && <span className="chip">generated</span>}
        <span className="spacer" />
        {threads.length > 0 && (
          <span className="chip comments">
            {threads.length} comment{threads.length > 1 ? 's' : ''}
          </span>
        )}
        <span className="counts">
          <span className="add">+{file.additions}</span>
          <span className="del">−{file.deletions}</span>
        </span>
        <label className="viewed-toggle" title="Collapse this file and mark it reviewed">
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
                <ThreadCard key={thread.id} thread={thread} onChanged={onThreadsChanged} />
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
                      <td colSpan={colSpan}>
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
