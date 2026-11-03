import { useEffect, useState } from 'react';
import { adminApi, ApiError } from '../data';
import type { AdminAuditEvent, AdminOverview, AdminProject } from '../data';

interface AdminPanelProps {
  onClose: () => void;
  onOpenSettings: (tab: 'users' | 'ai') => void;
  onToast: (message: string) => void;
}

type Tab = 'overview' | 'projects' | 'audit';

function formatBytes(value: number): string {
  if (!value) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const index = Math.min(units.length - 1, Math.floor(Math.log(value) / Math.log(1024)));
  return `${(value / 1024 ** index).toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时 ${minutes % 60} 分`;
  return `${Math.floor(hours / 24)} 天 ${hours % 24} 小时`;
}

function formatTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

export default function AdminPanel({ onClose, onOpenSettings, onToast }: AdminPanelProps) {
  const [tab, setTab] = useState<Tab>('overview');
  const [overview, setOverview] = useState<AdminOverview | null>(null);
  const [projects, setProjects] = useState<AdminProject[]>([]);
  const [projectTotal, setProjectTotal] = useState(0);
  const [query, setQuery] = useState('');
  const [audit, setAudit] = useState<AdminAuditEvent[]>([]);
  const [auditTotal, setAuditTotal] = useState(0);
  const [auditFilter, setAuditFilter] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const run = async (action: () => Promise<void>) => {
    setLoading(true);
    setError('');
    try {
      await action();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : '操作失败');
    } finally {
      setLoading(false);
    }
  };

  const loadOverview = () => run(async () => {
    setOverview(await adminApi.overview());
  });

  const loadProjects = (search = query) => run(async () => {
    const data = await adminApi.projects(search, 0, 100);
    setProjects(data.projects);
    setProjectTotal(data.total);
  });

  const loadAudit = (offset = 0, append = false) => run(async () => {
    const data = await adminApi.audit({ action: auditFilter, offset, limit: 50 });
    setAudit((current) => (append ? [...current, ...data.events] : data.events));
    setAuditTotal(data.total);
  });

  useEffect(() => {
    void loadOverview();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (tab === 'projects') void loadProjects(query);
    if (tab === 'audit') void loadAudit(0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab]);

  const removeProject = (project: AdminProject) => {
    if (!window.confirm(`删除项目「${project.name}」（所有者 ${project.ownerEmail}）？\n文档、版本和成员关系会一并删除，不可恢复。`)) return;
    void run(async () => {
      await adminApi.deleteProject(project.id);
      onToast(`已删除项目「${project.name}」`);
      await loadProjects();
      await loadOverview();
    });
  };

  return (
    <div className="modal-backdrop admin-backdrop" onClick={onClose}>
      <div className="modal-card admin-card" onClick={(event) => event.stopPropagation()}>
        <div className="modal-head">
          <div>
            <strong>管理后台</strong>
            <span>系统概览 · 全部项目 · 审计日志 · 用户与 AI 配置</span>
          </div>
          <button className="modal-close" onClick={onClose} aria-label="关闭">✕</button>
        </div>

        <div className="admin-tabs">
          <div className="admin-tab-buttons">
            <button className={tab === 'overview' ? 'active' : ''} onClick={() => setTab('overview')}>概览</button>
            <button className={tab === 'projects' ? 'active' : ''} onClick={() => setTab('projects')}>项目</button>
            <button className={tab === 'audit' ? 'active' : ''} onClick={() => setTab('audit')}>审计日志</button>
          </div>
          <div className="admin-tab-actions">
            <button onClick={() => onOpenSettings('users')}>用户管理</button>
            <button onClick={() => onOpenSettings('ai')}>AI 设置</button>
          </div>
        </div>

        <div className="admin-body">
          {error ? <div className="modal-error">{error}</div> : null}

          {tab === 'overview' ? (
            overview ? (
              <>
                <div className="admin-cards">
                  <div className="admin-card-item"><span>用户</span><b>{overview.users}</b><em>管理员 {overview.admins}</em></div>
                  <div className="admin-card-item"><span>项目</span><b>{overview.projects}</b><em>文档 {overview.documents}</em></div>
                  <div className="admin-card-item"><span>文档总大小</span><b>{formatBytes(overview.documentBytes)}</b><em>数据库 {formatBytes(overview.dbBytes)}</em></div>
                  <div className="admin-card-item"><span>审计事件</span><b>{overview.auditEvents}</b><em>最近 50 条可在审计页查看</em></div>
                  <div className="admin-card-item"><span>在线协作</span><b>{overview.collab.clients}</b><em>{overview.collab.rooms} 个项目房间</em></div>
                  <div className="admin-card-item"><span>运行时长</span><b>{formatDuration(overview.uptimeSec)}</b><em>Node {overview.node}</em></div>
                </div>

                <div className="admin-info">
                  <span>版本</span><b>{overview.version}</b>
                  <span>数据目录</span><b className="mono">{overview.dataDir}</b>
                  <span>开放注册</span><b>{overview.registrationOpen ? '是（建议创建管理员后关闭）' : '否（仅管理员创建用户）'}</b>
                  <span>登录限流</span><b>{overview.authRateLimit > 0 ? `${overview.authRateLimit} 次 / 5 分钟 / IP` : '已关闭'}</b>
                  <span>AI</span><b>{overview.ai.provider === 'mock' ? 'Mock 模式' : `${overview.ai.model}${overview.ai.ready ? '' : '（缺少 key）'}`}</b>
                  <span>STEP 转换器</span><b>{overview.converter.available ? '可用（服务端 OCCT）' : overview.converter.checked ? '不可用（使用浏览器回退）' : '检测中…'}</b>
                </div>

                <div className="admin-actions">
                  <button onClick={() => void loadOverview()} disabled={loading}>刷新概览</button>
                  <button onClick={() => setTab('projects')}>管理项目</button>
                  <button onClick={() => setTab('audit')}>查看审计</button>
                </div>
              </>
            ) : <div className="modal-note">正在读取系统概览…</div>
          ) : null}

          {tab === 'projects' ? (
            <>
              <form
                className="admin-search"
                onSubmit={(event) => {
                  event.preventDefault();
                  void loadProjects(query);
                }}
              >
                <input
                  placeholder="搜索项目名称或 ID"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                />
                <button type="submit" disabled={loading}>搜索</button>
                <span className="admin-count">共 {projectTotal} 个项目</span>
              </form>

              <div className="admin-table-wrap">
                <table className="admin-table">
                  <thead>
                    <tr>
                      <th>项目</th>
                      <th>所有者</th>
                      <th>构件</th>
                      <th>rev</th>
                      <th>大小</th>
                      <th>成员</th>
                      <th>更新时间</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {projects.map((project) => (
                      <tr key={project.id}>
                        <td>
                          <strong>{project.name}</strong>
                          <span className="mono">{project.id.slice(0, 8)}</span>
                        </td>
                        <td>{project.ownerName || project.ownerEmail || '—'}<span className="admin-muted">{project.ownerEmail}</span></td>
                        <td>{project.elementCount}</td>
                        <td>{project.rev}</td>
                        <td>{formatBytes(project.documentBytes)}</td>
                        <td>{project.memberCount}</td>
                        <td>{formatTime(project.updatedAt)}</td>
                        <td>
                          <button className="admin-danger" onClick={() => removeProject(project)} disabled={loading}>删除</button>
                        </td>
                      </tr>
                    ))}
                    {!projects.length ? (
                      <tr><td colSpan={8} className="admin-empty">没有匹配的项目</td></tr>
                    ) : null}
                  </tbody>
                </table>
              </div>
            </>
          ) : null}

          {tab === 'audit' ? (
            <>
              <form
                className="admin-search"
                onSubmit={(event) => {
                  event.preventDefault();
                  void loadAudit(0);
                }}
              >
                <input
                  placeholder="按操作过滤，例如 project.create / ai.apply / admin."
                  value={auditFilter}
                  onChange={(event) => setAuditFilter(event.target.value)}
                />
                <button type="submit" disabled={loading}>过滤</button>
                <span className="admin-count">共 {auditTotal} 条</span>
              </form>

              <div className="admin-audit">
                {audit.map((event) => (
                  <div className="admin-audit-row" key={event.id}>
                    <span className="admin-audit-time">{formatTime(event.createdAt)}</span>
                    <span className="admin-audit-action">{event.action}</span>
                    <span className="admin-audit-user">{event.userName || event.userEmail || '系统'}</span>
                    <span className="admin-audit-project">{event.projectName || '—'}</span>
                    <span className="admin-audit-detail" title={event.detail ?? ''}>{event.detail ?? ''}</span>
                  </div>
                ))}
                {!audit.length ? <div className="admin-empty">暂无审计记录</div> : null}
              </div>

              {audit.length < auditTotal ? (
                <div className="admin-actions">
                  <button onClick={() => void loadAudit(audit.length, true)} disabled={loading}>加载更多</button>
                </div>
              ) : null}
            </>
          ) : null}
        </div>

        <div className="modal-foot">
          管理后台仅系统管理员可见；所有敏感操作都会写入审计日志。项目内的成员与角色仍在「管理 → 成员权限」中维护。
        </div>
      </div>
    </div>
  );
}
