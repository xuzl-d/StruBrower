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
import { elementMeasures, wallLength } from '../bim/document';
import { NumberField, ReadonlyRow, SelectField, TextField } from './Fields';

interface PropertiesPanelProps {
  onCollapse?: () => void;
  width?: number;
  project: ProjectDocument;
  selection: BimElement[];
  selectedLevel: Level | null;
  onElementPatch: (id: string, patch: Record<string, unknown>) => void;
  onTypePatch: (typeId: string, patch: Record<string, unknown>) => void;
  onLevelPatch: (levelId: string, patch: { name?: string; elevation?: number }) => void;
  onDeleteSelection: () => void;
  onBoolean: (operation: 'union' | 'subtract' | 'intersect') => void;
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
  onLevelPatch,
  onDeleteSelection,
  onBoolean,
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
            <NumberField
              label={element.category === 'slab' ? '偏移' : '底部偏移'}
              value={'baseOffset' in element ? element.baseOffset : 0}
              step={0.05}
              unit="m"
              onCommit={(value) => onElementPatch(element.id, { baseOffset: value })}
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
              <NumberField
                label="顶部偏移"
                value={element.topOffset}
                step={0.05}
                unit="m"
                onCommit={(value) => onElementPatch(element.id, { topOffset: value })}
              />
            </>
          ) : null}

          <div className="property-group-heading"><span>尺寸（派生）</span><span>⌃</span></div>
          {elementMeasures(project, element).map((row) => (
            <ReadonlyRow key={row.label} label={row.label} value={row.value} />
          ))}
          <GeometryFields element={element} onElementPatch={onElementPatch} />

          {type ? (
            <>
              <div className="property-group-heading geometry-heading">
                <span>类型参数</span>
                <span className="heading-note">{typeUsage} 个实例共享</span>
              </div>
              <TextField label="类型名" value={type.name} onCommit={(value) => onTypePatch(type.id, { name: value })} />
              <TypeParameters type={type} onTypePatch={onTypePatch} />
              <SelectField
                label="材质"
                value={'materialId' in type ? type.materialId : ''}
                options={project.materials.map((material) => ({ value: material.id, label: material.name }))}
                onChange={(value) => onTypePatch(type.id, { materialId: value })}
              />
              <div className="property-note">修改类型参数会同时更新全部 {typeUsage} 个实例；尺寸派生值随之刷新。</div>
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
        <span>参数化构件：类型共享尺寸，实例持有位置与标高约束</span>
      </div>
    </aside>
  );
}

function GeometryFields({
  element,
  onElementPatch,
}: {
  element: BimElement;
  onElementPatch: (id: string, patch: Record<string, unknown>) => void;
}) {
  if (element.category === 'wall') {
    const wall = element as WallInstance;
    return (
      <>
        <NumberField
          label="起点 X"
          value={wall.start[0]}
          step={0.1}
          unit="m"
          onCommit={(value) => onElementPatch(wall.id, { start: [value, wall.start[1]] })}
        />
        <NumberField
          label="起点 Y"
          value={wall.start[1]}
          step={0.1}
          unit="m"
          onCommit={(value) => onElementPatch(wall.id, { start: [wall.start[0], value] })}
        />
        <NumberField
          label="终点 X"
          value={wall.end[0]}
          step={0.1}
          unit="m"
          onCommit={(value) => onElementPatch(wall.id, { end: [value, wall.end[1]] })}
        />
        <NumberField
          label="终点 Y"
          value={wall.end[1]}
          step={0.1}
          unit="m"
          onCommit={(value) => onElementPatch(wall.id, { end: [wall.end[0], value] })}
        />
        <ReadonlyRow label="墙长" value={`${wallLength(wall).toFixed(2)} m`} />
      </>
    );
  }
  if (element.category === 'column') {
    const column = element as ColumnInstance;
    return (
      <>
        <NumberField
          label="定位 X"
          value={column.position[0]}
          step={0.1}
          unit="m"
          onCommit={(value) => onElementPatch(column.id, { position: [value, column.position[1]] })}
        />
        <NumberField
          label="定位 Y"
          value={column.position[1]}
          step={0.1}
          unit="m"
          onCommit={(value) => onElementPatch(column.id, { position: [column.position[0], value] })}
        />
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
  return <ReadonlyRow label="来源" value={element.source} />;
}

function TypeParameters({
  type,
  onTypePatch,
}: {
  type: FamilyType;
  onTypePatch: (typeId: string, patch: Record<string, unknown>) => void;
}) {
  if (type.category === 'wall') {
    return (
      <NumberField
        label="厚度"
        value={type.thickness}
        step={0.01}
        min={0.02}
        max={2}
        unit="m"
        onCommit={(value) => onTypePatch(type.id, { thickness: value })}
      />
    );
  }
  if (type.category === 'column') {
    return (
      <>
        <NumberField label="截面宽" value={type.width} step={0.05} min={0.1} max={3} unit="m" onCommit={(value) => onTypePatch(type.id, { width: value })} />
        <NumberField label="截面深" value={type.depth} step={0.05} min={0.1} max={3} unit="m" onCommit={(value) => onTypePatch(type.id, { depth: value })} />
      </>
    );
  }
  return (
    <NumberField label="厚度" value={type.thickness} step={0.01} min={0.02} max={1} unit="m" onCommit={(value) => onTypePatch(type.id, { thickness: value })} />
  );
}
