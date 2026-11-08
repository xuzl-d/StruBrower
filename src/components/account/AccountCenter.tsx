import { useEffect, useMemo, useRef, useState } from 'react';
import type { ProjectSummary } from '../../bim/document';
import { adminApi } from '../../data';
import type { AuthUser } from '../../data';
import type { ViewSettings } from '../../settings';
import ProfileSection from './ProfileSection';
import SecuritySection from './SecuritySection';
import ProjectsSection from './ProjectsSection';
import PreferencesSection from './PreferencesSection';
import UsersSection from './UsersSection';
import AiSection from './AiSection';
import SystemSection from './SystemSection';

export type AccountSection = 'profile' | 'security' | 'projects' | 'preferences' | 'users' | 'ai' | 'system';

export interface AccountDiagnostics {
  renderer?: string;
  software?: boolean;
  elements?: number;
  triangles?: number;
}

interface AccountCenterProps {
  user: AuthUser;
  mode: 'local' | 'server' | null;
  /** 本地模式没有账号体系：只展示「我的项目 + 软件设置」 */
  localMode?: boolean;
  initialSection?: AccountSection;
  summaries: ProjectSummary[];
  currentProjectId: string;
  settings: ViewSettings;
  diagnostics?: AccountDiagnostics;
  onSettingsChange: (next: ViewSettings) => void;
  onClose: () => void;
  onLogout: () => void;
  onToast: (message: string) => void;
  onUserUpdated: (user: AuthUser) => void;
  onOpenProject: (id: string) => Promise<void> | void;
  onCreateProject: () => Promise<void> | void;
  onRenameProject: (id: string, name: string) => Promise<void> | void;
  onDeleteProject: (id: string) => Promise<void> | void;
  onRefreshProjects: () => Promise<void> | void;
}

interface NavEntry {
  id: AccountSection;
  label: string;
  icon: string;
  badge?: string;
}

const META: Record<AccountSection, { title: string; caption: string }> = {
  profile: { title: '个人资料', caption: '显示名称、邮箱与账号状态' },
  security: { title: '登录与安全', caption: '修改密码、管理当前会话' },
  projects: { title: '我的项目', caption: '全部参与过的项目，可重新打开继续编辑' },
  preferences: { title: '软件设置', caption: '本机显示与交互偏好，按设备保存' },
  users: { title: '用户管理', caption: '创建账号、重置密码、调整系统管理员' },
  ai: { title: 'AI 设置', caption: '建模助手的模型、接口地址与 API Key' },
  system: { title: '系统与审计', caption: '运行概览、全部项目与操作审计' },
};

const FOCUSABLE = 'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

/** 账户中心：右上角用户名打开；账号/项目/软件设置 + 超管专属的用户、AI、系统管理 */
export default function AccountCenter({
  user,
  mode,
  localMode = false,
  initialSection = 'profile',
  summaries,
  currentProjectId,
  settings,
  diagnostics,
  onSettingsChange,
  onClose,
  onLogout,
  onToast,
  onUserUpdated,
  onOpenProject,
  onCreateProject,
  onRenameProject,
  onDeleteProject,
  onRefreshProjects,
}: AccountCenterProps) {
  const isSystemAdmin = Boolean(user.isAdmin) && !localMode;
  const normalize = (value: AccountSection): AccountSection => {
    if (localMode && (value === 'profile' || value === 'security' || value === 'users' || value === 'ai' || value === 'system')) {
      return 'preferences';
    }
    if ((value === 'users' || value === 'ai' || value === 'system') && !isSystemAdmin) return 'profile';
    return value;
  };
  const [section, setSection] = useState<AccountSection>(normalize(initialSection));
  const [pendingAdmins, setPendingAdmins] = useState<number | null>(null);
  const shellRef = useRef<HTMLDivElement | null>(null);

  /* 超管专属页面在权限被收回时退回；本地模式只保留工作区页面 */
  useEffect(() => {
    if (!isSystemAdmin && (section === 'users' || section === 'ai' || section === 'system')) {
      setSection('profile');
      return;
    }
    if (localMode && (section === 'profile' || section === 'security')) setSection('preferences');
  }, [isSystemAdmin, localMode, section]);

  /* Esc 关闭；Tab 在面板内循环 */
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        onClose();
        return;
      }
      if (event.key !== 'Tab') return;
      const root = shellRef.current;
      if (!root) return;
      const items = Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE))
        .filter((element) => element.offsetParent !== null && !element.hasAttribute('disabled'));
      if (!items.length) return;
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement as HTMLElement | null;
      if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      } else if (event.shiftKey && (active === first || !root.contains(active))) {
        event.preventDefault();
        last.focus();
      }
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [onClose]);

  /* 打开时把焦点收进面板 */
  useEffect(() => {
    const root = shellRef.current;
    const target = root?.querySelector<HTMLElement>('.account-nav button.active')
      ?? root?.querySelector<HTMLElement>('button');
    target?.focus();
  }, []);

  /* 超管：顺带取一次用户总数，作为「用户管理」入口的角标 */
  useEffect(() => {
    if (!isSystemAdmin) return;
    let cancelled = false;
    void adminApi.users()
      .then((data) => {
        if (!cancelled) setPendingAdmins(data.users.length);
      })
      .catch(() => {
        if (!cancelled) setPendingAdmins(null);
      });
    return () => {
      cancelled = true;
    };
  }, [isSystemAdmin]);

  const accountNav = useMemo<NavEntry[]>(() => ([
    { id: 'profile', label: '个人资料', icon: '◍' },
    { id: 'security', label: '登录与安全', icon: '🔒' },
  ]), []);

  const workNav = useMemo<NavEntry[]>(() => ([
    { id: 'projects', label: '我的项目', icon: '▤', badge: String(summaries.length) },
    { id: 'preferences', label: '软件设置', icon: '⚙' },
  ]), [summaries.length]);

  const adminNav = useMemo<NavEntry[]>(() => ([
    { id: 'users', label: '用户管理', icon: '☰', badge: pendingAdmins === null ? undefined : String(pendingAdmins) },
    { id: 'ai', label: 'AI 设置', icon: '✦' },
    { id: 'system', label: '系统与审计', icon: '🛡' },
  ]), [pendingAdmins]);

  const meta = META[section];
  const initial = (user.name || user.email).slice(0, 1).toUpperCase();

  const renderSection = () => {
    if (localMode && (section === 'profile' || section === 'security')) {
      return (
        <PreferencesSection
          settings={settings}
          diagnostics={diagnostics}
          onSettingsChange={onSettingsChange}
          onToast={onToast}
        />
      );
    }
    switch (section) {
      case 'profile':
        return (
          <ProfileSection
            user={user}
            mode={mode}
            onUserUpdated={onUserUpdated}
            onToast={onToast}
            onLogout={onLogout}
            onOpenSecurity={() => setSection('security')}
          />
        );
      case 'security':
        return <SecuritySection user={user} mode={mode} onToast={onToast} />;
      case 'projects':
        return (
          <ProjectsSection
            summaries={summaries}
            currentProjectId={currentProjectId}
            mode={mode}
            onOpenProject={onOpenProject}
            onCreateProject={onCreateProject}
            onRenameProject={onRenameProject}
            onDeleteProject={onDeleteProject}
            onRefresh={onRefreshProjects}
          />
        );
      case 'preferences':
        return (
          <PreferencesSection
            settings={settings}
            diagnostics={diagnostics}
            onSettingsChange={onSettingsChange}
            onToast={onToast}
          />
        );
      case 'users':
        return isSystemAdmin
          ? <UsersSection currentUser={user} onToast={onToast} onSelfUpdated={onUserUpdated} onCountChange={setPendingAdmins} />
          : null;
      case 'ai':
        return isSystemAdmin ? <AiSection onToast={onToast} /> : null;
      case 'system':
        return isSystemAdmin ? <SystemSection onToast={onToast} /> : null;
      default:
        return null;
    }
  };

  const renderNavGroup = (title: string, entries: NavEntry[]) => (
    <>
      <div className="account-nav-title">{title}</div>
      {entries.map((entry) => (
        <button
          key={entry.id}
          className={`account-nav-item ${section === entry.id ? 'active' : ''}`}
          onClick={() => setSection(entry.id)}
        >
          <span className="account-nav-icon" aria-hidden>{entry.icon}</span>
          <span>{entry.label}</span>
          {entry.badge !== undefined ? <em>{entry.badge}</em> : null}
        </button>
      ))}
    </>
  );

  return (
    <section className="account-page" aria-label="账户中心">
      <div className="account-shell" ref={shellRef}>
        <aside className="account-nav">
          <div className="account-brand">
            <span className="account-brand-mark">S</span>
            <span className="account-brand-name">STRU<em>BROWSER</em></span>
          </div>

          <div className="account-identity">
            <span className="account-avatar">{initial}</span>
            <div className="account-identity-text">
              <strong title={user.name}>{user.name}</strong>
              <span title={user.email}>{user.email}</span>
              <em className={isSystemAdmin ? 'account-role admin' : 'account-role'}>
                {localMode ? '本地模式' : isSystemAdmin ? '系统管理员' : '普通成员'}
              </em>
            </div>
          </div>

          <nav className="account-nav-list">
            {localMode ? null : renderNavGroup('账号', accountNav)}
            {renderNavGroup('工作区', workNav)}
            {isSystemAdmin ? renderNavGroup('系统管理', adminNav) : null}
            {localMode ? (
              <p className="account-nav-hint">本地模式没有账号体系：项目保存在这台浏览器，接入服务端后可多人协作。</p>
            ) : isSystemAdmin ? null : (
              <p className="account-nav-hint">用户、AI 与系统设置仅系统管理员可见。</p>
            )}
          </nav>

          {localMode ? null : (
            <div className="account-nav-foot">
              <button className="account-logout" onClick={onLogout}>退出登录</button>
            </div>
          )}
        </aside>

        <div className="account-main">
          <header className="account-pagebar">
            <nav className="account-breadcrumb" aria-label="位置">
              <span>账户中心</span>
              <i aria-hidden>/</i>
              <strong>{meta.title}</strong>
            </nav>
            <div className="account-pagebar-actions">
              <span className="account-esc" title="按 Esc 返回工作台">Esc</span>
              <button className="account-back" onClick={onClose}>← 返回工作台</button>
            </div>
          </header>

          <div className="account-body">
            <div className="account-pagehead">
              <div>
                <h1>{meta.title}</h1>
                <p>{meta.caption}</p>
              </div>
            </div>
            {renderSection()}
          </div>
        </div>
      </div>
    </section>
  );
}
