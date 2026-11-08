import { useEffect, useMemo, useState } from 'react';
import { adminApi, ApiError } from '../../data';
import type { AdminUser, AuthUser } from '../../data';

interface UsersSectionProps {
  currentUser: AuthUser;
  onToast: (message: string) => void;
  onSelfUpdated: (user: AuthUser) => void;
  onCountChange: (count: number) => void;
}

type Filter = 'all' | 'admin' | 'member';

const PASSWORD_CHARS = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function randomPassword(length = 12): string {
  const bytes = new Uint32Array(length);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (value) => PASSWORD_CHARS[value % PASSWORD_CHARS.length]).join('');
}

function formatDate(value?: string): string {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleDateString('zh-CN');
}

/** 用户管理（系统管理员）：创建账号、改名、重置密码、授予/收回管理员、删除 */
export default function UsersSection({
  currentUser,
  onToast,
  onSelfUpdated,
  onCountChange,
}: UsersSectionProps) {
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const [creating, setCreating] = useState(false);
  const [newEmail, setNewEmail] = useState('');
  const [newName, setNewName] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [newIsAdmin, setNewIsAdmin] = useState(false);
  const [resetTarget, setResetTarget] = useState<string | null>(null);
  const [resetValue, setResetValue] = useState('');
  const [resetDone, setResetDone] = useState<{ id: string; password: string } | null>(null);
  const [renameTarget, setRenameTarget] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');

  const load = async () => {
    setLoading(true);
    try {
      const data = await adminApi.users();
      setUsers(data.users);
      onCountChange(data.users.length);
      setError('');
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : '读取用户失败');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const run = async (action: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      await action();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : '操作失败');
    } finally {
      setBusy(false);
    }
  };

  const rows = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    return users.filter((item) => {
      if (filter === 'admin' && !item.isAdmin) return false;
      if (filter === 'member' && item.isAdmin) return false;
      if (!keyword) return true;
      return item.name.toLowerCase().includes(keyword) || item.email.toLowerCase().includes(keyword);
    });
  }, [users, query, filter]);

  const adminCount = users.filter((item) => item.isAdmin).length;

  const createUser = () => run(async () => {
    if (!newEmail.trim() || !newName.trim() || newPassword.length < 6) {
      setError('请填写邮箱、名称，密码至少 6 位');
      return;
    }
    await adminApi.createUser({
      email: newEmail.trim(),
      name: newName.trim(),
      password: newPassword,
      isAdmin: newIsAdmin,
    });
    setNewEmail('');
    setNewName('');
    setNewPassword('');
    setNewIsAdmin(false);
    setCreating(false);
    onToast('已创建用户');
    await load();
  });

  const startReset = (target: AdminUser) => {
    setResetTarget(target.id);
    setResetValue(randomPassword());
    setResetDone(null);
  };

  const submitReset = (target: AdminUser) => run(async () => {
    if (resetValue.length < 6) {
      setError('密码至少 6 位');
      return;
    }
    await adminApi.updateUser(target.id, { password: resetValue });
    setResetDone({ id: target.id, password: resetValue });
    setResetValue('');
    onToast(`已重置 ${target.email} 的密码`);
  });

  const startRename = (target: AdminUser) => {
    setRenameTarget(target.id);
    setRenameValue(target.name);
    setResetTarget(null);
  };

  const submitRename = (target: AdminUser) => run(async () => {
    const name = renameValue.trim();
    if (!name) {
      setError('显示名称不能为空');
      return;
    }
    if (name === target.name) {
      setRenameTarget(null);
      return;
    }
    const result = await adminApi.updateUser(target.id, { name });
    if (result.user.id === currentUser.id) onSelfUpdated({ ...currentUser, name });
    setRenameTarget(null);
    onToast('已更新名称');
    await load();
  });

  const toggleAdmin = (target: AdminUser) => {
    void run(async () => {
      const result = await adminApi.updateUser(target.id, { isAdmin: !target.isAdmin });
      if (result.user.id === currentUser.id) onSelfUpdated({ ...currentUser, isAdmin: result.user.isAdmin });
      onToast(result.user.isAdmin ? '已设为系统管理员' : '已取消系统管理员');
      await load();
    });
  };

  const removeUser = (target: AdminUser) => {
    if (!window.confirm(`删除用户 ${target.email}？\n其项目成员关系会一并移除；名下仍有项目时需先处理项目。`)) return;
    void run(async () => {
      await adminApi.deleteUser(target.id);
      onToast('已删除用户');
      await load();
    });
  };

  return (
    <div className="account-cards">
      <div className="account-stats">
        <div className="account-stat">
          <span>账号总数</span>
          <b>{users.length}</b>
          <em>{loading ? '读取中…' : `当前显示 ${rows.length}`}</em>
        </div>
        <div className="account-stat">
          <span>系统管理员</span>
          <b>{adminCount}</b>
          <em>可管理用户、AI 与审计</em>
        </div>
        <div className="account-stat">
          <span>普通成员</span>
          <b>{users.length - adminCount}</b>
          <em>按项目角色协作</em>
        </div>
      </div>

      <section className="account-card">
        <header className="account-card-head">
          <div>
            <strong>账号</strong>
            <span>共 {users.length} 个账号，其中系统管理员 {adminCount} 名；至少保留一名管理员</span>
          </div>
          <button className="primary" onClick={() => setCreating((open) => !open)}>
            {creating ? '收起表单' : '＋ 新建用户'}
          </button>
        </header>

        {creating ? (
          <form
            className="user-create"
            onSubmit={(event) => {
              event.preventDefault();
              void createUser();
            }}
          >
            <input placeholder="邮箱（登录名）" value={newEmail} onChange={(event) => setNewEmail(event.target.value)} />
            <input placeholder="显示名称" value={newName} onChange={(event) => setNewName(event.target.value)} />
            <div className="user-create-pass">
              <input
                placeholder="初始密码（≥6 位）"
                value={newPassword}
                onChange={(event) => setNewPassword(event.target.value)}
              />
              <button type="button" onClick={() => setNewPassword(randomPassword())}>随机</button>
            </div>
            <label className="settings-check">
              <input type="checkbox" checked={newIsAdmin} onChange={(event) => setNewIsAdmin(event.target.checked)} />
              系统管理员
            </label>
            <button className="primary" type="submit" disabled={busy}>创建</button>
          </form>
        ) : null}

        <div className="account-toolbar">
          <input
            placeholder="搜索姓名或邮箱"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          <div className="account-segmented">
            <button className={filter === 'all' ? 'active' : ''} onClick={() => setFilter('all')}>全部 {users.length}</button>
            <button className={filter === 'admin' ? 'active' : ''} onClick={() => setFilter('admin')}>管理员 {adminCount}</button>
            <button className={filter === 'member' ? 'active' : ''} onClick={() => setFilter('member')}>普通成员 {users.length - adminCount}</button>
          </div>
        </div>

        {error ? <div className="account-error">{error}</div> : null}
        {loading ? <div className="account-note">正在读取用户…</div> : null}

        <div className="user-list">
          {rows.map((item) => {
            const isSelf = item.id === currentUser.id;
            return (
              <div className={`user-row ${isSelf ? 'self' : ''}`} key={item.id}>
                <span className="user-avatar">{(item.name || item.email).slice(0, 1).toUpperCase()}</span>
                <div className="user-main">
                  <div className="user-title">
                    {renameTarget === item.id ? (
                      <div className="user-rename">
                        <input
                          autoFocus
                          value={renameValue}
                          maxLength={40}
                          onChange={(event) => setRenameValue(event.target.value)}
                          onKeyDown={(event) => {
                            if (event.key === 'Enter') void submitRename(item);
                            if (event.key === 'Escape') setRenameTarget(null);
                          }}
                        />
                        <button className="primary" onClick={() => void submitRename(item)} disabled={busy}>保存</button>
                        <button onClick={() => setRenameTarget(null)}>取消</button>
                      </div>
                    ) : (
                      <>
                        <strong>{item.name}</strong>
                        {isSelf ? <span className="acc-tag current">你</span> : null}
                        {item.isAdmin ? <span className="acc-tag role-admin">系统管理员</span> : null}
                      </>
                    )}
                  </div>
                  <div className="user-meta">
                    <span>{item.email}</span>
                    <span>项目 {item.ownedProjects}</span>
                    <span>参与 {item.memberships}</span>
                    <span>注册于 {formatDate(item.createdAt)}</span>
                  </div>

                  {resetTarget === item.id ? (
                    <div className="user-reset">
                      <input
                        value={resetValue}
                        placeholder="新密码（≥6 位）"
                        onChange={(event) => setResetValue(event.target.value)}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter') void submitReset(item);
                          if (event.key === 'Escape') setResetTarget(null);
                        }}
                      />
                      <button onClick={() => setResetValue(randomPassword())}>随机</button>
                      <button className="primary" onClick={() => void submitReset(item)} disabled={busy}>确认重置</button>
                      <button onClick={() => setResetTarget(null)}>取消</button>
                    </div>
                  ) : null}
                  {resetDone?.id === item.id ? (
                    <div className="account-note ok">
                      新密码：<code>{resetDone.password}</code>
                      <button
                        onClick={() => {
                          void navigator.clipboard?.writeText(resetDone.password)
                            .then(() => onToast('密码已复制'))
                            .catch(() => onToast('复制失败，请手动复制'));
                        }}
                      >复制</button>
                      <span>请通过安全渠道转交，用户登录后可自行修改。</span>
                    </div>
                  ) : null}
                </div>

                <div className="user-actions">
                  <button onClick={() => startRename(item)} disabled={busy}>改名</button>
                  <button onClick={() => startReset(item)} disabled={busy}>
                    {resetTarget === item.id ? '重置中…' : '重置密码'}
                  </button>
                  <button onClick={() => toggleAdmin(item)} disabled={busy}>
                    {item.isAdmin ? '取消管理员' : '设为管理员'}
                  </button>
                  <button
                    className="danger"
                    onClick={() => removeUser(item)}
                    disabled={busy || isSelf}
                    title={isSelf ? '不能删除自己' : '删除账号'}
                  >删除</button>
                </div>
              </div>
            );
          })}
          {!rows.length && !loading ? <div className="account-empty">没有匹配的账号</div> : null}
        </div>

        <div className="account-note">
          拥有项目的账号需要先转让或删除其名下项目才能删除；所有敏感操作都会写入审计日志（「系统与审计」可查）。
        </div>
      </section>
    </div>
  );
}
