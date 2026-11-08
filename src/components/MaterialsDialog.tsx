/**
 * 材质浏览器（对应 Revit「管理 → 材质」）。
 * 左侧项目材质列表 + 搜索，右侧编辑颜色 / 不透明度 / 粗糙度 / 金属度 / 说明，
 * 支持新建、复制、删除、指派到选中图元或族类型、清除图元覆盖。
 * 所有修改通过 onUpdate 走 App.commit，因此可撤销、可协作同步。
 */
import { useMemo, useState } from 'react';
import {
  addMaterial, assignMaterial, assignMaterialToType, clearMaterialOverride, deleteMaterial,
  duplicateMaterial, materialUsage, normalizeMaterial, updateMaterial,
} from '../bim/layers';
import type { ProjectDocument } from '../bim/types';
import { RangeField, TextCommit } from './ManagerFields';
import ModalShell from './ModalShell';

export interface MaterialsDialogProps {
  project: ProjectDocument;
  selection: string[];
  readOnly: boolean;
  onUpdate: (mutator: (project: ProjectDocument) => ProjectDocument, label: string) => void;
  onClose: () => void;
  onToast?: (text: string) => void;
}

export default function MaterialsDialog({
  project, selection, readOnly, onUpdate, onClose, onToast,
}: MaterialsDialogProps) {
  const [selectedId, setSelectedId] = useState(project.materials[0]?.id ?? '');
  const [query, setQuery] = useState('');
  const [typeId, setTypeId] = useState(project.types[0]?.id ?? '');
  /** null = 未在编辑，显示材质当前值；字符串 = 正在编辑的草稿 */
  const [descriptionDraft, setDescriptionDraft] = useState<string | null>(null);

  const usage = useMemo(() => materialUsage(project), [project]);
  const filtered = project.materials.filter((material) => (
    material.name.toLowerCase().includes(query.trim().toLowerCase())
    || (material.description ?? '').toLowerCase().includes(query.trim().toLowerCase())
  ));
  const material = project.materials.find((item) => item.id === selectedId) ?? project.materials[0] ?? null;
  const surface = material ? normalizeMaterial(material) : null;
  // 说明用「失焦提交」，避免受控 textarea 的每次输入都写文档
  const currentDescription = material?.description ?? '';

  const apply = (mutator: (project: ProjectDocument) => ProjectDocument, label: string) => {
    if (readOnly) {
      onToast?.('当前角色为查看者，材质只读');
      return;
    }
    onUpdate(mutator, label);
  };

  const create = () => {
    apply((current) => addMaterial(current), '已新建材质');
    onToast?.('已新建材质，可在右侧编辑属性');
  };

  const remove = () => {
    if (!material) return;
    const count = usage[material.id] ?? 0;
    apply((current) => deleteMaterial(current, material.id), `已删除材质「${material.name}」${count ? `（${count} 处引用已改指默认材质）` : ''}`);
    setSelectedId('');
  };

  const assignToSelection = () => {
    if (!material) return;
    if (!selection.length) {
      onToast?.('请先在视口中选择构件，或使用「应用到类型」批量修改');
      return;
    }
    apply((current) => assignMaterial(current, selection, material.id),
      `已将材质「${material.name}」应用到 ${selection.length} 个构件`);
  };

  return (
    <ModalShell
      cardClassName="modal-card manager-card"
      cardStyle={{ width: 'min(940px, 95vw)' }}
      ariaLabel="材质浏览器"
    >
        <div className="modal-head">
          <div>
            <strong>材质浏览器</strong>
            <span>类型材质为默认，图元材质可单独覆盖 · 颜色 / 透明度实时作用于视口 · 快捷键 MA</span>
          </div>
          <button className="modal-close" onClick={onClose} aria-label="关闭">✕</button>
        </div>

        <div className="manager-toolbar material-toolbar">
          <button className="primary" disabled={readOnly} onClick={create}>＋ 新建材质</button>
          <button disabled={readOnly || !material} onClick={() => apply((current) => duplicateMaterial(current, material!.id), '已复制材质')}>复制</button>
          <button className="manager-delete" disabled={readOnly || !material || project.materials.length <= 1} onClick={remove}>删除</button>
          <span className="manager-sep" />
          <button disabled={readOnly || !material} onClick={assignToSelection}>应用到选中构件（{selection.length}）</button>
          <button
            disabled={readOnly || !selection.length}
            onClick={() => apply((current) => clearMaterialOverride(current, selection), `已清除 ${selection.length} 个构件的材质覆盖`)}
          >清除图元覆盖</button>
        </div>

        <div className="manager-split">
          <aside className="manager-list-pane">
            <input
              className="manager-input manager-search"
              aria-label="搜索材质"
              placeholder="搜索材质名称 / 说明…"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
            <div className="manager-list">
              {filtered.map((item) => (
                <button
                  key={item.id}
                  className={`manager-list-item ${item.id === material?.id ? 'active' : ''}`}
                  onClick={() => {
                    setSelectedId(item.id);
                    setDescriptionDraft(null);
                  }}
                >
                  <span className="manager-swatch" style={{ background: item.color, opacity: (item.opacity ?? 100) / 100 }} />
                  <span className="manager-list-name">{item.name}</span>
                  <small>{usage[item.id] ?? 0}</small>
                </button>
              ))}
              {!filtered.length ? <div className="manager-empty">没有匹配的材质</div> : null}
            </div>
            <div className="manager-list-foot">项目材质 {project.materials.length} 个</div>
          </aside>

          <section className="manager-editor">
            {material && surface ? (
              <>
                <div className="material-preview-row">
                  <div
                    className="material-preview"
                    style={{
                      background: `radial-gradient(circle at 32% 26%, #ffffffcc 0%, ${material.color} 42%, #0b1420 100%)`,
                      opacity: Math.max(0.25, surface.opacity / 100),
                    }}
                  />
                  <div className="material-preview-meta">
                    <strong>{material.name}</strong>
                    <span>被 {usage[material.id] ?? 0} 处引用（类型 + 图元覆盖）</span>
                    <code>{material.color.toUpperCase()} · 不透明度 {surface.opacity}</code>
                  </div>
                </div>

                <label className="manager-field">
                  <span>名称</span>
                  <TextCommit
                    ariaLabel="材质名称"
                    value={material.name}
                    onCommit={(name) => apply((current) => updateMaterial(current, material.id, { name }), '已重命名材质')}
                  />
                </label>
                <label className="manager-field">
                  <span>颜色</span>
                  <span className="manager-color">
                    <input
                      type="color"
                      aria-label="材质颜色"
                      value={material.color}
                      disabled={readOnly}
                      onChange={(event) => apply((current) => updateMaterial(current, material.id, { color: event.target.value }), '已修改材质颜色')}
                    />
                    <code>{material.color.toUpperCase()}</code>
                  </span>
                </label>

                <RangeField
                  label="不透明度"
                  value={surface.opacity}
                  onCommit={(value) => apply((current) => updateMaterial(current, material.id, { opacity: value }), '已修改材质不透明度')}
                  hint="100 = 完全不透明；玻璃类材质建议 30–45"
                />
                <RangeField
                  label="粗糙度"
                  value={Math.round(surface.roughness * 100)}
                  onCommit={(value) => apply((current) => updateMaterial(current, material.id, { roughness: value / 100 }), '已修改材质粗糙度')}
                  hint="0 = 镜面，100 = 完全漫反射"
                />
                <RangeField
                  label="金属度"
                  value={Math.round(surface.metalness * 100)}
                  onCommit={(value) => apply((current) => updateMaterial(current, material.id, { metalness: value / 100 }), '已修改材质金属度')}
                  hint="钢材建议 70–90，混凝土 / 木材建议 0–5"
                />

                <label className="manager-field manager-field-top">
                  <span>说明 / 牌号</span>
                  <textarea
                    className="manager-input"
                    aria-label="材质说明"
                    rows={2}
                    value={descriptionDraft ?? currentDescription}
                    onFocus={() => setDescriptionDraft(currentDescription)}
                    onChange={(event) => setDescriptionDraft(event.target.value)}
                    onBlur={() => {
                      const next = (descriptionDraft ?? currentDescription).trim();
                      if (next !== currentDescription) {
                        apply((current) => updateMaterial(current, material.id, { description: next }), '已修改材质说明');
                      }
                      setDescriptionDraft(null);
                    }}
                  />
                </label>

                <div className="manager-assign">
                  <span>应用到族类型（全部实例联动）</span>
                  <div>
                    <select value={typeId} onChange={(event) => setTypeId(event.target.value)}>
                      {project.types.map((type) => <option key={type.id} value={type.id}>{type.name}</option>)}
                    </select>
                    <button
                      disabled={readOnly || !typeId}
                      onClick={() => apply((current) => assignMaterialToType(current, typeId, material.id), `已将材质「${material.name}」应用到类型`)}
                    >应用</button>
                  </div>
                </div>
              </>
            ) : (
              <div className="manager-empty">项目还没有材质，点击「＋ 新建材质」创建。</div>
            )}
          </section>
        </div>

        <div className="modal-foot manager-foot">
          <span>提示：图元材质覆盖优先于类型材质；图层/类别的颜色替换优先于材质颜色。</span>
          <button className="primary" onClick={onClose}>完成</button>
        </div>
    </ModalShell>
  );
}
