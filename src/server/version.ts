import { readFileSync } from 'node:fs';

/** marj's own version, from the package.json this build ships in. */
export const VERSION: string = (() => {
  try {
    return (JSON.parse(readFileSync(new URL('../../../package.json', import.meta.url), 'utf8')) as { version: string }).version;
  } catch {
    return '0.0.0';
  }
})();
