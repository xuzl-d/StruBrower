import { createId } from './id';
import { defaultCategoryOverrides, defaultLayers, layerIdForCategory } from './layers';
import { defaultParameters, defaultTypeFormulas } from './parameters';
import type { FamilyType, Material, ProjectDocument } from './types';

export interface ProjectTemplate {
  name: string;
  levels?: Array<{ name: string; elevation: number }>;
}

const MATERIALS: Material[] = [
  { id: 'mat-concrete', name: '混凝土 · C30', color: '#a3adb8', opacity: 100, roughness: 0.85, metalness: 0.02, description: '现浇混凝土，灰色哑光' },
  { id: 'mat-masonry', name: '砌体 · 加气块', color: '#c6bba8', opacity: 100, roughness: 0.9, metalness: 0.01, description: '砌块墙体' },
  { id: 'mat-steel', name: '钢材 · Q355', color: '#8b98a8', opacity: 100, roughness: 0.35, metalness: 0.75, description: '结构钢，半光泽金属' },
  { id: 'mat-glass', name: '玻璃 · 中空', color: '#9fd3e4', opacity: 35, roughness: 0.08, metalness: 0.05, description: '透明玻璃，用于幕墙与门窗' },
  { id: 'mat-wood', name: '木材 · 胶合木', color: '#c79a68', opacity: 100, roughness: 0.72, metalness: 0.01, description: '木纹饰面' },
];

function baseTypes(): FamilyType[] {
  const formulas = defaultTypeFormulas();
  return [
    { id: 'type-wall-200', category: 'wall', name: '基本墙 200mm', thickness: 0.2, materialId: 'mat-concrete', formulas: formulas['type-wall-200'] },
    { id: 'type-wall-100', category: 'wall', name: '内墙 100mm', thickness: 0.1, materialId: 'mat-masonry', formulas: formulas['type-wall-100'] },
    { id: 'type-column-400', category: 'column', name: '矩形柱 400×400', width: 0.4, depth: 0.4, materialId: 'mat-concrete', formulas: formulas['type-column-400'] },
    { id: 'type-slab-150', category: 'slab', name: '楼板 150mm', thickness: 0.15, materialId: 'mat-concrete', formulas: formulas['type-slab-150'] },
  ];
}

/** 新建项目：两个标高（0 / 3.0 m）、四种基础类型、五种材质。轴网由用户绘制。 */
export function createProject(template: ProjectTemplate = { name: '未命名项目' }): ProjectDocument {
  const levelSpecs = template.levels ?? [
    { name: '标高 1', elevation: 0 },
    { name: '标高 2', elevation: 3 },
  ];
  return {
    schemaVersion: 2,
    id: createId(),
    name: template.name,
    updatedAt: new Date().toISOString(),
    units: 'metric',
    levels: levelSpecs.map((level) => ({ id: createId(), name: level.name, elevation: level.elevation })),
    grids: [],
    materials: MATERIALS.map((material) => ({ ...material })),
    layers: defaultLayers(),
    categoryOverrides: defaultCategoryOverrides(),
    parameters: defaultParameters(),
    types: baseTypes(),
    elements: [],
  };
}

/** 构件自动命名：同类别按顺序递增，例如 墙 1、墙 2；轴网按 1、2、3… */
export function nextElementName(project: ProjectDocument, category: 'wall' | 'column' | 'slab' | 'grid'): string {
  if (category === 'grid') {
    const used = new Set(project.grids.map((grid) => grid.name));
    for (let index = 1; index < 100; index += 1) {
      const candidate = String(index);
      if (!used.has(candidate)) return candidate;
    }
    return String(project.grids.length + 1);
  }
  const prefix = category === 'wall' ? '墙' : category === 'column' ? '柱' : '楼板';
  const used = new Set(project.elements.map((element) => element.name));
  for (let index = 1; index <= 9999; index += 1) {
    const candidate = `${prefix} ${index}`;
    if (!used.has(candidate)) return candidate;
  }
  return `${prefix} ${Date.now()}`;
}

/** 首次启动的示例项目：6 × 4 m 房间、四个墙、四根柱、一块楼板、四条轴网。 */
export function createDemoProject(): ProjectDocument {
  const project = createProject({ name: '示例项目 · 建筑' });
  const [level1, level2] = project.levels;
  if (!level1 || !level2) return project;
  const wallType = project.types.find((type) => type.id === 'type-wall-200');
  const columnType = project.types.find((type) => type.id === 'type-column-400');
  const slabType = project.types.find((type) => type.id === 'type-slab-150');
  const walls = [
    { from: [0, 0], to: [6, 0] },
    { from: [6, 0], to: [6, 4] },
    { from: [6, 4], to: [0, 4] },
    { from: [0, 4], to: [0, 0] },
  ] as const;
  project.elements = [
    ...walls.map((wall, index) => ({
      id: `demo-wall-${index + 1}`,
      name: `墙 ${index + 1}`,
      category: 'wall' as const,
      typeId: wallType?.id ?? 'type-wall-200',
      levelId: level1.id,
      visible: true,
      start: [wall.from[0], wall.from[1]] as [number, number],
      end: [wall.to[0], wall.to[1]] as [number, number],
      baseOffset: 0,
      topLevelId: level2.id,
      topOffset: 0,
    })),
    ...[
      [0, 0],
      [6, 0],
      [6, 4],
      [0, 4],
    ].map((position, index) => ({
      id: `demo-column-${index + 1}`,
      name: `柱 ${index + 1}`,
      category: 'column' as const,
      typeId: columnType?.id ?? 'type-column-400',
      levelId: level1.id,
      visible: true,
      position: [position[0]!, position[1]!] as [number, number],
      rotation: 0,
      baseOffset: 0,
      topLevelId: level2.id,
      topOffset: 0,
    })),
    {
      id: 'demo-slab-1',
      name: '楼板 1',
      category: 'slab' as const,
      typeId: slabType?.id ?? 'type-slab-150',
      levelId: level1.id,
      visible: true,
      points: [[0, 0], [6, 0], [6, 4], [0, 4]] as Array<[number, number]>,
      baseOffset: -0.15,
    },
  ];
  project.grids = [
    { id: 'demo-grid-1', name: '1', start: [0, -2], end: [0, 6] },
    { id: 'demo-grid-2', name: '2', start: [6, -2], end: [6, 6] },
    { id: 'demo-grid-A', name: 'A', start: [-2, 0], end: [8, 0] },
    { id: 'demo-grid-B', name: 'B', start: [-2, 4], end: [8, 4] },
  ];
  project.elements = project.elements.map((element) => ({
    ...element,
    layerId: layerIdForCategory(element.category),
  }));
  return project;
}
