import hljs from 'highlight.js/lib/common';

const BY_EXTENSION: Record<string, string> = {
  ts: 'typescript', tsx: 'typescript', mts: 'typescript', cts: 'typescript',
  js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
  rb: 'ruby', py: 'python', go: 'go', rs: 'rust', java: 'java', kt: 'kotlin',
  swift: 'swift', c: 'c', h: 'c', cc: 'cpp', cpp: 'cpp', hpp: 'cpp', cs: 'csharp',
  php: 'php', sh: 'bash', bash: 'bash', zsh: 'bash', fish: 'bash',
  json: 'json', yml: 'yaml', yaml: 'yaml', toml: 'ini', ini: 'ini',
  md: 'markdown', markdown: 'markdown', html: 'xml', xml: 'xml', svg: 'xml',
  css: 'css', scss: 'scss', less: 'less', sql: 'sql', graphql: 'graphql',
  dockerfile: 'dockerfile', erb: 'erb', vue: 'xml', svelte: 'xml',
};

const BY_FILENAME: Record<string, string> = {
  Dockerfile: 'dockerfile', Makefile: 'makefile', Gemfile: 'ruby', Rakefile: 'ruby',
};

export function languageOf(path: string): string | null {
  const name = path.split('/').pop() ?? path;
  if (BY_FILENAME[name]) return BY_FILENAME[name];
  const ext = name.includes('.') ? name.split('.').pop()!.toLowerCase() : '';
  const language = BY_EXTENSION[ext];
  return language && hljs.getLanguage(language) ? language : null;
}

const ENTITIES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (ch) => ENTITIES[ch]);
}

const cache = new Map<string, string>();

/**
 * Highlight a single diff line. Per-line highlighting loses state across
 * multi-line strings and comments, which is a fair trade for not needing the
 * whole file — the diff only ever gives us fragments.
 */
export function highlightLine(text: string, language: string | null): string {
  if (!language) return escapeHtml(text);
  const key = `${language} ${text}`;
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  let html: string;
  try {
    html = hljs.highlight(text, { language, ignoreIllegals: true }).value;
  } catch {
    html = escapeHtml(text);
  }
  if (cache.size > 20_000) cache.clear();
  cache.set(key, html);
  return html;
}
