/**
 * 约束引擎的构件层包装（typed）。
 *
 * 真正的求值在 shared/constraints.js：服务端校验 AI 写的约束、前端联动求值，用的是同一份代码。
 * 这里只补两件前端特有的事：
 *   1. 写回后刷新参数化构件的特征树快照（导出 / 明细 / 只读展示读的是快照）；
 *   2. 给出「这个构件该不该走约束通路」的判断，供 recomputeParameters 分流。
 */
import {
  CONSTRAINT_LIMITS,
  planConstraints,
  rebaseConstraints,
  resolveConstraints,
  summarizeConstraints,
} from '../../shared/constraints.js';
import type { ConstraintUpdate, ConstraintViolation, ResolveResult } from '../../shared/constraints.js';
import { withParams } from './parametric';
import type { BimElement, MeshInstance } from './types';

export { CONSTRAINT_LIMITS, planConstraints, rebaseConstraints, summarizeConstraints };
export type { ConstraintUpdate, ConstraintViolation };

/** 特征树 / 参数化模型的构件：只有它们有「可寻址尺寸」 */
export function isConstraintElement(element: BimElement): element is MeshInstance {
  return element.category === 'mesh'
    && Boolean(element.parametric || element.primitive?.kind === 'solid');
}

/**
 * 求值一个构件的全部约束。
 * @param globals 项目全局参数 + 构件上下文变量（层高 / 标高 / 长度 …），公式里可读
 */
export function resolveElementConstraints(
  element: MeshInstance,
  globals: Record<string, number> = {},
): ResolveResult<MeshInstance> {
  const result = resolveConstraints<MeshInstance>(element, { globals });
  let next = result.element;
  // 参数化构件改的是 param.*，几何由生成器重建；顺手把快照刷新，避免导出/明细读到旧尺寸
  if (next !== element && next.parametric) next = withParams(next, next.parametric.params);
  return { ...result, element: next };
}

/** 只检查不写回（面板红标、AI 上下文用） */
export function checkElementConstraints(
  element: MeshInstance,
  globals: Record<string, number> = {},
): ConstraintViolation[] {
  return resolveConstraints<MeshInstance>(element, { globals, dryRun: true }).violations;
}

/**
 * 这个尺寸的公式该写在哪个键上：起过名就写别名，否则写路径。
 * 面板读写的都是 elements.formulas，必须和约束引擎用同一个键，否则会出现「两条公式驱动同一个尺寸」。
 */
export function formulaKeyFor(element: BimElement, path: string): string {
  const alias = (element.constraints?.dimensions ?? []).find((item) => item.path === path);
  return alias?.name ?? path;
}

/** 该构件的约束摘要，例如 { dimensions: [...], formulas: {...}, violations: [...] } */
export function constraintSummaryOf(element: MeshInstance, globals: Record<string, number> = {}) {
  return summarizeConstraints(element, { globals });
}
