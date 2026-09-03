import { describe, expect, it } from 'vitest';
import { buildLocationIndex, findLocations } from '../src/client/locations.js';

const index = buildLocationIndex(['src/app/users.rb', 'src/app.js', 'lib/app.js', 'README.md']);
const find = (text: string) => findLocations(text, index).map(({ file, line, endLine }) => ({ file, line, endLine }));

describe('locations in chat replies', () => {
  it('links full paths with a line or a range', () => {
    expect(find('see src/app/users.rb:34 and src/app/users.rb:40-42')).toEqual([
      { file: 'src/app/users.rb', line: 34, endLine: 34 },
      { file: 'src/app/users.rb', line: 40, endLine: 42 },
    ]);
  });

  it('links a bare path with no line', () => {
    expect(find('README.md was rewritten.')).toEqual([{ file: 'README.md', line: null, endLine: null }]);
  });

  it('resolves a basename only when it is unambiguous', () => {
    expect(find('users.rb:12 does the lookup')).toEqual([{ file: 'src/app/users.rb', line: 12, endLine: 12 }]);
    expect(find('app.js:3 is shared')).toEqual([]); // src/app.js vs lib/app.js
    expect(find('lib/app.js:3')).toEqual([{ file: 'lib/app.js', line: 3, endLine: 3 }]);
  });

  it('does not match inside longer words or paths', () => {
    expect(find('the README.md.bak copy and src/app.json')).toEqual([]);
    expect(find('other/src/app.js:1')).toEqual([]);
  });

  it('reports offsets for splicing', () => {
    const [match] = findLocations('at src/app.js:7.', index);
    expect(match.start).toBe(3);
    expect(match.end).toBe(15);
  });
});
