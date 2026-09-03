import type { DiffFile, DiffHunk, DiffLine } from '../shared/types';

/** Inclusive range of new-side line numbers the reviewer expanded into view. */
export type Range = [number, number];

/** How many lines one click on an expander reveals, as on GitHub. */
export const STEP = 20;

/**
 * The lines not shown between two hunks (or before the first / after the last).
 * `end` is null for the tail while the file's length is still unknown.
 */
export interface Gap {
  /** index of the hunk this gap sits before; hunks.length for the tail */
  before: number;
  start: number;
  end: number | null;
}

/** first and last new-side line a hunk covers, honouring git's zero-length convention */
function newSpan(hunk: DiffHunk): { first: number; last: number } {
  return hunk.newLines === 0
    ? { first: hunk.newStart + 1, last: hunk.newStart }
    : { first: hunk.newStart, last: hunk.newStart + hunk.newLines - 1 };
}

function oldSpan(hunk: DiffHunk): { first: number; last: number } {
  return hunk.oldLines === 0
    ? { first: hunk.oldStart + 1, last: hunk.oldStart }
    : { first: hunk.oldStart, last: hunk.oldStart + hunk.oldLines - 1 };
}

export function gapsOf(file: DiffFile, totalLines: number | null): Gap[] {
  const gaps: Gap[] = [];
  let prevLast = 0;
  file.hunks.forEach((hunk, index) => {
    const { first, last } = newSpan(hunk);
    if (first - 1 >= prevLast + 1) gaps.push({ before: index, start: prevLast + 1, end: first - 1 });
    prevLast = Math.max(prevLast, last);
  });
  if (totalLines === null) gaps.push({ before: file.hunks.length, start: prevLast + 1, end: null });
  else if (totalLines >= prevLast + 1) gaps.push({ before: file.hunks.length, start: prevLast + 1, end: totalLines });
  return gaps;
}

/** Add a range, merging anything it touches, keeping the list sorted. */
export function addRange(ranges: Range[], next: Range): Range[] {
  let [lo, hi] = [Math.max(1, Math.min(...next)), Math.max(...next)];
  const rest: Range[] = [];
  for (const [a, b] of ranges) {
    if (b < lo - 1 || a > hi + 1) rest.push([a, b]);
    else {
      lo = Math.min(lo, a);
      hi = Math.max(hi, b);
    }
  }
  return [...rest, [lo, hi] as Range].sort((x, y) => x[0] - y[0]);
}

/**
 * The diff with the requested new-side lines pulled in from the full file as
 * context. Lines outside the hunks are identical on both sides, so their old
 * number follows from the neighbouring hunk's offset. Hunks that become
 * adjacent are merged, so the hunk headers in the result mark real gaps.
 */
export function expandFile(file: DiffFile, fullLines: string[] | null, ranges: Range[]): DiffFile {
  if (!fullLines || ranges.length === 0 || file.hunks.length === 0) return file;
  const total = fullLines.length;
  const wanted = new Set<number>();
  for (const [a, b] of ranges) for (let n = Math.max(1, a); n <= Math.min(total, b); n++) wanted.add(n);
  if (wanted.size === 0) return file;

  // sequence of lines in file order: gap context, hunk, gap context, hunk, ..., tail
  const items: { line: DiffLine; section: string | null }[] = [];
  let prevLast = 0;
  let prevLastOld = 0;
  const pushGap = (from: number, to: number, offset: number) => {
    for (let n = from; n <= to; n++) {
      if (!wanted.has(n)) continue;
      items.push({ line: { type: 'context', oldNo: n - offset, newNo: n, text: fullLines[n - 1] }, section: null });
    }
  };
  for (const hunk of file.hunks) {
    const news = newSpan(hunk);
    const olds = oldSpan(hunk);
    pushGap(prevLast + 1, news.first - 1, news.first - olds.first);
    hunk.lines.forEach((line, i) => items.push({ line, section: i === 0 ? hunk.section : null }));
    prevLast = Math.max(prevLast, news.last);
    prevLastOld = Math.max(prevLastOld, olds.last);
  }
  pushGap(prevLast + 1, total, prevLast - prevLastOld);

  // split into hunks wherever the new-side numbering skips
  const hunks: DiffHunk[] = [];
  let current: DiffLine[] = [];
  let section = '';
  let lastNew: number | null = null;
  const flush = () => {
    if (current.length === 0) return;
    const olds = current.map((l) => l.oldNo).filter((n): n is number => n !== null);
    const news = current.map((l) => l.newNo).filter((n): n is number => n !== null);
    hunks.push({
      oldStart: olds[0] ?? 0,
      oldLines: olds.length,
      newStart: news[0] ?? 0,
      newLines: news.length,
      section,
      lines: current,
    });
    current = [];
    section = '';
    lastNew = null;
  };
  for (const { line, section: label } of items) {
    if (line.newNo !== null && lastNew !== null && line.newNo !== lastNew + 1) flush();
    if (section === '' && label !== null) section = label;
    current.push(line);
    if (line.newNo !== null) lastNew = line.newNo;
  }
  flush();
  return { ...file, hunks };
}
