import type { Side } from '../../shared/types';

/** The line (or range) the reviewer is about to comment on. */
export interface DraftTarget {
  file: string;
  side: Side;
  startLine: number;
  endLine: number;
}
