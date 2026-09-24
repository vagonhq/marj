import { describe, expect, it } from 'vitest';
import { hasSuggestion, splitSuggestions } from '../src/client/suggestions.js';
import { appliedSuggestionOf, applySuggestionPrompt, EXPLAIN_PROMPT, reviewLevelOf, reviewPrompt } from '../src/shared/types.js';

describe('splitSuggestions', () => {
  it('pulls a ```suggestion block out of the markdown around it', () => {
    const body = ['`user` can be null here.', '', '```suggestion', '  if (!user) return;', '  use(user);', '```', '', 'Also rename it.'].join('\n');
    expect(splitSuggestions(body)).toEqual([
      { kind: 'markdown', text: '`user` can be null here.\n' },
      { kind: 'suggestion', lines: ['  if (!user) return;', '  use(user);'] },
      { kind: 'markdown', text: '\nAlso rename it.' },
    ]);
    expect(hasSuggestion(body)).toBe(true);
  });

  it('leaves ordinary code fences alone', () => {
    const body = 'try\n```ts\nconst a = 1;\n```\ninstead';
    expect(splitSuggestions(body)).toEqual([{ kind: 'markdown', text: body }]);
    expect(hasSuggestion(body)).toBe(false);
  });

  it('keeps an empty suggestion (delete these lines) and runs an unterminated one to the end', () => {
    expect(splitSuggestions('drop it\n```suggestion\n```')).toEqual([
      { kind: 'markdown', text: 'drop it' },
      { kind: 'suggestion', lines: [] },
    ]);
    expect(splitSuggestions('```suggestion\nx\ny')).toEqual([{ kind: 'suggestion', lines: ['x', 'y'] }]);
  });

  it('accepts ~~~ fences and longer backtick runs', () => {
    expect(splitSuggestions('~~~suggestion\na\n~~~')).toEqual([{ kind: 'suggestion', lines: ['a'] }]);
    expect(splitSuggestions('````suggestion\n```\n````')).toEqual([{ kind: 'suggestion', lines: ['```'] }]);
  });
});

describe('review prompts', () => {
  it('carries the level in the text and reads it back', () => {
    for (const level of ['low', 'medium', 'high', 'xhigh', 'max'] as const) {
      expect(reviewLevelOf(reviewPrompt(level))).toBe(level);
    }
    expect(reviewLevelOf(EXPLAIN_PROMPT)).toBeNull();
    expect(reviewLevelOf(applySuggestionPrompt('t3m1', 1))).toBeNull();
    expect(reviewLevelOf('Review these changes at effort level "bogus".')).toBeNull();
  });

  it('names the message and block an "Apply suggestion" click is about', () => {
    expect(appliedSuggestionOf(applySuggestionPrompt('t3m1', 2))).toEqual({ messageId: 't3m1', block: 2 });
    expect(appliedSuggestionOf(EXPLAIN_PROMPT)).toBeNull();
    expect(appliedSuggestionOf('Apply suggestion please')).toBeNull();
  });
});
