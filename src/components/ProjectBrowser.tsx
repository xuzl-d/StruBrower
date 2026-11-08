import { categoryLabels } from '../bim/types';
import type { BimElement, ElementCategory, ProjectDocument } from '../bim/types';
import type { ViewKind } from '../ModelViewport';

interface ProjectBrowserProps {
  onCollapse?: () => void;
  width?: number;
  project: ProjectDocument;
  activeLevelId: string;
  viewKind: ViewKind;
  viewLevelId: string | null;
  selection: string[];
  selectedLevelId: string | null;
  onActivate3d: () => void;
  onActivatePlan: (levelId: string) => void;
  onSelectLevel: (levelId: string) => void;
  onAddLevel: () => void;
  onSelectElement: (id: string, additive: boolean) => void;
  onToggleVisibility: (id: string) => void;
  onDeleteGrid: (id: string) => void;
  onRenameProject: () => void;
  onOpenLayers: () => void;
  onOpenMaterials: () => void;
  onToggleLayer: (id: string) => void;
}

const CATEGORY_ORDER: ElementCategory[] = ['wall', 'column', 'slab', 'mesh'];

const SYMBOLS: Record<ElementCategory, string> = {
  wall: '▤',
  column: '▮',
  slab: '▬',
  mesh: '◇',
};

export default function ProjectBrowser({
  onCollapse,
  width,
  project,
  activeLevelId,
  viewKind,
  viewLevelId,
  selection,
  selectedLevelId,
  onActivate3d,
  onActivatePlan,
  onSelectLevel,
  onAddLevel,
  onSelectElement,
  onToggleVisibility,
  onDeleteGrid,
  onRenameProject,
  onOpenLayers,
  onOpenMaterials,
  onToggleLayer,
}: ProjectBrowserProps) {
  const typeName = (element: BimElement): string =>
    project.types.find((type) => type.id === element.typeId)?.name ?? (element.category === 'mesh' ? element.source : '未指定类型');

  return (
    <aside
      className="panel left-panel"
      style={width ? { width, flexBasis: width } : undefined}
    >
      <div className="panel-heading">
        <span>项目浏览器</span>
        <div className="panel-heading-actions">
          <button aria-label="项目浏览器选项" title="项目浏览器">···</button>
          <button className="panel-collapse" onClick={onCollapse} title="收起面板" aria-label="收起项目浏览器">«</button>
        </div>
      </div>

      <div className="project-summary">
        <div className="project-icon">▧</div>
        <div className="project-title">
          <strong>{project.name}</strong>
          <span>{project.elements.length} 个构件 · {project.levels.length} 个标高</span>
        </div>
        <button className="rename-mini" onClick={onRenameProject} aria-label="重命名项目" title="重命名项目">✎</button>
      </div>

      <div className="browser-scroll">
        <section className="browser-section">
          <div className="tree-section-title"><span>⌄</span> 视图 <em>{project.levels.length + 1}</em></div>
          <div className={`view-row ${viewKind === '3d' ? 'active' : ''}`} onClick={onActivate3d}>
            <span className="view-glyph">◈</span> 三维视图
          </div>
          {project.levels.map((level) => (
            <div
              key={level.id}
              className={`view-row ${viewKind === 'plan' && viewLevelId === level.id ? 'active' : ''}`}
              onClick={() => onActivatePlan(level.id)}
            >
              <span className="view-glyph">▦</span> {level.name} 平面
            </div>
          ))}
        </section>

        <section className="browser-section">
          <div className="tree-section-title">
            <span>⌄</span> 标高 <em>{project.levels.length}</em>
            <button className="section-add" onClick={onAddLevel} title="添加标高">＋</button>
          </div>
          {project.levels.map((level) => (
            <div
              key={level.id}
              className={`level-row ${selectedLevelId === level.id ? 'selected' : ''} ${activeLevelId === level.id ? 'current' : ''}`}
              onClick={() => onSelectLevel(level.id)}
              title="选中标高后在右侧编辑名称与标高"
            >
              <span className="level-glyph">▭</span>
              <span className="level-name">{level.name}</span>
              <span className="level-elevation">{level.elevation.toFixed(2)} m</span>
              {activeLevelId === level.id ? <span className="level-badge">当前</span> : null}
            </div>
          ))}
        </section>

        <section className="browser-section">
          <div className="tree-section-title"><span>⌄</span> 轴网 <em>{project.grids.length}</em></div>
          {project.grids.length === 0 ? (
            <div className="browser-hint">使用「轴网」工具在视口中绘制两条点</div>
          ) : (
            project.grids.map((grid) => (
              <div key={grid.id} className="grid-row">
                <span className="grid-glyph">┼</span>
                <span className="grid-name">轴网 {grid.name}</span>
                <button className="row-delete" onClick={() => onDeleteGrid(grid.id)} title="删除轴网">✕</button>
              </div>
            ))
          )}
        </section>

        <section className="browser-section">
          <div className="tree-section-title">
            <span>⌄</span> 图层 <em>{project.layers?.length ?? 0}</em>
            <button className="section-add" onClick={onOpenLayers} title="打开图层管理器 / 可见性图形 (VV)">⚙</button>
          </div>
          {(project.layers ?? []).map((layer) => (
            <div className={`grid-row ${layer.visible ? '' : 'layer-hidden'}`} key={layer.id}>
              <span className="layer-dot" style={{ background: layer.color }} />
              <span className="grid-name">{layer.name}</span>
              {layer.locked ? <span className="layer-lock" title="图层已锁定">🔒</span> : null}
              <button
                className={`visibility-toggle ${layer.visible ? '' : 'muted'}`}
                onClick={() => onToggleLayer(layer.id)}
                title={layer.visible ? '隐藏图层' : '显示图层'}
              >{layer.visible ? '◉' : '⊘'}</button>
            </div>
          ))}
        </section>

        <section className="browser-section">
          <div className="tree-section-title">
            <span>⌄</span> 材质 <em>{project.materials.length}</em>
            <button className="section-add" onClick={onOpenMaterials} title="打开材质浏览器 (MA)">⚙</button>
          </div>
          {project.materials.map((material) => (
            <div className="grid-row" key={material.id} title={material.description || material.name}>
              <span className="layer-dot" style={{ background: material.color, opacity: (material.opacity ?? 100) / 100 }} />
              <span className="grid-name">{material.name}</span>
            </div>
          ))}
        </section>

        <section className="browser-section">
          <div className="tree-section-title"><span>⌄</span> 构件 <em>{project.elements.length}</em></div>
          {project.elements.length === 0 ? (
            <div className="empty-tree">
              <div className="empty-glyph">◇</div>
              <strong>项目还没有构件</strong>
              <span>在「建筑」选项卡选择墙 / 柱 / 楼板，然后在视口中点击放置</span>
            </div>
          ) : (
            CATEGORY_ORDER.map((category) => {
              const items = project.elements.filter((element) => element.category === category);
              if (!items.length) return null;
              return (
                <div className="category-group" key={category}>
                  <div className="category-heading">
                    <span>{SYMBOLS[category]}</span>
                    {categoryLabels[category]}
                    <em>{items.length}</em>
                  </div>
                  {items.map((element) => (
                    <div className={`tree-row ${selection.includes(element.id) ? 'selected' : ''}`} key={element.id}>
                      <button
                        className="tree-select"
                        onClick={(event) => onSelectElement(element.id, event.shiftKey || event.ctrlKey || event.metaKey)}
                        title="选择构件"
                      >
                        <span className={`element-symbol ${element.category}`}>{SYMBOLS[element.category]}</span>
                        <span className="element-name">{element.name}</span>
                        <span className="element-kind">{typeName(element)}</span>
                      </button>
                      <button
                        className={`visibility-toggle ${element.visible ? '' : 'muted'}`}
                        onClick={() => onToggleVisibility(element.id)}
                        title={element.visible ? '隐藏构件' : '显示构件'}
                      >
                        {element.visible ? '◉' : '⊘'}
                      </button>
                    </div>
                  ))}
                </div>
              );
            })
          )}
        </section>
      </div>

      <div className="left-panel-footer"><span className="sync-dot" />数据保存在此浏览器（IndexedDB）</div>
    </aside>
  );
}
