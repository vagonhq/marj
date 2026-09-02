import { marked } from 'marked';

marked.setOptions({ gfm: true, breaks: true });

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

/**
 * Agent replies are markdown. Raw HTML is escaped before parsing so nothing
 * the agent (or a pasted snippet) writes can inject markup.
 */
export function renderMarkdown(text: string): string {
  return marked.parse(escapeHtml(text), { async: false }) as string;
}
