/** 图层 / 材质管理器共用的「失焦提交」输入，避免每敲一个字符就产生一次撤销记录。 */
import { useEffect, useState } from 'react';

interface TextCommitProps {
  value: string;
  onCommit: (value: string) => void;
  ariaLabel?: string;
  placeholder?: string;
  className?: string;
}

export function TextCommit({ value, onCommit, ariaLabel, placeholder, className }: TextCommitProps) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  const commit = () => {
    const next = draft.trim();
    if (next && next !== value) onCommit(next);
    else setDraft(value);
  };
  return (
    <input
      className={className ?? 'manager-input'}
      aria-label={ariaLabel}
      placeholder={placeholder}
      value={draft}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === 'Enter') event.currentTarget.blur();
        if (event.key === 'Escape') {
          setDraft(value);
          event.currentTarget.blur();
        }
      }}
    />
  );
}

interface NumberCommitProps {
  value: number;
  min: number;
  max: number;
  step?: number;
  onCommit: (value: number) => void;
  ariaLabel?: string;
  suffix?: string;
}

export function NumberCommit({ value, min, max, step = 1, onCommit, ariaLabel, suffix }: NumberCommitProps) {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => setDraft(String(value)), [value]);
  const commit = () => {
    const parsed = Number(draft);
    if (Number.isFinite(parsed) && parsed >= min && parsed <= max && Math.abs(parsed - value) > 1e-9) {
      onCommit(Math.round(parsed * 1000) / 1000);
    } else {
      setDraft(String(value));
    }
  };
  return (
    <span className="manager-number">
      <input
        type="number"
        aria-label={ariaLabel}
        min={min}
        max={max}
        step={step}
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === 'Enter') event.currentTarget.blur();
          if (event.key === 'Escape') {
            setDraft(String(value));
            event.currentTarget.blur();
          }
        }}
      />
      {suffix ? <em>{suffix}</em> : null}
    </span>
  );
}

interface RangeFieldProps {
  label: string;
  value: number;
  min?: number;
  max?: number;
  step?: number;
  onCommit: (value: number) => void;
  hint?: string;
}

export function RangeField({ label, value, min = 0, max = 100, step = 1, onCommit, hint }: RangeFieldProps) {
  // 拖动过程中只更新本地值，松手才写入文档，避免每帧产生一条撤销记录
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  const commit = () => {
    if (Math.abs(draft - value) > 1e-9) onCommit(draft);
  };
  return (
    <label className="manager-range">
      <span>{label}<b>{draft}</b></span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={draft}
        onChange={(event) => setDraft(Number(event.target.value))}
        onPointerUp={commit}
        onKeyUp={commit}
        onBlur={commit}
      />
      {hint ? <small>{hint}</small> : null}
    </label>
  );
}
