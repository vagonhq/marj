import type { DiffFile } from '../shared/types';

export interface DirNode {
  kind: 'dir';
  /** the segment(s) shown on this row, e.g. "src/api" when the chain is single-child */
  name: string;
  path: string;
  children: TreeNode[];
}

export interface FileNode {
  kind: 'file';
  name: string;
  file: DiffFile;
}

export type TreeNode = DirNode | FileNode;

function insert(root: DirNode, file: DiffFile): void {
  const segments = file.path.split('/');
  const name = segments.pop()!;
  let node = root;
  let prefix = '';
  for (const segment of segments) {
    prefix = prefix ? `${prefix}/${segment}` : segment;
    let next = node.children.find((c): c is DirNode => c.kind === 'dir' && c.path === prefix);
    if (!next) {
      next = { kind: 'dir', name: segment, path: prefix, children: [] };
      node.children.push(next);
    }
    node = next;
  }
  node.children.push({ kind: 'file', name, file });
}

/** src → api → users.ts collapses to a single "src/api" row, like GitHub's tree. */
function squash(node: DirNode): DirNode {
  const children = node.children.map((child) => (child.kind === 'dir' ? squash(child) : child));
  if (children.length === 1 && children[0].kind === 'dir') {
    const only = children[0];
    return { kind: 'dir', name: `${node.name}/${only.name}`, path: only.path, children: only.children };
  }
  return { ...node, children };
}

function sortNodes(nodes: TreeNode[]): TreeNode[] {
  return [...nodes]
    .sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === 'dir' ? -1 : 1;
      return a.name.localeCompare(b.name);
    })
    .map((node) => (node.kind === 'dir' ? { ...node, children: sortNodes(node.children) } : node));
}

export function buildTree(files: DiffFile[]): TreeNode[] {
  const root: DirNode = { kind: 'dir', name: '', path: '', children: [] };
  for (const file of files) insert(root, file);
  return sortNodes(squash(root).children);
}

/**
 * The files in the order the tree shows them — directories first, then
 * alphabetical — so the diff stream on the right reads top to bottom in the
 * same order as the sidebar on the left.
 */
export function flattenTree(nodes: TreeNode[]): DiffFile[] {
  const out: DiffFile[] = [];
  const walk = (list: TreeNode[]) => {
    for (const node of list) {
      if (node.kind === 'file') out.push(node.file);
      else walk(node.children);
    }
  };
  walk(nodes);
  return out;
}
