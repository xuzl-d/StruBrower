/**
 * 球面皮革拼块（ballPanels）：把「缝制球」做成**真几何**，而不是一张贴图。
 *
 * 为什么要有这个形状：贴图 / bumpMap 只能在球面上画明暗，缝永远是画上去的；
 * 光照、掠射角、阴影都不随几何变化。这里每一块皮都是独立的封闭薄壳：
 *   - 外表面是球面多边形，中心微微鼓起（充气皮革的弧度）；
 *   - 边沿沿球面内缩 seam/2，相邻两块之间因此留出**真实的空隙**；
 *   - 侧壁从外缘斜切到内表面，缝壁有真实厚度和自己的法线；
 *   - 缝底是一颗半径更小的内胆球，从缝里看得见，形成真实深度。
 *
 * 面划分用「加权球面 Voronoi」：score(d) = dot(d, n) / h 最大者获胜，
 * 等价于从球心沿方向 d 先打到哪一块皮。三面等分方向就是多边形角点，
 * 所以边界天然连成完整网格，不会像平面贴片那样在球面上穿帮。
 *
 * 只输出 position + normal，且全部是 non-indexed 三角形 —— 与内核
 * normalizeSolid / mergeGeometries 的属性约定一致，多材质槽不会退化。
 */

import { BufferGeometry, Float32BufferAttribute, SphereGeometry } from 'three';

type Vec3 = [number, number, number];

/** 传给几何内核的形状参数（服务端会先归一化，这里仍做兜底，模板/手写文档也能用） */
export interface BallPanelsParams {
  shape?: 'ballPanels';
  /** 皮革外缘的球半径（米）。块中心最高点是 radius + bulge */
  radius: number;
  /** pentagons = 12 块全五边形（黑白都五边形）；classic = 12 黑五边形 + 20 白六边形 */
  layout?: 'pentagons' | 'classic' | string;
  /** 两块皮之间的缝宽（米，沿球面弧长量） */
  seam?: number;
  /** 皮革厚度（米），也是缝的深度 */
  thickness?: number;
  /** 每块皮中心相对外缘的鼓起量（米） */
  bulge?: number;
  /** 每条多边形边的球面细分数（6~64） */
  segments?: number;
  /** 从块心到边界的径向分层数，越大越圆滑 */
  rings?: number;
  /** pentagons 布局下黑色块数（0~12），默认 3（正十二面体最多只有 3 个面能两两不相邻） */
  darkCount?: number;
}

export type BallPanelRole = 'light' | 'dark' | 'core';

/** 手写文档 / 模板没给颜色时的兜底：白皮、黑皮、缝底内胆 */
export const DEFAULT_PANEL_MATERIALS = {
  light: { name: '白色皮革', color: '#f1eee5', roughness: 0.82, metalness: 0 },
  dark: { name: '黑色皮革', color: '#191c22', roughness: 0.8, metalness: 0 },
  core: { name: '缝底内胆', color: '#0b0d10', roughness: 0.95, metalness: 0 },
} as const;

export interface BallPanelPart {
  role: BallPanelRole;
  geometry: BufferGeometry | null;
}

interface Face {
  n: Vec3;
  /** 加权 Voronoi 的权重：越大这块皮越小 */
  h: number;
  dark: boolean;
  corners: Vec3[];
}

/* ---------- 向量 ---------- */

const finite = (value: unknown, fallback: number): number =>
  typeof value === 'number' && Number.isFinite(value) ? value : fallback;

const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));

const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const mul = (a: Vec3, k: number): Vec3 => [a[0] * k, a[1] * k, a[2] * k];
const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const length = (a: Vec3): number => Math.hypot(a[0], a[1], a[2]);

function unit(a: Vec3): Vec3 {
  const l = length(a);
  return l > 1e-12 ? mul(a, 1 / l) : [0, 0, 1];
}

const mix = (a: Vec3, b: Vec3, t: number): Vec3 => add(mul(a, 1 - t), mul(b, t));

/** 球面线性插值：沿大圆走，保证中间点仍严格落在单位球面上 */
function slerp(a: Vec3, b: Vec3, t: number): Vec3 {
  const cosine = clamp(dot(a, b), -1, 1);
  const omega = Math.acos(cosine);
  if (omega < 1e-7) return unit(mix(a, b, t));
  const sin = Math.sin(omega);
  return unit(add(mul(a, Math.sin((1 - t) * omega) / sin), mul(b, Math.sin(t * omega) / sin)));
}

/* ---------- 三角形收集器 ---------- */

/**
 * 逐三角形收集顶点与法线，并自动校正绕序：
 * 几何面法线与期望的着色法线反向时交换两个顶点，保证 FrontSide 不会被剔掉。
 * 这样生成网格时不必为每圈环的顺序纠结，法线永远是想要的那面。
 */
class TriMesh {
  private readonly positions: number[] = [];
  private readonly normals: number[] = [];

  triangle(a: Vec3, b: Vec3, c: Vec3, na: Vec3, nb: Vec3, nc: Vec3): void {
    const geometric = cross(sub(b, a), sub(c, a));
    const expected = add(add(na, nb), nc);
    let pb = b;
    let pc = c;
    let pnb = nb;
    let pnc = nc;
    if (dot(geometric, expected) < 0) {
      pb = c;
      pc = b;
      pnb = nc;
      pnc = nb;
    }
    for (const [p, n] of [[a, na], [pb, pnb], [pc, pnc]] as Array<[Vec3, Vec3]>) {
      this.positions.push(p[0], p[1], p[2]);
      this.normals.push(n[0], n[1], n[2]);
    }
  }

  get triangles(): number {
    return this.positions.length / 9;
  }

  toGeometry(): BufferGeometry | null {
    if (!this.positions.length) return null;
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new Float32BufferAttribute(this.positions, 3));
    geometry.setAttribute('normal', new Float32BufferAttribute(this.normals, 3));
    return geometry;
  }
}

/* ---------- 面划分 ---------- */

const GOLDEN = (1 + Math.sqrt(5)) / 2;
/** 截角二十面体里五边形 / 六边形面的权重比，来自外接球几何 */
const CLASSIC_PENTAGON_H = 1.0264;

/** 正二十面体 12 个顶点方向 = 正十二面体 12 个五边形面的法向 */
function icosahedronDirections(): Vec3[] {
  const raw: Vec3[] = [];
  for (const a of [-1, 1]) {
    for (const b of [-1, 1]) {
      raw.push([0, a, b * GOLDEN], [a, b * GOLDEN, 0], [a * GOLDEN, 0, b]);
    }
  }
  return raw.map(unit);
}

/** 正二十面体 20 个三角面的中心方向 = 截角二十面体 20 个六边形面的法向 */
function icosahedronFaceCenters(vertices: Vec3[]): Vec3[] {
  const centers: Vec3[] = [];
  const neighborDot = 1 / Math.sqrt(5); // 二十面体相邻顶点的点积
  for (let i = 0; i < vertices.length; i += 1) {
    for (let j = i + 1; j < vertices.length; j += 1) {
      for (let k = j + 1; k < vertices.length; k += 1) {
        const [a, b, c] = [vertices[i]!, vertices[j]!, vertices[k]!];
        if (Math.abs(dot(a, b) - neighborDot) > 0.01) continue;
        if (Math.abs(dot(a, c) - neighborDot) > 0.01) continue;
        if (Math.abs(dot(b, c) - neighborDot) > 0.01) continue;
        centers.push(unit(add(add(a, b), c)));
      }
    }
  }
  // 浮点误差会让同一个面心被凑出两次（不同顶点顺序），按方向去重
  const unique: Vec3[] = [];
  for (const center of centers) {
    if (!unique.some((item) => dot(item, center) > 1 - 1e-9)) unique.push(center);
  }
  return unique;
}

/** 给选黑块一个稳定的顺序：按四面体方向打分，避免依赖顶点数组本身的下标顺序 */
const TETRAHEDRON: Vec3[] = [
  unit([1, 1, 1]),
  unit([1, -1, -1]),
  unit([-1, 1, -1]),
  unit([-1, -1, 1]),
];

function buildFaces(layout: string): Face[] {
  const ico = icosahedronDirections();
  if (layout === 'classic') {
    const hexagons = icosahedronFaceCenters(ico);
    return [
      ...ico.map((n) => ({ n, h: CLASSIC_PENTAGON_H, dark: true, corners: [] })),
      ...hexagons.map((n) => ({ n, h: 1, dark: false, corners: [] })),
    ];
  }
  return ico.map((n) => ({ n, h: 1, dark: false, corners: [] }));
}

/**
 * 求加权球面 Voronoi 的角点：三个面同时等分的方向 d 满足
 * dot(d, n_i/h_i - n_j/h_j) = 0 与 dot(d, n_i/h_i - n_k/h_k) = 0，
 * 所以 d ∥ cross(差向量1, 差向量2)。再验证它确实是全场的胜者，
 * 才能排除「三面共线但另有一面更近」的伪角点。
 */
function assignCorners(faces: Face[]): void {
  const weighted = faces.map((face) => mul(face.n, 1 / face.h));
  for (let i = 0; i < faces.length; i += 1) {
    for (let j = i + 1; j < faces.length; j += 1) {
      for (let k = j + 1; k < faces.length; k += 1) {
        const normal = cross(sub(weighted[i]!, weighted[j]!), sub(weighted[i]!, weighted[k]!));
        if (length(normal) < 1e-9) continue;
        let d = unit(normal);
        if (dot(d, faces[i]!.n) < 0) d = mul(d, -1);
        const score = dot(d, weighted[i]!);
        if (score <= 0) continue;
        let winner = true;
        for (const w of weighted) {
          if (dot(d, w) > score + 1e-7) {
            winner = false;
            break;
          }
        }
        if (!winner) continue;
        for (const index of [i, j, k]) {
          const bucket = faces[index]!.corners;
          if (!bucket.some((item) => dot(item, d) > 1 - 1e-10)) bucket.push(d);
        }
      }
    }
  }
}

/** 两面共享两个角点 = 共享一条边 = 相邻 */
function facesAdjacent(a: Face, b: Face): boolean {
  let shared = 0;
  for (const corner of a.corners) {
    if (b.corners.some((other) => dot(corner, other) > 1 - 1e-8)) shared += 1;
    if (shared >= 2) return true;
  }
  return false;
}

/**
 * pentagons 布局下挑黑块：优先取**互不相邻**的一组（经典足球黑五边形彼此不挨着）。
 * 12 个五边形与正四面体方向的最大点积全都相等，直接按打分取前 N 个会退化成
 * 顶点数组顺序，选出一串连片的黑块；必须按真实邻接关系做贪心独立集。
 * darkCount 超过独立集上限时才允许补相邻面。
 */
function chooseDarkFaces(faces: Face[], darkCount: number): void {
  const target = clamp(Math.round(darkCount), 0, faces.length);
  const order = faces
    .map((face, index) => ({ index, score: Math.max(...TETRAHEDRON.map((t) => dot(face.n, t))) }))
    .sort((a, b) => b.score - a.score);
  const chosen: number[] = [];
  for (const { index } of order) {
    if (chosen.length >= target) break;
    if (chosen.some((other) => facesAdjacent(faces[index]!, faces[other]!))) continue;
    chosen.push(index);
  }
  if (chosen.length < target) {
    for (const { index } of order) {
      if (chosen.length >= target) break;
      if (!chosen.includes(index)) chosen.push(index);
    }
  }
  for (const index of chosen) faces[index]!.dark = true;
}

/** 角点按绕面法向的极角排序，得到有序球面多边形（t1×t2 = n，右手系） */
function orderedCorners(face: Face): Vec3[] {
  const ref: Vec3 = Math.abs(face.n[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
  const t1 = unit(cross(ref, face.n));
  const t2 = cross(face.n, t1);
  return [...face.corners]
    .sort((a, b) =>
      Math.atan2(dot(a, t2), dot(a, t1)) - Math.atan2(dot(b, t2), dot(b, t1)))
    .filter((item, index, list) =>
      index === 0 || dot(item, list[index - 1]!) < 1 - 1e-9);
}

/**
 * 皮革细微起伏：低频连续噪声只扰动**着色法线**，不改顶点位置、不增加面数。
 * 纯色球面 otherwise 会像一块塑料；加这一点偏转后掠射光下能看出皮革的不平整。
 */
function leatherNormal(normal: Vec3, direction: Vec3): Vec3 {
  const a = Math.sin(direction[0] * 41 + direction[1] * 17 + direction[2] * 29)
    * Math.cos(direction[2] * 23 - direction[0] * 13);
  const b = Math.sin(direction[1] * 37 - direction[2] * 19 + direction[0] * 11)
    * Math.cos(direction[0] * 31 + direction[2] * 7);
  const tangent = unit(sub(direction, mul(normal, dot(direction, normal))));
  const bitangent = cross(normal, tangent);
  return unit(add(normal, mul(add(mul(tangent, a), mul(bitangent, b)), 0.01)));
}

/* ---------- 主生成 ---------- */

/** 面划分诊断（测试用）：返回每块皮的法向、角点数与是否为黑块 */
export function ballPanelLayout(layout = 'pentagons', darkCount = 3): Array<{
  n: Vec3; corners: number; dark: boolean; darkNeighbors: number;
}> {
  const faces = buildFaces(layout);
  assignCorners(faces);
  if (layout === 'pentagons') chooseDarkFaces(faces, darkCount);
  return faces.map((face, index) => ({
    n: face.n,
    corners: orderedCorners(face).length,
    dark: face.dark,
    darkNeighbors: face.dark
      ? faces.filter((other, otherIndex) => otherIndex !== index && other.dark && facesAdjacent(face, other)).length
      : 0,
  }));
}

export function buildBallPanelParts(shape: BallPanelsParams): BallPanelPart[] {
  const radius = Math.max(0.001, finite(shape.radius, 0.12));
  const layout = shape.layout === 'classic' ? 'classic' : 'pentagons';
  // 缝宽、皮厚、鼓起都随球半径缩放：直径 24 cm 的足球和直径 2 m 的装置球用同一套参数就都合理
  const seam = clamp(finite(shape.seam, radius * 0.02), 0.00002, radius * 0.2);
  const thickness = clamp(finite(shape.thickness, radius * 0.028), 0.00005, radius * 0.3);
  const bulge = clamp(finite(shape.bulge, thickness * 0.8), 0, radius * 0.12);
  const perEdge = clamp(Math.round(finite(shape.segments, 12)), 6, 64);
  const rings = clamp(Math.round(finite(shape.rings, 5)), 2, 16);

  const light = new TriMesh();
  const dark = new TriMesh();
  const core = new TriMesh();
  const faces = buildFaces(layout);
  assignCorners(faces);
  if (layout === 'pentagons') chooseDarkFaces(faces, finite(shape.darkCount, 3));

  const shrinkAngle = seam / (2 * radius);
  for (const face of faces) {
    const corners = orderedCorners(face);
    if (corners.length < 3) continue;

    // 每块皮沿球面朝自己的中心内缩半个缝宽 → 相邻块之间出现真实空隙
    const inset = corners.map((d) => {
      const angle = Math.acos(clamp(dot(d, face.n), -1, 1));
      const t = Math.min(0.45, shrinkAngle / Math.max(angle, 1e-5));
      return slerp(d, face.n, t);
    });

    // 边界按每条边细分，仍严格落在球面上
    const boundary: Vec3[] = [];
    for (let i = 0; i < inset.length; i += 1) {
      const a = inset[i]!;
      const b = inset[(i + 1) % inset.length]!;
      for (let s = 0; s < perEdge; s += 1) boundary.push(slerp(a, b, s / perEdge));
    }
    const count = boundary.length;
    if (count < 3) continue;

    /* ---- 外表面：中心鼓起的球面片 ---- */
    const surface = face.dark ? dark : light;
    const centerPoint = mul(face.n, radius + bulge);
    const ringsPoints: Vec3[][] = [];
    const ringsNormals: Vec3[][] = [];
    for (let j = 1; j <= rings; j += 1) {
      const t = j / rings;
      const r = radius + bulge * (1 - t * t);
      const points: Vec3[] = [];
      const normals: Vec3[] = [];
      for (const b of boundary) {
        const d = slerp(face.n, b, t);
        // e_ρ：沿球面从块心指向边界的切向；鼓起使法线朝外偏转 slope/r
        const tangent = unit(sub(d, mul(face.n, dot(d, face.n))));
        const arc = Math.max(1e-6, Math.acos(clamp(dot(face.n, b), -1, 1)) * radius);
        const slope = (-2 * bulge * t) / arc;
        points.push(mul(d, r));
        const smooth = unit(sub(d, mul(tangent, slope / r)));
        normals.push(leatherNormal(smooth, d));
      }
      ringsPoints.push(points);
      ringsNormals.push(normals);
    }
    const first = ringsPoints[0]!;
    const firstN = ringsNormals[0]!;
    for (let k = 0; k < count; k += 1) {
      const next = (k + 1) % count;
      surface.triangle(centerPoint, first[k]!, first[next]!, face.n, firstN[k]!, firstN[next]!);
    }
    for (let j = 0; j + 1 < rings; j += 1) {
      const a = ringsPoints[j]!;
      const b = ringsPoints[j + 1]!;
      const na = ringsNormals[j]!;
      const nb = ringsNormals[j + 1]!;
      for (let k = 0; k < count; k += 1) {
        const next = (k + 1) % count;
        surface.triangle(a[k]!, a[next]!, b[next]!, na[k]!, na[next]!, nb[next]!);
        surface.triangle(a[k]!, b[next]!, b[k]!, na[k]!, nb[next]!, nb[k]!);
      }
    }

    /* ---- 侧壁：外缘 → 缝口倒角 → 内缘，法线由球面径向渐变到切向。
       缝壁是皮革自身的断面，跟这块皮同色；只有沟底才是最深的内胆色。
       若把整条缝壁涂黑，缝就又变回「画上去的一条线」了。 ---- */
    const bevelAngle = Math.min(0.12, (thickness / radius) * 0.6);
    const outward = boundary.map((b) => unit(sub(b, mul(face.n, dot(b, face.n)))));
    const wallRings: Vec3[][] = [];
    const wallNormals: Vec3[][] = [];
    const profile: Array<{ drop: number; insetT: number; blend: number }> = [
      { drop: 0, insetT: 0, blend: 0.3 },
      { drop: thickness * 0.28, insetT: 0.5, blend: 0.6 },
      { drop: thickness, insetT: 1, blend: 1 },
    ];
    for (const step of profile) {
      const r = radius - step.drop;
      const points: Vec3[] = [];
      const normals: Vec3[] = [];
      for (let k = 0; k < count; k += 1) {
        const direction = slerp(boundary[k]!, face.n, bevelAngle * step.insetT);
        points.push(mul(direction, r));
        normals.push(unit(mix(boundary[k]!, outward[k]!, step.blend)));
      }
      wallRings.push(points);
      wallNormals.push(normals);
    }
    for (let j = 0; j + 1 < wallRings.length; j += 1) {
      const a = wallRings[j]!;
      const b = wallRings[j + 1]!;
      const na = wallNormals[j]!;
      const nb = wallNormals[j + 1]!;
      for (let k = 0; k < count; k += 1) {
        const next = (k + 1) % count;
        surface.triangle(a[k]!, a[next]!, b[next]!, na[k]!, na[next]!, nb[next]!);
        surface.triangle(a[k]!, b[next]!, b[k]!, na[k]!, nb[next]!, nb[k]!);
      }
    }

    /* ---- 内表面：把壳封起来，法线朝内 ---- */
    const innerCenter = mul(face.n, radius - thickness);
    const innerRim = wallRings[wallRings.length - 1]!;
    for (let k = 0; k < count; k += 1) {
      const next = (k + 1) % count;
      const a = unit(innerRim[k]!);
      const b = unit(innerRim[next]!);
      surface.triangle(
        innerCenter,
        innerRim[k]!,
        innerRim[next]!,
        mul(face.n, -1),
        mul(a, -1),
        mul(b, -1),
      );
    }
  }

  /* ---- 缝底内胆球：比皮革内表面再低一点，缝里看到的是它 ---- */
  const coreRadius = radius - thickness - Math.min(thickness * 0.06, 0.0002);
  const sphereSegments = clamp(Math.round(perEdge * 4), 24, 64);
  const sphere = new SphereGeometry(coreRadius, sphereSegments, Math.max(12, Math.round(sphereSegments / 2)));
  const flat = sphere.index ? sphere.toNonIndexed() : sphere;
  const position = flat.getAttribute('position');
  const normal = flat.getAttribute('normal');
  for (let i = 0; i + 2 < position.count; i += 3) {
    const p = (index: number): Vec3 => [position.getX(index), position.getY(index), position.getZ(index)];
    const n = (index: number): Vec3 => [normal.getX(index), normal.getY(index), normal.getZ(index)];
    core.triangle(p(i), p(i + 1), p(i + 2), n(i), n(i + 1), n(i + 2));
  }
  if (flat !== sphere) flat.dispose();
  sphere.dispose();

  return [
    { role: 'light', geometry: light.toGeometry() },
    { role: 'dark', geometry: dark.toGeometry() },
    { role: 'core', geometry: core.toGeometry() },
  ];
}
