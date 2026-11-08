/**
 * 兼容层：老代码里「参数化模板」的概念，现在只是**带参数绑定的模型文档**。
 *
 * 以前这里是 `PARAM_TEMPLATES` + 每个模型一个 `build()` 生成函数（亭子、飞机各一段代码）。
 * 那样一来「模型」被写死在源码里，AI 既看不见也改不了，和「AI 输出特征树」是两条路。
 * 现在模型全部落在 `shared/models/*.json`（见 shared/library.js）：
 *   - 特征树是数据；
 *   - 参数表（params）与绑定表（bindings）也是数据；
 *   - 这里的 `build` 只是「深拷贝 + 把绑定写进特征字段」，对所有模型通用。
 *
 * 之所以保留这层：构件上仍然用 `element.parametric = { template, params }` 记录
 * 「这件是参数化模型」，面板 / setParams / 明细导出都按这个约定读。
 */
import {
  LIBRARY_MODELS,
  buildModelFeatures,
  coerceModelParams,
  defaultModelParams,
  modelDocument,
  modelHasParams,
  modelParamSpecs,
} from './library.js';

/** 只有「有参数表且绑定表非空」的模型才进这里——其余是静态特征树 */
export const PARAM_TEMPLATES = LIBRARY_MODELS.filter((entry) => modelHasParams(entry.id)).map((entry) => ({
  id: entry.id,
  name: entry.name,
  summary: entry.summary,
  params: modelParamSpecs(entry.id),
  build: (params) => buildModelFeatures(entry.id, params),
}));

const BY_ID = new Map(PARAM_TEMPLATES.map((template) => [template.id, template]));

export function paramTemplate(id) {
  return BY_ID.get(String(id ?? '')) ?? null;
}

export function paramTemplateIds() {
  return PARAM_TEMPLATES.map((template) => template.id);
}

/** 模板的参数默认值（新建参数化构件时用） */
export function defaultParams(templateId) {
  return defaultModelParams(templateId);
}

export function coerceParams(templateId, raw, options) {
  return coerceModelParams(templateId, raw, options);
}

/** 参数模型 → 特征树（数据里的绑定表求值，不跑任何模型专用代码） */
export function buildParametricFeatures(model) {
  const template = paramTemplate(model && model.template);
  if (!template) return [];
  return buildModelFeatures(template.id, model.params);
}

/** 判断一个值是否是参数化模型（服务端校验用） */
export function isParametricModel(value) {
  return Boolean(value && typeof value === 'object' && typeof value.template === 'string' && paramTemplate(value.template));
}

/** 该模型文档能不能当参数化模型用（给 UI 判类型，不必构造对象） */
export function isParametricModelId(id) {
  return Boolean(modelDocument(id) && modelHasParams(id));
}
