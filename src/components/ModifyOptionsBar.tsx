import type { ChangeEvent, KeyboardEvent } from 'react';
import { MODIFY_LABELS, MODIFY_OPTION_KEYS, modifyPrompt } from '../bim/modify';
import type { ModifyOptionKey, ModifyOptions, ModifySession } from '../bim/modify';

interface ModifyOptionsBarProps {
  session: ModifySession;
  canFinish: boolean;
  onOptions: (patch: Partial<ModifyOptions>) => void;
  onNumeric: (value: number | null) => void;
  onCenter: () => void;
  onFinish: () => void;
  onCancel: () => void;
}

const OPTION_LABELS: Record<ModifyOptionKey, string> = {
  constrain: '约束（正交 / 15°）',
  copy: '复制（保留原件）',
  multiple: '多个（连续放置）',
  number: '个数',
  distance: '距离',
  angle: '角度',
  ratio: '比例',
  moveToLast: '到最后一个',
  splitGap: '拆分间隙',
  center: '放置中心',
};

/** 数值字段同时也是 Revit 的「临时尺寸」输入框：输入数值后回车即完成。 */
function numericOption(session: ModifySession): { key: 'distance' | 'angle' | 'ratio'; unit: string; value: number } | null {
  switch (session.command) {
    case 'move': case 'copy': case 'array-linear': case 'offset':
      return { key: 'distance', unit: 'm', value: session.options.distance };
    case 'rotate': case 'array-radial':
      return { key: 'angle', unit: '°', value: session.options.angle };
    case 'scale':
      return { key: 'ratio', unit: '×', value: session.options.ratio };
    default: return null;
  }
}

export default function ModifyOptionsBar({
  session, canFinish, onOptions, onNumeric, onCenter, onFinish, onCancel,
}: ModifyOptionsBarProps) {
  const keys = MODIFY_OPTION_KEYS[session.command];
  const numeric = numericOption(session);
  const has = (key: ModifyOptionKey) => keys.includes(key);

  const numberField = (key: 'number' | 'splitGap', label: string, step: number, min: number, unit: string) => (
    <label className="options-field" key={key}>
      <span>{label}</span>
      <input
        type="number"
        step={step}
        min={min}
        value={session.options[key]}
        onChange={(event: ChangeEvent<HTMLInputElement>) => {
          const value = Number(event.target.value);
          if (Number.isFinite(value)) onOptions({ [key]: key === 'number' ? Math.max(2, Math.min(200, Math.round(value))) : Math.max(0, value) });
        }}
      />
      <em>{unit}</em>
    </label>
  );

  const onNumericKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      onFinish();
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      (event.target as HTMLInputElement).blur();
      onCancel();
    }
  };

  return (
    <div className="modify-options-bar" role="toolbar" aria-label="修改选项栏">
      <div className="options-command">
        <span className="options-badge">{MODIFY_LABELS[session.command]}</span>
        <span className="options-prompt">{session.note || modifyPrompt(session)}</span>
      </div>

      <div className="options-controls">
        {has('constrain') ? (
          <label className="options-check" title="移动/阵列沿水平或垂直；旋转按 15° 增量">
            <input type="checkbox" checked={session.options.constrain} onChange={(event) => onOptions({ constrain: event.target.checked })} />
            约束
          </label>
        ) : null}
        {has('copy') ? (
          <label className="options-check">
            <input type="checkbox" checked={session.options.copy} onChange={(event) => onOptions({ copy: event.target.checked })} />
            复制
          </label>
        ) : null}
        {has('multiple') ? (
          <label className="options-check" title="连续单击可放置多个副本，Esc 结束">
            <input type="checkbox" checked={session.options.multiple} onChange={(event) => onOptions({ multiple: event.target.checked })} />
            多个
          </label>
        ) : null}
        {has('moveToLast') ? (
          <label className="options-check" title="第二点为最后一个构件的位置（总距离 / (个数-1)）">
            <input type="checkbox" checked={session.options.moveToLast} onChange={(event) => onOptions({ moveToLast: event.target.checked })} />
            {OPTION_LABELS.moveToLast}
          </label>
        ) : null}
        {has('number') ? numberField('number', '个数', 1, 2, '个') : null}
        {has('splitGap') ? numberField('splitGap', '间隙', 0.05, 0, 'm') : null}
        {has('center') ? (
          <button className="options-button" onClick={onCenter} title="在视口中单击重新放置旋转中心">
            ⌖ 放置中心
          </button>
        ) : null}

        {numeric ? (
          <label className="options-field options-dimension" key={`${session.command}-${session.points.length}`}>
            <span>{session.command === 'scale' ? '比例' : session.command === 'rotate' || session.command === 'array-radial' ? '角度' : '临时尺寸'}</span>
            <input
              data-modify-numeric
              type="number"
              step={numeric.key === 'angle' ? 15 : numeric.key === 'ratio' ? 0.1 : 0.1}
              value={session.numeric ?? numeric.value}
              autoFocus={session.status === 'active' && session.points.length >= 1 && !session.centerPending}
              onChange={(event) => {
                const raw = event.target.value;
                const value = Number(raw);
                onOptions({ [numeric.key]: raw === '' ? 0 : value });
                onNumeric(raw === '' ? null : (Number.isFinite(value) ? value : null));
              }}
              onKeyDown={onNumericKeyDown}
              title="输入数值后按 Enter 直接完成（Revit 临时尺寸）"
            />
            <em>{numeric.unit}</em>
          </label>
        ) : null}

        <button className="options-button options-finish" onClick={onFinish} disabled={!canFinish} title="完成当前命令（Enter）">完成 ⏎</button>
        <button className="options-button options-cancel" onClick={onCancel} title="逐级退出（Esc）">取消 Esc</button>
      </div>
    </div>
  );
}
