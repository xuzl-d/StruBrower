import { useRef } from 'react';

interface PanelResizerProps {
  side: 'left' | 'right';
  width: number;
  defaultWidth: number;
  min: number;
  max: number;
  onResize: (width: number) => void;
}

const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));

/** 面板宽度拖拽条：拖动调整，双击恢复默认。 */
export default function PanelResizer({ side, width, defaultWidth, min, max, onResize }: PanelResizerProps) {
  const startRef = useRef<{ x: number; width: number } | null>(null);

  return (
    <div
      className={`panel-resizer ${side}`}
      role="separator"
      aria-orientation="vertical"
      aria-label={side === 'left' ? '调整项目浏览器宽度' : '调整属性栏宽度'}
      title="拖动调整宽度，双击恢复默认"
      onPointerDown={(event) => {
        event.preventDefault();
        event.currentTarget.setPointerCapture(event.pointerId);
        startRef.current = { x: event.clientX, width };
      }}
      onPointerMove={(event) => {
        const start = startRef.current;
        if (!start) return;
        const delta = side === 'left' ? event.clientX - start.x : start.x - event.clientX;
        onResize(clamp(Math.round(start.width + delta), min, max));
      }}
      onPointerUp={(event) => {
        startRef.current = null;
        if (event.currentTarget.hasPointerCapture(event.pointerId)) {
          event.currentTarget.releasePointerCapture(event.pointerId);
        }
      }}
      onPointerCancel={() => {
        startRef.current = null;
      }}
      onDoubleClick={() => onResize(defaultWidth)}
    />
  );
}
