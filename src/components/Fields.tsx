import { useEffect, useState } from 'react';

function formatNumber(value: number): string {
  return String(Number(value.toFixed(3)));
}

interface TextFieldProps {
  label: string;
  value: string;
  onCommit: (value: string) => void;
  placeholder?: string;
}

/** 文本输入：失焦或回车提交，避免每敲一个字就产生一次撤销记录。 */
export function TextField({ label, value, onCommit, placeholder }: TextFieldProps) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);

  const commit = () => {
    const next = draft.trim();
    if (next && next !== value) onCommit(next);
    else setDraft(value);
  };

  return (
    <label className="property-field">
      <span>{label}</span>
      <input
        value={draft}
        placeholder={placeholder}
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
    </label>
  );
}

interface NumberFieldProps {
  label: string;
  value: number;
  onCommit: (value: number) => void;
  step?: number;
  min?: number;
  max?: number;
  unit?: string;
}

/** 数值输入：失焦或回车提交，非法值回滚。 */
export function NumberField({ label, value, onCommit, step = 0.1, min, max, unit }: NumberFieldProps) {
  const [draft, setDraft] = useState(formatNumber(value));
  useEffect(() => setDraft(formatNumber(value)), [value]);

  const commit = () => {
    const parsed = Number(draft);
    const valid = Number.isFinite(parsed)
      && (min === undefined || parsed >= min)
      && (max === undefined || parsed <= max);
    if (valid && Math.abs(parsed - value) > 1e-9) onCommit(parsed);
    else setDraft(formatNumber(value));
  };

  return (
    <label className="property-field">
      <span>{label}</span>
      <span className="number-input">
        <input
          type="number"
          step={step}
          min={min}
          max={max}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === 'Enter') event.currentTarget.blur();
            if (event.key === 'Escape') {
              setDraft(formatNumber(value));
              event.currentTarget.blur();
            }
          }}
        />
        {unit ? <em>{unit}</em> : null}
      </span>
    </label>
  );
}

interface SelectFieldProps {
  label: string;
  value: string;
  options: Array<{ value: string; label: string }>;
  onChange: (value: string) => void;
}

export function SelectField({ label, value, options, onChange }: SelectFieldProps) {
  return (
    <label className="property-field">
      <span>{label}</span>
      <select value={value} onChange={(event) => onChange(event.target.value)}>
        {options.map((option) => (
          <option key={option.value} value={option.value}>{option.label}</option>
        ))}
      </select>
    </label>
  );
}

export function ReadonlyRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="property-field readonly">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}
