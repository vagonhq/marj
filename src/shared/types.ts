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
  kind: 'new-thread' | 'reply';
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
}

export type ServerEvent =
  | { type: 'diff:changed'; version: number }
  | { type: 'threads:changed'; cursor: number }
  | { type: 'hello'; cursor: number; version: number };
