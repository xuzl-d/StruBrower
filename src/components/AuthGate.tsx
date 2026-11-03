import { useState } from 'react';
import { ApiError, authApi, setAuthToken } from '../data';
import type { AuthUser } from '../data';

interface AuthGateProps {
  onAuthenticated: (user: AuthUser) => void;
  notice?: string;
}

type Mode = 'login' | 'register';

export default function AuthGate({ onAuthenticated, notice }: AuthGateProps) {
  const [mode, setMode] = useState<Mode>('login');
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      const result = mode === 'login'
        ? await authApi.login(email.trim(), password)
        : await authApi.register(email.trim(), name.trim() || email.trim(), password);
      setAuthToken(result.token);
      onAuthenticated(result.user);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : '登录失败，请稍后重试');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="auth-screen">
      <div className="auth-card">
        <div className="auth-brand">
          <div className="brand-mark">S</div>
          <div>
            <div className="brand-name">STRU<span>BROWSER</span></div>
            <div className="brand-caption">Web BIM 工作台 · 服务端模式</div>
          </div>
        </div>

        <div className="auth-tabs">
          <button className={mode === 'login' ? 'active' : ''} onClick={() => { setMode('login'); setError(''); }}>
            登录
          </button>
          <button className={mode === 'register' ? 'active' : ''} onClick={() => { setMode('register'); setError(''); }}>
            注册
          </button>
        </div>

        <form className="auth-form" onSubmit={submit}>
          <label className="auth-field">
            <span>邮箱</span>
            <input
              type="email"
              required
              autoComplete="username"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              placeholder="you@example.com"
            />
          </label>
          {mode === 'register' ? (
            <label className="auth-field">
              <span>显示名称</span>
              <input
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="例如：张工"
                maxLength={40}
              />
            </label>
          ) : null}
          <label className="auth-field">
            <span>密码</span>
            <input
              type="password"
              required
              minLength={6}
              autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              placeholder="至少 6 位"
            />
          </label>

          {error ? <div className="auth-error">{error}</div> : null}
          {notice ? <div className="auth-notice">{notice}</div> : null}

          <button className="auth-submit" type="submit" disabled={busy}>
            {busy ? '处理中…' : mode === 'login' ? '登录并进入项目' : '注册并进入项目'}
          </button>
        </form>

        <div className="auth-foot">
          账号与文档保存在本地 Node 服务（SQLite）。服务地址：<code>/api</code>
        </div>
      </div>
    </div>
  );
}
