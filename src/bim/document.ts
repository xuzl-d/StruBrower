import { createProject } from './template';
import type {
  BimElement,
  ColumnInstance,
  ColumnType,
  FamilyType,
  Level,
  MeshInstance,
  ProjectDocument,
  SlabInstance,
  SlabType,
  WallInstance,
  WallType,
} from './types';

export function levelById(project: ProjectDocument, id: string | undefined): Level | undefined {
  return project.levels.find((level) => level.id === id);
}

export function typeById(project: ProjectDocument, id: string | undefined): FamilyType | undefined {
  return project.types.find((type) => type.id === id);
}

export function wallTypeOf(project: ProjectDocument, wall: WallInstance): WallType | undefined {
  const type = typeById(project, wall.typeId);
  return type?.category === 'wall' ? type : undefined;
}

export function columnTypeOf(project: ProjectDocument, column: ColumnInstance): ColumnType | undefined {
  const type = typeById(project, column.typeId);
  return type?.category === 'column' ? type : undefined;
}

export function slabTypeOf(project: ProjectDocument, slab: SlabInstance): SlabType | undefined {
  const type = typeById(project, slab.typeId);
  return type?.category === 'slab' ? type : undefined;
}

/** 构件底部世界 Z 值。 */
export function baseElevation(project: ProjectDocument, element: BimElement): number {
  const level = levelById(project, element.levelId);
  const offset = 'baseOffset' in element ? element.baseOffset : 0;
  return (level?.elevation ?? 0) + offset;
}

/** 构件顶部世界 Z 值；楼板为板顶。 */
export function topElevation(project: ProjectDocument, element: BimElement): number {
  if (element.category === 'slab') {
    const type = slabTypeOf(project, element);
    return baseElevation(project, element) + (type?.thickness ?? 0.15);
  }
  if (element.category === 'mesh') return baseElevation(project, element);
  const topLevel = levelById(project, element.topLevelId);
  return (topLevel?.elevation ?? 0) + element.topOffset;
}

export function elementHeight(project: ProjectDocument, element: BimElement): number {
  return Math.max(0, topElevation(project, element) - baseElevation(project, element));
}

export function wallLength(wall: WallInstance): number {
  return Math.hypot(wall.end[0] - wall.start[0], wall.end[1] - wall.start[1]);
}

export function polygonArea(points: Array<[number, number]>): number {
  let sum = 0;
  for (let index = 0; index < points.length; index += 1) {
    const [x1, y1] = points[index]!;
    const [x2, y2] = points[(index + 1) % points.length]!;
    sum += x1 * y2 - x2 * y1;
  }
  return Math.abs(sum) / 2;
}

/** 构件材质颜色；参数化构件取类型材质，导入几何取自身颜色。 */
export function elementColor(project: ProjectDocument, element: BimElement): string {
  if (element.category === 'mesh') return element.color;
  const type = typeById(project, element.typeId);
  const materialId = type && 'materialId' in type ? type.materialId : undefined;
  const material = project.materials.find((item) => item.id === materialId);
  return material?.color ?? '#a3adb8';
}

export interface MeasureRow {
  label: string;
  value: string;
}

/** 派生尺寸（只读），供属性面板展示。 */
export function elementMeasures(project: ProjectDocument, element: BimElement): MeasureRow[] {
  if (element.category === 'wall') {
    const type = wallTypeOf(project, element);
    return [
      { label: '长度', value: `${wallLength(element).toFixed(2)} m` },
      { label: '高度', value: `${elementHeight(project, element).toFixed(2)} m` },
      { label: '厚度', value: `${(type?.thickness ?? 0.2).toFixed(3)} m` },
    ];
  }
  if (element.category === 'column') {
    const type = columnTypeOf(project, element);
    return [
      { label: '高度', value: `${elementHeight(project, element).toFixed(2)} m` },
      { label: '截面', value: `${((type?.width ?? 0.4) * 1000).toFixed(0)} × ${((type?.depth ?? 0.4) * 1000).toFixed(0)} mm` },
    ];
  }
  if (element.category === 'slab') {
    const type = slabTypeOf(project, element);
    return [
      { label: '面积', value: `${polygonArea(element.points).toFixed(2)} m²` },
      { label: '厚度', value: `${(type?.thickness ?? 0.15).toFixed(3)} m` },
    ];
  }
  return [
    { label: '顶点', value: element.positions.length / 3 > 0 ? String(element.positions.length / 3) : '0' },
    { label: '三角面', value: String(Math.floor(element.indices.length / 3)) },
  ];
}

export function countTriangles(project: ProjectDocument): number {
  return project.elements.reduce((sum, element) => {
    if (!element.visible) return sum;
    if (element.category === 'mesh') return sum + Math.floor(element.indices.length / 3);
    // 参数化构件按几何外形估算三角面：长方体 12 面、拉伸体按轮廓边数
    if (element.category === 'wall' || element.category === 'column') return sum + 12;
    return sum + Math.max(12, element.points.length * 2);
  }, 0);
}

/* ------------------------------ 迁移 ------------------------------ */

interface LegacyElement {
  id: string;
  name: string;
  kind: string;
  positions: number[];
  indices: number[];
  vertexColors?: number[];
  color: string;
  visible: boolean;
  properties?: { category?: string; material?: string; level?: string };
}

interface LegacyDocument {
  id: string;
  name: string;
  updatedAt?: string;
  elements?: LegacyElement[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** v1 文档的几何以 Y-up 存储（旧视口用 group 旋转到 Z-up），迁移时转成 Z-up。 */
function yUpToZUp(positions: number[]): number[] {
  const rotated: number[] = [];
  for (let index = 0; index + 2 < positions.length; index += 3) {
    const x = positions[index]!;
    const y = positions[index + 1]!;
    const z = positions[index + 2]!;
    rotated.push(x, -z, y);
  }
  return rotated;
}

function toMeshElement(element: LegacyElement, levelId: string): MeshInstance {
  const positions = Array.isArray(element.positions) ? yUpToZUp(element.positions) : [];
  return {
    id: element.id,
    name: element.name || '导入几何',
    category: 'mesh',
    levelId,
    typeId: '',
    visible: element.visible !== false,
    positions,
    indices: Array.isArray(element.indices) ? element.indices : [],
    vertexColors: Array.isArray(element.vertexColors) ? element.vertexColors : undefined,
    color: element.color || '#a3adb8',
    source: 'v1 网格',
  };
}

/**
 * 把任意来源的文档规范化为 schema v2。
 * v1（网格原型）文档会被转换为一个含 “导入几何” 构件的等价项目。
 */
export function migrateDocument(raw: unknown): ProjectDocument {
  if (!isRecord(raw)) return createProject();
  if (raw.schemaVersion === 2 && Array.isArray(raw.levels) && Array.isArray(raw.types) && Array.isArray(raw.elements)) {
    const project = raw as unknown as ProjectDocument;
    return {
      ...project,
      grids: Array.isArray(project.grids) ? project.grids : [],
      materials: Array.isArray(project.materials) ? project.materials : [],
    };
  }
  const legacy = raw as unknown as LegacyDocument;
  const project = createProject({ name: typeof legacy.name === 'string' ? legacy.name : '未命名项目' });
  project.id = typeof legacy.id === 'string' ? legacy.id : project.id;
  project.updatedAt = legacy.updatedAt ?? project.updatedAt;
  const levelId = project.levels[0]!.id;
  project.elements = (legacy.elements ?? [])
    .filter((element) => element && Array.isArray(element.positions))
    .map((element) => toMeshElement(element, levelId));
  return project;
}

export interface ProjectSummary {
  id: string;
  name: string;
  updatedAt: string;
  elementCount: number;
  /** 服务端模式下的当前用户角色与文档 rev */
  role?: 'viewer' | 'editor' | 'admin';
  rev?: number;
}

export function summarize(project: ProjectDocument): ProjectSummary {
  return {
    id: project.id,
    name: project.name,
    updatedAt: project.updatedAt,
    elementCount: project.elements.length,
  };
}
