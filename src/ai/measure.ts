/**
 * AI 几何测量：对当前特征树求值，回答「某点处表面在哪」「两个特征离多远 / 是否穿插」「包围盒多大」。
 *
 * 坐标是造型构件的局部坐标（米），和特征的 translate 同一坐标系，AI 可以直接把结果写回 translate。
 * 结果来自采样计算，不是拓扑精确的碰撞检测；文字里会明确写出这一点，避免被当成严格结论。
 */
import { Box3, DoubleSide, Mesh, MeshBasicMaterial, Raycaster, Triangle, Vector3 } from 'three';
import type { BufferGeometry } from 'three';
import { buildSolidModel, buildSolidParts } from '../bim/solid';
import type { SolidPartGeometry } from '../bim/solid';
import type { BimElement, ProjectDocument, SolidFeature } from '../bim/types';
import type { AiMeasureRequest } from '../data';

const SAMPLE_LIMIT = 600;
const MAX_HITS = 6;
const TOUCH_DISTANCE = 0.002;
const INSIDE_RATIO = 0.02;

type SolidElement = Extract<BimElement, { category: 'mesh' }>;

const isSolid = (element: BimElement): element is SolidElement =>
  element.category === 'mesh' && element.primitive?.kind === 'solid';

const featuresOf = (element: SolidElement): SolidFeature[] =>
  element.primitive?.kind === 'solid' ? element.primitive.features : [];

const fixed = (value: number) => (Math.abs(value) < 5e-4 ? 0 : value).toFixed(3);

class Resolution extends Error {}

/** 一个构件的求值缓存：同一轮多条请求只求一次值 */
class SolidSession {
  private parts: SolidPartGeometry[] | null = null;
  private whole: BufferGeometry | null = null;

  constructor(readonly element: SolidElement, readonly features: SolidFeature[]) {}

  getParts(): SolidPartGeometry[] {
    this.parts ??= buildSolidParts(this.features);
    return this.parts;
  }

  getWhole(): BufferGeometry {
    this.whole ??= buildSolidModel(this.features).geometry;
    return this.whole;
  }

  dispose(): void {
    this.parts?.forEach((part) => part.geometry.dispose());
    this.whole?.dispose();
  }
}

function resolveElement(document: ProjectDocument, ref: string | undefined): SolidElement {
  const solids = document.elements.filter(isSolid);
  if (!solids.length) throw new Resolution('项目里没有造型构件');
  if (ref === undefined) {
    if (solids.length === 1) return solids[0]!;
    throw new Resolution(`有 ${solids.length} 个造型构件，请用 target 指定：${solids.map((item) => item.name).join('、')}`);
  }
  const text = ref.trim();
  const exact = solids.filter((item) => item.id === text || item.name === text);
  if (exact.length === 1) return exact[0]!;
  const partial = solids.filter((item) => item.name.includes(text));
  if (partial.length === 1) return partial[0]!;
  throw new Resolution(`找不到造型构件「${text}」，可用：${solids.map((item) => item.name).join('、')}`);
}

function resolveFeature(features: SolidFeature[], ref: string | number): { index: number; feature: SolidFeature } {
  const text = String(ref).trim();
  const labels = () => features.map((item, index) => `${index + 1}.${item.label ?? item.shape.shape}`).join('、');
  if (/^\d+$/.test(text)) {
    const index = Number(text) - 1;
    const feature = features[index];
    if (!feature) throw new Resolution(`特征序号 ${text} 超出范围（1 ~ ${features.length}）`);
    return { index, feature };
  }
  const byId = features.findIndex((item) => item.id === text);
  if (byId >= 0) return { index: byId, feature: features[byId]! };
  const exact = features.map((feature, index) => ({ feature, index })).filter((item) => item.feature.label === text);
  if (exact.length === 1) return exact[0]!;
  const partial = features.map((feature, index) => ({ feature, index })).filter((item) => (item.feature.label ?? '').includes(text));
  if (partial.length === 1) return partial[0]!;
  throw new Resolution(partial.length > 1 ? `特征名称「${text}」匹配到 ${partial.length} 个，请改用序号或 id` : `找不到特征「${text}」，当前特征：${labels()}`);
}

function geometriesOf(session: SolidSession, ref: string | number | undefined): { geoms: BufferGeometry[]; name: string; note: string } {
  if (ref === undefined) return { geoms: [session.getWhole()], name: '整个构件（含布尔结果）', note: '' };
  const { feature } = resolveFeature(session.features, ref);
  const geoms = session.getParts().filter((part) => part.id === feature.id).map((part) => part.geometry);
  if (!geoms.length) throw new Resolution(`特征「${feature.label ?? feature.shape.shape}」没有可测量的几何`);
  const name = `特征「${feature.label ?? feature.shape.shape}」`;
  const note = feature.mode && feature.mode !== 'add' ? '（这是切除/相交特征，量的是它自身的形状，不是布尔后的结果）' : '';
  return { geoms, name, note };
}

function boundsOf(geoms: BufferGeometry[]): Box3 {
  const box = new Box3();
  for (const geometry of geoms) {
    geometry.computeBoundingBox();
    if (geometry.boundingBox) box.union(geometry.boundingBox);
  }
  return box;
}

const MATERIAL = new MeshBasicMaterial({ side: DoubleSide });

function surfaceHits(geoms: BufferGeometry[], axis: 'x' | 'y' | 'z', at: [number, number]): string {
  const box = boundsOf(geoms);
  if (box.isEmpty()) return '没有可测量的几何';
  const lead = 1;
  const [a, b] = at;
  const origin = axis === 'z' ? new Vector3(a, b, box.max.z + lead)
    : axis === 'x' ? new Vector3(box.max.x + lead, a, b)
      : new Vector3(a, box.max.y + lead, b);
  const direction = axis === 'z' ? new Vector3(0, 0, -1) : axis === 'x' ? new Vector3(-1, 0, 0) : new Vector3(0, -1, 0);
  const meshes = geoms.map((geometry) => new Mesh(geometry, MATERIAL));
  const hits = new Raycaster(origin, direction, 0, Infinity).intersectObjects(meshes, false);
  const values: number[] = [];
  for (const hit of hits) {
    const value = hit.point[axis];
    if (!values.some((existing) => Math.abs(existing - value) < 1e-5)) values.push(value);
    if (values.length >= MAX_HITS) break;
  }
  if (!values.length) return `沿 ${axis} 轴没有命中表面（该点在几何投影之外）`;
  const first = hits[0]!;
  const normal = first.face?.normal.clone();
  if (normal && normal.dot(direction) > 0) normal.negate();
  const normalText = normal ? `；最先命中处面法线 (${fixed(normal.x)}, ${fixed(normal.y)}, ${fixed(normal.z)})` : '';
  return `沿 ${axis} 轴从外侧向内命中 ${values.length} 个交点：${values.map((value) => `${axis}=${fixed(value)}`).join('、')}${normalText}`;
}

function triangleSoup(geoms: BufferGeometry[]): { tris: Float32Array; bounds: Float32Array } {
  const chunks: number[] = [];
  for (const geometry of geoms) {
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
      const a = tris[o + axis]!;
      const b = tris[o + 3 + axis]!;
      const c = tris[o + 6 + axis]!;
      bounds[t * 6 + axis] = Math.min(a, b, c);
      bounds[t * 6 + 3 + axis] = Math.max(a, b, c);
    }
  }
  return { tris, bounds };
}

function samplePoints(geoms: BufferGeometry[]): Float32Array {
  const all: number[] = [];
  for (const geometry of geoms) {
    const position = geometry.getAttribute('position');
    for (let i = 0; i < position.count; i += 1) all.push(position.getX(i), position.getY(i), position.getZ(i));
  }
  const total = all.length / 3;
  const step = Math.max(1, Math.floor(total / SAMPLE_LIMIT));
  const out: number[] = [];
  for (let i = 0; i < total; i += step) out.push(all[i * 3]!, all[i * 3 + 1]!, all[i * 3 + 2]!);
  return Float32Array.from(out);
}

function minDistance(points: Float32Array, soup: { tris: Float32Array; bounds: Float32Array }): number {
  const triangle = new Triangle();
  const point = new Vector3();
  const closest = new Vector3();
  const { tris, bounds } = soup;
  let best = Infinity;
  for (let i = 0; i < points.length; i += 3) {
    const px = points[i]!;
    const py = points[i + 1]!;
    const pz = points[i + 2]!;
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

/** 沿 +Z 数穿过的三角形个数，奇数说明点在封闭体内；点轻微抖动，避免正好落在边上重复计数 */
function insideCount(points: Float32Array, soup: { tris: Float32Array; bounds: Float32Array }): number {
  const { tris, bounds } = soup;
  let inside = 0;
  for (let i = 0; i < points.length; i += 3) {
    const px = points[i]! + 1.3e-7;
    const py = points[i + 1]! + 0.7e-7;
    const pz = points[i + 2]!;
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

function describeGap(nameA: string, nameB: string, a: BufferGeometry[], b: BufferGeometry[]): string {
  const pointsA = samplePoints(a);
  const pointsB = samplePoints(b);
  const soupA = triangleSoup(a);
  const soupB = triangleSoup(b);
  const distance = Math.min(minDistance(pointsA, soupB), minDistance(pointsB, soupA));
  const insideA = insideCount(pointsA, soupB);
  const insideB = insideCount(pointsB, soupA);
  const ratioA = insideA / Math.max(1, pointsA.length / 3);
  const ratioB = insideB / Math.max(1, pointsB.length / 3);
  const counts = `${nameA}的采样点有 ${insideA}/${pointsA.length / 3} 在${nameB}内部，${nameB}的采样点有 ${insideB}/${pointsB.length / 3} 在${nameA}内部`;
  if (ratioA >= INSIDE_RATIO || ratioB >= INSIDE_RATIO) return `判断：穿插或嵌入（估计）。表面最近距离约 ${fixed(distance)}；${counts}`;
  if (distance <= TOUCH_DISTANCE) return `判断：接触或几乎接触。表面最近距离约 ${fixed(distance)}；${counts}`;
  return `判断：有间隙。表面最近距离约 ${fixed(distance)}；${counts}`;
}

function runOne(document: ProjectDocument, request: AiMeasureRequest, sessions: Map<string, SolidSession>): string {
  const element = resolveElement(document, request.target);
  let session = sessions.get(element.id);
  if (!session) {
    session = new SolidSession(element, featuresOf(element));
    sessions.set(element.id, session);
  }
  const prefix = `构件「${element.name}」`;
  if (request.type === 'bounds') {
    const { geoms, name, note } = geometriesOf(session, request.feature);
    const box = boundsOf(geoms);
    if (box.isEmpty()) throw new Resolution('没有可测量的几何');
    const size = box.getSize(new Vector3());
    return `包围盒 ${prefix} ${name}${note}：x [${fixed(box.min.x)}, ${fixed(box.max.x)}]，y [${fixed(box.min.y)}, ${fixed(box.max.y)}]，z [${fixed(box.min.z)}, ${fixed(box.max.z)}]；尺寸 ${fixed(size.x)} × ${fixed(size.y)} × ${fixed(size.z)}`;
  }
  if (request.type === 'surface') {
    const { geoms, name, note } = geometriesOf(session, request.feature);
    return `表面查询 ${prefix} ${name}${note}，at=(${request.at.map(fixed).join(', ')})：${surfaceHits(geoms, request.axis, request.at)}`;
  }
  const first = geometriesOf(session, request.a);
  const second = geometriesOf(session, request.b);
  return `间距 ${prefix} ${first.name} 与 ${second.name}${first.note}${second.note}：${describeGap(first.name, second.name, first.geoms, second.geoms)}`;
}

export function runMeasure(document: ProjectDocument, requests: AiMeasureRequest[]): string {
  const sessions = new Map<string, SolidSession>();
  const lines = ['[几何测量结果] 坐标为造型构件局部坐标（米，与特征 translate 同一坐标系）；表面、距离和穿插来自对当前特征树求值后的采样计算，不是拓扑精确的碰撞检测。'];
  try {
    requests.forEach((request, index) => {
      try {
        lines.push(`${index + 1}. ${runOne(document, request, sessions)}`);
      } catch (error) {
        lines.push(`${index + 1}. 无法测量：${error instanceof Resolution ? error.message : '求值失败'}`);
      }
    });
  } finally {
    sessions.forEach((session) => session.dispose());
  }
  return lines.join('\n');
}
