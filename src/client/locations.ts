/**
 * Turn `path:line` mentions in chat replies into jump targets.
 *
 * The agent is asked to reference code as `src/a.ts:42`, but people (and
 * models) also write `a.ts:42` or just `src/a.ts`, so a mention resolves when
 * it is a full path from the diff or a basename that belongs to exactly one
 * file in it.
 */

export interface Location {
  /** the diff file's post-image path */
  file: string;
  line: number | null;
  endLine: number | null;
}

export interface LocationMatch extends Location {
  start: number;
  end: number;
}

export interface LocationIndex {
  pattern: RegExp | null;
  resolve: Map<string, string>;
}

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');

export function buildLocationIndex(paths: string[]): LocationIndex {
  const resolve = new Map<string, string>();
  const byBase = new Map<string, string[]>();
  for (const path of paths) {
    resolve.set(path, path);
    const base = path.split('/').pop()!;
    byBase.set(base, [...(byBase.get(base) ?? []), path]);
  }
  for (const [base, owners] of byBase) {
    if (owners.length === 1 && !resolve.has(base)) resolve.set(base, owners[0]);
  }
  if (resolve.size === 0) return { pattern: null, resolve };

  // longest first so `src/app.js` wins over `app.js`
  const keys = [...resolve.keys()].sort((a, b) => b.length - a.length).map(escape);
  // `README.md.` at the end of a sentence still matches; `README.md.bak` and `src/app.json` do not
  const pattern = new RegExp(`(?<![\\w./-])(${keys.join('|')})(?::(\\d+)(?:[-–](\\d+))?)?(?!\\.?[\\w/])`, 'g');
  return { pattern, resolve };
}

export function findLocations(text: string, index: LocationIndex): LocationMatch[] {
  if (!index.pattern) return [];
  const out: LocationMatch[] = [];
  for (const match of text.matchAll(index.pattern)) {
    const file = index.resolve.get(match[1]);
    if (!file) continue;
    const line = match[2] ? Number(match[2]) : null;
    out.push({
      file,
      line,
      endLine: match[3] ? Number(match[3]) : line,
      start: match.index!,
      end: match.index! + match[0].length,
    });
  }
  return out;
}

/**
 * Wrap every location mention inside `root` in an anchor. Works on text nodes,
 * so mentions inside inline code (the agent's favourite) are linked too.
 */
export function linkifyLocations(root: HTMLElement, index: LocationIndex): void {
  if (!index.pattern) return;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) => {
      const parent = node.parentElement;
      if (!parent || parent.closest('a, pre')) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  const targets: Text[] = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) targets.push(node as Text);

  for (const node of targets) {
    const text = node.data;
    const matches = findLocations(text, index);
    if (matches.length === 0) continue;
    const frag = document.createDocumentFragment();
    let cursor = 0;
    for (const match of matches) {
      if (match.start > cursor) frag.append(text.slice(cursor, match.start));
      const a = document.createElement('a');
      a.href = '#';
      a.className = 'loc';
      a.textContent = text.slice(match.start, match.end);
      a.dataset.file = match.file;
      if (match.line !== null) a.dataset.line = String(match.line);
      a.title = match.line === null ? `Jump to ${match.file}` : `Jump to ${match.file} line ${match.line}`;
      frag.append(a);
      cursor = match.end;
    }
    if (cursor < text.length) frag.append(text.slice(cursor));
    node.replaceWith(frag);
  }
}
