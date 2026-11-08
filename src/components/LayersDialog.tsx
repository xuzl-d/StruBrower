/**
 * 图层管理器（对应 Revit「可见性/图形 VV」+ CAD 图层特性）。
 * 两个页签：图层表（显示 / 锁定 / 颜色替换 / 透明度 / 当前图层 / 指派选中）与类别可见性替换。
 * 所有修改通过 onUpdate 走 App.commit，因此可撤销、可协作同步。
 */
import { useMemo, useState } from 'react';
import {
  addLayer, assignLayer, categoryOverrideOf, defaultCategoryOverrides, DEFAULT_LAYER_ID,
  deleteLayer, ensureDocumentLayers, layerUsage, setAllLayersVisible, setCategoryOverride,
  updateLayer,
} from '../bim/layers';
import { categoryLabels } from '../bim/types';
import type { ElementCategory, ProjectDocument } from '../bim/types';
import { NumberCommit, TextCommit } from './ManagerFields';
import ModalShell from './ModalShell';

export interface LayersDialogProps {
  project: ProjectDocument;
  /** 当前视口选中的构件 id，用于「指派到图层」 */
  selection: string[];
  currentLayerId: string;
  readOnly: boolean;
  onUpdate: (mutator: (project: ProjectDocument) => ProjectDocument, label: string) => void;
  onCurrentLayer: (id: string) => void;
  onClose: () => void;
  onToast?: (text: string) => void;
}

const CATEGORIES: ElementCategory[] = ['wall', 'column', 'slab', 'mesh'];

export default function LayersDialog({
  project, selection, currentLayerId, readOnly, onUpdate, onCurrentLayer, onClose, onToast,
}: LayersDialogProps) {
  const [tab, setTab] = useState<'layers' | 'categories'>('layers');
  const [targetLayerId, setTargetLayerId] = useState(currentLayerId);
  const doc = useMemo(() => ensureDocumentLayers(project), [project]);
  const layers = doc.layers ?? [];
  const usage = useMemo(() => layerUsage(doc), [doc]);
  const categoryCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const element of doc.elements) counts[element.category] = (counts[element.category] ?? 0) + 1;
    return counts;
  }, [doc]);

  const apply = (mutator: (project: ProjectDocument) => ProjectDocument, label: string) => {
    if (readOnly) {
      onToast?.('当前角色为查看者，图层设置只读');
      return;
    }
    onUpdate(mutator, label);
  };

  const assign = () => {
    if (!selection.length) {
      onToast?.('请先在视口中选择要指派的构件');
      return;
    }
    if (!layers.some((layer) => layer.id === targetLayerId)) return;
    apply((current) => assignLayer(current, selection, targetLayerId),
      `已将 ${selection.length} 个构件指派到图层「${layers.find((layer) => layer.id === targetLayerId)?.name}」`);
  };

  return (
    <ModalShell
      cardClassName="modal-card manager-card"
      cardStyle={{ width: 'min(1000px, 95vw)' }}
      ariaLabel="图层管理"
    >
        <div className="modal-head">
          <div>
            <strong>图层管理 · 可见性/图形</strong>
            <span>显示优先级：构件自身可见 → 图层 → 类别 · 锁定图层中的构件不可编辑 · 快捷键 VV</span>
          </div>
          <button className="modal-close" onClick={onClose} aria-label="关闭">✕</button>
        </div>

        <div className="manager-tabs">
          <button className={tab === 'layers' ? 'active' : ''} onClick={() => setTab('layers')}>图层</button>
          <button className={tab === 'categories' ? 'active' : ''} onClick={() => setTab('categories')}>模型类别</button>
          <span className="manager-tabs-note">
            {layers.length} 个图层 · {doc.elements.length} 个构件
            {layers.some((layer) => !layer.visible) ? ' · 存在隐藏图层' : ''}
          </span>
        </div>

        <div className="modal-body manager-body">
          {tab === 'layers' ? (
            <>
              <div className="manager-toolbar">
                <button className="primary" disabled={readOnly} onClick={() => apply((current) => addLayer(current), '已新建图层')}>＋ 新建图层</button>
                <button disabled={readOnly} onClick={() => apply((current) => setAllLayersVisible(current, true), '已显示所有图层')}>全部显示</button>
                <button disabled={readOnly} onClick={() => apply((current) => setAllLayersVisible(current, false), '已隐藏所有图层')}>全部隐藏</button>
                <span className="manager-sep" />
                <label className="manager-inline">
                  指派选中构件到
                  <select value={targetLayerId} onChange={(event) => setTargetLayerId(event.target.value)}>
                    {layers.map((layer) => <option key={layer.id} value={layer.id}>{layer.name}</option>)}
                  </select>
                </label>
                <button disabled={readOnly || !selection.length} onClick={assign}>
                  指派（已选 {selection.length}）
                </button>
              </div>

              <div className="admin-table-wrap">
                <table className="admin-table appearance-table">
                  <thead>
                    <tr>
                      <th>显示</th>
                      <th>锁定</th>
                      <th>当前</th>
                      <th>图层名称</th>
                      <th>颜色 / 替换</th>
                      <th>透明度</th>
                      <th>构件</th>
                      <th>操作</th>
                    </tr>
                  </thead>
                  <tbody>
                    {layers.map((layer) => (
                      <tr key={layer.id} className={layer.visible ? '' : 'row-hidden'}>
                        <td>
                          <input
                            type="checkbox"
                            aria-label={`显示 ${layer.name}`}
                            checked={layer.visible}
                            disabled={readOnly}
                            onChange={(event) => apply(
                              (current) => updateLayer(current, layer.id, { visible: event.target.checked }),
                              `图层「${layer.name}」已${event.target.checked ? '显示' : '隐藏'}`,
                            )}
                          />
                        </td>
                        <td>
                          <input
                            type="checkbox"
                            aria-label={`锁定 ${layer.name}`}
                            checked={layer.locked}
                            disabled={readOnly}
                            onChange={(event) => apply(
                              (current) => updateLayer(current, layer.id, { locked: event.target.checked }),
                              `图层「${layer.name}」已${event.target.checked ? '锁定' : '解锁'}`,
                            )}
                          />
                        </td>
                        <td>
                          <input
                            type="radio"
                            name="current-layer"
                            aria-label={`设为当前图层 ${layer.name}`}
                            checked={currentLayerId === layer.id}
                            onChange={() => {
                              onCurrentLayer(layer.id);
                              setTargetLayerId(layer.id);
                              onToast?.(`当前图层：${layer.name}（新绘制构件将放在此层）`);
                            }}
                          />
                        </td>
                        <td>
                          <TextCommit
                            className="manager-input manager-name"
                            ariaLabel={`图层名称 ${layer.name}`}
                            value={layer.name}
                            onCommit={(name) => apply((current) => updateLayer(current, layer.id, { name }), '已重命名图层')}
                          />
                        </td>
                        <td>
                          <span className="manager-color">
                            <input
                              type="color"
                              aria-label={`图层颜色 ${layer.name}`}
                              value={layer.color}
                              disabled={readOnly}
                              onChange={(event) => apply(
                                (current) => updateLayer(current, layer.id, { color: event.target.value }),
                                '已修改图层颜色',
                              )}
                            />
                            <label>
                              <input
                                type="checkbox"
                                checked={Boolean(layer.colorOverride)}
                                disabled={readOnly}
                                onChange={(event) => apply(
                                  (current) => updateLayer(current, layer.id, { colorOverride: event.target.checked }),
                                  event.target.checked ? '已按图层颜色替换显示' : '已恢复材质颜色',
                                )}
                              />
                              替换
                            </label>
                          </span>
                        </td>
                        <td>
                          <NumberCommit
                            ariaLabel={`图层透明度 ${layer.name}`}
                            value={layer.transparency ?? 0}
                            min={0}
                            max={100}
                            step={5}
                            suffix="%"
                            onCommit={(value) => apply(
                              (current) => updateLayer(current, layer.id, { transparency: value }),
                              '已修改图层透明度',
                            )}
                          />
                        </td>
                        <td>{usage[layer.id] ?? 0}</td>
                        <td>
                          <button
                            className="manager-delete"
                            disabled={readOnly || layer.id === DEFAULT_LAYER_ID || (usage[layer.id] ?? 0) > 0}
                            title={layer.id === DEFAULT_LAYER_ID ? '0 号默认图层不可删除' : (usage[layer.id] ?? 0) > 0 ? '请先转移该图层上的构件' : '删除图层'}
                            onClick={() => {
                              apply((current) => deleteLayer(current, layer.id), `已删除图层「${layer.name}」`);
                              if (currentLayerId === layer.id) onCurrentLayer(DEFAULT_LAYER_ID);
                            }}
                          >删除</button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="manager-hint">
                0 号默认图层不可删除；含构件的图层需先指派到其它图层再删除。删除图层时，其构件会自动归到 0 号图层。
              </div>
            </>
          ) : (
            <>
              <div className="manager-toolbar">
                <button
                  disabled={readOnly}
                  onClick={() => apply((current) => {
                    let next = current;
                    for (const category of CATEGORIES) next = setCategoryOverride(next, category, { visible: true });
                    return next;
                  }, '已显示全部模型类别')}
                >全部显示</button>
                <button
                  disabled={readOnly}
                  onClick={() => apply((current) => {
                    let next = current;
                    for (const category of CATEGORIES) next = setCategoryOverride(next, category, { visible: false });
                    return next;
                  }, '已隐藏全部模型类别')}
                >全部隐藏</button>
                <button
                  disabled={readOnly}
                  onClick={() => apply((current) => ({ ...current, categoryOverrides: defaultCategoryOverrides() }), '已恢复默认类别可见性')}
                >恢复默认</button>
              </div>
              <div className="admin-table-wrap">
                <table className="admin-table appearance-table">
                  <thead>
                    <tr><th>可见</th><th>模型类别</th><th>投影颜色替换</th><th>透明度</th><th>构件数</th></tr>
                  </thead>
                  <tbody>
                    {CATEGORIES.map((category) => {
                      const override = categoryOverrideOf(doc, category);
                      return (
                        <tr key={category} className={override.visible === false ? 'row-hidden' : ''}>
                          <td>
                            <input
                              type="checkbox"
                              aria-label={`显示 ${categoryLabels[category]}`}
                              checked={override.visible !== false}
                              disabled={readOnly}
                              onChange={(event) => apply(
                                (current) => setCategoryOverride(current, category, { visible: event.target.checked }),
                                `类别「${categoryLabels[category]}」已${event.target.checked ? '显示' : '隐藏'}`,
                              )}
                            />
                          </td>
                          <td>{categoryLabels[category]}<small className="manager-code">{category}</small></td>
                          <td>
                            <span className="manager-color">
                              <input
                                type="color"
                                aria-label={`类别颜色 ${categoryLabels[category]}`}
                                value={override.color ?? '#a3adb8'}
                                disabled={readOnly}
                                onChange={(event) => apply(
                                  (current) => setCategoryOverride(current, category, { color: event.target.value }),
                                  `已设置「${categoryLabels[category]}」类别颜色`,
                                )}
                              />
                              <button
                                className="manager-delete"
                                disabled={readOnly || !override.color}
                                onClick={() => apply(
                                  (current) => setCategoryOverride(current, category, { color: undefined }),
                                  '已清除类别颜色替换',
                                )}
                              >清除</button>
                            </span>
                          </td>
                          <td>
                            <NumberCommit
                              ariaLabel={`类别透明度 ${categoryLabels[category]}`}
                              value={override.transparency ?? 0}
                              min={0}
                              max={100}
                              step={5}
                              suffix="%"
                              onCommit={(value) => apply(
                                (current) => setCategoryOverride(current, category, { transparency: value }),
                                '已修改类别透明度',
                              )}
                            />
                          </td>
                          <td>{categoryCounts[category] ?? 0}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <div className="manager-hint">
                类别替换作用于该类别全部构件；图层颜色替换优先级更高。这里的设置随项目保存并参与协作同步，快捷键 VV 可快速打开本对话框。
              </div>
            </>
          )}
        </div>

        <div className="modal-foot manager-foot">
          <span>当前图层：{layers.find((layer) => layer.id === currentLayerId)?.name ?? '0 · 默认'} · 新绘制构件自动归入该层</span>
          <button className="primary" onClick={onClose}>完成</button>
        </div>
    </ModalShell>
  );
}
