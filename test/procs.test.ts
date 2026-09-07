import { describe, expect, it } from 'vitest';
import { classify, parsePs, pickStrays } from '../src/cli/procs.js';

// a process table as seen on a laptop that ran several marj versions over a week
const PS = `
    1     0  0 /sbin/launchd
  500     1 501 /bin/zsh -l
  600   500 501 node /Users/me/.nvm/versions/node/v20/bin/marj stop --all
 9719     1 501 node /Users/me/.nvm/versions/node/v20/bin/marj --json --no-open https://github.com/o/r/pull/1921
14030     1 501 /Users/me/.nvm/versions/node/v20/bin/node /Users/me/personal/marj/dist/server/cli/index.js hub
14256   700 501 node /Users/me/.nvm/versions/node/v20/bin/marj watch
16271   701 501 node /Users/me/.npm/_npx/8f2a/node_modules/.bin/marj watch --session pr-42
33480     1 501 node /Users/me/personal/marj/dist/server/cli/index.js --json --no-open --no-watch --port 4890
68654   702 501 node /Users/me/personal/marj/dist/server/cli/index.js --port 4870 watch --cursor 0 --timeout 1
70001     1 501 node --enable-source-maps /Users/me/w/node_modules/@vagonhq/marj/dist/server/cli/index.js --json
70002     1 501 node /Users/me/w/other-tool/dist/server/cli/index.js serve
70003     1 501 vim /Users/me/personal/marj/README.md
70004     1 501 /Applications/Code.app/Contents/MacOS/Electron /Users/me/personal/marj
70005     1 502 node /usr/local/bin/marj watch
70006     1 501 node /Users/me/personal/marj/dist/server/cli/index.js
`;

describe('parsePs', () => {
  it('reads pid, ppid, uid and the full command line', () => {
    const rows = parsePs(PS);
    expect(rows[0]).toEqual({ pid: 1, ppid: 0, uid: 0, args: '/sbin/launchd' });
    expect(rows.find((r) => r.pid === 68654)?.args).toBe(
      'node /Users/me/personal/marj/dist/server/cli/index.js --port 4870 watch --cursor 0 --timeout 1',
    );
    expect(rows).toHaveLength(15);
  });
});

describe('classify', () => {
  it('recognises the marj bin and the package entry, under any node', () => {
    expect(classify('node /Users/me/.nvm/versions/node/v20/bin/marj watch')).toBe('watch');
    expect(classify('/usr/local/bin/node /x/marj/dist/server/cli/index.js hub')).toBe('hub');
    expect(classify('node --enable-source-maps /x/node_modules/@vagonhq/marj/dist/server/cli/index.js --json')).toBe('server');
    expect(classify('node /Users/me/.npm/_npx/8f2a/node_modules/.bin/marj --json --no-open')).toBe('server');
    expect(classify('node20 /opt/marj/bin/marj')).toBe('server');
  });

  it('accepts the CLI entry it was told about, wherever it lives', () => {
    expect(classify('node /opt/tools/review/dist/server/cli/index.js hub', '/opt/tools/review/dist/server/cli/index.js')).toBe('hub');
  });

  it('ignores everything that merely mentions marj', () => {
    expect(classify('vim /Users/me/personal/marj/README.md')).toBeNull();
    expect(classify('/Applications/Code.app/Contents/MacOS/Electron /Users/me/personal/marj')).toBeNull();
    expect(classify('node /Users/me/w/other-tool/dist/server/cli/index.js serve')).toBeNull();
    expect(classify('npm exec -y @vagonhq/marj@latest -- watch')).toBeNull();
    expect(classify('bash /Users/me/.claude/plugins/marj/bin/marj watch')).toBeNull();
    expect(classify('')).toBeNull();
  });
});

describe('pickStrays', () => {
  const rows = parsePs(PS);

  it('lists every marj process of this user except the caller and its ancestors', () => {
    const strays = pickStrays(rows, { self: 600, uid: 501 });
    expect(strays.map((p) => [p.pid, p.kind])).toEqual([
      [9719, 'server'],
      [14030, 'hub'],
      [14256, 'watch'],
      [16271, 'watch'],
      [33480, 'server'],
      [68654, 'watch'],
      [70001, 'server'],
      [70006, 'server'],
    ]);
  });

  it('leaves other users alone', () => {
    const strays = pickStrays(rows, { self: 600, uid: 501 });
    expect(strays.some((p) => p.pid === 70005)).toBe(false);
    expect(pickStrays(rows, { self: 600 }).some((p) => p.pid === 70005)).toBe(true);
  });

  it('never lists the caller, even when the caller is itself a marj process', () => {
    // a `marj watch` asking (say via a future subcommand) must not be told to kill itself or its shell
    const strays = pickStrays(rows, { self: 14256, uid: 501 });
    expect(strays.some((p) => p.pid === 14256)).toBe(false);
    expect(strays.some((p) => p.pid === 600)).toBe(true);
  });

  it('skips the ancestor chain, which may pass through a marj wrapper', () => {
    const table = parsePs(`
  10   1 501 /bin/zsh
  20  10 501 node /Users/me/.nvm/versions/node/v20/bin/marj watch
  30  20 501 node /Users/me/personal/marj/dist/server/cli/index.js stop --all
  40   1 501 node /Users/me/personal/marj/dist/server/cli/index.js hub
`);
    expect(pickStrays(table, { self: 30, uid: 501 }).map((p) => p.pid)).toEqual([40]);
  });
});
