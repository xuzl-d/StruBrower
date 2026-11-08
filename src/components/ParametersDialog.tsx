/**
 * 参数关联管理器（Revit「项目参数 / 族类型公式 / 关联参数」）。
 * 四个页签：全局参数、类型参数关联、实例参数关联、依赖关系与问题。
 * 所有写入都经 App.commit → recomputeParameters，因此几何、明细表、IFC、协作端自动联动。
 */
import { useEffect, useMemo, useState } from 'react';
import {
  CONTEXT_VARIABLES, PARAMETER_UNIT_LABELS, TYPE_PARAMETER_SPECS,
  createParameter, elementParameterSpecs, ensureDocumentParameters,
  formatParameterValue, parameterIssues, parameterUsage, previewFormula,
  readElementParameter, readTypeParameter, recomputeParameters, removeParameter,
  renameParameterReferences, setElementFormula, setTypeFormula, upsertParameter,
} from '../bim/parameters';
import type { ParameterUnit, ProjectDocument } from '../bim/types';
import { formulaKeyFor } from '../bim/constraints';
import { isElementLocked } from '../bim/layers';
import { NumberCommit, TextCommit } from './ManagerFields';
import ModalShell from './ModalShell';

export interface ParametersDialogProps {
  project: ProjectDocument;
  /** 视口当前选中构件，实例关联页默认定位到它 */
  selection: string[];
  readOnly: boolean;
  onUpdate: (mutator: (project: ProjectDocument) => ProjectDocument, label: string) => void;
  onClose: () => void;
  onToast?: (text: string) => void;
}

type Tab = 'globals' | 'types' | 'elements' | 'deps';

/** 公式输入：允许清空（解除关联），失焦/回车提交。 */
function FormulaInput({
  value, onCommit, disabled, elementId, project,
}: {
  value: string;
  onCommit: (formula: string | null) => void;
  disabled?: boolean;
  elementId?: string;
  project: ProjectDocument;
}) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  const preview = useMemo(() => {
    if (!draft.trim()) return null;
    return previewFormula(project, draft, elementId);
  }, [draft, project, elementId]);
  const commit = () => {
    const next = draft.trim();
    if (next !== value) onCommit(next || null);
  };
  return (
    <span className="formula-cell">
      <span className={value ? 'fx-badge linked' : 'fx-badge'}>fx</span>
      <input
        className="manager-input formula-input"
        value={draft}
        disabled={disabled}
        placeholder="输入公式以建立关联"
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === 'Enter') event.currentTarget.blur();
          if (event.key === 'Escape') { setDraft(value); event.currentTarget.blur(); }
        }}
      />
      {preview ? (
        <em className={preview.ok ? 'formula-preview' : 'formula-preview error'} title={preview.error ?? ''}>
          {preview.ok ? `= ${Number(preview.value.toFixed(4))}` : preview.error}
        </em>
      ) : null}
    </span>
  );
}

export default function ParametersDialog({
  project, selection, readOnly, onUpdate, onClose, onToast,
}: ParametersDialogProps) {
  const doc = useMemo(() => ensureDocumentParameters(project), [project]);
  const parameters = doc.parameters ?? [];
  const [tab, setTab] = useState<Tab>('globals');
  const [selectedId, setSelectedId] = useState(parameters[0]?.id ?? '');
  const [query, setQuery] = useState('');
  const [elementId, setElementId] = useState(selection[0] ?? doc.elements[0]?.id ?? '');

  const selected = parameters.find((item) => item.id === selectedId) ?? parameters[0] ?? null;
  const issues = useMemo(() => parameterIssues(doc), [doc]);
  const usage = useMemo(() => parameterUsage(doc), [doc]);
  const pending = useMemo(() => recomputeParameters(doc).report, [doc]);

  const apply = (mutator: (current: ProjectDocument) => ProjectDocument, label: string) => {
    if (readOnly) {
      onToast?.('当前角色为查看者，参数只读');
      return;
    }
    onUpdate(mutator, label);
  };

  const recompute = () => apply((current) => recomputeParameters(current).project, '已重算全部关联参数');
  const filtered = parameters.filter((item) => item.name.toLowerCase().includes(query.trim().toLowerCase()));

  const rename = (name: string) => {
    if (!selected || name === selected.name) return;
    if (parameters.some((item) => item.name === name)) {
      onToast?.('已存在同名参数，请使用唯一名称');
      return;
    }
    apply(
      (current) => renameParameterReferences(upsertParameter(current, { ...selected, name }), selected.name, name),
      `已将参数「${selected.name}」重命名为「${name}」并同步所有公式`,
    );
  };

  const element = doc.elements.find((item) => item.id === elementId) ?? doc.elements[0] ?? null;
  const usagesOfSelected = selected ? usage.find((item) => item.name === selected.name)?.usedBy ?? [] : [];

  return (
    <ModalShell
      cardClassName="modal-card manager-card"
      cardStyle={{ width: 'min(1080px, 96vw)' }}
      ariaLabel="参数关联"
    >
        <div className="modal-head">
          <div>
            <strong>参数关联 · 项目参数与公式</strong>
            <span>改一个源参数 → 全局参数（拓扑序）→ 类型 → 实例 → 几何 / 明细表 / IFC 自动刷新 · 快捷键 GP</span>
          </div>
          <button className="modal-close" onClick={onClose} aria-label="关闭">✕</button>
        </div>

        <div className="manager-tabs">
          <button className={tab === 'globals' ? 'active' : ''} onClick={() => setTab('globals')}>全局参数</button>
          <button className={tab === 'types' ? 'active' : ''} onClick={() => setTab('types')}>类型参数关联</button>
          <button className={tab === 'elements' ? 'active' : ''} onClick={() => setTab('elements')}>实例参数关联</button>
          <button className={tab === 'deps' ? 'active' : ''} onClick={() => setTab('deps')}>依赖关系 / 问题</button>
          <span className="manager-tabs-note">
            {parameters.length} 个全局参数 · {doc.types.length} 个类型 · {doc.elements.length} 个构件
            {issues.length ? ` · ${issues.length} 个公式问题` : ' · 公式全部有效'}
          </span>
        </div>

        <div className="modal-body manager-body">
          {tab === 'globals' ? (
            <>
              <div className="manager-toolbar">
                <button className="primary" disabled={readOnly} onClick={() => {
                  const created = createParameter(doc);
                  apply((current) => upsertParameter(current, created), '已新建全局参数');
                  setSelectedId(created.id);
                }}>＋ 新建参数</button>
                <button disabled={readOnly} onClick={recompute}>⟳ 立即重算</button>
                <span className="manager-sep" />
                <span className="manager-inline">公式示例</span>
                <code className="formula-example">标准墙厚 * 2 + 50mm</code>
                <span className="manager-inline">· 支持 + − × ÷ ^ %、比较、if/min/max/round/clamp 等函数</span>
              </div>
              <div className="manager-split">
                <div className="manager-list-pane">
                  <input
                    className="manager-input manager-search"
                    placeholder="搜索参数名"
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                  />
                  <div className="manager-list">
                    {filtered.map((item) => (
                      <button
                        key={item.id}
                        className={`manager-list-item ${selected?.id === item.id ? 'active' : ''}`}
                        onClick={() => setSelectedId(item.id)}
                      >
                        <span className={item.formula ? 'fx-badge linked' : 'fx-badge'}>{item.formula ? 'fx' : '#'}</span>
                        <span className="manager-list-name">{item.name}</span>
                        <small>{formatParameterValue(item.value, item.unit)}</small>
                      </button>
                    ))}
                    {!filtered.length ? <div className="manager-empty">没有匹配的参数</div> : null}
                  </div>
                  <div className="manager-list-foot">
                    带 fx 的参数由公式计算，数值只读；修改驱动参数会级联更新全部下游参数。
                  </div>
                </div>
                <div className="manager-editor">
                  {selected ? (
                    <>
                      <div className="manager-field">
                        <span>参数名</span>
                        <TextCommit value={selected.name} onCommit={rename} ariaLabel="参数名" />
                      </div>
                      <div className="manager-field">
                        <span>数值</span>
                        {selected.formula ? (
                          <strong className="parameter-readonly">{formatParameterValue(selected.value, selected.unit)} <em>由公式计算</em></strong>
                        ) : (
                          <NumberCommit
                            value={selected.value}
                            min={-100000}
                            max={100000}
                            step={0.01}
                            suffix={PARAMETER_UNIT_LABELS[selected.unit]}
                            ariaLabel="参数值"
                            onCommit={(value) => apply(
                              (current) => upsertParameter(current, { ...selected, value }),
                              `已修改全局参数「${selected.name}」`,
                            )}
                          />
                        )}
                      </div>
                      <div className="manager-field">
                        <span>单位</span>
                        <select
                          className="manager-inline"
                          value={selected.unit}
                          onChange={(event) => apply(
                            (current) => upsertParameter(current, { ...selected, unit: event.target.value as ParameterUnit }),
                            '已修改参数单位',
                          )}
                          disabled={readOnly}
                        >
                          {(Object.keys(PARAMETER_UNIT_LABELS) as ParameterUnit[]).map((unit) => (
                            <option key={unit} value={unit}>{PARAMETER_UNIT_LABELS[unit]}</option>
                          ))}
                        </select>
                      </div>
                      <div className="manager-field manager-field-top">
                        <span>公式</span>
                        <FormulaInput
                          project={doc}
                          value={selected.formula ?? ''}
                          disabled={readOnly}
                          onCommit={(formula) => apply(
                            (current) => upsertParameter(current, { ...selected, formula: formula ?? undefined }),
                            formula ? `已为「${selected.name}」设置公式` : `已解除「${selected.name}」的公式`,
                          )}
                        />
                      </div>
                      <div className="manager-field manager-field-top">
                        <span>说明</span>
                        <TextCommit
                          value={selected.description ?? ''}
                          placeholder="用途说明"
                          ariaLabel="参数说明"
                          onCommit={(value) => apply(
                            (current) => upsertParameter(current, { ...selected, description: value }),
                            '已修改参数说明',
                          )}
                        />
                      </div>
                      <div className="manager-assign">
                        <span>被 {usagesOfSelected.length} 处公式引用</span>
                        {usagesOfSelected.length ? (
                          <div className="parameter-usage-list">
                            {usagesOfSelected.map((item, index) => (
                              <code key={`${item.label}-${item.key}-${index}`}>{item.label} · {item.key}：{item.formula}</code>
                            ))}
                          </div>
                        ) : <div className="manager-hint">尚无下游引用。可在「类型参数关联」或「实例参数关联」中引用此参数。</div>}
                      </div>
                      <div className="manager-toolbar">
                        <button
                          className="manager-delete"
                          disabled={readOnly}
                          onClick={() => {
                            apply((current) => removeParameter(current, selected.id), `已删除参数「${selected.name}」`);
                            if (usagesOfSelected.length) onToast?.(`注意：仍有 ${usagesOfSelected.length} 处公式引用该参数，请同步修改`);
                            setSelectedId(parameters.find((item) => item.id !== selected.id)?.id ?? '');
                          }}
                        >删除参数</button>
                      </div>
                    </>
                  ) : <div className="manager-empty">点击「新建参数」开始</div>}
                </div>
              </div>
            </>
          ) : null}

          {tab === 'types' ? (
            <>
              <div className="manager-hint">
                类型参数一经公式关联即为只读计算值。修改驱动参数后，所有引用该类型的构件几何、
                明细表体积与 IFC 导出同步更新（改一处、动全身）。
              </div>
              <div className="admin-table-wrap">
                <table className="admin-table appearance-table">
                  <thead>
                    <tr>
                      <th>族类型</th>
                      <th>参数</th>
                      <th>当前值</th>
                      <th>关联公式</th>
                      <th>引用此类型的构件</th>
                      <th>状态</th>
                    </tr>
                  </thead>
                  <tbody>
                    {doc.types.flatMap((type) => TYPE_PARAMETER_SPECS[type.category].map((spec) => {
                      const formula = type.formulas?.[spec.key] ?? '';
                      const value = readTypeParameter(type, spec.key) ?? 0;
                      const count = doc.elements.filter((item) => item.typeId === type.id).length;
                      return (
                        <tr key={`${type.id}-${spec.key}`}>
                          <td>{type.name}</td>
                          <td>{spec.label}</td>
                          <td>{formatParameterValue(value, spec.unit)}</td>
                          <td>
                            <FormulaInput
                              project={doc}
                              value={formula}
                              disabled={readOnly}
                              onCommit={(next) => apply(
                                (current) => setTypeFormula(current, type.id, spec.key, next),
                                next ? `已关联「${type.name} · ${spec.label}」` : `已解除「${type.name} · ${spec.label}」的关联`,
                              )}
                            />
                          </td>
                          <td>{count}</td>
                          <td>{formula ? <span className="link-state linked">已关联</span> : <span className="link-state">手动</span>}</td>
                        </tr>
                      );
                    }))}
                  </tbody>
                </table>
              </div>
              <div className="manager-hint">
                可用变量：{parameters.map((item) => item.name).join('、')}；项目层高 <code>层高</code>；常量 PI/E；
                单位字面量 <code>200mm</code>、<code>90deg</code>。
              </div>
            </>
          ) : null}

          {tab === 'elements' ? (
            <>
              <div className="manager-toolbar">
                <label className="manager-inline">
                  构件
                  <select value={element?.id ?? ''} onChange={(event) => setElementId(event.target.value)}>
                    {doc.elements.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
                  </select>
                </label>
                {selection.length ? <span className="manager-inline">视口已选 {selection.length} 个构件</span> : null}
                <span className="manager-sep" />
                <button disabled={readOnly} onClick={recompute}>⟳ 重算</button>
              </div>
              {element ? (
                <div className="admin-table-wrap">
                  <table className="admin-table appearance-table">
                    <thead>
                      <tr><th>实例参数</th><th>当前值</th><th>关联公式</th><th>状态</th></tr>
                    </thead>
                    <tbody>
                      {elementParameterSpecs(element).map((spec) => {
                        // 尺寸起过名（约束别名）时公式写在别名上，这里必须用同一个键
                        const formulaKey = formulaKeyFor(element, spec.key);
                        const formula = element.formulas?.[formulaKey] ?? element.formulas?.[spec.key] ?? '';
                        const value = readElementParameter(element, spec.key) ?? 0;
                        const aliased = formulaKey !== spec.key;
                        return (
                          <tr key={spec.key}>
                            <td>{spec.label}</td>
                            <td>{formatParameterValue(value, spec.unit)}</td>
                            <td>
                              <FormulaInput
                                project={doc}
                                elementId={element.id}
                                value={formula}
                                disabled={readOnly || isElementLocked(doc, element)}
                                onCommit={(next) => apply(
                                  (current) => setElementFormula(current, element.id, formulaKey, next),
                                  next ? `已关联「${element.name} · ${spec.label}」` : `已解除「${element.name} · ${spec.label}」的关联`,
                                )}
                              />
                            </td>
                            <td>
                              {formula
                                ? <span className="link-state linked">已关联</span>
                                : aliased
                                  ? <span className="link-state">可驱动</span>
                                  : <span className="link-state">手动</span>}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              ) : <div className="manager-empty">当前项目没有构件</div>}
              {element && element.constraints?.checks?.length ? (
                <div className="constraint-rules">
                  <div className="constraint-rules-title">设计规则（校验式：不成立即违规）</div>
                  <ul>
                    {element.constraints.checks.map((check) => (
                      <li key={check.id}>
                        <code>{check.expr}</code>
                        {check.message ? <span>{check.message}</span> : null}
                        {check.severity === 'warn' ? <span className="link-state">提示</span> : null}
                      </li>
                    ))}
                  </ul>
                  <div className="manager-hint">违规会出现在「依赖关系与问题」页；校验式只检查，不会改动尺寸。</div>
                </div>
              ) : null}
              <div className="manager-hint">
                实例公式除全局参数外还可用上下文变量：
                {CONTEXT_VARIABLES.filter((item) => item.scope === 'element').map((item) => (
                  <code key={item.name} className="variable-chip">{item.name}</code>
                ))}
                。改标高高程、墙长或楼板面积后，引用这些变量的实例参数会在下一次文档变更时自动重算。
              </div>
            </>
          ) : null}

          {tab === 'deps' ? (
            <>
              <div className="manager-toolbar">
                <button disabled={readOnly} onClick={recompute}>⟳ 立即重算全部关联参数</button>
                <span className="manager-inline">当前待更新项：{pending.updates.length} · 受影响构件：{pending.affectedElements}</span>
              </div>
              {issues.length ? (
                <div className="parameter-issues">
                  <strong>⚠ {issues.length} 个公式问题</strong>
                  {issues.map((issue, index) => (
                    <div key={`${issue.id}-${issue.key}-${index}`} className="parameter-issue">
                      <code>{issue.scope === 'parameter' ? '全局参数' : issue.scope === 'type' ? '类型' : '构件'} · {issue.name} · {issue.key}</code>
                      <span>{issue.message}</span>
                    </div>
                  ))}
                </div>
              ) : <div className="parameter-ok">✓ 所有公式均可求值，无循环引用或未知参数</div>}
              <div className="admin-table-wrap">
                <table className="admin-table appearance-table">
                  <thead><tr><th>全局参数</th><th>当前值</th><th>下游引用（类型 / 实例 / 参数）</th></tr></thead>
                  <tbody>
                    {usage.map((item) => {
                      const parameter = parameters.find((entry) => item.name === entry.name);
                      return (
                        <tr key={item.id}>
                          <td>{item.name}{parameter?.formula ? <span className="fx-badge linked">fx</span> : null}</td>
                          <td>{parameter ? formatParameterValue(parameter.value, parameter.unit) : '—'}</td>
                          <td className="parameter-dep-cell">
                            {item.usedBy.length
                              ? item.usedBy.map((ref, index) => (
                                <code key={`${ref.label}-${index}`}>{ref.label} · {ref.key} = {ref.formula}</code>
                              ))
                              : <span className="manager-hint">无下游引用</span>}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <div className="manager-hint">
                求值顺序由依赖图自动拓扑排序；出现循环引用时相关参数保留原值并在上方列出问题。
                公式在每次文档变更后重算一次（不迭代收敛），避免自引用公式震荡。
              </div>
            </>
          ) : null}
        </div>

        <div className="modal-foot manager-foot">
          <span className="parameter-foot-note">
            公式可用变量表：{parameters.length} 个全局参数 · 内置函数 {Object.keys({ abs: 1, min: 1, max: 1, round: 1, if: 1, clamp: 1 }).length}+ ·
            {' '}独立求值器（无 eval）
          </span>
          <div>
            <span className={issues.length ? 'parameter-status error' : 'parameter-status'}>
              {issues.length ? `${issues.length} 个问题` : '关联已同步'}
            </span>
            <button className="primary" onClick={onClose}>关闭</button>
          </div>
        </div>
    </ModalShell>
  );
}
