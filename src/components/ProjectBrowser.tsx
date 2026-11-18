import { useEffect, useState } from 'react';
import type { MouseEvent as ReactMouseEvent } from 'react';
import { sortedLevels } from '../bim/document';
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
  onClearGrids: () => void;
  onDeleteLevel: (id: string) => void;
  onDeleteLayer: (id: string) => void;
  onDeleteMaterial: (id: string) => void;
  onDeleteElement: (id: string) => void;
  onRenameProject: () => void;
  onOpenLayers: () => void;
  onOpenMaterials: () => void;
  onToggleLayer: (id: string) => void;
}

const CATEGORY_ORDER: ElementCategory[] = ['wall', 'column', 'beam', 'brace', 'slab', 'mesh'];

const SYMBOLS: Record<ElementCategory, string> = {
  wall: '▤',
  column: '▮',
  beam: '═',
  brace: '╱',
  slab: '▬',
  mesh: '◇',
};

type MenuTarget =
  | { kind: 'level'; id: string; label: string }
  | { kind: 'grid'; id: string; label: string }
  | { kind: 'layer'; id: string; label: string }
  | { kind: 'material'; id: string; label: string }
  | { kind: 'element'; id: string; label: string };

interface ContextMenuState {
  x: number;
  y: number;
  target: MenuTarget;
}

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
  onClearGrids,
  onDeleteLevel,
  onDeleteLayer,
  onDeleteMaterial,
  onDeleteElement,
  onRenameProject,
  onOpenLayers,
  onOpenMaterials,
  onToggleLayer,
}: ProjectBrowserProps) {
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [menu, setMenu] = useState<ContextMenuState | null>(null);

  const toggleSection = (key: string) =>
    setCollapsed((current) => ({ ...current, [key]: !current[key] }));

  const openMenu = (event: ReactMouseEvent, target: MenuTarget) => {
    event.preventDefault();
    event.stopPropagation();
    setMenu({
      x: Math.min(event.clientX, window.innerWidth - 180),
      y: Math.min(event.clientY, window.innerHeight - 80),
      target,
    });
  };

  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    window.addEventListener('mousedown', close);
    window.addEventListener('scroll', close, true);
    return () => {
      window.removeEventListener('mousedown', close);
      window.removeEventListener('scroll', close, true);
    };
  }, [menu]);

  const runMenuDelete = () => {
    if (!menu) return;
    const target = menu.target;
    switch (target.kind) {
      case 'level': onDeleteLevel(target.id); break;
      case 'grid': onDeleteGrid(target.id); break;
      case 'layer': onDeleteLayer(target.id); break;
      case 'material': onDeleteMaterial(target.id); break;
      case 'element': onDeleteElement(target.id); break;
    }
    setMenu(null);
  };

  /** 视图/标高列表按高度升序显示 */
  const orderedLevels = sortedLevels(project);
  const typeName = (element: BimElement): string =>
    project.types.find((type) => type.id === element.typeId)?.name ?? (element.category === 'mesh' ? element.source : '未指定类型');

  const caret = (key: string) => <span className="tree-caret">{collapsed[key] ? '›' : '⌄'}</span>;

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
          <div className="tree-section-title" onClick={() => toggleSection('views')} title="点击折叠/展开">
            {caret('views')} 视图 <em>{project.levels.length + 1}</em>
          </div>
          {!collapsed.views ? (
            <>
              <div className={`view-row ${viewKind === '3d' ? 'active' : ''}`} onClick={onActivate3d}>
                <span className="view-glyph">◈</span> 三维视图
              </div>
              {orderedLevels.map((level) => (
                <div
                  key={level.id}
                  className={`view-row ${viewKind === 'plan' && viewLevelId === level.id ? 'active' : ''}`}
                  onClick={() => onActivatePlan(level.id)}
                >
                  <span className="view-glyph">▦</span> {level.name} 平面
                </div>
              ))}
            </>
          ) : null}
        </section>

        <section className="browser-section">
          <div className="tree-section-title" onClick={() => toggleSection('levels')} title="点击折叠/展开">
            {caret('levels')} 标高 <em>{project.levels.length}</em>
            <button
              className="section-add"
              onClick={(event) => { event.stopPropagation(); onAddLevel(); }}
              title="添加标高"
            >＋</button>
          </div>
          {!collapsed.levels ? orderedLevels.map((level) => (
            <div
              key={level.id}
              className={`level-row ${selectedLevelId === level.id ? 'selected' : ''} ${activeLevelId === level.id ? 'current' : ''}`}
              onClick={() => onSelectLevel(level.id)}
              onContextMenu={(event) => openMenu(event, { kind: 'level', id: level.id, label: `标高 ${level.name}` })}
              title="单击选中标高；右键删除"
            >
              <span className="level-glyph">▭</span>
              <span className="level-name">{level.name}</span>
              <span className="level-elevation">{level.elevation.toFixed(2)} m</span>
              {activeLevelId === level.id ? <span className="level-badge">当前</span> : null}
            </div>
          )) : null}
        </section>

        <section className="browser-section">
          <div className="tree-section-title" onClick={() => toggleSection('grids')} title="点击折叠/展开">
            {caret('grids')} 轴网 <em>{project.grids.length}</em>
            {project.grids.length > 0 ? (
              <button
                className="section-add"
                onClick={(event) => { event.stopPropagation(); onClearGrids(); }}
                title="删除全部轴网（可撤销）"
              >清空</button>
            ) : null}
          </div>
          {!collapsed.grids ? (
            project.grids.length === 0 ? (
              <div className="browser-hint">使用「轴网」工具在视口中绘制两条点</div>
            ) : (
              project.grids.map((grid) => (
                <div
                  key={grid.id}
                  className="grid-row"
                  onContextMenu={(event) => openMenu(event, { kind: 'grid', id: grid.id, label: `轴网 ${grid.name}` })}
                  title="右键删除"
                >
                  <span className="grid-glyph">┼</span>
                  <span className="grid-name">轴网 {grid.name}</span>
                  <button
                    className="row-delete"
                    onClick={() => onDeleteGrid(grid.id)}
                    title="删除轴网"
                  >✕</button>
                </div>
              ))
            )
          ) : null}
        </section>

        <section className="browser-section">
          <div className="tree-section-title" onClick={() => toggleSection('layers')} title="点击折叠/展开">
            {caret('layers')} 图层 <em>{project.layers?.length ?? 0}</em>
            <button
              className="section-add"
              onClick={(event) => { event.stopPropagation(); onOpenLayers(); }}
              title="打开图层管理器 / 可见性图形 (VV)"
            >⚙</button>
          </div>
          {!collapsed.layers ? (project.layers ?? []).map((layer) => (
            <div
              className={`grid-row ${layer.visible ? '' : 'layer-hidden'}`}
              key={layer.id}
              onContextMenu={(event) => openMenu(event, { kind: 'layer', id: layer.id, label: `图层 ${layer.name}` })}
              title="右键删除"
            >
              <span className="layer-dot" style={{ background: layer.color }} />
              <span className="grid-name">{layer.name}</span>
              {layer.locked ? <span className="layer-lock" title="图层已锁定">🔒</span> : null}
              <button
                className={`visibility-toggle ${layer.visible ? '' : 'muted'}`}
                onClick={() => onToggleLayer(layer.id)}
                title={layer.visible ? '隐藏图层' : '显示图层'}
              >{layer.visible ? '◉' : '⊘'}</button>
            </div>
          )) : null}
        </section>

        <section className="browser-section">
          <div className="tree-section-title" onClick={() => toggleSection('materials')} title="点击折叠/展开">
            {caret('materials')} 材质 <em>{project.materials.length}</em>
            <button
              className="section-add"
              onClick={(event) => { event.stopPropagation(); onOpenMaterials(); }}
              title="打开材质浏览器 (MA)"
            >⚙</button>
          </div>
          {!collapsed.materials ? project.materials.map((material) => (
            <div
              className="grid-row"
              key={material.id}
              title={material.description || material.name}
              onContextMenu={(event) => openMenu(event, { kind: 'material', id: material.id, label: `材质 ${material.name}` })}
            >
              <span className="layer-dot" style={{ background: material.color, opacity: (material.opacity ?? 100) / 100 }} />
              <span className="grid-name">{material.name}</span>
            </div>
          )) : null}
        </section>

        <section className="browser-section">
          <div className="tree-section-title" onClick={() => toggleSection('elements')} title="点击折叠/展开">
            {caret('elements')} 构件 <em>{project.elements.length}</em>
          </div>
          {!collapsed.elements ? (
            project.elements.length === 0 ? (
              <div className="empty-tree">
                <div className="empty-glyph">◇</div>
                <strong>项目还没有构件</strong>
                <span>在「建筑」选项卡选择墙 / 柱 / 楼板，然后在视口中点击放置</span>
              </div>
            ) : (
              CATEGORY_ORDER.map((category) => {
                const items = project.elements.filter((element) => element.category === category);
                if (!items.length) return null;
                const groupKey = `cat:${category}`;
                return (
                  <div className="category-group" key={category}>
                    <div className="category-heading" onClick={() => toggleSection(groupKey)} title="点击折叠/展开">
                      {caret(groupKey)}
                      <span>{SYMBOLS[category]}</span>
                      {categoryLabels[category]}
                      <em>{items.length}</em>
                    </div>
                    {!collapsed[groupKey] ? items.map((element) => (
                      <div
                        className={`tree-row ${selection.includes(element.id) ? 'selected' : ''}`}
                        key={element.id}
                        onContextMenu={(event) => openMenu(event, { kind: 'element', id: element.id, label: `构件 ${element.name}` })}
                        title="右键删除"
                      >
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
                    )) : null}
                  </div>
                );
              })
            )
          ) : null}
        </section>
      </div>

      <div className="left-panel-footer"><span className="sync-dot" />数据保存在此浏览器（IndexedDB）</div>

      {menu ? (
        <div
          className="browser-context-menu"
          style={{ left: menu.x, top: menu.y }}
          onMouseDown={(event) => event.stopPropagation()}
          onContextMenu={(event) => event.preventDefault()}
        >
          <div className="context-menu-target">{menu.target.label}</div>
          <button className="context-menu-item danger" onClick={runMenuDelete}>删除</button>
        </div>
      ) : null}
    </aside>
  );
}
