/**
 * BIM 语义内核数据模型（文档 schema v2）。
 *
 * 与 v1 的区别：构件不再是“顶点 + 索引”的网格，而是“类型 + 参数 + 约束”的族实例，
 * 几何由 buildElementGeometry 按参数实时生成。导入的 STEP/OBJ 仍以 mesh 形式保存，
 * 与参数化构件并存。
 *
 * 坐标约定：世界坐标 Z-up，单位米；标高 elevation 即世界 Z 值。
 */

export type Id = string;
export type Vec2 = [number, number];

/** 标高。同名标高在建 BIM 项目里是构件竖向定位的基准。 */
export interface Level {
  id: Id;
  name: string;
  /** 世界 Z 值，单位米 */
  elevation: number;
}

/** 轴网。平面内的一条线，用于定位构件。 */
export interface Grid {
  id: Id;
  name: string;
  start: Vec2;
  end: Vec2;
}

export interface Material {
  id: Id;
  name: string;
  color: string;
}

export interface WallType {
  id: Id;
  category: 'wall';
  name: string;
  thickness: number;
  materialId: Id;
}

export interface ColumnType {
  id: Id;
  category: 'column';
  name: string;
  width: number;
  depth: number;
  materialId: Id;
}

export interface SlabType {
  id: Id;
  category: 'slab';
  name: string;
  thickness: number;
  materialId: Id;
}

/** 族类型（Revit 的 Type）。同一类型的实例共享尺寸参数。 */
export type FamilyType = WallType | ColumnType | SlabType;

export interface ElementBase {
  id: Id;
  name: string;
  /** 底部约束：所在标高 */
  levelId: Id;
  /** 类型引用；mesh 构件为空字符串 */
  typeId: Id;
  visible: boolean;
}

export interface WallInstance extends ElementBase {
  category: 'wall';
  start: Vec2;
  end: Vec2;
  /** 相对底部标高的偏移，米 */
  baseOffset: number;
  /** 顶部约束：顶部标高 + 偏移 */
  topLevelId: Id;
  topOffset: number;
}

export interface ColumnInstance extends ElementBase {
  category: 'column';
  position: Vec2;
  /** 绕 Z 轴转角，弧度 */
  rotation: number;
  baseOffset: number;
  topLevelId: Id;
  topOffset: number;
}

export interface SlabInstance extends ElementBase {
  category: 'slab';
  /** 轮廓（平面坐标，逆时针或顺时针均可），厚度取自类型 */
  points: Vec2[];
  baseOffset: number;
}

/** 未参数化的导入几何（STEP/OBJ/布尔结果）。 */
export interface MeshInstance extends ElementBase {
  category: 'mesh';
  positions: number[];
  indices: number[];
  vertexColors?: number[];
  color: string;
  /** 来源描述，例如 “STEP 导入” */
  source: string;
  /** 整体平移量（米），避免移动大网格时重写全部顶点 */
  offset?: [number, number, number];
  /** 绕 Z 轴的整体旋转（弧度），先旋转再平移 */
  rotation?: number;
}

export type BimElement = WallInstance | ColumnInstance | SlabInstance | MeshInstance;

export type ElementCategory = BimElement['category'];

export interface ProjectDocument {
  schemaVersion: 2;
  id: string;
  name: string;
  updatedAt: string;
  units: 'metric';
  levels: Level[];
  grids: Grid[];
  materials: Material[];
  types: FamilyType[];
  elements: BimElement[];
}

export const categoryLabels: Record<ElementCategory, string> = {
  wall: '墙',
  column: '柱',
  slab: '楼板',
  mesh: '导入几何',
};
