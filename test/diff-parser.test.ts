import { describe, expect, it } from 'vitest';
import { isGenerated, parseUnifiedDiff, unquotePath } from '../src/server/diff-parser.js';

describe('parseUnifiedDiff', () => {
  it('parses a simple modification with line numbers on both sides', () => {
    const raw = [
      'diff --git a/app.js b/app.js',
      'index 1234567..89abcde 100644',
      '--- a/app.js',
      '+++ b/app.js',
      '@@ -1,3 +1,4 @@ function total()',
      ' const a = 1;',
      '-const b = 2;',
      '+const b = 3;',
      '+const c = 4;',
      ' const d = 5;',
      '',
    ].join('\n');

    const [file] = parseUnifiedDiff(raw);
    expect(file.path).toBe('app.js');
    expect(file.status).toBe('modified');
    expect(file.additions).toBe(2);
    expect(file.deletions).toBe(1);
    expect(file.hunks).toHaveLength(1);
    expect(file.hunks[0].section).toBe('function total()');
    expect(file.hunks[0].lines.map((l) => [l.type, l.oldNo, l.newNo])).toEqual([
      ['context', 1, 1],
      ['del', 2, null],
      ['add', null, 2],
      ['add', null, 3],
      ['context', 3, 4],
    ]);
  });

  it('detects added and deleted files', () => {
    const raw = [
      'diff --git a/new.txt b/new.txt',
      'new file mode 100644',
      '--- /dev/null',
      '+++ b/new.txt',
      '@@ -0,0 +1 @@',
      '+hello',
      'diff --git a/gone.txt b/gone.txt',
      'deleted file mode 100644',
      '--- a/gone.txt',
      '+++ /dev/null',
      '@@ -1 +0,0 @@',
      '-bye',
      '',
    ].join('\n');

    const files = parseUnifiedDiff(raw);
    expect(files.map((f) => [f.path, f.status])).toEqual([
      ['new.txt', 'added'],
      ['gone.txt', 'deleted'],
    ]);
  });

  it('keeps both paths for renames', () => {
    const raw = [
      'diff --git a/old/name.ts b/new/name.ts',
      'similarity index 96%',
      'rename from old/name.ts',
      'rename to new/name.ts',
      '--- a/old/name.ts',
      '+++ b/new/name.ts',
      '@@ -1 +1 @@',
      '-a',
      '+b',
      '',
    ].join('\n');

    const [file] = parseUnifiedDiff(raw);
    expect(file.status).toBe('renamed');
    expect(file.oldPath).toBe('old/name.ts');
    expect(file.path).toBe('new/name.ts');
  });

  it('flags binary files and keeps them hunk-free', () => {
    const raw = [
      'diff --git a/logo.png b/logo.png',
      'index 1111111..2222222 100644',
      'Binary files a/logo.png and b/logo.png differ',
      '',
    ].join('\n');

    const [file] = parseUnifiedDiff(raw);
    expect(file.binary).toBe(true);
    expect(file.hunks).toEqual([]);
  });

  it('handles multiple hunks and the no-newline marker', () => {
    const raw = [
      'diff --git a/a.txt b/a.txt',
      '--- a/a.txt',
      '+++ b/a.txt',
      '@@ -1,2 +1,2 @@',
      '-one',
      '+ONE',
      ' two',
      '@@ -10,2 +10,2 @@',
      ' ten',
      '-eleven',
      '\\ No newline at end of file',
      '+ELEVEN',
      '',
    ].join('\n');

    const [file] = parseUnifiedDiff(raw);
    expect(file.hunks).toHaveLength(2);
    expect(file.hunks[1].lines[1].noNewline).toBe(true);
    expect(file.hunks[1].lines[2].newNo).toBe(11);
  });

  it('handles paths with spaces and quoted unicode paths', () => {
    const raw = [
      'diff --git a/my dir/file name.txt b/my dir/file name.txt',
      '--- a/my dir/file name.txt',
      '+++ b/my dir/file name.txt',
      '@@ -1 +1 @@',
      '-x',
      '+y',
      '',
    ].join('\n');

    const [file] = parseUnifiedDiff(raw);
    expect(file.path).toBe('my dir/file name.txt');
  });

  it('unquotes git-escaped paths', () => {
    expect(unquotePath('"a/dosya\\303\\247.txt"')).toBe('a/dosyaç.txt');
    expect(unquotePath('plain.txt')).toBe('plain.txt');
  });

  it('marks lockfiles and build output as generated', () => {
    expect(isGenerated('package-lock.json')).toBe(true);
    expect(isGenerated('web/dist/app.js')).toBe(true);
    expect(isGenerated('src/app.ts')).toBe(false);
  });

  it('returns nothing for an empty diff', () => {
    expect(parseUnifiedDiff('')).toEqual([]);
  });
});
