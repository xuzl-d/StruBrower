/**
 * 任意造型（特征树编辑器）。
 *
 * 对齐 SolidWorks 的基本心智模型：左边特征树，右边参数；每个特征＝形状 + 位置/旋转 + 合并方式 + 可选阵列。
 * 编辑只改特征参数，几何由内核实时求值，因此模型始终保持可编辑。
 */
import { useMemo, useState } from 'react';
import type { ReactElement } from 'react';
import {
  SOLID_SHAPE_LABELS,
  SOLID_LIMITS,
  countSolidFeatures,
  createSolidFeature,
  solidFeatureGroups,
  updateSolidFeatureField,
} from '../bim/solid';
import {
  SOLID_MATERIAL_KEYS,
  SOLID_MATERIAL_PRESETS,
  resolveSolidMaterial,
  solidMaterialPresetOf,
} from '../../shared/materials.js';
import { SOLID_TEMPLATES } from '../bim/solidTemplates';
import { buildParametricFeatures, coerceParams, paramTemplate } from '../bim/parametric';
import type { ParametricModel, SolidFeature, SolidMaterial, SolidShape, Vec2 } from '../bim/types';
import ModalShell from './ModalShell';

interface SolidDialogProps {
  name: string;
  features: SolidFeature[];
  position: Vec2;
  /** 构件整体绕 Z 转角度（度） */
  rotation: number;
  readOnly: boolean;
  /** 参数化模型（模板 + 参数）；存在时对话框顶部出现参数卡，改一个数整组联动 */
  parametric?: ParametricModel | null;
  onApply: (payload: {
    name: string;
    features: SolidFeature[];
    position: Vec2;
    rotation: number;
    /** null = 断开参数化，存静态特征树 */
    parametric: ParametricModel | null;
  }) => void;
  onClose: () => void;
  onToast: (text: string) => void;
}

const MODE_LABELS: Record<'add' | 'cut' | 'intersect', string> = {
  add: '合并',
  cut: '切除',
  intersect: '相交',
};

const NEW_SHAPES: Array<{ shape: SolidShape['shape']; label: string }> = [
  { shape: 'roundedBox', label: '圆角盒' },
  { shape: 'box', label: '长方体' },
  { shape: 'cylinder', label: '圆柱' },
  { shape: 'tube', label: '圆管' },
  { shape: 'capsule', label: '胶囊' },
  { shape: 'sphere', label: '球' },
  { shape: 'ellipsoid', label: '椭球' },
  { shape: 'cone', label: '圆锥 / 圆台' },
  { shape: 'torus', label: '圆环' },
  { shape: 'prism', label: '拉伸轮廓' },
  { shape: 'revolve', label: '旋转体' },
  { shape: 'sweep', label: '扫掠' },
];

function defaultShape(shape: SolidShape['shape']): SolidShape {
  switch (shape) {
    case 'roundedBox': return { shape: 'roundedBox', width: 0.2, depth: 0.16, height: 0.1, radius: 0.016, segments: 32 };
    case 'box': return { shape: 'box', width: 0.2, depth: 0.2, height: 0.1 };
    case 'cylinder': return { shape: 'cylinder', radius: 0.06, height: 0.2, segments: 32 };
    case 'tube': return { shape: 'tube', radius: 0.05, thickness: 0.006, height: 0.2, segments: 32 };
    case 'capsule': return { shape: 'capsule', radius: 0.03, height: 0.14, segments: 32 };
    case 'sphere': return { shape: 'sphere', radius: 0.08, segments: 32 };
    case 'ellipsoid': return { shape: 'ellipsoid', rx: 0.1, ry: 0.07, rz: 0.05, segments: 32 };
    case 'cone': return { shape: 'cone', radius: 0.08, topRadius: 0.02, height: 0.16, segments: 32 };
    case 'torus': return { shape: 'torus', radius: 0.08, tube: 0.02, segments: 48, tubeSegments: 16 };
    case 'prism': return { shape: 'prism', profile: [[-0.08, -0.08], [0.08, -0.08], [0.08, 0.08], [-0.08, 0.08]], height: 0.12 };
    case 'revolve': return { shape: 'revolve', profile: [[0, 0], [0.06, 0], [0.06, 0.05], [0.03, 0.12], [0, 0.12]], segments: 48 };
    case 'sweep': return {
      shape: 'sweep',
      profile: [[-0.02, -0.02], [0.02, -0.02], [0.02, 0.02], [-0.02, 0.02]],
      path: [[0, 0, 0], [0.1, 0.02, 0.06], [0.2, 0.05, 0.14]],
    };
    default: return { shape: 'box', width: 0.2, depth: 0.2, height: 0.1 };
  }
}

function readAtPath(features: SolidFeature[], path: number[]): SolidFeature | null {
  let list = features;
  let found: SolidFeature | null = null;
  for (let depth = 0; depth < path.length; depth += 1) {
    found = list[path[depth]] ?? null;
    if (!found) return null;
    if (depth < path.length - 1) {
      if (found.shape.shape !== 'group') return null;
      list = found.shape.features;
    }
  }
  return found;
}

function writeAtPath(features: SolidFeature[], path: number[], next: SolidFeature): SolidFeature[] {
  const [head, ...rest] = path;
  return features.map((feature, index) => {
    if (index !== head) return feature;
    if (!rest.length) return next;
    if (feature.shape.shape !== 'group') return feature;
    return { ...feature, shape: { ...feature.shape, features: writeAtPath(feature.shape.features, rest, next) } };
  });
}

function removeAtPath(features: SolidFeature[], path: number[]): SolidFeature[] {
  const [head, ...rest] = path;
  return features
    .filter((_, index) => index !== head || rest.length > 0)
    .map((feature, index) => {
      if (index !== head || !rest.length) return feature;
      if (feature.shape.shape !== 'group') return feature;
      return { ...feature, shape: { ...feature.shape, features: removeAtPath(feature.shape.features, rest) } };
    });
}

function moveAtPath(features: SolidFeature[], path: number[], delta: -1 | 1): SolidFeature[] {
  const [head, ...rest] = path;
  if (rest.length) {
    return features.map((feature, index) => {
      if (index !== head || feature.shape.shape !== 'group') return feature;
      return { ...feature, shape: { ...feature.shape, features: moveAtPath(feature.shape.features, rest, delta) } };
    });
  }
  const target = head + delta;
  if (target < 0 || target >= features.length) return features;
  const next = [...features];
  [next[head], next[target]] = [next[target], next[head]];
  return next;
}

function featureTitle(feature: SolidFeature): string {
  return feature.label?.trim() || SOLID_SHAPE_LABELS[feature.shape.shape];
}

/**
 * 特征材质的显示形态：模板里写的是预设名（'carbon'），文档里存的是展开后的对象。
 * 这里统一解析一次，界面既显示色块也显示预设名。
 */
function featureMaterialOf(feature: SolidFeature | null | undefined): SolidMaterial | undefined {
  if (!feature?.material) return undefined;
  return resolveSolidMaterial(feature.material).material ?? undefined;
}

export default function SolidDialog({
  name,
  features,
  position,
  rotation,
  readOnly,
  parametric: parametricProp,
  onApply,
  onClose,
  onToast,
}: SolidDialogProps) {
  const [draftName, setDraftName] = useState(name);
  const [draftFeatures, setDraftFeatures] = useState<SolidFeature[]>(features);
  const [draftPosition, setDraftPosition] = useState<Vec2>(position);
  const [draftRotation, setDraftRotation] = useState(rotation);
  const [selected, setSelected] = useState<number[]>([0]);
  const [confirmTemplate, setConfirmTemplate] = useState('');
  const [parametric, setParametric] = useState<ParametricModel | null>(parametricProp ?? null);
  /** 用户是否手动改过特征树：改过就说明他要的是静态编辑，应用时断开参数化 */
  const [manual, setManual] = useState(false);
  const paramSpec = parametric ? paramTemplate(parametric.template) : null;

  const selectedFeature = useMemo(() => readAtPath(draftFeatures, selected), [draftFeatures, selected]);
  const groups = useMemo(() => (selectedFeature ? solidFeatureGroups(selectedFeature) : []), [selectedFeature]);
  const total = countSolidFeatures(draftFeatures);

  const update = (mutator: (list: SolidFeature[]) => SolidFeature[], label?: string) => {
    if (readOnly) {
      onToast('当前角色为查看者，造型只读');
      return;
    }
    setDraftFeatures((current) => mutator(current));
    // 手动动过特征 = 想脱离模板，参数化在应用时会被断开
    setManual(true);
    if (label) onToast(label);
  };

  /**
   * 改一个参数：模板里的尺寸关系（檐口 = 柱顶、额枋骑柱头、屋面起坡按柱网半径）
   * 全部重算，所以不是「改一根柱子」，而是整座亭子重建。
   */
  const changeParam = (key: string, value: number) => {
    if (!parametric) return;
    const { params } = coerceParams(parametric.template, { ...parametric.params, [key]: value });
    const next: ParametricModel = { ...parametric, params };
    setParametric(next);
    setManual(false);
    setDraftFeatures(buildParametricFeatures(next));
    setSelected([0]);
  };

  const disconnect = () => {
    if (readOnly) {
      onToast('当前角色为查看者，造型只读');
      return;
    }
    setParametric(null);
    setManual(true);
    onToast('已断开参数化：此后特征树就是源数据，改参数不再生效');
  };

  const patchSelected = (next: SolidFeature) => {
    update((list) => writeAtPath(list, selected, next));
  };

  const addShape = (shape: SolidShape['shape']) => {
    if (draftFeatures.length >= SOLID_LIMITS.features) {
      onToast(`特征数量上限 ${SOLID_LIMITS.features}`);
      return;
    }
    const feature = createSolidFeature(defaultShape(shape), {
      label: SOLID_SHAPE_LABELS[shape],
      mode: draftFeatures.length ? 'add' : 'add',
    });
    update((list) => [...list, feature]);
    setSelected([draftFeatures.length]);
  };

  const removeSelected = () => {
    if (draftFeatures.length <= 1) {
      onToast('至少保留一个特征');
      return;
    }
    update((list) => removeAtPath(list, selected));
    setSelected([Math.max(0, selected[0] - 1)]);
  };

  const duplicateSelected = () => {
    if (!selectedFeature) return;
    if (draftFeatures.length >= SOLID_LIMITS.features) return;
    const copy: SolidFeature = {
      ...selectedFeature,
      id: `feature-${Math.random().toString(36).slice(2, 9)}`,
      label: `${featureTitle(selectedFeature)} 副本`,
    };
    const path = [...selected];
    const index = path.pop()!;
    update((list) => {
      const parent = path.length ? readAtPath(list, path) : null;
      if (path.length && parent?.shape.shape === 'group') {
        const children = [...parent.shape.features];
        children.splice(index + 1, 0, copy);
        return writeAtPath(list, path, { ...parent, shape: { ...parent.shape, features: children } });
      }
      const next = [...list];
      next.splice(index + 1, 0, copy);
      return next;
    });
    setSelected([...path, index + 1]);
  };

  const togglePattern = (type: 'circular' | 'linear') => {
    if (!selectedFeature) return;
    if (selectedFeature.pattern) {
      patchSelected({ ...selectedFeature, pattern: undefined });
      return;
    }
    patchSelected({
      ...selectedFeature,
      pattern: type === 'circular'
        ? { type: 'circular', count: 4, axis: 'z', angle: 360 }
        : { type: 'linear', count: 2, step: [0.1, 0, 0] },
    });
  };

  /* 材质：只改外观，不影响几何；空 = 跟随构件材质 */
  const material = featureMaterialOf(selectedFeature);
  const setMaterial = (next: SolidMaterial | undefined) => {
    if (!selectedFeature) return;
    patchSelected({ ...selectedFeature, material: next });
  };
  const patchMaterial = (patch: Partial<SolidMaterial>) => {
    setMaterial({ ...(material ?? {}), ...patch });
  };

  const applyTemplate = (id: string) => {
    if (!id) return;
    const template = SOLID_TEMPLATES.find((item) => item.id === id);
    if (!template) return;
    update(() => template.build(), `已套用模板「${template.name}」`);
    // 参数化模板套用后重新挂上参数（update 里刚把 manual 置真，这里覆盖回去）
    setParametric(template.parametric ? { ...template.parametric, params: { ...template.parametric.params } } : null);
    setManual(false);
    setSelected([0]);
    setConfirmTemplate('');
  };

  const apply = () => {
    if (readOnly) {
      onToast('当前角色为查看者，无法应用造型');
      return;
    }
    if (!Number.isFinite(draftPosition[0]) || !Number.isFinite(draftPosition[1])) {
      onToast('位置必须是数字');
      return;
    }
    onApply({
      name: draftName.trim() || '特征实体',
      features: draftFeatures,
      position: draftPosition,
      rotation: draftRotation,
      parametric: manual ? null : parametric,
    });
  };

  const renderTree = (list: SolidFeature[], path: number[], depth = 0): ReactElement[] => (
    list.flatMap((feature, index) => {
      const current = [...path, index];
      const active = current.join('.') === selected.join('.');
      const swatch = featureMaterialOf(feature);
      const rows: ReactElement[] = [
        <button
          key={`f-${current.join('-')}`}
          className={`solid-tree-row ${active ? 'active' : ''}`}
          style={{ paddingLeft: 10 + depth * 14 }}
          onClick={() => setSelected(current)}
        >
          <span className="solid-tree-index">{index + 1}</span>
          {swatch?.color ? (
            <span
              className="solid-tree-swatch"
              style={{ background: swatch.color, opacity: (swatch.opacity ?? 100) / 100 }}
              title={swatch.name ?? swatch.color}
            />
          ) : null}
          <span className="solid-tree-name">{featureTitle(feature)}</span>
          {feature.mode === 'cut' ? <em className="solid-badge cut">切</em> : null}
          {feature.mode === 'intersect' ? <em className="solid-badge isect">交</em> : null}
          {feature.pattern ? <em className="solid-badge pattern">×{feature.pattern.count}</em> : null}
        </button>,
      ];
      if (feature.shape.shape === 'group') {
        rows.push(...renderTree(feature.shape.features, current, depth + 1));
      }
      return rows;
    })
  );

  return (
    <ModalShell
      cardClassName="modal-card solid-card"
      cardStyle={{ width: 'min(1180px, 96vw)' }}
      ariaLabel="任意造型"
    >
      <div className="modal-head">
        <div>
          <strong>任意造型 · 特征树</strong>
          <span>
            形状 → 变换 → 阵列 → 布尔（合并/切除/相交）；共 {total} 个特征
            {readOnly ? ' · 只读' : ''}
          </span>
        </div>
        <button className="modal-close" onClick={onClose} aria-label="关闭">✕</button>
      </div>

      <div className="solid-top">
        <label className="solid-top-field">
          <span>名称</span>
          <input value={draftName} maxLength={40} onChange={(event) => setDraftName(event.target.value)} />
        </label>
        <label className="solid-top-field">
          <span>定位 X</span>
          <input
            type="number"
            step={0.1}
            value={draftPosition[0]}
            onChange={(event) => setDraftPosition([Number(event.target.value), draftPosition[1]])}
          />
        </label>
        <label className="solid-top-field">
          <span>定位 Y</span>
          <input
            type="number"
            step={0.1}
            value={draftPosition[1]}
            onChange={(event) => setDraftPosition([draftPosition[0], Number(event.target.value)])}
          />
        </label>
        <label className="solid-top-field">
          <span>转角 °</span>
          <input
            type="number"
            step={15}
            value={draftRotation}
            onChange={(event) => setDraftRotation(Number(event.target.value))}
          />
        </label>
        <label className="solid-top-field grow">
          <span>模板</span>
          <select
            value={confirmTemplate}
            onChange={(event) => {
              const value = event.target.value;
              setConfirmTemplate(value);
              if (value) applyTemplate(value);
            }}
          >
            <option value="">选择模板（会替换当前特征树）</option>
            {SOLID_TEMPLATES.map((template) => (
              <option key={template.id} value={template.id}>{template.name}</option>
            ))}
          </select>
        </label>
      </div>

      <div className="solid-body">
        <aside className="solid-tree">
          <div className="solid-tree-head">
            <span>特征树</span>
            <em>{draftFeatures.length} 项</em>
          </div>
          <div className="solid-tree-list">{renderTree(draftFeatures, [])}</div>
          <div className="solid-tree-add">
            <span>添加特征</span>
            <div className="solid-tree-add-row">
              {NEW_SHAPES.map((item) => (
                <button key={item.shape} onClick={() => addShape(item.shape)} disabled={readOnly}>
                  {item.label}
                </button>
              ))}
            </div>
            <div className="solid-tree-add-row">
              <button onClick={() => applyTemplate('quadcopter')} disabled={readOnly}>无人机</button>
              <button onClick={() => applyTemplate('gear')} disabled={readOnly}>齿轮</button>
              <button onClick={() => applyTemplate('vase')} disabled={readOnly}>花瓶</button>
            </div>
            <div className="solid-tree-add-row">
              <button onClick={() => applyTemplate('aircraft')} disabled={readOnly} title="A350 客机（1:10）">飞机</button>
              <button onClick={() => applyTemplate('pavilion')} disabled={readOnly} title="六角攒尖亭">亭子</button>
            </div>
          </div>
        </aside>

        <section className="solid-detail">
          {parametric && paramSpec ? (
            <div className="solid-group solid-param-card">
              <div className="solid-group-title">
                参数（尺寸驱动）· {paramSpec.name}
                <span className="solid-param-tag">{manual ? '应用后断开' : '已启用'}</span>
              </div>
              <p className="solid-param-note">
                {manual
                  ? '特征树已被手动修改，应用后会断开参数化（参数不再覆盖你的编辑）。'
                  : paramSpec.summary}
              </p>
              <div className="solid-fields">
                {paramSpec.params.map((spec) => (
                  <label className="solid-field" key={spec.key}>
                    <span>{spec.label}</span>
                    <input
                      type="number"
                      min={spec.min}
                      max={spec.max}
                      step={spec.step}
                      value={Number((parametric.params[spec.key] ?? spec.default).toFixed(3))}
                      disabled={readOnly}
                      onChange={(event) => {
                        const value = Number(event.target.value);
                        if (Number.isFinite(value)) changeParam(spec.key, value);
                      }}
                    />
                    <em>{spec.unit === 'length' ? 'm' : spec.unit === 'count' ? '边' : ''}</em>
                  </label>
                ))}
              </div>
              <div className="solid-param-actions">
                <button onClick={disconnect} disabled={readOnly || manual}>断开参数化</button>
                <span>
                  {paramSpec.params.length} 个驱动参数 · 可绑定项目参数（如「柱高 = 层高 − 0.3」）
                </span>
              </div>
            </div>
          ) : null}
          {selectedFeature ? (
            <>
              <div className="solid-detail-head">
                <div>
                  <strong>{featureTitle(selectedFeature)}</strong>
                  <span>{SOLID_SHAPE_LABELS[selectedFeature.shape.shape]} · 特征 {selected.map((index) => index + 1).join('.')}</span>
                </div>
                <div className="solid-detail-actions">
                  <div className="solid-modes">
                    {(['add', 'cut', 'intersect'] as const).map((mode) => (
                      <button
                        key={mode}
                        className={selectedFeature.mode === mode || (!selectedFeature.mode && mode === 'add') ? 'active' : ''}
                        onClick={() => patchSelected({ ...selectedFeature, mode })}
                        disabled={readOnly}
                      >{MODE_LABELS[mode]}</button>
                    ))}
                  </div>
                  <button onClick={() => togglePattern('circular')} disabled={readOnly}>
                    {selectedFeature.pattern ? '去掉阵列' : '圆周阵列'}
                  </button>
                  {selectedFeature.pattern ? (
                    <button onClick={() => togglePattern('linear')} disabled={readOnly}>切线性</button>
                  ) : (
                    <button onClick={() => togglePattern('linear')} disabled={readOnly}>线性阵列</button>
                  )}
                  <button onClick={duplicateSelected} disabled={readOnly}>复制</button>
                  <button onClick={() => update((list) => moveAtPath(list, selected, -1))} disabled={readOnly || selected[0] === 0}>↑</button>
                  <button
                    onClick={() => update((list) => moveAtPath(list, selected, 1))}
                    disabled={readOnly || selected[0] === (selected.length === 1 ? draftFeatures.length - 1 : draftFeatures.length - 1)}
                  >↓</button>
                  <button className="danger" onClick={removeSelected} disabled={readOnly}>删除</button>
                </div>
              </div>

              {groups.map((group) => (
                <div className="solid-group" key={group.title}>
                  <div className="solid-group-title">{group.title}</div>
                  <div className="solid-fields">
                    {group.fields.map((field) => (
                      <label className="solid-field" key={field.key}>
                        <span>{field.label}</span>
                        <input
                          type="number"
                          step={field.step}
                          value={Number(field.value.toFixed(4))}
                          disabled={readOnly}
                          onChange={(event) => {
                            const value = Number(event.target.value);
                            if (!Number.isFinite(value)) return;
                            patchSelected(updateSolidFeatureField(selectedFeature, field.key, value));
                          }}
                        />
                        {field.unit ? <em>{field.unit}</em> : null}
                      </label>
                    ))}
                  </div>
                </div>
              ))}

              <div className="solid-group">
                <div className="solid-group-title">材质 / 颜色（只影响外观，不改几何）</div>
                <div className="solid-material-grid">
                  <label className="solid-field">
                    <span>预设</span>
                    <select
                      className="solid-material-preset"
                      value={solidMaterialPresetOf(material)}
                      disabled={readOnly}
                      onChange={(event) => {
                        const key = event.target.value;
                        if (key) setMaterial({ ...SOLID_MATERIAL_PRESETS[key] });
                      }}
                    >
                      <option value="">自定义</option>
                      {SOLID_MATERIAL_KEYS.map((key) => (
                        <option key={key} value={key}>{SOLID_MATERIAL_PRESETS[key].name}</option>
                      ))}
                    </select>
                  </label>
                  <label className="solid-field">
                    <span>颜色</span>
                    <span className="solid-color">
                      <input
                        type="color"
                        aria-label="零件颜色"
                        value={material?.color ?? '#b9c2cb'}
                        disabled={readOnly}
                        onChange={(event) => patchMaterial({ color: event.target.value })}
                      />
                      <code title={material?.name ?? undefined}>{(material?.color ?? '#b9c2cb').toUpperCase()}</code>
                    </span>
                  </label>
                  <label className="solid-field solid-field-range">
                    <span>粗糙度</span>
                    <input
                      type="range"
                      min={0}
                      max={1}
                      step={0.02}
                      value={material?.roughness ?? 0.62}
                      disabled={readOnly}
                      onChange={(event) => patchMaterial({ roughness: Number(event.target.value) })}
                    />
                    <em>{(material?.roughness ?? 0.62).toFixed(2)}</em>
                  </label>
                  <label className="solid-field solid-field-range">
                    <span>金属度</span>
                    <input
                      type="range"
                      min={0}
                      max={1}
                      step={0.02}
                      value={material?.metalness ?? 0.04}
                      disabled={readOnly}
                      onChange={(event) => patchMaterial({ metalness: Number(event.target.value) })}
                    />
                    <em>{(material?.metalness ?? 0.04).toFixed(2)}</em>
                  </label>
                  <label className="solid-field solid-field-range">
                    <span>不透明度</span>
                    <input
                      type="range"
                      min={5}
                      max={100}
                      step={1}
                      value={material?.opacity ?? 100}
                      disabled={readOnly}
                      onChange={(event) => patchMaterial({ opacity: Number(event.target.value) })}
                    />
                    <em>{Math.round(material?.opacity ?? 100)}</em>
                  </label>
                  <div className="solid-field">
                    <span>操作</span>
                    <button
                      className="solid-material-clear"
                      disabled={readOnly || !material}
                      onClick={() => setMaterial(undefined)}
                    >跟随构件材质</button>
                  </div>
                </div>
                <div className="solid-mat-chips">
                  {SOLID_MATERIAL_KEYS.map((key) => (
                    <button
                      key={key}
                      className={`solid-mat-chip ${solidMaterialPresetOf(material) === key ? 'active' : ''}`}
                      title={`${SOLID_MATERIAL_PRESETS[key].name} · ${SOLID_MATERIAL_PRESETS[key].color}`}
                      style={{ background: SOLID_MATERIAL_PRESETS[key].color }}
                      disabled={readOnly}
                      onClick={() => setMaterial({ ...SOLID_MATERIAL_PRESETS[key] })}
                    />
                  ))}
                </div>
                <div className="solid-material-hint">
                  金属件金属度 ≥ 0.85、粗糙度 0.15–0.4；塑料金属度 ≤ 0.1；玻璃把不透明度调到 25–45。
                  不填材质时跟随「材质浏览器」里指派的构件材质。
                </div>
              </div>

              {selectedFeature.shape.shape === 'group' ? (
                <div className="solid-note">
                  子装配包含 {selectedFeature.shape.features.length} 个子特征：在左侧树里点开可单独编辑；
                  整体可再做圆周阵列（例如 4 组旋翼）。
                </div>
              ) : null}
              <div className="solid-note">
                坐标是特征局部坐标（米）：XY 以原点为中心，Z 轴向上；阵列在变换之后叠加，圆周阵列默认 360° 均分。
              </div>
            </>
          ) : (
            <div className="solid-note">先在左侧选择一个特征</div>
          )}
        </section>
      </div>

      <div className="modal-foot solid-foot">
        <span>特征 {total} 个 · 修改在点「应用」后写入模型（可 Ctrl/Cmd+Z 撤销）</span>
        <div className="solid-foot-actions">
          <button onClick={onClose}>取消</button>
          <button
            className="primary"
            onClick={apply}
            disabled={readOnly || !draftFeatures.length}
          >应用</button>
        </div>
      </div>
    </ModalShell>
  );
}
