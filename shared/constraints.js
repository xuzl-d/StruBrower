/**
 * 通用约束引擎（纯数据，无 three 依赖，服务端与前端共用）。
 *
 * ## 为什么是「单向赋值 + 断言」而不是约束求解器
 *
 * 通用几何约束求解（尺寸标注、相切/同心/共线、过约束诊断、双向拖动）需要三件东西：
 *   1. 稳定的拓扑引用（改尺寸之后，第 137 号面还是同一个面）——B-rep persistent naming；
 *   2. 雅可比矩阵 + 牛顿迭代 + 最小二乘（欠约束时给最小改动解）；
 *   3. 冗余/冲突诊断（哪条约束是多余的、哪两条打架）。
 * 这是 CAD 内核级别的工作量，而且和「特征树每次改参数都重建几何」天然冲突：
 * 重建之后拓扑引用就失效了。所以这里做的是工程上真正撑得住的那一层——
 * **在特征字段上做有向依赖图（DAG）**：
 *
 *   - 驱动式（driving）：`field = 表达式`，一次拓扑排序求值，无环即收敛（不需要迭代）；
 *   - 校验式（checking）：`要求`，求值后核对，不满足就报违规，**绝不偷偷改模型**。
 *
 * 建筑/产品建模里 90% 的「约束」本来就是尺寸链（柱高 = 层高 − 梁高、踏步数 = round(层高/踏步高)），
 * 它是单向的、可显式求解的，不需要联立方程。剩下 10%（相切、共线、对称）留白，并在文档里写清楚。
 *
 * ## 三种写法
 *
 *   element.constraints.dimensions = [{ name: '柱高', path: 'f2.height' }]   // 起名
 *   element.formulas = { '柱高': '层高 - 0.3' }                             // 驱动（谁决定谁）
 *   element.constraints.checks = [{ expr: '柱高 <= 层高 - 0.2', message: '…' }] // 校验（成立才合规）
 *
 * 公式里既能用别名，也能直接用路径（`f2.height * 2`），所以「不起名」也能约束。
 */

import { evaluateFormula, formulaReferences, remapIdentifiers } from './formula.js';
import { clampDimension, listDimensions, remapFeaturePath, writeDimension } from './dimensions.js';

export const CONSTRAINT_LIMITS = {
  /** 单个构件最多多少个尺寸别名 */
  dimensions: 40,
  /** 单个构件最多多少条校验规则 */
  checks: 20,
  /** 单条表达式长度上限 */
  expression: 240,
};

const push = (list, kind, target, message, severity = 'error') => {
  list.push({ kind, target, message, severity });
};

/**
 * 建立约束的静态视图：别名、绑定、规格、依赖。
 * 不做任何写入，因此可以在服务端「只校验不落库」。
 */
export function planConstraints(element) {
  const dimensions = listDimensions(element);
  const specByPath = new Map(dimensions.map((item) => [item.path, item]));
  const values = new Map(dimensions.map((item) => [item.path, item.value]));
  const errors = [];
  const warnings = [];
  const pathByAlias = new Map();
  const aliasByPath = new Map();

  for (const alias of element?.constraints?.dimensions ?? []) {
    const name = typeof alias?.name === 'string' ? alias.name.trim() : '';
    const path = typeof alias?.path === 'string' ? alias.path.trim() : '';
    if (!name || !path) {
      push(errors, 'alias', name || path, '尺寸别名需要 name 与 path');
      continue;
    }
    if (name.length > 24) {
      push(errors, 'alias', name, `别名「${name}」太长（上限 24 字）`);
      continue;
    }
    if (!specByPath.has(path)) {
      push(errors, 'alias', name, `别名「${name}」指向的尺寸「${path}」不存在，可用路径见 solidInfo 或特征尺寸表`);
      continue;
    }
    if (pathByAlias.has(name)) {
      push(errors, 'alias', name, `别名「${name}」重复定义`);
      continue;
    }
    pathByAlias.set(name, path);
    aliasByPath.set(path, name);
  }

  /** 键 → 路径：公式键可以写别名，也可以直接写路径 */
  const resolveKey = (key) => pathByAlias.get(key) ?? (specByPath.has(key) ? key : null);

  /** @type {Array<{key:string, path:string, expr:string}>} */
  const bindings = [];
  const seenPath = new Map();
  for (const [key, expr] of Object.entries(element?.formulas ?? {})) {
    if (typeof expr !== 'string' || !expr.trim()) continue;
    const path = resolveKey(key);
    if (!path) {
      push(errors, 'formula', key, `公式键「${key}」既不是别名也不是可寻址尺寸`);
      continue;
    }
    if (expr.trim().length > CONSTRAINT_LIMITS.expression) {
      push(errors, 'formula', key, `公式太长（上限 ${CONSTRAINT_LIMITS.expression} 字符）`);
      continue;
    }
    if (seenPath.has(path)) {
      push(errors, 'formula', key, `尺寸「${path}」被 ${seenPath.get(path)} 与 ${key} 同时驱动`);
      continue;
    }
    seenPath.set(path, key);
    bindings.push({ key, path, expr: expr.trim() });
  }

  const bindingByPath = new Map(bindings.map((item) => [item.path, item]));
  // 依赖只算「另一个被公式驱动的尺寸」：引用普通尺寸/项目参数不产生排序约束
  const deps = new Map();
  for (const binding of bindings) {
    const list = [];
    for (const reference of formulaReferences(binding.expr)) {
      const refPath = resolveKey(reference);
      if (refPath && bindingByPath.has(refPath) && refPath !== binding.path) list.push(refPath);
    }
    deps.set(binding.path, list);
  }

  return { dimensions, specByPath, values, pathByAlias, aliasByPath, bindings, bindingByPath, deps, errors, warnings };
}

/**
 * 求值：按依赖顺序算驱动式，写回尺寸，最后核对校验式。
 *
 * @param {any} element
 * @param {{globals?: Record<string, number>, clamp?: boolean, dryRun?: boolean}} [options]
 *   globals：项目全局参数 + 上下文变量（层高 / 标高 / 长度 …），只在表达式里可读，不会被写回
 *   dryRun：只算不写（服务端校验用）
 * @returns {{element:any, updates:Array<{path:string,label:string,from:number,to:number}>, violations:Array<{kind:string,target:string,message:string,severity:'error'|'warn'}>, values:Record<string,number>}}
 */
export function resolveConstraints(element, options = {}) {
  const globals = options.globals && typeof options.globals === 'object' ? options.globals : {};
  const clamp = options.clamp !== false;
  const dryRun = options.dryRun === true;

  const plan = planConstraints(element);
  const violations = [...plan.errors];
  const updates = [];
  const { specByPath, values, pathByAlias, aliasByPath, bindingByPath, deps } = plan;

    // 先把「引用了不存在的东西」逐个点出来：这是 AI 最常犯的错（自己编一个尺寸名）
  for (const binding of plan.bindings) {
    for (const reference of formulaReferences(binding.expr)) {
      if (pathByAlias.has(reference) || specByPath.has(reference) || reference in globals) continue;
      push(violations, 'formula', binding.key, `公式「${binding.key}」引用了不存在的量「${reference}」（既不是别名、不是尺寸路径，也不是项目参数）`);
    }
  }

  const buildVars = () => {
    const vars = { ...globals };
    for (const [path, value] of values) vars[path] = value;
    for (const [name, path] of pathByAlias) {
      const value = values.get(path);
      if (typeof value === 'number') vars[name] = value;
    }
    return vars;
  };

  // 拓扑排序（深搜），顺带找出环
  const order = [];
  const state = new Map();
  const cyclePaths = new Set();
  const visit = (path, chain) => {
    const current = state.get(path);
    if (current === 'done') return;
    if (current === 'visiting') {
      const start = chain.indexOf(path);
      for (const item of [...chain.slice(start >= 0 ? start : 0), path]) cyclePaths.add(item);
      return;
    }
    state.set(path, 'visiting');
    for (const dep of deps.get(path) ?? []) visit(dep, [...chain, path]);
    state.set(path, 'done');
    order.push(path);
  };
  for (const binding of plan.bindings) visit(binding.path, []);

  for (const path of cyclePaths) {
    const binding = bindingByPath.get(path);
    push(violations, 'formula', binding?.key ?? path, `循环引用：「${aliasByPath.get(path) ?? path}」的公式直接或间接引用了自身，已保留原值`);
  }

  for (const path of order) {
    if (cyclePaths.has(path)) continue;
    const binding = bindingByPath.get(path);
    if (!binding) continue;
    const result = evaluateFormula(binding.expr, buildVars());
    if (!result.ok) {
      push(violations, 'formula', binding.key, `公式「${binding.expr}」无法求值：${result.error}`);
      continue;
    }
    const spec = specByPath.get(path) ?? null;
    const value = clamp ? clampDimension(spec, result.value) : result.value;
    if (value === null) {
      push(violations, 'formula', binding.key, `公式「${binding.expr}」算出的不是有限数值`);
      continue;
    }
    const before = values.get(path);
    if (typeof before !== 'number') continue;
    if (Math.abs(value - before) > 1e-9) {
      values.set(path, value);
      updates.push({ path, label: aliasByPath.get(path) ?? spec?.label ?? path, from: before, to: value });
    }
  }

  let next = element;
  if (!dryRun) {
    for (const update of updates) next = writeDimension(next, update.path, update.to);
  }

  // 校验式：表达式写的是「要求」，为假即违规
  const checks = Array.isArray(element?.constraints?.checks) ? element.constraints.checks : [];
  if (checks.length > CONSTRAINT_LIMITS.checks) {
    push(violations, 'check', 'checks', `校验规则最多 ${CONSTRAINT_LIMITS.checks} 条，当前 ${checks.length} 条`);
  }
  for (const check of checks.slice(0, CONSTRAINT_LIMITS.checks)) {
    const expr = typeof check?.expr === 'string' ? check.expr.trim() : '';
    if (!expr) continue;
    if (expr.length > CONSTRAINT_LIMITS.expression) {
      push(violations, 'check', check.id ?? expr, '校验规则太长');
      continue;
    }
    const result = evaluateFormula(expr, buildVars());
    if (!result.ok) {
      push(violations, 'check', check.id ?? expr, `校验规则「${expr}」无法求值：${result.error}`);
      continue;
    }
    if (Math.abs(result.value) < 1e-9) {
      push(violations, 'check', check.id ?? expr, check.message ?? `不满足约束：${expr}`, check.severity ?? 'error');
    }
  }

  return { element: next, updates, violations, values: Object.fromEntries(values) };
}

/**
 * 特征树增删后，把约束里的特征序号搬到新位置（否则 `f3.height` 会悄悄指向别的零件）。
 * @param {any} element
 * @param {Record<number, number|undefined>} remap 旧序号(1 起) → 新序号(1 起)
 */
export function rebaseConstraints(element, remap) {
  if (!element || typeof element !== 'object') return element;
  const removed = new Set(Object.entries(remap).filter(([, value]) => value === undefined).map(([key]) => Number(key)));
  const mentionsRemoved = (expr) => formulaReferences(expr).some((reference) => {
    const match = /^f(\d+)(?:\.|$)/.exec(reference);
    return match ? removed.has(Number(match[1])) : false;
  });

  let changed = false;
  const next = { ...element };
  // 别名 → 路径：别名被删掉时，用它当键的公式也必须跟着删（否则公式会指向一个不存在的名字）
  const aliasPaths = new Map((element.constraints?.dimensions ?? []).map((alias) => [alias.name, alias.path]));

  if (element.formulas && Object.keys(element.formulas).length) {
    const formulas = {};
    for (const [key, expr] of Object.entries(element.formulas)) {
      const aliasPath = aliasPaths.get(key);
      const nextKey = remapFeaturePath(key, remap);
      const keyGone = nextKey === null || (aliasPath !== undefined && remapFeaturePath(aliasPath, remap) === null);
      if (keyGone || mentionsRemoved(expr)) { changed = true; continue; }
      const nextExpr = remapIdentifiers(expr, remap);
      if (nextKey !== key || nextExpr !== expr) changed = true;
      formulas[nextKey ?? key] = nextExpr;
    }
    next.formulas = Object.keys(formulas).length ? formulas : undefined;
    if (!next.formulas) delete next.formulas;
  }

  const constraints = element.constraints;
  if (constraints) {
    const dimensions = (constraints.dimensions ?? [])
      .map((alias) => {
        const path = remapFeaturePath(alias.path, remap);
        if (!path) { changed = true; return null; }
        if (path !== alias.path) changed = true;
        return { ...alias, path };
      })
      .filter(Boolean);
    const checks = (constraints.checks ?? [])
      .map((check) => {
        if (mentionsRemoved(check.expr)) { changed = true; return null; }
        const expr = remapIdentifiers(check.expr, remap);
        if (expr !== check.expr) changed = true;
        return { ...check, expr };
      })
      .filter(Boolean);
    if (dimensions.length || checks.length) {
      next.constraints = {
        ...(dimensions.length ? { dimensions } : {}),
        ...(checks.length ? { checks } : {}),
      };
    } else {
      delete next.constraints;
    }
  }

  return changed ? next : element;
}

/** 给上下文 / 面板用的紧凑摘要：名字、路径、当前值、公式、违规 */
export function summarizeConstraints(element, { globals = {} } = {}) {
  const constraints = element?.constraints ?? {};
  const aliases = (constraints.dimensions ?? []).map((alias) => ({
    name: alias.name,
    path: alias.path,
    value: planValue(element, alias.path),
  }));
  const formulas = Object.fromEntries(
    Object.entries(element?.formulas ?? {}).filter(([, expr]) => typeof expr === 'string' && expr.trim()),
  );
  const checks = (constraints.checks ?? []).map((check) => ({
    expr: check.expr,
    ...(check.message ? { message: check.message } : {}),
    ...(check.severity ? { severity: check.severity } : {}),
  }));
  const violations = (aliases.length || Object.keys(formulas).length || checks.length)
    ? resolveConstraints(element, { globals, dryRun: true }).violations
    : [];
  return {
    ...(aliases.length ? { dimensions: aliases } : {}),
    ...(Object.keys(formulas).length ? { formulas } : {}),
    ...(checks.length ? { checks } : {}),
    ...(violations.length ? { violations: violations.map((item) => item.message) } : {}),
  };
}

function planValue(element, path) {
  const found = listDimensions(element).find((item) => item.path === path);
  return found ? found.value : null;
}
