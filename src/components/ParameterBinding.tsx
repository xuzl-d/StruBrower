/**
 * 属性面板中的参数绑定控件：
 * 未关联时是普通数值输入，点击 fx 即可输入公式；已关联时数值只读并显示公式与解除入口。
 * 公式实时预览通过与内核相同的求值器计算，不写文档。
 */
import { useEffect, useMemo, useState } from 'react';
import { previewFormula } from '../bim/parameters';
import type { ProjectDocument } from '../bim/types';
import { NumberField, ReadonlyRow } from './Fields';

export interface ParameterBindingProps {
  label: string;
  value: number;
  unit?: string;
  step?: number;
  min?: number;
  max?: number;
  formula?: string;
  project: ProjectDocument;
  /** 实例参数可带构件 id，预览时注入该构件的上下文变量 */
  elementId?: string;
  onValue: (value: number) => void;
  onFormula: (formula: string | null) => void;
}

export default function ParameterBinding({
  label, value, unit, step, min, max, formula, project, elementId, onValue, onFormula,
}: ParameterBindingProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(formula ?? '');
  useEffect(() => {
    if (!editing) setDraft(formula ?? '');
  }, [formula, editing]);

  const preview = useMemo(
    () => (draft.trim() ? previewFormula(project, draft, elementId) : null),
    [draft, project, elementId],
  );
  const commit = () => {
    const next = draft.trim();
    if (next !== (formula ?? '')) onFormula(next || null);
    setEditing(false);
  };

  return (
    <div className="parameter-binding">
      {formula ? (
        <>
          <ReadonlyRow label={label} value={`${Number(value.toFixed(3))}${unit ? ` ${unit}` : ''}`} />
          <div className="parameter-link-row">
            <span className="fx-badge linked">fx</span>
            <code title={formula}>{formula}</code>
            <button type="button" onClick={() => { setDraft(formula); setEditing(true); }} title="编辑关联公式">编辑</button>
            <button type="button" onClick={() => onFormula(null)} title="解除关联，恢复手动输入">解除</button>
          </div>
        </>
      ) : (
        <>
          <NumberField label={label} value={value} unit={unit} step={step} min={min} max={max} onCommit={onValue} />
          <button
            type="button"
            className="fx-button"
            title="关联到全局参数 / 公式"
            onClick={() => { setDraft(''); setEditing(true); }}
          >fx</button>
        </>
      )}
      {editing ? (
        <div className="parameter-formula-editor">
          <input
            className="manager-input"
            autoFocus
            placeholder="例如 标准墙厚 * 2 或 层高 / 10"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onBlur={commit}
            onKeyDown={(event) => {
              if (event.key === 'Enter') event.currentTarget.blur();
              if (event.key === 'Escape') { setDraft(formula ?? ''); setEditing(false); }
            }}
          />
          {preview ? (
            <em className={preview.ok ? 'formula-preview' : 'formula-preview error'}>
              {preview.ok ? `= ${Number(preview.value.toFixed(4))}` : preview.error}
            </em>
          ) : null}
          <button type="button" onMouseDown={(event) => event.preventDefault()} onClick={commit}>应用</button>
          <button type="button" onMouseDown={(event) => event.preventDefault()} onClick={() => setEditing(false)}>取消</button>
        </div>
      ) : null}
    </div>
  );
}
