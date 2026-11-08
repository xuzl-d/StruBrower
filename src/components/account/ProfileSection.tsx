import { useState } from 'react';
import { ApiError, authApi } from '../../data';
import type { AuthUser } from '../../data';

interface ProfileSectionProps {
  user: AuthUser;
  mode: 'local' | 'server' | null;
  onUserUpdated: (user: AuthUser) => void;
  onToast: (message: string) => void;
  onLogout: () => void;
  onOpenSecurity: () => void;
}

function formatDate(value?: string | null): string {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleDateString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit' });
}

/** 个人资料：改显示名称、查看邮箱与角色、退出登录 */
export default function ProfileSection({
  user,
  mode,
  onUserUpdated,
  onToast,
  onLogout,
  onOpenSecurity,
}: ProfileSectionProps) {
  const [name, setName] = useState(user.name);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const dirty = name.trim() !== user.name && name.trim().length > 0;

  const save = async () => {
    if (!dirty || busy) return;
    setBusy(true);
    setError('');
    try {
      const result = await authApi.updateProfile({ name: name.trim() });
      onUserUpdated(result.user);
      onToast('显示名称已更新');
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : '保存失败');
    } finally {
      setBusy(false);
    }
  };

  const initial = (user.name || user.email).slice(0, 1).toUpperCase();

  return (
    <div className="account-cards">
      <section className="account-card">
        <header className="account-card-head">
          <div>
            <strong>基本资料</strong>
            <span>显示名称会出现在协作在线列表、成员列表和审计日志里</span>
          </div>
        </header>

        <div className="account-profile-row">
          <span className="account-avatar large">{initial}</span>
          <div className="account-profile-fields">
            <label className="account-field">
              <span>显示名称</span>
              <div className="account-field-inline">
                <input
                  value={name}
                  maxLength={40}
                  placeholder="你的名字"
                  onChange={(event) => setName(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') void save();
                  }}
                  disabled={mode === 'local'}
                />
                <button className="primary" onClick={() => void save()} disabled={!dirty || busy}>
                  {busy ? '保存中…' : '保存'}
                </button>
              </div>
              <em>{mode === 'local' ? '本地模式没有账号体系，登录服务端后可修改' : '1–40 个字符，随时可改'}</em>
            </label>

            <label className="account-field">
              <span>邮箱（登录名）</span>
              <input value={user.email} readOnly disabled />
              <em>邮箱即登录名，暂不支持自助修改；如需更换请联系系统管理员</em>
            </label>
          </div>
        </div>

        {error ? <div className="account-error">{error}</div> : null}

        <div className="account-kv">
          <div><span>账号角色</span><b>{user.isAdmin ? '系统管理员' : '普通成员'}</b></div>
          <div><span>注册时间</span><b>{formatDate(user.createdAt)}</b></div>
          <div><span>运行模式</span><b>{mode === 'server' ? '服务端（多人协作）' : mode === 'local' ? '本地（仅本机）' : '连接中…'}</b></div>
        </div>
      </section>

      <section className="account-card">
        <header className="account-card-head">
          <div>
            <strong>登录与安全</strong>
            <span>定期更换密码；忘记密码需要系统管理员重置</span>
          </div>
          <button onClick={onOpenSecurity}>修改密码</button>
        </header>
        <div className="account-session">
          <div>
            <strong>当前会话</strong>
            <span>本浏览器已登录为 {user.email}</span>
          </div>
          <button className="danger" onClick={onLogout}>退出登录</button>
        </div>
      </section>
    </div>
  );
}
