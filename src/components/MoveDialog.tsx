import { useState } from 'react';
import ModalShell from './ModalShell';

export interface MoveDelta {
  dx: number;
  dy: number;
  dz: number;
}

interface MoveDialogProps {
  selectionCount: number;
  onClose: () => void;
  onApply: (delta: MoveDelta) => void;
}

export default function MoveDialog({ selectionCount, onClose, onApply }: MoveDialogProps) {
  const [dx, setDx] = useState('1');
  const [dy, setDy] = useState('0');
  const [dz, setDz] = useState('0');
  const [error, setError] = useState('');

  const apply = () => {
    const values = [Number(dx), Number(dy), Number(dz)];
    if (values.some((value) => !Number.isFinite(value))) {
      setError('请输入有效数字');
      return;
    }
    if (values.every((value) => Math.abs(value) < 1e-9)) {
      setError('平移量不能全为 0');
      return;
    }
    onApply({ dx: values[0], dy: values[1], dz: values[2] });
  };

  return (
    <ModalShell cardClassName="modal-card move-card" ariaLabel="平移构件">
        <div className="modal-head">
          <div>
            <strong>平移构件</strong>
            <span>已选择 {selectionCount} 个构件 · 单位米 · Z 为标高方向</span>
          </div>
          <button className="modal-close" onClick={onClose} aria-label="关闭">✕</button>
        </div>
        <div className="modal-body">
          <div className="move-grid">
            <label><span>ΔX</span><input type="number" step="0.1" value={dx} onChange={(event) => setDx(event.target.value)} /></label>
            <label><span>ΔY</span><input type="number" step="0.1" value={dy} onChange={(event) => setDy(event.target.value)} /></label>
            <label><span>ΔZ</span><input type="number" step="0.1" value={dz} onChange={(event) => setDz(event.target.value)} /></label>
          </div>
          {error ? <div className="modal-error">{error}</div> : null}
          <div className="modal-note">
            墙/柱平移后保持高度不变（底部与顶部偏移同步调整）；导入网格使用整体偏移，不重写顶点。
            提示：选中后可用方向键微调（0.1 m，按住 Shift 为 1 m）。
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
