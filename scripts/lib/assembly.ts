/**
 * 零件合并器：把多个「零件 Agent」的局部坐标产物 + 「拼接 Agent」的摆放表，
 * 合成**唯一一条 addSolid 指令**。
 *
 * 分工边界（重要）：
 * - 零件 Agent 只写 features（自己的局部坐标系）、bbox、anchors，不写整车位置；
 * - 拼接 Agent 只写 placements（translate / rotate / scale / mirror），不碰零件内部几何；
 * - 本文件负责校验、预算、包 group、套变换、排切除顺序，产出可直接送 applyOps 的 ops。
 *
 * 为什么每个零件必须包一层 group：内核的 group 支持平移/旋转/缩放/阵列/镜像，
 * 且子特征的材质、切除都封闭在组内求值 —— 拼接 Agent 才能只动一个零件而不牵连别人。
 * 代价是「跨零件切除」不能写在组里（组内的 cut 只切自己组的零件），
 * 所以提供 scope:'root' / spec.cuts：这类特征提升到顶层、排在所有 group 之后，
 * 坐标必须是整车根坐标（不是零件局部坐标）。
 *
 * 用法：
 *   const { ops, report } = mergeAssembly(spec);
 *   const doc = applyOps(project, ops);
 */
import { Vector3 } from 'three';
import { SOLID_LIMITS, normalizeFeatures } from '../../server/ai/solid.js';

export type Vec3 = [number, number, number];
export type Feature = Record<string, unknown>;

export interface Anchor {
  /** 连接点名，例如「镜座根部」；同一零件内唯一 */
  name: string;
  /** 零件局部坐标（米） */
  at: Vec3;
  /** 外法向（可选），贴合件用它决定朝向 */
  normal?: Vec3;
}

export interface PartManifest {
  /** 稳定英文 id（slug），决定 group id 与特征 id 前缀；合并后按零件返工全靠它 */
  id: string;
  /** 零件中文名，同时是 group 的 label */
  name: string;
  /** 统一材质约定：预设名或 { name, color, roughness, metalness, opacity } */
  material?: string | Record<string, unknown>;
  /** 局部坐标系里的特征数组；首特征必须是 add */
  features: Feature[];
  /** 声明的连接点，合并时按 placement 换算成整车坐标写进 report */
  anchors?: Anchor[];
  /** 声明的局部包围盒（可选，交给查询接口核对，合并器不自行求值几何） */
  bbox?: { min: Vec3; max: Vec3 };
  /** 该零件的特征配额（不含 group 外壳）；提前分预算，超了直接报错 */
  quota?: number;
  /**
   * part（默认）：包成 group，坐标是零件局部坐标，由 placement 摆放。
   * root：特征直接放到顶层、排在所有 group 之后，坐标必须是整车根坐标；
   *       只用于「要切到别的零件」的切除/相交特征。
   */
  scope?: 'part' | 'root';
  note?: string;
}

export interface Placement {
  part: string;
  translate?: Vec3;
  /** 度，顺序与内核一致：X → Y → Z */
  rotate?: Vec3;
  scale?: number | Vec3;
  /** 镜像面法向 + 面上一点；内核会同时保留原件与镜像件 */
  mirror?: { axis?: 'x' | 'y' | 'z'; center?: Vec3 };
  /** group 自带阵列；与 mirror 互斥（一个特征只能有一条 pattern） */
  array?: {
    type: 'linear' | 'circular';
    count: number;
    step?: Vec3;
    axis?: 'x' | 'y' | 'z';
    angle?: number;
    center?: Vec3;
  };
}

export interface AssemblySpec {
  name: string;
  color?: string;
  /** addSolid 的构件位置，[x,y] 或 [x,y,z] */
  position?: [number, number] | Vec3;
  /** addSolid 的整件旋转（度，绕 Z）与缩放 */
  rotation?: number;
  scale?: number;
  parts: PartManifest[];
  /** 一个零件最多一条；不给就是单位变换 */
  placements?: Placement[];
  /** 顶层共享切除（整车根坐标），排在所有零件之后 */
  cuts?: Feature[];
  budget?: { total?: number; reserved?: number };
}

export interface AssemblyErrorDetail {
  part?: string;
  field?: string;
  hint?: string;
}

export class AssemblyError extends Error {
  constructor(message: string, readonly detail: AssemblyErrorDetail = {}) {
    super(message);
    this.name = 'AssemblyError';
  }
}

export interface MergedAnchor {
  part: string;
  name: string;
  at: Vec3;
  normal?: Vec3;
  /** 镜像 placement 会额外产出一份镜像连接点 */
  mirrored?: boolean;
}

export interface AssemblyReport {
  name: string;
  /** 顶层特征数（含 group 外壳与嵌套子特征），与服务端 96 上限对齐 */
  featureCount: number;
  limit: number;
  parts: Array<{
    id: string;
    name: string;
    groupId?: string;
    featureCount: number;
    quota?: number;
    scope: 'part' | 'root';
    placement: Placement;
    anchors: MergedAnchor[];
  }>;
  /** 顶层切除数量（含 scope:'root' 的零件与 spec.cuts） */
  rootCuts: number;
  /** 组内切除数量 */
  innerCuts: number;
  warnings: string[];
}

export interface MergeResult {
  /** 长度恒为 1 */
  ops: Array<Record<string, unknown>>;
  report: AssemblyReport;
}

const ID_RE = /^[a-z][a-z0-9_-]*$/i;
const CUT_MODES = new Set(['cut', 'intersect']);

function fail(message: string, detail: AssemblyErrorDetail = {}): never {
  throw new AssemblyError(message, detail);
}

function isVec3(value: unknown): value is Vec3 {
  return Array.isArray(value) && value.length === 3 && value.every((n) => typeof n === 'number' && Number.isFinite(n));
}

function childrenOf(feature: Feature): Feature[] | null {
  const shape = feature.shape;
  if (shape && typeof shape === 'object' && Array.isArray((shape as Feature).features)) {
    return (shape as Feature).features as Feature[];
  }
  return Array.isArray(feature.features) ? (feature.features as Feature[]) : null;
}

function shapeName(feature: Feature): string {
  const shape = feature.shape;
  if (typeof shape === 'string') return shape;
  if (shape && typeof shape === 'object') return String((shape as Feature).shape ?? '?');
  return String(feature.kind ?? feature.type ?? '?');
}

function modeOf(feature: Feature): string {
  return typeof feature.mode === 'string' ? feature.mode : 'add';
}

/** 递归统计特征数（含嵌套组）与最大 group 嵌套深度 */
function inspectTree(features: Feature[], depth = 0): { count: number; groupDepth: number; cuts: number } {
  let count = 0;
  let groupDepth = depth;
  let cuts = 0;
  for (const feature of features) {
    count += 1;
    if (CUT_MODES.has(modeOf(feature))) cuts += 1;
    const children = childrenOf(feature);
    if (children) {
      const inner = inspectTree(children, depth + 1);
      count += inner.count;
      cuts += inner.cuts;
      groupDepth = Math.max(groupDepth, inner.groupDepth);
    }
  }
  return { count, groupDepth, cuts };
}

/** 给每个特征补稳定 id / label，并收集全局 label 冲突 */
function stabilize(features: Feature[], prefix: string, labels: Map<string, string>, used: Set<string>): Feature[] {
  return features.map((feature, index) => {
    const explicit = typeof feature.id === 'string' ? feature.id.trim() : '';
    let id = explicit || `${prefix}-f${index + 1}`;
    if (used.has(id)) fail(`特征 id「${id}」重复，请改名或让合并器自动生成`, { field: 'features[].id' });
    used.add(id);

    const label = typeof feature.label === 'string' && feature.label.trim()
      ? feature.label.trim()
      : `${prefix}-${index + 1}`;
    const owner = labels.get(label);
    if (owner) fail(`特征名「${label}」在「${owner}」里已经用过，合并后无法按名字返工；请改成唯一名字`, { field: 'features[].label' });
    labels.set(label, prefix);

    const copy: Feature = { ...feature, id, label };
    const children = childrenOf(feature);
    if (children) {
      const next = stabilize(children, id, labels, used);
      const shape = feature.shape;
      if (shape && typeof shape === 'object' && Array.isArray((shape as Feature).features)) {
        copy.shape = { ...(shape as Feature), features: next };
      } else {
        copy.features = next;
      }
    }
    return copy;
  });
}

/**
 * 只保证「切之前有材料」：若开头就是 cut / intersect，把第一个 add 挪到最前。
 * 不把所有切除都挪到末尾 —— 有些切除后面紧跟内衬/填充件（挖了孔再装回去），
 * 强行把 cut 排到最后会把填充件也切掉，反而改变设计意图。
 * 跨零件的顶层切除由 mergeAssembly 统一排在所有 group 之后，不在这里处理。
 */
function orderFeatures(features: Feature[]): Feature[] {
  const firstAdd = features.findIndex((feature) => !CUT_MODES.has(modeOf(feature)));
  if (firstAdd <= 0) return features.slice();
  return [features[firstAdd]!, ...features.slice(0, firstAdd), ...features.slice(firstAdd + 1)];
}

function validatePlacement(placement: Placement, known: Set<string>): Placement {
  if (!placement || typeof placement !== 'object') fail('placements[] 必须是对象');
  if (typeof placement.part !== 'string' || !known.has(placement.part)) {
    fail(`placements 引用了不存在的零件「${String(placement.part)}」`, { field: 'part' });
  }
  if (placement.translate !== undefined && !isVec3(placement.translate)) fail(`零件「${placement.part}」的 translate 必须是 [x,y,z]`);
  if (placement.rotate !== undefined && !isVec3(placement.rotate)) fail(`零件「${placement.part}」的 rotate 必须是 [x,y,z]（度）`);
  if (placement.scale !== undefined) {
    const ok = typeof placement.scale === 'number' && Number.isFinite(placement.scale) && placement.scale > 0
      || isVec3(placement.scale) && placement.scale.every((n) => n > 0);
    if (!ok) fail(`零件「${placement.part}」的 scale 必须是正数或三个正数`);
  }
  if (placement.mirror !== undefined) {
    const axis = placement.mirror.axis ?? 'y';
    if (!['x', 'y', 'z'].includes(axis)) fail(`零件「${placement.part}」的 mirror.axis 只能是 x / y / z`);
    if (placement.mirror.center !== undefined && !isVec3(placement.mirror.center)) {
      fail(`零件「${placement.part}」的 mirror.center 必须是 [x,y,z]`);
    }
  }
  if (placement.array !== undefined) {
    const array = placement.array;
    if (array.type !== 'linear' && array.type !== 'circular') fail(`零件「${placement.part}」的 array.type 只能是 linear / circular`);
    if (!Number.isInteger(array.count) || array.count < 1 || array.count > SOLID_LIMITS.patternCount) {
      fail(`零件「${placement.part}」的 array.count 超出 1~${SOLID_LIMITS.patternCount}`);
    }
    if (array.type === 'linear' && !isVec3(array.step)) fail(`零件「${placement.part}」的线性阵列需要 step:[x,y,z]`);
    if (array.axis !== undefined && !['x', 'y', 'z'].includes(array.axis)) fail(`零件「${placement.part}」的 array.axis 只能是 x / y / z`);
    if (array.center !== undefined && !isVec3(array.center)) fail(`零件「${placement.part}」的 array.center 必须是 [x,y,z]`);
  }
  if (placement.mirror && placement.array) {
    fail(`零件「${placement.part}」不能同时给 mirror 和 array（group 只有一条 pattern）`, { part: placement.part });
  }
  return placement;
}

/** 拼接变换：与内核 applyTransform 完全同序（scale → rotateX → rotateY → rotateZ → translate） */
function transformPoint(point: Vec3, placement: Placement, isNormal = false): Vec3 {
  const v = new Vector3(point[0], point[1], point[2]);
  const scale = placement.scale;
  if (!isNormal) {
    if (typeof scale === 'number') v.multiplyScalar(scale);
    else if (Array.isArray(scale)) v.set(v.x * scale[0], v.y * scale[1], v.z * scale[2]);
  }
  const [rx, ry, rz] = placement.rotate ?? [0, 0, 0];
  const rad = Math.PI / 180;
  if (rx) v.applyAxisAngle(new Vector3(1, 0, 0), rx * rad);
  if (ry) v.applyAxisAngle(new Vector3(0, 1, 0), ry * rad);
  if (rz) v.applyAxisAngle(new Vector3(0, 0, 1), rz * rad);
  if (!isNormal) {
    const [tx, ty, tz] = placement.translate ?? [0, 0, 0];
    v.add(new Vector3(tx, ty, tz));
  }
  return [v.x, v.y, v.z] as Vec3;
}

function mirroredPoint(point: Vec3, axis: 'x' | 'y' | 'z', center: Vec3): Vec3 {
  const index = axis === 'x' ? 0 : axis === 'y' ? 1 : 2;
  const out: Vec3 = [point[0], point[1], point[2]];
  out[index] = 2 * center[index] - out[index];
  return out;
}

function anchorsOf(part: PartManifest, placement: Placement): MergedAnchor[] {
  const result: MergedAnchor[] = [];
  const mirror = placement.mirror;
  for (const anchor of part.anchors ?? []) {
    if (!anchor || typeof anchor.name !== 'string' || !anchor.name.trim()) {
      fail(`零件「${part.id}」有连接点没写 name`, { part: part.id, field: 'anchors[].name' });
    }
    if (!isVec3(anchor.at)) fail(`连接点「${anchor.name}」的 at 必须是 [x,y,z]`, { part: part.id });
    if (anchor.normal !== undefined && !isVec3(anchor.normal)) {
      fail(`连接点「${anchor.name}」的 normal 必须是 [x,y,z]`, { part: part.id });
    }
    const at = transformPoint(anchor.at, placement);
    const normal = anchor.normal ? transformPoint(anchor.normal, placement, true) : undefined;
    result.push({ part: part.id, name: anchor.name, at, ...(normal ? { normal } : {}) });
    if (mirror) {
      const axis = mirror.axis ?? 'y';
      const center = mirror.center ?? [0, 0, 0];
      const mAt = mirroredPoint(at, axis, center);
      const mNormal = normal ? mirroredPoint(normal, axis, [0, 0, 0]) : undefined;
      result.push({ part: part.id, name: `${anchor.name}·镜像`, at: mAt, ...(mNormal ? { normal: mNormal } : {}), mirrored: true });
    }
  }
  return result;
}

/** 校验整份装配说明；不合法时抛出带可操作提示的 AssemblyError */
export function validateAssembly(spec: AssemblySpec): void {
  if (!spec || typeof spec !== 'object') fail('装配说明必须是对象');
  if (typeof spec.name !== 'string' || !spec.name.trim()) fail('缺少 name（模型名）');
  if (!Array.isArray(spec.parts) || !spec.parts.length) fail('parts 不能为空');

  const ids = new Set<string>();
  const names = new Set<string>();
  for (const part of spec.parts) {
    if (!part || typeof part !== 'object') fail('parts[] 必须是对象');
    if (typeof part.id !== 'string' || !ID_RE.test(part.id)) {
      fail(`零件 id「${String(part.id)}」不合法：用英文字母开头的 slug，例如 body / mirror-left`, { part: part.id });
    }
    if (ids.has(part.id)) fail(`零件 id「${part.id}」重复`, { part: part.id });
    ids.add(part.id);
    if (typeof part.name !== 'string' || !part.name.trim()) fail(`零件「${part.id}」缺少 name`, { part: part.id });
    if (names.has(part.name.trim())) fail(`零件名「${part.name}」重复，合并后无法按名字定位`, { part: part.id });
    names.add(part.name.trim());
    if (!Array.isArray(part.features) || !part.features.length) {
      fail(`零件「${part.id}」的 features 不能为空`, { part: part.id, field: 'features' });
    }
    if (part.quota !== undefined && (!Number.isInteger(part.quota) || part.quota < 1)) {
      fail(`零件「${part.id}」的 quota 必须是正整数`, { part: part.id });
    }
    if (part.bbox !== undefined && (!part.bbox || !isVec3(part.bbox.min) || !isVec3(part.bbox.max))) {
      fail(`零件「${part.id}」的 bbox 需要 { min:[x,y,z], max:[x,y,z] }`, { part: part.id });
    }
    const tree = inspectTree(part.features);
    const isRoot = (part.scope ?? 'part') === 'root';
    if (!isRoot && tree.groupDepth > 1) {
      fail(`零件「${part.id}」内部最多再嵌一层 group（连同合并器包的外壳共 2 层）`, { part: part.id, hint: '把更深的子装配拍平，或把该零件设为 scope:"root" 直通' });
    }
    if (isRoot && tree.groupDepth > 2) {
      fail(`零件「${part.id}」的 group 嵌套超过 2 层`, { part: part.id });
    }
    if (!isRoot && !part.features.some((feature) => !CUT_MODES.has(modeOf(feature)))) {
      fail(`零件「${part.id}」只有切除/相交特征：组内没有材料可切。若要切别的零件，请设 scope:'root'`, { part: part.id });
    }
    if (part.quota !== undefined && tree.count > part.quota) {
      fail(`零件「${part.id}」用了 ${tree.count} 个特征，超过分配配额 ${part.quota}（group 外壳另占 1 个）`, {
        part: part.id, hint: '减少阵列/拆分特征，或重新分配 quota',
      });
    }
  }

  const placements = spec.placements ?? [];
  const placed = new Set<string>();
  for (const placement of placements) {
    validatePlacement(placement, ids);
    if (placed.has(placement.part)) fail(`零件「${placement.part}」有两条 placement`, { part: placement.part });
    placed.add(placement.part);
  }
  for (const cut of spec.cuts ?? []) {
    if (!cut || typeof cut !== 'object') fail('cuts[] 必须是特征对象');
    if (!CUT_MODES.has(modeOf(cut))) {
      fail(`顶层 cuts 里出现 add 特征「${shapeName(cut)}」：要加实体请写成一个零件`, { hint: '顶层共享特征只接受 mode: cut / intersect' });
    }
  }
}

/** 按 96 上限提前分预算：返回每个零件的占用与总量，超了指名道姓 */
function budgetOf(spec: AssemblySpec): { total: number; limit: number; perPart: Map<string, number> } {
  const perPart = new Map<string, number>();
  let total = 0;
  for (const part of spec.parts) {
    const own = inspectTree(part.features).count;
    const cost = own + ((part.scope ?? 'part') === 'part' ? 1 : 0);
    perPart.set(part.id, cost);
    total += cost;
    if (part.quota !== undefined && own > part.quota) {
      fail(`零件「${part.id}」占 ${own} 个特征，超过配额 ${part.quota}`, { part: part.id });
    }
  }
  total += (spec.cuts ?? []).length;
  const limit = Math.min(SOLID_LIMITS.features, spec.budget?.total ?? SOLID_LIMITS.features);
  const reserved = spec.budget?.reserved ?? 0;
  if (total + reserved > limit) {
    const detail = [...perPart.entries()].map(([id, n]) => `${id}=${n}`).join('、');
    fail(`特征总数 ${total}${reserved ? ` + 预留 ${reserved}` : ''} 超过上限 ${limit}（${detail}）`, {
      hint: '给零件 Agent 重新分配 quota，或把细节改成阵列（阵列实例不占特征数）',
    });
  }
  return { total, limit, perPart };
}

/**
 * 合并：校验 → 分预算 → 稳定命名 → 包 group → 套放置变换 → 排切除 → 归一化 → 唯一 addSolid。
 *
 * 归一化复用服务端的 normalizeFeatures，等于「入库前先干跑一遍」：形状白名单、尺寸、
 * 材质预设、96 上限、2 层嵌套都在这里挡住，Agent 拿到的是可直接落库的 ops。
 */
export function mergeAssembly(spec: AssemblySpec): MergeResult {
  validateAssembly(spec);
  const budget = budgetOf(spec);
  const labels = new Map<string, string>();
  const used = new Set<string>();
  const warnings: string[] = [];
  const placements = new Map((spec.placements ?? []).map((item) => [item.part, item]));
  const identity: Placement = { part: '' };

  const topLevel: Feature[] = [];
  const rootFeatures: Feature[] = [];
  let innerCuts = 0;
  let rootCuts = 0;
  const reportParts: AssemblyReport['parts'] = [];

  for (const part of spec.parts) {
    const placement = placements.get(part.id) ?? { ...identity, part: part.id };
    const features = orderFeatures(stabilize(part.features, part.id, labels, used));
    const tree = inspectTree(features);
    const isRoot = (part.scope ?? 'part') === 'root';
    if (tree.groupDepth > (isRoot ? 2 : 1)) fail(`零件「${part.id}」group 嵌套超过 2 层`, { part: part.id });
    if (!part.material) warnings.push(`零件「${part.id}」没写 material，会跟随构件颜色；建议按统一材质约定补齐`);

    if (isRoot) {
      rootFeatures.push(...features);
      rootCuts += tree.cuts;
      reportParts.push({
        id: part.id, name: part.name, featureCount: tree.count, quota: part.quota,
        scope: 'root', placement, anchors: anchorsOf(part, placement),
      });
      continue;
    }

    const group: Feature = {
      id: `part-${part.id}`,
      label: part.name,
      shape: { shape: 'group', features },
      mode: 'add',
    };
    if (part.material) group.material = part.material;
    if (placement.translate) group.translate = placement.translate;
    if (placement.rotate) group.rotate = placement.rotate;
    if (placement.scale !== undefined) group.scale = placement.scale;
    if (placement.mirror) {
      group.pattern = { type: 'mirror', axis: placement.mirror.axis ?? 'y', center: placement.mirror.center ?? [0, 0, 0] };
    } else if (placement.array) {
      const array = placement.array;
      group.pattern = array.type === 'linear'
        ? { type: 'linear', count: array.count, step: array.step }
        : { type: 'circular', count: array.count, axis: array.axis ?? 'z', ...(array.angle !== undefined ? { angle: array.angle } : {}), center: array.center ?? [0, 0, 0] };
    }
    topLevel.push(group);
    innerCuts += tree.cuts;
    reportParts.push({
      id: part.id, name: part.name, groupId: `part-${part.id}`,
      featureCount: tree.count + 1, quota: part.quota,
      scope: 'part', placement, anchors: anchorsOf(part, placement),
    });
  }

  const cuts = stabilize(spec.cuts ?? [], 'root-cut', labels, used);
  rootFeatures.push(...orderFeatures(cuts));
  rootCuts += cuts.length;
  // 切除类零件统一排在「被切零件」之后：所有 group 先入，再是 root 空间的共享切除
  const features = [...topLevel, ...rootFeatures];

  // 首特征必须是 add（group 天然是 add）；root-only 装配没有材料可切
  if (features.length && modeOf(features[0]!) === 'cut') {
    fail('顶层第一个特征是 cut：至少需要 part 作用域的零件先提供材料');
  }

  let normalized: Feature[];
  try {
    normalized = normalizeFeatures(features, 'features') as unknown as Feature[];
  } catch (error) {
    fail(`合并结果没过服务端校验：${error instanceof Error ? error.message : String(error)}`, {
      hint: '按报错定位到具体零件，修好后重跑合并',
    });
  }

  const op: Record<string, unknown> = { op: 'addSolid', name: spec.name.trim(), features: normalized };
  if (spec.color) op.color = spec.color;
  if (spec.position) op.position = spec.position;
  if (typeof spec.rotation === 'number') op.rotation = spec.rotation;
  if (typeof spec.scale === 'number') op.scale = spec.scale;

  return {
    ops: [op],
    report: {
      name: spec.name.trim(),
      featureCount: budget.total,
      limit: budget.limit,
      parts: reportParts,
      rootCuts,
      innerCuts,
      warnings,
    },
  };
}

/**
 * 把一条已有的 addSolid 拆成「单零件装配」，用于回归验证或给拼接 Agent 做基线。
 * 原树若已经有 2 层 group，合并器再包一层就会超过上限，这时退化成 scope:'root'
 * 的直通零件（不再包 group），保证往返一致；要给每个零件独立摆放请手动拆 parts。
 */
export function assemblyFromOps(ops: unknown[], name?: string): AssemblySpec {
  const solid = ops.find((op) => op && typeof op === 'object' && (op as Feature).op === 'addSolid') as Feature | undefined;
  if (!solid || !Array.isArray(solid.features)) fail('ops 里没有带 features 的 addSolid');
  const features = solid.features as Feature[];
  const deep = inspectTree(features).groupDepth > 1;
  const spec: AssemblySpec = {
    name: name ?? String(solid.name ?? '装配模型'),
    parts: [{
      id: 'main', name: '主体', features,
      ...(deep ? { scope: 'root' as const, note: '原树已有 2 层 group，直通不额外包外壳' } : {}),
    }],
  };
  if (typeof solid.color === 'string') spec.color = solid.color;
  if (Array.isArray(solid.position)) spec.position = solid.position as Vec3;
  return spec;
}

/** 供 CLI 打印的可读摘要 */
export function formatReport(report: AssemblyReport): string {
  const lines = [
    `装配「${report.name}」：${report.featureCount}/${report.limit} 个特征，${report.parts.length} 个零件`,
    `切除：组内 ${report.innerCuts} 个，顶层 ${report.rootCuts} 个（顶层排在所有零件之后）`,
  ];
  for (const part of report.parts) {
    const place = part.placement;
    const t = place.translate ? ` 平移(${place.translate.join(', ')})` : '';
    const r = place.rotate ? ` 旋转(${place.rotate.join(', ')})` : '';
    const s = place.scale ? ` 缩放(${String(place.scale)})` : '';
    const m = place.mirror ? ` 镜像(${place.mirror.axis ?? 'y'})` : '';
    lines.push(`  · ${part.id}「${part.name}」${part.featureCount} 特征${part.quota ? `/配额 ${part.quota}` : ''}${t}${r}${s}${m}`);
    for (const anchor of part.anchors) {
      lines.push(`      ⊙ ${anchor.name} → (${anchor.at.map((n) => n.toFixed(3)).join(', ')})`);
    }
  }
  report.warnings.forEach((warning) => lines.push(`  ! ${warning}`));
  return lines.join('\n');
}

/** 归一化数值输出，避免报告里出现 -0 / 浮点噪声 */
export function tidy(value: number): number {
  const rounded = Number(value.toFixed(6));
  return Object.is(rounded, -0) ? 0 : rounded;
}
