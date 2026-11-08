import { useState } from 'react';
import type { KeyboardEvent } from 'react';
import { parseAngle, parseLength, polarPoint } from '../bim/coordinates';
import type { Vec2 } from '../bim/types';
import type { Tool } from '../ModelViewport';

const TOOL_LABELS: Record<Tool, string> = {
  select: '选择', wall: '墙', column: '柱', slab: '楼板', grid: '轴网', primitive: '体量',
};

interface DrawCoordinateBarProps {
  tool: Tool;
  /** 已拾取的第一点（轴网/墙/板/体量需要两点） */
  draftStart: Vec2 | null;
  /** 当前光标在工作平面上的位置，用于「取光标」 */
  cursor: Vec2 | null;
  levelLabel: string;
  onPick: (point: Vec2) => void;
  onCancel: () => void;
}

/**
 * 绘制时的坐标输入条：可直接键入选点，不必用鼠标点。
 * - 两点构件（墙/板/轴网/体量）：先输第一点，再输第二点，或改用「长度 + 角度」极坐标；
 * - 柱：只需一个放置点。
 * 数值默认按米解释，也接受 `3600mm`、`360cm` 这类写法。
 */
export default function DrawCoordinateBar({
  tool, draftStart, cursor, levelLabel, onPick, onCancel,
}: DrawCoordinateBarProps) {
  const singlePoint = tool === 'column';
  const [x, setX] = useState(() => (draftStart ? draftStart[0].toFixed(3) : ''));
  const [y, setY] = useState(() => (draftStart ? draftStart[1].toFixed(3) : ''));
  const [length, setLength] = useState('');
  const [angle, setAngle] = useState('90');
  const [error, setError] = useState('');

  function takeCursor() {
    if (!cursor) return;
    setX(cursor[0].toFixed(3));
    setY(cursor[1].toFixed(3));
    setError('');
  }

  function submitPoint() {
    const px = parseLength(x);
    const py = parseLength(y);
    if (px === null || py === null) {
      setError('坐标无法识别，示例：3.6 或 3600mm');
      return;
    }
    setError('');
    onPick([px, py]);
    // 松开焦点，避免按钮保持聚焦后再按 Enter 又放一个点
    (document.activeElement as HTMLElement | null)?.blur();
  }

  function submitPolar() {
    if (!draftStart) return;
    const distance = parseLength(length);
    const degrees = parseAngle(angle);
    if (distance === null || degrees === null || Math.abs(distance) < 1e-6) {
      setError('请输入长度与角度，例如 6 / 90');
      return;
    }
    setError('');
    onPick(polarPoint(draftStart, distance, degrees));
    (document.activeElement as HTMLElement | null)?.blur();
  }

  const onPointKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      submitPoint();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      onCancel();
    }
  };

  const onPolarKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      submitPolar();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      onCancel();
    }
  };

  const stepText = singlePoint ? '放置点' : draftStart ? '第二点' : '第一点';

  return (
    <div className="draw-coords" role="group" aria-label="绘制坐标输入">
      <div className="draw-coords-head">
        <span className="draw-coords-badge">{TOOL_LABELS[tool]}</span>
        <span className="draw-coords-step">{stepText}</span>
        <span className="draw-coords-level">{levelLabel}</span>
        <button className="draw-coords-close" onClick={onCancel} title="取消当前取点（Esc）">✕</button>
      </div>

      <div className="draw-coords-row">
        <label className="draw-coords-field">
          <span>X</span>
          <input
            value={x}
            inputMode="decimal"
            placeholder="0.000"
            autoComplete="off"
            onChange={(event) => { setX(event.target.value); setError(''); }}
            onKeyDown={onPointKeyDown}
            aria-label="X 坐标（米）"
          />
        </label>
        <label className="draw-coords-field">
          <span>Y</span>
          <input
            value={y}
            inputMode="decimal"
            placeholder="0.000"
            autoComplete="off"
            onChange={(event) => { setY(event.target.value); setError(''); }}
            onKeyDown={onPointKeyDown}
            aria-label="Y 坐标（米）"
          />
        </label>
        <button
          className="draw-coords-take"
          onClick={takeCursor}
          disabled={!cursor}
          title={cursor ? `取光标位置（${cursor[0].toFixed(2)}, ${cursor[1].toFixed(2)}）` : '把光标移到视口里再取点'}
        >⌖</button>
      </div>

      <div className="draw-coords-row">
        <button className="draw-coords-ok" onClick={submitPoint} title="按输入坐标确定该点（Enter）">
          {singlePoint ? '放置' : '确定'} ⏎
        </button>
        {!singlePoint && draftStart ? (
          <button className="draw-coords-ok draw-coords-polar-ok" onClick={submitPolar} title="用下方的长度与角度确定第二点（Enter）">
            极坐标 ⏎
          </button>
        ) : null}
      </div>

      {!singlePoint && draftStart ? (
        <div className="draw-coords-row">
          <label className="draw-coords-field">
            <span>长度</span>
            <input
              value={length}
              inputMode="decimal"
              placeholder="6.000"
              autoComplete="off"
              onChange={(event) => { setLength(event.target.value); setError(''); }}
              onKeyDown={onPolarKeyDown}
              aria-label="长度（米）"
            />
          </label>
          <label className="draw-coords-field draw-coords-angle">
            <span>角度</span>
            <input
              value={angle}
              inputMode="decimal"
              placeholder="90"
              autoComplete="off"
              onChange={(event) => { setAngle(event.target.value); setError(''); }}
              onKeyDown={onPolarKeyDown}
              aria-label="角度（度）"
            />
          </label>
        </div>
      ) : null}

      <div className="draw-coords-foot">
        <span className={error ? 'draw-coords-error' : ''}>
          {error
            || (draftStart && !singlePoint
              ? `起点 (${draftStart[0].toFixed(2)}, ${draftStart[1].toFixed(2)})`
              : '单位：米，可写 3600mm')}
        </span>
      </div>
    </div>
  );
}
