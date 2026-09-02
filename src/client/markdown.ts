import { marked } from 'marked';
import { escapeHtml } from './highlight.js';

marked.setOptions({ gfm: true, breaks: true });

/**
 * Agent replies are markdown. Raw HTML is escaped before parsing so nothing
 * the agent (or a pasted snippet) writes can inject markup.
 */
export function renderMarkdown(text: string): string {
  return marked.parse(escapeHtml(text), { async: false }) as string;
}
