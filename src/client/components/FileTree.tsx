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
import { buildTree, type TreeNode } from '../tree.js';

interface Props {
  files: DiffFile[];
  threadsByFile: Map<string, Thread[]>;
  viewed: Map<string, string>;
  /** the file a chat link last jumped to */
  active?: string | null;
  onSelect: (path: string) => void;
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

export function FileTree({ files, threadsByFile, viewed, active, onSelect }: Props) {
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

  const renderNode = (node: TreeNode, depth: number) => {
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
          id={`tree-${node.file.path}`}
          className={`tree-row file${isViewed ? ' viewed' : ''}${active === node.file.path ? ' active' : ''}`}
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
