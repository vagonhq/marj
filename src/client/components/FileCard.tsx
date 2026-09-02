import { Fragment, useMemo } from 'react';
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
  onToggle: () => void;
  draft: DraftTarget | null;
  onDraft: (draft: DraftTarget | null) => void;
  onSubmitDraft: (body: string, intent: Intent) => Promise<void>;
  onThreadsChanged: () => void;
}

/** Where a line lives: deletions belong to the old side, everything else to the new. */
function anchorOf(line: DiffLine): { side: Side; no: number } | null {
  if (line.type === 'del') return line.oldNo === null ? null : { side: 'old', no: line.oldNo };
  return line.newNo === null ? null : { side: 'new', no: line.newNo };
}

interface SplitRow {
  left: DiffLine | null;
  right: DiffLine | null;
}

function toSplitRows(hunk: DiffHunk): SplitRow[] {
  const rows: SplitRow[] = [];
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

export function FileCard(props: Props) {
  const { file, view, threads, collapsed, onToggle, draft, onDraft, onSubmitDraft, onThreadsChanged } = props;
  const language = useMemo(() => languageOf(file.path), [file.path]);

  const anchored = threads.filter((t) => t.status !== 'outdated');
  const outdated = threads.filter((t) => t.status === 'outdated');

  const threadsAt = (side: Side, no: number) =>
    anchored.filter((thread) => thread.side === side && thread.endLine === no);

  const draftAt = (side: Side, no: number) =>
    draft && draft.side === side && draft.endLine === no ? draft : null;

  const openDraft = (event: React.MouseEvent, side: Side, no: number) => {
    if (event.shiftKey && draft && draft.side === side && no > draft.startLine) {
      onDraft({ ...draft, endLine: no });
      return;
    }
    onDraft({ file: file.path, side, startLine: no, endLine: no });
  };

  const inDraftRange = (side: Side, no: number) =>
    !!draft && draft.side === side && no >= draft.startLine && no <= draft.endLine;

  const overlay = (side: Side, no: number, colSpan: number) => {
    const items = threadsAt(side, no);
    const activeDraft = draftAt(side, no);
    if (items.length === 0 && !activeDraft) return null;
    return (
      <tr className="overlay-row">
        <td colSpan={colSpan}>
          {items.map((thread) => (
            <ThreadCard key={thread.id} thread={thread} onChanged={onThreadsChanged} />
          ))}
          {activeDraft && (
            <Composer
              placeholder={
                activeDraft.startLine === activeDraft.endLine
                  ? `Line ${activeDraft.startLine} — "Comment" just answers, "Comment & fix" changes the code`
                  : `Lines ${activeDraft.startLine}-${activeDraft.endLine} — "Comment" just answers, "Comment & fix" changes the code`
              }
              autoFocus
              onCancel={() => onDraft(null)}
              onSubmit={onSubmitDraft}
            />
          )}
        </td>
      </tr>
    );
  };

  const renderCode = (text: string) => (
    <span className="code" dangerouslySetInnerHTML={{ __html: highlightLine(text, language) || '&nbsp;' }} />
  );

  const unifiedRows = (hunk: DiffHunk) =>
    hunk.lines.map((line, index) => {
      const anchor = anchorOf(line);
      const key = `${line.type}-${line.oldNo ?? 'x'}-${line.newNo ?? 'x'}-${index}`;
      return (
        <Fragment key={key}>
          <tr className={`line ${line.type} ${anchor && inDraftRange(anchor.side, anchor.no) ? 'drafting' : ''}`}>
            <td className="num old">{line.oldNo ?? ''}</td>
            <td className="num new">{line.newNo ?? ''}</td>
            <td className="gutter">
              {anchor && (
                <button
                  className="add-comment"
                  title="Comment (shift-click to extend the range)"
                  onClick={(event) => openDraft(event, anchor.side, anchor.no)}
                >
                  +
                </button>
              )}
            </td>
            <td className="content">
              <span className="marker">{line.type === 'add' ? '+' : line.type === 'del' ? '-' : ' '}</span>
              {renderCode(line.text)}
            </td>
          </tr>
          {anchor && overlay(anchor.side, anchor.no, 4)}
        </Fragment>
      );
    });

  const splitRows = (hunk: DiffHunk) =>
    toSplitRows(hunk).map((row, index) => {
      const leftNo = row.left?.oldNo ?? null;
      const rightNo = row.right?.newNo ?? null;
      return (
        <Fragment key={`s-${index}-${leftNo ?? 'x'}-${rightNo ?? 'x'}`}>
          <tr className="line split">
            <td className="num old">{leftNo ?? ''}</td>
            <td className="gutter">
              {leftNo !== null && row.left?.type === 'del' && (
                <button className="add-comment" onClick={(event) => openDraft(event, 'old', leftNo)}>
                  +
                </button>
              )}
            </td>
            <td className={`content ${row.left ? row.left.type : 'filler'}`}>
              {row.left ? renderCode(row.left.text) : null}
            </td>
            <td className="num new">{rightNo ?? ''}</td>
            <td className="gutter">
              {rightNo !== null && (
                <button className="add-comment" onClick={(event) => openDraft(event, 'new', rightNo)}>
                  +
                </button>
              )}
            </td>
            <td className={`content ${row.right ? row.right.type : 'filler'}`}>
              {row.right ? renderCode(row.right.text) : null}
            </td>
          </tr>
          {leftNo !== null && row.left?.type === 'del' && overlay('old', leftNo, 6)}
          {rightNo !== null && overlay('new', rightNo, 6)}
        </Fragment>
      );
    });

  return (
    <section className="file-card" id={`file-${file.path}`}>
      <header className="file-head">
        <button className="chevron" onClick={onToggle} aria-label="toggle file">
          {collapsed ? '▸' : '▾'}
        </button>
        <span className="file-path">
          {file.oldPath && file.oldPath !== file.path && <span className="old-path">{file.oldPath} → </span>}
          {file.path}
        </span>
        <span className={`chip ${file.status}`}>{file.status}</span>
        {file.generated && <span className="chip generated">generated</span>}
        <span className="spacer" />
        {threads.length > 0 && <span className="chip comments">{threads.length} 💬</span>}
        <span className="counts">
          <span className="add">+{file.additions}</span>
          <span className="del">-{file.deletions}</span>
        </span>
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
            <div className="binary">Binary file not shown</div>
          ) : file.hunks.length === 0 ? (
            <div className="binary">No textual changes</div>
          ) : (
            <table className={`diff ${view}`}>
              <colgroup>
                {view === 'unified' ? (
                  <>
                    <col className="num-col" />
                    <col className="num-col" />
                    <col className="gutter-col" />
                    <col />
                  </>
                ) : (
                  <>
                    <col className="num-col" />
                    <col className="gutter-col" />
                    <col style={{ width: '50%' }} />
                    <col className="num-col" />
                    <col className="gutter-col" />
                    <col />
                  </>
                )}
              </colgroup>
              <tbody>
                {file.hunks.map((hunk, index) => (
                  <Fragment key={`h${index}`}>
                    <tr className="hunk-head">
                      <td colSpan={view === 'unified' ? 4 : 6}>
                        @@ -{hunk.oldStart},{hunk.oldLines} +{hunk.newStart},{hunk.newLines} @@
                        {hunk.section && <span className="section"> {hunk.section}</span>}
                      </td>
                    </tr>
                    {view === 'unified' ? unifiedRows(hunk) : splitRows(hunk)}
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
