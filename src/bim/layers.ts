/**
 * 图层 / 材质内核（纯函数，无 three / React 依赖）。
 *
 * 模型参照 Revit：
 * - 图层 ≈ 「可见性/图形(VV)」中的过滤器 + CAD 图层：控制整层显示、锁定、颜色替换、透明度；
 * - 类别替换 ≈ VV 的「模型类别」页：控制墙/柱/板/导入几何的显示与投影颜色；
 * - 材质 ≈ 材质浏览器：颜色 + 透明度 + 表面物理属性，可由类型继承，也可按图元覆盖。
 *
 * 优先级（由高到低）：图层颜色替换 > 类别颜色替换 > 图元材质 > 类型材质 > mesh 自带色。
 * 可见性：构件自身 visible && 图层 visible && 类别 visible，三者全部为真才显示。
 */
import { createId } from './id';
import type {
  BimElement,
  CategoryOverride,
  ElementCategory,
  Id,
  Layer,
  Material,
  ProjectDocument,
} from './types';

export const DEFAULT_LAYER_ID = 'layer-0';

export const DEFAULT_ROUGHNESS = 0.62;
export const DEFAULT_METALNESS = 0.04;
export const FALLBACK_COLOR = '#a3adb8';

interface LayerSpec {
  id: Id;
  name: string;
  color: string;
}

/** 新项目自带的图层，名称沿用 CAD 图层命名习惯。 */
export const DEFAULT_LAYER_SPECS: LayerSpec[] = [
  { id: DEFAULT_LAYER_ID, name: '0 · 默认', color: '#a3adb8' },
  { id: 'layer-wall', name: 'A-WALL · 墙', color: '#c6bba8' },
  { id: 'layer-column', name: 'S-COLM · 柱', color: '#8b98a8' },
  { id: 'layer-slab', name: 'S-FLOR · 楼板', color: '#9fb0a4' },
  { id: 'layer-import', name: 'IMP-GEOM · 导入几何', color: '#9fd3e4' },
  { id: 'layer-reference', name: 'A-REF · 参照', color: '#7f8fa6' },
];

export function defaultLayers(): Layer[] {
  return DEFAULT_LAYER_SPECS.map((spec) => ({
    id: spec.id,
    name: spec.name,
    color: spec.color,
    visible: true,
    locked: false,
    colorOverride: false,
    transparency: 0,
  }));
}

export function defaultCategoryOverrides(): Record<ElementCategory, CategoryOverride> {
  return {
    wall: { visible: true },
    column: { visible: true },
    slab: { visible: true },
    mesh: { visible: true },
  };
}

/** 构件未标注图层时按类别归属，保证旧文档导入后立刻分层。 */
export function layerIdForCategory(category: ElementCategory): Id {
  if (category === 'wall') return 'layer-wall';
  if (category === 'column') return 'layer-column';
  if (category === 'slab') return 'layer-slab';
  if (category === 'mesh') return 'layer-import';
  return DEFAULT_LAYER_ID;
}

/**
 * 文档规范化：补齐图层表 / 类别替换 / 材质物理属性 / 构件图层。
 * 已完整的文档返回同一个引用，避免无意义的重渲染与协作补丁。
 */
export function ensureDocumentLayers(project: ProjectDocument): ProjectDocument {
  const layers = Array.isArray(project.layers) && project.layers.length
    ? project.layers
    : defaultLayers();
  const overrides = project.categoryOverrides ?? defaultCategoryOverrides();
  let changed = layers !== project.layers || overrides !== project.categoryOverrides;

  const elements = project.elements.map((element) => {
    if (element.layerId && layers.some((layer) => layer.id === element.layerId)) return element;
    changed = true;
    return { ...element, layerId: layerIdForCategory(element.category) };
  });
  if (changed) return { ...project, layers, categoryOverrides: overrides, elements };
  return project;
}

/** 缺省材质属性补齐（供 UI / 渲染统一读取，不写回文档）。 */
export function normalizeMaterial(material: Material): Required<Pick<Material, 'opacity' | 'roughness' | 'metalness'>> & Material {
  return {
    ...material,
    opacity: clamp01to100(material.opacity ?? 100),
    roughness: clampUnit(material.roughness ?? DEFAULT_ROUGHNESS),
    metalness: clampUnit(material.metalness ?? DEFAULT_METALNESS),
  };
}

function clampUnit(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function clamp01to100(value: number): number {
  return Math.min(100, Math.max(0, value));
}

export function layerById(project: ProjectDocument, id: Id | undefined): Layer | undefined {
  return project.layers?.find((layer) => layer.id === id);
}

export function layerOfElement(project: ProjectDocument, element: BimElement): Layer | undefined {
  return layerById(project, element.layerId)
    ?? layerById(project, layerIdForCategory(element.category))
    ?? project.layers?.[0];
}

export function categoryOverrideOf(project: ProjectDocument, category: ElementCategory): CategoryOverride {
  return project.categoryOverrides?.[category] ?? { visible: true };
}

/** 三者同时满足才在视口中显示。 */
export function isElementVisible(project: ProjectDocument, element: BimElement): boolean {
  if (!element.visible) return false;
  const layer = layerOfElement(project, element);
  if (layer && !layer.visible) return false;
  return categoryOverrideOf(project, element.category).visible !== false;
}

/** 构件 Pin 或所在图层锁定都视为不可编辑。 */
export function isElementLocked(project: ProjectDocument, element: BimElement): boolean {
  return Boolean(element.pinned) || Boolean(layerOfElement(project, element)?.locked);
}

/** 图元材质覆盖优先，其次类型材质；mesh 无材质时返回 undefined。 */
export function materialOfElement(project: ProjectDocument, element: BimElement): Material | undefined {
  const explicit = element.materialId
    ? project.materials.find((material) => material.id === element.materialId)
    : undefined;
  if (explicit) return explicit;
  if (element.category === 'mesh') return undefined;
  const type = project.types.find((item) => item.id === element.typeId);
  const typeMaterialId = type && 'materialId' in type ? type.materialId : undefined;
  return project.materials.find((material) => material.id === typeMaterialId);
}

export interface SurfaceStyle {
  color: string;
  /** 0–1，1 为不透明 */
  opacity: number;
  roughness: number;
  metalness: number;
  transparent: boolean;
}

/**
 * 颜色被「图形替换」锁定的颜色（图层颜色替换 / 类别替换）。
 * 造型实体逐零件材质着色时，这里返回了颜色就说明用户在用图层/类别控制显示，
 * 零件的自定义颜色要让位，否则图层着色功能对特征实体失效。
 */
export function colorLockOf(project: ProjectDocument, element: BimElement): string | null {
  const layer = layerOfElement(project, element);
  if (layer?.colorOverride) return layer.color;
  return categoryOverrideOf(project, element.category).color ?? null;
}

/** 视口渲染用的最终表面样式（颜色替换 + 透明度叠加）。 */
export function effectiveSurface(project: ProjectDocument, element: BimElement): SurfaceStyle {
  const material = materialOfElement(project, element);
  const layer = layerOfElement(project, element);
  const category = categoryOverrideOf(project, element.category);
  const meshColor = element.category === 'mesh' ? element.color : FALLBACK_COLOR;
  const color = colorLockOf(project, element)
    ?? material?.color
    ?? meshColor;
  const surface = material ? normalizeMaterial(material) : null;
  const layerFactor = 1 - clamp01to100(layer?.transparency ?? 0) / 100;
  const categoryFactor = 1 - clamp01to100(category.transparency ?? 0) / 100;
  const opacity = clampUnit((surface?.opacity ?? 100) / 100 * layerFactor * categoryFactor);
  return {
    color,
    opacity,
    roughness: surface?.roughness ?? DEFAULT_ROUGHNESS,
    metalness: surface?.metalness ?? DEFAULT_METALNESS,
    transparent: opacity < 0.999,
  };
}

export function effectiveColor(project: ProjectDocument, element: BimElement): string {
  return effectiveSurface(project, element).color;
}

/* ------------------------------ 图层操作 ------------------------------ */

export function layerUsage(project: ProjectDocument): Record<Id, number> {
  const counts: Record<Id, number> = {};
  for (const element of project.elements) {
    const id = layerOfElement(project, element)?.id ?? DEFAULT_LAYER_ID;
    counts[id] = (counts[id] ?? 0) + 1;
  }
  return counts;
}

export function updateLayer(project: ProjectDocument, id: Id, patch: Partial<Omit<Layer, 'id'>>): ProjectDocument {
  if (!project.layers?.some((layer) => layer.id === id)) return project;
  return {
    ...project,
    layers: project.layers.map((layer) => (layer.id === id ? { ...layer, ...patch } : layer)),
  };
}

export function addLayer(project: ProjectDocument, name?: string): ProjectDocument {
  const base = ensureDocumentLayers(project);
  const used = new Set(base.layers?.map((layer) => layer.name));
  let index = base.layers?.length ?? 1;
  while (used.has(name || `新建图层 ${index}`)) index += 1;
  const layer: Layer = {
    id: createId(),
    name: name?.trim() || `新建图层 ${index}`,
    color: '#69c0ff',
    visible: true,
    locked: false,
    colorOverride: false,
    transparency: 0,
  };
  return { ...base, layers: [...(base.layers ?? []), layer] };
}

/** 删除图层：0 号默认图层不可删；构件自动回到 0 号图层。 */
export function deleteLayer(project: ProjectDocument, id: Id): ProjectDocument {
  if (id === DEFAULT_LAYER_ID || !project.layers?.some((layer) => layer.id === id)) return project;
  return {
    ...project,
    layers: project.layers.filter((layer) => layer.id !== id),
    elements: project.elements.map((element) => (
      element.layerId === id ? { ...element, layerId: DEFAULT_LAYER_ID } : element
    )),
  };
}

export function assignLayer(project: ProjectDocument, ids: string[], layerId: Id): ProjectDocument {
  if (!project.layers?.some((layer) => layer.id === layerId)) return project;
  const targets = new Set(ids);
  return {
    ...project,
    elements: project.elements.map((element) => (
      targets.has(element.id) ? { ...element, layerId } : element
    )),
  };
}

export function setAllLayersVisible(project: ProjectDocument, visible: boolean): ProjectDocument {
  const base = ensureDocumentLayers(project);
  return { ...base, layers: (base.layers ?? []).map((layer) => ({ ...layer, visible })) };
}

export function setCategoryOverride(
  project: ProjectDocument,
  category: ElementCategory,
  patch: Partial<CategoryOverride>,
): ProjectDocument {
  const current = project.categoryOverrides ?? defaultCategoryOverrides();
  return {
    ...project,
    categoryOverrides: {
      ...current,
      [category]: { ...(current[category] ?? { visible: true }), ...patch },
    },
  };
}

/* ------------------------------ 材质操作 ------------------------------ */

/** 统计材质被多少「类型 + 图元覆盖」引用。 */
export function materialUsage(project: ProjectDocument): Record<Id, number> {
  const counts: Record<Id, number> = {};
  const bump = (id: Id | undefined) => {
    if (id) counts[id] = (counts[id] ?? 0) + 1;
  };
  for (const type of project.types) {
    if ('materialId' in type) bump(type.materialId);
  }
  for (const element of project.elements) bump(element.materialId);
  return counts;
}

export function addMaterial(project: ProjectDocument, spec: Partial<Material> = {}): ProjectDocument {
  const used = new Set(project.materials.map((material) => material.name));
  let index = project.materials.length + 1;
  while (used.has(`新建材质 ${index}`)) index += 1;
  const material: Material = {
    id: createId(),
    name: spec.name?.trim() || `新建材质 ${index}`,
    color: spec.color ?? '#a3adb8',
    opacity: clamp01to100(spec.opacity ?? 100),
    roughness: clampUnit(spec.roughness ?? DEFAULT_ROUGHNESS),
    metalness: clampUnit(spec.metalness ?? DEFAULT_METALNESS),
    description: spec.description ?? '',
  };
  return { ...project, materials: [...project.materials, material] };
}

export function duplicateMaterial(project: ProjectDocument, id: Id): ProjectDocument {
  const source = project.materials.find((material) => material.id === id);
  if (!source) return project;
  return addMaterial(project, { ...source, name: `${source.name} 副本` });
}

export function updateMaterial(project: ProjectDocument, id: Id, patch: Partial<Omit<Material, 'id'>>): ProjectDocument {
  if (!project.materials.some((material) => material.id === id)) return project;
  const normalized: Partial<Material> = { ...patch };
  if (patch.opacity !== undefined) normalized.opacity = clamp01to100(patch.opacity);
  if (patch.roughness !== undefined) normalized.roughness = clampUnit(patch.roughness);
  if (patch.metalness !== undefined) normalized.metalness = clampUnit(patch.metalness);
  return {
    ...project,
    materials: project.materials.map((material) => (
      material.id === id ? { ...material, ...normalized } : material
    )),
  };
}

/**
 * 删除材质：引用它的类型与图元统一改指到第一个剩余材质（无剩余则清空引用）。
 * 与 Revit 一致，删除前由 UI 提示引用数量，但内核保证删除后不会留下悬空 id。
 */
export function deleteMaterial(project: ProjectDocument, id: Id): ProjectDocument {
  const rest = project.materials.filter((material) => material.id !== id);
  // 至少保留一种材质，避免出现没有任何材质的项目（UI 也会禁用最后一个删除按钮）
  if (rest.length === project.materials.length || rest.length === 0) return project;
  const fallback = rest[0]!.id;
  return {
    ...project,
    materials: rest,
    types: project.types.map((type) => (
      'materialId' in type && type.materialId === id ? { ...type, materialId: fallback } : type
    )) as ProjectDocument['types'],
    elements: project.elements.map((element) => (
      element.materialId === id ? { ...element, materialId: fallback } : element
    )),
  };
}

/** 按图元覆盖材质（Revit「材质涂刷」）；mesh 同时同步自身颜色以便 IFC/OBJ 一致。 */
export function assignMaterial(project: ProjectDocument, ids: string[], materialId: Id): ProjectDocument {
  const material = project.materials.find((item) => item.id === materialId);
  if (!material) return project;
  const targets = new Set(ids);
  return {
    ...project,
    elements: project.elements.map((element) => {
      if (!targets.has(element.id)) return element;
      return element.category === 'mesh'
        ? { ...element, materialId, color: material.color }
        : { ...element, materialId };
    }),
  };
}

/** 清除图元级材质覆盖，恢复为类型材质。 */
export function clearMaterialOverride(project: ProjectDocument, ids: string[]): ProjectDocument {
  const targets = new Set(ids);
  return {
    ...project,
    elements: project.elements.map((element) => (
      targets.has(element.id) ? { ...element, materialId: undefined } : element
    )),
  };
}

export function assignMaterialToType(project: ProjectDocument, typeId: Id, materialId: Id): ProjectDocument {
  if (!project.materials.some((material) => material.id === materialId)) return project;
  return {
    ...project,
    types: project.types.map((type) => (
      type.id === typeId && 'materialId' in type ? { ...type, materialId } : type
    )) as ProjectDocument['types'],
  };
}

/** 图层/材质视图配置只导出为项目内数据，供外部 JSON 调试与测试。 */
export function appearanceSummary(project: ProjectDocument): {
  layers: number;
  hiddenLayers: number;
  lockedLayers: number;
  materials: number;
  overriddenElements: number;
} {
  const base = ensureDocumentLayers(project);
  const layers = base.layers ?? [];
  return {
    layers: layers.length,
    hiddenLayers: layers.filter((layer) => !layer.visible).length,
    lockedLayers: layers.filter((layer) => layer.locked).length,
    materials: base.materials.length,
    overriddenElements: base.elements.filter((element) => Boolean(element.materialId)).length,
  };
}
