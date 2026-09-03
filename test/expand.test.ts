import { describe, expect, it } from 'vitest';
import { addRange, expandFile, gapsOf } from '../src/client/expand.js';
import { parseUnifiedDiff } from '../src/server/diff-parser.js';

// a 30-line file where line 11 was changed and line 24 was added
const full = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`);
full[10] = 'line 11 changed';
full.splice(23, 0, 'inserted');

const file = parseUnifiedDiff(
  [
    'diff --git a/f.txt b/f.txt',
    '--- a/f.txt',
    '+++ b/f.txt',
    '@@ -10,3 +10,3 @@ fn one',
    ' line 10',
    '-line 11',
    '+line 11 changed',
    ' line 12',
    '@@ -22,3 +22,4 @@ fn two',
    ' line 22',
    ' line 23',
    '+inserted',
    ' line 24',
    '',
  ].join('\n'),
)[0];

describe('expanding context', () => {
  it('lists the gaps between hunks, the tail unknown until the file is read', () => {
    expect(gapsOf(file, null)).toEqual([
      { before: 0, start: 1, end: 9 },
      { before: 1, start: 13, end: 21 },
      { before: 2, start: 26, end: null },
    ]);
    expect(gapsOf(file, full.length).at(-1)).toEqual({ before: 2, start: 26, end: 31 });
  });

  it('merges overlapping and touching ranges', () => {
    expect(addRange([[1, 5]], [6, 8])).toEqual([[1, 8]]);
    expect(addRange([[1, 5]], [10, 12])).toEqual([[1, 5], [10, 12]]);
    expect(addRange([[1, 5], [10, 12]], [4, 11])).toEqual([[1, 12]]);
  });

  it('pulls gap lines in as context with the right old numbers', () => {
    const expanded = expandFile(file, full, [[7, 9]]);
    expect(expanded.hunks).toHaveLength(2);
    const first = expanded.hunks[0];
    expect(first.newStart).toBe(7);
    expect(first.oldStart).toBe(7);
    expect(first.lines.slice(0, 3).map((l) => `${l.oldNo}/${l.newNo} ${l.text}`)).toEqual([
      '7/7 line 7',
      '8/8 line 8',
      '9/9 line 9',
    ]);
    expect(first.section).toBe('fn one');
  });

  it('merges hunks once the gap between them is fully shown', () => {
    const expanded = expandFile(file, full, [[13, 21]]);
    expect(expanded.hunks).toHaveLength(1);
    expect(expanded.hunks[0].lines.map((l) => l.newNo).filter(Boolean)).toEqual(
      Array.from({ length: 16 }, (_, i) => 10 + i),
    );
    // lines after the insertion point are shifted by one on the new side
    const tail = expandFile(file, full, [[26, 40]]);
    const last = tail.hunks.at(-1)!.lines.at(-1)!;
    expect(last).toMatchObject({ newNo: 31, oldNo: 30, text: 'line 30' });
    expect(gapsOf(tail, full.length)).toEqual([
      { before: 0, start: 1, end: 9 },
      { before: 1, start: 13, end: 21 },
    ]);
  });

  it('keeps a partial expansion as its own hunk', () => {
    const expanded = expandFile(file, full, [[13, 15]]);
    expect(expanded.hunks.map((h) => h.newStart)).toEqual([10, 22]);
    expect(expanded.hunks[0].lines.map((l) => l.newNo)).toEqual([10, null, 11, 12, 13, 14, 15]);
  });

  it('is a no-op without file content', () => {
    expect(expandFile(file, null, [[1, 9]])).toBe(file);
  });
});
