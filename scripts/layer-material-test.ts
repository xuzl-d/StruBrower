/**
 * 图层管理 / 材质管理内核测试：
 * 迁移、可见性优先级、锁定保护、颜色与透明度、图元材质覆盖、材质删除引用修复、
 * 图层增删改指派、IFC 材质/图层实体、协作差分与服务端补丁校验。
 */
import {
  addLayer, addMaterial, appearanceSummary, assignLayer, assignMaterial, assignMaterialToType,
  categoryOverrideOf, clearMaterialOverride, defaultCategoryOverrides, DEFAULT_LAYER_ID,
  defaultLayers, deleteLayer, deleteMaterial, duplicateMaterial, effectiveColor, effectiveSurface,
  ensureDocumentLayers, isElementLocked, isElementVisible, layerById, layerIdForCategory,
  layerOfElement, layerUsage, materialOfElement, materialUsage, normalizeMaterial,
  setAllLayersVisible, setCategoryOverride, updateLayer, updateMaterial,
} from '../src/bim/layers';
import { countTriangles, elementColor, migrateDocument } from '../src/bim/document';
import { advanceModify, createModifySession, finishModify, immediateModify } from '../src/bim/modify';
import { createDemoProject, createProject } from '../src/bim/template';
import { exportIfc } from '../src/bim/ifc';
import { buildSchedule } from '../src/bim/schedule';
import { applyDocumentDiff, diffDocuments } from '../src/collab/diff';
import { applyDocumentDiff as serverApplyDiff, validateDiff, validateDocument } from '../server/validate.js';
import type { ProjectDocument, WallInstance } from '../src/bim/types';

let failed = 0;
function check(name: string, ok: boolean, detail?: unknown) {
  if (ok) console.log('  ✓', name);
  else { failed += 1; console.log('  ✗', name, detail ?? ''); }
}

const project = createDemoProject();
const wall = project.elements.find((element) => element.id === 'demo-wall-1') as WallInstance;
const column = project.elements.find((element) => element.category === 'column')!;
const slab = project.elements.find((element) => element.category === 'slab')!;

/* ------------------------------ 默认数据与迁移 ------------------------------ */
check('示例项目自带 6 个默认图层与 5 种材质', project.layers?.length === 6 && project.materials.length === 5);
check('构件按类别自动归入对应图层',
  wall.layerId === 'layer-wall' && column.layerId === 'layer-column'
  && slab.layerId === 'layer-slab' && layerIdForCategory('mesh') === 'layer-import');
check('类别替换默认全部可见',
  Object.values(defaultCategoryOverrides()).every((override) => override.visible));
check('新项目也带图层表', createProject({ name: '空项目' }).layers?.length === 6);

const legacy: ProjectDocument = {
  ...project,
  layers: undefined,
  categoryOverrides: undefined,
  elements: project.elements.map((element) => {
    const copy = { ...element } as Record<string, unknown>;
    delete copy.layerId;
    return copy as unknown as ProjectDocument['elements'][number];
  }),
};
const migrated = migrateDocument(legacy);
check('旧文档迁移：自动补图层并按类别指派构件',
  migrated.layers?.length === 6 && migrated.elements.every((element) => Boolean(element.layerId)),
  migrated.layers?.length);
check('ensureDocumentLayers 幂等（第二次返回同一引用）', ensureDocumentLayers(migrated) === migrated);
check('layerById / layerOfElement 解析正确',
  layerById(project, 'layer-wall')?.name.includes('墙') === true
  && layerOfElement(project, wall)?.id === 'layer-wall');

/* ------------------------------ 可见性与颜色优先级 ------------------------------ */
const allVisible = project.elements.every((element) => isElementVisible(project, element));
const hiddenWallLayer = updateLayer(project, 'layer-wall', { visible: false });
check('隐藏图层：该层构件不可见，其它层仍可见',
  allVisible && !isElementVisible(hiddenWallLayer, wall) && isElementVisible(hiddenWallLayer, column));
check('countTriangles 跟随图层可见性下降', countTriangles(hiddenWallLayer) < countTriangles(project));
const hiddenCategory = setCategoryOverride(project, 'column', { visible: false });
check('隐藏类别：柱不可见，墙仍可见',
  !isElementVisible(hiddenCategory, column) && isElementVisible(hiddenCategory, wall));
check('构件自身 visible=false 优先级最高',
  !isElementVisible(project, { ...wall, visible: false }));
check('全部显示 / 全部隐藏', (() => {
  const off = setAllLayersVisible(project, false);
  const on = setAllLayersVisible(off, true);
  return project.elements.every((element) => !isElementVisible(off, element))
    && project.elements.every((element) => isElementVisible(on, element));
})());

const originalColor = effectiveColor(project, wall);
const categoryColor = setCategoryOverride(project, 'wall', { color: '#112233' });
const layerColor = updateLayer(categoryColor, 'layer-wall', { colorOverride: true, color: '#ff0000' });
check('颜色优先级：图层替换 > 类别替换 > 材质色',
  originalColor !== '#112233' && effectiveColor(categoryColor, wall) === '#112233'
  && effectiveColor(layerColor, wall) === '#ff0000');
check('elementColor 与 effectiveColor 一致', elementColor(layerColor, wall) === effectiveColor(layerColor, wall));
const glass = assignMaterial(project, [wall.id], 'mat-glass');
check('材质不透明度影响最终表面样式', (() => {
  const style = effectiveSurface(glass, glass.elements.find((element) => element.id === wall.id)!);
  return style.transparent && style.opacity > 0.3 && style.opacity < 0.4;
})());
check('图层透明度与材质透明度叠加', (() => {
  const transparentLayer = updateLayer(glass, 'layer-wall', { transparency: 50 });
  const style = effectiveSurface(transparentLayer, transparentLayer.elements.find((element) => element.id === wall.id)!);
  const base = effectiveSurface(glass, glass.elements.find((element) => element.id === wall.id)!);
  return Math.abs(style.opacity - base.opacity * 0.5) < 1e-9;
})());
check('类别替换对象可读取默认值', categoryOverrideOf(project, 'slab').visible === true);

/* ------------------------------ 锁定保护 ------------------------------ */
const locked = updateLayer(project, 'layer-wall', { locked: true });
check('图层锁定：isElementLocked 生效且不影响别的层',
  isElementLocked(locked, wall) && !isElementLocked(locked, column));
check('锁定图层中的构件无法被删除', (() => {
  const outcome = immediateModify(locked, 'delete', [wall.id]);
  return Boolean(outcome.error) && outcome.elements === locked.elements;
})());
check('锁定图层中的构件无法被移动', (() => {
  const session = createModifySession('move', locked, [wall.id]);
  const outcome = finishModify(locked, session, null);
  return Boolean(outcome.error);
})());
check('解锁图层后可正常移动', (() => {
  const unlocked = updateLayer(locked, 'layer-wall', { locked: false });
  let session = createModifySession('move', unlocked, [wall.id]);
  session = advanceModify(session, { point: [0, 0], hitId: null });
  session = advanceModify(session, { point: [1, 0], hitId: null });
  const outcome = finishModify(unlocked, session, null);
  return !outcome.error && outcome.elements.find((element) => element.id === wall.id) !== wall;
})());

/* ------------------------------ 材质操作 ------------------------------ */
const usage = materialUsage(project);
check('材质引用统计：混凝土被 3 个类型引用', usage['mat-concrete'] === 3, usage);
check('图元材质覆盖优先于类型材质',
  materialOfElement(glass, glass.elements.find((element) => element.id === wall.id)!)?.id === 'mat-glass'
  && materialOfElement(project, wall)?.id === 'mat-concrete');
check('明细表材质列反映图元覆盖',
  buildSchedule(glass).find((row) => row.id === wall.id)?.material.includes('玻璃') === true);
check('清除图元覆盖后恢复类型材质', (() => {
  const cleared = clearMaterialOverride(glass, [wall.id]);
  return materialOfElement(cleared, cleared.elements.find((element) => element.id === wall.id)!)?.id === 'mat-concrete';
})());
check('应用到族类型：全部同类型实例生效', (() => {
  const changed = assignMaterialToType(project, wall.typeId, 'mat-wood');
  return materialOfElement(changed, wall)?.id === 'mat-wood'
    && project.elements.filter((element) => element.category === 'wall').every(
      (element) => materialOfElement(changed, element)?.id === 'mat-wood',
    );
})());
check('新建 / 复制材质', (() => {
  const created = addMaterial(project, { name: '自定义', color: '#abcdef' });
  const copied = duplicateMaterial(created, created.materials.at(-1)!.id);
  return created.materials.length === project.materials.length + 1
    && copied.materials.length === created.materials.length + 1
    && copied.materials.at(-1)!.name === '自定义 副本';
})());
check('材质数值钳制在合法区间', (() => {
  const changed = updateMaterial(project, 'mat-concrete', { opacity: 999, roughness: -3, metalness: 2 });
  const surface = normalizeMaterial(changed.materials.find((item) => item.id === 'mat-concrete')!);
  return surface.opacity === 100 && surface.roughness === 0 && surface.metalness === 1;
})());
check('删除材质：类型与图元引用自动改指默认材质', (() => {
  const withOverride = assignMaterial(project, [wall.id], 'mat-concrete');
  const removed = deleteMaterial(withOverride, 'mat-concrete');
  const fallback = removed.materials[0]!.id;
  return removed.materials.length === project.materials.length - 1
    && removed.types.filter((type) => 'materialId' in type)
      .every((type) => !('materialId' in type) || type.materialId !== 'mat-concrete')
    && removed.elements.find((element) => element.id === wall.id)?.materialId === fallback;
})());
check('0 号默认材质不能删到空表', deleteMaterial({ ...project, materials: [project.materials[0]!] }, 'mat-concrete').materials.length === 1);

/* ------------------------------ 图层操作 ------------------------------ */
check('新建图层与删除空图层', (() => {
  const added = addLayer(project);
  const newId = added.layers!.at(-1)!.id;
  return added.layers!.length === 7 && deleteLayer(added, newId).layers!.length === 6;
})());
check('0 号默认图层不可删除', deleteLayer(project, DEFAULT_LAYER_ID) === project);
check('删除含构件的图层时构件回到 0 号图层', (() => {
  const removed = deleteLayer(project, 'layer-wall');
  return removed.elements.find((element) => element.id === wall.id)?.layerId === DEFAULT_LAYER_ID
    && !removed.layers!.some((layer) => layer.id === 'layer-wall');
})());
check('指派构件到指定图层', (() => {
  const moved = assignLayer(project, [wall.id], 'layer-reference');
  return moved.elements.find((element) => element.id === wall.id)?.layerId === 'layer-reference'
    && layerUsage(moved)['layer-reference'] === 1;
})());
check('指派到不存在的图层不改变文档', assignLayer(project, [wall.id], 'no-such-layer') === project);
check('图层使用统计与 appearanceSummary 一致', (() => {
  const counts = layerUsage(project);
  const summary = appearanceSummary(project);
  return Object.values(counts).reduce((sum, count) => sum + count, 0) === project.elements.length
    && summary.layers === 6 && summary.hiddenLayers === 0 && summary.lockedLayers === 0;
})());
check('重命名 / 颜色 / 透明度更新图层', (() => {
  const renamed = updateLayer(project, 'layer-wall', { name: '外墙', color: '#010203', transparency: 25 });
  const layer = layerById(renamed, 'layer-wall')!;
  return layer.name === '外墙' && layer.color === '#010203' && layer.transparency === 25;
})());
check('defaultLayers 每次返回新数组（避免共享引用）', defaultLayers() !== defaultLayers());

/* ------------------------------ IFC / 协作 ------------------------------ */
const ifc = exportIfc(project);
check('IFC4 导出包含 IfcMaterial 与材质关联',
  ifc.includes('IFCMATERIAL(') && ifc.includes('IFCRELASSOCIATESMATERIAL('));
check('IFC4 导出包含 IfcPresentationLayerAssignment（图层）',
  ifc.includes('IFCPRESENTATIONLAYERASSIGNMENT('));
check('IFC 图层名来自项目图层表', ifc.includes('IFCPRESENTATIONLAYERASSIGNMENT(') && project.layers!.some((layer) => layer.name.includes('墙')));
check('IFC 材质关联数量 = 有材质的构件数', (() => {
  const count = project.elements.filter((element) => element.visible && materialOfElement(project, element)).length;
  return (ifc.match(/IFCRELASSOCIATESMATERIAL\(/g) ?? []).length === count;
})());

const changedDoc = updateLayer(project, 'layer-wall', { visible: false, locked: true });
const diff = diffDocuments(project, changedDoc);
check('协作差分包含 layers 字段', Boolean(diff?.layers) && diff?.layers?.length === 6);
check('类别替换变更也进入差分', (() => {
  const withCategory = setCategoryOverride(project, 'slab', { visible: false, color: '#abcdef' });
  const categoryDiff = diffDocuments(project, withCategory);
  return categoryDiff?.categoryOverrides?.slab?.visible === false
    && applyDocumentDiff(project, categoryDiff).categoryOverrides?.slab?.color === '#abcdef';
})());
check('applyDocumentDiff 往返还原图层状态', (() => {
  const restored = applyDocumentDiff(project, diff!);
  return restored.layers?.find((layer) => layer.id === 'layer-wall')?.visible === false
    && restored.layers?.find((layer) => layer.id === 'layer-wall')?.locked === true;
})());
check('服务端 validateDiff 接受新字段', validateDiff({
  layers: changedDoc.layers,
  categoryOverrides: { wall: { visible: false, transparency: 30 } },
}) === null);
check('服务端 validateDiff 拒绝非法 categoryOverrides', validateDiff({
  categoryOverrides: { wall: { visible: 'no' } },
}) !== null);
check('服务端 applyDocumentDiff 支持图层替换', (() => {
  const next = serverApplyDiff(project, { layers: changedDoc.layers });
  return next.layers?.find((layer) => layer.id === 'layer-wall')?.visible === false;
})());
check('服务端 validateDocument 仍接受带图层的新文档', validateDocument(changedDoc) === null);

console.log(failed ? `\n${failed} 项失败` : '\n全部通过');
process.exit(failed ? 1 : 0);
