/**
 * 参数化模型的客户端辅助：把「模板 + 参数」翻译成几何，并维护特征树快照。
 *
 * 与 `shared/parametric.js` 的分工：
 *   - shared：模板定义（参数表 + 生成器），服务端校验与前端求值共用；
 *   - 这里：构件层面的读写——求值入口 `solidPrimitiveOf`、改参数 `withParam`、断开 `disconnect`。
 *
 * 约束怎么来的：模板内部用代码写死尺寸关系（额枋骑柱头、檐口 = 柱顶、屋顶起坡按柱网半径），
 * 跨构件的约束（柱高 = 层高 − 0.3）走项目已有的 `element.formulas`，键名 `param.<key>`。
 * 因此不需要表达式求解器，也不需要在特征之间解方程。
 */
import {
  PARAM_TEMPLATES,
  buildParametricFeatures,
  coerceParams,
  defaultParams,
  isParametricModel,
  paramTemplate,
  paramTemplateIds,
} from '../../shared/parametric.js';
import type { MeshInstance, ParametricModel, PrimitiveSpec, SolidFeature } from './types';

export { PARAM_TEMPLATES, buildParametricFeatures, coerceParams, defaultParams, paramTemplate, paramTemplateIds, isParametricModel };

export type { ParamSpec, ParamTemplate } from '../../shared/parametric.js';

/** 该构件是不是参数化模型 */
export function isParametric(element: MeshInstance): boolean {
  return Boolean(element.parametric && paramTemplate(element.parametric.template));
}

/** 特征树快照（参数化构件则是按当前参数重建的结果） */
export function solidFeaturesOf(element: MeshInstance): SolidFeature[] {
  if (element.parametric) {
    const features = buildParametricFeatures(element.parametric);
    if (features.length) return features;
  }
  return element.primitive?.kind === 'solid' ? element.primitive.features : [];
}

/**
 * 求值用的 primitive：参数化构件就地重建，其余原样返回。
 * geometry.ts 只认这一层，所以「文档里存参数」和「文档里存特征树」在视口里没有差别。
 */
export function solidPrimitiveOf(element: MeshInstance): PrimitiveSpec | undefined {
  if (element.parametric) {
    const features = buildParametricFeatures(element.parametric);
    if (features.length) return { kind: 'solid', features };
  }
  return element.primitive;
}

/** 参数化构件改一个参数：同时刷新快照，保证导出 / 明细 / 只读展示一致 */
export function withParam(element: MeshInstance, key: string, value: number): MeshInstance {
  if (!element.parametric) return element;
  const { params } = coerceParams(element.parametric.template, { ...element.parametric.params, [key]: value });
  return withParams(element, params);
}

/** 参数化构件批量改参数（AI 的 setParams、面板一次改多个都用它） */
export function withParams(element: MeshInstance, patch: Record<string, number>): MeshInstance {
  if (!element.parametric) return element;
  const { params } = coerceParams(element.parametric.template, { ...element.parametric.params, ...patch });
  const parametric: ParametricModel = { ...element.parametric, params };
  const features = buildParametricFeatures(parametric);
  return {
    ...element,
    parametric,
    ...(features.length ? { primitive: { kind: 'solid' as const, features } } : {}),
  };
}

/**
 * 断开参数化，只保留当前几何的特征树。
 * 用户手动改特征就相当于「转成静态特征树」——参数再也不会覆盖他的编辑。
 */
export function disconnectParametric(element: MeshInstance): MeshInstance {
  if (!element.parametric) return element;
  const features = solidFeaturesOf(element);
  const next: MeshInstance = { ...element, parametric: undefined };
  if (features.length) next.primitive = { kind: 'solid', features };
  return next;
}

/** 参数问题的可读文案（面板提示用） */
export function paramIssues(model: ParametricModel): string[] {
  const template = paramTemplate(model.template);
  if (!template) return [`未知参数化模板「${model.template}」`];
  return coerceParams(template.id, model.params).issues;
}
