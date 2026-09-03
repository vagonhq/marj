import { marked } from 'marked';

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

marked.setOptions({ gfm: true, breaks: true });

// Agent replies are untrusted markdown. Rather than pre-escaping the whole
// string (which double-escapes quotes and angle brackets inside code spans —
// `"x"` came out as `&quot;x&quot;`), let marked escape text and code the right
// way and only neutralise raw HTML tokens, so nothing can inject markup.
marked.use({
  renderer: {
    // block and inline HTML both arrive here; both tokens carry `.text`
    html: (token) => escapeHtml(typeof token === 'string' ? token : token.text),
  },
});

export function renderMarkdown(text: string): string {
  return marked.parse(text, { async: false }) as string;
}
