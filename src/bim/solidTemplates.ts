/**
 * 模型库的界面适配层：**模型本身是数据**（`shared/models/*.json`），这里只把文档翻成
 * 界面要的清单（id / 名称 / 摘要 / 初始参数 / 取特征树）。
 *
 * 为什么不再有 `pavilionSolid()` 这类函数：
 * 造型内核只认特征树，模型就应该是特征树——和 AI 通过 addSolid 发出来的是同一种东西。
 * 生成器写进源码之后，模型只能由改代码的人改；现在任何一份 JSON 都能加进库里、
 * 也能被 AI 直接读出来当示例。新增模型 = 新增一份文档，不改 TypeScript。
 */
import {
  LIBRARY_MODELS,
  buildModelFeatures,
  defaultModelParams,
  libraryFeatures,
  modelHasParams,
} from '../../shared/library.js';
import type { ParametricModel, SolidFeature } from './types';

export interface SolidTemplate {
  id: string;
  name: string;
  summary: string;
  /**
   * 参数化：文档里带了参数表 + 绑定表。落成构件后改参数，整组特征跟着重算。
   * 没有这个字段的模板是静态特征树，套用后就固定了（可在特征树里逐项改尺寸）。
   */
  parametric?: ParametricModel;
  build: () => SolidFeature[];
}

export const SOLID_TEMPLATES: SolidTemplate[] = LIBRARY_MODELS.map((entry) => {
  const parametric: ParametricModel | undefined = modelHasParams(entry.id)
    ? { template: entry.id, params: defaultModelParams(entry.id) }
    : undefined;
  return {
    id: entry.id,
    name: entry.name,
    summary: entry.summary,
    ...(parametric ? { parametric } : {}),
    build: () => (parametric ? buildModelFeatures(entry.id, parametric.params) : libraryFeatures(entry.id)),
  };
});
