import { useEffect, useState } from 'react';
import AdminPanel from './AdminPanel';
import { getAuthToken, setAuthToken } from '../data';

interface AdminUser { id: string; email: string; name: string; isAdmin: boolean }

export default function AdminPage() {
  const [checking, setChecking] = useState(true);
  const [user, setUser] = useState<AdminUser | null>(null);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const token = getAuthToken();
    if (!token) { setChecking(false); return; }
    void fetch('/api/me', { headers: { Authorization: `Bearer ${token}` } })
      .then(async (response) => {
        if (!response.ok) throw new Error('unauthorized');
        const data = await response.json() as { user: AdminUser };
        if (data.user?.isAdmin) setUser(data.user);
        else setAuthToken(null);
      })
      .catch(() => setAuthToken(null))
      .finally(() => setChecking(false));
  }, []);

  const login = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      const response = await fetch('/api/admin/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
      const data = await response.json().catch(() => null);
      if (!response.ok) throw new Error(data?.error ?? '登录失败');
      setAuthToken(data.token);
      setUser(data.user);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '登录失败');
    } finally {
      setBusy(false);
    }
  };

  const leave = () => {
    window.location.href = '/';
  };

  if (checking) return <div className="admin-page"><div className="admin-gate">正在检查登录状态…</div></div>;
  if (!user) {
    return (
      <div className="admin-page">
        <form className="admin-gate" onSubmit={(event) => void login(event)}>
          <div className="admin-gate-brand"><span>S</span><div><strong>STRUBROWSER</strong><em>管理后台</em></div></div>
          <p>仅系统管理员可登录；普通账号会被拒绝。</p>
          <label><span>邮箱</span><input type="email" required value={email} onChange={(event) => setEmail(event.target.value)} autoComplete="username" /></label>
          <label><span>密码</span><input type="password" required value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="current-password" /></label>
          {error ? <div className="admin-gate-error">{error}</div> : null}
          <button type="submit" disabled={busy}>{busy ? '登录中…' : '以管理员身份登录'}</button>
          <a href="/">← 返回工作台</a>
        </form>
      </div>
    );
  }

  return (
    <div className="admin-page">
      <AdminPanel
        onClose={leave}
        onToast={() => {}}
        onOpenSettings={(tab) => { window.location.href = `/?settings=${tab}`; }}
      />
    </div>
  );
}
