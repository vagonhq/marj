import { execFile } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

/**
 * Finding marj processes the hub does not know about.
 *
 * `marj stop --all` used to kill only the hub named in ~/.marj/hub.json. That leaves
 * behind whatever else is marj on this machine: standalone servers from versions that
 * predate the hub (each on its own port, so the hub then comes up on 4713 instead of
 * 4711), a hub whose hub.json was overwritten, and `marj watch` loops whose server is
 * long gone. This module reads the process table so `stop --all` can sweep them too.
 */

export type MarjKind = 'hub' | 'watch' | 'server';

export interface PsRow {
  pid: number;
  ppid: number;
  uid: number;
  args: string;
}

export interface MarjProcess extends PsRow {
  kind: MarjKind;
}

const CLI_ENTRY = fileURLToPath(new URL('./index.js', import.meta.url));

/** Rows of `ps -eo pid=,ppid=,uid=,args=` (no header, whitespace separated, args last). */
export function parsePs(output: string): PsRow[] {
  const rows: PsRow[] = [];
  for (const line of output.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (m) rows.push({ pid: Number(m[1]), ppid: Number(m[2]), uid: Number(m[3]), args: m[4].trim() });
  }
  return rows;
}

// the script node was given: a `marj` bin (global install, nvm, npx's .bin) or the
// package's own CLI entry (a dev checkout or node_modules/@vagonhq/marj)
const MARJ_SCRIPT = /(^|\/)(marj|marj\/dist\/server\/cli\/index\.js)$/;

/** What kind of marj process this command line is, or null when it is not marj at all. */
export function classify(args: string, entry: string = CLI_ENTRY): MarjKind | null {
  const tokens = args.split(/\s+/).filter(Boolean);
  if (tokens.length < 2) return null;
  if (!/^node(\d+)?(\.exe)?$/.test(path.basename(tokens[0]))) return null;
  let i = 1;
  while (i < tokens.length && tokens[i].startsWith('-')) i++; // node's own flags, e.g. --enable-source-maps
  const script = tokens[i];
  if (!script || !(MARJ_SCRIPT.test(script) || script === entry)) return null;
  const rest = tokens.slice(i + 1);
  if (rest.includes('hub')) return 'hub';
  if (rest.includes('watch')) return 'watch';
  // `marj` itself returns at once since the hub exists, so a long-lived one is an old standalone server
  return 'server';
}

/**
 * The marj processes worth stopping: every one owned by this user, except this
 * process and its ancestors (the shell, an npx wrapper, the agent that ran us).
 */
export function pickStrays(rows: PsRow[], opts: { self: number; uid?: number; entry?: string }): MarjProcess[] {
  const byPid = new Map(rows.map((r) => [r.pid, r]));
  const skip = new Set<number>([opts.self]);
  for (let pid = byPid.get(opts.self)?.ppid ?? 0; pid > 1 && byPid.has(pid) && !skip.has(pid); pid = byPid.get(pid)!.ppid) {
    skip.add(pid);
  }
  const out: MarjProcess[] = [];
  for (const row of rows) {
    if (skip.has(row.pid)) continue;
    if (opts.uid !== undefined && row.uid !== opts.uid) continue;
    const kind = classify(row.args, opts.entry);
    if (kind) out.push({ ...row, kind });
  }
  return out.sort((a, b) => a.pid - b.pid);
}

/** Every stray marj process on this machine (empty where there is no `ps`, e.g. Windows). */
export async function strayMarjProcesses(): Promise<MarjProcess[]> {
  let stdout: string;
  try {
    ({ stdout } = await promisify(execFile)('ps', ['-eo', 'pid=,ppid=,uid=,args='], { maxBuffer: 32 * 1024 * 1024 }));
  } catch {
    return [];
  }
  return pickStrays(parsePs(stdout), { self: process.pid, uid: process.getuid?.() });
}

export const pidAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * SIGTERM each pid and wait for them to exit; whatever is still there after
 * `graceMs` gets SIGKILL. Returns the pids that had to be killed hard.
 */
export async function terminate(pids: number[], graceMs = 3000): Promise<number[]> {
  for (const pid of pids) {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      /* already gone */
    }
  }
  const deadline = Date.now() + graceMs;
  let alive = pids.filter(pidAlive);
  while (alive.length > 0 && Date.now() < deadline) {
    await sleep(100);
    alive = alive.filter(pidAlive);
  }
  for (const pid of alive) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      /* gone in the meantime */
    }
  }
  return alive;
}
