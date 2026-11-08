/**
 * Revit 式「修改」命令内核（纯函数，不依赖 React / three）。
 *
 * 操作逻辑与 Revit 一致：
 *   先选构件 → 点修改命令 → 上下文选项栏设置约束/复制/个数 → 在视口里依次取基点、终点
 *   → 视口显示幽灵预览与临时尺寸 → 点击 / Enter 完成，Esc 逐级退出。
 * 本模块负责状态机、变换计算、临时尺寸与提交；视口只负责取点与绘制预览。
 */
import { arrayElements, duplicateElements, rotateElement, selectionCenter, translateElement } from './edit';
import { polygonArea } from './document';
import { isElementLocked } from './layers';
import { createId } from './id';
import type { BimElement, ProjectDocument, Vec2, WallInstance } from './types';

export type ModifyCommandId =
  | 'move' | 'copy' | 'rotate'
  | 'mirror-draw' | 'mirror-pick'
  | 'array-linear' | 'array-radial'
  | 'align' | 'offset' | 'scale' | 'trim' | 'split'
  | 'measure' | 'pin' | 'unpin' | 'delete';

export const MODIFY_LABELS: Record<ModifyCommandId, string> = {
  move: '移动', copy: '复制', rotate: '旋转',
  'mirror-draw': '镜像 - 绘制轴', 'mirror-pick': '镜像 - 拾取轴',
  'array-linear': '线性阵列', 'array-radial': '环形阵列',
  align: '对齐', offset: '偏移', scale: '缩放', trim: '修剪 / 延伸', split: '拆分',
  measure: '测量', pin: '锁定', unpin: '解锁', delete: '删除',
};

/** Revit 双字母快捷键。 */
export const MODIFY_SHORTCUTS: Record<string, ModifyCommandId> = {
  MV: 'move', CO: 'copy', RO: 'rotate', MM: 'mirror-draw', DM: 'mirror-pick',
  AR: 'array-linear', RA: 'array-radial', AL: 'align', OF: 'offset',
  SZ: 'scale', TR: 'trim', SL: 'split', DI: 'measure',
  PN: 'pin', UP: 'unpin', DE: 'delete',
};

export const IMMEDIATE_COMMANDS: ReadonlySet<ModifyCommandId> = new Set(['pin', 'unpin', 'delete']);

export interface ModifyOptions {
  /** 约束：移动/复制/阵列约束到水平或垂直，旋转/环形阵列按 15° 增量 */
  constrain: boolean;
  /** 复制：保留原件（旋转 / 镜像 / 偏移 / 缩放） */
  copy: boolean;
  /** 多个：连续放置副本，Esc 结束（复制） */
  multiple: boolean;
  /** 阵列个数 / 拆分个数 */
  number: number;
  /** 偏移距离 / 移动距离（临时尺寸数值输入，米） */
  distance: number;
  /** 旋转角度 / 环形阵列总角度（数值输入，度） */
  angle: number;
  /** 缩放比例 */
  ratio: number;
  /** 线性阵列：第二点定义「最后一个」而不是「第二个」 */
  moveToLast: boolean;
  /** 拆分间隙（米） */
  splitGap: number;
}

export const DEFAULT_MODIFY_OPTIONS: ModifyOptions = {
  constrain: false, copy: false, multiple: false, number: 3,
  distance: 1, angle: 90, ratio: 2, moveToLast: false, splitGap: 0,
};

export type ModifyOptionKey = keyof ModifyOptions | 'center';

/** 每个命令在选项栏里出现的控件（Revit 上下文选项栏）。 */
export const MODIFY_OPTION_KEYS: Record<ModifyCommandId, readonly ModifyOptionKey[]> = {
  move: ['constrain', 'copy', 'distance'],
  copy: ['constrain', 'multiple', 'distance'],
  rotate: ['copy', 'angle', 'center'],
  'mirror-draw': ['copy'],
  'mirror-pick': ['copy'],
  'array-linear': ['constrain', 'number', 'moveToLast', 'distance'],
  'array-radial': ['number', 'angle', 'center'],
  align: ['constrain'],
  offset: ['copy', 'multiple', 'distance'],
  scale: ['copy', 'ratio'],
  trim: [],
  split: ['splitGap'],
  measure: [],
  pin: [], unpin: [], delete: [],
};

export type ModifyStatus = 'await-selection' | 'active' | 'finished';

export interface ModifySession {
  command: ModifyCommandId;
  ids: string[];
  points: Vec2[];
  /** 每次取点命中的构件 id（拾取轴 / 修剪 / 偏移 / 拆分用） */
  hits: Array<string | null>;
  /** 旋转 / 环形阵列中心，默认选集形心，可在视口里重新放置 */
  center: Vec2;
  options: ModifyOptions;
  status: ModifyStatus;
  /** 下一次点击用来重新放置旋转中心 */
  centerPending: boolean;
  /** 临时尺寸数值输入（米 / 度 / 比例，按命令解释） */
  numeric: number | null;
  note: string;
}

export interface ModifyClick {
  point: Vec2;
  hitId: string | null;
}

export type ElementTransform =
  | { kind: 'translate'; dx: number; dy: number; dz?: number }
  | { kind: 'rotate'; angle: number; center: Vec2 }
  | { kind: 'mirror'; linePoint: Vec2; lineDir: Vec2 }
  | { kind: 'scale'; factor: number; center: Vec2 };

export interface PreviewGuide {
  from: Vec2;
  to: Vec2;
  color?: string;
}

export interface PreviewSpec {
  /** 每个变换生成一份所有选中构件的幽灵副本 */
  ghosts: ElementTransform[];
  guides: PreviewGuide[];
  markers: Vec2[];
  label: string;
  labelAt: Vec2 | null;
}

export interface ModifyOutcome {
  /** 提交后的完整构件数组（未变化时应等于原数组） */
  elements: BimElement[];
  selection: string[];
  label: string;
  note?: string;
  error?: string;
  /** 「多个」复制：提交一份副本后命令继续，返回重置后的会话 */
  keepSession?: ModifySession;
}

const round = (value: number): number => Math.round(value * 1e6) / 1e6;
const add = (a: Vec2, b: Vec2): Vec2 => [a[0] + b[0], a[1] + b[1]];
const sub = (a: Vec2, b: Vec2): Vec2 => [a[0] - b[0], a[1] - b[1]];
const length = (v: Vec2): number => Math.hypot(v[0], v[1]);
const scale2 = (v: Vec2, k: number): Vec2 => [v[0] * k, v[1] * k];
const dot = (a: Vec2, b: Vec2): number => a[0] * b[0] + a[1] * b[1];
const distance = (a: Vec2, b: Vec2): number => length(sub(a, b));
const middle = (a: Vec2, b: Vec2): Vec2 => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
const deg = (rad: number): number => (rad * 180) / Math.PI;
const rad = (degrees: number): number => (degrees * Math.PI) / 180;

/** 归一化到 (-180°, 180°]，避免跨越 0° 时突然转一圈。 */
function normalizeDeg(value: number): number {
  let result = value % 360;
  if (result > 180) result -= 360;
  if (result <= -180) result += 360;
  return result;
}

/** 正交约束：只保留主导轴方向。 */
export function constrainVector(vector: Vec2, enabled: boolean): Vec2 {
  if (!enabled) return vector;
  return Math.abs(vector[0]) >= Math.abs(vector[1]) ? [vector[0], 0] : [0, vector[1]];
}

function constrainAngle(value: number, enabled: boolean): number {
  return enabled ? Math.round(value / 15) * 15 : value;
}

function direction(from: Vec2, to: Vec2): Vec2 {
  const delta = sub(to, from);
  const len = length(delta);
  return len < 1e-9 ? [1, 0] : [delta[0] / len, delta[1] / len];
}

export function reflectPoint(point: Vec2, linePoint: Vec2, lineDir: Vec2): Vec2 {
  // 关于「过 linePoint、方向 lineDir」的直线反射
  const dir = direction([0, 0], lineDir);
  const relative = sub(point, linePoint);
  const projection = dot(relative, dir);
  return [
    round(linePoint[0] + 2 * projection * dir[0] - relative[0]),
    round(linePoint[1] + 2 * projection * dir[1] - relative[1]),
  ];
}

function lineAngle(lineDir: Vec2): number {
  return Math.atan2(lineDir[1], lineDir[0]);
}

/** 关于任意直线镜像（edit.ts 只支持水平/垂直，这里补齐任意轴与导入网格）。 */
export function mirrorElementAboutLine(element: BimElement, linePoint: Vec2, lineDir: Vec2): BimElement {
  const map = (p: Vec2): Vec2 => reflectPoint(p, linePoint, lineDir);
  const phi = lineAngle(lineDir);
  if (element.category === 'wall') {
    return { ...element, start: map(element.start), end: map(element.end) };
  }
  if (element.category === 'column') {
    return {
      ...element,
      position: map(element.position),
      rotation: round(2 * phi - element.rotation),
    };
  }
  if (element.category === 'slab') {
    // 反射会翻转多边形绕序，反转数组保持轮廓方向
    return { ...element, points: element.points.map(map).reverse() };
  }
  const offset = element.offset ?? [0, 0, 0];
  const reflected = reflectPoint([offset[0], offset[1]], linePoint, lineDir);
  return {
    ...element,
    offset: [reflected[0], reflected[1], offset[2]],
    rotation: round(2 * phi - (element.rotation ?? 0)),
    flip: !element.flip,
  };
}

/** 缩放只作用于导入几何 / 参数化体量（Revit 不允许缩放墙柱板）。 */
export function scaleMeshElement(element: BimElement, factor: number, center: Vec2): BimElement {
  if (element.category !== 'mesh' || !Number.isFinite(factor) || factor <= 0) return element;
  const offset = element.offset ?? [0, 0, 0];
  const moved: Vec2 = [
    round(center[0] + (offset[0] - center[0]) * factor),
    round(center[1] + (offset[1] - center[1]) * factor),
  ];
  return {
    ...element,
    offset: [moved[0], moved[1], offset[2]],
    scale: round((element.scale ?? 1) * factor),
  };
}

export function applyTransform(element: BimElement, transform: ElementTransform): BimElement {
  switch (transform.kind) {
    case 'translate': return translateElement(element, { dx: transform.dx, dy: transform.dy, dz: transform.dz ?? 0 });
    case 'rotate': return rotateElement(element, { angle: transform.angle, center: transform.center });
    case 'mirror': return mirrorElementAboutLine(element, transform.linePoint, transform.lineDir);
    case 'scale': return scaleMeshElement(element, transform.factor, transform.center);
  }
}

/* ------------------------- 构件几何辅助 ------------------------- */

/** 构件上可用于捕捉 / 对齐的锚点。 */
export function elementAnchors(element: BimElement): Vec2[] {
  if (element.category === 'wall') return [element.start, element.end, middle(element.start, element.end)];
  if (element.category === 'column') return [element.position];
  if (element.category === 'slab') return [...element.points, ...element.points.map((p, i) => middle(p, element.points[(i + 1) % element.points.length]!))];
  const offset = element.offset ?? [0, 0, 0];
  return [[offset[0], offset[1]]];
}

function nearestAnchor(project: ProjectDocument, ids: string[], point: Vec2): Vec2 {
  let best: Vec2 = point;
  let bestDistance = Infinity;
  for (const element of project.elements) {
    if (!ids.includes(element.id)) continue;
    for (const anchor of elementAnchors(element)) {
      const d = distance(anchor, point);
      if (d < bestDistance) {
        bestDistance = d;
        best = anchor;
      }
    }
  }
  return best;
}

function wallById(project: ProjectDocument, id: string | null): WallInstance | null {
  const found = project.elements.find((element) => element.id === id);
  return found?.category === 'wall' ? found : null;
}

/** 无限直线交点（平行返回 null）。 */
function infiniteLineIntersection(a1: Vec2, a2: Vec2, b1: Vec2, b2: Vec2): Vec2 | null {
  const r = sub(a2, a1);
  const s = sub(b2, b1);
  const denominator = r[0] * s[1] - r[1] * s[0];
  if (Math.abs(denominator) < 1e-9) return null;
  const t = ((b1[0] - a1[0]) * s[1] - (b1[1] - a1[1]) * s[0]) / denominator;
  return [round(a1[0] + r[0] * t), round(a1[1] + r[1] * t)];
}

function closestPointOnSegment(point: Vec2, a: Vec2, b: Vec2): Vec2 {
  const segment = sub(b, a);
  const len2 = dot(segment, segment);
  if (len2 < 1e-12) return a;
  const t = Math.max(0, Math.min(1, dot(sub(point, a), segment) / len2));
  return [round(a[0] + segment[0] * t), round(a[1] + segment[1] * t)];
}

/** 拾取镜像轴：墙 / 轴网线，或楼板最近的边。 */
export function axisFromPick(project: ProjectDocument, hitId: string | null, point: Vec2): { linePoint: Vec2; lineDir: Vec2 } | null {
  const wall = wallById(project, hitId);
  if (wall) return { linePoint: wall.start, lineDir: sub(wall.end, wall.start) };
  const grid = project.grids.find((item) => item.id === hitId);
  if (grid) return { linePoint: grid.start, lineDir: sub(grid.end, grid.start) };
  const slab = project.elements.find((element) => element.id === hitId);
  if (slab?.category === 'slab') {
    let best: { a: Vec2; b: Vec2; d: number } | null = null;
    for (let index = 0; index < slab.points.length; index += 1) {
      const a = slab.points[index]!;
      const b = slab.points[(index + 1) % slab.points.length]!;
      const d = distance(closestPointOnSegment(point, a, b), point);
      if (!best || d < best.d) best = { a, b, d };
    }
    if (best) return { linePoint: best.a, lineDir: sub(best.b, best.a) };
  }
  // 没拾到线时，用最近的墙 / 轴网做轴（Revit 允许点选参照线，这里做容错）
  let nearest: { linePoint: Vec2; lineDir: Vec2; d: number } | null = null;
  const lines: Array<[Vec2, Vec2, number]> = [
    ...project.elements.filter((element): element is WallInstance => element.category === 'wall')
      .map((element) => [element.start, element.end, 0] as [Vec2, Vec2, number]),
    ...project.grids.map((grid) => [grid.start, grid.end, 0] as [Vec2, Vec2, number]),
  ];
  for (const [a, b] of lines) {
    const d = distance(closestPointOnSegment(point, a, b), point);
    if (!nearest || d < nearest.d) nearest = { linePoint: a, lineDir: sub(b, a), d };
  }
  return nearest && nearest.d < 1.5 ? { linePoint: nearest.linePoint, lineDir: nearest.lineDir } : null;
}

/** 偏移方向：墙/板的法线，柱/网格用「中心 → 点击侧」方向。 */
function offsetDirection(element: BimElement, sidePoint: Vec2 | null): { center: Vec2; normal: Vec2 } {
  const towardNormal = (center: Vec2): { center: Vec2; normal: Vec2 } => {
    const toward = sidePoint ? sub(sidePoint, center) : [1, 0] as Vec2;
    return { center, normal: length(toward) < 1e-9 ? ([1, 0] as Vec2) : scale2(toward, 1 / length(toward)) };
  };
  if (element.category === 'wall') {
    const dir = direction(element.start, element.end);
    return { center: middle(element.start, element.end), normal: [-dir[1], dir[0]] };
  }
  if (element.category === 'slab') {
    let best: { a: Vec2; b: Vec2; d: number } | null = null;
    const reference = sidePoint ?? [0, 0] as Vec2;
    for (let index = 0; index < element.points.length; index += 1) {
      const a = element.points[index]!;
      const b = element.points[(index + 1) % element.points.length]!;
      const d = distance(closestPointOnSegment(reference, a, b), reference);
      if (!best || d < best.d) best = { a, b, d };
    }
    if (best) {
      const dir = direction(best.a, best.b);
      return { center: middle(best.a, best.b), normal: [-dir[1], dir[0]] };
    }
    const center: Vec2 = [
      element.points.reduce((sum, point) => sum + point[0], 0) / Math.max(1, element.points.length),
      element.points.reduce((sum, point) => sum + point[1], 0) / Math.max(1, element.points.length),
    ];
    return towardNormal(center);
  }
  const center: Vec2 = element.category === 'column'
    ? element.position
    : [(element.offset ?? [0, 0, 0])[0], (element.offset ?? [0, 0, 0])[1]];
  const toward = sidePoint ? sub(sidePoint, center) : [1, 0] as Vec2;
  return { center, normal: length(toward) < 1e-9 ? ([1, 0] as Vec2) : scale2(toward, 1 / length(toward)) };
}

function nextName(project: ProjectDocument, category: BimElement['category']): string {
  const prefix = category === 'wall' ? '墙' : category === 'column' ? '柱' : category === 'slab' ? '楼板' : '构件';
  const used = new Set(project.elements.map((element) => element.name));
  for (let index = 1; index < 10000; index += 1) {
    const candidate = `${prefix} ${index}`;
    if (!used.has(candidate)) return candidate;
  }
  return `${prefix} ${Date.now()}`;
}

function replace(project: ProjectDocument, updates: Map<string, BimElement>): BimElement[] {
  return project.elements.map((element) => updates.get(element.id) ?? element);
}

/* --------------------------- 状态机 --------------------------- */

export function createModifySession(
  command: ModifyCommandId,
  project: ProjectDocument,
  selection: string[],
  overrides: Partial<ModifyOptions> = {},
): ModifySession {
  const ids = selection.filter((id) => project.elements.some((element) => element.id === id));
  const selected = project.elements.filter((element) => ids.includes(element.id));
  const options: ModifyOptions = {
    ...DEFAULT_MODIFY_OPTIONS,
    ...(command === 'copy' ? { multiple: true } : {}),
    ...(command === 'array-radial' ? { angle: 360 } : {}),
    ...overrides,
  };
  return {
    command, ids, points: [], hits: [], center: selectionCenter(selected),
    options, status: ids.length || command === 'measure' ? 'active' : 'await-selection',
    centerPending: false, numeric: null, note: '',
  };
}

export function withSelection(session: ModifySession, project: ProjectDocument, ids: string[]): ModifySession {
  const valid = ids.filter((id) => project.elements.some((element) => element.id === id));
  const selected = project.elements.filter((element) => valid.includes(element.id));
  return {
    ...session, ids: valid, points: [], hits: [], center: selectionCenter(selected),
    status: valid.length ? 'active' : 'await-selection', centerPending: false, numeric: null,
    note: valid.length ? '' : session.note,
  };
}

export function setCenter(session: ModifySession, point: Vec2): ModifySession {
  return { ...session, center: point, centerPending: false, note: `旋转中心 (${point[0].toFixed(2)}, ${point[1].toFixed(2)})` };
}

export function requiredClicks(command: ModifyCommandId): number {
  switch (command) {
    case 'mirror-pick': case 'split': return 1;
    case 'scale': return 3;
    case 'pin': case 'unpin': case 'delete': return 0;
    default: return 2;
  }
}

/** 数值输入可以替代最后一次取点（Revit：输入临时尺寸后回车）。 */
export function isReady(session: ModifySession, cursor: Vec2 | null): boolean {
  const count = session.points.length;
  const hasNumeric = session.numeric !== null && Number.isFinite(session.numeric);
  if (session.centerPending) return false;
  if (session.command === 'scale') {
    return count >= 3 || (count >= 2 && hasNumeric) || (count >= 1 && hasNumeric);
  }
  if (session.command === 'mirror-pick' || session.command === 'split') return count >= 1;
  if (session.command === 'pin' || session.command === 'unpin' || session.command === 'delete') return true;
  if (count >= 2) return true;
  if (count >= 1 && hasNumeric) {
    if (session.command === 'offset') return Boolean(cursor);
    return true;
  }
  return false;
}

export function advanceModify(session: ModifySession, click: ModifyClick): ModifySession {
  if (session.status !== 'active') return session;
  if (session.centerPending) return setCenter(session, click.point);
  return {
    ...session,
    points: [...session.points, click.point],
    hits: [...session.hits, click.hitId],
    numeric: null,
    note: '',
  };
}

/** Esc：先撤销上一个取点，没有取点了才退出命令（Revit 逐级退出）。 */
export function stepBack(session: ModifySession): ModifySession {
  if (session.centerPending) return { ...session, centerPending: false };
  if (!session.points.length) return { ...session, status: 'finished' };
  return {
    ...session,
    points: session.points.slice(0, -1),
    hits: session.hits.slice(0, -1),
    numeric: null,
    note: '',
  };
}

export function modifyPrompt(session: ModifySession): string {
  const { command, points, status, centerPending } = session;
  if (status === 'await-selection') return `请选择要${MODIFY_LABELS[command]}的构件（Shift 加选），Esc 取消命令`;
  if (centerPending) return '单击放置旋转中心（对象捕捉可用），Esc 返回';
  const base = points.length === 0;
  switch (command) {
    case 'move': case 'copy':
      return base ? '单击确定移动起点（端点 / 中点 / 交点可捕捉）'
        : '移动光标确定终点，或输入距离后回车；Shift 约束正交 · Esc 返回上一步';
    case 'rotate':
      return base ? '单击确定旋转起始方向（可先点选项栏「放置中心」）'
        : '单击确定终止方向，或输入角度后回车；Esc 返回上一步';
    case 'mirror-draw':
      return base ? '单击确定镜像轴起点' : '单击确定镜像轴终点；Esc 返回上一步';
    case 'mirror-pick': return '拾取墙 / 轴网 / 楼板边作为镜像轴；Esc 取消';
    case 'array-linear':
      return base ? '单击确定阵列基点'
        : `单击确定${session.options.moveToLast ? '最后一个' : '第二个'}构件位置；选项栏可改个数与间距`;
    case 'array-radial':
      return base ? '单击确定阵列起始方向'
        : '单击确定终止方向（或输入总角度回车）；选项栏可改个数';
    case 'align':
      return base ? '单击拾取参照点（要对齐到的位置）' : '在选中构件上单击要对齐的点；Esc 返回上一步';
    case 'offset':
      return base ? '单击拾取要偏移的构件' : '在偏移一侧单击（或输入距离后回车）；Esc 返回上一步';
    case 'scale':
      return base ? '单击确定缩放基点' : points.length === 1
        ? '单击确定参照长度终点' : '单击确定新长度终点，或输入比例后回车';
    case 'trim':
      return base ? '单击第一面墙上要保留的一侧' : '单击第二面墙上要保留的一侧；Esc 返回上一步';
    case 'split': return '单击墙上的拆分位置（Esc 取消）';
    case 'measure': return base ? '单击测量起点' : '单击测量终点；Esc 返回上一步';
    default: return 'Esc 取消命令';
  }
}

/* --------------------------- 预览计算 --------------------------- */

function numericDistance(session: ModifySession, cursor: Vec2 | null, base: Vec2): Vec2 {
  const value = session.numeric ?? 0;
  const dir = cursor ? direction(base, cursor) : ([1, 0] as Vec2);
  return scale2(dir, value);
}

function moveVector(session: ModifySession, cursor: Vec2 | null): Vec2 | null {
  const points = [...session.points, ...(cursor ? [cursor] : [])];
  if (points.length < 2) return null;
  const base = session.points[0]!;
  const raw = session.numeric !== null && session.points.length < 2
    ? numericDistance(session, cursor, base)
    : sub(points[1]!, base);
  return constrainVector(raw, session.options.constrain);
}

function rotationAngle(session: ModifySession, cursor: Vec2 | null): number | null {
  const points = [...session.points, ...(cursor ? [cursor] : [])];
  if (points.length < 2 && session.numeric === null) return null;
  if (session.numeric !== null && session.points.length < 2) return rad(constrainAngle(session.numeric, session.options.constrain));
  if (points.length < 2) return null;
  const center = session.center;
  const from = Math.atan2(points[0]![1] - center[1], points[0]![0] - center[0]);
  const to = Math.atan2(points[1]![1] - center[1], points[1]![0] - center[0]);
  return rad(constrainAngle(normalizeDeg(deg(to - from)), session.options.constrain));
}

function arraySpacing(session: ModifySession, cursor: Vec2 | null): Vec2 | null {
  const move = moveVector(session, cursor);
  if (!move) return null;
  const divisor = session.options.moveToLast ? Math.max(1, session.options.number - 1) : 1;
  return scale2(move, 1 / divisor);
}

export function modifyPreview(project: ProjectDocument, session: ModifySession, cursor: Vec2 | null): PreviewSpec {
  const empty: PreviewSpec = { ghosts: [], guides: [], markers: [], label: '', labelAt: null };
  if (session.status !== 'active') return empty;
  const points = [...session.points, ...(cursor ? [cursor] : [])];
  const first = points[0] ?? null;
  const second = points[1] ?? null;
  const labelAt = cursor ?? second ?? first;
  const guide = (from: Vec2, to: Vec2): PreviewGuide => ({ from, to });
  const guides: PreviewGuide[] = [];
  const markers: Vec2[] = [];

  switch (session.command) {
    case 'move': case 'copy': {
      if (!first) return empty;
      const move = moveVector(session, cursor);
      markers.push(first);
      if (!move) return { ...empty, markers, label: '单击确定起点', labelAt };
      const end = add(first, move);
      guides.push(guide(first, end));
      return {
        ghosts: [{ kind: 'translate', dx: move[0], dy: move[1] }],
        guides, markers,
        label: `距离 ${length(move).toFixed(2)} m　ΔX ${move[0].toFixed(2)}　ΔY ${move[1].toFixed(2)}`,
        labelAt: end,
      };
    }
    case 'rotate': {
      markers.push(session.center);
      const angle = rotationAngle(session, cursor);
      if (first) guides.push(guide(session.center, first));
      if (second) guides.push(guide(session.center, second));
      if (angle === null) return { ...empty, guides, markers, label: '单击确定起始方向', labelAt };
      return {
        ghosts: [{ kind: 'rotate', angle, center: session.center }],
        guides, markers,
        label: `角度 ${deg(angle).toFixed(1)}°`,
        labelAt: second ?? cursor,
      };
    }
    case 'mirror-draw': {
      if (!first) return empty;
      markers.push(first);
      if (!second) return { ...empty, markers, label: '单击确定轴线终点', labelAt };
      const dir = sub(second, first);
      if (length(dir) < 1e-9) return { ...empty, markers, labelAt };
      const normalized = direction([0, 0], dir);
      guides.push(guide(add(first, scale2(normalized, -20)), add(first, scale2(normalized, 20))));
      return {
        ghosts: [{ kind: 'mirror', linePoint: first, lineDir: dir }],
        guides, markers,
        label: `镜像轴 ${length(dir).toFixed(2)} m`,
        labelAt: second,
      };
    }
    case 'array-linear': {
      if (!first) return empty;
      const spacing = arraySpacing(session, cursor);
      markers.push(first);
      if (!spacing) return { ...empty, markers, labelAt };
      const count = Math.max(2, Math.min(200, Math.round(session.options.number)));
      const ghosts: ElementTransform[] = [];
      for (let index = 1; index < count; index += 1) {
        ghosts.push({ kind: 'translate', dx: spacing[0] * index, dy: spacing[1] * index });
      }
      guides.push(guide(first, add(first, scale2(spacing, count - 1))));
      return { ghosts, guides, markers, label: `间距 ${length(spacing).toFixed(2)} m · ${count} 个`, labelAt: cursor ?? second };
    }
    case 'array-radial': {
      markers.push(session.center);
      const angle = rotationAngle(session, cursor);
      if (first) guides.push(guide(session.center, first));
      if (second) guides.push(guide(session.center, second));
      const total = session.numeric !== null && session.points.length < 2 ? session.numeric : (angle === null ? null : deg(angle));
      if (total === null) return { ...empty, guides, markers, labelAt };
      const count = Math.max(2, Math.min(200, Math.round(session.options.number)));
      const step = Math.abs(Math.abs(total) - 360) < 0.01 ? total / count : total / (count - 1);
      const ghosts: ElementTransform[] = [];
      for (let index = 1; index < count; index += 1) {
        ghosts.push({ kind: 'rotate', angle: rad(step * index), center: session.center });
      }
      return { ghosts, guides, markers, label: `总角度 ${total.toFixed(1)}° · ${count} 个`, labelAt: cursor ?? second };
    }
    case 'align': {
      if (!first) return empty;
      markers.push(first);
      if (!second) return { ...empty, markers, label: '单击构件上要对齐的点', labelAt };
      const move = constrainVector(sub(first, nearestAnchor(project, session.ids, second)), session.options.constrain);
      guides.push(guide(second, add(second, move)));
      return {
        ghosts: [{ kind: 'translate', dx: move[0], dy: move[1] }], guides, markers,
        label: `对齐 ${length(move).toFixed(2)} m`, labelAt: second,
      };
    }
    case 'offset': {
      if (!first) return empty;
      markers.push(first);
      if (session.points.length < 1) return { ...empty, markers, labelAt };
      const targetId = session.hits[0];
      const target = project.elements.find((element) => element.id === targetId)
        ?? project.elements.find((element) => session.ids.includes(element.id));
      if (!target) return { ...empty, markers, labelAt };
      const { center, normal } = offsetDirection(target, second);
      const side = second ? (dot(sub(second, center), normal) >= 0 ? 1 : -1) : 1;
      const dist = session.numeric ?? session.options.distance;
      const move = scale2(normal, dist * side);
      guides.push(guide(center, add(center, move)));
      return {
        ghosts: [{ kind: 'translate', dx: move[0], dy: move[1] }], guides, markers,
        label: `偏移 ${Math.abs(dist).toFixed(2)} m`, labelAt: second ?? first,
      };
    }
    case 'scale': {
      if (!first) return empty;
      markers.push(first);
      if (!second) return { ...empty, markers, labelAt };
      const ratio = session.numeric ?? (points[2] ? distance(first, points[2]) / Math.max(1e-6, distance(first, second)) : null);
      if (ratio === null) return { ...empty, markers, guides: [guide(first, second)], labelAt };
      guides.push(guide(first, second));
      if (points[2]) guides.push(guide(first, points[2]));
      return {
        ghosts: [{ kind: 'scale', factor: ratio, center: first }], guides, markers,
        label: `比例 ${ratio.toFixed(2)} ×`, labelAt: points[2] ?? second,
      };
    }
    case 'trim': case 'measure': case 'mirror-pick': case 'split': {
      if (!first) return empty;
      markers.push(first);
      if (second) guides.push(guide(first, second));
      const label = second ? `距离 ${distance(first, second).toFixed(2)} m` : '单击继续';
      return { ...empty, guides, markers, label, labelAt };
    }
    default: return empty;
  }
}

/* --------------------------- 提交 --------------------------- */

function movable(project: ProjectDocument, ids: string[]): { elements: BimElement[]; pinned: number } {
  const elements = project.elements.filter((element) => ids.includes(element.id));
  const usable = elements.filter((element) => !isElementLocked(project, element));
  return { elements: usable, pinned: elements.length - usable.length };
}

function outcomeError(project: ProjectDocument, session: ModifySession, message: string): ModifyOutcome {
  return { elements: project.elements, selection: session.ids, label: '', error: message };
}

function copiesWithTransform(project: ProjectDocument, elements: BimElement[], transform: ElementTransform | null): BimElement[] {
  const copies = duplicateElements(project, elements, { dx: 0, dy: 0 });
  return transform ? copies.map((copy) => applyTransform(copy, transform)) : copies;
}

export function finishModify(project: ProjectDocument, session: ModifySession, cursor: Vec2 | null = null): ModifyOutcome {
  const { ids, points, options, command } = session;
  const { elements: targets, pinned } = movable(project, ids);
  const note = pinned ? `已跳过 ${pinned} 个锁定构件（先解锁）` : undefined;
  if (!targets.length && command !== 'measure') return outcomeError(project, session, '没有可编辑的构件（可能全部已锁定）');
  if (!isReady(session, cursor)) return outcomeError(project, session, '请继续在视口中取点');

  const first = points[0] ?? cursor ?? ([0, 0] as Vec2);
  const second = points[1] ?? cursor ?? first;
  const baseIds = ids;

  switch (command) {
    case 'move': {
      const move = moveVector(session, cursor);
      if (!move || length(move) < 1e-9) return outcomeError(project, session, '移动距离不能为 0');
      const transform: ElementTransform = { kind: 'translate', dx: move[0], dy: move[1] };
      const updates = new Map(targets.map((element) => [element.id, applyTransform(element, transform)]));
      const added = options.copy ? copiesWithTransform(project, targets, transform) : [];
      return {
        elements: [...replace(project, updates), ...added], selection: baseIds,
        label: `${options.copy ? '移动复制' : '已移动'} ${targets.length} 个构件（${length(move).toFixed(2)} m）`, note,
      };
    }
    case 'copy': {
      const move = moveVector(session, cursor);
      if (!move || length(move) < 1e-9) return outcomeError(project, session, '复制距离不能为 0');
      const transform: ElementTransform = { kind: 'translate', dx: move[0], dy: move[1] };
      const added = copiesWithTransform(project, targets, transform);
      const keepSession: ModifySession | undefined = options.multiple
        ? { ...session, points: [first], hits: [session.hits[0] ?? null], numeric: null, note: '已放置一个副本，继续单击放置（Esc 结束）' }
        : undefined;
      return {
        elements: [...project.elements, ...added], selection: added.map((element) => element.id),
        label: `已复制 ${added.length} 个构件（${length(move).toFixed(2)} m）`, note, keepSession,
      };
    }
    case 'rotate': {
      const angle = rotationAngle(session, cursor);
      if (angle === null || Math.abs(angle) < 1e-9) return outcomeError(project, session, '旋转角度不能为 0');
      const transform: ElementTransform = { kind: 'rotate', angle, center: session.center };
      if (options.copy) {
        const added = copiesWithTransform(project, targets, transform);
        return { elements: [...project.elements, ...added], selection: added.map((e) => e.id), label: `已旋转复制 ${added.length} 个构件（${deg(angle).toFixed(1)}°）`, note };
      }
      const updates = new Map(targets.map((element) => [element.id, applyTransform(element, transform)]));
      return { elements: replace(project, updates), selection: baseIds, label: `已旋转 ${targets.length} 个构件（${deg(angle).toFixed(1)}°）`, note };
    }
    case 'mirror-draw': case 'mirror-pick': {
      let line: { linePoint: Vec2; lineDir: Vec2 } | null;
      if (command === 'mirror-draw') {
        if (distance(first, second) < 1e-6) return outcomeError(project, session, '镜像轴长度不能为 0');
        line = { linePoint: first, lineDir: sub(second, first) };
      } else {
        line = axisFromPick(project, session.hits[0] ?? null, first);
        if (!line) return outcomeError(project, session, '请拾取墙 / 轴网 / 楼板边作为镜像轴');
      }
      const transform: ElementTransform = { kind: 'mirror', ...line };
      if (options.copy) {
        const added = copiesWithTransform(project, targets, transform);
        return { elements: [...project.elements, ...added], selection: added.map((e) => e.id), label: `已镜像复制 ${added.length} 个构件`, note };
      }
      const updates = new Map(targets.map((element) => [element.id, applyTransform(element, transform)]));
      return { elements: replace(project, updates), selection: baseIds, label: `已镜像 ${targets.length} 个构件`, note };
    }
    case 'array-linear': {
      const spacing = arraySpacing(session, cursor);
      if (!spacing || length(spacing) < 1e-9) return outcomeError(project, session, '阵列间距不能为 0');
      const count = Math.max(2, Math.min(200, Math.round(options.number)));
      const added = arrayElements(project, targets, { mode: 'linear', count, dx: spacing[0], dy: spacing[1] });
      return {
        elements: [...project.elements, ...added], selection: [...baseIds, ...added.map((e) => e.id)],
        label: `线性阵列：${count} 个（间距 ${length(spacing).toFixed(2)} m）`, note,
      };
    }
    case 'array-radial': {
      const angle = rotationAngle(session, cursor);
      const total = session.numeric ?? (angle === null ? null : deg(angle));
      if (total === null || Math.abs(total) < 1e-9) return outcomeError(project, session, '请指定阵列总角度');
      const count = Math.max(2, Math.min(200, Math.round(options.number)));
      const added = arrayElements(project, targets, { mode: 'polar', count, totalAngleDeg: total, center: session.center });
      return {
        elements: [...project.elements, ...added], selection: [...baseIds, ...added.map((e) => e.id)],
        label: `环形阵列：${count} 个（${total.toFixed(1)}°）`, note,
      };
    }
    case 'align': {
      const anchor = nearestAnchor(project, ids, second);
      const move = constrainVector(sub(first, anchor), options.constrain);
      if (length(move) < 1e-9) return outcomeError(project, session, '两点已对齐');
      const transform: ElementTransform = { kind: 'translate', dx: move[0], dy: move[1] };
      const updates = new Map(targets.map((element) => [element.id, applyTransform(element, transform)]));
      return { elements: replace(project, updates), selection: baseIds, label: `已对齐 ${targets.length} 个构件（${length(move).toFixed(2)} m）`, note };
    }
    case 'offset': {
      const picked = project.elements.find((element) => element.id === session.hits[0]);
      const affected = picked && !isElementLocked(project, picked) ? [picked] : targets;
      const side = points.length >= 2 ? second : cursor;
      const dist = session.numeric ?? options.distance;
      if (!Number.isFinite(dist) || Math.abs(dist) < 1e-9) return outcomeError(project, session, '偏移距离不能为 0');
      const updates = new Map<string, BimElement>();
      const additions: BimElement[] = [];
      for (const element of affected) {
        const { center, normal } = offsetDirection(element, side);
        const sign = side ? (dot(sub(side, center), normal) >= 0 ? 1 : -1) : 1;
        const move = scale2(normal, dist * sign);
        const transform: ElementTransform = { kind: 'translate', dx: move[0], dy: move[1] };
        if (options.copy) additions.push(...copiesWithTransform(project, [element], transform));
        else updates.set(element.id, applyTransform(element, transform));
      }
      const keepSession: ModifySession | undefined = options.multiple
        ? { ...session, points: [], hits: [], numeric: null, note: '继续拾取构件偏移（Esc 结束）' }
        : undefined;
      return {
        elements: [...replace(project, updates), ...additions],
        selection: additions.length ? additions.map((e) => e.id) : baseIds,
        label: `已偏移 ${affected.length} 个构件（${Math.abs(dist).toFixed(2)} m）`, note, keepSession,
      };
    }
    case 'scale': {
      if (targets.some((element) => element.category !== 'mesh')) {
        return outcomeError(project, session, '缩放仅支持导入几何 / 参数化体量（Revit 同样不允许缩放墙柱板）');
      }
      const ratio = session.numeric ?? (points[2] ? distance(first, points[2]) / Math.max(1e-6, distance(first, second)) : null);
      if (ratio === null || ratio <= 0 || !Number.isFinite(ratio)) return outcomeError(project, session, '缩放比例无效');
      const transform: ElementTransform = { kind: 'scale', factor: ratio, center: first };
      if (options.copy) {
        const added = copiesWithTransform(project, targets, transform);
        return { elements: [...project.elements, ...added], selection: added.map((e) => e.id), label: `已缩放复制（${ratio.toFixed(2)} ×）`, note };
      }
      const updates = new Map(targets.map((element) => [element.id, applyTransform(element, transform)]));
      return { elements: replace(project, updates), selection: baseIds, label: `已缩放 ${targets.length} 个构件（${ratio.toFixed(2)} ×）`, note };
    }
    case 'trim': {
      const wallA = wallById(project, session.hits[0] ?? null) ?? project.elements.find((e): e is WallInstance => ids.includes(e.id) && e.category === 'wall');
      const wallB = wallById(project, session.hits[1] ?? null) ?? project.elements.find((e): e is WallInstance => ids.includes(e.id) && e.category === 'wall' && e.id !== wallA?.id);
      if (!wallA || !wallB || wallA.id === wallB.id) return outcomeError(project, session, '修剪 / 延伸需要拾取两面不同的墙');
      const intersection = infiniteLineIntersection(wallA.start, wallA.end, wallB.start, wallB.end);
      if (!intersection) return outcomeError(project, session, '两墙平行，无法修剪到角点');
      const trimOne = (wall: WallInstance, click: Vec2): WallInstance => {
        const startDistance = distance(wall.start, click);
        const endDistance = distance(wall.end, click);
        return startDistance <= endDistance
          ? { ...wall, end: intersection }
          : { ...wall, start: intersection };
      };
      const updatedA = trimOne(wallA, first);
      const updatedB = trimOne(wallB, second);
      const updates = new Map<string, BimElement>([[wallA.id, updatedA], [wallB.id, updatedB]]);
      return { elements: replace(project, updates), selection: [wallA.id, wallB.id], label: '已修剪 / 延伸到角点', note };
    }
    case 'split': {
      const wall = wallById(project, session.hits[0] ?? null)
        ?? project.elements.find((element): element is WallInstance => element.category === 'wall'
          && distance(closestPointOnSegment(first, element.start, element.end), first) < 0.6);
      if (!wall) return outcomeError(project, session, '请单击墙上的拆分位置（目前仅支持墙）');
      const segment = sub(wall.end, wall.start);
      const wallLength = length(segment);
      if (wallLength < 0.2) return outcomeError(project, session, '墙太短，无法拆分');
      const dir = scale2(segment, 1 / wallLength);
      const cut = closestPointOnSegment(first, wall.start, wall.end);
      const t = dot(sub(cut, wall.start), dir);
      const gap = Math.max(0, Math.min(options.splitGap, wallLength * 0.4));
      if (t < gap / 2 + 0.05 || t > wallLength - gap / 2 - 0.05) return outcomeError(project, session, '拆分点太靠近墙端点');
      const aEnd: Vec2 = add(cut, scale2(dir, -gap / 2));
      const bStart: Vec2 = add(cut, scale2(dir, gap / 2));
      const firstWall: WallInstance = { ...wall, end: aEnd.map(round) as Vec2, id: createId(), name: nextName(project, 'wall') };
      const secondWall: WallInstance = { ...wall, start: bStart.map(round) as Vec2 };
      return {
        elements: [...project.elements.filter((element) => element.id !== wall.id), firstWall, secondWall],
        selection: [firstWall.id, secondWall.id],
        label: `已拆分为 2 面墙${gap ? `（间隙 ${gap.toFixed(2)} m）` : ''}`, note,
      };
    }
    case 'measure': {
      return {
        elements: project.elements, selection: baseIds, label:
          `测量：距离 ${distance(first, second).toFixed(3)} m　ΔX ${(second[0] - first[0]).toFixed(3)}　ΔY ${(second[1] - first[1]).toFixed(3)}　方位 ${normalizeDeg(deg(Math.atan2(second[1] - first[1], second[0] - first[0]))).toFixed(1)}°`,
      };
    }
    case 'pin': case 'unpin': case 'delete': {
      const result = immediateModify(project, command, ids);
      return { ...result, selection: command === 'delete' ? [] : baseIds };
    }
  }
}

/** 无需取点的即时命令（锁定 / 解锁 / 删除），锁定构件受保护。 */
export function immediateModify(project: ProjectDocument, command: 'pin' | 'unpin' | 'delete', ids: string[]): ModifyOutcome {
  const selected = project.elements.filter((element) => ids.includes(element.id));
  if (!selected.length) return outcomeError(project, createModifySession(command, project, ids), '请先选择构件');
  if (command === 'pin') {
    const updates = new Map(selected.map((element) => [element.id, { ...element, pinned: true } as BimElement]));
    return { elements: replace(project, updates), selection: ids, label: `已锁定 ${selected.length} 个构件` };
  }
  if (command === 'unpin') {
    const updates = new Map(selected.map((element) => [element.id, { ...element, pinned: false } as BimElement]));
    return { elements: replace(project, updates), selection: ids, label: `已解锁 ${selected.length} 个构件` };
  }
  const removable = selected.filter((element) => !isElementLocked(project, element));
  const pinned = selected.length - removable.length;
  if (!removable.length) return outcomeError(project, createModifySession(command, project, ids), '选中的构件已锁定，请解锁构件或所在图层');
  const removed = new Set(removable.map((element) => element.id));
  return {
    elements: project.elements.filter((element) => !removed.has(element.id)),
    selection: [], label: `已删除 ${removable.length} 个构件`,
    note: pinned ? `已跳过 ${pinned} 个锁定构件` : undefined,
  };
}

/** 供明细表 / 属性面板用的构件体积估算（米³）。 */
export function approximateVolume(project: ProjectDocument, element: BimElement): number {
  if (element.category === 'wall') {
    const type = project.types.find((item) => item.id === element.typeId);
    const thickness = type && 'thickness' in type ? type.thickness : 0.2;
    const height = Math.max(0, (project.levels.find((level) => level.id === element.topLevelId)?.elevation ?? 0)
      + element.topOffset - (project.levels.find((level) => level.id === element.levelId)?.elevation ?? 0) - element.baseOffset);
    return Math.hypot(element.end[0] - element.start[0], element.end[1] - element.start[1]) * thickness * height;
  }
  if (element.category === 'column') {
    const type = project.types.find((item) => item.id === element.typeId);
    const width = type && 'width' in type ? type.width : 0.4;
    const depth = type && 'depth' in type ? type.depth : 0.4;
    const height = Math.max(0, (project.levels.find((level) => level.id === element.topLevelId)?.elevation ?? 0)
      + element.topOffset - (project.levels.find((level) => level.id === element.levelId)?.elevation ?? 0) - element.baseOffset);
    return width * depth * height;
  }
  if (element.category === 'slab') {
    const type = project.types.find((item) => item.id === element.typeId);
    return polygonArea(element.points) * (type && 'thickness' in type ? type.thickness : 0.15);
  }
  return 0;
}

/** 供预览矩阵计算：把变换转成 three 用的 4×4（列主序数组由视口自己构造）。 */
export function transformParams(transform: ElementTransform): { translation: Vec2; rotation: number; mirrorAngle: number | null; scale: number; origin: Vec2 } {
  switch (transform.kind) {
    case 'translate': return { translation: [transform.dx, transform.dy], rotation: 0, mirrorAngle: null, scale: 1, origin: [0, 0] };
    case 'rotate': return { translation: [0, 0], rotation: transform.angle, mirrorAngle: null, scale: 1, origin: transform.center };
    case 'mirror': return { translation: [0, 0], rotation: 0, mirrorAngle: lineAngle(transform.lineDir), scale: 1, origin: transform.linePoint };
    case 'scale': return { translation: [0, 0], rotation: 0, mirrorAngle: null, scale: transform.factor, origin: transform.center };
  }
}
