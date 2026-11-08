/**
 * 参数化基本体（Revit 的「内建体量 / 拉伸 / 旋转」简化实现）。
 *
 * 几何不落盘：MeshInstance.primitive 保存参数，buildElementGeometry 按参数实时生成，
 * 因此改尺寸不必重写顶点数组，也能和导入网格共用平移 / 旋转 / 缩放 / 镜像变换。
 */
import {
  BoxGeometry,
  BufferGeometry,
  CylinderGeometry,
  ExtrudeGeometry,
  LatheGeometry,
  PlaneGeometry,
  Shape,
  SphereGeometry,
  Vector2,
} from 'three';
import { createId } from './id';
import { buildSolidModel, createSolidFeature } from './solid';
import type { MeshInstance, PrimitiveSpec, ProjectDocument, SolidMaterial, Vec2 } from './types';

export type PrimitiveKind = PrimitiveSpec['kind'];

export const PRIMITIVE_LABELS: Record<PrimitiveKind, string> = {
  box: '长方体',
  cylinder: '圆柱体',
  sphere: '球体',
  extrude: '拉伸体',
  revolve: '旋转体',
  pyramid: '棱锥体',
  decal: '贴花',
  solid: '特征实体',
};

export const PRIMITIVE_COLORS: Record<PrimitiveKind, string> = {
  box: '#9db8d6',
  cylinder: '#c4a7de',
  sphere: '#e0b57e',
  extrude: '#7fc9b0',
  revolve: '#de9bb0',
  pyramid: '#9fb7e0',
  decal: '#1c3f74',
  solid: '#8fb9e8',
};

/** 默认参数：视口里点一下就能生成可继续编辑的体量。 */
export function defaultPrimitive(kind: PrimitiveKind, radius = 1, height = 2): PrimitiveSpec {
  switch (kind) {
    case 'box': return { kind, width: radius * 2, depth: radius * 2, height };
    case 'cylinder': return { kind, radius, height, segments: 32 };
    case 'sphere': return { kind, radius, segments: 24 };
    case 'extrude': {
      const r = radius;
      return {
        kind,
        profile: [[-r, -r], [r, -r], [r, r], [-r, r]] as Vec2[],
        height,
      };
    }
    case 'revolve': return {
      kind,
      // 母线：(半径, 高度)，绕 Z 轴旋转一周；带一点收腰，区别于普通圆柱
      profile: [[0, 0], [radius, 0], [radius * 0.92, height * 0.3], [radius * 0.55, height * 0.72], [radius * 0.28, height], [0, height]] as Vec2[],
      segments: 32,
    };
    case 'pyramid': return { kind, radius, height, sides: 4 };
    case 'decal': return { kind, width: radius * 4, height, normal: 'z', text: '样例文字', color: '#1c3f74' };
    case 'solid': return {
      kind,
      features: [createSolidFeature({ shape: 'box', width: radius * 2, depth: radius * 2, height }, { label: '基体' })],
    };
  }
}

/** 按参数生成几何（局部坐标：XY 居中、底面 z=0，Z-up，单位米）。 */
export function buildPrimitiveGeometry(spec: PrimitiveSpec): BufferGeometry {
  const clamp = (value: number, min: number, fallback: number) => (Number.isFinite(value) ? Math.max(min, value) : fallback);
  switch (spec.kind) {
    case 'box': {
      const width = clamp(spec.width, 0.01, 2);
      const depth = clamp(spec.depth, 0.01, 2);
      const height = clamp(spec.height, 0.01, 2);
      return new BoxGeometry(width, depth, height).translate(0, 0, height / 2);
    }
    case 'cylinder': {
      const radius = clamp(spec.radius, 0.01, 1);
      const height = clamp(spec.height, 0.01, 2);
      const segments = Math.round(clamp(spec.segments, 3, 32));
      return new CylinderGeometry(radius, radius, height, segments, 1, false)
        .rotateX(Math.PI / 2)
        .translate(0, 0, height / 2);
    }
    case 'sphere': {
      const radius = clamp(spec.radius, 0.01, 1);
      const segments = Math.round(clamp(spec.segments, 6, 24));
      return new SphereGeometry(radius, segments, Math.max(6, Math.round(segments / 2)))
        .translate(0, 0, radius);
    }
    case 'pyramid': {
      const radius = clamp(spec.radius, 0.01, 1);
      const height = clamp(spec.height, 0.01, 2);
      const sides = Math.round(clamp(spec.sides, 3, 4));
      return new CylinderGeometry(0, radius, height, sides, 1, false)
        .rotateX(Math.PI / 2)
        .translate(0, 0, height / 2);
    }
    case 'extrude': {
      const points = spec.profile.length >= 3 ? spec.profile : (defaultPrimitive('extrude') as Extract<PrimitiveSpec, { kind: 'extrude' }>).profile;
      const shape = new Shape();
      points.forEach(([x, y], index) => (index === 0 ? shape.moveTo(x, y) : shape.lineTo(x, y)));
      shape.closePath();
      const height = clamp(spec.height, 0.01, 2);
      return new ExtrudeGeometry(shape, { depth: height, bevelEnabled: false, curveSegments: 1 });
    }
    case 'revolve': {
      const segments = Math.round(clamp(spec.segments, 6, 32));
      const points = spec.profile.length >= 2 ? spec.profile : (defaultPrimitive('revolve') as Extract<PrimitiveSpec, { kind: 'revolve' }>).profile;
      const vectorPoints = points
        .filter((point) => Number.isFinite(point[0]) && Number.isFinite(point[1]))
        .map(([radius, height]) => new Vector2(Math.max(0, radius), height));
      const safe = vectorPoints.length >= 2 ? vectorPoints : [new Vector2(0, 0), new Vector2(1, 0), new Vector2(1, 2)];
      // LatheGeometry 绕 Y 轴旋转，转到 Z-up（Y → Z）
      return new LatheGeometry(safe, segments).rotateX(Math.PI / 2);
    }
    case 'decal': {
      // 贴花：一块带 UV 的矩形，按 normal 转到目标朝向（PlaneGeometry 默认朝 +Z）
      const width = clamp(spec.width, 0.02, 4);
      const height = clamp(spec.height, 0.02, 2);
      const plane = new PlaneGeometry(width, height);
      // 贴花默认朝 +Z、文字沿 +x。转到目标面时还要保证「从外侧看，字是正的」：
      // 站在 +Y 侧看，+X 在屏幕左侧，所以朝 +Y 的那张要把字翻到 -X 方向，否则是镜像字。
      switch (spec.normal ?? 'z') {
        case 'y': plane.rotateX(Math.PI / 2).rotateZ(Math.PI); break;
        case '-y': plane.rotateX(Math.PI / 2); break;
        case '-z': plane.rotateX(Math.PI).rotateZ(Math.PI); break;
        case 'x': plane.rotateX(Math.PI / 2).rotateZ(Math.PI / 2); break;
        case '-x': plane.rotateX(Math.PI / 2).rotateZ(-Math.PI / 2); break;
        default: break;
      }
      return plane;
    }
    case 'solid':
      // 特征造型：按特征树求 CSG 结果（局部坐标，z=0 为标高平面）
      return buildSolidModel(spec.features).geometry;
  }
}

/** 几何 + 逐特征材质（null = 跟随构件材质）；非特征实体的材质表为空 */
export interface PrimitiveModel {
  geometry: BufferGeometry;
  materials: Array<SolidMaterial | null>;
}

export function buildPrimitiveModel(spec: PrimitiveSpec): PrimitiveModel {
  if (spec.kind === 'solid') return buildSolidModel(spec.features);
  return { geometry: buildPrimitiveGeometry(spec), materials: [] };
}

export function primitiveTriangles(spec: PrimitiveSpec): number {
  const geometry = buildPrimitiveGeometry(spec);
  const count = Math.floor((geometry.index?.count ?? geometry.getAttribute('position').count) / 3);
  geometry.dispose();
  return count;
}

export interface PrimitiveField {
  key: string;
  label: string;
  value: number;
  min: number;
  step: number;
  unit: string;
}

/** 属性面板可编辑的参数（轮廓点暂用属性面板只读展示，可通过重新创建修改）。 */
export function primitiveFields(spec: PrimitiveSpec): PrimitiveField[] {
  const field = (key: string, label: string, value: number, min = 0.01, step = 0.1, unit = 'm'): PrimitiveField => ({ key, label, value, min, step, unit });
  switch (spec.kind) {
    case 'box': return [field('width', '宽度 X', spec.width), field('depth', '深度 Y', spec.depth), field('height', '高度', spec.height)];
    case 'cylinder': return [field('radius', '半径', spec.radius), field('height', '高度', spec.height), field('segments', '分段数', spec.segments, 3, 1, '')];
    case 'sphere': return [field('radius', '半径', spec.radius), field('segments', '分段数', spec.segments, 6, 1, '')];
    case 'extrude': return [field('height', '拉伸高度', spec.height)];
    case 'revolve': return [field('segments', '旋转分段', spec.segments, 6, 1, '')];
    case 'pyramid': return [field('radius', '底面半径', spec.radius), field('height', '高度', spec.height), field('sides', '边数', spec.sides, 3, 1, '')];
    case 'decal': return [field('width', '宽度', spec.width), field('height', '高度', spec.height)];
    // 特征实体走「任意造型」对话框编辑特征树，属性面板只展示概要
    case 'solid': return [];
  }
}

export function updatePrimitiveField(spec: PrimitiveSpec, key: string, value: number): PrimitiveSpec {
  if (!Number.isFinite(value)) return spec;
  const next = { ...spec } as unknown as Record<string, unknown>;
  if (!(key in next)) return spec;
  const min = key === 'segments' || key === 'sides' ? 3 : 0.01;
  const integer = key === 'segments' || key === 'sides';
  next[key] = integer ? Math.max(3, Math.round(value)) : Math.max(min, value);
  return next as unknown as PrimitiveSpec;
}

/** 生成一个参数化基本体构件；position 为世界平面坐标（写入 offset）。 */
export function createPrimitiveElement(options: {
  project: ProjectDocument;
  kind: PrimitiveKind;
  position: Vec2;
  levelId: string;
  spec?: PrimitiveSpec;
  profile?: Vec2[];
}): MeshInstance {
  const { project, kind, position, levelId } = options;
  const spec = options.spec ?? defaultPrimitive(kind);
  const used = new Set(project.elements.map((element) => element.name));
  let index = 1;
  while (used.has(`${PRIMITIVE_LABELS[kind]} ${index}`)) index += 1;
  return {
    id: createId(),
    name: `${PRIMITIVE_LABELS[kind]} ${index}`,
    category: 'mesh',
    levelId,
    typeId: '',
    visible: true,
    positions: [],
    indices: [],
    color: PRIMITIVE_COLORS[kind],
    source: `${PRIMITIVE_LABELS[kind]}（参数化）`,
    offset: [position[0], position[1], 0],
    primitive: options.profile ? ({ ...spec, profile: options.profile } as PrimitiveSpec) : spec,
  };
}
