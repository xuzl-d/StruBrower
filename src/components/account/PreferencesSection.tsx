import { useEffect, useState } from 'react';
import { DEFAULT_VIEW_SETTINGS, FONT_SCALES, RENDER_SCALES, SNAP_STEPS } from '../../settings';
import type { ViewSettings } from '../../settings';
import type { AccountDiagnostics } from './AccountCenter';

interface PreferencesSectionProps {
  settings: ViewSettings;
  diagnostics?: AccountDiagnostics;
  onSettingsChange: (next: ViewSettings) => void;
  onToast: (message: string) => void;
}

const COLOR_FIELDS: Array<{ key: 'highlightColor' | 'backgroundColor' | 'gridColor' | 'bubbleColor'; label: string; hint: string }> = [
  { key: 'highlightColor', label: '选中高亮', hint: '选中构件的高亮色' },
  { key: 'backgroundColor', label: '视口背景', hint: '三维/平面视图的背景色' },
  { key: 'gridColor', label: '轴网线', hint: '轴网线的颜色' },
  { key: 'bubbleColor', label: '轴网气泡', hint: '端部圆圈与描边颜色' },
];

const TOGGLE_FIELDS: Array<{
  key: 'showGroundGrid' | 'showLevelGrid' | 'showGrids' | 'showBubbles' | 'showAxisIndicator'
  | 'showCoordinates' | 'showStats' | 'objectSnap' | 'gridSnap';
  label: string;
  hint: string;
}> = [
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

/** 软件设置：本机偏好（颜色 / 显示 / 交互 / 诊断），按设备保存在浏览器里 */
export default function PreferencesSection({
  settings,
  diagnostics,
  onSettingsChange,
  onToast,
}: PreferencesSectionProps) {
  const [ping, setPing] = useState<number | null>(null);

  const set = <K extends keyof ViewSettings>(key: K, value: ViewSettings[K]) => {
    onSettingsChange({ ...settings, [key]: value });
  };

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

  const reset = () => {
    onSettingsChange({ ...DEFAULT_VIEW_SETTINGS });
    onToast('已恢复默认设置');
  };

  return (
    <div className="account-cards">
      <section className="account-card">
        <header className="account-card-head">
          <div>
            <strong>颜色</strong>
            <span>影响视口高亮、背景与轴网显示</span>
          </div>
          <button onClick={reset}>恢复默认</button>
        </header>
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
      </section>

      <section className="account-card">
        <header className="account-card-head">
          <div>
            <strong>显示</strong>
            <span>按本机浏览器保存，切换项目不丢失</span>
          </div>
        </header>
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
      </section>

      <section className="account-card">
        <header className="account-card-head">
          <div>
            <strong>交互</strong>
            <span>鼠标方案、旋转手感、渲染分辨率与吸附步长</span>
          </div>
        </header>
        <div className="account-form">
          <label className="account-field">
            <span>鼠标方案</span>
            <select
              value={settings.mouseScheme}
              onChange={(event) => set('mouseScheme', event.target.value === 'classic' ? 'classic' : 'revit')}
            >
              <option value="revit">Revit（左键拖拽旋转 · 轻点两下框选 · 中键平移）</option>
              <option value="classic">经典（左键旋转 · 单击两次框选）</option>
            </select>
            <em>Revit 方案：按住左键拖动立即旋转；轻点构件选中，空白处轻点两下完成框选；Ctrl+拖拽构件为复制</em>
          </label>

          <label className="settings-toggle">
            <input
              type="checkbox"
              checked={settings.rotateDamping}
              onChange={(event) => set('rotateDamping', event.target.checked)}
            />
            <span>旋转惯性</span>
            <em>松开鼠标后继续减速滑动；关闭后立即停住</em>
          </label>

          <label className="account-field">
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

          <label className="account-field">
            <span>界面字号</span>
            <select
              value={settings.uiFontScale}
              onChange={(event) => set('uiFontScale', Number(event.target.value))}
            >
              {FONT_SCALES.map((scale) => (
                <option key={scale} value={scale}>{Math.round(scale * 100)}%</option>
              ))}
            </select>
            <em>基准已按桌面软件字号放大；可再微调 90%–125%，更大可用浏览器缩放</em>
          </label>

          <label className="account-field">
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
        </div>
      </section>

      <section className="account-card">
        <header className="account-card-head">
          <div>
            <strong>诊断</strong>
            <span>反馈卡顿、花屏问题时把这段信息发给管理员</span>
          </div>
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
        </header>
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
        <div className="account-note">
          软件设置保存在本机浏览器（按设备生效），切换项目或账号都不会丢失；颜色使用 #RRGGBB。
          如果「渲染器」显示软件渲染，说明这台机器没有可用的 GPU 加速，卡顿与网络无关。
        </div>
      </section>
    </div>
  );
}
