import { useMemo, useState } from 'react';
import type { ProjectSummary } from '../../bim/document';

interface ProjectsSectionProps {
  summaries: ProjectSummary[];
  currentProjectId: string;
  mode: 'local' | 'server' | null;
  onOpenProject: (id: string) => Promise<void> | void;
  onCreateProject: () => Promise<void> | void;
  onRenameProject: (id: string, name: string) => Promise<void> | void;
  onDeleteProject: (id: string) => Promise<void> | void;
  onRefresh: () => Promise<void> | void;
}

const ROLE_LABEL: Record<string, string> = {
  admin: '管理员',
  editor: '可编辑',
  viewer: '只读',
};

function relativeTime(value?: string): string {
  if (!value) return '—';
  const time = new Date(value).getTime();
  if (Number.isNaN(time)) return '—';
  const diff = Date.now() - time;
  if (diff < 60_000) return '刚刚';
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} 天前`;
  return new Date(time).toLocaleDateString('zh-CN');
}

/** 我的项目：全部参与过的项目（所有者 / 成员），可直接打开继续编辑 */
export default function ProjectsSection({
  summaries,
  currentProjectId,
  mode,
  onOpenProject,
  onCreateProject,
  onRenameProject,
  onDeleteProject,
  onRefresh,
}: ProjectsSectionProps) {
  const [query, setQuery] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draftName, setDraftName] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const rows = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    return [...summaries]
      .sort((a, b) => String(b.updatedAt ?? '').localeCompare(String(a.updatedAt ?? '')))
      .filter((item) => !keyword || item.name.toLowerCase().includes(keyword) || item.id.toLowerCase().includes(keyword));
  }, [summaries, query]);

  const startRename = (item: ProjectSummary) => {
    setEditingId(item.id);
    setDraftName(item.name);
  };

  const commitRename = async (id: string) => {
    const name = draftName.trim();
    setEditingId(null);
    const current = summaries.find((item) => item.id === id);
    if (!name || name === current?.name) return;
    setBusyId(id);
    try {
      await onRenameProject(id, name);
    } finally {
      setBusyId(null);
    }
  };

  const refresh = async () => {
    setRefreshing(true);
    try {
      await onRefresh();
    } finally {
      setRefreshing(false);
    }
  };

  return (
    <div className="account-cards">
      <section className="account-card">
        <header className="account-card-head">
          <div>
            <strong>全部项目</strong>
            <span>
              你参与过的项目按最近修改排序；打开后会切换当前工作文档（未保存的改动会先自动保存）
            </span>
          </div>
          <div className="account-head-actions">
            <button onClick={() => void refresh()} disabled={refreshing}>{refreshing ? '刷新中…' : '刷新'}</button>
            <button className="primary" onClick={() => void onCreateProject()}>＋ 新建项目</button>
          </div>
        </header>

        <div className="account-toolbar">
          <input
            placeholder="搜索项目名称或 ID"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          <span className="account-count">{rows.length} / {summaries.length} 个项目</span>
        </div>

        <div className="acc-proj-table">
          {rows.map((item) => {
            const isCurrent = item.id === currentProjectId;
            const canManage = item.role === 'admin' || item.role === undefined;
            return (
              <div className={`acc-proj-row ${isCurrent ? 'current' : ''}`} key={item.id}>
                <div className="acc-proj-main">
                  {editingId === item.id ? (
                    <div className="acc-proj-rename">
                      <input
                        autoFocus
                        value={draftName}
                        maxLength={60}
                        onChange={(event) => setDraftName(event.target.value)}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter') void commitRename(item.id);
                          if (event.key === 'Escape') setEditingId(null);
                        }}
                      />
                      <button className="primary" onClick={() => void commitRename(item.id)}>保存</button>
                      <button onClick={() => setEditingId(null)}>取消</button>
                    </div>
                  ) : (
                    <div className="acc-proj-title">
                      <strong>{item.name}</strong>
                      {isCurrent ? <span className="acc-tag current">当前打开</span> : null}
                      {item.role ? (
                        <span className={`acc-tag role-${item.role}`}>{ROLE_LABEL[item.role] ?? item.role}</span>
                      ) : null}
                    </div>
                  )}
                  <div className="acc-proj-meta">
                    <span>rev {item.rev ?? 0}</span>
                    <span>{item.elementCount ?? 0} 构件</span>
                    <span>更新于 {relativeTime(item.updatedAt)}</span>
                    <code title={item.id}>{item.id.slice(0, 8)}</code>
                  </div>
                </div>

                <div className="acc-proj-actions">
                  <button
                    className="primary"
                    disabled={isCurrent || busyId === item.id || editingId === item.id}
                    onClick={() => void onOpenProject(item.id)}
                    title={isCurrent ? '已经是当前项目' : '打开并继续编辑'}
                  >{isCurrent ? '编辑中' : '打开'}</button>
                  <button
                    disabled={!canManage || busyId === item.id}
                    onClick={() => startRename(item)}
                    title={canManage ? '重命名项目' : '需要项目管理员'}
                  >重命名</button>
                  <button
                    className="danger"
                    disabled={!canManage || busyId === item.id}
                    onClick={() => void onDeleteProject(item.id)}
                    title={canManage ? '删除项目' : '需要项目管理员'}
                  >删除</button>
                </div>
              </div>
            );
          })}
          {!rows.length ? (
            <div className="account-empty">
              {query ? '没有匹配的项目' : '还没有项目：点右上角「新建项目」开始'}
            </div>
          ) : null}
        </div>

        {mode === 'local' ? (
          <div className="account-note">
            当前是本地模式，项目只保存在这台浏览器里；用 <code>./start.sh</code> 启动服务端后才能多人协作、跨设备打开。
          </div>
        ) : null}
      </section>
    </div>
  );
}
