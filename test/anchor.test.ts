import { describe, expect, it } from 'vitest';
import { buildAnchor, findAnchor, similarity } from '../src/server/anchor.js';
import { parseUnifiedDiff } from '../src/server/diff-parser.js';
import type { Thread } from '../src/shared/types.js';

function diffOf(lines: string[]): ReturnType<typeof parseUnifiedDiff>[number] {
  const body = lines.join('\n');
  return parseUnifiedDiff(
    ['diff --git a/app.js b/app.js', '--- a/app.js', '+++ b/app.js', body, ''].join('\n'),
  )[0];
}

const before = diffOf([
  '@@ -1,6 +1,6 @@',
  ' function total(items) {',
  '   let sum = 0;',
  '   for (const item of items) {',
  '-    sum += item.price;',
  '+    sum += item.price * item.qty;',
  '   }',
  '   return sum;',
]);

function threadOn(file: typeof before, line: number): Thread {
  return {
    id: 't1',
    file: 'app.js',
    side: 'new',
    startLine: line,
    endLine: line,
    anchor: buildAnchor(file, 'new', line, line),
    status: 'open',
    agentTyping: false,
    createdAt: '',
    updatedAt: '',
    messages: [],
    anchoredVersion: 0,
  };
}

describe('anchoring', () => {
  it('captures the commented line with surrounding context', () => {
    const anchor = buildAnchor(before, 'new', 4, 4);
    expect(anchor.text).toEqual(['    sum += item.price * item.qty;']);
    expect(anchor.before).toEqual([
      'function total(items) {',
      '  let sum = 0;',
      '  for (const item of items) {',
    ]);
    expect(anchor.after).toEqual(['  }', '  return sum;']);
  });

  it('keeps the position when nothing moved', () => {
    const thread = threadOn(before, 4);
    expect(findAnchor(before, thread)).toEqual({ startLine: 4, endLine: 4, moved: false });
  });

  it('follows the line when it shifts down', () => {
    const thread = threadOn(before, 4);
    const shifted = diffOf([
      '@@ -1,8 +1,8 @@',
      ' function total(items) {',
      '   let sum = 0;',
      '+  const seen = new Set();',
      '   for (const item of items) {',
      '-    sum += item.price;',
      '+    sum += item.price * item.qty;',
      '   }',
      '   return sum;',
    ]);
    expect(findAnchor(shifted, thread)).toEqual({ startLine: 5, endLine: 5, moved: true });
  });

  it('re-anchors when the agent rewrites the very line under review', () => {
    const thread = threadOn(before, 4);
    const rewritten = diffOf([
      '@@ -1,7 +1,8 @@',
      ' function total(items) {',
      '   let sum = 0;',
      '   for (const item of items) {',
      '-    sum += item.price;',
      '+    if (!item) continue;',
      '+    sum += item.price * (item.qty ?? 1);',
      '   }',
      '   return sum;',
    ]);
    const result = findAnchor(rewritten, thread);
    expect(result).toEqual({ startLine: 5, endLine: 5, moved: true });
  });

  it('falls back to the context above when the line is deleted outright', () => {
    const thread = threadOn(before, 4);
    const removed = diffOf([
      '@@ -1,6 +1,4 @@',
      ' function total(items) {',
      '   let sum = 0;',
      '   for (const item of items) {',
      '-    sum += item.price;',
      '   }',
      '   return sum;',
    ]);
    const result = findAnchor(removed, thread);
    expect(result?.moved).toBe(true);
    expect(result?.startLine).toBe(4);
  });

  it('gives up when the file no longer resembles the comment', () => {
    const thread = threadOn(before, 4);
    const unrelated = diffOf([
      '@@ -1,3 +1,3 @@',
      '-import x from "x";',
      '+import y from "y";',
      ' export const config = {};',
    ]);
    expect(findAnchor(unrelated, thread)).toBeNull();
  });

  it('scores similar strings above the threshold', () => {
    expect(similarity('sum += item.price;', 'sum += item.price * (item.qty ?? 1);')).toBeGreaterThan(0.45);
    expect(similarity('const a = 1;', 'throw new Error("boom");')).toBeLessThan(0.45);
  });
});
