import { describe, expect, it } from 'vitest';
import { renderMarkdown } from '../src/client/markdown.js';

describe('renderMarkdown', () => {
  it('renders quotes inside inline code without double-escaping', () => {
    const html = renderMarkdown('set `GlobalVersion = "20.6.1.0"` here');
    // the code span holds a real quote entity, not a literal &quot; the user can read
    expect(html).toContain('<code>');
    expect(html).toContain('&quot;20.6.1.0&quot;');
    expect(html).not.toContain('&amp;quot;');
  });

  it('keeps plain-text quotes and angle brackets readable', () => {
    const html = renderMarkdown('use "x" when a < b');
    expect(html).not.toContain('&amp;');
    expect(html).toContain('&lt;'); // a < b escaped once
  });

  it('neutralises raw HTML so replies cannot inject markup', () => {
    const html = renderMarkdown('hi <img src=x onerror=alert(1)> there');
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;img');
  });

  it('still renders normal markdown', () => {
    const html = renderMarkdown('**bold** and a [link](https://example.com)');
    expect(html).toContain('<strong>bold</strong>');
    expect(html).toContain('href="https://example.com"');
  });
});
