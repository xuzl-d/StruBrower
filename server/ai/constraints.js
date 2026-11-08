/**
 * 约束的服务端校验（AI 指令的权威入口）。
 *
 * AI 可以给**任意**造型构件写约束（不限预置模板）：
 *   { op:'setConstraints', target, dimensions:[{name,path}], formulas:{...}, checks:[{expr,message}] }
 *
 * 校验的重点不是「算得对不对」，而是「指得准不准」——AI 最容易犯的错是
 * 编一个不存在的尺寸名（`f9.height`），或者引用一个自己刚起的别名却没写进 dimensions。
 * 这两类错在服务端就被拦住，返回可操作的提示（含可用路径清单），而不是等到前端静默失败。
 */
import crypto from 'node:crypto';
import { OpsError } from './errors.js';
import { CONSTRAINT_LIMITS, resolveConstraints } from '../../shared/constraints.js';
import { listDimensions } from '../../shared/dimensions.js';
import { evaluateFormula, formulaReferences } from '../../shared/formula.js';

/** 表达式里可以直接用的上下文变量（构件级），给 0 占位即可通过语法/引用校验 */
const CONTEXT_NAMES = ['层高', '标高', '顶部标高', '长度', '面积', '厚度', '截面宽', '截面深', '底部偏移', '序号'];

function globalVariables(document) {
  const vars = {};
  for (const name of CONTEXT_NAMES) vars[name] = 0;
  for (const parameter of document.parameters ?? []) vars[parameter.name] = 0;
  return vars;
}

function describeAvailable(element) {
  const dims = listDimensions(element);
  const preview = dims.slice(0, 14).map((spec) => spec.path).join(' / ');
  return dims.length ? `可用尺寸路径：${preview}${dims.length > 14 ? ` …（共 ${dims.length} 个）` : ''}` : '该构件没有可驱动尺寸';
}

/**
 * 把约束补丁合并进构件并校验。
 * @returns {{ element: any, notes: string[] }}
 */
export function applyConstraintPatch(document, element, op) {
  const dims = listDimensions(element);
  const specByPath = new Map(dims.map((spec) => [spec.path, spec]));
  const globals = globalVariables(document);
  const notes = [];

  // 模型时而把三个字段包进 constraints 里，时而写 formula 单数：认掉，别让它白跑一趟
  const nested = op.constraints && typeof op.constraints === 'object' ? op.constraints : {};
  const dimensionsInput = op.dimensions ?? nested.dimensions;
  const checksInput = op.checks ?? nested.checks;
  const formulasInput = op.formulas ?? op.formula ?? nested.formulas;

  const next = { ...element };
  const clear = op.replace === true || nested.replace === true;
  let constraints = clear ? {} : { ...(element.constraints ?? {}) };
  let formulas = clear ? {} : { ...(element.formulas ?? {}) };

  /* ---------- 1. 别名表 ---------- */
  const pathByAlias = new Map();
  const aliasTable = new Map();
  for (const alias of constraints.dimensions ?? []) {
    if (alias?.name && alias?.path) {
      aliasTable.set(alias.name, alias);
      pathByAlias.set(alias.name, alias.path);
    }
  }

  if (dimensionsInput !== undefined) {
    if (!Array.isArray(dimensionsInput)) throw new OpsError('dimensions 必须是 [{ name, path }] 数组');
    if (dimensionsInput.length > CONSTRAINT_LIMITS.dimensions) {
      throw new OpsError(`尺寸别名最多 ${CONSTRAINT_LIMITS.dimensions} 个`);
    }
    aliasTable.clear();
    pathByAlias.clear();
    dimensionsInput.forEach((raw, index) => {
      const name = typeof raw?.name === 'string' ? raw.name.trim() : '';
      const path = typeof raw?.path === 'string' ? raw.path.trim() : '';
      const label = `dimensions[${index}]`;
      if (!name) throw new OpsError(`${label} 缺少 name（公式里用的名字，可为中文）`);
      if (!path) throw new OpsError(`${label}「${name}」缺少 path（尺寸路径）`);
      if (name.length > 24) throw new OpsError(`${label} 名称「${name}」太长（上限 24 字）`);
      if (name in globals) throw new OpsError(`别名「${name}」与项目参数同名，会遮蔽项目参数，请换个名字`);
      if (pathByAlias.has(name)) throw new OpsError(`别名「${name}」重复`);
      if (!specByPath.has(path)) {
        throw new OpsError(`别名「${name}」指向的尺寸「${path}」不存在。${describeAvailable(element)}`);
      }
      pathByAlias.set(name, path);
      aliasTable.set(name, {
        name,
        path,
        ...(typeof raw.unit === 'string' ? { unit: raw.unit } : {}),
        ...(typeof raw.label === 'string' ? { label: raw.label.slice(0, 24) } : {}),
      });
    });
  }

  // 探针变量：尺寸与别名一律先给 0，只用来判语法与引用是否存在（别名要在这一行之前收集完）
  const probeVars = {
    ...globals,
    ...Object.fromEntries(dims.map((spec) => [spec.path, 0])),
    ...Object.fromEntries([...pathByAlias.keys()].map((name) => [name, 0])),
  };

  const resolveKey = (key) => pathByAlias.get(key) ?? (specByPath.has(key) ? key : null);

  /* ---------- 2. 驱动式公式 ---------- */
  if (formulasInput !== undefined) {
    if (!formulasInput || typeof formulasInput !== 'object' || Array.isArray(formulasInput)) {
      throw new OpsError('formulas 必须是对象，例如 { "柱高": "层高 - 0.3" }');
    }
    for (const [key, raw] of Object.entries(formulasInput)) {
      if (raw === null || raw === undefined || raw === '') {
        delete formulas[key];
        continue;
      }
      if (typeof raw !== 'string') throw new OpsError(`公式「${key}」必须是字符串`);
      const expr = raw.trim();
      if (expr.length > CONSTRAINT_LIMITS.expression) throw new OpsError(`公式「${key}」太长（上限 ${CONSTRAINT_LIMITS.expression} 字符）`);
      const path = resolveKey(key);
      if (!path) {
        throw new OpsError(`公式键「${key}」既不是别名也不是尺寸路径。先写 dimensions 起名，或直接用路径。${describeAvailable(element)}`);
      }
      const probe = evaluateFormula(expr, probeVars);
      if (!probe.ok) throw new OpsError(`公式「${key} = ${expr}」无法求值：${probe.error}`);
      for (const reference of formulaReferences(expr)) {
        if (reference === path) continue;
        if (resolveKey(reference) || reference in globals) continue;
        throw new OpsError(
          `公式「${key}」引用了不存在的量「${reference}」：它既不是 dimensions 里的别名、不是尺寸路径，也不是项目参数。`
          + `若想用新名字，先把它写进 dimensions（例如 { "name": "${reference}", "path": "f2.height" }）。`,
        );
      }
      formulas[key] = expr;
    }
  }

  /* ---------- 3. 校验式 ---------- */
  if (checksInput !== undefined) {
    if (!Array.isArray(checksInput)) throw new OpsError('checks 必须是 [{ expr, message? }] 数组');
    if (checksInput.length > CONSTRAINT_LIMITS.checks) {
      throw new OpsError(`校验规则最多 ${CONSTRAINT_LIMITS.checks} 条`);
    }
    const checks = [];
    checksInput.forEach((raw, index) => {
      const expr = typeof raw?.expr === 'string' ? raw.expr.trim() : '';
      if (!expr) throw new OpsError(`checks[${index}] 缺少 expr（写「要求」，为假即违规）`);
      if (expr.length > CONSTRAINT_LIMITS.expression) throw new OpsError(`checks[${index}] 表达式太长`);
      const probe = evaluateFormula(expr, probeVars);
      if (!probe.ok) throw new OpsError(`校验规则「${expr}」无法求值：${probe.error}`);
      for (const reference of formulaReferences(expr)) {
        if (resolveKey(reference) || reference in globals) continue;
        throw new OpsError(`校验规则「${expr}」引用了不存在的量「${reference}」，先写进 dimensions 或改用尺寸路径`);
      }
      const severity = raw.severity === 'warn' ? 'warn' : 'error';
      checks.push({
        id: typeof raw.id === 'string' && raw.id ? raw.id.slice(0, 64) : `chk-${crypto.randomUUID()}`,
        expr,
        ...(typeof raw.message === 'string' && raw.message.trim() ? { message: raw.message.trim().slice(0, 120) } : {}),
        severity,
      });
    });
    constraints.checks = checks;
  }

  /* ---------- 4. 组装 ---------- */
  const dimensions = [...aliasTable.values()];
  if (dimensions.length) constraints.dimensions = dimensions;
  else delete constraints.dimensions;
  if (!constraints.checks?.length) delete constraints.checks;

  next.formulas = formulas;
  if (!Object.keys(formulas).length) delete next.formulas;
  if (Object.keys(constraints).length) next.constraints = constraints;
  else delete next.constraints;

  /* ---------- 5. 成环检测（唯一需要跑一遍求值才能发现的问题） ---------- */
  const { violations } = resolveConstraints(next, { globals, dryRun: true });
  const cycle = violations.find((item) => item.kind === 'formula' && item.message.includes('循环引用'));
  if (cycle) throw new OpsError(`${cycle.message}。请打破循环：让其中一个尺寸直接写字面值，或改成校验式检查`);

  if (clear) notes.push('已清空原有约束');
  if (dimensions.length) notes.push(`${dimensions.length} 个尺寸别名（${dimensions.map((item) => item.name).join(' / ')}）`);
  if (Object.keys(formulas).length) notes.push(`${Object.keys(formulas).length} 条驱动约束`);
  if (constraints.checks?.length) notes.push(`${constraints.checks.length} 条校验规则`);

  return { element: next, notes };
}
