/**
 * GitHub-style suggested changes: a fenced ```suggestion block in a comment
 * proposes a replacement for the lines the thread is on. The UI draws it as a
 * small diff with an "Apply suggestion" button instead of a plain code block.
 */
export type Segment = { kind: 'markdown'; text: string } | { kind: 'suggestion'; lines: string[] };

const FENCE = /^([ \t]*)(`{3,}|~{3,})[ \t]*suggestion[ \t]*$/;

/** The comment body split into markdown runs and suggestion blocks, in order. */
export function splitSuggestions(body: string): Segment[] {
  const out: Segment[] = [];
  const lines = body.split('\n');
  let text: string[] = [];
  const flush = () => {
    const chunk = text.join('\n');
    if (chunk.trim()) out.push({ kind: 'markdown', text: chunk });
    text = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const open = lines[i].match(FENCE);
    if (!open) {
      text.push(lines[i]);
      continue;
    }
    const fence = open[2];
    // the block runs to the next line that is just the same fence (an unterminated block runs to the end)
    let end = i + 1;
    while (end < lines.length && lines[end].trim() !== fence) end++;
    flush();
    out.push({ kind: 'suggestion', lines: lines.slice(i + 1, end) });
    i = end;
  }
  flush();
  return out;
}

export const hasSuggestion = (body: string): boolean => splitSuggestions(body).some((s) => s.kind === 'suggestion');
