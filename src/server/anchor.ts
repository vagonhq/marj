import type { Anchor, DiffFile, DiffPayload, Side, Thread } from '../shared/types.js';
import type { ThreadStore } from './threads.js';

interface NumberedLine {
  no: number;
  text: string;
}

/** The lines of a file that exist on one side of the diff, in order. */
export function sideLines(file: DiffFile, side: Side): NumberedLine[] {
  const out: NumberedLine[] = [];
  for (const hunk of file.hunks) {
    for (const line of hunk.lines) {
      const no = side === 'old' ? line.oldNo : line.newNo;
      if (no === null) continue;
      out.push({ no, text: line.text });
    }
  }
  return out;
}

/** Capture the commented lines plus a little context so we can find them later. */
export function buildAnchor(
  file: DiffFile,
  side: Side,
  startLine: number,
  endLine: number,
): Anchor {
  const lines = sideLines(file, side);
  const index = new Map(lines.map((l, i) => [l.no, i]));
  const from = index.get(startLine);
  const to = index.get(endLine);
  if (from === undefined || to === undefined) return { text: [], before: [], after: [] };
  return {
    text: lines.slice(from, to + 1).map((l) => l.text),
    before: lines.slice(Math.max(0, from - 3), from).map((l) => l.text),
    after: lines.slice(to + 1, to + 4).map((l) => l.text),
  };
}

function normalise(text: string): string {
  return text.trim();
}

function sequenceMatches(lines: NumberedLine[], at: number, wanted: string[]): boolean {
  if (at + wanted.length > lines.length) return false;
  for (let i = 0; i < wanted.length; i++) {
    if (normalise(lines[at + i].text) !== normalise(wanted[i])) return false;
  }
  return true;
}

function contextScore(lines: NumberedLine[], at: number, anchor: Anchor): number {
  let score = 0;
  for (let i = 0; i < anchor.before.length; i++) {
    const idx = at - anchor.before.length + i;
    if (idx >= 0 && normalise(lines[idx].text) === normalise(anchor.before[i])) score++;
  }
  const afterStart = at + anchor.text.length;
  for (let i = 0; i < anchor.after.length; i++) {
    const idx = afterStart + i;
    if (idx < lines.length && normalise(lines[idx].text) === normalise(anchor.after[i])) score++;
  }
  return score;
}

export interface AnchorResult {
  startLine: number;
  endLine: number;
  moved: boolean;
}

function bigrams(text: string): Set<string> {
  const set = new Set<string>();
  for (let i = 0; i < text.length - 1; i++) set.add(text.slice(i, i + 2));
  return set;
}

/** Sørensen–Dice similarity on character bigrams, 0..1. */
export function similarity(a: string, b: string): number {
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return a === b ? 1 : 0;
  const left = bigrams(a);
  const right = bigrams(b);
  let shared = 0;
  for (const gram of left) if (right.has(gram)) shared++;
  return (2 * shared) / (left.size + right.size);
}

const SIMILAR_ENOUGH = 0.45;

/**
 * The commented line is usually the one the agent just rewrote, so an exact
 * match fails far more often here than on GitHub. Fall back to the most
 * similar line, then to the surrounding context, before giving up.
 */
function fuzzyFind(lines: NumberedLine[], anchor: Anchor, near: number): AnchorResult | null {
  const wanted = normalise(anchor.text[0]);
  let best: { index: number; score: number } | null = null;

  for (let i = 0; i < lines.length; i++) {
    const score =
      similarity(normalise(lines[i].text), wanted) +
      contextScore(lines, i, anchor) * 0.05 -
      Math.min(Math.abs(lines[i].no - near), 200) * 0.0005;
    if (!best || score > best.score) best = { index: i, score };
  }
  if (best && best.score >= SIMILAR_ENOUGH) {
    const start = lines[best.index].no;
    const end = lines[Math.min(best.index + anchor.text.length - 1, lines.length - 1)].no;
    return { startLine: start, endLine: Math.max(start, end), moved: true };
  }

  // the line itself is gone — hang the thread off the context above it
  if (anchor.before.length > 0) {
    const tail = normalise(anchor.before[anchor.before.length - 1]);
    for (let i = 0; i < lines.length; i++) {
      if (normalise(lines[i].text) !== tail) continue;
      const next = lines[i + 1] ?? lines[i];
      return { startLine: next.no, endLine: next.no, moved: true };
    }
  }
  return null;
}

/**
 * Find where a thread's lines live in the current diff. Exact position first,
 * then the same content anywhere in the file (closest match wins).
 */
export function findAnchor(file: DiffFile, thread: Thread): AnchorResult | null {
  const lines = sideLines(file, thread.side);
  if (lines.length === 0) return null;

  const anchor = thread.anchor;
  if (anchor.text.length === 0) {
    // no captured content (legacy thread) — keep it only if the lines still exist
    const stillThere = lines.some((l) => l.no === thread.startLine);
    return stillThere ? { startLine: thread.startLine, endLine: thread.endLine, moved: false } : null;
  }

  const atIndex = lines.findIndex((l) => l.no === thread.startLine);
  if (atIndex !== -1 && sequenceMatches(lines, atIndex, anchor.text)) {
    return { startLine: thread.startLine, endLine: thread.endLine, moved: false };
  }

  let best: { index: number; score: number } | null = null;
  for (let i = 0; i < lines.length; i++) {
    if (!sequenceMatches(lines, i, anchor.text)) continue;
    const score = contextScore(lines, i, anchor) * 100 - Math.abs(lines[i].no - thread.startLine);
    if (!best || score > best.score) best = { index: i, score };
  }
  if (!best) return fuzzyFind(lines, anchor, thread.startLine);

  const startLine = lines[best.index].no;
  const endLine = lines[Math.min(best.index + anchor.text.length - 1, lines.length - 1)].no;
  return { startLine, endLine, moved: startLine !== thread.startLine };
}

/**
 * Re-point every thread at the freshly computed diff. Threads whose code is
 * gone become `outdated`; threads that come back become open again.
 */
export function reanchorAll(store: ThreadStore, diff: DiffPayload): void {
  const byPath = new Map<string, DiffFile>();
  for (const file of diff.files) {
    byPath.set(file.path, file);
    if (file.oldPath) byPath.set(file.oldPath, file);
  }

  for (const thread of store.list()) {
    if (thread.status === 'resolved') continue;
    const file = byPath.get(thread.file);
    const result = file ? findAnchor(file, thread) : null;

    if (!result) {
      if (thread.status !== 'outdated') {
        store.reanchor(thread.id, { status: 'outdated', anchoredVersion: diff.version });
      }
      continue;
    }

    const restored = thread.status === 'outdated';
    store.reanchor(thread.id, {
      startLine: result.startLine,
      endLine: result.endLine,
      anchoredVersion: diff.version,
      ...(restored ? { status: thread.messages.at(-1)?.role === 'agent' ? 'answered' : 'open' } : {}),
    });
  }
}
