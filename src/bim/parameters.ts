/**
 * 参数关联更新内核（Revit「项目参数 / 类型参数公式 / 关联约束」的 Web 实现）。
 *
 * 设计要点：
 * - 公式是纯文本表达式，**不使用 eval / new Function**，自带词法分析与递归下降求值；
 * - 所有参数值统一以「米 / 弧度 / 无量纲」存储，单位只影响显示与字面量换算（200mm → 0.2）；
 * - recomputeParameters 是唯一的联动入口：文档发生任何变更后调用一次，
 *   按「全局参数（拓扑序）→ 类型参数 → 实例参数」重算，几何/明细表/IFC 全部读同一份文档，
 *   因此会自动跟着刷新；
 * - 依赖出现环时报告问题并保留原值，不产生半更新状态；
 * - 无变化时返回原对象引用，避免污染撤销栈与协作差分。
 */
import { createId } from './id';
import { paramTemplate, withParam } from './parametric';
import { isConstraintElement, resolveElementConstraints } from './constraints';
import { evaluateFormula, formulaReferences } from '../../shared/formula.js';
import { planConstraints } from '../../shared/constraints.js';
import { readDimension, writeDimension } from '../../shared/dimensions.js';
import type { EvalResult } from '../../shared/formula.js';
import type {
  BimElement,
  FamilyType,
  FormulaMap,
  ParameterUnit,
  PrimitiveSpec,
  ProjectDocument,
  ProjectParameter,
} from './types';

/* ------------------------------ 基础定义 ------------------------------ */

export const PARAMETER_UNIT_LABELS: Record<ParameterUnit, string> = {
  length: 'm',
  area: 'm²',
  volume: 'm³',
  angle: 'rad',
  number: '—',
  count: '个',
};

export interface ParameterKeySpec {
  key: string;
  label: string;
  unit: ParameterUnit;
  min: number;
  max: number;
  integer?: boolean;
}

const LENGTH = (key: string, label: string, min = 0.01, max = 100): ParameterKeySpec =>
  ({ key, label, unit: 'length', min, max });

/** 类型可绑定的参数（与 TypeParameters 面板一一对应）。 */
export const TYPE_PARAMETER_SPECS: Record<FamilyType['category'], ParameterKeySpec[]> = {
  wall: [LENGTH('thickness', '厚度', 0.02, 2)],
  column: [LENGTH('width', '截面宽', 0.1, 3), LENGTH('depth', '截面深', 0.1, 3)],
  slab: [LENGTH('thickness', '厚度', 0.02, 1)],
};

/** 内置变量（上下文相关，随构件/标高变化而自动更新）。 */
export const CONTEXT_VARIABLES: Array<{ name: string; label: string; scope: 'type' | 'element' }> = [
  { name: '层高', label: '层高 / StoryHeight（m）', scope: 'type' },
  { name: '标高', label: '构件所在标高高程（m）', scope: 'element' },
  { name: '顶部标高', label: '顶部标高世界高程（m）', scope: 'element' },
  { name: '层高', label: '构件净高（顶部 − 底部，m）', scope: 'element' },
  { name: '长度', label: '墙长 / Length（m）', scope: 'element' },
  { name: '面积', label: '楼板面积 / Area（m²）', scope: 'element' },
  { name: '厚度', label: '类型厚度（m）', scope: 'element' },
  { name: '截面宽', label: '柱截面宽（m）', scope: 'element' },
  { name: '截面深', label: '柱截面深（m）', scope: 'element' },
  { name: '底部偏移', label: '实例底部偏移（m）', scope: 'element' },
  { name: '序号', label: '构件在文档中的序号（从 1 起）', scope: 'element' },
];

/**
 * 公式求值内核已下沉到 shared/formula.js（服务端校验 AI 写的约束要用同一份实现）。
 * 这里只做转发，保持既有引用路径不变。
 */
export { FORMULA_FUNCTIONS, evaluateFormula, formulaReferences } from '../../shared/formula.js';
export type { EvalResult } from '../../shared/formula.js';

/** 新建项目的默认全局参数：链式依赖可直观演示「改一处、动全身」。 */
export function defaultParameters(): ProjectParameter[] {
  return [
    { id: 'param-story', name: '标准层高', value: 3, unit: 'length', description: '标高 1 → 标高 2 的高度', group: '建筑' },
    { id: 'param-base', name: '基准厚度', value: 0.2, unit: 'length', description: '所有构件厚度的 driving 参数', group: '建筑' },
    { id: 'param-factor', name: '墙厚系数', value: 1, unit: 'number', description: '标准墙厚 = 基准厚度 × 系数', group: '建筑' },
    { id: 'param-wall', name: '标准墙厚', value: 0.2, unit: 'length', formula: '基准厚度 * 墙厚系数', description: '由基准厚度派生', group: '墙体' },
    { id: 'param-inner-wall', name: '内墙厚', value: 0.1, unit: 'length', formula: '标准墙厚 / 2', description: '由标准墙厚派生', group: '墙体' },
    { id: 'param-slab', name: '标准板厚', value: 0.15, unit: 'length', formula: '标准墙厚 * 0.75', description: '由标准墙厚派生', group: '楼板' },
    { id: 'param-column', name: '标准柱截面', value: 0.4, unit: 'length', formula: '标准墙厚 * 2', description: '由标准墙厚派生', group: '柱' },
  ];
}

/** 新建项目时给基础类型挂上默认关联（计算值与原默认值完全一致，不影响既有文档）。 */
export function defaultTypeFormulas(): Record<string, FormulaMap> {
  return {
    'type-wall-200': { thickness: '标准墙厚' },
    'type-wall-100': { thickness: '内墙厚' },
    'type-column-400': { width: '标准柱截面', depth: '标准柱截面' },
    'type-slab-150': { thickness: '标准板厚' },
  };
}

/** 旧文档补齐参数表，但不自动绑定公式，防止历史项目的尺寸被意外改写。 */
export function ensureDocumentParameters(project: ProjectDocument): ProjectDocument {
  if (Array.isArray(project.parameters)) return project;
  const strip = <T extends { formulas?: FormulaMap }>(holder: T): T => {
    const copy = { ...holder };
    delete copy.formulas;
    return copy;
  };
  return {
    ...project,
    parameters: defaultParameters().map((parameter) => ({ ...parameter, formula: undefined })),
    types: project.types.map(strip),
    elements: project.elements.map(strip),
  };
}


/* ------------------------------ 参数读写 ------------------------------ */

function clampValue(spec: ParameterKeySpec | undefined, value: number): number {
  if (!Number.isFinite(value)) return 0;
  const min = spec?.min ?? -1e6;
  const max = spec?.max ?? 1e6;
  const clamped = Math.min(Math.max(value, min), max);
  return spec?.integer ? Math.round(clamped) : clamped;
}

export function typeParameterSpec(type: FamilyType, key: string): ParameterKeySpec | undefined {
  return TYPE_PARAMETER_SPECS[type.category].find((spec) => spec.key === key);
}

export function readTypeParameter(type: FamilyType, key: string): number | null {
  if (!typeParameterSpec(type, key)) return null;
  const value = (type as unknown as Record<string, unknown>)[key];
  return typeof value === 'number' ? value : null;
}

function writeTypeParameter(type: FamilyType, key: string, value: number): FamilyType {
  return { ...type, [key]: value } as FamilyType;
}

/** 实例可绑定参数：几何定位、约束偏移、参数化体量尺寸。 */
export function elementParameterSpecs(element: BimElement): ParameterKeySpec[] {
  const specs: ParameterKeySpec[] = [];
  if (element.category !== 'mesh') {
    specs.push(LENGTH('baseOffset', '底部偏移', -100, 100));
  }
  if (element.category === 'wall' || element.category === 'column') {
    specs.push(LENGTH('topOffset', '顶部偏移', -100, 100));
  }
  if (element.category === 'wall') {
    specs.push(LENGTH('start.x', '起点 X', -1e5, 1e5), LENGTH('start.y', '起点 Y', -1e5, 1e5));
    specs.push(LENGTH('end.x', '终点 X', -1e5, 1e5), LENGTH('end.y', '终点 Y', -1e5, 1e5));
  }
  if (element.category === 'column') {
    specs.push(LENGTH('position.x', '定位 X', -1e5, 1e5), LENGTH('position.y', '定位 Y', -1e5, 1e5));
    specs.push({ key: 'rotation', label: '转角', unit: 'angle', min: -Math.PI * 4, max: Math.PI * 4 });
  }
  if (element.category === 'mesh') {
    specs.push(LENGTH('offset.x', '平移 X', -1e5, 1e5), LENGTH('offset.y', '平移 Y', -1e5, 1e5), LENGTH('offset.z', '平移 Z', -1e5, 1e5));
    if (element.parametric) {
      // 参数化构件的模型参数直接进参数表：可以绑公式（如「柱高 = 层高 − 0.3」），
      // 也可以在参数对话框里改数值 —— 两者都靠 writeElementParameter 回到 parametric.params。
      for (const spec of paramTemplate(element.parametric.template)?.params ?? []) {
        specs.push({
          key: `param.${spec.key}`,
          label: spec.label,
          unit: spec.unit,
          min: spec.min,
          max: spec.max,
          ...(spec.integer ? { integer: true } : {}),
        });
      }
    } else if (element.primitive) {
      for (const field of primitiveSpecs(element.primitive)) specs.push(field);
    }
    // 约束里出现过的尺寸（别名 / 公式目标）也进参数表：
    // 一个特征树有几十个可驱动尺寸，全列出来没法看；被约束过的才是「有意义的尺寸」。
    for (const field of constrainedSpecs(element)) {
      if (!specs.some((item) => item.key === field.key)) specs.push(field);
    }
  }
  return specs;
}

/** 别名与公式目标涉及的尺寸（键 = 尺寸路径），供参数表显示与联动 */
function constrainedSpecs(element: BimElement): ParameterKeySpec[] {
  if (element.category !== 'mesh') return [];
  const plan = planConstraints(element);
  const out: ParameterKeySpec[] = [];
  const add = (path: string, name?: string) => {
    if (!path || path.startsWith('param.') || path.startsWith('primitive.')) return;
    const spec = plan.specByPath.get(path);
    if (!spec) return;
    out.push({
      key: path,
      label: name ? `${name}（${spec.label}）` : spec.label,
      unit: spec.unit,
      min: spec.min,
      max: spec.max,
      ...(spec.integer ? { integer: true } : {}),
    });
  };
  for (const alias of element.constraints?.dimensions ?? []) add(alias.path, alias.name);
  for (const binding of plan.bindings) add(binding.path);
  return out;
}

function primitiveSpecs(spec: PrimitiveSpec): ParameterKeySpec[] {
  const length = (key: string, label: string, min = 0.01): ParameterKeySpec =>
    LENGTH(`primitive.${key}`, label, min, 100);
  const count = (key: string, label: string, min: number, max: number): ParameterKeySpec =>
    ({ key: `primitive.${key}`, label, unit: 'count', min, max, integer: true });
  switch (spec.kind) {
    case 'box': return [length('width', '体量宽'), length('depth', '体量深'), length('height', '体量高')];
    case 'cylinder': return [length('radius', '体量半径'), length('height', '体量高'), count('segments', '分段数', 3, 128)];
    case 'sphere': return [length('radius', '体量半径'), count('segments', '分段数', 6, 128)];
    case 'extrude': return [length('height', '拉伸高度')];
    case 'decal': return [length('width', '贴花宽'), length('height', '贴花高')];
    case 'revolve': return [count('segments', '旋转分段', 6, 128)];
    case 'pyramid': return [length('radius', '底面半径'), length('height', '体量高'), count('sides', '边数', 3, 64)];
    // 特征实体的尺寸在「任意造型」对话框里按特征编辑，不进参数表
    case 'solid': return [];
  }
}

export function elementParameterSpec(element: BimElement, key: string): ParameterKeySpec | undefined {
  return elementParameterSpecs(element).find((spec) => spec.key === key);
}

export function readElementParameter(element: BimElement, key: string): number | null {
  const [head, tail] = key.split('.');
  if (head === 'param') {
    const params = element.category === 'mesh' ? element.parametric?.params : undefined;
    const value = params && tail ? params[tail] : undefined;
    return typeof value === 'number' ? value : null;
  }
  if (head === 'primitive') {
    const primitive = element.category === 'mesh' ? element.primitive : undefined;
    const value = primitive && tail ? (primitive as unknown as Record<string, unknown>)[tail] : undefined;
    return typeof value === 'number' ? value : null;
  }
  // 特征尺寸（f3.height / f2.translate.1 …）：走共享的尺寸寻址层，和约束引擎读同一份数据
  if (element.category === 'mesh' && /^f\d+$/.test(head)) {
    return readDimension(element, key);
  }
  if (head === 'offset' && element.category === 'mesh') {
    const offset = element.offset;
    if (!offset) return 0;
    if (tail === 'x') return offset[0];
    if (tail === 'y') return offset[1];
    if (tail === 'z') return offset[2];
    return null;
  }
  if ((head === 'start' || head === 'end' || head === 'position') && tail) {
    const vec = (element as unknown as Record<string, unknown>)[head];
    if (Array.isArray(vec)) {
      const index = tail === 'x' ? 0 : tail === 'y' ? 1 : -1;
      const value = index >= 0 ? vec[index] : undefined;
      return typeof value === 'number' ? value : null;
    }
    return null;
  }
  const value = (element as unknown as Record<string, unknown>)[key];
  return typeof value === 'number' ? value : null;
}

export function writeElementParameter(element: BimElement, key: string, value: number): BimElement {
  const [head, tail] = key.split('.');
  if (head === 'param' && element.category === 'mesh' && element.parametric && tail) {
    // 公式算出来的高度写回参数模型，同时刷新特征树快照（几何会在求值时重建）
    return withParam(element, tail, value);
  }
  if (head === 'primitive' && element.category === 'mesh' && element.primitive && tail) {
    return { ...element, primitive: { ...element.primitive, [tail]: value } } as BimElement;
  }
  if (head === 'f' || /^f\d+$/.test(head)) {
    if (element.category !== 'mesh') return element;
    return writeDimension(element, key, value) as BimElement;
  }
  if (head === 'offset' && element.category === 'mesh') {
    const offset: [number, number, number] = [
      element.offset?.[0] ?? 0, element.offset?.[1] ?? 0, element.offset?.[2] ?? 0,
    ];
    if (tail === 'x') offset[0] = value;
    else if (tail === 'y') offset[1] = value;
    else if (tail === 'z') offset[2] = value;
    return { ...element, offset };
  }
  if ((head === 'start' || head === 'end' || head === 'position') && tail) {
    const vec = (element as unknown as Record<string, unknown>)[head];
    if (Array.isArray(vec)) {
      const next: [number, number] = [Number(vec[0]) || 0, Number(vec[1]) || 0];
      if (tail === 'x') next[0] = value;
      else if (tail === 'y') next[1] = value;
      return { ...element, [head]: next } as BimElement;
    }
  }
  return { ...element, [key]: value } as BimElement;
}

/* ------------------------------ 文档编辑辅助 ------------------------------ */

export function upsertParameter(project: ProjectDocument, parameter: ProjectParameter): ProjectDocument {
  const list = project.parameters ?? [];
  const index = list.findIndex((item) => item.id === parameter.id);
  const next = index >= 0 ? list.map((item) => (item.id === parameter.id ? parameter : item)) : [...list, parameter];
  return { ...project, parameters: next };
}

export function removeParameter(project: ProjectDocument, id: string): ProjectDocument {
  return { ...project, parameters: (project.parameters ?? []).filter((item) => item.id !== id) };
}

function patchFormula<T extends { formulas?: FormulaMap }>(holder: T, key: string, formula: string | null): T {
  const formulas = { ...(holder.formulas ?? {}) };
  if (formula && formula.trim()) formulas[key] = formula.trim();
  else delete formulas[key];
  if (Object.keys(formulas).length) return { ...holder, formulas };
  const copy = { ...holder };
  delete copy.formulas;
  return copy;
}

export function setTypeFormula(project: ProjectDocument, typeId: string, key: string, formula: string | null): ProjectDocument {
  return {
    ...project,
    types: project.types.map((type) => (type.id === typeId ? patchFormula(type, key, formula) : type)),
  };
}

export function setElementFormula(project: ProjectDocument, elementId: string, key: string, formula: string | null): ProjectDocument {
  return {
    ...project,
    elements: project.elements.map((element) => (element.id === elementId ? patchFormula(element, key, formula) : element)),
  };
}

/** 重命名全局参数时同步改写所有公式里的引用，避免关联断开。 */
export function renameParameterReferences(project: ProjectDocument, oldName: string, newName: string): ProjectDocument {
  if (!oldName || oldName === newName) return project;
  const rewrite = (formula: string) => (formula.includes(oldName) ? formula.split(oldName).join(newName) : formula);
  const rewriteMap = (formulas?: FormulaMap): FormulaMap | undefined => {
    if (!formulas) return undefined;
    return Object.fromEntries(Object.entries(formulas).map(([key, formula]) => [key, rewrite(formula)]));
  };
  return {
    ...project,
    parameters: (project.parameters ?? []).map((item) => ({
      ...item,
      name: item.name === oldName ? newName : item.name,
      formula: item.formula ? rewrite(item.formula) : undefined,
    })),
    types: project.types.map((type) => {
      const formulas = rewriteMap(type.formulas);
      return formulas ? { ...type, formulas } : type;
    }),
    elements: project.elements.map((element) => {
      const formulas = rewriteMap(element.formulas);
      return formulas ? { ...element, formulas } : element;
    }),
  };
}

export function createParameter(project: ProjectDocument, name?: string): ProjectParameter {
  const used = new Set((project.parameters ?? []).map((item) => item.name));
  let index = 1;
  while (used.has(`参数 ${index}`)) index += 1;
  return { id: createId(), name: name || `参数 ${index}`, value: 1, unit: 'number', group: '自定义' };
}

/* ------------------------------ 联动重算 ------------------------------ */

export interface ParameterUpdate {
  scope: 'parameter' | 'type' | 'element';
  id: string;
  name: string;
  key: string;
  from: number;
  to: number;
}

export interface ParameterIssue {
  scope: 'parameter' | 'type' | 'element';
  id: string;
  name: string;
  key: string;
  message: string;
}

export interface RecomputeReport {
  updates: ParameterUpdate[];
  issues: ParameterIssue[];
  /** 因公式重算而几何/派生量发生变化的构件数量 */
  affectedElements: number;
}

const emptyReport = (): RecomputeReport => ({ updates: [], issues: [], affectedElements: 0 });

function variableMap(parameters: ProjectParameter[]): Record<string, number> {
  const map: Record<string, number> = { PI: Math.PI, pi: Math.PI, E: Math.E, e: Math.E };
  for (const parameter of parameters) {
    map[parameter.name] = parameter.value;
    map[parameter.id] = parameter.value;
    map[`$${parameter.name}`] = parameter.value;
  }
  return map;
}

/** 项目层高：取前两个标高的高差；只有一个标高时用 3 m。 */
function projectStoryHeight(project: ProjectDocument): number {
  const first = project.levels[0]?.elevation ?? 0;
  const second = project.levels[1]?.elevation;
  return second === undefined ? 3 : Math.abs(second - first);
}

function polygonAreaLocal(points: Array<[number, number]>): number {
  let sum = 0;
  for (let index = 0; index < points.length; index += 1) {
    const [x1, y1] = points[index]!;
    const [x2, y2] = points[(index + 1) % points.length]!;
    sum += x1 * y2 - x2 * y1;
  }
  return Math.abs(sum) / 2;
}

function elementContext(project: ProjectDocument, element: BimElement, index: number, globals: Record<string, number>): Record<string, number> {
  const level = project.levels.find((item) => item.id === element.levelId);
  const base = (level?.elevation ?? 0) + (readElementParameter(element, 'baseOffset') ?? 0);
  let top = base;
  if (element.category === 'wall' || element.category === 'column') {
    const topLevel = project.levels.find((item) => item.id === element.topLevelId);
    top = (topLevel?.elevation ?? base) + element.topOffset;
  } else if (element.category === 'slab') {
    const type = project.types.find((item) => item.id === element.typeId);
    top = base + (type?.category === 'slab' ? type.thickness : 0);
  }
  const type = project.types.find((item) => item.id === element.typeId);
  const length = element.category === 'wall'
    ? Math.hypot(element.end[0] - element.start[0], element.end[1] - element.start[1]) : 0;
  const area = element.category === 'slab' ? polygonAreaLocal(element.points) : 0;
  // 造型构件（特征树 / 参数化）没有「顶部标高」，但设计规则几乎都要用层高：
  // 「柱高 = 层高 − 0.3」这种公式不该因为构件类别不同就算出 0。
  const storyHeight = projectStoryHeight(project);
  const isMesh = element.category === 'mesh';
  const clearHeight = isMesh ? storyHeight : Math.max(0, top - base);
  const context: Record<string, number> = {
    ...globals,
    层高: clearHeight,
    StoryHeight: clearHeight,
    标高: level?.elevation ?? 0,
    LevelElevation: level?.elevation ?? 0,
    顶部标高: isMesh ? base + storyHeight : top,
    TopElevation: isMesh ? base + storyHeight : top,
    长度: length,
    Length: length,
    面积: area,
    Area: area,
    厚度: type?.category === 'wall' || type?.category === 'slab' ? type.thickness : 0,
    TypeThickness: type?.category === 'wall' || type?.category === 'slab' ? type.thickness : 0,
    截面宽: type?.category === 'column' ? type.width : 0,
    TypeWidth: type?.category === 'column' ? type.width : 0,
    截面深: type?.category === 'column' ? type.depth : 0,
    TypeDepth: type?.category === 'column' ? type.depth : 0,
    底部偏移: readElementParameter(element, 'baseOffset') ?? 0,
    BaseOffset: readElementParameter(element, 'baseOffset') ?? 0,
    序号: index + 1,
    Index: index + 1,
  };
  return context;
}

/**
 * 按依赖顺序重算全部关联参数。无变化时返回原 project 引用。
 * 每次文档变更后调用一次即可（不作迭代收敛，避免自引用公式震荡）。
 */
export function recomputeParameters(project: ProjectDocument): { project: ProjectDocument; report: RecomputeReport } {
  const report = emptyReport();
  const parameters = project.parameters ?? [];
  const byName = new Map(parameters.map((parameter) => [parameter.name, parameter]));
  const original = new Map(parameters.map((parameter) => [parameter.name, parameter.value]));
  const computed = new Map(original);
  const state = new Map<string, 'visiting' | 'done'>();
  const cycle = new Set<string>();

  const resolveGlobal = (name: string, chain: string[]): number => {
    const parameter = byName.get(name);
    if (!parameter) return computed.get(name) ?? 0;
    if (state.get(name) === 'done') return computed.get(name)!;
    if (state.get(name) === 'visiting') {
      for (const item of [...chain.slice(chain.indexOf(name) >= 0 ? chain.indexOf(name) : 0), name]) cycle.add(item);
      return parameter.value;
    }
    state.set(name, 'visiting');
    if (parameter.formula?.trim()) {
      const references = formulaReferences(parameter.formula);
      for (const reference of references) {
        if (byName.has(reference) && reference !== name) resolveGlobal(reference, [...chain, name]);
      }
      const globals = variableMap(parameters.map((item) => ({ ...item, value: computed.get(item.name) ?? item.value })));
      const result = evaluateFormula(parameter.formula, globals);
      if (result.ok) computed.set(name, result.value);
      else {
        report.issues.push({ scope: 'parameter', id: parameter.id, name: parameter.name, key: parameter.name, message: result.error ?? '公式无效' });
      }
    }
    state.set(name, 'done');
    return computed.get(name)!;
  };

  for (const parameter of parameters) resolveGlobal(parameter.name, []);
  if (cycle.size) {
    for (const name of cycle) {
      const parameter = byName.get(name)!;
      computed.set(name, original.get(name)!);
      report.issues.push({ scope: 'parameter', id: parameter.id, name, key: name, message: '循环引用：该参数的公式直接或间接引用了自身' });
    }
  }

  let nextParameters = parameters;
  if (parameters.some((parameter) => Math.abs((computed.get(parameter.name) ?? parameter.value) - parameter.value) > 1e-9)) {
    nextParameters = parameters.map((parameter) => {
      const value = computed.get(parameter.name) ?? parameter.value;
      if (Math.abs(value - parameter.value) <= 1e-9) return parameter;
      report.updates.push({ scope: 'parameter', id: parameter.id, name: parameter.name, key: parameter.name, from: parameter.value, to: value });
      return { ...parameter, value };
    });
  }
  const globals = variableMap(nextParameters);
  const storyHeight = projectStoryHeight(project);

  /* 类型参数：上下文含全部全局参数与项目层高 */
  const typeContext: Record<string, number> = { ...globals, 层高: storyHeight, StoryHeight: storyHeight };
  const changedTypeIds = new Set<string>();
  let nextTypes = project.types;
  const typeReplacements = new Map<string, FamilyType>();
  project.types.forEach((type) => {
    let current = type;
    for (const [key, formula] of Object.entries(type.formulas ?? {})) {
      const spec = typeParameterSpec(type, key);
      if (!spec) {
        report.issues.push({ scope: 'type', id: type.id, name: type.name, key, message: '该类型不存在此参数' });
        continue;
      }
      const result = evaluateFormula(formula, typeContext);
      if (!result.ok) {
        report.issues.push({ scope: 'type', id: type.id, name: type.name, key, message: result.error ?? '公式无效' });
        continue;
      }
      const value = clampValue(spec, result.value);
      const before = readTypeParameter(current, key) ?? value;
      if (Math.abs(value - before) > 1e-9) {
        report.updates.push({ scope: 'type', id: type.id, name: type.name, key, from: before, to: value });
        changedTypeIds.add(type.id);
        current = writeTypeParameter(current, key, value);
      }
    }
    if (current !== type) typeReplacements.set(type.id, current);
  });
  if (typeReplacements.size) {
    nextTypes = project.types.map((type) => typeReplacements.get(type.id) ?? type);
  }

  /* 实例参数：上下文含标高、层高、长度、面积、更新后的类型尺寸 */
  const contextProject: ProjectDocument = { ...project, types: nextTypes, parameters: nextParameters };
  const changedElementIds = new Set<string>();
  let nextElements = project.elements;
  const elementReplacements = new Map<string, BimElement>();
  contextProject.elements.forEach((element, index) => {
    const context = elementContext(contextProject, element, index, globals);
    // 造型构件的尺寸是「特征字段」，走通用约束引擎（别名 → 路径 → 单向求值 → 校验）
    if (isConstraintElement(element)) {
      const result = resolveElementConstraints(element, context);
      for (const update of result.updates) {
        report.updates.push({
          scope: 'element', id: element.id, name: element.name, key: update.path, from: update.from, to: update.to,
        });
      }
      for (const violation of result.violations) {
        report.issues.push({
          scope: 'element',
          id: element.id,
          name: element.name,
          key: violation.target,
          message: violation.severity === 'warn' ? `提示：${violation.message}` : violation.message,
        });
      }
      if (result.element !== element) {
        changedElementIds.add(element.id);
        elementReplacements.set(element.id, result.element);
      }
      return;
    }
    const formulas = element.formulas ?? {};
    if (!Object.keys(formulas).length) return;
    let current: BimElement = element;
    for (const [key, formula] of Object.entries(formulas)) {
      const spec = elementParameterSpec(element, key);
      if (!spec) {
        report.issues.push({ scope: 'element', id: element.id, name: element.name, key, message: '该构件不存在此参数' });
        continue;
      }
      const result = evaluateFormula(formula, context);
      if (!result.ok) {
        report.issues.push({ scope: 'element', id: element.id, name: element.name, key, message: result.error ?? '公式无效' });
        continue;
      }
      const value = clampValue(spec, result.value);
      const before = readElementParameter(current, key) ?? value;
      if (Math.abs(value - before) > 1e-9) {
        report.updates.push({ scope: 'element', id: element.id, name: element.name, key, from: before, to: value });
        changedElementIds.add(element.id);
        current = writeElementParameter(current, key, value);
      }
    }
    if (current !== element) elementReplacements.set(element.id, current);
  });
  if (elementReplacements.size) {
    nextElements = project.elements.map((element) => elementReplacements.get(element.id) ?? element);
  }

  const affected = new Set(changedElementIds);
  if (changedTypeIds.size) {
    for (const element of project.elements) {
      if (element.typeId && changedTypeIds.has(element.typeId)) affected.add(element.id);
    }
  }
  report.affectedElements = affected.size;

  let result = project;
  if (nextParameters !== parameters || nextTypes !== project.types || nextElements !== project.elements) {
    result = { ...project };
    if (nextParameters !== parameters) result.parameters = nextParameters;
    if (nextTypes !== project.types) result.types = nextTypes;
    if (nextElements !== project.elements) result.elements = nextElements;
  }
  return { project: result, report };
}

/** 公式输入时的实时预览（不写文档）；元素公式会带上该构件的上下文变量。 */
export function previewFormula(project: ProjectDocument, formula: string, elementId?: string): EvalResult {
  const parameters = project.parameters ?? [];
  const globals = variableMap(parameters);
  const storyHeight = projectStoryHeight(project);
  let variables: Record<string, number> = { ...globals, 层高: storyHeight, StoryHeight: storyHeight };
  if (elementId) {
    const index = project.elements.findIndex((element) => element.id === elementId);
    const element = index >= 0 ? project.elements[index] : undefined;
    if (element) variables = elementContext(project, element, index, globals);
  }
  return evaluateFormula(formula, variables);
}

/** 只读检查当前文档里的公式问题（用于对话框提示，不修改文档）。 */
export function parameterIssues(project: ProjectDocument): ParameterIssue[] {
  return recomputeParameters(project).report.issues;
}

export interface ParameterUsage {
  name: string;
  id: string;
  usedBy: Array<{ label: string; key: string; formula: string; scope: 'parameter' | 'type' | 'element' }>;
}

/** 依赖关系：每个全局参数被哪些公式引用。 */
export function parameterUsage(project: ProjectDocument): ParameterUsage[] {
  const parameters = project.parameters ?? [];
  const usages = parameters.map((parameter) => ({ name: parameter.name, id: parameter.id, usedBy: [] as ParameterUsage['usedBy'] }));
  const byName = new Map(usages.map((usage) => [usage.name, usage]));
  const record = (formula: string, label: string, key: string, scope: ParameterUsage['usedBy'][number]['scope']) => {
    for (const reference of formulaReferences(formula)) {
      byName.get(reference)?.usedBy.push({ label, key, formula, scope });
    }
  };
  for (const parameter of parameters) {
    if (parameter.formula) record(parameter.formula, parameter.name, parameter.name, 'parameter');
  }
  for (const type of project.types) {
    for (const [key, formula] of Object.entries(type.formulas ?? {})) record(formula, type.name, key, 'type');
  }
  for (const element of project.elements) {
    for (const [key, formula] of Object.entries(element.formulas ?? {})) record(formula, element.name, key, 'element');
  }
  return usages;
}

export function formatParameterValue(value: number, unit: ParameterUnit): string {
  const digits = unit === 'number' || unit === 'count' ? 3 : 3;
  const text = Number(value.toFixed(digits)).toString();
  return unit === 'number' ? text : `${text} ${PARAMETER_UNIT_LABELS[unit]}`;
}
