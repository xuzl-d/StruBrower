/**
 * 特征造型内核（SolidWorks 的「草图 + 特征 + 布尔 + 阵列」简化实现）。
 *
 * 文档只保存**特征树**（SolidFeature[]），几何在渲染时按特征实时求值：
 * 形状 → 变换 → 阵列 → 与已有实体布尔（add 合并 / cut 切除 / intersect 相交）。
 * 因此改尺寸、改阵列数量、改切除位置都不用重写顶点，也不会让文档膨胀。
 *
 * 坐标约定：特征局部坐标，单位米，Z-up；XY 以原点为中心（z 也居中），
 * 由 translate 摆放；整份实体再按构件 offset 落到世界坐标、按标高抬升。
 */
import {
  Box3,
  BoxGeometry,
  BufferGeometry,
  CylinderGeometry,
  Float32BufferAttribute,
  LatheGeometry,
  Matrix3,
  Matrix4,
  ShapeUtils,
  SphereGeometry,
  TorusGeometry,
  Vector2,
  Vector3,
} from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { ConvexGeometry } from 'three/examples/jsm/geometries/ConvexGeometry.js';
import { ADDITION, Brush, Evaluator, INTERSECTION, SUBTRACTION } from 'three-bvh-csg';
import { resolveSolidMaterial, solidMaterialKey } from '../../shared/materials.js';
import type { LoftSection, RoofAttachment, SolidFeature, SolidMaterial, SolidPattern, SolidShape, Vec2, Vec3 } from './types';

/** 安全上限：防止 AI 生成过大的模型把浏览器卡死 */
export const SOLID_LIMITS = {
  features: 96,
  nestedFeatures: 48,
  segments: 64,
  points: 192,
  hullPoints: 64,
  // 线性 / 圆周阵列的单特征实例上限。原先 64，导致一排 90 个舷窗要拆成 4 个特征；
  // 提高到 192 之后一整排就能写完（多出来的实例只增加几何，特征数不变）。
  patternCount: 192,
  bodies: 420,
} as const;

const MIN_SIZE = 0.001;

function finite(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function segments(value: unknown, fallback = 32): number {
  return clamp(Math.round(finite(value, fallback)), 6, SOLID_LIMITS.segments);
}

function vec3(value: Vec3 | undefined): Vec3 {
  if (!value) return [0, 0, 0];
  return [finite(value[0], 0), finite(value[1], 0), finite(value[2], 0)];
}

/** 只保留 position / normal 并转成非索引：合并与 CSG 都要求属性一致 */
function normalizeSolid(geometry: BufferGeometry): BufferGeometry {
  const flat = geometry.index ? geometry.toNonIndexed() : geometry;
  if (flat !== geometry) geometry.dispose();
  for (const name of Object.keys(flat.attributes)) {
    if (name !== 'position' && name !== 'normal') flat.deleteAttribute(name);
  }
  // BoxGeometry 之类的内置几何自带 6 个 group（指向 6 个材质槽），
  // 混合进我们的材质分组里会指到不存在的材质上，统一清掉，分组放到最后统一重建。
  flat.clearGroups();
  if (!flat.getAttribute('normal')) flat.computeVertexNormals();
  return flat;
}

function isBlank(geometry: BufferGeometry | null): boolean {
  return !geometry || !geometry.getAttribute('position') || geometry.getAttribute('position').count === 0;
}

/* ---------- 轮廓工具 ---------- */

function cleanProfile(profile: Vec2[] | undefined, fallback: Vec2[]): Vec2[] {
  const points = Array.isArray(profile)
    ? profile
      .filter((point) => Array.isArray(point) && point.length >= 2)
      .map((point) => [finite(point[0], 0), finite(point[1], 0)] as Vec2)
      .slice(0, SOLID_LIMITS.points)
    : [];
  const cleaned: Vec2[] = [];
  for (const point of points) {
    const last = cleaned[cleaned.length - 1];
    if (!last || Math.hypot(point[0] - last[0], point[1] - last[1]) > 1e-6) cleaned.push(point);
  }
  if (cleaned.length > 1) {
    const first = cleaned[0];
    const last = cleaned[cleaned.length - 1];
    if (Math.hypot(first[0] - last[0], first[1] - last[1]) <= 1e-6) cleaned.pop();
  }
  return cleaned.length >= 3 ? cleaned : fallback;
}

function signedArea(points: Vec2[]): number {
  let area = 0;
  for (let index = 0; index < points.length; index += 1) {
    const a = points[index];
    const b = points[(index + 1) % points.length];
    area += a[0] * b[1] - b[0] * a[1];
  }
  return area / 2;
}

/** 统一成逆时针，保证侧面法线朝外 */
function toCounterClockwise(points: Vec2[]): Vec2[] {
  return signedArea(points) < 0 ? [...points].reverse() : points;
}

/** 按周长等分重采样，用于放样时截面点数不一致的情况 */
function resamplePolygon(points: Vec2[], count: number): Vec2[] {
  const source = toCounterClockwise(points);
  const lengths: number[] = [];
  let total = 0;
  for (let index = 0; index < source.length; index += 1) {
    const a = source[index];
    const b = source[(index + 1) % source.length];
    const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
    lengths.push(length);
    total += length;
  }
  if (total < 1e-9) return Array.from({ length: count }, () => [source[0][0], source[0][1]] as Vec2);
  const result: Vec2[] = [];
  let segment = 0;
  let walked = 0;
  for (let index = 0; index < count; index += 1) {
    const target = (total * index) / count;
    while (segment < lengths.length - 1 && walked + lengths[segment] < target) {
      walked += lengths[segment];
      segment += 1;
    }
    const a = source[segment];
    const b = source[(segment + 1) % source.length];
    const ratio = lengths[segment] < 1e-9 ? 0 : (target - walked) / lengths[segment];
    result.push([a[0] + (b[0] - a[0]) * ratio, a[1] + (b[1] - a[1]) * ratio]);
  }
  return result;
}

function triangulate(points: Vec2[]): number[] {
  try {
    const contour = points.map(([x, y]) => new Vector2(x, y));
    return ShapeUtils.triangulateShape(contour, []).flat();
  } catch {
    // 退化轮廓退化成扇形
    const fan: number[] = [];
    for (let index = 1; index + 1 < points.length; index += 1) fan.push(0, index, index + 1);
    return fan;
  }
}

/**
 * 把若干同点数的环（自下而上）缝成实体：侧面四边形 + 上下封盖。
 * rings 的 z 必须递增，轮廓必须是逆时针。
 *
 * 侧面顶点在环之间、周向之间共享（索引化），computeVertexNormals 得到**平滑**法线，
 * 放样/扭转体的过渡才不会有面片感；封盖用独立顶点，保留与侧壁的棱边。
 */
function stitchRings(rings: Array<{ z: number; points: Vec2[] }>): BufferGeometry {
  if (rings.length < 2) return new BufferGeometry();
  const count = rings[0].points.length;
  const positions: number[] = [];
  const indices: number[] = [];

  for (const ring of rings) {
    for (const point of ring.points) positions.push(point[0], point[1], ring.z);
  }
  for (let ring = 0; ring + 1 < rings.length; ring += 1) {
    for (let index = 0; index < count; index += 1) {
      const next = (index + 1) % count;
      const a = ring * count + index;
      const b = ring * count + next;
      const c = (ring + 1) * count + next;
      const d = (ring + 1) * count + index;
      indices.push(a, b, c, a, c, d);
    }
  }

  const cap = (ring: { z: number; points: Vec2[] }, flip: boolean) => {
    const base = positions.length / 3;
    for (const point of ring.points) positions.push(point[0], point[1], ring.z);
    const triangles = triangulate(ring.points);
    for (let index = 0; index + 2 < triangles.length; index += 3) {
      const a = base + triangles[index];
      const b = base + triangles[index + 1];
      const c = base + triangles[index + 2];
      if (flip) indices.push(a, c, b);
      else indices.push(a, b, c);
    }
  };
  cap(rings[0], true);
  cap(rings[rings.length - 1], false);

  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}

/* ---------- 形状 → 几何 ---------- */

function buildPrism(profile: Vec2[], height: number, twist = 0, taper = 1): BufferGeometry {
  const points = toCounterClockwise(cleanProfile(profile, [[-0.1, -0.1], [0.1, -0.1], [0.1, 0.1], [-0.1, 0.1]]));
  const h = Math.max(MIN_SIZE, height);
  const steps = Math.max(1, Math.ceil(Math.abs(twist) / 12));
  const rings: Array<{ z: number; points: Vec2[] }> = [];
  for (let step = 0; step <= steps; step += 1) {
    const ratio = step / steps;
    const angle = ((twist * ratio) * Math.PI) / 180;
    const scale = 1 + (clamp(taper, 0.02, 20) - 1) * ratio;
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    rings.push({
      z: -h / 2 + h * ratio,
      points: points.map(([x, y]) => [(x * cos - y * sin) * scale, (x * sin + y * cos) * scale] as Vec2),
    });
  }
  return stitchRings(rings);
}

/**
 * 超椭圆采样：power = 2 是正椭圆，越大侧面越平（机身剖面 2.2–2.6，看起来像"圆角矩形"）。
 * 起点固定在 +x 方向，保证逐层放样时同一条母线对得上，不会拧出斜向褶皱。
 */
function sampleEllipse(rx: number, ry: number, power: number, count: number): Vec2[] {
  const points: Vec2[] = [];
  const exponent = 2 / clamp(finite(power, 2), 1, 8);
  for (let index = 0; index < count; index += 1) {
    const angle = (index / count) * Math.PI * 2;
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    points.push([
      rx * Math.sign(cos) * Math.abs(cos) ** exponent,
      ry * Math.sign(sin) * Math.abs(sin) ** exponent,
    ]);
  }
  return points;
}

/** NACA 四位翼型的半厚度分布（u 为弦向 0..1，尾缘收到 0） */
function nacaHalfThickness(u: number): number {
  return 5 * (0.2969 * Math.sqrt(u) - 0.126 * u - 0.3516 * u * u + 0.2843 * u ** 3 - 0.1036 * u ** 4);
}

/**
 * 翼型采样：弦长沿 x（前缘在 +x），厚度沿 y，与放样方向 z 正交。
 * 上表面从前缘走到尾缘，再沿下表面走回来，尾缘收成一个点。
 */
function sampleAirfoil(chord: number, thickness: number, le: number, camber: number, count: number): Vec2[] {
  const half = Math.max(3, Math.round(count / 2));
  const bend = clamp(finite(camber, 0), -0.09, 0.09);
  const mean = (u: number) => {
    if (!bend) return 0;
    const p = 0.4;
    return u < p ? (bend / (p * p)) * (2 * p * u - u * u) : (bend / ((1 - p) * (1 - p))) * (1 - 2 * p + 2 * p * u - u * u);
  };
  const points: Vec2[] = [];
  for (let index = 0; index <= half; index += 1) {
    const u = index / half;
    points.push([le - chord * u, chord * (mean(u) + nacaHalfThickness(u) * thickness)]);
  }
  for (let index = half - 1; index >= 1; index -= 1) {
    const u = index / half;
    points.push([le - chord * u, chord * (mean(u) - nacaHalfThickness(u) * thickness)]);
  }
  return points;
}

/** 取一个放样截面的轮廓：手写点 > 参数化椭圆 > 参数化翼型；再叠加扭转与偏移 */
function sectionPoints(section: LoftSection): Vec2[] {
  let points: Vec2[] = [];
  if (Array.isArray(section.profile) && section.profile.length >= 3) {
    points = cleanProfile(section.profile, []);
  } else if (section.ellipse) {
    const { rx, ry, power } = section.ellipse;
    points = sampleEllipse(
      Math.max(MIN_SIZE, finite(rx, 1)),
      Math.max(MIN_SIZE, finite(ry, 1)),
      power ?? 2,
      clamp(Math.round(finite(section.points, 32)), 6, SOLID_LIMITS.points),
    );
  } else if (section.airfoil) {
    const { chord, thickness, le, camber } = section.airfoil;
    points = sampleAirfoil(
      Math.max(MIN_SIZE, finite(chord, 1)),
      clamp(finite(thickness, 0.12), 0.01, 0.5),
      finite(le, 0),
      finite(camber, 0),
      clamp(Math.round(finite(section.points, 20)), 8, SOLID_LIMITS.points),
    );
  }
  if (points.length < 3) return [];

  const twist = finite(section.twist, 0);
  const offsetX = finite(section.offset?.[0], 0);
  const offsetY = finite(section.offset?.[1], 0);
  if (!twist && !offsetX && !offsetY) return points;
  const angle = (twist * Math.PI) / 180;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  return points.map(([x, y]) => [x * cos - y * sin + offsetX, x * sin + y * cos + offsetY] as Vec2);
}

function buildLoft(sections: LoftSection[]): BufferGeometry {
  const cleaned = (Array.isArray(sections) ? sections : [])
    .filter((section) => section && typeof section === 'object')
    .map((section) => ({ z: finite(section.z, 0), profile: sectionPoints(section) }))
    .filter((section) => section.profile.length >= 3)
    .sort((a, b) => a.z - b.z)
    .slice(0, SOLID_LIMITS.features);
  if (cleaned.length < 2) return new BufferGeometry();
  const count = Math.max(...cleaned.map((section) => section.profile.length));
  return stitchRings(cleaned.map((section) => ({ z: section.z, points: resamplePolygon(section.profile, count) })));
}

function buildSweep(profile: Vec2[], path: Vec3[], closed = false, taper?: [number, number]): BufferGeometry {
  const points = toCounterClockwise(cleanProfile(profile, [[-0.05, -0.05], [0.05, -0.05], [0.05, 0.05], [-0.05, 0.05]]));
  const centers = (Array.isArray(path) ? path : [])
    .filter((point) => Array.isArray(point) && point.length >= 3)
    .map((point) => new Vector3(finite(point[0], 0), finite(point[1], 0), finite(point[2], 0)))
    .slice(0, SOLID_LIMITS.points);
  if (centers.length < 2) return new BufferGeometry();

  // 平行传输法：沿路径维护一个不扭转的正交标架
  const tangents: Vector3[] = [];
  for (let index = 0; index < centers.length; index += 1) {
    const previous = centers[Math.max(0, index - 1)];
    const next = centers[Math.min(centers.length - 1, index + 1)];
    const tangent = next.clone().sub(previous);
    if (tangent.lengthSq() < 1e-12) tangent.set(1, 0, 0);
    tangents.push(tangent.normalize());
  }

  let normal = Math.abs(tangents[0].z) < 0.9
    ? new Vector3().crossVectors(tangents[0], new Vector3(0, 0, 1)).normalize()
    : new Vector3().crossVectors(tangents[0], new Vector3(1, 0, 0)).normalize();

  const count = points.length;
  const taperStart = clamp(finite(taper?.[0], 1), 0.02, 20);
  const taperEnd = clamp(finite(taper?.[1], 1), 0.02, 20);
  const positions: number[] = [];
  const indices: number[] = [];
  const ringStart: number[] = [];

  for (let index = 0; index < centers.length; index += 1) {
    const tangent = tangents[index];
    // 把上一帧法线投影到当前法平面，避免标架翻转
    normal = normal.clone().sub(tangent.clone().multiplyScalar(normal.dot(tangent))).normalize();
    if (!Number.isFinite(normal.x) || normal.lengthSq() < 0.5) {
      normal = new Vector3().crossVectors(tangent, new Vector3(0, 0, 1)).normalize();
    }
    const binormal = new Vector3().crossVectors(tangent, normal).normalize();
    const ratio = centers.length > 1 ? index / (centers.length - 1) : 0;
    const scale = taperStart + (taperEnd - taperStart) * ratio;
    ringStart.push(positions.length / 3);
    for (const [x, y] of points) {
      const point = centers[index].clone()
        .add(normal.clone().multiplyScalar(x * scale))
        .add(binormal.clone().multiplyScalar(y * scale));
      positions.push(point.x, point.y, point.z);
    }
  }

  const quad = (ringA: number, ringB: number) => {
    for (let index = 0; index < count; index += 1) {
      const next = (index + 1) % count;
      const a = ringStart[ringA] + index;
      const b = ringStart[ringA] + next;
      const c = ringStart[ringB] + next;
      const d = ringStart[ringB] + index;
      indices.push(a, b, c, a, c, d);
    }
  };
  for (let ring = 0; ring + 1 < ringStart.length; ring += 1) quad(ring, ring + 1);
  if (closed && ringStart.length > 2) quad(ringStart.length - 1, 0);

  // 端盖：独立顶点，保留与侧壁的棱边
  const cap = (ring: number, flip: boolean) => {
    const base = positions.length / 3;
    const start = ringStart[ring];
    for (let index = 0; index < count; index += 1) {
      positions.push(positions[(start + index) * 3], positions[(start + index) * 3 + 1], positions[(start + index) * 3 + 2]);
    }
    const triangles = triangulate(points);
    for (let index = 0; index + 2 < triangles.length; index += 3) {
      const a = base + triangles[index];
      const b = base + triangles[index + 1];
      const c = base + triangles[index + 2];
      if (flip) indices.push(a, c, b);
      else indices.push(a, b, c);
    }
  };
  if (!closed) {
    cap(0, true);
    cap(ringStart.length - 1, false);
  }

  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}

function buildRevolve(profile: Vec2[], seg: number, angle = 360): BufferGeometry {
  const raw = (Array.isArray(profile) ? profile : [])
    .filter((point) => Array.isArray(point) && point.length >= 2)
    .map(([radius, height]) => new Vector2(Math.max(0, finite(radius, 0)), finite(height, 0)))
    .slice(0, SOLID_LIMITS.points);
  if (raw.length < 2) return new BufferGeometry();
  const closedAngle = Math.abs(angle) >= 359.9;
  const phiLength = closedAngle ? Math.PI * 2 : (clamp(angle, 1, 360) * Math.PI) / 180;
  // LatheGeometry 绕 Y 轴旋转，rotateX(π/2) 后成为 Z-up
  return new LatheGeometry(raw, Math.max(6, seg), 0, phiLength).rotateX(Math.PI / 2);
}

/**
 * 圆角矩形轮廓上的点：u ∈ [0,4)，每 1 个单位是「一条直边 + 一个圆角」。
 *
 * 直边与圆弧各占一半参数空间，所以**点分布与圆角半径无关** —— 逐层放样时
 * 同一条 u 落在同一条母线上，不会因为半径变化把表面拧出斜向褶皱。
 */
function roundedRectPoint(u: number, a: number, b: number, r: number): [number, number] {
  const wrapped = ((u % 4) + 4) % 4;
  const index = Math.min(3, Math.floor(wrapped));
  const t = wrapped - index;
  const rr = clamp(r, 0, Math.min(a, b));
  const straight = t < 0.5;
  const k = straight ? t * 2 : (t - 0.5) * 2;
  switch (index) {
    case 0: {
      if (straight) return [a, -(b - rr) + k * 2 * (b - rr)];
      const ang = (k * Math.PI) / 2;
      return [a - rr + rr * Math.cos(ang), b - rr + rr * Math.sin(ang)];
    }
    case 1: {
      if (straight) return [a - rr - k * 2 * (a - rr), b];
      const ang = Math.PI / 2 + (k * Math.PI) / 2;
      return [-(a - rr) + rr * Math.cos(ang), b - rr + rr * Math.sin(ang)];
    }
    case 2: {
      if (straight) return [-a, b - rr - k * 2 * (b - rr)];
      const ang = Math.PI + (k * Math.PI) / 2;
      return [-(a - rr) + rr * Math.cos(ang), -(b - rr) + rr * Math.sin(ang)];
    }
    default: {
      if (straight) return [-(a - rr) + k * 2 * (a - rr), -b];
      const ang = (3 * Math.PI) / 2 + (k * Math.PI) / 2;
      return [a - rr + rr * Math.cos(ang), -(b - rr) + rr * Math.sin(ang)];
    }
  }
}

/**
 * 圆角盒：三轴都倒圆的盒体（SolidWorks 里「盒 + 三条棱倒圆」的结果）。
 *
 * 做法是真正的 CAD 造型，而不是用 superellipsoid 近似：
 * 1. 竖直方向切成若干层，每层是一个**圆角矩形**轮廓（平面圆角 = radius）；
 * 2. 靠顶 / 底 edge 范围内，轮廓按 |z| 向内缩进 edge·(1−cosφ)，形成顶棱倒圆。
 *
 * 这样侧面是平的、只有棱边带 R，和实物外壳一致。旧实现（单指数超椭球）
 * 在倒圆接近半个短边时会整块退化成蛋形 —— 220×48×48 的机身配 R18 就成了一根胶囊，
 * 这是「造型不像实物」的主要来源之一。
 *
 * radius 同时表示平面圆角与竖直倒圆，与 CAD 的「圆角盒」语义一致；半径超过半高时
 * 竖直方向整圈都落在圆弧里（薄板配大圆角的常见情况），轮廓仍保持平面 R 不变。
 */
function buildRoundedBox(width: number, depth: number, height: number, radius: number, seg: number): BufferGeometry {
  const a = Math.max(MIN_SIZE, width) / 2;
  const b = Math.max(MIN_SIZE, depth) / 2;
  const c = Math.max(MIN_SIZE, height) / 2;
  const planHalf = Math.min(a, b);
  // 留 2% 的极小圆角，避免 radius=0 时轮廓退化成一堆重合点（退化面会产生 0 法线）
  const planFillet = clamp(finite(radius, planHalf * 0.12), planHalf * 0.02, planHalf * 0.999);
  const edge = Math.min(planFillet, c * 0.999);

  const nu = Math.max(16, 4 * Math.round(Math.max(16, Math.round(seg)) / 4));
  const nv = Math.max(8, Math.round(seg * 0.75));

  const straightHalf = Math.max(0, c - edge);
  const arcSteps = edge > MIN_SIZE ? Math.max(4, Math.round(nv * 0.45)) : 0;
  const straightSteps = straightHalf > MIN_SIZE ? Math.max(2, nv - 2 * arcSteps) : 0;

  // 竖直采样：底弧（−c → −straightHalf）→ 直段 → 顶弧（straightHalf → c）
  const rings: Array<[number, number]> = [];
  if (arcSteps > 0) {
    const bottom: Array<[number, number]> = [];
    for (let i = 0; i <= arcSteps; i += 1) {
      const phi = (Math.PI / 2) * (i / arcSteps);
      bottom.push([-(straightHalf + edge * Math.sin(phi)), edge * (1 - Math.cos(phi))]);
    }
    bottom.reverse();
    // 与直段首环重合的那一层跳过，避免零高度四边形
    rings.push(...(straightSteps > 0 ? bottom.slice(0, -1) : bottom));
  } else {
    rings.push([-c, 0]);
  }
  if (straightSteps > 0) {
    for (let i = 0; i <= straightSteps; i += 1) {
      rings.push([-straightHalf + (2 * straightHalf * i) / straightSteps, 0]);
    }
  }
  if (arcSteps > 0) {
    for (let i = 0; i <= arcSteps; i += 1) {
      const phi = (Math.PI / 2) * (i / arcSteps);
      // i=0 与「直段末环 / 底弧末环」重合（薄板时两段弧在 z=0 相接），跳过
      if (i === 0) continue;
      rings.push([straightHalf + edge * Math.sin(phi), edge * (1 - Math.cos(phi))]);
    }
  } else {
    rings.push([c, 0]);
  }

  const positions: number[] = [];
  const indices: number[] = [];
  const ringStart: number[] = [];
  for (const [z, inset] of rings) {
    const a2 = Math.max(MIN_SIZE / 8, a - inset);
    const b2 = Math.max(MIN_SIZE / 8, b - inset);
    const r2 = Math.max(planFillet - inset, Math.min(a2, b2) * 0.02);
    ringStart.push(positions.length / 3);
    for (let iu = 0; iu < nu; iu += 1) {
      const [x, y] = roundedRectPoint((4 * iu) / nu, a2, b2, r2);
      positions.push(x, y, z);
    }
  }

  for (let ring = 0; ring + 1 < ringStart.length; ring += 1) {
    for (let iu = 0; iu < nu; iu += 1) {
      const next = (iu + 1) % nu;
      const i0 = ringStart[ring] + iu;
      const i1 = ringStart[ring] + next;
      const i2 = ringStart[ring + 1] + next;
      const i3 = ringStart[ring + 1] + iu;
      indices.push(i0, i1, i2, i0, i2, i3);
    }
  }

  const bottomCenter = positions.length / 3;
  positions.push(0, 0, -c);
  const topCenter = positions.length / 3;
  positions.push(0, 0, c);
  for (let iu = 0; iu < nu; iu += 1) {
    const next = (iu + 1) % nu;
    indices.push(bottomCenter, ringStart[0] + next, ringStart[0] + iu);
    const last = ringStart[ringStart.length - 1];
    indices.push(topCenter, last + iu, last + next);
  }

  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}

/** 圆管：Lathe 转一圈封闭剖面，内外壁 + 上下环面一次成型 */
function buildTube(radius: number, thickness: number, height: number, seg: number): BufferGeometry {
  const outer = Math.max(MIN_SIZE, radius);
  const wall = clamp(finite(thickness, outer * 0.1), MIN_SIZE / 4, outer * 0.98);
  const inner = Math.max(MIN_SIZE / 4, outer - wall);
  const h = Math.max(MIN_SIZE, height);
  const profile = [
    new Vector2(inner, -h / 2),
    new Vector2(outer, -h / 2),
    new Vector2(outer, h / 2),
    new Vector2(inner, h / 2),
    new Vector2(inner, -h / 2),
  ];
  return new LatheGeometry(profile, Math.max(6, seg)).rotateX(Math.PI / 2);
}

/** 胶囊：两端半球封头的圆柱，height 为总高 */
function buildCapsule(radius: number, height: number, seg: number): BufferGeometry {
  const r = Math.max(MIN_SIZE, radius);
  const h = Math.max(2 * r, height);
  const profile: Vector2[] = [];
  const steps = Math.max(4, Math.round(seg / 4));
  profile.push(new Vector2(0, -h / 2));
  for (let index = 1; index <= steps; index += 1) {
    const angle = (Math.PI / 2) * (index / steps);
    profile.push(new Vector2(r * Math.sin(angle), -h / 2 + r - r * Math.cos(angle)));
  }
  profile.push(new Vector2(r, h / 2 - r));
  for (let index = 1; index <= steps; index += 1) {
    const angle = (Math.PI / 2) * (index / steps);
    profile.push(new Vector2(r * Math.cos(angle), h / 2 - r + r * Math.sin(angle)));
  }
  return new LatheGeometry(profile, Math.max(8, seg)).rotateX(Math.PI / 2);
}

/** 椭球：单位球三轴缩放 */
function buildEllipsoid(rx: number, ry: number, rz: number, seg: number): BufferGeometry {
  const geometry = new SphereGeometry(1, Math.max(12, seg), Math.max(8, Math.round(seg / 2)));
  geometry.scale(Math.max(MIN_SIZE, rx), Math.max(MIN_SIZE, ry), Math.max(MIN_SIZE, rz));
  return geometry;
}

/** 凸包：用点集围出流线外形（整流罩 / 机头 / 不规则块） */
function buildHull(points: Vec3[]): BufferGeometry {
  const list = (Array.isArray(points) ? points : [])
    .filter((point) => Array.isArray(point) && point.length >= 3)
    .map((point) => new Vector3(finite(point[0], 0), finite(point[1], 0), finite(point[2], 0)))
    .slice(0, SOLID_LIMITS.hullPoints);
  if (list.length < 4) return new BufferGeometry();
  try {
    return new ConvexGeometry(list);
  } catch {
    return new BufferGeometry();
  }
}

/* ---------- 瓦面：逐片铺板瓦 + 筒瓦 ---------- */

/**
 * 瓦片累加器。
 *
 * 瓦片都是硬边薄壳，法线按面算（flat）。筒瓦半圆只有 4 段，flat 反而更像手工陶瓦；
 * 用平滑法线会把瓦片糊成一根圆管，瓦楞感就没了。
 */
interface TileMesh {
  pos: number[];
  nrm: number[];
}

function tileFaceNormal(a: Vec3, b: Vec3, c: Vec3): Vec3 {
  const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
  const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
  return [uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx];
}

function tilePushTriangle(mesh: TileMesh, a: Vec3, b: Vec3, c: Vec3, outward: Vec3): void {
  let tri: [Vec3, Vec3, Vec3] = [a, b, c];
  let normal = tileFaceNormal(a, b, c);
  if (normal[0] * outward[0] + normal[1] * outward[1] + normal[2] * outward[2] < 0) {
    tri = [a, c, b];
    normal = [-normal[0], -normal[1], -normal[2]];
  }
  const length = Math.hypot(normal[0], normal[1], normal[2]) || 1;
  const unit: Vec3 = [normal[0] / length, normal[1] / length, normal[2] / length];
  for (const point of tri) {
    mesh.pos.push(point[0], point[1], point[2]);
    mesh.nrm.push(unit[0], unit[1], unit[2]);
  }
}

/**
 * 推一个多边形面，但每个顶点带自己的法向（光滑着色）。
 *
 * 瓦面在翼角处被 `cornerLift` 拧着，一片板瓦的四个角**不共面**：扇形成两个三角面以后，
 * 两个面法向差 8° 上下，一面对着光源、一面背着，画出来就是「一格惨白、一格灰」——
 * 用户看到的「白色错误块」就是它。顶点法向按曲面解析求，跨面插值以后反光是连续的。
 *
 * 绕序由**顶点法向**决定，不再用「面中心 − 瓦片中心」：翼角上瓦片被拧得厉害，
 * 半片的形心可能跑到整片的形心下面，那一判就会把顶面判成朝下 —— 于是法向朝上、
 * 绕序朝下，整片瓦变黑。顶点法向是外接曲面算出来的，拿它当外向永远对。
 */
function tilePushFaceShaded(mesh: TileMesh, points: Vec3[], normals: Vec3[]): void {
  const count = points.length;
  if (count < 3) return;
  let nx = 0, ny = 0, nz = 0;
  for (const normal of normals) {
    nx += normal[0]; ny += normal[1]; nz += normal[2];
  }
  const outward: Vec3 = [nx, ny, nz];
  if (Math.hypot(outward[0], outward[1], outward[2]) < 1e-9) return;
  for (let index = 1; index < count - 1; index += 1) {
    const a = points[0]!, b = points[index]!, c = points[index + 1]!;
    const na = normals[0]!, nb = normals[index]!, nc = normals[index + 1]!;
    const face = tileFaceNormal(a, b, c);
    const same = face[0] * outward[0] + face[1] * outward[1] + face[2] * outward[2] >= 0;
    const tri: Vec3[] = same ? [a, b, c] : [a, c, b];
    const ntri: Vec3[] = same ? [na, nb, nc] : [na, nc, nb];
    for (let k = 0; k < 3; k += 1) {
      const point = tri[k]!;
      const normal = ntri[k]!;
      mesh.pos.push(point[0], point[1], point[2]);
      mesh.nrm.push(normal[0], normal[1], normal[2]);
    }
  }
}

/**
 * 推一个多边形面（扇形三角化）。
 *
 * 朝向不靠人肉保证：拿「面中心 − 瓦片中心」当外向。瓦片都是凸的，这个向量必然朝外，
 * 于是顶面朝上、底面朝下、四边朝外全都自动对 —— 少一处手写符号就少一个「某片瓦背面朝外」
 * 的隐蔽 bug（这种错不报错，只在渲染时悄悄少一块）。
 */
function tilePushFace(mesh: TileMesh, points: Vec3[], center: Vec3): void {
  if (points.length < 3) return;
  let mx = 0, my = 0, mz = 0;
  for (const point of points) {
    mx += point[0]; my += point[1]; mz += point[2];
  }
  const count = points.length;
  const outward: Vec3 = [mx / count - center[0], my / count - center[1], mz / count - center[2]];
  if (Math.hypot(outward[0], outward[1], outward[2]) < 1e-9) return;
  const first = points[0]!;
  for (let index = 1; index < count - 1; index += 1) {
    tilePushTriangle(mesh, first, points[index]!, points[index + 1]!, outward);
  }
}

/** 屋面轮廓：从檐口到顶点的 (半径, 高度) 折线，按**坡长**参数化 */
interface RoofCurve {
  length: number;
  /** s = 从檐口量起的坡长（米） */
  at(s: number): { r: number; z: number; dr: number; dz: number };
}

function roofCurveOf(rings: Array<{ z: number; radius: number }>): RoofCurve | null {
  const list = (Array.isArray(rings) ? rings : [])
    .filter((ring) => ring && Number.isFinite(ring.z) && Number.isFinite(ring.radius))
    .map((ring) => ({ z: ring.z, r: Math.max(0.02, ring.radius) }))
    .sort((a, b) => a.z - b.z)
    .slice(0, 64);
  if (list.length < 2) return null;
  const spans: number[] = [0];
  for (let index = 1; index < list.length; index += 1) {
    spans.push(spans[index - 1]! + Math.hypot(list[index]!.r - list[index - 1]!.r, list[index]!.z - list[index - 1]!.z));
  }
  const length = spans[spans.length - 1]!;
  if (!(length > 0.05)) return null;
  return {
    length,
    at(s: number) {
      const at = clamp(s, 0, length);
      let index = 1;
      while (index < spans.length - 1 && spans[index]! < at) index += 1;
      const a = list[index - 1]!;
      const b = list[index]!;
      const span = (spans[index]! - spans[index - 1]!) || 1;
      const w = (at - spans[index - 1]!) / span;
      return {
        r: a.r + (b.r - a.r) * w,
        z: a.z + (b.z - a.z) * w,
        dr: (b.r - a.r) / span,
        dz: (b.z - a.z) / span,
      };
    },
  };
}

/**
 * 瓦面求值 —— 照着真实瓦作铺，而不是给屋面加一圈波浪：
 *
 * 1. 环向每条边切成 `rows` 列，一列一块**板瓦**（横向内凹的薄壳，有厚度、有瓦口）；
 * 2. 列的分界线上压一条**筒瓦**（半圆筒），盖住板瓦的侧缝 —— 板瓦 + 筒瓦才是瓦顶，
 *    只有波浪只能算「石棉瓦」；
 * 3. 沿坡向按**坡长**均分 `courses` 层，每块板瓦下缘抬 `lift`、上缘贴屋面，
 *    相邻两片之间就有了叠压的台阶（传统「压六露四」的观感来源）；
 * 4. 最下一层筒瓦端头套一个**实心圆盘**（**瓦当**），板瓦端头挂一片有厚度的桃形舌片（**滴水**），
 *    檐口才是那条起伏的花边。两样都必须是实体：零厚度的片子在低角度下就是一张纸。
 *
 * 长度全部走 `RoofCurve` 的**弧长**：按 z 等分会让近顶的瓦挤扁、檐口的瓦拉长，
 * 这是「远看像、近看假」最常见的原因。
 */
/**
 * 屋面曲面的数学定义。
 *
 * 抽出来导出是给 `scripts/pavilion-fit.ts` 用的：翼角处的封檐板 / 戗脊 / 角梁
 * 必须跟瓦面共用同一条 `surface(u, s)`（含角部起翘 cornerLift 与外挑 cornerOut），
 * 各自按自己的折线走，角上就会出现「木头穿出瓦面」。
 */
export interface RoofSurface {
  /** 檐口到顶点的坡长 */
  length: number;
  /** 环向面数：多边形边数，圆形为 1 */
  panels: number;
  sides: number;
  thickness: number;
  crown: number;
  lift: number;
  sag: number;
  margin: number;
  cornerLift: number;
  cornerOut: number;
  /** 中线：坡长 → 半径 / 高度 / 导数 */
  at(s: number): { r: number; z: number; dr: number; dz: number };
  /** 角部起翘权重（0 = 正常屋面，1 = 角尖最高） */
  warp(u: number, s: number): number;
  /** (u, s) → 瓦面基准点与单位外法向。u∈[0,1) 环向，s 为从檐口量起的坡长 */
  surface(u: number, s: number): { p: Vec3; n: Vec3 };
  /** 环向水平切向（u 增大方向） */
  lateralAt(u: number, s: number): Vec3;
  /** 下坡方向（朝檐口） */
  downSlope(u: number, s: number): Vec3;
}

export function roofSurfaceOf(shape: Extract<SolidShape, { shape: 'tiles' }>): RoofSurface | null {
  const curve = roofCurveOf(shape.rings);
  if (!curve) return null;

  const sides = clamp(Math.round(finite(shape.sides, 6)), 0, 24);
  const panels = sides >= 3 ? sides : 1;
  const thickness = clamp(finite(shape.thickness, 0.014), 0.002, 0.08);
  const lift = clamp(finite(shape.lift, 0.012), 0, 0.1);
  const crown = clamp(finite(shape.crown, 0.05), 0, 0.2);
  const sag = clamp(finite(shape.sag, 0.012), 0, 0.08);
  const margin = clamp(finite(shape.margin, 0.04), 0, curve.length * 0.2);
  // 角部起翘（翼角）：屋面自己翘起来，而不是在角上另贴一块板
  const cornerLift = clamp(finite(shape.cornerLift, 0), 0, curve.length);
  const cornerOut = clamp(finite(shape.cornerOut, 0), 0, 1);
  const cornerSpan = clamp(finite(shape.cornerSpan, 0.3), 0.02, 0.5);
  const cornerDepth = curve.length * clamp(finite(shape.cornerDepth, 0.32), 0.02, 1);

  /** 环向参数 u∈[0,1) → 屋面点与水平外法向（多边形按边、圆形按半径） */
  const contour = (r: number, u: number) => {
    if (sides < 3) {
      const angle = u * Math.PI * 2;
      return { x: Math.cos(angle) * r, y: Math.sin(angle) * r, nx: Math.cos(angle), ny: Math.sin(angle) };
    }
    const per = 1 / sides;
    const index = Math.min(sides - 1, Math.floor(u / per));
    const w = u / per - index;
    const a0 = (index / sides) * Math.PI * 2;
    const a1 = ((index + 1) / sides) * Math.PI * 2;
    const ax = Math.cos(a0) * r, ay = Math.sin(a0) * r;
    const bx = Math.cos(a1) * r, by = Math.sin(a1) * r;
    const ex = bx - ax, ey = by - ay;
    const width = Math.hypot(ex, ey) || 1;
    return { x: ax + ex * w, y: ay + ey * w, nx: ey / width, ny: -ex / width };
  };

  /**
   * 角部起翘权重（0 = 不受影响，1 = 抬到最高）：
   *   - 环向：u 落在多边形**顶点**上最大，到面中（半跨）衰减到 0；
   *   - 坡向：檐口最大，往上走 `cornerDepth` 衰减到 0。
   * 两侧都用平方衰减，接回正常屋面时斜率为 0，翘起来的角不会折出一道楞。
   */
  const cornerWarp = (u: number, s: number) => {
    if (cornerLift <= 0 && cornerOut <= 0) return 0;
    const local = Math.abs(u * panels - Math.round(u * panels)); // 0 = 角上，0.5 = 面中
    const across = Math.max(0, 1 - local / cornerSpan);
    const along = Math.max(0, 1 - s / cornerDepth);
    return across * across * along * along;
  };

  /** 屋面点 + 外法向：坡越陡法向越水平，到垂直墙时正好水平 */
  const surface = (u: number, s: number) => {
    const at = curve.at(s);
    const warp = cornerWarp(u, s);
    const point = contour(at.r * (1 + cornerOut * warp), u);
    const slope = Math.hypot(at.dr, at.dz) || 1;
    const radial = at.dz / slope;
    const up = -at.dr / slope;
    return {
      p: [point.x, point.y, at.z + cornerLift * warp] as Vec3,
      n: [point.nx * radial, point.ny * radial, up] as Vec3,
    };
  };

  /** 环向切向（水平的，沿 u 增大方向）——筒瓦拿它撑开宽度 */
  const lateralAt = (u: number, s: number): Vec3 => {
    const here = surface(u, s).p;
    const ahead = surface(u + 1e-3, s).p;
    const dx = ahead[0] - here[0];
    const dy = ahead[1] - here[1];
    const length = Math.hypot(dx, dy) || 1;
    return [dx / length, dy / length, 0];
  };

  /** 下坡方向（朝檐口外）的单位向量：瓦当的进深、滴水的厚度都沿它长 */
  const downSlope = (u: number, s: number): Vec3 => {
    const here = surface(u, s).p;
    const above = surface(u, s + 1e-3).p;
    const dx = here[0] - above[0];
    const dy = here[1] - above[1];
    const dz = here[2] - above[2];
    const length = Math.hypot(dx, dy, dz) || 1;
    return [dx / length, dy / length, dz / length];
  };

  return {
    length: curve.length,
    panels,
    sides,
    thickness,
    crown,
    lift,
    sag,
    margin,
    cornerLift,
    cornerOut,
    at: (at: number) => curve.at(at),
    warp: cornerWarp,
    surface,
    lateralAt,
    downSlope,
  };
}

function buildTiles(shape: Extract<SolidShape, { shape: 'tiles' }>): BufferGeometry {
  const roof = roofSurfaceOf(shape);
  if (!roof) return new BufferGeometry();
  const { length, panels, thickness, lift, crown, sag, margin, surface, lateralAt, downSlope } = roof;

  const rowsPerPanel = clamp(Math.round(finite(shape.rows, 9)), 2, 24);
  const columns = rowsPerPanel * panels;
  const courses = clamp(Math.round(finite(shape.courses, 12)), 2, 40);
  const board = clamp(finite(shape.board, 0), 0, 0.4);
  const showTiles = shape.showTiles !== false;

  // 檐口留 margin、顶上留一点给宝顶，其余按坡长均分
  const span = length - margin * 1.8;
  const step = span / courses;
  if (!(step > 0.01)) return new BufferGeometry();

  const shift = (p: Vec3, n: Vec3, distance: number): Vec3 => [
    p[0] + n[0] * distance,
    p[1] + n[1] * distance,
    p[2] + n[2] * distance,
  ];

  const midpoint = (a: Vec3, b: Vec3): Vec3 => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];

  /**
   * 曲面在 (u, s) 处的**真法向**（含角部起翘）。
   *
   * `surface().n` 只是剖面曲线的法向 —— 它不知道环向上被 `cornerLift` / `cornerOut` 抬过，
   * 所以在翼角上比真实曲面法向歪得厉害。这里对 warp 之后的点做中心差分重新求一次。
   * 逐顶点用它做着色法向，瓦面才是一张连续的面，而不是一格一格的亮片。
   *
   * 网格点会重复调用（每片瓦的四个角与邻瓦共用），按 (u, s) 缓存。
   */
  const normalCache = new Map<string, Vec3>();
  const normalAt = (u: number, s: number): Vec3 => {
    const key = `${Math.round(u * 1e5)}|${Math.round(s * 1e4)}`;
    const hit = normalCache.get(key);
    if (hit) return hit;
    const base = surface(u, s).n;
    const e = 0.002;
    const a = surface(u - e, s).p;
    const b = surface(u + e, s).p;
    const c = surface(u, Math.max(0, s - e)).p;
    const d = surface(u, Math.min(length, s + e)).p;
    const du: Vec3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const ds: Vec3 = [d[0] - c[0], d[1] - c[1], d[2] - c[2]];
    let normal: Vec3 = [
      du[1] * ds[2] - du[2] * ds[1],
      du[2] * ds[0] - du[0] * ds[2],
      du[0] * ds[1] - du[1] * ds[0],
    ];
    const len = Math.hypot(normal[0], normal[1], normal[2]);
    // 檐口 / 顶点处差分会退化（一侧被 clamp 成同一个点），退回剖面法向
    if (!(len > 1e-9)) normal = [base[0], base[1], base[2]];
    else {
      normal = [normal[0] / len, normal[1] / len, normal[2] / len];
      if (normal[0] * base[0] + normal[1] * base[1] + normal[2] * base[2] < 0) {
        normal = [-normal[0], -normal[1], -normal[2]];
      }
    }
    normalCache.set(key, normal);
    return normal;
  };

  /** 整圈（闭口，首尾不重复）：瓦当是圆盘，半圆环在低角度看过去就成了一条翻边 */
  const discRing = (center: Vec3, normal: Vec3, tangent: Vec3, radius: number, steps: number): Vec3[] => {
    const points: Vec3[] = [];
    for (let k = 0; k < steps; k += 1) {
      const angle = (Math.PI * 2 * k) / steps;
      const cos = Math.cos(angle) * radius;
      const sin = Math.sin(angle) * radius;
      points.push([
        center[0] + normal[0] * cos + tangent[0] * sin,
        center[1] + normal[1] * cos + tangent[1] * sin,
        center[2] + normal[2] * cos + tangent[2] * sin,
      ]);
    }
    return points;
  };

  const mesh: TileMesh = { pos: [], nrm: [] };

  /* ---------------- 板瓦 ---------------- */
  const boardTile = (u0: number, u1: number, s0: number, s1: number, eave: boolean) => {
    const us = [u0, (u0 + u1) / 2, u1];
    const top: Vec3[][] = [];
    const bottom: Vec3[][] = [];
    /** 每个顶点的光滑法向（顶面用，底面取反）—— 见 normalAt 的注释 */
    const normals: Vec3[][] = [];
    for (let vi = 0; vi < 2; vi += 1) {
      const rowTop: Vec3[] = [];
      const rowBottom: Vec3[] = [];
      const rowNormals: Vec3[] = [];
      for (let ui = 0; ui < 3; ui += 1) {
        const s = vi ? s1 : s0;
        const hit = surface(us[ui]!, s);
        // 下缘抬起 lift、上缘贴屋面：相邻两片之间就有了那道台阶
        const offset = thickness + lift * (1 - vi) - sag * Math.sin((Math.PI * ui) / 2);
        rowTop.push(shift(hit.p, hit.n, offset));
        rowBottom.push(shift(hit.p, hit.n, offset - thickness));
        rowNormals.push(normalAt(us[ui]!, s));
      }
      top.push(rowTop);
      bottom.push(rowBottom);
      normals.push(rowNormals);
    }

    const center: Vec3 = [
      (top[0]![0]![0] + top[1]![2]![0]) / 2,
      (top[0]![0]![1] + top[1]![2]![1]) / 2,
      (top[0]![0]![2] + top[1]![2]![2]) / 2,
    ];

    // 顶面 / 底面：逐顶点法向，翼角处的板瓦才是一张连续的面而不是两片亮片
    for (let ui = 0; ui < 2; ui += 1) {
      tilePushFaceShaded(
        mesh,
        [top[0]![ui]!, top[0]![ui + 1]!, top[1]![ui + 1]!, top[1]![ui]!],
        [normals[0]![ui]!, normals[0]![ui + 1]!, normals[1]![ui + 1]!, normals[1]![ui]!],
      );
      tilePushFaceShaded(
        mesh,
        [bottom[0]![ui]!, bottom[0]![ui + 1]!, bottom[1]![ui + 1]!, bottom[1]![ui]!],
        [
          [-normals[0]![ui]![0], -normals[0]![ui]![1], -normals[0]![ui]![2]],
          [-normals[0]![ui + 1]![0], -normals[0]![ui + 1]![1], -normals[0]![ui + 1]![2]],
          [-normals[1]![ui + 1]![0], -normals[1]![ui + 1]![1], -normals[1]![ui + 1]![2]],
          [-normals[1]![ui]![0], -normals[1]![ui]![1], -normals[1]![ui]![2]],
        ],
      );
    }
    // 下缘 / 上缘的瓦口厚度
    for (let ui = 0; ui < 2; ui += 1) {
      tilePushFace(mesh, [bottom[0]![ui]!, bottom[0]![ui + 1]!, top[0]![ui + 1]!, top[0]![ui]!], center);
      tilePushFace(mesh, [bottom[1]![ui]!, bottom[1]![ui + 1]!, top[1]![ui + 1]!, top[1]![ui]!], center);
    }
    // 两条侧缝（被筒瓦压住，留出厚度让瓦看起来是块）
    for (const ui of [0, 2]) {
      tilePushFace(mesh, [bottom[0]![ui]!, bottom[1]![ui]!, top[1]![ui]!, top[0]![ui]!], center);
    }

    // 滴水：檐口那片板瓦的端头往下挂一个桃形舌片。
    // 两个要点：
    // 1. 舌片的**宽面朝外**（正对檐口），厚度沿下坡方向 —— 厚度若沿屋面法向，
    //    从檐口正对面看过去只剩一条 16 mm 的边，那就是用户说的「薄片」；
    // 2. 做成实心（前后两面 + 一圈侧壁），不是「正反两个三角」的双面片。
    if (eave) {
      const flare = (u1 - u0) * 0.08;
      const drop = Math.min(0.09, step * 0.62);
      const shoulder = drop * 0.46;
      const leftHit = surface(u0 + flare, s0);
      const rightHit = surface(u1 - flare, s0);
      const midHit = surface((u0 + u1) / 2, s0);
      const down = downSlope((u0 + u1) / 2, s0);
      const base = (hit: { p: Vec3; n: Vec3 }) => shift(hit.p, hit.n, lift + thickness * 0.9);
      const leftTop = base(leftHit);
      const rightTop = base(rightHit);
      const midTop = base(midHit);
      // 轮廓：上边齐瓦口，两侧切肩，中间收成尖（滴水瓦的样子）
      const outline: Vec3[] = [
        leftTop,
        rightTop,
        [rightTop[0], rightTop[1], rightTop[2] - shoulder],
        [midTop[0], midTop[1], midTop[2] - drop],
        [leftTop[0], leftTop[1], leftTop[2] - shoulder],
      ];
      // 厚度沿下坡方向：外面凸出瓦口 0.6 个瓦厚，里面塞进瓦口里，接缝看不见
      const front = outline.map((point) => shift(point, down, thickness * 0.6));
      const back = outline.map((point) => shift(point, down, -thickness * 0.4));
      let cx = 0, cy = 0, cz = 0;
      for (const point of [...front, ...back]) {
        cx += point[0]; cy += point[1]; cz += point[2];
      }
      const total = front.length + back.length;
      const core: Vec3 = [cx / total, cy / total, cz / total];
      tilePushFace(mesh, front, core);
      tilePushFace(mesh, back, core);
      for (let i = 0; i < front.length; i += 1) {
        const j = (i + 1) % front.length;
        tilePushFace(mesh, [back[i]!, back[j]!, front[j]!, front[i]!], core);
      }
    }
  };

  /* ---------------- 筒瓦 ---------------- */
  const CROWN_STEPS = 4;
  const crownTile = (u: number, s0: number, s1: number, eave: boolean) => {
    const start = surface(u, s0);
    const end = surface(u, s1);
    const lateral0 = lateralAt(u, s0);
    const lateral1 = lateralAt(u, s1);
    // 骑在板瓦之上：圆心抬半个瓦厚
    const center0 = shift(start.p, start.n, thickness * 0.6);
    const center1 = shift(end.p, end.n, thickness * 0.6);

    const ring = (center: Vec3, normal: Vec3, lateral: Vec3, radius: number): Vec3[] => {
      const points: Vec3[] = [];
      for (let k = 0; k <= CROWN_STEPS; k += 1) {
        const angle = -Math.PI / 2 + (Math.PI * k) / CROWN_STEPS;
        const cos = Math.cos(angle) * radius;
        const sin = Math.sin(angle) * radius;
        points.push([
          center[0] + normal[0] * cos + lateral[0] * sin,
          center[1] + normal[1] * cos + lateral[1] * sin,
          center[2] + normal[2] * cos + lateral[2] * sin,
        ]);
      }
      return points;
    };

    const ring0 = ring(center0, start.n, lateral0, crown * (eave ? 1 : 1.07));
    const ring1 = ring(center1, end.n, lateral1, crown * 0.95);
    // 筒瓦是半圆筒：顶点法向按径向取，四段弧才连成一整根圆管，不是四片窄平面
    const archNormals = (normal: Vec3, lateral: Vec3): Vec3[] => {
      const list: Vec3[] = [];
      for (let k = 0; k <= CROWN_STEPS; k += 1) {
        const angle = -Math.PI / 2 + (Math.PI * k) / CROWN_STEPS;
        const cos = Math.cos(angle);
        const sin = Math.sin(angle);
        const raw: Vec3 = [
          normal[0] * cos + lateral[0] * sin,
          normal[1] * cos + lateral[1] * sin,
          normal[2] * cos + lateral[2] * sin,
        ];
        const len = Math.hypot(raw[0], raw[1], raw[2]) || 1;
        list.push([raw[0] / len, raw[1] / len, raw[2] / len]);
      }
      return list;
    };
    const normals0 = archNormals(start.n, lateral0);
    const normals1 = archNormals(end.n, lateral1);
    for (let k = 0; k < CROWN_STEPS; k += 1) {
      tilePushFaceShaded(
        mesh,
        [ring0[k]!, ring0[k + 1]!, ring1[k + 1]!, ring1[k]!],
        [normals0[k]!, normals0[k + 1]!, normals1[k + 1]!, normals1[k]!],
      );
    }

    const cap0Center: Vec3 = [
      center0[0] - start.n[0] * crown * 0.5,
      center0[1] - start.n[1] * crown * 0.5,
      center0[2] - start.n[2] * crown * 0.5,
    ];

    // 瓦当：檐口那条筒瓦的端头套一个**实心圆盘**（整圈 + 饼厚）。
    // 早先做的是半圆环 + 一片扇形封口，从低角度看只剩一条翻边和一张薄片 ——
    // 真瓦当是一块饼：整圆、有厚度、圆盘下缘本来就垂到瓦口以下。
    if (eave) {
      const down = downSlope(u, s0);
      const radius = crown * 1.22;
      const depth = crown * 0.55;
      const frontCenter = shift(center0, down, depth);
      const back = discRing(center0, start.n, lateral0, radius, 14);
      // 盘面比盘背收一点：直筒侧壁在低角度下会像一枚立着的硬币，收口后才像瓦当
      const front = discRing(frontCenter, start.n, lateral0, radius * 0.92, 14);
      const core = midpoint(center0, frontCenter);
      for (let k = 0; k < back.length; k += 1) {
        const j = (k + 1) % back.length;
        tilePushFace(mesh, [back[k]!, back[j]!, front[j]!, front[k]!], core);
      }
      // 盘面朝外、盘背朝里（盘背正好把筒瓦的开口封住，仰视看不见空筒）
      tilePushFace(mesh, front, center0);
      tilePushFace(mesh, back, frontCenter);
    } else {
      tilePushFace(mesh, ring0, cap0Center);
    }
    // 顶端封口（上面被宝顶压住，封一下免得俯视看见空筒）
    const cap1Center: Vec3 = [
      center1[0] - end.n[0] * crown * 0.5,
      center1[1] - end.n[1] * crown * 0.5,
      center1[2] - end.n[2] * crown * 0.5,
    ];
    tilePushFace(mesh, ring1, cap1Center);
  };

  /* ---------------- 瓦下衬板（望板） ---------------- */
  /**
   * 衬板不走自己的曲面，而是**复用瓦片的横向分格**：u 方向的顶点与瓦片是同一批，
   * 所以两者沿环向的折线完全重合 —— 从构造上就不可能出现「衬板从瓦缝里顶出来」，
   * 这比把两块曲面调容差可靠得多。
   *
   * 法向位置压在 `-(sag + 4mm)`：瓦底最低点是筒瓦中缝 `-sag`（`lift` 只会把它抬高），
   * 衬板顶面永远在它之下，两者不相交。
   *
   * 坡向另取均匀分格：屋面母线是折线，`surface(u, s)` 沿 s 做线性插值，
   * 任何分格数取到的点都落在母线上，不会外凸。
   */
  if (board > 0) {
    const boardTop = -(sag + 0.004);
    const boardBottom = boardTop - board;
    const boardRows = clamp(Math.round(courses), 6, 64);
    const sEave = margin;
    const sCrest = margin + courses * step;

    /**
     * 横向必须用**和板瓦一样的顶点**：板瓦每列取 u0 / 中点 / u1 三点（`sag` 要落在中间），
     * 折线比两根点的弦更贴曲面。衬板若只取两端，中段会高出瓦底一个矢高（约 2 mm）而顶出来。
     */
    const boardColumns = columns * 2;
    const shellGrid = (offset: number): Vec3[][] => {
      const rows: Vec3[][] = [];
      for (let r = 0; r <= boardRows; r += 1) {
        const s = sEave + ((sCrest - sEave) * r) / boardRows;
        const row: Vec3[] = [];
        for (let c = 0; c <= boardColumns; c += 1) {
          const hit = surface(c / boardColumns, s);
          row.push(shift(hit.p, hit.n, offset));
        }
        rows.push(row);
      }
      return rows;
    };

    const outer = shellGrid(boardTop);
    const inner = shellGrid(boardBottom);

    /**
     * 衬板法向同样取曲面法向：母线是折线，衬板的每个格子是平面，
     * 平着铺的时候看不出差别；翼角抬起来以后，一格一个平面法向就会让露出来的板子「一块亮一块暗」。
     */
    const boardNormals: Vec3[][] = [];
    for (let r = 0; r <= boardRows; r += 1) {
      const s = sEave + ((sCrest - sEave) * r) / boardRows;
      const row: Vec3[] = [];
      for (let c = 0; c <= boardColumns; c += 1) row.push(normalAt(c / boardColumns, s));
      boardNormals.push(row);
    }

    /** 一块板：外表面 + 内表面，朝向用这 8 个点的重心判定 */
    const boardCell = (
      outward: Vec3[],
      inward: Vec3[],
      outwardNormals: Vec3[],
      inwardNormals: Vec3[],
    ) => {
      tilePushFaceShaded(mesh, outward, outwardNormals);
      tilePushFaceShaded(mesh, inward, inwardNormals);
    };

    const down = (n: Vec3): Vec3 => [-n[0], -n[1], -n[2]];

    for (let r = 0; r < boardRows; r += 1) {
      for (let c = 0; c < boardColumns; c += 1) {
        boardCell(
          [outer[r]![c]!, outer[r]![c + 1]!, outer[r + 1]![c + 1]!, outer[r + 1]![c]!],
          [inner[r]![c]!, inner[r]![c + 1]!, inner[r + 1]![c + 1]!, inner[r + 1]![c]!],
          [
            boardNormals[r]![c]!,
            boardNormals[r]![c + 1]!,
            boardNormals[r + 1]![c + 1]!,
            boardNormals[r + 1]![c]!,
          ],
          [
            down(boardNormals[r]![c]!),
            down(boardNormals[r]![c + 1]!),
            down(boardNormals[r + 1]![c + 1]!),
            down(boardNormals[r + 1]![c]!),
          ],
        );
      }
    }
    // 檐口 / 上端的板头（沿 u 首尾重合，环向不需要封边）。
    // 板头是 10 cm 厚的窄条，**用平面法向**（逐顶点法向会把窄条抹成一条渐变色），
    // 朝向照旧由「面中心 − 板中间」判：檐口面朝下坡、上端面朝上坡，一次判对。
    for (let c = 0; c < boardColumns; c += 1) {
      const eaveFace = [outer[0]![c]!, outer[0]![c + 1]!, inner[0]![c + 1]!, inner[0]![c]!];
      const crestFace = [
        outer[boardRows]![c]!,
        outer[boardRows]![c + 1]!,
        inner[boardRows]![c + 1]!,
        inner[boardRows]![c]!,
      ];
      let cx = 0, cy = 0, cz = 0;
      for (const point of [...eaveFace, ...crestFace]) {
        cx += point[0]; cy += point[1]; cz += point[2];
      }
      const core: Vec3 = [cx / 8, cy / 8, cz / 8];
      tilePushFace(mesh, eaveFace, core);
      tilePushFace(mesh, crestFace, core);
    }
  }

  /* ---------------- 铺 ---------------- */
  if (showTiles) {
    for (let course = 0; course < courses; course += 1) {
      const eave = course === 0;
      for (let column = 0; column < columns; column += 1) {
        // 错缝：相邻两列沿坡向错开半块。瓦作里上下两列不会把横缝对成一条直线，
        // 对齐铺出来是「贴瓷砖」，错开半步才有手工瓦顶的味道。
        // 檐口那层从同一个 s 起铺 —— 瓦口要齐，不然檐边是锯齿；
        // 但它的**上沿**跟着错，否则第一道错缝就会在檐口那层和上一层之间裂开半格（漏瓦见板）。
        const stagger = (column % 2) * step * 0.5;
        const s0 = margin + course * step + (course === 0 ? 0 : stagger);
        const s1 = Math.min(length, margin + (course + 1) * step + stagger);
        boardTile(column / columns, (column + 1) / columns, s0, s1, eave);
        if (crown > 0) crownTile(column / columns, s0, s1, eave);
      }
    }
  }

  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute(mesh.pos, 3));
  geometry.setAttribute('normal', new Float32BufferAttribute(mesh.nrm, 3));
  return geometry;
}

/* ---------- 曲面修饰：偏移 / 倒圆 / 抽壳 ---------- */

/**
 * 顶点焊接后的表面拓扑。
 *
 * 三种修饰都要先回答「一个顶点周围有哪几个面」：偏移 / 抽壳把这些面的平面往里推 t，
 * 倒圆把棱角交给滚球。求值链里的几何是非索引的（normalizeSolid 的产物），
 * 同一个坐标会出现六次（每个相邻三角形一次），所以先按坐标焊接。
 */
interface SurfaceTopology {
  /** 焊接后的唯一顶点 */
  points: Vector3[];
  /** 非索引几何里每个顶点对应的焊接下标 */
  remap: Int32Array;
  /** 每个顶点相邻的不同面法向（外法向，已按 ~1.8° 去重） */
  planes: Vector3[][];
  /** 去重后的面平面（法向 + 到原点的有向距离），用来判凸 */
  faces: Array<{ normal: Vector3; offset: number }>;
}

function surfaceTopology(geometry: BufferGeometry): SurfaceTopology | null {
  const position = geometry.getAttribute('position');
  if (!position || position.count < 3) return null;
  const index = geometry.index;
  const corners = index ? index.count : position.count;
  const triangles = Math.floor(corners / 3);
  if (!triangles) return null;
  const corner = (offset: number) => (index ? index.getX(offset) : offset);

  const points: Vector3[] = [];
  const lookup = new Map<string, number>();
  const remap = new Int32Array(position.count);
  for (let i = 0; i < position.count; i += 1) {
    const x = position.getX(i);
    const y = position.getY(i);
    const z = position.getZ(i);
    // 1e-5 m = 0.01 mm 的量化，足够合并同一点、又不会把薄壁两侧粘起来
    const key = `${Math.round(x * 1e5)},${Math.round(y * 1e5)},${Math.round(z * 1e5)}`;
    let id = lookup.get(key);
    if (id === undefined) {
      id = points.length;
      lookup.set(key, id);
      points.push(new Vector3(x, y, z));
    }
    remap[i] = id;
  }

  const planes: Vector3[][] = points.map(() => []);
  const faces: SurfaceTopology['faces'] = [];
  const faceKeys = new Set<string>();
  const a = new Vector3();
  const b = new Vector3();
  const c = new Vector3();
  const normal = new Vector3();

  for (let t = 0; t < triangles; t += 1) {
    const ia = remap[corner(t * 3)]!;
    const ib = remap[corner(t * 3 + 1)]!;
    const ic = remap[corner(t * 3 + 2)]!;
    if (ia === ib || ib === ic || ic === ia) continue;
    a.copy(points[ia]!);
    b.copy(points[ib]!);
    c.copy(points[ic]!);
    normal.copy(b).sub(a).cross(c.sub(a));
    const length = normal.length();
    if (length < 1e-12) continue;
    normal.multiplyScalar(1 / length);

    for (const id of [ia, ib, ic]) {
      const list = planes[id]!;
      if (!list.some((item) => item.dot(normal) > 0.9995)) list.push(normal.clone());
    }
    const offset = normal.dot(a);
    const key = `${Math.round(normal.x * 1e3)},${Math.round(normal.y * 1e3)},${Math.round(normal.z * 1e3)},${Math.round(offset * 1e3)}`;
    if (!faceKeys.has(key)) {
      faceKeys.add(key);
      faces.push({ normal: normal.clone(), offset });
    }
  }

  return { points, remap, planes, faces };
}

/**
 * 把顶点点位整体推移 distance：正数外扩、负数内收。
 *
 * 顶点要同时落在「相邻各面都平移 distance 后的平面」上，这是个超定方程组，
 * 用最小二乘解（加一点正则项，曲面上相邻面近乎平行也不会退化）。
 * 平面棱角上正好是三面相交 → 精确解，与 CAD 的「面偏移」一致；
 * 圆柱 / 放样这类曲面处退化成沿法向偏移 → 也正是想要的（法向偏移就是曲面的偏移面）。
 */
function offsetPoints(points: Vector3[], planes: Vector3[][], distance: number): Vector3[] {
  const lambda = 1e-6;
  const matrix = new Matrix3();
  return points.map((point, i) => {
    const list = planes[i] ?? [];
    if (!list.length) return point.clone();
    // 解 M·d = b：M = Σ n nᵀ，b = Σ n·distance
    let xx = lambda;
    let xy = 0;
    let xz = 0;
    let yy = lambda;
    let yz = 0;
    let zz = lambda;
    let bx = 0;
    let by = 0;
    let bz = 0;
    for (const n of list) {
      xx += n.x * n.x;
      xy += n.x * n.y;
      xz += n.x * n.z;
      yy += n.y * n.y;
      yz += n.y * n.z;
      zz += n.z * n.z;
      bx += n.x * distance;
      by += n.y * distance;
      bz += n.z * distance;
    }
    matrix.set(xx, xy, xz, xy, yy, yz, xz, yz, zz);
    if (Math.abs(matrix.determinant()) < 1e-12) return point.clone();
    matrix.invert();
    const e = matrix.elements;
    return new Vector3(
      point.x + e[0]! * bx + e[3]! * by + e[6]! * bz,
      point.y + e[1]! * bx + e[4]! * by + e[7]! * bz,
      point.z + e[2]! * bx + e[5]! * by + e[8]! * bz,
    );
  });
}

/** 曲面偏移：返回新几何，入参不动 */
function offsetSurface(geometry: BufferGeometry, distance: number): BufferGeometry {
  const next = geometry.clone();
  if (Math.abs(distance) < 1e-6) return next;
  const topology = surfaceTopology(next);
  if (!topology) return next;
  const moved = offsetPoints(topology.points, topology.planes, distance);
  const position = next.getAttribute('position');
  for (let i = 0; i < position.count; i += 1) {
    const point = moved[topology.remap[i]!]!;
    position.setXYZ(i, point.x, point.y, point.z);
  }
  position.needsUpdate = true;
  next.computeBoundingBox();
  next.computeBoundingSphere();
  return next;
}

/** 有向体积：绕序朝外时为正 */
function meshVolume(geometry: BufferGeometry): number {
  const position = geometry.getAttribute('position');
  if (!position) return 0;
  const index = geometry.index;
  const at = (i: number) => (index ? index.getX(i) : i);
  const total = index ? index.count : position.count;
  let volume = 0;
  for (let i = 0; i + 2 < total; i += 3) {
    const a = at(i);
    const b = at(i + 1);
    const c = at(i + 2);
    const ax = position.getX(a);
    const ay = position.getY(a);
    const az = position.getZ(a);
    const bx = position.getX(b);
    const by = position.getY(b);
    const bz = position.getZ(b);
    const cx = position.getX(c);
    const cy = position.getY(c);
    const cz = position.getZ(c);
    volume += (ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx)) / 6;
  }
  return volume;
}

/**
 * 凸性判断：所有顶点都落在每个面平面的内侧。
 *
 * 倒圆的实现是「先内缩 r、再拿 r 的球滚一遍」，这个恒等式只在**凸体**上成立
 * （P ⊕ 球 = conv(各顶点球) 的前提是 P 是凸的）。非凸体上做出来会变成它的凸包，
 * 把孔、凹槽全填掉——所以宁可不做，也不能毁形。
 */
function isConvexSolid(topology: SurfaceTopology): boolean {
  if (!topology.faces.length) return false;
  const faceStride = Math.max(1, Math.ceil(topology.faces.length / 512));
  const pointStride = Math.max(1, Math.ceil(topology.points.length / 512));
  for (let f = 0; f < topology.faces.length; f += faceStride) {
    const face = topology.faces[f]!;
    for (let p = 0; p < topology.points.length; p += pointStride) {
      if (face.normal.dot(topology.points[p]!) - face.offset > 1e-4) return false;
    }
  }
  return true;
}

/**
 * 「体 ⊕ 球」：在每个顶点周围撒一圈球面点再取凸包。
 *
 * 对凸体，P ⊕ 球(r) = conv(∪ 各顶点球)，这就是精确的滚球倒圆：
 * 平面棱角变成半径 r 的圆柱面、三条棱交汇的角变成球面，整体外形尺寸不变。
 * 采样点数按顶点数分预算，避免一个 64 段圆柱算出上万个点。
 */
function ballUnion(points: Vector3[], radius: number, segmentHint: number): BufferGeometry {
  if (!points.length) return new BufferGeometry();
  const cap = Math.max(8, Math.min(64, Math.round(segmentHint)));
  const samples = clamp(Math.floor(3200 / Math.max(8, points.length)), 8, cap);
  const golden = Math.PI * (3 - Math.sqrt(5));
  const offsets: Vector3[] = [];
  for (let i = 0; i < samples; i += 1) {
    const z = 1 - (2 * i + 1) / samples;
    const ring = Math.sqrt(Math.max(0, 1 - z * z));
    const theta = golden * i;
    offsets.push(new Vector3(Math.cos(theta) * ring, Math.sin(theta) * ring, z).multiplyScalar(radius));
  }
  const cloud: Vector3[] = [];
  for (const point of points) {
    for (const offset of offsets) cloud.push(point.clone().add(offset));
  }
  try {
    return new ConvexGeometry(cloud);
  } catch {
    return new BufferGeometry();
  }
}

/** 倒圆：内缩 r → 滚球 → 外扩 r（尺寸不变，棱角变成 R） */
function filletGeometry(geometry: BufferGeometry, radius: number, segmentHint: number): BufferGeometry {
  geometry.computeBoundingBox();
  const size = geometry.boundingBox ? geometry.boundingBox.getSize(new Vector3()) : new Vector3(1, 1, 1);
  const limit = Math.min(size.x, size.y, size.z) * 0.45;
  const r = Math.min(Math.max(radius, MIN_SIZE), Math.max(MIN_SIZE, limit));
  const topology = surfaceTopology(geometry);
  if (!topology || !isConvexSolid(topology)) return geometry;
  const eroded = offsetSurface(geometry, -r);
  const inner = surfaceTopology(eroded);
  eroded.dispose();
  if (!inner) return geometry;
  const rounded = ballUnion(inner.points, r, segmentHint);
  if (isBlank(rounded)) {
    rounded.dispose();
    return geometry;
  }
  return rounded;
}

const OPEN_DIRECTIONS: Record<string, Vec3> = {
  'x+': [1, 0, 0],
  'x-': [-1, 0, 0],
  'y+': [0, 1, 0],
  'y-': [0, -1, 0],
  'z+': [0, 0, 1],
  'z-': [0, 0, -1],
};

function openDirections(open: unknown): Vec3[] {
  const list = Array.isArray(open) ? open : typeof open === 'string' ? [open] : [];
  return list
    .map((item) => OPEN_DIRECTIONS[String(item).trim().toLowerCase()])
    .filter((item): item is Vec3 => Boolean(item));
}

/**
 * 抽壳：把实体掏空，只留一层壁厚。
 *
 * inner = 曲面内收 t，再用它切一刀。开口面（open）的处理是把内腔沿该方向再平移 t
 * 补一刀——这样内腔正好穿出那个面，而其余五面的壁厚仍是 t（直接切一个「盖子」的
 * 做法会把侧壁也削掉一截，檐口就变矮了）。
 */
function shellGeometry(geometry: BufferGeometry, thickness: number, open: unknown): BufferGeometry {
  geometry.computeBoundingBox();
  const size = geometry.boundingBox ? geometry.boundingBox.getSize(new Vector3()) : new Vector3(1, 1, 1);
  const limit = Math.min(size.x, size.y, size.z) * 0.45;
  const t = Math.min(Math.max(thickness, MIN_SIZE), Math.max(MIN_SIZE, limit));
  const inner = offsetSurface(geometry, -t);

  let result = booleanGeometry(geometry.clone(), inner, 'subtract');
  if (isBlank(result)) return geometry;

  for (const dir of openDirections(open)) {
    const cutter = inner.clone();
    // 多推 5%：内腔要真的穿出外表面，否则同面共面会留下薄薄一层「膜」
    const shift = t * 1.05;
    cutter.translate(dir[0] * shift, dir[1] * shift, dir[2] * shift);
    const next = booleanGeometry(result, cutter, 'subtract');
    cutter.dispose();
    if (next === result) continue;
    if (isBlank(next)) {
      next.dispose();
      continue;
    }
    result.dispose();
    result = next;
  }
  inner.dispose();
  // 兜底：抽壳之后体积必须变小，否则说明 CSG 没切动（宁可交实心，也不能交一个假壳）
  if (Math.abs(meshVolume(result)) > Math.abs(meshVolume(geometry)) * 0.999) {
    if (result !== geometry) result.dispose();
    return geometry;
  }
  return result;
}

/** 修饰字段允许写成纯数字，也允许写成 { radius } / { thickness } / { distance } */
function modifierNumber(value: unknown, keys: string[]): number {
  if (typeof value === 'number') return finite(value, 0);
  if (value && typeof value === 'object') {
    const spec = value as Record<string, unknown>;
    for (const key of keys) {
      if (typeof spec[key] === 'number') return finite(spec[key], 0);
    }
  }
  return 0;
}

/**
 * 依次施加曲面修饰：偏移 → 倒圆 → 抽壳 →（之后才做变换 / 阵列 / 布尔）。
 *
 * 顺序与 CAD 一致：先改面（偏移），再倒棱（倒圆），最后掏空（抽壳）——
 * 掏空放在倒圆之后，内壁自然继承外侧的大圆角，不会被抽成尖角。
 */
function applySurfaceModifiers(geometry: BufferGeometry, feature: SolidFeature): BufferGeometry {
  let current = geometry;
  let changed = false;
  const swap = (next: BufferGeometry | null | undefined): void => {
    if (!next || next === current) return;
    if (isBlank(next)) {
      next.dispose();
      return;
    }
    current.dispose();
    current = next;
    changed = true;
  };

  const offset = modifierNumber(feature.offset, ['distance', 'value']);
  if (offset) swap(offsetSurface(current, offset));

  const radius = modifierNumber(feature.fillet, ['radius', 'value']);
  if (radius > 0) {
    const spec = typeof feature.fillet === 'object' && feature.fillet ? feature.fillet : undefined;
    if (feature.shape.shape === 'box') {
      // 盒体有专用构造器（平面 + 真正的 R 圆角），比滚球采样的面片干净得多
      current.computeBoundingBox();
      const size = current.boundingBox ? current.boundingBox.getSize(new Vector3()) : new Vector3(1, 1, 1);
      swap(buildRoundedBox(size.x, size.y, size.z, radius, segments(spec?.segments, 32)));
    } else {
      swap(filletGeometry(current, radius, segments(spec?.segments, 24)));
    }
  }

  const thickness = modifierNumber(feature.shell, ['thickness', 'value']);
  if (thickness > 0) {
    const open = feature.shell && typeof feature.shell === 'object'
      ? (feature.shell as { open?: unknown }).open
      : undefined;
    swap(shellGeometry(current, thickness, open));
  }

  // 修饰结果必须和形状构造一样是「非索引 + position/normal」：
  // 后续还要和别的特征 merge / CSG，属性对不齐会静默合不上。
  if (changed) current = normalizeSolid(current);
  return current;
}

/** 求值上下文：让某个特征能按 id 找到同树的瓦面曲面（见 RoofAttachment） */
export interface ShapeContext {
  roof(id: string): RoofSurface | null;
}

/**
 * sweep 贴瓦面：按参照的瓦面特征算出路径。
 *
 * 两种模式：
 * - `slope`：角上的一条线，从檐口往顶点走（戗脊、角梁）；
 * - `ring`：檐口一圈，闭口（封檐板）。
 * 偏移沿屋面外法向：负值压进瓦面之下（看不见的木构），正值浮在瓦面之上（压脊的瓦件）。
 */
function roofPathFor(attach: RoofAttachment, context: ShapeContext): Vec3[] | null {
  const roof = context.roof(attach.surface);
  if (!roof) return null;
  const offset = clamp(finite(attach.offset, 0), -2, 2);
  const samples = clamp(Math.round(finite(attach.samples, 14)), 2, 240);
  const tipLift = Math.max(0, finite(attach.tipLift, 0));

  const place = (u: number, s: number, extra = 0): Vec3 => {
    const hit = roof.surface(u, Math.max(0, s));
    const push = offset + extra;
    return [
      hit.p[0] + hit.n[0] * push,
      hit.p[1] + hit.n[1] * push,
      hit.p[2] + hit.n[2] * push,
    ];
  };

  if (attach.mode === 'ring') {
    const s = Math.max(0, finite(attach.s, 0.06));
    // 闭口环：首尾不重复，采样点均匀铺满一圈
    return Array.from({ length: samples }, (_, index) => place(index / samples, s));
  }

  const u = finite(attach.u, 0);
  const range = Array.isArray(attach.range)
    ? [finite(attach.range[0], 0), finite(attach.range[1], roof.length)]
    : [0, roof.length];
  const from = range[0]!;
  const to = range[1]!;
  const reach = Math.max(0.02, Math.abs(to - from) * 0.22);
  return Array.from({ length: samples }, (_, index) => {
    const t = samples > 1 ? index / (samples - 1) : 0;
    const s = from + (to - from) * t;
    // 翘尖：只在檐口一端抬，用平方衰减接回正常曲线，避免折出一道楞
    const falloff = Math.max(0, 1 - Math.abs(s - from) / reach);
    return place(u, s, tipLift * falloff * falloff);
  });
}

function buildShape(shape: SolidShape, context?: ShapeContext): BufferGeometry {
  switch (shape.shape) {
    case 'box': {
      const width = Math.max(MIN_SIZE, finite(shape.width, 0.2));
      const depthY = Math.max(MIN_SIZE, finite(shape.depth, 0.2));
      const height = Math.max(MIN_SIZE, finite(shape.height, 0.2));
      return new BoxGeometry(width, depthY, height);
    }
    case 'roundedBox':
      return buildRoundedBox(
        finite(shape.width, 0.2),
        finite(shape.depth, 0.2),
        finite(shape.height, 0.2),
        finite(shape.radius, 0.02),
        segments(shape.segments),
      );
    case 'cylinder': {
      const radius = Math.max(MIN_SIZE, finite(shape.radius, 0.05));
      const height = Math.max(MIN_SIZE, finite(shape.height, 0.2));
      return new CylinderGeometry(radius, radius, height, segments(shape.segments)).rotateX(Math.PI / 2);
    }
    case 'tube':
      return buildTube(
        finite(shape.radius, 0.05),
        finite(shape.thickness, 0.005),
        finite(shape.height, 0.2),
        segments(shape.segments),
      );
    case 'capsule':
      return buildCapsule(finite(shape.radius, 0.03), finite(shape.height, 0.1), segments(shape.segments));
    case 'sphere': {
      const radius = Math.max(MIN_SIZE, finite(shape.radius, 0.1));
      const seg = segments(shape.segments);
      return new SphereGeometry(radius, seg, Math.max(6, Math.round(seg / 2)));
    }
    case 'ellipsoid':
      return buildEllipsoid(
        finite(shape.rx, 0.1),
        finite(shape.ry, 0.08),
        finite(shape.rz, 0.05),
        segments(shape.segments),
      );
    case 'cone': {
      const radius = Math.max(MIN_SIZE, finite(shape.radius, 0.1));
      const topRadius = Math.max(0, finite(shape.topRadius, 0));
      const height = Math.max(MIN_SIZE, finite(shape.height, 0.2));
      return new CylinderGeometry(topRadius, radius, height, segments(shape.segments)).rotateX(Math.PI / 2);
    }
    case 'torus': {
      const radius = Math.max(MIN_SIZE, finite(shape.radius, 0.1));
      const tube = Math.max(MIN_SIZE / 2, finite(shape.tube, 0.02));
      return new TorusGeometry(radius, tube, Math.max(6, Math.round(segments(shape.tubeSegments, 12))), segments(shape.segments, 32));
    }
    case 'prism':
      return buildPrism(
        shape.profile,
        finite(shape.height, 0.2),
        finite(shape.twist, 0),
        finite(shape.taper, 1),
      );
    case 'revolve':
      return buildRevolve(shape.profile, segments(shape.segments, 48), finite(shape.angle, 360));
    case 'loft':
      return buildLoft(shape.sections);
    case 'sweep': {
      const path = shape.onRoof && context
        ? roofPathFor(shape.onRoof, context) ?? shape.path ?? []
        : shape.path ?? [];
      return buildSweep(
        shape.profile,
        path,
        Boolean(shape.closed),
        Array.isArray(shape.taper)
          ? [finite(shape.taper[0], 1), finite(shape.taper[1], 1)]
          : undefined,
      );
    }
    case 'hull':
      return buildHull(shape.points);
    case 'tiles':
      return buildTiles(shape);
    case 'group':
      // 子装配不在这里展开：材质要逐个子特征保留，交给 evaluateFeatures 递归处理
      return new BufferGeometry();
    default:
      return new BufferGeometry();
  }
}

/* ---------- 变换 / 阵列 / 布尔 ---------- */

function applyTransform(geometry: BufferGeometry, feature: SolidFeature): void {
  const scale = feature.scale;
  if (typeof scale === 'number' && Number.isFinite(scale) && Math.abs(scale) > 1e-6) {
    geometry.scale(Math.abs(scale), Math.abs(scale), Math.abs(scale));
  } else if (Array.isArray(scale)) {
    geometry.scale(
      Math.max(1e-4, Math.abs(finite(scale[0], 1))),
      Math.max(1e-4, Math.abs(finite(scale[1], 1))),
      Math.max(1e-4, Math.abs(finite(scale[2], 1))),
    );
  }
  const rotation = vec3(feature.rotate);
  const [rx, ry, rz] = rotation.map((value) => (value * Math.PI) / 180);
  if (rx) geometry.rotateX(rx);
  if (ry) geometry.rotateY(ry);
  if (rz) geometry.rotateZ(rz);
  const [tx, ty, tz] = vec3(feature.translate);
  if (tx || ty || tz) geometry.translate(tx, ty, tz);
}

function axisVector(axis: SolidPattern['axis']): Vector3 {
  if (axis === 'x') return new Vector3(1, 0, 0);
  if (axis === 'y') return new Vector3(0, 1, 0);
  return new Vector3(0, 0, 1);
}

/**
 * 翻转绕序并取反法线：给镜像用。
 *
 * 反射矩阵的行列式是负的，直接 applyMatrix4 会让三角形绕序反掉、法线朝里；
 * 把绕序掰回来、法线取反，才能继续参与合并与 CSG。
 */
function flipWinding(geometry: BufferGeometry): void {
  const index = geometry.index;
  if (index) {
    for (let offset = 0; offset + 2 < index.count; offset += 3) {
      const second = index.getX(offset + 1);
      index.setX(offset + 1, index.getX(offset + 2));
      index.setX(offset + 2, second);
    }
    index.needsUpdate = true;
  } else {
    for (const attribute of Object.values(geometry.attributes)) {
      const array = attribute.array as Float32Array;
      const size = attribute.itemSize;
      for (let vertex = 0; vertex + 2 < attribute.count; vertex += 3) {
        for (let component = 0; component < size; component += 1) {
          const a = (vertex + 1) * size + component;
          const b = (vertex + 2) * size + component;
          const swap = array[a]!;
          array[a] = array[b]!;
          array[b] = swap;
        }
      }
      attribute.needsUpdate = true;
    }
  }
  const normal = geometry.getAttribute('normal');
  if (normal) {
    for (let offset = 0; offset < normal.count; offset += 1) {
      normal.setXYZ(offset, -normal.getX(offset), -normal.getY(offset), -normal.getZ(offset));
    }
    normal.needsUpdate = true;
  }
}

/** 镜像一份几何：镜像面过 center、法向为 axis */
function mirrorGeometry(geometry: BufferGeometry, axis: SolidPattern['axis'], center: Vec3): BufferGeometry {
  const [cx, cy, cz] = center;
  const matrix = new Matrix4()
    .makeTranslation(cx, cy, cz)
    .multiply(new Matrix4().makeScale(axis === 'x' ? -1 : 1, axis === 'y' ? -1 : 1, axis === 'z' ? -1 : 1))
    .multiply(new Matrix4().makeTranslation(-cx, -cy, -cz));
  const clone = geometry.clone();
  clone.applyMatrix4(matrix);
  flipWinding(clone);
  return clone;
}

function expandPattern(geometry: BufferGeometry, pattern: SolidPattern | undefined): BufferGeometry[] {
  // 镜像恒为两份，不看 count
  if (pattern?.type === 'mirror') {
    const mirrored = mirrorGeometry(geometry, pattern.axis ?? 'y', vec3(pattern.center));
    return [geometry, mirrored];
  }
  const count = clamp(Math.round(finite(pattern?.count, 1)), 1, SOLID_LIMITS.patternCount);
  if (!pattern || count <= 1) return [geometry];
  const bodies: BufferGeometry[] = [geometry];
  const total = finite(pattern.angle, 360);
  const closed = Math.abs(total % 360) < 1e-6;
  const stepAngle = ((closed ? 360 / count : total / Math.max(1, count - 1)) * Math.PI) / 180;
  const step = vec3(pattern.step);

  for (let index = 1; index < count; index += 1) {
    const clone = geometry.clone();
    if (pattern.type === 'linear') {
      clone.translate(step[0] * index, step[1] * index, step[2] * index);
    } else {
      const [cx, cy, cz] = vec3(pattern.center);
      const matrix = new Matrix4()
        .makeTranslation(cx, cy, cz)
        .multiply(new Matrix4().makeRotationAxis(axisVector(pattern.axis), stepAngle * index))
        .multiply(new Matrix4().makeTranslation(-cx, -cy, -cz));
      clone.applyMatrix4(matrix);
    }
    bodies.push(clone);
  }
  return bodies;
}

function mergeBodies(bodies: BufferGeometry[]): BufferGeometry | null {
  if (!bodies.length) return null;
  if (bodies.length === 1) return bodies[0];
  const merged = mergeGeometries(bodies, false);
  if (merged) {
    bodies.forEach((body) => body.dispose());
    return merged;
  }
  // 属性不一致时退回逐个 CSG 并集
  let current = bodies[0];
  for (let index = 1; index < bodies.length; index += 1) {
    current = booleanGeometry(current, bodies[index], 'union');
    bodies[index].dispose();
  }
  return current;
}

/**
 * 布尔运算：用 three-bvh-csg（BVH 加速）。
 * 早期用 three-csg-ts：在细模型（上万三角形）上又慢又会切出长条碎面，
 * 换成 BVH 版之后切孔既快又干净，切除特征才能放心用。
 */
let evaluator: Evaluator | null = null;

// three-bvh-csg 仍向 three-mesh-bvh 传已弃用的 maxLeafSize，每建一个 Brush 就打一条提示，
// 编辑模型时会把控制台刷屏。只过滤这一条，其它警告照常。
let bvhNoiseMuted = false;
function muteBvhDeprecation(): void {
  if (bvhNoiseMuted) return;
  bvhNoiseMuted = true;
  const nativeWarn = console.warn.bind(console);
  console.warn = (...args: unknown[]) => {
    if (args.length === 1 && typeof args[0] === 'string' && args[0].includes('maxLeafSize')) return;
    nativeWarn(...(args as Parameters<typeof console.warn>));
  };
}

function booleanEvaluator(): Evaluator {
  if (!evaluator) {
    muteBvhDeprecation();
    evaluator = new Evaluator();
    evaluator.useGroups = false;
    evaluator.attributes = ['position', 'normal'];
  }
  return evaluator;
}

function booleanGeometry(a: BufferGeometry, b: BufferGeometry, mode: 'union' | 'subtract' | 'intersect'): BufferGeometry {
  // 注意：不在这里 dispose 入参几何，调用方可能还要复用（例如同一个刀具切多个零件）
  try {
    const brushA = new Brush(a);
    brushA.updateMatrixWorld();
    const brushB = new Brush(b);
    brushB.updateMatrixWorld();
    const result = booleanEvaluator().evaluate(
      brushA,
      brushB,
      mode === 'union' ? ADDITION : mode === 'subtract' ? SUBTRACTION : INTERSECTION,
    );
    const source = result.geometry;
    const geometry = normalizeSolid(source);
    if (geometry !== source) source.dispose();
    return geometry;
  } catch {
    // 布尔失败时保守处理：并集退化合并，切除/相交保持原样
    if (mode === 'union') {
      const merged = mergeGeometries([a, b], false);
      if (merged) return merged;
    }
    return a;
  }
}

function boundsOf(geometry: BufferGeometry): Box3 {
  if (!geometry.boundingBox) geometry.computeBoundingBox();
  return geometry.boundingBox ?? new Box3();
}

/** 布尔结果把包围盒切塌了 → 判定 CSG 失败，宁可留料也不要把整个模型切碎 */
function looksIntact(before: Box3, geometry: BufferGeometry): boolean {
  const sizeBefore = before.getSize(new Vector3());
  const sizeAfter = boundsOf(geometry).getSize(new Vector3());
  const volumeBefore = Math.max(1e-12, sizeBefore.x * sizeBefore.y * sizeBefore.z);
  const volumeAfter = sizeAfter.x * sizeAfter.y * sizeAfter.z;
  return volumeAfter > volumeBefore * 0.35;
}

/** 零件：几何 + 材质槽号（-1 表示跟随构件材质） */
interface Part {
  geometry: BufferGeometry;
  material: number;
}

/** 材质表：整棵树共用的材质槽，取值相同的材质合并成一槽（渲染时一个材质槽 = 一个 draw group） */
interface MaterialTable {
  list: SolidMaterial[];
}

/**
 * 材质槽分配。接受完整材质对象，也接受预设名字符串（模板库与 AI 都爱写 "aluminum"）：
 * 字符串在这里展开成完整参数后再分组，渲染端拿到的永远是具体色值。
 */
function slotOf(table: MaterialTable, material: SolidMaterial | string | undefined): number {
  if (!material) return -1;
  const resolved = typeof material === 'string' ? resolveSolidMaterial(material).material : material;
  if (!resolved) return -1;
  const key = solidMaterialKey(resolved);
  if (!key) return -1;
  const found = table.list.findIndex((item) => solidMaterialKey(item) === key);
  if (found >= 0) return found;
  table.list.push(resolved);
  return table.list.length - 1;
}

/**
 * 切除：只对「与刀具包围盒相交」的零件单独做布尔。
 *
 * 直接在大网格（细模型轻松上万三角形）上跑 BSP-CSG 又慢又容易炸；
 * 零件各自只有几百到一两千三角形，逐个切的结果一样，代价低一个数量级。
 * 材质跟着零件走，所以切除不会把整块模型刷成同一个颜色。
 */
function subtractFromParts(parts: Part[], cutter: BufferGeometry): Part[] {
  const cutterBounds = boundsOf(cutter);
  const result: Part[] = [];
  for (const part of parts) {
    const partBounds = boundsOf(part.geometry);
    if (!partBounds.intersectsBox(cutterBounds)) {
      result.push(part);
      continue;
    }
    const tool = cutter.clone();
    const next = booleanGeometry(part.geometry, tool, 'subtract');
    tool.dispose();
    if (next === part.geometry || isBlank(next) || !looksIntact(partBounds, next)) {
      if (next !== part.geometry) next.dispose();
      result.push(part);
      continue;
    }
    part.geometry.dispose();
    result.push({ geometry: next, material: part.material });
  }
  return result;
}

/* ---------- 特征树求值 ---------- */

/** 变换 + 阵列：返回合并好的单个几何（入参几何会被合并/释放） */
function instanceOf(geometry: BufferGeometry, feature: SolidFeature): BufferGeometry | null {
  applyTransform(geometry, feature);
  return mergeBodies(expandPattern(geometry, feature.pattern));
}

/**
 * 按特征树求值出「零件集合」。第一个特征建立基础实体，后续特征按 mode 与之布尔。
 *
 * 零件在求值期间不合并：切除只作用在相交的零件上，而且材质信息挂在零件上，
 * 合并推迟到最后一次（assembleParts），这样逐零件材质、几十个特征的精细模型都能兼顾。
 */
function evaluateFeatures(
  features: SolidFeature[],
  depth: number,
  table: MaterialTable,
  inherited = -1,
  context?: ShapeContext,
): Part[] {
  const list = (Array.isArray(features) ? features : []).slice(0, depth ? SOLID_LIMITS.nestedFeatures : SOLID_LIMITS.features);
  let parts: Part[] = [];
  let bodies = 0;

  for (const feature of list) {
    if (!feature || typeof feature !== 'object' || !feature.shape) continue;
    const material = feature.material ? slotOf(table, feature.material) : inherited;

    // 子装配：递归求值，子特征各自的材质保留；整组的变换 / 阵列再作用到每个子零件
    if (feature.shape.shape === 'group') {
      if (depth >= 4) continue;
      bodies += 1;
      if (bodies > SOLID_LIMITS.bodies) break;
      for (const child of evaluateFeatures(feature.shape.features, depth + 1, table, material, context)) {
        const geometry = instanceOf(child.geometry, feature);
        if (geometry) parts.push({ geometry, material: child.material });
      }
      continue;
    }

    let shapeGeometry = normalizeSolid(buildShape(feature.shape, context));
    if (isBlank(shapeGeometry)) {
      shapeGeometry.dispose();
      continue;
    }
    shapeGeometry = applySurfaceModifiers(shapeGeometry, feature);
    const merged = instanceOf(shapeGeometry, feature);
    if (!merged) continue;

    bodies += 1;
    if (bodies > SOLID_LIMITS.bodies) {
      merged.dispose();
      break;
    }

    if (!parts.length) {
      parts = [{ geometry: merged, material }];
      continue;
    }

    const mode = feature.mode ?? 'add';
    if (mode === 'cut') {
      parts = subtractFromParts(parts, merged);
      merged.dispose();
    } else if (mode === 'intersect') {
      const keptMaterial = material >= 0 ? material : parts[0].material;
      const whole = mergeBodies(parts.map((part) => part.geometry)) ?? new BufferGeometry();
      parts = [];
      const next = booleanGeometry(whole, merged, 'intersect');
      whole.dispose();
      merged.dispose();
      if (!isBlank(next)) parts = [{ geometry: next, material: keptMaterial }];
      else next.dispose();
    } else {
      parts.push({ geometry: merged, material });
    }
  }

  return parts;
}

/** 造型求值结果：几何（带材质分组）+ 材质表（null = 跟随构件材质） */
export interface SolidBuild {
  geometry: BufferGeometry;
  materials: Array<SolidMaterial | null>;
}

function triangleCountOf(geometry: BufferGeometry): number {
  return geometry.index ? geometry.index.count : geometry.getAttribute('position').count;
}

/**
 * 把零件合并成最终实体，并按材质槽建立 geometry.groups。
 *
 * three 的多材质渲染靠 groups 的 materialIndex 指向 material 数组；
 * 这里每个材质槽合并成一块几何，再用 mergeGeometries(useGroups=true) 拼起来，
 * 最后把「数组下标」改写成真正的材质槽号。
 */
function assembleParts(parts: Part[], table: MaterialTable): SolidBuild {
  const buckets = new Map<number, BufferGeometry[]>();
  for (const part of parts) {
    const list = buckets.get(part.material);
    if (list) list.push(part.geometry);
    else buckets.set(part.material, [part.geometry]);
  }

  const geometries: BufferGeometry[] = [];
  const slots: number[] = [];
  for (const [slot, list] of [...buckets.entries()].sort((a, b) => a[0] - b[0])) {
    const merged = mergeBodies(list);
    if (!merged) continue;
    geometries.push(merged);
    slots.push(slot);
  }
  if (!geometries.length) return { geometry: new BufferGeometry(), materials: [] };

  const materials: Array<SolidMaterial | null> = [...table.list];
  let inheritSlot = -1;
  if (slots.includes(-1)) {
    inheritSlot = materials.length;
    materials.push(null);
  }
  const slotToMaterial = (slot: number) => (slot < 0 ? inheritSlot : slot);

  let geometry: BufferGeometry;
  if (geometries.length === 1) {
    geometry = geometries[0];
    const index = slotToMaterial(slots[0]);
    // 单材质且槽号是 0 时不用分组，renderer 直接用材质表第一个
    if (materials.length > 1 || index !== 0) geometry.addGroup(0, triangleCountOf(geometry), index);
  } else {
    const merged = mergeGeometries(geometries, true);
    if (merged) {
      geometries.forEach((item) => item.dispose());
      merged.groups.forEach((group, order) => {
        group.materialIndex = slotToMaterial(slots[order] ?? -1);
      });
      geometry = merged;
    } else {
      // 属性极少数情况下对不齐：退化成单材质（形状完整，只是颜色统一）
      geometry = mergeBodies(geometries) ?? new BufferGeometry();
      materials.length = 0;
      materials.push(null);
      geometry.clearGroups();
    }
  }

  // 只在缺失法线时补：形状自带的平滑法线（圆柱 / 放样 / 圆角）不能被面法线覆盖，
  // 否则所有曲面都会被「平面化」，这是早期造型看起来分面粗糙的主要原因。
  if (!geometry.getAttribute('normal')) geometry.computeVertexNormals();
  geometry.computeBoundingSphere();
  geometry.computeBoundingBox();
  return { geometry, materials };
}

/**
 * 收集整棵树里所有瓦面特征的曲面，供 sweep 的 `onRoof` 按 id 取用。
 *
 * 只看 id：同一棵树里瓦面不重名。瓦面若被放在 group 里并带变换，这里不做补偿
 * —— 目前的做法是瓦面直接挂在顶层，够用且不会悄悄算错。
 */
function collectRoofs(features: SolidFeature[], map: Map<string, RoofSurface>): void {
  for (const feature of Array.isArray(features) ? features : []) {
    if (!feature || typeof feature !== 'object' || !feature.shape) continue;
    if (feature.shape.shape === 'group') {
      collectRoofs(feature.shape.features, map);
      continue;
    }
    if (feature.shape.shape !== 'tiles' || !feature.id) continue;
    const roof = roofSurfaceOf(feature.shape);
    if (roof) map.set(feature.id, roof);
  }
}

/** 按特征树求值出实体（含逐特征材质） */
export function buildSolidModel(features: SolidFeature[]): SolidBuild {
  const table: MaterialTable = { list: [] };
  const roofs = new Map<string, RoofSurface>();
  collectRoofs(features, roofs);
  const context: ShapeContext = { roof: (id: string) => roofs.get(id) ?? null };
  return assembleParts(evaluateFeatures(features, 0, table, -1, context), table);
}

/** 按特征树求值出实体几何（局部坐标，Z-up，单位米）。不需要材质时用这个。 */
export function buildSolidGeometry(features: SolidFeature[]): BufferGeometry {
  return buildSolidModel(features).geometry;
}

/** 一个特征的零件几何（变换 / 阵列已应用，材质只是槽号） */
export interface SolidPartGeometry {
  id: string;
  material: number;
  geometry: BufferGeometry;
}

/**
 * 逐特征的零件几何，**共用整棵树的屋面上下文**。
 *
 * 用途是诊断：想知道「哪个构件穿了哪个」，就得把每个特征单独拿出来量。
 * 关键点是 `onRoof` 贴面必须仍然能解析到瓦面 —— 如果按 `[feature]` 单独求值，
 * 上下文里就没有 `pv-tiles`，`roofPathFor` 会退回硬编码 path，量出来的全是假数据。
 *
 * 注意：布尔（`mode: cut / intersect`）不在这条路径上求值，这里看的是原始零件。
 */
export function buildSolidParts(features: SolidFeature[]): SolidPartGeometry[] {
  const roofs = new Map<string, RoofSurface>();
  collectRoofs(features, roofs);
  const context: ShapeContext = { roof: (id: string) => roofs.get(id) ?? null };
  const parts: SolidPartGeometry[] = [];
  for (const feature of Array.isArray(features) ? features : []) {
    if (!feature?.shape) continue;
    const table: MaterialTable = { list: [] };
    for (const part of evaluateFeatures([feature], 0, table, -1, context)) {
      parts.push({ id: feature.id, material: part.material, geometry: part.geometry });
    }
  }
  return parts;
}

/** 特征数量（含嵌套组），用于界面与统计 */
export function countSolidFeatures(features: SolidFeature[]): number {
  let total = 0;
  for (const feature of Array.isArray(features) ? features : []) {
    total += 1;
    if (feature?.shape?.shape === 'group') total += countSolidFeatures(feature.shape.features);
  }
  return total;
}

/** 三角形数量上限估算，供界面提示 */
export function solidTriangleCount(features: SolidFeature[]): number {
  const geometry = buildSolidGeometry(features);
  const count = Math.floor((geometry.index?.count ?? geometry.getAttribute('position').count) / 3);
  geometry.dispose();
  return count;
}

/* ---------- 界面：标签与可编辑字段 ---------- */

export const SOLID_SHAPE_LABELS: Record<SolidShape['shape'], string> = {
  box: '长方体',
  roundedBox: '圆角盒',
  cylinder: '圆柱',
  tube: '圆管',
  capsule: '胶囊',
  sphere: '球',
  ellipsoid: '椭球',
  cone: '圆锥 / 圆台',
  torus: '圆环',
  prism: '拉伸轮廓',
  revolve: '旋转体',
  loft: '放样',
  sweep: '扫掠',
  hull: '凸包',
  tiles: '瓦面',
  group: '子装配',
};

export interface SolidField {
  key: string;
  label: string;
  value: number;
  min: number;
  step: number;
  unit: 'm' | '°' | '';
}

export interface SolidFieldGroup {
  title: string;
  fields: SolidField[];
}

function lengthField(key: string, label: string, value: number, min = 0.001): SolidField {
  return { key, label, value, min, step: 0.01, unit: 'm' };
}

function countField(key: string, label: string, value: number, min: number, max: number): SolidField {
  return { key, label, value: clamp(Math.round(value), min, max), min, step: 1, unit: '' };
}

function angleField(key: string, label: string, value: number): SolidField {
  return { key, label, value, min: -3600, step: 5, unit: '°' };
}

/** 特征的可编辑数值字段（按「尺寸 / 位置 / 旋转 / 阵列」分组） */
export function solidFeatureGroups(feature: SolidFeature): SolidFieldGroup[] {
  const groups: SolidFieldGroup[] = [];
  const shape = feature.shape;
  const size: SolidField[] = [];
  switch (shape.shape) {
    case 'box':
      size.push(
        lengthField('shape.width', '宽 X', shape.width),
        lengthField('shape.depth', '深 Y', shape.depth),
        lengthField('shape.height', '高 Z', shape.height),
      );
      break;
    case 'roundedBox':
      size.push(
        lengthField('shape.width', '宽 X', shape.width),
        lengthField('shape.depth', '深 Y', shape.depth),
        lengthField('shape.height', '高 Z', shape.height),
        lengthField('shape.radius', '倒圆半径', shape.radius),
        countField('shape.segments', '分段', finite(shape.segments, 32), 6, SOLID_LIMITS.segments),
      );
      break;
    case 'tube':
      size.push(
        lengthField('shape.radius', '外半径', shape.radius),
        lengthField('shape.thickness', '壁厚', shape.thickness),
        lengthField('shape.height', '高', shape.height),
        countField('shape.segments', '分段', finite(shape.segments, 32), 6, SOLID_LIMITS.segments),
      );
      break;
    case 'capsule':
      size.push(
        lengthField('shape.radius', '半径', shape.radius),
        lengthField('shape.height', '总高', shape.height),
        countField('shape.segments', '分段', finite(shape.segments, 32), 6, SOLID_LIMITS.segments),
      );
      break;
    case 'ellipsoid':
      size.push(
        lengthField('shape.rx', '半径 X', shape.rx),
        lengthField('shape.ry', '半径 Y', shape.ry),
        lengthField('shape.rz', '半径 Z', shape.rz),
        countField('shape.segments', '分段', finite(shape.segments, 32), 6, SOLID_LIMITS.segments),
      );
      break;
    case 'hull':
      size.push(countField('shape.points', '点数', shape.points.length, 4, SOLID_LIMITS.hullPoints));
      break;
    case 'cylinder':
    case 'sphere':
      size.push(lengthField('shape.radius', '半径', shape.radius));
      if (shape.shape === 'cylinder') size.push(lengthField('shape.height', '高', shape.height));
      size.push(countField('shape.segments', '分段', finite(shape.segments, 24), 6, SOLID_LIMITS.segments));
      break;
    case 'cone':
      size.push(
        lengthField('shape.radius', '底半径', shape.radius),
        lengthField('shape.topRadius', '顶半径', finite(shape.topRadius, 0), 0),
        lengthField('shape.height', '高', shape.height),
        countField('shape.segments', '分段', finite(shape.segments, 24), 6, SOLID_LIMITS.segments),
      );
      break;
    case 'torus':
      size.push(
        lengthField('shape.radius', '环半径', shape.radius),
        lengthField('shape.tube', '管半径', shape.tube),
        countField('shape.segments', '环分段', finite(shape.segments, 32), 6, SOLID_LIMITS.segments),
        countField('shape.tubeSegments', '管分段', finite(shape.tubeSegments, 12), 6, SOLID_LIMITS.segments),
      );
      break;
    case 'prism':
      size.push(
        lengthField('shape.height', '拉伸高度', shape.height),
        angleField('shape.twist', '扭转', finite(shape.twist, 0)),
        { key: 'shape.taper', label: '顶面缩放', value: finite(shape.taper, 1), min: 0.02, step: 0.05, unit: '' },
      );
      break;
    case 'revolve':
      size.push(
        countField('shape.segments', '旋转分段', finite(shape.segments, 48), 6, SOLID_LIMITS.segments),
        angleField('shape.angle', '旋转角度', finite(shape.angle, 360)),
      );
      break;
    case 'loft':
      size.push(countField('shape.segments', '截面数', shape.sections.length, 2, SOLID_LIMITS.features));
      break;
    case 'sweep':
      size.push(countField('shape.segments', '路径点数', shape.path?.length ?? 0, 2, SOLID_LIMITS.points));
      break;
    case 'tiles':
      size.push(
        countField('shape.rows', '每面瓦列', finite(shape.rows, 9), 2, 24),
        countField('shape.courses', '叠瓦层数', finite(shape.courses, 12), 2, 40),
        lengthField('shape.crown', '筒瓦半径', finite(shape.crown, 0.05), 0),
        lengthField('shape.thickness', '瓦厚', finite(shape.thickness, 0.014), 0.002),
        lengthField('shape.lift', '叠压台阶', finite(shape.lift, 0.012), 0),
        lengthField('shape.sag', '板瓦内凹', finite(shape.sag, 0.012), 0),
        lengthField('shape.cornerLift', '角部起翘', finite(shape.cornerLift, 0), 0),
        { key: 'shape.cornerOut', label: '角部外挑', value: finite(shape.cornerOut, 0), min: 0, step: 0.02, unit: '' },
      );
      break;
    case 'group':
      size.push(countField('shape.segments', '子特征数', shape.features.length, 1, SOLID_LIMITS.nestedFeatures));
      break;
    default:
      break;
  }
  if (size.length) groups.push({ title: '尺寸', fields: size });

  // 曲面修饰：只有写了才出现，避免每个特征都挂三个 0
  const offsetValue = modifierNumber(feature.offset, ['distance', 'value']);
  const filletValue = modifierNumber(feature.fillet, ['radius', 'value']);
  const shellValue = modifierNumber(feature.shell, ['thickness', 'value']);
  const modifiers: SolidField[] = [];
  if (offsetValue) modifiers.push(lengthField('offset.distance', '曲面偏移', offsetValue, 0));
  if (filletValue) modifiers.push(lengthField('fillet.radius', '倒圆半径', filletValue));
  if (shellValue) modifiers.push(lengthField('shell.thickness', '抽壳壁厚', shellValue));
  if (modifiers.length) groups.push({ title: '曲面修饰（米）', fields: modifiers });

  const translate = vec3(feature.translate);
  groups.push({
    title: '位置（米）',
    fields: [
      lengthField('translate.x', 'X', translate[0], -1e4),
      lengthField('translate.y', 'Y', translate[1], -1e4),
      lengthField('translate.z', 'Z', translate[2], -1e4),
    ],
  });

  const rotate = vec3(feature.rotate);
  groups.push({
    title: '旋转（度）',
    fields: [
      angleField('rotate.x', '绕 X', rotate[0]),
      angleField('rotate.y', '绕 Y', rotate[1]),
      angleField('rotate.z', '绕 Z', rotate[2]),
    ],
  });

  if (feature.pattern && feature.pattern.type !== 'mirror') {
    const step = vec3(feature.pattern.step);
    const fields: SolidField[] = [
      countField('pattern.count', '数量', finite(feature.pattern.count, 2), 1, SOLID_LIMITS.patternCount),
    ];
    if (feature.pattern.type === 'linear') {
      fields.push(
        lengthField('pattern.step.x', '步距 X', step[0], -1e4),
        lengthField('pattern.step.y', '步距 Y', step[1], -1e4),
        lengthField('pattern.step.z', '步距 Z', step[2], -1e4),
      );
    } else {
      fields.push(angleField('pattern.angle', '总角度', finite(feature.pattern.angle, 360)));
    }
    groups.push({ title: feature.pattern.type === 'linear' ? '线性阵列' : '圆周阵列', fields });
  }

  return groups;
}

function setVecComponent(vector: Vec3 | undefined, axis: string, value: number): Vec3 {
  const next = vec3(vector);
  if (axis === 'x') next[0] = value;
  else if (axis === 'y') next[1] = value;
  else if (axis === 'z') next[2] = value;
  return next;
}

/** 按字段 key 更新特征；返回新对象，不改入参 */
export function updateSolidFeatureField(feature: SolidFeature, key: string, value: number): SolidFeature {
  if (!Number.isFinite(value)) return feature;
  const [group, field, axis] = key.split('.');

  if (group === 'translate' && field) {
    return { ...feature, translate: setVecComponent(feature.translate, field, value) };
  }
  if (group === 'rotate' && field) {
    return { ...feature, rotate: setVecComponent(feature.rotate, field, value) };
  }
  if (group === 'scale') {
    return { ...feature, scale: Math.max(1e-3, Math.abs(value)) };
  }
  if (group === 'offset' && field === 'distance') {
    // 归零 = 去掉这个修饰（否则每次求值都白跑一遍偏移）
    return { ...feature, offset: Math.abs(value) < 1e-6 ? undefined : value };
  }
  if (group === 'fillet' && field === 'radius') {
    const base = typeof feature.fillet === 'object' && feature.fillet ? feature.fillet : {};
    return { ...feature, fillet: { ...base, radius: Math.max(1e-4, Math.abs(value)) } };
  }
  if (group === 'shell' && field === 'thickness') {
    const base = typeof feature.shell === 'object' && feature.shell ? feature.shell : {};
    return { ...feature, shell: { ...base, thickness: Math.max(1e-4, Math.abs(value)) } };
  }
  if (group === 'pattern' && feature.pattern) {
    if (field === 'count') {
      return { ...feature, pattern: { ...feature.pattern, count: clamp(Math.round(value), 1, SOLID_LIMITS.patternCount) } };
    }
    if (field === 'angle') {
      return { ...feature, pattern: { ...feature.pattern, angle: value } };
    }
    if (field === 'step' && axis) {
      return { ...feature, pattern: { ...feature.pattern, step: setVecComponent(feature.pattern.step, axis, value) } };
    }
    return feature;
  }
  if (group !== 'shape') return feature;

  const shape = feature.shape as unknown as Record<string, unknown>;
  if (!(field in shape)) return feature;
  if (field === 'segments' || field === 'tubeSegments') {
    return { ...feature, shape: { ...feature.shape, [field]: clamp(Math.round(value), 6, SOLID_LIMITS.segments) } };
  }
  if (field === 'taper') {
    return { ...feature, shape: { ...feature.shape, taper: clamp(value, 0.02, 20) } as SolidShape };
  }
  if (field === 'twist' || field === 'angle') {
    return { ...feature, shape: { ...feature.shape, [field]: value } as SolidShape };
  }
  if (field === 'topRadius') {
    return { ...feature, shape: { ...feature.shape, topRadius: Math.max(0, value) } as SolidShape };
  }
  const fieldSpec = solidFeatureGroups(feature)
    .flatMap((groupItem) => groupItem.fields)
    .find((item) => item.key === key);
  const min = fieldSpec?.min ?? 0.001;
  return { ...feature, shape: { ...feature.shape, [field]: Math.max(min, value) } as SolidShape };
}

/** 新建空特征（默认一块 0.2 m 立方） */
export function createSolidFeature(shape: SolidShape, options: Partial<SolidFeature> = {}): SolidFeature {
  return {
    id: options.id ?? `feature-${Math.random().toString(36).slice(2, 9)}`,
    label: options.label,
    mode: options.mode ?? 'add',
    translate: options.translate,
    rotate: options.rotate,
    scale: options.scale,
    pattern: options.pattern,
    shape,
  };
}
