import type { DiffFile, DiffHunk, DiffLine, FileStatus } from '../shared/types.js';

const GENERATED_PATTERNS: RegExp[] = [
  /(^|\/)(package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|Cargo\.lock|poetry\.lock|Gemfile\.lock|composer\.lock|go\.sum|Podfile\.lock|flake\.lock)$/,
  /(^|\/)(dist|build|out|vendor|node_modules|coverage|\.next|__snapshots__)\//,
  /\.(min\.(js|css)|map|snap)$/,
  /(^|\/)(pnpm-workspace\.yaml)$/,
];

export function isGenerated(path: string): boolean {
  return GENERATED_PATTERNS.some((re) => re.test(path));
}

/**
 * git quotes paths containing control chars, spaces at the edges, quotes or
 * non-ascii bytes (unless core.quotePath=false). Undo that.
 */
export function unquotePath(raw: string): string {
  if (!raw.startsWith('"')) return raw;
  const body = raw.slice(1, raw.endsWith('"') ? -1 : undefined);
  const bytes: number[] = [];
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (ch !== '\\') {
      bytes.push(...new TextEncoder().encode(ch));
      continue;
    }
    const next = body[++i];
    if (next === undefined) break;
    if (next >= '0' && next <= '7') {
      const octal = next + (body[i + 1] ?? '') + (body[i + 2] ?? '');
      const match = /^[0-7]{1,3}/.exec(octal)![0];
      i += match.length - 1;
      bytes.push(parseInt(match, 8));
      continue;
    }
    const simple: Record<string, number> = {
      n: 10, t: 9, r: 13, f: 12, b: 8, v: 11, a: 7, '\\': 92, '"': 34,
    };
    bytes.push(simple[next] ?? next.charCodeAt(0));
  }
  return new TextDecoder().decode(new Uint8Array(bytes));
}

/** Strip the leading a/ or b/ prefix git adds, honouring quoted paths. */
function stripPrefix(raw: string): string {
  const path = unquotePath(raw.trim());
  if (path === '/dev/null') return path;
  return path.replace(/^[ab]\//, '');
}

const HUNK_RE = /^@@+ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@+(?: (.*))?$/;

function emptyFile(): DiffFile {
  return {
    path: '',
    oldPath: null,
    status: 'modified',
    binary: false,
    additions: 0,
    deletions: 0,
    hunks: [],
    generated: false,
  };
}

/**
 * Parse `git diff` (unified format, no colour) into a structured model.
 * Tolerates combined diffs by skipping them and unknown extended headers.
 */
export function parseUnifiedDiff(raw: string): DiffFile[] {
  const files: DiffFile[] = [];
  const lines = raw.split('\n');

  let file: DiffFile | null = null;
  let hunk: DiffHunk | null = null;
  let oldNo = 0;
  let newNo = 0;
  // paths seen in ---/+++ take precedence over the ambiguous `diff --git` line
  let headerOld: string | null = null;
  let headerNew: string | null = null;

  const finishFile = () => {
    if (!file) return;
    if (headerOld && headerNew) {
      if (headerOld === '/dev/null') {
        file.status = 'added';
        file.path = headerNew;
        file.oldPath = null;
      } else if (headerNew === '/dev/null') {
        file.status = 'deleted';
        file.path = headerOld;
        file.oldPath = null;
      } else if (file.status !== 'renamed') {
        file.path = headerNew;
        file.oldPath = null;
      }
    }
    file.generated = isGenerated(file.path);
    files.push(file);
    file = null;
    hunk = null;
    headerOld = null;
    headerNew = null;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (line.startsWith('diff --git ')) {
      finishFile();
      file = emptyFile();
      const rest = line.slice('diff --git '.length);
      const paths = splitDiffGitPaths(rest);
      if (paths) {
        file.oldPath = paths[0] === paths[1] ? null : paths[0];
        file.path = paths[1];
      }
      continue;
    }

    if (line.startsWith('diff --cc ') || line.startsWith('diff --combined ')) {
      // combined (merge) diffs are not supported; drop until the next file
      finishFile();
      file = null;
      continue;
    }

    if (!file) continue;

    if (hunk === null) {
      if (line.startsWith('new file mode')) { file.status = 'added'; continue; }
      if (line.startsWith('deleted file mode')) { file.status = 'deleted'; continue; }
      if (line.startsWith('rename from ')) {
        file.status = 'renamed';
        file.oldPath = stripPrefix(line.slice('rename from '.length));
        continue;
      }
      if (line.startsWith('rename to ')) {
        file.status = 'renamed';
        file.path = stripPrefix(line.slice('rename to '.length));
        continue;
      }
      if (line.startsWith('copy from ') || line.startsWith('copy to ')) continue;
      if (line.startsWith('index ') || line.startsWith('old mode') || line.startsWith('new mode') ||
          line.startsWith('similarity index') || line.startsWith('dissimilarity index')) continue;
      if (line.startsWith('Binary files ') || line.startsWith('GIT binary patch')) {
        file.binary = true;
        continue;
      }
      if (line.startsWith('--- ')) { headerOld = stripPrefix(line.slice(4)); continue; }
      if (line.startsWith('+++ ')) { headerNew = stripPrefix(line.slice(4)); continue; }
    }

    const hunkMatch = HUNK_RE.exec(line);
    if (hunkMatch) {
      hunk = {
        oldStart: Number(hunkMatch[1]),
        oldLines: hunkMatch[2] === undefined ? 1 : Number(hunkMatch[2]),
        newStart: Number(hunkMatch[3]),
        newLines: hunkMatch[4] === undefined ? 1 : Number(hunkMatch[4]),
        section: hunkMatch[5] ?? '',
        lines: [],
      };
      oldNo = hunk.oldStart;
      newNo = hunk.newStart;
      file.hunks.push(hunk);
      continue;
    }

    if (!hunk) continue;

    if (line.startsWith('\\')) {
      const last = hunk.lines[hunk.lines.length - 1];
      if (last) last.noNewline = true;
      continue;
    }

    const marker = line[0];
    const text = line.slice(1);
    let entry: DiffLine | null = null;
    if (marker === '+') {
      entry = { type: 'add', oldNo: null, newNo: newNo++, text };
      file.additions++;
    } else if (marker === '-') {
      entry = { type: 'del', oldNo: oldNo++, newNo: null, text };
      file.deletions++;
    } else if (marker === ' ') {
      entry = { type: 'context', oldNo: oldNo++, newNo: newNo++, text };
    } else if (line === '' && i < lines.length - 1) {
      // A bare empty line inside a hunk is an unchanged empty line whose
      // trailing space was stripped somewhere along the way. The very last
      // element is just the trailing newline of the diff itself.
      const consumed = countConsumed(hunk);
      if (consumed.old < hunk.oldLines || consumed.new < hunk.newLines) {
        entry = { type: 'context', oldNo: oldNo++, newNo: newNo++, text: '' };
      } else {
        hunk = null;
        continue;
      }
    } else {
      // anything else ends the hunk (e.g. trailing git output)
      hunk = null;
      continue;
    }
    hunk.lines.push(entry);
  }

  finishFile();
  return files;
}

function countConsumed(hunk: DiffHunk): { old: number; new: number } {
  let o = 0;
  let n = 0;
  for (const l of hunk.lines) {
    if (l.type !== 'add') o++;
    if (l.type !== 'del') n++;
  }
  return { old: o, new: n };
}

/**
 * `diff --git a/x b/y` — paths may contain spaces, and either side may be
 * quoted. Split on the a/ b/ prefixes rather than on whitespace.
 */
function splitDiffGitPaths(rest: string): [string, string] | null {
  if (rest.startsWith('"')) {
    const end = findQuoteEnd(rest);
    if (end > 0) {
      const first = rest.slice(0, end + 1);
      const second = rest.slice(end + 1).trim();
      return [stripPrefix(first), stripPrefix(second)];
    }
  }
  // unquoted: find " b/" that splits the string in a plausible way
  const idx = rest.indexOf(' b/');
  if (idx > 0) return [stripPrefix(rest.slice(0, idx)), stripPrefix(rest.slice(idx + 1))];
  const parts = rest.split(' ');
  if (parts.length >= 2) return [stripPrefix(parts[0]), stripPrefix(parts.slice(1).join(' '))];
  return null;
}

function findQuoteEnd(s: string): number {
  for (let i = 1; i < s.length; i++) {
    if (s[i] === '\\') { i++; continue; }
    if (s[i] === '"') return i;
  }
  return -1;
}
