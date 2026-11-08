import { useState } from 'react';
import { ApiError, authApi } from '../../data';
import type { AuthUser } from '../../data';

interface SecuritySectionProps {
  user: AuthUser;
  mode: 'local' | 'server' | null;
  onToast: (message: string) => void;
}

const strength = (value: string): { score: number; label: string } => {
  let score = 0;
  if (value.length >= 6) score += 1;
  if (value.length >= 10) score += 1;
  if (/[a-z]/.test(value) && /[A-Z]/.test(value)) score += 1;
  if (/\d/.test(value)) score += 1;
  if (/[^A-Za-z0-9]/.test(value)) score += 1;
  if (score <= 1) return { score: 1, label: '偏弱' };
  if (score === 2) return { score: 2, label: '一般' };
  if (score <= 4) return { score: 3, label: '较强' };
  return { score: 4, label: '很强' };
};

/** 登录与安全：修改自己的密码（需验证旧密码） */
export default function SecuritySection({ user, mode, onToast }: SecuritySectionProps) {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);

  const info = strength(next);
  const canSubmit = current.length > 0 && next.length >= 6 && next === confirm && next !== current;

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!canSubmit || busy) return;
    setBusy(true);
    setError('');
    setDone(false);
    try {
      await authApi.changePassword(current, next);
      setCurrent('');
      setNext('');
      setConfirm('');
      setDone(true);
      onToast('密码已更新');
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : '修改密码失败');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="account-cards">
      <section className="account-card">
        <header className="account-card-head">
          <div>
            <strong>修改密码</strong>
            <span>账号 {user.email}；修改后请用新密码重新登录其它设备</span>
          </div>
        </header>

        <form className="account-form" onSubmit={(event) => void submit(event)}>
          <label className="account-field">
            <span>当前密码</span>
            <input
              type="password"
              value={current}
              autoComplete="current-password"
              onChange={(event) => setCurrent(event.target.value)}
              disabled={mode === 'local'}
            />
          </label>

          <label className="account-field">
            <span>新密码</span>
            <input
              type="password"
              value={next}
              autoComplete="new-password"
              placeholder="至少 6 位"
              onChange={(event) => setNext(event.target.value)}
              disabled={mode === 'local'}
            />
            {next ? (
              <div className={`password-meter level-${info.score}`}>
                <i /><i /><i /><i />
                <em>{info.label}</em>
              </div>
            ) : <em>建议 10 位以上，混合大小写、数字与符号</em>}
          </label>

          <label className="account-field">
            <span>确认新密码</span>
            <input
              type="password"
              value={confirm}
              autoComplete="new-password"
              onChange={(event) => setConfirm(event.target.value)}
              disabled={mode === 'local'}
            />
            {confirm && confirm !== next ? <em className="bad">两次输入不一致</em> : null}
            {confirm && confirm === next && next.length > 0 ? <em className="ok">两次输入一致</em> : null}
          </label>

          {error ? <div className="account-error">{error}</div> : null}
          {done ? <div className="account-note ok">密码已更新，下次登录请使用新密码。</div> : null}

          <div className="account-actions">
            <button className="primary" type="submit" disabled={!canSubmit || busy || mode === 'local'}>
              {busy ? '更新中…' : '更新密码'}
            </button>
            {mode === 'local' ? <span className="account-hint">本地模式没有账号体系</span> : null}
          </div>
        </form>
      </section>

      <section className="account-card">
        <header className="account-card-head">
          <div>
            <strong>忘记密码怎么办</strong>
            <span>StruBrowser 不自带邮件服务，重置由系统管理员完成</span>
          </div>
        </header>
        <ul className="account-list">
          <li>联系系统管理员，在「账户中心 → 用户管理」里为你设置新密码。</li>
          <li>管理员重置后旧密码立即失效；已登录的其它浏览器会话仍然有效，公共电脑上请主动退出登录。</li>
          <li>
            如果唯一的系统管理员忘了密码，可在服务端运行
            <code>npm run reset-password -- 邮箱 新密码</code>
            直接重置。
          </li>
        </ul>
      </section>
    </div>
  );
}
