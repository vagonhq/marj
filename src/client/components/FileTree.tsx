import {
  CheckIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  DiffAddedIcon,
  DiffModifiedIcon,
  DiffRemovedIcon,
  DiffRenamedIcon,
  FileDirectoryFillIcon,
  SearchIcon,
} from '@primer/octicons-react';
import { useMemo, useState } from 'react';
import type { DiffFile, Thread } from '../../shared/types';

interface Props {
  files: DiffFile[];
  threadsByFile: Map<string, Thread[]>;
  viewed: Map<string, string>;
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
  return sortNodes(squash(root).children);
}

function StatusIcon({ file, viewed }: { file: DiffFile; viewed: boolean }) {
  if (viewed) return <CheckIcon size={16} className="status viewed" />;
  switch (file.status) {
    case 'added':
      return <DiffAddedIcon size={16} className="status added" />;
    case 'deleted':
      return <DiffRemovedIcon size={16} className="status deleted" />;
    case 'renamed':
      return <DiffRenamedIcon size={16} className="status renamed" />;
    default:
      return <DiffModifiedIcon size={16} className="status modified" />;
  }
}

export function FileTree({ files, threadsByFile, viewed, onSelect }: Props) {
  const [filter, setFilter] = useState('');
  const [folded, setFolded] = useState<Set<string>>(new Set());

  const shown = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    return needle ? files.filter((f) => f.path.toLowerCase().includes(needle)) : files;
  }, [files, filter]);
  const tree = useMemo(() => buildTree(shown), [shown]);

  const toggle = (path: string) =>
    setFolded((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });

  const renderNode = (node: Node, depth: number) => {
    const indent = { paddingLeft: `${8 + depth * 16}px` };

    if (node.kind === 'dir') {
      const open = filter.trim() !== '' || !folded.has(node.path);
      return (
        <li key={`d:${node.path}`}>
          <button className="tree-row dir" style={indent} onClick={() => toggle(node.path)}>
            <span className="twisty">{open ? <ChevronDownIcon size={12} /> : <ChevronRightIcon size={12} />}</span>
            <FileDirectoryFillIcon size={16} className="folder" />
            <span className="tree-label">{node.name}</span>
          </button>
          {open && <ul>{node.children.map((child) => renderNode(child, depth + 1))}</ul>}
        </li>
      );
    }

    const threads = threadsByFile.get(node.file.path) ?? [];
    const open = threads.filter((t) => t.status !== 'resolved').length;
    const isViewed = viewed.has(node.file.path);
    return (
      <li key={`f:${node.file.path}`}>
        <button
          className={`tree-row file${isViewed ? ' viewed' : ''}`}
          style={indent}
          onClick={() => onSelect(node.file.path)}
          title={node.file.path}
        >
          <span className="twisty" />
          <StatusIcon file={node.file} viewed={isViewed} />
          <span className="tree-label">{node.name}</span>
          {open > 0 && <span className="counter accent">{open}</span>}
        </button>
      </li>
    );
  };

  return (
    <aside className="sidebar">
      <div className="filter">
        <SearchIcon size={14} className="filter-icon" />
        <input
          type="search"
          placeholder="Filter changed files"
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
        />
      </div>
      <ul className="tree">{tree.map((node) => renderNode(node, 0))}</ul>
      {shown.length === 0 && <div className="tree-empty">No files match</div>}
    </aside>
  );
}
