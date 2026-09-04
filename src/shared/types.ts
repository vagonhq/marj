export type LineType = 'context' | 'add' | 'del';
export type Side = 'old' | 'new';

export interface DiffLine {
  type: LineType;
  /** 1-based line number in the pre-image, null for added lines */
  oldNo: number | null;
  /** 1-based line number in the post-image, null for deleted lines */
  newNo: number | null;
  text: string;
  /** true when git reported "\ No newline at end of file" right after this line */
  noNewline?: boolean;
}

export interface DiffHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  /** the text after the second @@, usually the enclosing function */
  section: string;
  lines: DiffLine[];
}

export type FileStatus = 'added' | 'deleted' | 'modified' | 'renamed';

export interface DiffFile {
  /** post-image path (pre-image path for deleted files) */
  path: string;
  /** pre-image path when it differs (renames), else null */
  oldPath: string | null;
  status: FileStatus;
  binary: boolean;
  additions: number;
  deletions: number;
  hunks: DiffHunk[];
  /** true when marj thinks this is generated/lock output and collapses it by default */
  generated: boolean;
}

export interface DiffPayload {
  /** human readable description of what is being diffed */
  mode: string;
  /** the git revision arguments actually used */
  args: string[];
  repoRoot: string;
  files: DiffFile[];
  /** bumped every time the diff is recomputed */
  version: number;
  computedAt: string;
  /** git config user.name, for the reviewer's avatar */
  author: string;
}

export type Role = 'user' | 'agent';

/** What the reviewer wants back: an answer, or an answer plus the fix. */
export type Intent = 'ask' | 'fix';

export interface Message {
  id: string;
  role: Role;
  body: string;
  createdAt: string;
  seq: number;
  /** set on user messages only */
  intent?: Intent;
}

export type ThreadStatus = 'open' | 'answered' | 'resolved' | 'outdated';

/**
 * Threads about the file as a whole carry no line: startLine and endLine are 0.
 * Diff line numbers start at 1, so 0 never collides with a real position.
 */
export const FILE_LEVEL = 0;

export const isFileLevel = (target: { startLine: number }): boolean => target.startLine === FILE_LEVEL;

/**
 * The review chat: one conversation about the change as a whole, not tied to
 * a file. Stored as a thread with a fixed id so the agent can `marj reply chat`.
 */
export const CHAT_THREAD = 'chat';

export const isChat = (thread: { id: string }): boolean => thread.id === CHAT_THREAD;

/** What the "Explain these changes" button sends into the chat. */
export const EXPLAIN_PROMPT =
  'Explain what these changes do as a whole: the goal, then file by file what was added or changed and why. ' +
  'Point at the code with `path:line` references so I can jump to them.';

/** What the "Ask Claude to commit & push" button sends into the chat. */
export const COMMIT_PROMPT =
  'Commit the uncommitted changes from this review with a clear, conventional commit message, then push them.';

/** "src/a.ts:12-15", "src/a.ts:12", or just "src/a.ts" for a file-level thread */
export function describeTarget(target: { file: string; startLine: number; endLine: number }): string {
  if (isFileLevel(target)) return target.file;
  const range =
    target.startLine === target.endLine ? `${target.startLine}` : `${target.startLine}-${target.endLine}`;
  return `${target.file}:${range}`;
}

export interface Anchor {
  /** the commented lines themselves */
  text: string[];
  /** up to 3 lines before */
  before: string[];
  /** up to 3 lines after */
  after: string[];
}

export interface Thread {
  id: string;
  file: string;
  side: Side;
  startLine: number;
  endLine: number;
  anchor: Anchor;
  status: ThreadStatus;
  agentTyping: boolean;
  createdAt: string;
  updatedAt: string;
  messages: Message[];
  /** diff version the thread was last successfully anchored against */
  anchoredVersion: number;
}

/** One line of the agent's inbox: a user message that has not been answered yet. */
export interface AgentEvent {
  seq: number;
  threadId: string;
  messageId: string;
  /** `chat` for messages in the review chat, which has no file */
  kind: 'new-thread' | 'reply' | 'chat';
  file: string;
  side: Side;
  startLine: number;
  endLine: number;
  body: string;
  intent: Intent;
  status: ThreadStatus;
  createdAt: string;
}

export interface WaitResponse {
  cursor: number;
  events: AgentEvent[];
}

export interface ServerInfo {
  port: number;
  url: string;
  pid: number;
  repoRoot: string;
  cwd: string;
  mode: string;
  startedAt: string;
  /** the isolated session this server serves, or undefined for the default one */
  session?: string;
  /** the hub mounts this review under /r/<id> */
  id?: string;
  /** marj version of the hub serving it */
  version?: string;
}

/** What is in the working tree but not in HEAD — the fixes of this review, plus anything else uncommitted. */
export interface WorktreeState {
  /** branch the working tree is on; null when detached or the repo has no commits */
  branch: string | null;
  /** branch whose code the review shows, when the review is of a branch */
  reviewedBranch: string | null;
  /** false when a fix made now would land on a different branch than the one being reviewed */
  onReviewedBranch: boolean;
  /** pull request number when reviewing a PR */
  pr: number | null;
  files: DiffFile[];
  /** paths modified since the review server started — what changed during this review */
  touched: string[];
  version: number;
}

/** One marj server (or a repo with saved reviews but no server), for the repo switcher. */
export interface ServerListing {
  /** hub mount id (/r/<id>) when it is being served, null for a stopped repo */
  id: string | null;
  /** repo folder name, e.g. "vagon-frontend" or a worktree's folder */
  name: string;
  repoRoot: string;
  /** the isolated session, if any */
  session: string | null;
  /** what it is reviewing, e.g. "develop...feature (working tree)"; empty when not running */
  mode: string;
  /** browser URL when a server is up */
  url: string | null;
  live: boolean;
  /** the server the browser is talking to right now */
  current: boolean;
  /** git branch checked out there, when known */
  branch: string | null;
}

export type ServerEvent =
  | { type: 'diff:changed'; version: number }
  | { type: 'threads:changed'; cursor: number }
  | { type: 'hello'; cursor: number; version: number };
