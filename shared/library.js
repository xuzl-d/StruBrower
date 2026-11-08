/**
 * 模型库：**模型 = 数据**（`shared/models/*.json`），代码里没有「亭子生成器」这种东西。
 *
 * 为什么这样分层
 * --------------
 * 造型内核（src/bim/solid.ts）只认特征树：形状 + 变换 + 阵列 + 布尔。
 * 因此「一个亭子」不是一段 JavaScript，而是一份特征树文档——和 AI 通过 addSolid
 * 吐出来的东西是同一格式、同一套校验。好处是：
 *   - 案例库即 AI 的 few-shot：模型怎么拼的，数据里看得见；
 *   - AI 能改模型：改 JSON 里几个数，而不是改生成器代码再重新构建；
 *   - 新增模型不需要写代码，写/生成一份文档即可。
 *
 * 文档结构
 * --------
 *   {
 *     id, name, summary,            // 元信息
 *     features: [...]               // 特征树（顶层特征数组，与 addSolid.features 同构）
 *     params?: [ {key,label,unit,min,max,default,step,integer?} ]
 *     bindings?: { "f3.height": "height + 0.2", ... }   // 参数 → 特征字段（数据形式的尺寸链）
 *   }
 * bindings 是可选的「参数化层」：表达式里只能用 params 里的键与数字，
 * 求值顺序不敏感（一次算完，不迭代）。需要真正的跨特征依赖/校验规则时，
 * 用构件上的 element.formulas / constraints（shared/constraints.js），不是这里。
 *
 * 这个文件是**纯数据访问**：不 import three，前端、服务端共用同一份。
 */
import pavilionHex from './models/pavilion-hex.json' with { type: 'json' };
import pavilionOct from './models/pavilion-oct.json' with { type: 'json' };
import aircraftA350 from './models/aircraft-a350.json' with { type: 'json' };
import quadcopter from './models/quadcopter.json' with { type: 'json' };
import screwdriver from './models/screwdriver.json' with { type: 'json' };
import gear from './models/gear.json' with { type: 'json' };
import vase from './models/vase.json' with { type: 'json' };
import pipe from './models/pipe.json' with { type: 'json' };
import bracket from './models/bracket.json' with { type: 'json' };
import crawlerCrane from './models/crawler-crane.json' with { type: 'json' };
import { evaluateFormula } from './formula.js';
import { writeDimension } from './dimensions.js';

const clamp = (value, min, max) => Math.min(Math.max(Number.isFinite(value) ? value : min, min), max);

/** 库里的顺序 = 界面上的顺序（先建筑/复杂件，再零件） */
const RAW_DOCUMENTS = [pavilionHex, pavilionOct, aircraftA350, crawlerCrane, quadcopter, screwdriver, gear, vase, pipe, bracket];

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const item of Object.values(value)) deepFreeze(item);
  return value;
}

function assertDocument(doc) {
  const label = `shared/models/${doc?.id ?? '?'}.json`;
  if (!doc || typeof doc !== 'object') throw new Error(`${label} 不是对象`);
  if (typeof doc.id !== 'string' || !doc.id.trim()) throw new Error(`${label} 缺 id`);
  if (typeof doc.name !== 'string' || !doc.name.trim()) throw new Error(`${label} 缺 name`);
  if (!Array.isArray(doc.features) || !doc.features.length) throw new Error(`${label} 的 features 必须是非空数组`);
  doc.features.forEach((feature, index) => {
    const shape = feature?.shape;
    if (!shape || typeof shape.shape !== 'string') {
      throw new Error(`${label} 的第 ${index + 1} 个特征缺 shape.shape`);
    }
  });
  for (const spec of doc.params ?? []) {
    if (!spec || typeof spec.key !== 'string' || !spec.key) throw new Error(`${label} 的参数缺 key`);
    if (typeof spec.default !== 'number') throw new Error(`${label} 的参数「${spec.key}」缺默认值`);
  }
  if (doc.bindings !== undefined) {
    if (!doc.bindings || typeof doc.bindings !== 'object') throw new Error(`${label} 的 bindings 必须是对象`);
    for (const [path, expr] of Object.entries(doc.bindings)) {
      if (typeof expr !== 'string' || !expr.trim()) throw new Error(`${label} 的绑定「${path}」表达式为空`);
    }
  }
}

const DOCUMENTS = RAW_DOCUMENTS.map((doc) => {
  assertDocument(doc);
  return deepFreeze(doc);
});

const BY_ID = new Map(DOCUMENTS.map((doc) => [doc.id, doc]));

/** 全部模型文档（只读；要改请深拷贝，见 libraryFeatures） */
export const MODEL_DOCUMENTS = DOCUMENTS;

/** 界面上直接用的清单：元信息 + 参数表，不含特征树（别把几十 KB 塞进 React state） */
export const LIBRARY_MODELS = DOCUMENTS.map((doc) => ({
  id: doc.id,
  name: doc.name,
  summary: typeof doc.summary === 'string' ? doc.summary : '',
  featureCount: doc.features.length,
  params: (doc.params ?? []).map((spec) => ({ ...spec })),
}));

/** @returns {any|null} */
export function modelDocument(id) {
  return BY_ID.get(String(id ?? '')) ?? null;
}

export function isLibraryModel(id) {
  return BY_ID.has(String(id ?? ''));
}

export function libraryModelIds() {
  return DOCUMENTS.map((doc) => doc.id);
}

/** 参数表（没有参数返回空数组） */
export function modelParamSpecs(id) {
  return (modelDocument(id)?.params ?? []).map((spec) => ({ ...spec }));
}

/** 参数默认值 */
export function defaultModelParams(id) {
  const doc = modelDocument(id);
  if (!doc) return {};
  return Object.fromEntries((doc.params ?? []).map((spec) => [spec.key, spec.default]));
}

/** 每个模型的参数是否能把整件驱动起来（绑定表非空） */
export function modelHasParams(id) {
  const doc = modelDocument(id);
  return Boolean(doc && (doc.params ?? []).length && Object.keys(doc.bindings ?? {}).length);
}

/**
 * 参数归一化：未知键 / 缺键 / 越界都写进 issues，由调用方决定报错还是夹紧。
 * @returns {{params: Record<string, number>, issues: string[]}}
 */
export function coerceModelParams(id, raw, { strict = false } = {}) {
  const doc = modelDocument(id);
  if (!doc) return { params: {}, issues: [`未知模型「${id}」，可用：${libraryModelIds().join(' / ')}`] };
  const source = raw && typeof raw === 'object' ? raw : {};
  const issues = [];
  const params = {};
  for (const spec of doc.params ?? []) {
    const value = source[spec.key];
    if (value === undefined || value === null) {
      if (!strict) params[spec.key] = spec.default;
      continue;
    }
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      issues.push(`参数「${spec.label}」(${spec.key}) 必须是数字`);
      params[spec.key] = spec.default;
      continue;
    }
    const rounded = spec.integer ? Math.round(value) : value;
    if (rounded < spec.min || rounded > spec.max) {
      issues.push(`参数「${spec.label}」(${spec.key}) 应在 ${spec.min} ~ ${spec.max} 之间，收到 ${value}`);
    }
    params[spec.key] = clamp(rounded, spec.min, spec.max);
  }
  for (const key of Object.keys(source)) {
    if (!(doc.params ?? []).some((spec) => spec.key === key)) {
      issues.push(`模型「${doc.name}」没有参数「${key}」，可用：${(doc.params ?? []).map((spec) => spec.key).join(' / ') || '（无）'}`);
    }
  }
  return { params, issues };
}

/**
 * 把参数绑到特征字段上（数据形式的尺寸链）。
 * 表达式只能引用参数与常数，因此一次遍历即可，不需要拓扑排序。
 * @returns {{features: any[], issues: string[]}}
 */
export function applyModelBindings(doc, features, params) {
  const bindings = doc?.bindings ?? {};
  const issues = [];
  let element = { primitive: { kind: 'solid', features } };
  for (const [path, expr] of Object.entries(bindings)) {
    const result = evaluateFormula(expr, params);
    if (!result.ok) {
      issues.push(`绑定「${path}」无法求值：${result.error}`);
      continue;
    }
    const before = element;
    element = writeDimension(element, path, result.value);
    if (element === before) issues.push(`绑定「${path}」没有落到任何可写字段上`);
  }
  return { features: element.primitive.features, issues };
}

/** 模型的初始特征树（深拷贝，改它不会污染库） */
export function libraryFeatures(id) {
  const doc = modelDocument(id);
  if (!doc) throw new Error(`未知模型「${id}」`);
  return structuredClone(doc.features);
}

/**
 * 按参数求值出特征树。
 * @param {string} id
 * @param {Record<string, number>} [params]
 */
export function buildModelFeatures(id, params) {
  const doc = modelDocument(id);
  if (!doc) return [];
  // 缺省参数按默认值补齐；没有参数表的文档 coerceModelParams 会直接返回 {}
  const { params: values } = coerceModelParams(id, params ?? defaultModelParams(id));
  const { features } = applyModelBindings(doc, structuredClone(doc.features), values);
  return features;
}

/** 绑定表自检（服务端与测试用）：返回问题列表，空表示这份文档的参数层是通的 */
export function checkModelDocument(id) {
  const doc = modelDocument(id);
  if (!doc) return [`未知模型「${id}」`];
  const params = defaultModelParams(id);
  const { issues } = applyModelBindings(doc, structuredClone(doc.features), params);
  return issues;
}
