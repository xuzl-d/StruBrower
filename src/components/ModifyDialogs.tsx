import { useState } from 'react';
import ModalShell from './ModalShell';

export interface RotateDelta {
  angleDeg: number;
  center: [number, number];
}

export interface MirrorDelta {
  axis: 'vertical' | 'horizontal';
  position: number;
  keepOriginal: boolean;
}

export type ArrayDelta =
  | { mode: 'linear'; count: number; dx: number; dy: number }
  | { mode: 'polar'; count: number; totalAngleDeg: number; center: [number, number] };

interface BaseProps {
  selectionCount: number;
  onClose: () => void;
}

function parseNumber(value: string): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** 旋转：绕平面基点旋转一定角度（逆时针为正）。 */
export function RotateDialog({
  selectionCount,
  defaultCenter,
  onClose,
  onApply,
}: BaseProps & { defaultCenter: [number, number]; onApply: (delta: RotateDelta) => void }) {
  const [angle, setAngle] = useState('90');
  const [cx, setCx] = useState(String(defaultCenter[0]));
  const [cy, setCy] = useState(String(defaultCenter[1]));
  const [error, setError] = useState('');

  const apply = () => {
    const angleValue = parseNumber(angle);
    const x = parseNumber(cx);
    const y = parseNumber(cy);
    if (angleValue === null || x === null || y === null) {
      setError('请输入有效数字');
      return;
    }
    if (Math.abs(angleValue) < 1e-9) {
      setError('旋转角度不能为 0');
      return;
    }
    onApply({ angleDeg: angleValue, center: [x, y] });
  };

  return (
    <ModalShell cardClassName="modal-card move-card">
        <div className="modal-head">
          <div>
            <strong>旋转构件</strong>
            <span>已选择 {selectionCount} 个构件 · 逆时针为正 · 单位：度 / 米</span>
          </div>
          <button className="modal-close" onClick={onClose} aria-label="关闭">✕</button>
        </div>
        <div className="modal-body">
          <div className="move-grid">
            <label><span>角度°</span><input type="number" step="15" value={angle} onChange={(event) => setAngle(event.target.value)} /></label>
            <label><span>基点 X</span><input type="number" step="0.5" value={cx} onChange={(event) => setCx(event.target.value)} /></label>
            <label><span>基点 Y</span><input type="number" step="0.5" value={cy} onChange={(event) => setCy(event.target.value)} /></label>
          </div>
          {error ? <div className="modal-error">{error}</div> : null}
          <div className="modal-note">
            默认基点为选中构件的形心；墙/板按顶点旋转，柱累加自身转角，导入网格通过旋转 + 偏移表示，不重写顶点。
          </div>
        </div>
        <div className="modal-foot">
          <div className="modal-actions">
            <button onClick={onClose}>取消</button>
            <button className="primary" onClick={apply}>应用</button>
          </div>
        </div>
    </ModalShell>
  );
}

/** 镜像：关于水平/垂直直线镜像，可选择保留原件。 */
export function MirrorDialog({
  selectionCount,
  onClose,
  onApply,
}: BaseProps & { onApply: (delta: MirrorDelta) => void }) {
  const [axis, setAxis] = useState<'vertical' | 'horizontal'>('vertical');
  const [position, setPosition] = useState('0');
  const [keepOriginal, setKeepOriginal] = useState(false);
  const [error, setError] = useState('');

  const apply = () => {
    const value = parseNumber(position);
    if (value === null) {
      setError('请输入有效的镜像线位置');
      return;
    }
    onApply({ axis, position: value, keepOriginal });
  };

  return (
    <ModalShell cardClassName="modal-card move-card">
        <div className="modal-head">
          <div>
            <strong>镜像构件</strong>
            <span>已选择 {selectionCount} 个构件 · 单位：米</span>
          </div>
          <button className="modal-close" onClick={onClose} aria-label="关闭">✕</button>
        </div>
        <div className="modal-body">
          <div className="move-grid mirror-grid">
            <label>
              <span>镜像线</span>
              <select value={axis} onChange={(event) => setAxis(event.target.value as 'vertical' | 'horizontal')}>
                <option value="vertical">垂直（x = 值）</option>
                <option value="horizontal">水平（y = 值）</option>
              </select>
            </label>
            <label><span>位置</span><input type="number" step="0.5" value={position} onChange={(event) => setPosition(event.target.value)} /></label>
          </div>
          <label className="settings-check move-check">
            <input type="checkbox" checked={keepOriginal} onChange={(event) => setKeepOriginal(event.target.checked)} />
            保留原构件（镜像生成副本）
          </label>
          {error ? <div className="modal-error">{error}</div> : null}
          <div className="modal-note">导入的网格需要翻转几何，暂不支持镜像；如选中会跳过并提示。</div>
        </div>
        <div className="modal-foot">
          <div className="modal-actions">
            <button onClick={onClose}>取消</button>
            <button className="primary" onClick={apply}>应用</button>
          </div>
        </div>
    </ModalShell>
  );
}

/** 阵列：线性（个数 + 间距）或环形（个数 + 总角度 + 中心）。 */
export function ArrayDialog({
  selectionCount,
  defaultCenter,
  onClose,
  onApply,
}: BaseProps & { defaultCenter: [number, number]; onApply: (delta: ArrayDelta) => void }) {
  const [mode, setMode] = useState<'linear' | 'polar'>('linear');
  const [count, setCount] = useState('3');
  const [dx, setDx] = useState('2');
  const [dy, setDy] = useState('0');
  const [angle, setAngle] = useState('360');
  const [cx, setCx] = useState(String(defaultCenter[0]));
  const [cy, setCy] = useState(String(defaultCenter[1]));
  const [error, setError] = useState('');

  const apply = () => {
    const countValue = parseNumber(count);
    if (countValue === null || countValue < 2) {
      setError('阵列个数至少为 2');
      return;
    }
    if (mode === 'linear') {
      const stepX = parseNumber(dx);
      const stepY = parseNumber(dy);
      if (stepX === null || stepY === null) {
        setError('请输入有效间距');
        return;
      }
      if (Math.abs(stepX) < 1e-9 && Math.abs(stepY) < 1e-9) {
        setError('阵列间距不能为 0');
        return;
      }
      onApply({ mode: 'linear', count: countValue, dx: stepX, dy: stepY });
      return;
    }
    const angleValue = parseNumber(angle);
    const x = parseNumber(cx);
    const y = parseNumber(cy);
    if (angleValue === null || x === null || y === null) {
      setError('请输入有效数字');
      return;
    }
    if (Math.abs(angleValue) < 1e-9) {
      setError('总角度不能为 0');
      return;
    }
    onApply({ mode: 'polar', count: countValue, totalAngleDeg: angleValue, center: [x, y] });
  };

  return (
    <ModalShell cardClassName="modal-card move-card">
        <div className="modal-head">
          <div>
            <strong>阵列</strong>
            <span>已选择 {selectionCount} 个构件 · 在原件基础上生成副本</span>
          </div>
          <button className="modal-close" onClick={onClose} aria-label="关闭">✕</button>
        </div>
        <div className="modal-body">
          <div className="move-grid array-mode-row">
            <label>
              <span>类型</span>
              <select value={mode} onChange={(event) => setMode(event.target.value as 'linear' | 'polar')}>
                <option value="linear">线性阵列</option>
                <option value="polar">环形阵列</option>
              </select>
            </label>
            <label><span>个数</span><input type="number" min={2} max={200} step="1" value={count} onChange={(event) => setCount(event.target.value)} /></label>
          </div>
          {mode === 'linear' ? (
            <div className="move-grid">
              <label><span>ΔX</span><input type="number" step="0.5" value={dx} onChange={(event) => setDx(event.target.value)} /></label>
              <label><span>ΔY</span><input type="number" step="0.5" value={dy} onChange={(event) => setDy(event.target.value)} /></label>
            </div>
          ) : (
            <>
              <div className="move-grid">
                <label><span>总角度°</span><input type="number" step="15" value={angle} onChange={(event) => setAngle(event.target.value)} /></label>
                <label><span>中心 X</span><input type="number" step="0.5" value={cx} onChange={(event) => setCx(event.target.value)} /></label>
                <label><span>中心 Y</span><input type="number" step="0.5" value={cy} onChange={(event) => setCy(event.target.value)} /></label>
              </div>
              <div className="modal-note">总角度 360° 时按个数等分；小于 360° 时最后一个副本落在总角度上。</div>
            </>
          )}
          {error ? <div className="modal-error">{error}</div> : null}
        </div>
        <div className="modal-foot">
          <div className="modal-actions">
            <button onClick={onClose}>取消</button>
            <button className="primary" onClick={apply}>应用</button>
          </div>
        </div>
    </ModalShell>
  );
}
