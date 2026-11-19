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

/**
 * 几何体检：逐特征算包围盒，找出「飘离主体」或「异常巨大」的零件。
 *
 * 这是给 AI 自检用的数字证据——即使 vision 关闭、AI 看不到截图，也能凭这些数字
 * 发现「阵列中心留在原点导致一圈环散落到几米外」这类肉眼才看得出的错误。
 * 用各特征中心的中位数当鲁棒中心，避免离群零件自己把中心拉偏。
 */
function detectAnomalies(session: SolidSession, elementName: string): string {
  const parts = session.getParts();
  const entries = parts.map((part) => {
    const box = boundsOf([part.geometry]);
    return {
      label: session.features.find((f) => f.id === part.id)?.label ?? part.id,
      box,
      center: box.getCenter(new Vector3()),
      size: box.getSize(new Vector3()),
    };
  }).filter((entry) => !entry.box.isEmpty());
  if (!entries.length) return '没有可测量的几何';

  const boxSpan = (b: Box3) => { const s = b.getSize(new Vector3()); return Math.max(s.x, s.y, s.z); };

  // 主判据（留一法）：把某个特征单独拿出来，若它的跨度远大于「去掉它之后其余零件的整体跨度」，
  // 它就是散开/超大的异常零件。阵列中心留在原点、把一圈环甩到几米外时，环组自身横跨整个场景，
  // 而其余零件仍是正常大小——这个对比最稳健，不依赖「哪个是主体/典型尺寸」的猜测。
  // 例：电风扇正常零件整体约 1.6m，散落同心丝组自身 3.58m → 3.58 > 1.6×1.5，报出；
  //     立杆自身 1.12m < 1.6×1.5，不误报。
  const whole = boundsOf(parts.map((p) => p.geometry));
  const wholeCenter = whole.getCenter(new Vector3());
  const wholeSize = whole.getSize(new Vector3());

  const grouped = new Map<string, { count: number; dist: number; huge: number; rest: number }>();
  entries.forEach((entry) => {
    // 去掉「同 label 的全部实例」后的整体跨度 = 基线。
    // 按 label 去而不是逐个去：一圈散落的环是同一阵列产生的，去掉一个还有三个撑着基线，
    // 整组去掉才露出「其余零件其实很小」的事实。
    const rest = new Box3();
    entries.forEach((other) => { if (other.label !== entry.label) rest.union(other.box); });
    const restSpan = rest.isEmpty() ? 0 : boxSpan(rest);
    const baseline = Math.max(restSpan, 0.3); // 小模型给下限，避免噪声放大
    const maxSide = boxSpan(entry.box);
    const dist = entry.center.distanceTo(wholeCenter);
    const isHuge = maxSide > baseline * 1.5 + 0.1;
    const isFar = dist > baseline * 1.8 + 0.2 && entries.length >= 3; // 样本太少不用中心判据
    if (!isHuge && !isFar) return;
    const g = grouped.get(entry.label) ?? { count: 0, dist: 0, huge: 0, rest: 0 };
    g.count += 1;
    g.dist = Math.max(g.dist, dist);
    g.huge = Math.max(g.huge, maxSide);
    g.rest = Math.max(g.rest, restSpan);
    grouped.set(entry.label, g);
  });

  const issues: string[] = [];
  for (const [label, g] of grouped) {
    if (g.huge > g.rest * 1.5 + 0.1) {
      issues.push(`特征「${label}」${g.count > 1 ? `有 ${g.count} 个实例` : ''}自身跨度达 ${fixed(g.huge)} m，而其余零件整体仅 ${fixed(g.rest)} m——多半是阵列 pattern.center 留在原点/与主体不同轴，把零件甩散了`);
    } else {
      issues.push(`特征「${label}」${g.count > 1 ? `有 ${g.count} 个实例` : ''}中心距整体约 ${fixed(g.dist)} m，明显飘离——检查 translate 与 pattern.center`);
    }
  }
  const summary = `构件「${elementName}」共 ${entries.length} 个可测特征，整体跨度 ${fixed(wholeSize.x)} × ${fixed(wholeSize.y)} × ${fixed(wholeSize.z)} m`;
  if (!issues.length) return `${summary}；未发现明显离群或超大零件（这是采样包围盒判断，不代表无穿插）。`;
  return `${summary}；发现 ${issues.length} 类可疑几何：\n${issues.slice(0, 8).map((s, i) => `  ${i + 1}. ${s}`).join('\n')}${issues.length > 8 ? `\n  …另有 ${issues.length - 8} 类` : ''}\n建议用 editFeature 修正 translate / pattern.center，或用 measure bounds 核对后再改。`;
}

/**
 * 按特征引用取一组零件几何。
 * 单个序号 / id / 唯一名称 → 一个特征；名称模糊匹配到多个特征 → 整组
 * （护网这种「前罩弧形网圈1/2/3/4」必须整组量，逐个量看不出收口）。
 */
function resolveParts(session: SolidSession, ref: string | number): { parts: SolidPartGeometry[]; name: string } {
  const text = String(ref).trim();
  const all = session.getParts();
  let matched = session.features;
  if (/^\d+$/.test(text)) {
    const feature = session.features[Number(text) - 1];
    if (!feature) throw new Resolution(`特征序号 ${text} 超出范围（1 ~ ${session.features.length}）`);
    matched = [feature];
  } else {
    const byId = session.features.find((feature) => feature.id === text);
    if (byId) matched = [byId];
    else {
      const exact = session.features.filter((feature) => feature.label === text);
      matched = exact.length ? exact : session.features.filter((feature) => (feature.label ?? '').includes(text));
    }
  }
  if (!matched.length) throw new Resolution(`找不到特征「${text}」，当前特征：${session.features.map((f, i) => `${i + 1}.${f.label ?? f.shape.shape}`).join('、')}`);
  const ids = new Set(matched.map((feature) => feature.id));
  const parts = all.filter((part) => ids.has(part.id));
  if (!parts.length) throw new Resolution(`特征「${text}」没有可测量的几何`);
  const name = matched.length === 1
    ? `特征「${matched[0]!.label ?? matched[0]!.shape.shape}」`
    : `特征组「${text}」（${matched.length} 个特征 / ${parts.length} 个实例）`;
  return { parts, name };
}

const axisMin = (box: Box3, axis: 'x' | 'y' | 'z') => (axis === 'x' ? box.min.x : axis === 'y' ? box.min.y : box.min.z);
const axisMax = (box: Box3, axis: 'x' | 'y' | 'z') => (axis === 'x' ? box.max.x : axis === 'y' ? box.max.y : box.max.z);

/** 包覆关系：外罩的包围盒是否在容差内完整包住内件，并沿轴向盖过两端 */
function describeEnclosure(session: SolidSession, request: Extract<AiMeasureRequest, { type: 'enclosure' }>): string {
  const outerRef = resolveParts(session, request.outer);
  const innerRef = resolveParts(session, request.inner);
  const outer = boundsOf(outerRef.parts.map((part) => part.geometry));
  const inner = boundsOf(innerRef.parts.map((part) => part.geometry));
  if (outer.isEmpty() || inner.isEmpty()) throw new Resolution('包覆双方至少有一方没有可测量的几何');
  const axis = request.axis ?? 'z';
  const marginRaw = Number(request.margin ?? 0.01);
  const margin = Number.isFinite(marginRaw) ? Math.min(1, Math.max(0, marginRaw)) : 0.01;
  const lateral = (['x', 'y', 'z'] as const).filter((item) => item !== axis);
  const rows = lateral.map((item) => {
    const pass = axisMin(outer, item) <= axisMin(inner, item) - margin && axisMax(outer, item) >= axisMax(inner, item) + margin;
    return `${item}: 外 [${fixed(axisMin(outer, item))}, ${fixed(axisMax(outer, item))}] / 内 [${fixed(axisMin(inner, item))}, ${fixed(axisMax(inner, item))}] ${pass ? '包住' : '未包住'}`;
  });
  const axialPass = axisMin(outer, axis) <= axisMin(inner, axis) - margin / 2
    && axisMax(outer, axis) >= axisMax(inner, axis) + margin / 2;
  rows.push(`${axis}（轴向）: 外 [${fixed(axisMin(outer, axis))}, ${fixed(axisMax(outer, axis))}] / 内 [${fixed(axisMin(inner, axis))}, ${fixed(axisMax(inner, axis))}] ${axialPass ? '盖过两端' : '未盖过两端'}`);
  const pass = lateral.every((item) => axisMin(outer, item) <= axisMin(inner, item) - margin && axisMax(outer, item) >= axisMax(inner, item) + margin) && axialPass;
  return `包覆关系 外=${outerRef.name} 内=${innerRef.name}（容差 ${fixed(margin)} m）：\n  ${rows.join('\n  ')}\n判断：${pass ? '外件在三个方向都包住内件，且轴向盖过两端' : '外件没有完整包住内件——若这是防护罩/壳体，说明还没把被包件罩起来'}。这是包围盒判断，不代表曲面贴合。`;
}

/**
 * 对齐诊断：compare 特征组相对 base 特征组的包围盒中心偏移与轴向伸出量。
 * 专治「护条阵列中心偏离罩体轴线」「护条末端像刺一样戳出罩子」这类肉眼才看得出、
 * 现有包覆/轮廓测量都漏掉的几何错误——给出具体数字，AI 才能据它改 translate / path。
 */
function describeAlignment(session: SolidSession, request: Extract<AiMeasureRequest, { type: 'alignment' }>): string {
  const baseRef = resolveParts(session, request.base);
  const compareRef = resolveParts(session, request.compare);
  const base = boundsOf(baseRef.parts.map((part) => part.geometry));
  const compare = boundsOf(compareRef.parts.map((part) => part.geometry));
  if (base.isEmpty() || compare.isEmpty()) throw new Resolution('对齐双方至少有一方没有可测量的几何');
  const marginRaw = Number(request.margin ?? 0.005);
  const margin = Number.isFinite(marginRaw) ? Math.min(1, Math.max(0, marginRaw)) : 0.005;
  const axes = ['x', 'y', 'z'] as const;
  const center = (box: Box3, axis: 'x' | 'y' | 'z') => (axisMin(box, axis) + axisMax(box, axis)) / 2;
  const rows = axes.map((item) => {
    const delta = center(compare, item) - center(base, item);
    const cmpMin = axisMin(compare, item); const cmpMax = axisMax(compare, item);
    const outLow = axisMin(base, item) - cmpMin;   // compare 比 base 多伸出的低端
    const outHigh = cmpMax - axisMax(base, item);  // compare 比 base 多伸出的高端
    const aligned = Math.abs(delta) <= margin;
    return `${item}: 中心偏移 ${fixed(delta)} m ${aligned ? '对齐' : '偏心'}；compare [${fixed(cmpMin)}, ${fixed(cmpMax)}] / base [${fixed(axisMin(base, item))}, ${fixed(axisMax(base, item))}]，低端伸出 ${fixed(Math.max(0, outLow))} m，高端伸出 ${fixed(Math.max(0, outHigh))} m`;
  });
  const eccentric = axes.filter((item) => Math.abs(center(compare, item) - center(base, item)) > margin);
  const axis = request.axis;
  const axial = axis ? axes.find((item) => item === axis) : undefined;
  const verdict = eccentric.length
    ? `compare 相对 base 在 ${eccentric.join('、')} 方向偏心（超过容差 ${fixed(margin)} m）——若 compare 是环形阵列护条、base 是罩体，说明阵列中心没落在罩体轴线上，应把 pattern.center 或 translate 改到 base 的中心。`
    : '三者中心对齐' + (axial ? `；轴向 ${axial} 的伸出量见上，护条末端不该明显超过罩体边缘` : '');
  return `对齐诊断 base=${baseRef.name} compare=${compareRef.name}（中心容差 ${fixed(margin)} m）：\n  ${rows.join('\n  ')}\n判断：${verdict} 这是包围盒判断，不代表曲面贴合。`;
}

/**
 * 实心面遮挡诊断：沿 axis 方向对特征投影面打 N×N 网格射线，统计命中比例（填充率）。
 *
 * 专治「防护网 / 网罩被做成实心 loft 锥碗（锅盖）」——这类错误用包围盒看是「包住」、
 * 用轴向轮廓看是「收口」，但其实是挡住内部零件的实心面。真正的镂空网架填充率低，
 * 实心锅盖填充率接近 1。给出可执行的数字阈值，AI 才能据它把实心面改成网圈+护条。
 */
function describeSolidCover(session: SolidSession, request: Extract<AiMeasureRequest, { type: 'solidCover' }>): string {
  const ref = resolveParts(session, request.feature);
  const axis = request.axis;
  const lateral = (['x', 'y', 'z'] as const).filter((item) => item !== axis);
  const box = boundsOf(ref.parts.map((part) => part.geometry));
  if (box.isEmpty()) throw new Resolution('没有可测量的几何');
  // 网格必须够密：粗网格（9×9）会把细丝的投影过度计数，密集网罩能到 65% 被误判成实心锅盖；
  // 15×15 实测网罩 25~34%、实心碗 79%，才有清晰分界。
  const gridRaw = Number(request.grid ?? 15);
  const grid = Number.isFinite(gridRaw) ? Math.min(31, Math.max(9, Math.round(gridRaw))) : 15;
  const meshes = ref.parts.map((part) => new Mesh(part.geometry, MATERIAL));
  const lead = 1;
  const makeOrigin = (u: number, v: number): Vector3 => {
    if (axis === 'z') return new Vector3(u, v, box.max.z + lead);
    if (axis === 'x') return new Vector3(box.max.x + lead, u, v);
    return new Vector3(u, box.max.y + lead, v);
  };
  const direction = axis === 'z' ? new Vector3(0, 0, -1) : axis === 'x' ? new Vector3(-1, 0, 0) : new Vector3(0, -1, 0);
  const lo0 = axisMin(box, lateral[0]); const hi0 = axisMax(box, lateral[0]);
  const lo1 = axisMin(box, lateral[1]); const hi1 = axisMax(box, lateral[1]);
  let hits = 0;
  let total = 0;
  const raycaster = new Raycaster();
  for (let i = 0; i < grid; i += 1) {
    for (let j = 0; j < grid; j += 1) {
      const u = lo0 + (hi0 - lo0) * ((i + 0.5) / grid);
      const v = lo1 + (hi1 - lo1) * ((j + 0.5) / grid);
      total += 1;
      raycaster.set(makeOrigin(u, v), direction);
      if (raycaster.intersectObjects(meshes, false).length) hits += 1;
    }
  }
  const fill = hits / Math.max(1, total);
  const solidThreshold = 0.6;
  const openThreshold = 0.4;
  const verdict = fill >= solidThreshold
    ? `疑似实心面（填充率 ${(fill * 100).toFixed(0)}% ≥ ${solidThreshold * 100}%）：这个特征几乎铺满自己的投影面，会挡住后面的零件。如果它是防护网 / 罩子，说明被做成了实心 loft 锥碗（锅盖）——必须改用细网圈（torus / tube / revolve 薄环）+ 弯曲护条（sweep）搭出镂空骨架，不能用带 ellipse 剖面的 loft 封盖成实心面。`
    : fill <= openThreshold
      ? `镂空骨架（填充率 ${(fill * 100).toFixed(0)}% ≤ ${openThreshold * 100}%）：视线大部分能穿过，符合网罩形态。`
      : `半通透（填充率 ${(fill * 100).toFixed(0)}%）：介于镂空与实心之间，结合截图判断是否该继续减少实体面积。`;
  return `实心面遮挡 ${ref.name} 沿 ${axis} 轴投影（${grid}×${grid} 网格射线）：命中 ${hits}/${total}，填充率 ${(fill * 100).toFixed(0)}%。\n判断：${verdict} 这是射线采样估算，不代表拓扑精确的遮挡率。`;
}

/** 轴向轮廓：半径沿轴是否单调收口，用来区分「弧形罩」和「平面圆盘」 */
function describeAxialProfile(session: SolidSession, request: Extract<AiMeasureRequest, { type: 'axialProfile' }>): string {
  const ref = resolveParts(session, request.feature);
  const axis = request.axis;
  const lateral = (['x', 'y', 'z'] as const).filter((item) => item !== axis);
  const samples = ref.parts.map((part) => {
    const box = boundsOf([part.geometry]);
    const center = (axisMin(box, axis) + axisMax(box, axis)) / 2;
    const half = (item: 'x' | 'y' | 'z') => (axisMax(box, item) - axisMin(box, item)) / 2;
    return { axis: center, radius: Math.max(half(lateral[0]!), half(lateral[1]!)) };
  }).filter((sample) => Number.isFinite(sample.axis) && Number.isFinite(sample.radius));
  if (!samples.length) throw new Resolution('没有可测量的轮廓');
  const anchor = samples.reduce((max, item) => (item.radius > max.radius ? item : max));
  const ordered = [...samples].sort((a, b) => Math.abs(a.axis - anchor.axis) - Math.abs(b.axis - anchor.axis));
  const rows = ordered.map((sample) => `${axis}=${fixed(sample.axis)} 半径≈${fixed(sample.radius)} m（离外缘 ${fixed(Math.abs(sample.axis - anchor.axis))} m）`);
  if (ordered.length < 3) return `轴向轮廓 ${ref.name} 沿 ${axis} 轴只有 ${ordered.length} 个有效截面，不足以判断弧度：\n  ${rows.join('\n  ')}\n建议给罩体 3 圈以上递缩截面。`;
  let drops = 0;
  for (let index = 1; index < ordered.length; index += 1) {
    if (ordered[index]!.radius <= ordered[index - 1]!.radius * 1.02) drops += 1;
  }
  const first = ordered[0]!.radius;
  const last = ordered[ordered.length - 1]!.radius;
  const verdict = drops === ordered.length - 1 && last < first * 0.9
    ? '收口明显：半径随离外缘距离单调减小，符合弧形罩/锥罩'
    : (Math.abs(last - first) < first * 0.1
      ? '几乎不收口：各截面半径相近，更像平面圆盘而不是弧形罩'
      : '轮廓有变化但不单调，未形成清晰的弧形收口');
  return `轴向轮廓 ${ref.name} 沿 ${axis} 轴（${ordered.length} 个截面）：\n  ${rows.join('\n  ')}\n判断：${verdict}。这是按包围盒半跨度估算的半径，不代替真实曲面曲率。`;
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
  if (request.type === 'anomalies') {
    return detectAnomalies(session, element.name);
  }
  if (request.type === 'enclosure') {
    return describeEnclosure(session, request);
  }
  if (request.type === 'axialProfile') {
    return describeAxialProfile(session, request);
  }
  if (request.type === 'alignment') {
    return describeAlignment(session, request);
  }
  if (request.type === 'solidCover') {
    return describeSolidCover(session, request);
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
        lines.push(`${index + 1}. 无法测量：${error instanceof Resolution ? error.message : `求值失败（${error instanceof Error ? error.message : String(error)}）`}`);
      }
    });
  } finally {
    sessions.forEach((session) => session.dispose());
  }
  return lines.join('\n');
}
