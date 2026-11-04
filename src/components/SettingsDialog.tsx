import { useEffect, useState } from 'react';
import { adminApi, ApiError } from '../data';
import type { AdminUser, AiSettingsView, AuthUser } from '../data';
import { DEFAULT_VIEW_SETTINGS, FONT_SCALES, RENDER_SCALES, SNAP_STEPS } from '../settings';
import type { ViewSettings } from '../settings';

type Tab = 'view' | 'users' | 'ai';

interface SettingsDialogProps {
  currentUser: AuthUser | null;
  settings: ViewSettings;
  onSettingsChange: (next: ViewSettings) => void;
  onClose: () => void;
  onToast: (message: string) => void;
  onSelfUpdated: (user: AuthUser) => void;
  initialTab?: Tab;
  diagnostics?: { renderer?: string; software?: boolean; elements?: number; triangles?: number };
}

const COLOR_FIELDS: Array<{ key: 'highlightColor' | 'backgroundColor' | 'gridColor' | 'bubbleColor'; label: string; hint: string }> = [
  { key: 'highlightColor', label: '选中高亮', hint: '选中构件的高亮色' },
  { key: 'backgroundColor', label: '视口背景', hint: '三维/平面视图的背景色' },
  { key: 'gridColor', label: '轴网线', hint: '轴网线的颜色' },
  { key: 'bubbleColor', label: '轴网气泡', hint: '端部圆圈与描边颜色' },
];

const TOGGLE_FIELDS: Array<{ key: 'showGroundGrid' | 'showLevelGrid' | 'showGrids' | 'showBubbles' | 'showAxisIndicator' | 'showCoordinates' | 'showStats' | 'objectSnap' | 'gridSnap'; label: string; hint: string }> = [
  { key: 'showGroundGrid', label: '地面参考网格', hint: '视口底部的世界网格' },
  { key: 'showLevelGrid', label: '工作平面网格', hint: '当前标高上的辅助网格' },
  { key: 'showGrids', label: '轴网', hint: '轴网线总开关' },
  { key: 'showBubbles', label: '轴网气泡', hint: '端部圆圈与名称' },
  { key: 'showAxisIndicator', label: '坐标轴指示器', hint: '左下角 XYZ 指示' },
  { key: 'showCoordinates', label: '光标坐标', hint: '底部状态栏的 XYZ 坐标' },
  { key: 'showStats', label: '构件统计', hint: '底部状态栏的构件数与三角面' },
  { key: 'objectSnap', label: '对象捕捉', hint: '端点 / 中点 / 交点' },
  { key: 'gridSnap', label: '网格吸附', hint: '按吸附步长取整' },
];

export default function SettingsDialog({
  currentUser,
  settings,
  onSettingsChange,
  onClose,
  onToast,
  onSelfUpdated,
  initialTab = 'view',
  diagnostics,
}: SettingsDialogProps) {
  const isAdmin = Boolean(currentUser?.isAdmin);
  const [tab, setTab] = useState<Tab>(initialTab);
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const [newEmail, setNewEmail] = useState('');
  const [newName, setNewName] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [newIsAdmin, setNewIsAdmin] = useState(false);

  const [ai, setAi] = useState<AiSettingsView | null>(null);
  const [provider, setProvider] = useState<'mock' | 'openai'>('mock');
  const [baseUrl, setBaseUrl] = useState('');
  const [model, setModel] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [timeoutMs, setTimeoutMs] = useState(60000);
  const [testResult, setTestResult] = useState<{ ok: boolean; text: string } | null>(null);
  const [ping, setPing] = useState<number | null>(null);

  const set = <K extends keyof ViewSettings>(key: K, value: ViewSettings[K]) => {
    onSettingsChange({ ...settings, [key]: value });
  };

  const resetViewSettings = () => {
    onSettingsChange({ ...DEFAULT_VIEW_SETTINGS });
    onToast('已恢复默认设置');
  };

  const loadUsers = async () => {
    if (!isAdmin) return;
    setLoading(true);
    try {
      const data = await adminApi.users();
      setUsers(data.users);
      setError('');
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : '读取用户失败');
    } finally {
      setLoading(false);
    }
  };

  const loadAi = async () => {
    if (!isAdmin) return;
    try {
      const data = await adminApi.aiSettings();
      setAi(data);
      setProvider(data.provider);
      setBaseUrl(data.baseUrl);
      setModel(data.model);
      setTimeoutMs(data.timeoutMs);
      setApiKey('');
      setError('');
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : '读取 AI 设置失败');
    }
  };

  useEffect(() => {
    void loadUsers();
    void loadAi();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAdmin]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const samples: number[] = [];
      for (let index = 0; index < 3; index += 1) {
        const started = performance.now();
        try {
          await fetch('/api/health', { cache: 'no-store' });
          samples.push(performance.now() - started);
        } catch {
          // 本地模式/离线时忽略
        }
      }
      if (cancelled || !samples.length) return;
      samples.sort((a, b) => a - b);
      setPing(Math.round(samples[1] ?? samples[0]));
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if ((tab === 'users' || tab === 'ai') && !isAdmin) setTab('view');
  }, [tab, isAdmin]);

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
    onToast('已创建用户');
    await loadUsers();
  });

  const renameUser = (user: AdminUser) => {
    const name = window.prompt('新的显示名称', user.name)?.trim();
    if (!name || name === user.name) return;
    void run(async () => {
      const result = await adminApi.updateUser(user.id, { name });
      if (result.user.id === currentUser?.id && currentUser) onSelfUpdated({ ...currentUser, name });
      onToast('已更新名称');
      await loadUsers();
    });
  };

  const resetPassword = (user: AdminUser) => {
    const password = window.prompt(`为 ${user.email} 设置新密码（至少 6 位）`);
    if (!password) return;
    if (password.length < 6) {
      setError('密码至少 6 位');
      return;
    }
    void run(async () => {
      await adminApi.updateUser(user.id, { password });
      onToast('已重置密码');
    });
  };

  const toggleAdmin = (user: AdminUser) => {
    void run(async () => {
      const result = await adminApi.updateUser(user.id, { isAdmin: !user.isAdmin });
      if (result.user.id === currentUser?.id && currentUser) onSelfUpdated({ ...currentUser, isAdmin: result.user.isAdmin });
      onToast(result.user.isAdmin ? '已设为系统管理员' : '已取消系统管理员');
      await loadUsers();
    });
  };

  const removeUser = (user: AdminUser) => {
    if (!window.confirm(`删除用户 ${user.email}？其项目成员关系会一并移除。`)) return;
    void run(async () => {
      await adminApi.deleteUser(user.id);
      onToast('已删除用户');
      await loadUsers();
    });
  };

  const saveAi = () => run(async () => {
    const result = await adminApi.saveAiSettings({
      provider,
      baseUrl: baseUrl.trim(),
      model: model.trim(),
      timeoutMs,
      ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
    });
    setAi(result);
    setApiKey('');
    onToast(result.ready ? 'AI 设置已保存' : '已保存，但还缺少 API key');
  });

  const testAi = () => run(async () => {
    const result = await adminApi.testAi();
    setTestResult({
      ok: result.ok,
      text: result.ok ? `连接成功（${result.provider}${result.model ? ` · ${result.model}` : ''}）` : `连接失败：${result.error ?? '未知错误'}`,
    });
  });

  const clearKey = () => run(async () => {
    const result = await adminApi.saveAiSettings({ clearKey: true });
    setAi(result);
    onToast('已清除已保存的 API key');
  });

  const sourceLabel = (key: string): string => {
    const source = ai?.source?.[key];
    return source === 'db' ? '数据库' : source === 'env' ? '环境变量' : '未设置';
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-card settings-card" onClick={(event) => event.stopPropagation()}>
        <div className="modal-head">
          <div>
            <strong>设置</strong>
            <span>{isAdmin ? '软件偏好 · 用户与权限 · AI 模型' : '软件偏好（显示与交互）'}</span>
          </div>
          <button className="modal-close" onClick={onClose} aria-label="关闭">✕</button>
        </div>

        <div className="settings-tabs">
          <button className={tab === 'view' ? 'active' : ''} onClick={() => setTab('view')}>软件设置</button>
          {isAdmin ? <button className={tab === 'users' ? 'active' : ''} onClick={() => setTab('users')}>用户管理</button> : null}
          {isAdmin ? <button className={tab === 'ai' ? 'active' : ''} onClick={() => setTab('ai')}>AI 设置</button> : null}
        </div>

        <div className="modal-body">
          {error ? <div className="modal-error">{error}</div> : null}

          {tab === 'view' ? (
            <>
              <div className="settings-section-title">颜色</div>
              <div className="settings-colors">
                {COLOR_FIELDS.map((field) => (
                  <label className="settings-color" key={field.key} title={field.hint}>
                    <span>{field.label}</span>
                    <input
                      type="color"
                      value={settings[field.key]}
                      onChange={(event) => set(field.key, event.target.value)}
                    />
                    <code>{settings[field.key]}</code>
                  </label>
                ))}
              </div>

              <div className="settings-section-title">显示</div>
              <div className="settings-toggles">
                {TOGGLE_FIELDS.map((field) => (
                  <label className="settings-toggle" key={field.key} title={field.hint}>
                    <input
                      type="checkbox"
                      checked={settings[field.key]}
                      onChange={(event) => set(field.key, event.target.checked)}
                    />
                    <span>{field.label}</span>
                    <em>{field.hint}</em>
                  </label>
                ))}
              </div>

              <div className="settings-section-title">交互</div>
              <label className="settings-toggle">
                <input
                  type="checkbox"
                  checked={settings.rotateDamping}
                  onChange={(event) => set('rotateDamping', event.target.checked)}
                />
                <span>旋转惯性</span>
                <em>松开鼠标后继续减速滑动；关闭后立即停住</em>
              </label>
              <label className="settings-inline-row">
                <span>渲染分辨率</span>
                <select
                  value={settings.renderScale}
                  onChange={(event) => set('renderScale', Number(event.target.value))}
                >
                  {RENDER_SCALES.map((scale) => (
                    <option key={scale} value={scale}>{Math.round(scale * 100)}%</option>
                  ))}
                </select>
                <em>相对设备像素比；弱显卡 / 远程桌面建议 75%</em>
              </label>
              <label className="settings-inline-row">
                <span>界面字号</span>
                <select
                  value={settings.uiFontScale}
                  onChange={(event) => set('uiFontScale', Number(event.target.value))}
                >
                  {FONT_SCALES.map((scale) => (
                    <option key={scale} value={scale}>{Math.round(scale * 100)}%</option>
                  ))}
                </select>
                <em>整体放大/缩小界面文字，适合高分屏或小字看不清的电脑</em>
              </label>
              <label className="settings-inline-row">
                <span>吸附步长</span>
                <select
                  value={settings.snapStep}
                  onChange={(event) => set('snapStep', Number(event.target.value))}
                >
                  {SNAP_STEPS.map((step) => (
                    <option key={step} value={step}>{step} m</option>
                  ))}
                </select>
                <em>绘制墙/柱/板/轴网时坐标的取整步长</em>
              </label>

              <div className="settings-section-title">诊断</div>
              <div className="settings-diagnostics">
                <span>渲染器</span>
                <b>{diagnostics?.renderer ?? '检测中…'}{diagnostics?.software ? '（软件渲染）' : ''}</b>
                <span>设备像素比</span>
                <b>{typeof window !== 'undefined' ? window.devicePixelRatio.toFixed(2) : '—'}</b>
                <span>CPU 逻辑核心</span>
                <b>{typeof navigator !== 'undefined' && navigator.hardwareConcurrency ? navigator.hardwareConcurrency : '—'}</b>
                <span>与服务器延迟</span>
                <b>{ping === null ? '本地/不可用' : `${ping} ms`}</b>
                <span>当前项目</span>
                <b>{diagnostics ? `${diagnostics.elements ?? 0} 构件 · ${(diagnostics.triangles ?? 0).toLocaleString()} 三角面` : '—'}</b>
              </div>
              <div className="settings-actions-row">
                <button
                  onClick={() => {
                    const lines = [
                      `渲染器: ${diagnostics?.renderer ?? '未知'}${diagnostics?.software ? ' (软件渲染)' : ''}`,
                      `设备像素比: ${window.devicePixelRatio}`,
                      `CPU 核心: ${navigator.hardwareConcurrency ?? '未知'}`,
                      `服务器延迟: ${ping === null ? '不可用' : `${ping} ms`}`,
                      `项目: ${diagnostics?.elements ?? 0} 构件 / ${diagnostics?.triangles ?? 0} 三角面`,
                      `UA: ${navigator.userAgent}`,
                    ];
                    void navigator.clipboard?.writeText(lines.join('\n'))
                      .then(() => onToast('诊断信息已复制'))
                      .catch(() => onToast('复制失败，请手动选择文本'));
                  }}
                >复制诊断信息</button>
              </div>

              <div className="modal-note">
                软件设置保存在本机浏览器（按设备生效），切换项目不会丢失；颜色使用 #RRGGBB。
                如果「渲染器」显示软件渲染，说明这台机器没有可用的 GPU 加速，卡顿与网络无关。
              </div>
            </>
          ) : null}

          {tab === 'users' && isAdmin ? (
            <>
              <div className="settings-create">
                <input placeholder="邮箱" value={newEmail} onChange={(event) => setNewEmail(event.target.value)} />
                <input placeholder="显示名称" value={newName} onChange={(event) => setNewName(event.target.value)} />
                <input
                  type="password"
                  placeholder="初始密码（≥6 位）"
                  value={newPassword}
                  onChange={(event) => setNewPassword(event.target.value)}
                />
                <label className="settings-check">
                  <input type="checkbox" checked={newIsAdmin} onChange={(event) => setNewIsAdmin(event.target.checked)} />
                  管理员
                </label>
                <button onClick={() => void createUser()} disabled={busy}>创建用户</button>
              </div>

              {loading ? <div className="modal-note">正在读取用户…</div> : null}
              <div className="settings-list">
                {users.map((user) => (
                  <div className="settings-row" key={user.id}>
                    <div className="settings-user">
                      <strong>
                        {user.name}
                        {user.id === currentUser?.id ? <em>（你）</em> : null}
                        {user.isAdmin ? <span className="settings-badge">管理员</span> : null}
                      </strong>
                      <span>{user.email} · 项目 {user.ownedProjects} 个 · 成员 {user.memberships} 个</span>
                    </div>
                    <div className="settings-actions">
                      <button onClick={() => renameUser(user)} disabled={busy}>改名</button>
                      <button onClick={() => resetPassword(user)} disabled={busy}>重置密码</button>
                      <button onClick={() => toggleAdmin(user)} disabled={busy}>
                        {user.isAdmin ? '取消管理员' : '设为管理员'}
                      </button>
                      <button
                        className="danger"
                        onClick={() => removeUser(user)}
                        disabled={busy || user.id === currentUser?.id}
                      >删除</button>
                    </div>
                  </div>
                ))}
              </div>
              <div className="modal-note">至少保留一名系统管理员；拥有项目的用户需先处理项目才能删除。</div>
            </>
          ) : null}

          {tab === 'ai' && isAdmin ? (
            <>
              <div className="settings-form">
                <label>
                  <span>提供方</span>
                  <select value={provider} onChange={(event) => setProvider(event.target.value as 'mock' | 'openai')}>
                    <option value="mock">Mock（本地模拟，无需 key）</option>
                    <option value="openai">OpenAI 兼容接口（DeepSeek / 通义 / Ollama…）</option>
                  </select>
                </label>
                <label>
                  <span>接口地址</span>
                  <input
                    value={baseUrl}
                    placeholder="https://api.deepseek.com/v1"
                    onChange={(event) => setBaseUrl(event.target.value)}
                    disabled={provider === 'mock'}
                  />
                  <em>来源：{sourceLabel('baseUrl')}</em>
                </label>
                <label>
                  <span>模型</span>
                  <input
                    value={model}
                    placeholder="deepseek-chat"
                    onChange={(event) => setModel(event.target.value)}
                    disabled={provider === 'mock'}
                  />
                  <em>来源：{sourceLabel('model')}</em>
                </label>
                <label>
                  <span>API Key</span>
                  <input
                    type="password"
                    value={apiKey}
                    placeholder={ai?.hasKey ? `已保存 ${ai.keyHint}（留空则不修改）` : 'sk-...'}
                    onChange={(event) => setApiKey(event.target.value)}
                    disabled={provider === 'mock'}
                    autoComplete="off"
                  />
                  <em>来源：{sourceLabel('apiKey')} · 加密存储，不会回传给浏览器</em>
                </label>
                <label>
                  <span>超时（ms）</span>
                  <input
                    type="number"
                    value={timeoutMs}
                    min={1000}
                    max={300000}
                    step={1000}
                    onChange={(event) => setTimeoutMs(Number(event.target.value))}
                  />
                </label>
              </div>

              <div className="settings-actions-row">
                <button className="primary" onClick={() => void saveAi()} disabled={busy}>保存 AI 设置</button>
                <button onClick={() => void testAi()} disabled={busy}>测试连接</button>
                {ai?.hasKey ? <button className="danger" onClick={() => void clearKey()} disabled={busy}>清除已保存的 key</button> : null}
              </div>

              <div className="settings-status">
                <span className={ai?.ready ? 'ok' : 'warn'}>{ai?.ready ? '就绪' : '未就绪（缺少 API key）'}</span>
                <span>当前：{ai ? `${ai.provider}${ai.provider === 'mock' ? '' : ` · ${ai.model}`}` : '—'}</span>
                {testResult ? <span className={testResult.ok ? 'ok' : 'bad'}>{testResult.text}</span> : null}
              </div>

              <div className="modal-note">
                环境变量也能配置（低优先级）：STRU_AI_PROVIDER / STRU_AI_BASE_URL / STRU_AI_MODEL / STRU_AI_API_KEY。
                这里保存的设置优先，且立即生效。
              </div>
            </>
          ) : null}
        </div>

        <div className="modal-foot settings-foot">
          {tab === 'view' ? (
            <button className="settings-reset" onClick={resetViewSettings}>恢复默认设置</button>
          ) : <span />}
          <span>软件设置只影响本机视图；用户与 AI 配置需要系统管理员，项目成员仍在「管理 → 成员权限」中维护。</span>
        </div>
      </div>
    </div>
  );
}
