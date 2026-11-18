/**
 * 面向 Agent 的只读几何查询：位置不再靠截图估算。
 *
 * 与前端 `src/ai/measure.ts` 的区别（那套是给「应用内 AI 自检」用的）：
 * - 这里吃的是 ops / 装配说明 / 特征树文件，跑在 Node 里，Agent 可以直接命令行调用；
 * - 坐标默认给**整车世界坐标**（含构件 elevation / offset / rotation / scale / flip），
 *   也能切回 root（特征树局部坐标，可直接写回 feature.translate）；
 * - 射线是任意 origin + direction，不限于三根坐标轴；
 * - 多了 `sample` / `grid`：把车身曲面采样点与法线交给贴合件 Agent，
 *   灯罩、后视镜这类零件才能按曲面生成，而不是先生成一个方块再靠拼接 Agent 硬挪。
 *
 * 只读：不写文件、不改文档、不入库。结果是采样/射线估算，不是拓扑精确的碰撞检测。
 */
import {
  Box3, DoubleSide, Matrix4, Mesh, MeshBasicMaterial, Raycaster, Triangle, Vector3,
} from 'three';
import type { BufferGeometry } from 'three';
import { applyOps } from '../../server/ai/ops.js';
import { createProject } from '../../src/bim/template';
import { baseElevation } from '../../src/bim/document';
import { buildSolidModel, buildSolidParts } from '../../src/bim/solid';
import type { BimElement, ProjectDocument, SolidFeature } from '../../src/bim/types';
import { mergeAssembly, type AssemblySpec } from './assembly';

export type Vec3 = [number, number, number];
export type Frame = 'world' | 'root';
export type Axis = 'x' | 'y' | 'z';

export interface QueryRequest {
  type: 'parts' | 'bounds' | 'ray' | 'surface' | 'gap' | 'sample';
  /** 多造型构件时按名字/id 选；单个构件可不写 */
  target?: string;
  frame?: Frame;
  part?: string;
  origin?: Vec3;
  direction?: Vec3;
  axis?: Axis;
  at?: [number, number] | Array<[number, number]>;
  /** sample 的网格采样：{ a:[起,止,点数], b:[起,止,点数] } */
  grid?: { a: [number, number, number]; b: [number, number, number] };
  maxHits?: number;
  a?: string;
  b?: string;
}

export interface QueryHit {
  point: Vec3;
  normal: Vec3;
  distance: number;
  part: string;
}

interface PartGeometries {
  id: string;
  label: string;
  geometries: BufferGeometry[];
}

export interface QueryModel {
  name: string;
  parts: PartGeometries[];
  whole: BufferGeometry;
  /** root → world 的变换（构件放置：flip / scale / elevation / rotation / offset） */
  worldMatrix: Matrix4;
  dispose(): void;
}

export class QueryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'QueryError';
  }
}

const SAMPLE_LIMIT = 600;
const MAX_HITS = 8;
const TOUCH_DISTANCE = 0.002;
const INSIDE_RATIO = 0.02;
const MATERIAL = new MeshBasicMaterial({ side: DoubleSide });

function fail(message: string): never {
  throw new QueryError(message);
}

function vec3(value: unknown, label: string): Vec3 {
  if (!Array.isArray(value) || value.length !== 3 || value.some((n) => typeof n !== 'number' || !Number.isFinite(n))) {
    fail(`${label} 必须是 [x, y, z] 三个有限数`);
  }
  return [value[0], value[1], value[2]] as Vec3;
}

function pair(value: unknown, label: string): [number, number] {
  if (!Array.isArray(value) || value.length !== 2 || value.some((n) => typeof n !== 'number' || !Number.isFinite(n))) {
    fail(`${label} 必须是 [a, b] 两个有限数（axis=z 时是 [x,y]，x 时 [y,z]，y 时 [x,z]）`);
  }
  return [value[0], value[1]] as [number, number];
}

function tidy(value: number): number {
  const rounded = Number(value.toFixed(5));
  return Object.is(rounded, -0) ? 0 : rounded;
}

function triple(vector: Vector3): Vec3 {
  return [tidy(vector.x), tidy(vector.y), tidy(vector.z)];
}

function isSolid(element: BimElement): boolean {
  return element.category === 'mesh' && (element as unknown as { primitive?: { kind?: string } }).primitive?.kind === 'solid';
}

function featuresOf(element: BimElement): SolidFeature[] {
  return ((element as unknown as { primitive?: { features?: SolidFeature[] } }).primitive?.features ?? []) as SolidFeature[];
}

/** 与 src/bim/geometry.ts 的元素变换顺序一致：flip → scale → elevation → rotateZ → offset */
function matrixOf(project: ProjectDocument, element: BimElement): Matrix4 {
  const matrix = new Matrix4();
  const meta = element as unknown as { flip?: boolean; scale?: number; rotation?: number; offset?: Vec3 };
  if (meta.flip) matrix.premultiply(new Matrix4().makeScale(1, -1, 1));
  if (meta.scale && Math.abs(meta.scale - 1) > 1e-9) {
    matrix.premultiply(new Matrix4().makeScale(meta.scale, meta.scale, meta.scale));
  }
  matrix.premultiply(new Matrix4().makeTranslation(0, 0, baseElevation(project, element)));
  if (meta.rotation) matrix.premultiply(new Matrix4().makeRotationZ(meta.rotation));
  if (meta.offset) matrix.premultiply(new Matrix4().makeTranslation(meta.offset[0], meta.offset[1], meta.offset[2]));
  return matrix;
}

/** 把 ops / 装配说明 / 模型库文档 / 裸特征树统一变成 addSolid ops */
function toOps(input: unknown): unknown[] {
  if (Array.isArray(input)) {
    if (input.every((item) => item && typeof item === 'object' && 'op' in (item as object))) return input;
    return [{ op: 'addSolid', name: '查询模型', features: input }];
  }
  if (!input || typeof input !== 'object') fail('输入必须是 ops 数组、装配说明或特征树');
  const spec = input as Record<string, unknown>;
  if (Array.isArray(spec.parts)) return mergeAssembly(spec as unknown as AssemblySpec).ops;
  if (Array.isArray(spec.features)) {
    return [{ op: 'addSolid', name: String(spec.name ?? '查询模型'), features: spec.features }];
  }
  fail('识别不出输入格式：需要 ops[] / { parts, placements } / { features } / features[]');
}

/**
 * 加载模型并求值。走真实链路（applyOps → 文档 → 造型内核），
 * 所以查询到的几何与浏览器里渲染出来的是同一套。
 */
export function loadQueryModels(input: unknown): { project: ProjectDocument; models: QueryModel[] } {
  const project = createProject({ name: '几何查询' }) as ProjectDocument;
  const result = applyOps(project, toOps(input) as Array<Record<string, unknown>>) as { document: ProjectDocument };
  const applied = result.document;
  const solids = applied.elements.filter(isSolid);
  if (!solids.length) fail('这份输入里没有造型构件（addSolid 特征树）');

  const models: QueryModel[] = solids.map((element) => {
    const features = featuresOf(element);
    const worldMatrix = matrixOf(applied, element);
    const labelOf = new Map<string, string>();
    for (const feature of features) {
      if (feature.id) labelOf.set(feature.id, String(feature.label ?? feature.shape?.shape ?? feature.id));
    }
    const grouped = new Map<string, BufferGeometry[]>();
    for (const part of buildSolidParts(features)) {
      const list = grouped.get(part.id) ?? [];
      list.push(part.geometry);
      grouped.set(part.id, list);
    }
    const parts: PartGeometries[] = features.map((feature) => ({
      id: String(feature.id ?? ''),
      label: String(feature.label ?? feature.shape?.shape ?? ''),
      geometries: grouped.get(String(feature.id ?? '')) ?? [],
    })).filter((part) => part.geometries.length > 0);
    const whole = buildSolidModel(features).geometry;
    return {
      name: element.name,
      parts,
      whole,
      worldMatrix,
      dispose() {
        parts.forEach((part) => part.geometries.forEach((geometry) => geometry.dispose()));
        whole.dispose();
      },
    };
  });
  return { project: applied, models };
}

function transformed(geometry: BufferGeometry, frame: Frame, matrix: Matrix4): BufferGeometry {
  if (frame === 'root') return geometry;
  const clone = geometry.clone();
  clone.applyMatrix4(matrix);
  return clone;
}

function resolveModel(models: QueryModel[], target?: string): QueryModel {
  if (!target) {
    if (models.length === 1) return models[0]!;
    fail(`有 ${models.length} 个造型构件，请用 target 指定：${models.map((item) => item.name).join('、')}`);
  }
  const exact = models.filter((item) => item.name === target);
  if (exact.length === 1) return exact[0]!;
  const partial = models.filter((item) => item.name.includes(target));
  if (partial.length === 1) return partial[0]!;
  fail(`找不到构件「${target}」，可用：${models.map((item) => item.name).join('、')}`);
}

function resolvePart(model: QueryModel, ref?: string): PartGeometries[] {
  if (!ref) return model.parts;
  const exact = model.parts.filter((part) => part.id === ref || part.label === ref);
  if (exact.length) return exact;
  const partial = model.parts.filter((part) => part.label.includes(ref) || part.id.includes(ref));
  if (partial.length === 1) return partial;
  if (partial.length > 1) fail(`「${ref}」匹配到 ${partial.length} 个零件，请写完整名字或 id`);
  fail(`找不到零件「${ref}」；可用：${model.parts.map((part) => part.label || part.id).join('、')}`);
}

function geometriesOf(model: QueryModel, frame: Frame, ref?: string): Array<{ label: string; geometry: BufferGeometry; owned: boolean }> {
  if (!ref) {
    return [{ label: '整个构件（含布尔结果）', geometry: transformed(model.whole, frame, model.worldMatrix), owned: frame === 'world' }];
  }
  const parts = resolvePart(model, ref);
  if (!parts.length) fail(`零件「${ref}」没有可查询的几何`);
  return parts.flatMap((part) => part.geometries.map((geometry) => ({
    label: part.label || part.id,
    geometry: transformed(geometry, frame, model.worldMatrix),
    owned: frame === 'root',
  })));
}

function disposeGeometries(items: Array<{ geometry: BufferGeometry; owned: boolean }>): void {
  items.forEach((item) => { if (!item.owned) item.geometry.dispose(); });
}

function boxOf(geometries: BufferGeometry[]): Box3 {
  const box = new Box3();
  for (const geometry of geometries) {
    geometry.computeBoundingBox();
    if (geometry.boundingBox) box.union(geometry.boundingBox);
  }
  return box;
}

function boxText(box: Box3): Record<string, unknown> {
  const size = box.getSize(new Vector3());
  const center = box.getCenter(new Vector3());
  return {
    min: triple(box.min), max: triple(box.max),
    size: triple(size), center: triple(center),
  };
}

function raycast(
  items: Array<{ label: string; geometry: BufferGeometry }>,
  originVec: Vector3,
  directionVec: Vector3,
  maxHits: number,
): QueryHit[] {
  const direction = directionVec.clone().normalize();
  if (direction.lengthSq() < 1e-12) fail('direction 不能是零向量');
  const meshes = items.map((item) => new Mesh(item.geometry, MATERIAL));
  const hits = new Raycaster(originVec, direction, 0, Infinity).intersectObjects(meshes, false);
  const out: QueryHit[] = [];
  const seen = new Set<string>();
  for (const hit of hits) {
    const normal = hit.face?.normal.clone() ?? new Vector3(0, 0, 1);
    if (normal.dot(direction) > 0) normal.negate();
    const key = `${hit.point.x.toFixed(5)},${hit.point.y.toFixed(5)},${hit.point.z.toFixed(5)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const part = items[meshes.indexOf(hit.object as Mesh)]?.label ?? hit.object.name;
    out.push({ point: triple(hit.point), normal: triple(normal), distance: tidy(hit.distance), part: part ?? '' });
    if (out.length >= maxHits) break;
  }
  return out;
}

function axisRay(box: Box3, axis: Axis, at: [number, number]): { origin: Vector3; direction: Vector3 } {
  const lead = 1;
  const [a, b] = at;
  if (axis === 'z') return { origin: new Vector3(a, b, box.max.z + lead), direction: new Vector3(0, 0, -1) };
  if (axis === 'x') return { origin: new Vector3(box.max.x + lead, a, b), direction: new Vector3(-1, 0, 0) };
  return { origin: new Vector3(a, box.max.y + lead, b), direction: new Vector3(0, -1, 0) };
}

/* ---------- 距离 / 穿插：采样估算，与前端 measure 同一套判据 ---------- */

function samplePoints(geometries: BufferGeometry[]): Float32Array {
  const all: number[] = [];
  for (const geometry of geometries) {
    const position = geometry.getAttribute('position');
    for (let i = 0; i < position.count; i += 1) {
      all.push(position.getX(i), position.getY(i), position.getZ(i));
    }
  }
  const total = all.length / 3;
  const step = Math.max(1, Math.floor(total / SAMPLE_LIMIT));
  const out: number[] = [];
  for (let i = 0; i < total; i += step) out.push(all[i * 3]!, all[i * 3 + 1]!, all[i * 3 + 2]!);
  return Float32Array.from(out);
}

function triangleSoup(geometries: BufferGeometry[]): { tris: Float32Array; bounds: Float32Array } {
  const chunks: number[] = [];
  for (const geometry of geometries) {
    const position = geometry.getAttribute('position');
    const index = geometry.index;
    const count = index ? index.count : position.count;
    for (let i = 0; i + 2 < count; i += 3) {
      for (let k = 0; k < 3; k += 1) {
        const vertex = index ? index.getX(i + k) : i + k;
        chunks.push(position.getX(vertex), position.getY(vertex), position.getZ(vertex));
      }
    }
  }
  const tris = Float32Array.from(chunks);
  const bounds = new Float32Array((tris.length / 9) * 6);
  for (let t = 0; t < tris.length / 9; t += 1) {
    const o = t * 9;
    for (let axis = 0; axis < 3; axis += 1) {
      const a = tris[o + axis]!; const b = tris[o + 3 + axis]!; const c = tris[o + 6 + axis]!;
      bounds[t * 6 + axis] = Math.min(a, b, c);
      bounds[t * 6 + 3 + axis] = Math.max(a, b, c);
    }
  }
  return { tris, bounds };
}

function minDistance(points: Float32Array, soup: { tris: Float32Array; bounds: Float32Array }): number {
  const triangle = new Triangle();
  const point = new Vector3();
  const closest = new Vector3();
  let best = Infinity;
  const { tris, bounds } = soup;
  for (let i = 0; i < points.length; i += 3) {
    const px = points[i]!; const py = points[i + 1]!; const pz = points[i + 2]!;
    point.set(px, py, pz);
    for (let t = 0; t < tris.length / 9; t += 1) {
      const b = t * 6;
      if (px < bounds[b]! - best || px > bounds[b + 3]! + best
        || py < bounds[b + 1]! - best || py > bounds[b + 4]! + best
        || pz < bounds[b + 2]! - best || pz > bounds[b + 5]! + best) continue;
      const o = t * 9;
      triangle.a.set(tris[o]!, tris[o + 1]!, tris[o + 2]!);
      triangle.b.set(tris[o + 3]!, tris[o + 4]!, tris[o + 5]!);
      triangle.c.set(tris[o + 6]!, tris[o + 7]!, tris[o + 8]!);
      triangle.closestPointToPoint(point, closest);
      const distance = closest.distanceTo(point);
      if (distance < best) best = distance;
    }
  }
  return best;
}

function insideCount(points: Float32Array, soup: { tris: Float32Array; bounds: Float32Array }): number {
  const { tris, bounds } = soup;
  let inside = 0;
  for (let i = 0; i < points.length; i += 3) {
    const px = points[i]! + 1.3e-7; const py = points[i + 1]! + 0.7e-7; const pz = points[i + 2]!;
    let crossings = 0;
    for (let t = 0; t < tris.length / 9; t += 1) {
      const b = t * 6;
      if (px < bounds[b]! || px > bounds[b + 3]! || py < bounds[b + 1]! || py > bounds[b + 4]! || bounds[b + 5]! < pz) continue;
      const o = t * 9;
      const x1 = tris[o]!; const y1 = tris[o + 1]!; const z1 = tris[o + 2]!;
      const x2 = tris[o + 3]!; const y2 = tris[o + 4]!; const z2 = tris[o + 5]!;
      const x3 = tris[o + 6]!; const y3 = tris[o + 7]!; const z3 = tris[o + 8]!;
      const det = (y2 - y3) * (x1 - x3) + (x3 - x2) * (y1 - y3);
      if (Math.abs(det) < 1e-12) continue;
      const l1 = ((y2 - y3) * (px - x3) + (x3 - x2) * (py - y3)) / det;
      const l2 = ((y3 - y1) * (px - x3) + (x1 - x3) * (py - y3)) / det;
      const l3 = 1 - l1 - l2;
      if (l1 < 0 || l2 < 0 || l3 < 0) continue;
      if (l1 * z1 + l2 * z2 + l3 * z3 > pz) crossings += 1;
    }
    if (crossings % 2 === 1) inside += 1;
  }
  return inside;
}

function describeGap(a: BufferGeometry[], b: BufferGeometry[]): Record<string, unknown> {
  const pointsA = samplePoints(a);
  const pointsB = samplePoints(b);
  const soupA = triangleSoup(a);
  const soupB = triangleSoup(b);
  const distance = Math.min(minDistance(pointsA, soupB), minDistance(pointsB, soupA));
  const insideA = insideCount(pointsA, soupB);
  const insideB = insideCount(pointsB, soupA);
  const ratioA = insideA / Math.max(1, pointsA.length / 3);
  const ratioB = insideB / Math.max(1, pointsB.length / 3);
  const relation = ratioA >= INSIDE_RATIO || ratioB >= INSIDE_RATIO ? 'intersect'
    : distance <= TOUCH_DISTANCE ? 'contact' : 'gap';
  return {
    relation,
    distance: tidy(distance),
    insideA, samplesA: pointsA.length / 3,
    insideB, samplesB: pointsB.length / 3,
    note: '采样估算，不是拓扑精确碰撞检测；relation=intersect 表示穿插或嵌入',
  };
}

function sampleList(request: QueryRequest): Array<[number, number]> {
  const points: Array<[number, number]> = [];
  if (Array.isArray(request.at)) {
    if (request.at.length === 2 && request.at.every((value) => typeof value === 'number')) {
      points.push([request.at[0] as number, request.at[1] as number]);
    } else {
      for (const item of request.at) {
        if (Array.isArray(item) && item.length === 2 && item.every((n) => typeof n === 'number' && Number.isFinite(n))) {
          points.push([item[0], item[1]]);
        }
      }
    }
  }
  if (request.grid) {
    const [a0, a1, na] = request.grid.a;
    const [b0, b1, nb] = request.grid.b;
    const countA = Math.max(1, Math.min(64, Math.round(na)));
    const countB = Math.max(1, Math.min(64, Math.round(nb)));
    for (let i = 0; i < countA; i += 1) {
      for (let j = 0; j < countB; j += 1) {
        const a = countA === 1 ? a0 : a0 + (a1 - a0) * i / (countA - 1);
        const b = countB === 1 ? b0 : b0 + (b1 - b0) * j / (countB - 1);
        points.push([a, b]);
      }
    }
  }
  if (!points.length) fail('sample 需要 at: [[a,b], …] 或 grid: { a:[起,止,点数], b:[起,止,点数] }');
  return points.slice(0, 512);
}

function runOne(models: QueryModel[], request: QueryRequest): Record<string, unknown> {
  const model = resolveModel(models, request.target);
  const frame: Frame = request.frame === 'root' ? 'root' : 'world';
  const maxHits = Math.max(1, Math.min(32, Math.round(request.maxHits ?? MAX_HITS)));

  if (request.type === 'parts') {
    const items = model.parts.map((part) => {
      const geoms = part.geometries.map((geometry) => transformed(geometry, frame, model.worldMatrix));
      const box = boxOf(geoms);
      disposeGeometries(geoms.map((geometry) => ({ geometry, owned: frame === 'root' })));
      return { id: part.id, label: part.label, ...boxText(box) };
    });
    return { type: 'parts', frame, target: model.name, parts: items };
  }

  const items = geometriesOf(model, frame, request.part);
  try {
    const geoms = items.map((item) => item.geometry);
    const box = boxOf(geoms);
    if (box.isEmpty()) return { type: request.type, ok: false, error: '没有可查询的几何' };

    if (request.type === 'bounds') {
      return { type: 'bounds', frame, target: model.name, part: request.part ?? 'whole', ...boxText(box) };
    }

    if (request.type === 'ray') {
      const origin = new Vector3(...vec3(request.origin, 'ray.origin'));
      const direction = new Vector3(...vec3(request.direction, 'ray.direction'));
      const hits = raycast(items, origin, direction, maxHits);
      return { type: 'ray', frame, target: model.name, part: request.part ?? 'whole', hits };
    }

    if (request.type === 'surface' || request.type === 'sample') {
      const axis: Axis = request.axis === 'x' || request.axis === 'y' ? request.axis : 'z';
      const list = request.type === 'sample' ? sampleList(request) : [pair(request.at, 'surface.at')];
      const results = list.map((at) => {
        const { origin, direction } = axisRay(box, axis, at);
        const hits = raycast(items, origin, direction, 1);
        const hit = hits[0];
        return { at: [tidy(at[0]), tidy(at[1])], ...(hit ? { hit } : { hit: null }) };
      });
      return {
        type: request.type, frame, target: model.name, part: request.part ?? 'whole', axis,
        results,
        note: request.type === 'sample'
          ? '采样点 + 法线可直接交给贴合件 Agent 生成 loft / prism 截面'
          : '沿轴从外侧向内命中表面',
      };
    }

    if (request.type === 'gap') {
      if (!request.a || !request.b) fail('gap 需要 a、b 两个零件名或特征 id');
      const first = geometriesOf(model, frame, request.a);
      const second = geometriesOf(model, frame, request.b);
      try {
        return {
          type: 'gap', frame, target: model.name, a: request.a, b: request.b,
          ...describeGap(first.map((item) => item.geometry), second.map((item) => item.geometry)),
        };
      } finally {
        disposeGeometries(first);
        disposeGeometries(second);
      }
    }

    fail(`未知查询类型「${String(request.type)}」`);
  } finally {
    disposeGeometries(items);
  }
}

/** 批量查询：单条失败不影响其它条，返回结构化结果（可直接 JSON 化给 Agent） */
export function runQueries(input: unknown, requests: QueryRequest[]): Record<string, unknown> {
  const { models } = loadQueryModels(input);
  try {
    const results = requests.map((request, index) => {
      try {
        return { index: index + 1, ok: true, ...runOne(models, request) };
      } catch (error) {
        return { index: index + 1, ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    });
    return {
      note: '只读几何查询；坐标默认整车世界坐标（含构件放置），frame:"root" 可切回特征树局部坐标。射线与距离是采样/射线估算，不是拓扑精确碰撞检测。',
      results,
    };
  } finally {
    models.forEach((model) => model.dispose());
  }
}
