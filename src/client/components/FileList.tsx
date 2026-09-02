import type { DiffFile, Thread } from '../../shared/types';

interface Props {
  files: DiffFile[];
  threadsByFile: Map<string, Thread[]>;
  collapsed: Set<string>;
  onSelect: (path: string) => void;
}

const STATUS_LABEL: Record<DiffFile['status'], string> = {
  added: 'A',
  deleted: 'D',
  modified: 'M',
  renamed: 'R',
};

export function FileList({ files, threadsByFile, collapsed, onSelect }: Props) {
  return (
    <aside className="sidebar">
      <div className="sidebar-title">Files changed</div>
      <ul>
        {files.map((file) => {
          const threads = threadsByFile.get(file.path) ?? [];
          const open = threads.filter((t) => t.status !== 'resolved').length;
          const name = file.path.split('/').pop();
          const dir = file.path.slice(0, file.path.length - (name?.length ?? 0));
          return (
            <li key={file.path}>
              <button onClick={() => onSelect(file.path)} className={collapsed.has(file.path) ? 'dim' : ''}>
                <span className={`status ${file.status}`}>{STATUS_LABEL[file.status]}</span>
                <span className="path">
                  <span className="dir">{dir}</span>
                  <span className="name">{name}</span>
                </span>
                {open > 0 && <span className="badge">{open}</span>}
                <span className="counts">
                  <span className="add">+{file.additions}</span>
                  <span className="del">-{file.deletions}</span>
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </aside>
  );
}
