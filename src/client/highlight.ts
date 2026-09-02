import { bundledLanguages, createHighlighter, type BundledLanguage, type Highlighter } from 'shiki';
import type { DiffFile } from '../shared/types';

/** One coloured run of text; `style` carries --shiki-light / --shiki-dark. */
export interface Token {
  text: string;
  style?: Record<string, string>;
}

export type TokenLine = Token[];

const THEMES = { light: 'github-light-default', dark: 'github-dark-default' } as const;

const BY_EXTENSION: Record<string, string> = {
  ts: 'typescript', mts: 'typescript', cts: 'typescript', tsx: 'tsx',
  js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'jsx',
  rb: 'ruby', erb: 'erb', rake: 'ruby', gemspec: 'ruby', ru: 'ruby',
  py: 'python', go: 'go', rs: 'rust', java: 'java', kt: 'kotlin', kts: 'kotlin', scala: 'scala',
  swift: 'swift', m: 'objective-c', c: 'c', h: 'c', cc: 'cpp', cpp: 'cpp', hpp: 'cpp', cs: 'csharp',
  php: 'php', sh: 'bash', bash: 'bash', zsh: 'zsh', fish: 'fish', ps1: 'powershell',
  json: 'json', jsonc: 'jsonc', json5: 'json5', yml: 'yaml', yaml: 'yaml', toml: 'toml', ini: 'ini',
  md: 'markdown', mdx: 'mdx', html: 'html', htm: 'html', xml: 'xml', svg: 'xml', plist: 'xml',
  css: 'css', scss: 'scss', sass: 'sass', less: 'less', styl: 'stylus',
  sql: 'sql', graphql: 'graphql', gql: 'graphql', prisma: 'prisma', proto: 'proto',
  vue: 'vue', svelte: 'svelte', astro: 'astro', hbs: 'handlebars', ejs: 'html', pug: 'pug',
  tf: 'terraform', hcl: 'hcl', nix: 'nix', lua: 'lua', dart: 'dart', ex: 'elixir', exs: 'elixir',
  hs: 'haskell', clj: 'clojure', r: 'r', jl: 'julia', pl: 'perl', zig: 'zig', dockerfile: 'dockerfile',
  diff: 'diff', patch: 'diff', csv: 'csv', env: 'dotenv', txt: 'plaintext', log: 'log',
};

const BY_FILENAME: Record<string, string> = {
  Dockerfile: 'dockerfile', Makefile: 'makefile', Gemfile: 'ruby', Rakefile: 'ruby', Podfile: 'ruby',
  Fastfile: 'ruby', Brewfile: 'ruby', Guardfile: 'ruby', Procfile: 'yaml', '.env': 'dotenv',
  '.gitignore': 'ini', '.gitattributes': 'ini', '.editorconfig': 'ini', 'CMakeLists.txt': 'cmake',
};

export function languageOf(path: string): string | null {
  const name = path.split('/').pop() ?? path;
  const direct = BY_FILENAME[name];
  if (direct) return direct in bundledLanguages ? direct : null;
  if (name.startsWith('Dockerfile')) return 'dockerfile';
  const ext = name.includes('.') ? name.split('.').pop()!.toLowerCase() : '';
  const lang = BY_EXTENSION[ext];
  return lang && lang in bundledLanguages ? lang : null;
}

let highlighter: Promise<Highlighter> | null = null;
const loading = new Map<string, Promise<void>>();

async function ready(lang: string): Promise<Highlighter> {
  highlighter ??= createHighlighter({ themes: [THEMES.light, THEMES.dark], langs: [] });
  const h = await highlighter;
  if (!h.getLoadedLanguages().includes(lang)) {
    let pending = loading.get(lang);
    if (!pending) {
      pending = h.loadLanguage(lang as BundledLanguage);
      loading.set(lang, pending);
    }
    await pending;
  }
  return h;
}

export const lineKey = (side: 'old' | 'new', no: number) => `${side}:${no}`;

/**
 * Highlight every hunk of a file, each side as one continuous block so that
 * multi-line strings and comments keep their state across lines — which is
 * what per-line highlighting could never get right. Keys are `old:<no>` and
 * `new:<no>`; context lines are present on both sides.
 */
export async function highlightFile(file: DiffFile, lang: string): Promise<Map<string, TokenLine>> {
  const h = await ready(lang);
  const out = new Map<string, TokenLine>();

  for (const hunk of file.hunks) {
    const sides = [
      ['old', hunk.lines.filter((l) => l.type !== 'add')],
      ['new', hunk.lines.filter((l) => l.type !== 'del')],
    ] as const;

    for (const [side, lines] of sides) {
      if (lines.length === 0) continue;
      const { tokens } = h.codeToTokens(lines.map((l) => l.text).join('\n'), {
        lang: lang as BundledLanguage,
        themes: THEMES,
        defaultColor: false,
      });
      lines.forEach((line, index) => {
        const no = side === 'old' ? line.oldNo : line.newNo;
        if (no === null) return;
        out.set(
          lineKey(side, no),
          (tokens[index] ?? []).map((t) => ({ text: t.content, style: t.htmlStyle as Record<string, string> | undefined })),
        );
      });
    }
  }
  return out;
}
