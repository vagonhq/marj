import { useMemo, useState } from 'react';
import type { DiffFile, Thread } from '../../shared/types';

/** Primer's folder glyph — the unicode folder characters render inconsistently. */
function FolderIcon() {
  return (
    <svg className="folder" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
      <path
        fill="currentColor"
        d="M1.75 1A1.75 1.75 0 0 0 0 2.75v10.5C0 14.216.784 15 1.75 15h12.5A1.75 1.75 0 0 0 16 13.25v-8.5A1.75 1.75 0 0 0 14.25 3h-6.5a.25.25 0 0 1-.2-.1l-.9-1.2C6.32 1.26 5.88 1 5.4 1Z"
      />
    </svg>
  );
}

interface Props {
  files: DiffFile[];
  threadsByFile: Map<string, Thread[]>;
  collapsedFiles: Set<string>;
  onSelect: (path: string) => void;
}

interface DirNode {
  kind: 'dir';
  /** the segment(s) shown on this row, e.g. "src/api" when the chain is single-child */
  name: string;
  path: string;
  children: Node[];
}

interface FileNode {
  kind: 'file';
  name: string;
  file: DiffFile;
}

type Node = DirNode | FileNode;

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

function sortNodes(nodes: Node[]): Node[] {
  return [...nodes]
    .sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === 'dir' ? -1 : 1;
      return a.name.localeCompare(b.name);
    })
    .map((node) => (node.kind === 'dir' ? { ...node, children: sortNodes(node.children) } : node));
}

function buildTree(files: DiffFile[]): Node[] {
  const root: DirNode = { kind: 'dir', name: '', path: '', children: [] };
  for (const file of files) insert(root, file);
  const squashed = squash(root);
  return sortNodes(squashed.children);
}

function countFiles(node: Node): number {
  return node.kind === 'file' ? 1 : node.children.reduce((sum, child) => sum + countFiles(child), 0);
}

const STATUS_LABEL: Record<DiffFile['status'], string> = {
  added: 'A',
  deleted: 'D',
  modified: 'M',
  renamed: 'R',
};

export function FileTree({ files, threadsByFile, collapsedFiles, onSelect }: Props) {
  const tree = useMemo(() => buildTree(files), [files]);
  const [folded, setFolded] = useState<Set<string>>(new Set());

  const toggle = (path: string) =>
    setFolded((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });

  const renderNode = (node: Node, depth: number) => {
    const indent = { paddingLeft: `${8 + depth * 14}px` };

    if (node.kind === 'dir') {
      const open = !folded.has(node.path);
      return (
        <li key={`d:${node.path}`}>
          <button className="tree-row dir" style={indent} onClick={() => toggle(node.path)}>
            <span className="twisty">{open ? '▾' : '▸'}</span>
            <FolderIcon />
            <span className="label">{node.name}</span>
            <span className="muted">{countFiles(node)}</span>
          </button>
          {open && <ul>{node.children.map((child) => renderNode(child, depth + 1))}</ul>}
        </li>
      );
    }

    const threads = threadsByFile.get(node.file.path) ?? [];
    const open = threads.filter((t) => t.status !== 'resolved').length;
    return (
      <li key={`f:${node.file.path}`}>
        <button
          className={`tree-row file${collapsedFiles.has(node.file.path) ? ' dim' : ''}`}
          style={indent}
          onClick={() => onSelect(node.file.path)}
          title={node.file.path}
        >
          <span className={`status ${node.file.status}`}>{STATUS_LABEL[node.file.status]}</span>
          <span className="label">{node.name}</span>
          {open > 0 && <span className="badge">{open}</span>}
          <span className="counts">
            <span className="add">+{node.file.additions}</span>
            <span className="del">−{node.file.deletions}</span>
          </span>
        </button>
      </li>
    );
  };

  return (
    <aside className="sidebar">
      <div className="sidebar-title">
        Files changed <span className="muted">{files.length}</span>
      </div>
      <ul className="tree">{tree.map((node) => renderNode(node, 0))}</ul>
    </aside>
  );
}
