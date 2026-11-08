import { categoryLabels } from '../bim/types';
import type {
  BimElement,
  ColumnInstance,
  FamilyType,
  Level,
  ProjectDocument,
  SlabInstance,
  WallInstance,
} from '../bim/types';
import { elementMaterial, elementMeasures, wallLength } from '../bim/document';
import { isElementLocked, isElementVisible, layerOfElement } from '../bim/layers';
import { primitiveFields, PRIMITIVE_LABELS, updatePrimitiveField } from '../bim/primitives';
import { PARAMETER_UNIT_LABELS, TYPE_PARAMETER_SPECS, readTypeParameter } from '../bim/parameters';
import { NumberField, ReadonlyRow, SelectField, TextField } from './Fields';
import ParameterBinding from './ParameterBinding';
import { solidMaterialKey, solidMaterialLabel } from '../../shared/materials.js';
import type { SolidFeature } from '../bim/types';

interface PropertiesPanelProps {
  onCollapse?: () => void;
  width?: number;
  project: ProjectDocument;
  selection: BimElement[];
  selectedLevel: Level | null;
  onElementPatch: (id: string, patch: Record<string, unknown>) => void;
  onTypePatch: (typeId: string, patch: Record<string, unknown>) => void;
  onTypeFormula: (typeId: string, key: string, formula: string | null) => void;
  onElementFormula: (elementId: string, key: string, formula: string | null) => void;
  onLevelPatch: (levelId: string, patch: { name?: string; elevation?: number }) => void;
  onDeleteSelection: () => void;
  onBoolean: (operation: 'union' | 'subtract' | 'intersect') => void;
  /** 打开特征树编辑器（仅造型实体） */
  onEditSolid?: (element: BimElement) => void;
  readOnly?: boolean;
}

export default function PropertiesPanel({
  onCollapse,
  width,
  project,
  selection,
  selectedLevel,
  onElementPatch,
  onTypePatch,
  onTypeFormula,
  onElementFormula,
  onLevelPatch,
  onDeleteSelection,
  onBoolean,
  onEditSolid,
  readOnly = false,
}: PropertiesPanelProps) {
  const element = selection.length === 1 ? selection[0]! : null;
  const type = element ? project.types.find((item) => item.id === element.typeId) ?? null : null;
  const typeUsage = type ? project.elements.filter((item) => item.typeId === type.id).length : 0;

  return (
    <aside
      className="panel right-panel"
      style={width ? { width, flexBasis: width } : undefined}
    >
      <div className="panel-heading">
        <span>属性</span>
        <div className="panel-heading-actions">
          <button aria-label="属性面板选项" title="属性">···</button>
          <button className="panel-collapse" onClick={onCollapse} title="收起面板" aria-label="收起属性面板">»</button>
        </div>
      </div>

      {element ? (
        <div className="property-content">
          {readOnly ? <div className="readonly-note">当前角色为查看者：属性只读，可查看与缩放。</div> : null}
          <fieldset className="property-fieldset" disabled={readOnly}>
          <div className="property-object">
            <div className="property-object-icon">
              {element.category === 'wall' ? '▤' : element.category === 'column' ? '▮' : element.category === 'slab' ? '▬' : '◇'}
            </div>
            <div>
              <strong>{element.name}</strong>
              <span>
                {categoryLabels[element.category]} · {type?.name ?? (element.category === 'mesh' ? element.source : '未指定类型')}
              </span>
            </div>
          </div>

          <div className="property-group-heading"><span>标识</span><span>⌃</span></div>
          <TextField label="名称" value={element.name} onCommit={(value) => onElementPatch(element.id, { name: value })} />
          <label className="property-check">
            <input type="checkbox" checked={Boolean(element.pinned)} onChange={(event) => onElementPatch(element.id, { pinned: event.target.checked })} />
            锁定构件（Pin：不可移动 / 复制 / 删除）
          </label>
          <ReadonlyRow label="当前材质" value={elementMaterial(project, element)} />
          <SelectField
            label="图层"
            value={element.layerId ?? layerOfElement(project, element)?.id ?? ''}
            options={project.layers?.length
              ? project.layers.map((layer) => ({ value: layer.id, label: layer.name }))
              : [{ value: '', label: '(默认图层)' }]}
            onChange={(value) => onElementPatch(element.id, { layerId: value })}
          />
          <SelectField
            label="图元材质"
            value={element.materialId ?? ''}
            options={[
              { value: '', label: type ? '(跟随类型材质)' : '(使用自身颜色)' },
              ...project.materials.map((material) => ({ value: material.id, label: material.name })),
            ]}
            onChange={(value) => {
              const material = project.materials.find((item) => item.id === value);
              onElementPatch(element.id, {
                materialId: value || undefined,
                ...(element.category === 'mesh' && material ? { color: material.color } : {}),
              });
            }}
          />
          {!isElementVisible(project, element) ? (
            <div className="property-note">该构件当前被图层或类别可见性隐藏，可在「视图 → 图层管理 (VV)」中开启。</div>
          ) : null}
          {isElementLocked(project, element) ? (
            <div className="property-note">该构件或其所在图层已锁定，需在图层管理器中解锁后才能编辑。</div>
          ) : null}
          {type ? (
            <SelectField
              label="类型"
              value={type.id}
              options={project.types
                .filter((item) => item.category === type.category)
                .map((item) => ({ value: item.id, label: item.name }))}
              onChange={(value) => onElementPatch(element.id, { typeId: value })}
            />
          ) : null}

          <div className="property-group-heading"><span>约束</span><span>⌃</span></div>
          <SelectField
            label={element.category === 'slab' ? '标高' : '底部标高'}
            value={element.levelId}
            options={project.levels.map((level) => ({ value: level.id, label: level.name }))}
            onChange={(value) => onElementPatch(element.id, { levelId: value })}
          />
          {element.category !== 'mesh' ? (
            <ParameterBinding
              label={element.category === 'slab' ? '偏移' : '底部偏移'}
              value={'baseOffset' in element ? element.baseOffset : 0}
              step={0.05}
              unit="m"
              formula={element.formulas?.baseOffset}
              project={project}
              elementId={element.id}
              onValue={(value) => onElementPatch(element.id, { baseOffset: value })}
              onFormula={(formula) => onElementFormula(element.id, 'baseOffset', formula)}
            />
          ) : null}
          {element.category === 'wall' || element.category === 'column' ? (
            <>
              <SelectField
                label="顶部标高"
                value={element.topLevelId}
                options={project.levels.map((level) => ({ value: level.id, label: level.name }))}
                onChange={(value) => onElementPatch(element.id, { topLevelId: value })}
              />
              <ParameterBinding
                label="顶部偏移"
                value={element.topOffset}
                step={0.05}
                unit="m"
                formula={element.formulas?.topOffset}
                project={project}
                elementId={element.id}
                onValue={(value) => onElementPatch(element.id, { topOffset: value })}
                onFormula={(formula) => onElementFormula(element.id, 'topOffset', formula)}
              />
            </>
          ) : null}

          <div className="property-group-heading"><span>尺寸（派生）</span><span>⌃</span></div>
          {elementMeasures(project, element).map((row) => (
            <ReadonlyRow key={row.label} label={row.label} value={row.value} />
          ))}
          <GeometryFields
            element={element}
            project={project}
            onElementPatch={onElementPatch}
            onElementFormula={onElementFormula}
            onEditSolid={onEditSolid}
            readOnly={readOnly}
          />

          {type ? (
            <>
              <div className="property-group-heading geometry-heading">
                <span>类型参数</span>
                <span className="heading-note">{typeUsage} 个实例共享</span>
              </div>
              <TextField label="类型名" value={type.name} onCommit={(value) => onTypePatch(type.id, { name: value })} />
              <TypeParameters
                type={type}
                project={project}
                onTypePatch={onTypePatch}
                onTypeFormula={onTypeFormula}
              />
              <SelectField
                label="材质"
                value={'materialId' in type ? type.materialId : ''}
                options={project.materials.map((material) => ({ value: material.id, label: material.name }))}
                onChange={(value) => onTypePatch(type.id, { materialId: value })}
              />
              <div className="property-note">修改类型参数会同时更新全部 {typeUsage} 个实例；带 fx 的参数由公式计算，改驱动参数即联动几何、明细表与 IFC。</div>
            </>
          ) : null}

          <div className="property-actions">
            <button onClick={() => onElementPatch(element.id, { visible: !element.visible })}>
              {element.visible ? '隐藏构件' : '显示构件'}
            </button>
            <button className="danger" onClick={onDeleteSelection}>删除构件</button>
          </div>
          <div className="element-id"><span>元素 ID</span><code>{element.id.slice(0, 14)}…</code></div>
          </fieldset>
        </div>
      ) : selection.length > 1 ? (
        <div className="properties-empty multi-selection">
          <div className="property-glyph">◇</div>
          <strong>已选择 {selection.length} 个构件</strong>
          <span>可执行布尔运算或删除。</span>
          <div className="property-actions inline">
            <button onClick={() => onBoolean('union')}>并集</button>
            <button onClick={() => onBoolean('subtract')}>差集</button>
            <button className="danger" onClick={onDeleteSelection}>删除</button>
          </div>
        </div>
      ) : selectedLevel ? (
        <div className="property-content">
          {readOnly ? <div className="readonly-note">当前角色为查看者：属性只读。</div> : null}
          <fieldset className="property-fieldset" disabled={readOnly}>
          <div className="property-object">
            <div className="property-object-icon">▭</div>
            <div>
              <strong>{selectedLevel.name}</strong>
              <span>标高 · {project.elements.filter((item) => item.levelId === selectedLevel.id).length} 个构件以此为基准</span>
            </div>
          </div>
          <div className="property-group-heading"><span>标高</span><span>⌃</span></div>
          <TextField label="名称" value={selectedLevel.name} onCommit={(value) => onLevelPatch(selectedLevel.id, { name: value })} />
          <NumberField
            label="高程"
            value={selectedLevel.elevation}
            step={0.1}
            unit="m"
            onCommit={(value) => onLevelPatch(selectedLevel.id, { elevation: value })}
          />
          <div className="property-note">修改标高会联动所有以它为基准/顶部的构件，这是 BIM 与纯网格建模的核心差别。</div>
          </fieldset>
        </div>
      ) : (
        <div className="properties-empty">
          <div className="property-glyph">◇</div>
          <strong>未选择构件</strong>
          <span>在视口或项目浏览器中选择构件、标高查看参数</span>
        </div>
      )}

      <div className="property-panel-bottom">
        <span className="property-help-icon">i</span>
        <span>类型共享尺寸 · 点击 fx 建立公式关联，改驱动参数即联动更新</span>
      </div>
    </aside>
  );
}

function GeometryFields({
  element, project, onElementPatch, onElementFormula, onEditSolid, readOnly = false,
}: {
  element: BimElement;
  project: ProjectDocument;
  onElementPatch: (id: string, patch: Record<string, unknown>) => void;
  onElementFormula: (elementId: string, key: string, formula: string | null) => void;
  onEditSolid?: (element: BimElement) => void;
  readOnly?: boolean;
}) {
  const bind = (
    label: string,
    key: string,
    value: number,
    onValue: (next: number) => void,
    unit = 'm',
    step = 0.1,
  ) => (
    <ParameterBinding
      key={key}
      label={label}
      value={value}
      step={step}
      unit={unit}
      formula={element.formulas?.[key]}
      project={project}
      elementId={element.id}
      onValue={onValue}
      onFormula={(formula) => onElementFormula(element.id, key, formula)}
    />
  );
  if (element.category === 'wall') {
    const wall = element as WallInstance;
    return (
      <>
        {bind('起点 X', 'start.x', wall.start[0], (value) => onElementPatch(wall.id, { start: [value, wall.start[1]] }))}
        {bind('起点 Y', 'start.y', wall.start[1], (value) => onElementPatch(wall.id, { start: [wall.start[0], value] }))}
        {bind('终点 X', 'end.x', wall.end[0], (value) => onElementPatch(wall.id, { end: [value, wall.end[1]] }))}
        {bind('终点 Y', 'end.y', wall.end[1], (value) => onElementPatch(wall.id, { end: [wall.end[0], value] }))}
        <ReadonlyRow label="墙长" value={`${wallLength(wall).toFixed(2)} m`} />
      </>
    );
  }
  if (element.category === 'column') {
    const column = element as ColumnInstance;
    return (
      <>
        {bind('定位 X', 'position.x', column.position[0], (value) => onElementPatch(column.id, { position: [value, column.position[1]] }))}
        {bind('定位 Y', 'position.y', column.position[1], (value) => onElementPatch(column.id, { position: [column.position[0], value] }))}
        <NumberField
          label="转角"
          value={Number((column.rotation * 180 / Math.PI).toFixed(1))}
          step={5}
          unit="°"
          onCommit={(value) => onElementPatch(column.id, { rotation: (value * Math.PI) / 180 })}
        />
      </>
    );
  }
  if (element.category === 'slab') {
    const slab = element as SlabInstance;
    const xs = slab.points.map((point) => point[0]);
    const ys = slab.points.map((point) => point[1]);
    return (
      <>
        <ReadonlyRow label="轮廓点" value={`${slab.points.length} 个`} />
        <ReadonlyRow
          label="外包尺寸"
          value={`${(Math.max(...xs) - Math.min(...xs)).toFixed(2)} × ${(Math.max(...ys) - Math.min(...ys)).toFixed(2)} m`}
        />
        <div className="property-note">轮廓编辑将在后续里程碑开放（草图模式 + 尺寸标注）。</div>
      </>
    );
  }
  if (element.primitive) {
    const spec = element.primitive;
    if (spec.kind === 'solid') {
      const features = spec.features ?? [];
      const nested = features.reduce(
        (total, feature) => total + (feature.shape?.shape === 'group' ? feature.shape.features.length : 0),
        0,
      );
      // 逐零件材质概览：名称去重后列前几个，方便一眼判断「这是不是灰模」
      const materials = new Map<string, string>();
      const walk = (list: SolidFeature[]) => {
        for (const feature of list) {
          if (feature.material) materials.set(solidMaterialKey(feature.material), solidMaterialLabel(feature.material));
          if (feature.shape?.shape === 'group') walk(feature.shape.features);
        }
      };
      walk(features);
      return (
        <>
          <ReadonlyRow label="实体类型" value="特征树（任意造型）" />
          <ReadonlyRow label="特征数" value={`${features.length} 个顶层${nested ? ` · ${nested} 个子特征` : ''}`} />
          <ReadonlyRow
            label="材质"
            value={materials.size
              ? `${materials.size} 种 · ${[...materials.values()].slice(0, 4).join('、')}${materials.size > 4 ? ' …' : ''}`
              : '跟随构件材质（未单独上色）'}
          />
          <ReadonlyRow
            label="特征"
            value={features.slice(0, 8).map((feature) => feature.label ?? feature.shape?.shape).join('、')
              + (features.length > 8 ? ' …' : '')}
          />
          <button
            className="solid-open-button"
            disabled={readOnly || !onEditSolid}
            onClick={() => onEditSolid?.(element)}
          >
            编辑特征树…
          </button>
          <div className="property-note">
            特征树是可参数化的：改尺寸 / 移位 / 阵列 / 切除 / 零件颜色都在编辑器里完成，几何实时重建。
            零件自带材质优先于上面的构件材质（没写的零件才跟随构件材质）；
            也可以直接让 AI 改，例如「把机臂加长到 30cm」「机身改成深空灰」。
          </div>
        </>
      );
    }
    return (
      <>
        <ReadonlyRow label="体量类型" value={PRIMITIVE_LABELS[spec.kind]} />
        {primitiveFields(spec).map((field) => bind(
          field.label,
          `primitive.${field.key}`,
          field.value,
          (value) => onElementPatch(element.id, { primitive: updatePrimitiveField(spec, field.key, value) }),
          field.unit || '',
          field.step,
        ))}
        <div className="property-note">参数化体量：改参数立即重建几何；点击 fx 可把尺寸关联到全局参数。</div>
      </>
    );
  }
  return <ReadonlyRow label="来源" value={element.source} />;
}

function TypeParameters({
  type, project, onTypePatch, onTypeFormula,
}: {
  type: FamilyType;
  project: ProjectDocument;
  onTypePatch: (typeId: string, patch: Record<string, unknown>) => void;
  onTypeFormula: (typeId: string, key: string, formula: string | null) => void;
}) {
  return (
    <>
      {TYPE_PARAMETER_SPECS[type.category].map((spec) => (
        <ParameterBinding
          key={spec.key}
          label={spec.label}
          value={readTypeParameter(type, spec.key) ?? 0}
          step={type.category === 'column' ? 0.05 : 0.01}
          min={spec.min}
          max={spec.max}
          unit={PARAMETER_UNIT_LABELS[spec.unit]}
          formula={type.formulas?.[spec.key]}
          project={project}
          onValue={(value) => onTypePatch(type.id, { [spec.key]: value })}
          onFormula={(formula) => onTypeFormula(type.id, spec.key, formula)}
        />
      ))}
    </>
  );
}
