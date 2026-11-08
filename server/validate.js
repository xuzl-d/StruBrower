/**
 * 文档校验与差分应用（服务端权威实现）。
 * 客户端 src/collab/diff.ts 保持同一套差分语义：按构件 id 合并、数组整包替换。
 */
import { coerceParams, paramTemplate } from '../shared/parametric.js';

export function validateDocument(document) {
  if (!document || typeof document !== 'object') return '文档格式无效';
  if (document.schemaVersion !== 2) return '仅支持 schemaVersion 2 的文档';
  for (const key of ['levels', 'grids', 'materials', 'types', 'elements']) {
    if (!Array.isArray(document[key])) return `${key} 必须是数组`;
  }
  if (!document.levels.length) return '至少需要一个标高';
  if (document.elements.length > 200000) return '构件数量超过服务端上限（200000）';
  for (const element of document.elements) {
    if (!element || typeof element.id !== 'string' || typeof element.category !== 'string') {
      return '构件缺少 id 或 category';
    }
    // 造型实体：特征树是渲染时求值的，限制规模避免一份文档把浏览器卡死
    if (element.primitive && element.primitive.kind === 'solid') {
      const features = element.primitive.features;
      if (!Array.isArray(features) || !features.length) return `构件「${element.name ?? element.id}」的造型缺少特征`;
      if (features.length > 48) return `构件「${element.name ?? element.id}」的造型特征超过 48 个`;
    }
    // 参数化构件：模型文档必须存在，参数必须能夹到合法区间（防止手改文档写出离谱尺寸）。
    // 旧文档里可能残留已经不在库里的模板 id（例如拆分前的 pavilion），此时以特征树快照为准，
    // 不把整份文档判无效——否则用户打开老项目就直接失败。
    if (element.parametric) {
      const template = paramTemplate(element.parametric.template);
      if (template) {
        const { issues } = coerceParams(template.id, element.parametric.params);
        if (issues.length) return `构件「${element.name ?? element.id}」参数无效：${issues[0]}`;
      }
    }
  }
  return null;
}

/** 协作补丁的结构校验，防止异常客户端写入超大数据或错误形状。 */
export function validateDiff(diff) {
  if (!diff || typeof diff !== 'object') return '补丁格式无效';
  const allowed = new Set(['name', 'levels', 'grids', 'types', 'materials', 'layers', 'categoryOverrides', 'parameters', 'elements']);
  for (const key of Object.keys(diff)) {
    if (!allowed.has(key)) return `补丁包含未知字段 ${key}`;
  }
  if (diff.name !== undefined && (typeof diff.name !== 'string' || diff.name.length > 200)) return '项目名无效';
  for (const key of ['levels', 'grids', 'types', 'materials', 'layers', 'parameters']) {
    if (diff[key] !== undefined && (!Array.isArray(diff[key]) || diff[key].length > 5000)) {
      return `${key} 必须是数组且不超过 5000 项`;
    }
  }
  if (diff.categoryOverrides !== undefined) {
    const overrides = diff.categoryOverrides;
    if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides)
      || Object.keys(overrides).length > 32) return 'categoryOverrides 无效';
    for (const value of Object.values(overrides)) {
      if (!value || typeof value !== 'object' || typeof value.visible !== 'boolean') {
        return 'categoryOverrides 中的可见性必须是布尔值';
      }
    }
  }
  if (diff.elements !== undefined) {
    const { put, remove } = diff.elements ?? {};
    if (put !== undefined && (!Array.isArray(put) || put.length > 5000)) return 'elements.put 无效';
    if (remove !== undefined && (!Array.isArray(remove) || remove.length > 5000)) return 'elements.remove 无效';
    for (const element of put ?? []) {
      if (!element || typeof element.id !== 'string' || typeof element.category !== 'string') {
        return 'elements.put 中的构件缺少 id 或 category';
      }
    }
    for (const id of remove ?? []) {
      if (typeof id !== 'string') return 'elements.remove 必须是 id 数组';
    }
  }
  return null;
}

/**
 * 把差分应用到文档（返回新对象，不修改入参）。
 * 构件按 id 合并：先删除 remove，再用 put 覆盖/追加；数组按 id 保持原顺序，新构件追加到末尾。
 */
export function applyDocumentDiff(document, diff) {
  const next = { ...document };
  if (typeof diff.name === 'string' && diff.name.trim()) next.name = diff.name.trim();
  if (Array.isArray(diff.levels)) next.levels = diff.levels;
  if (Array.isArray(diff.grids)) next.grids = diff.grids;
  if (Array.isArray(diff.types)) next.types = diff.types;
  if (Array.isArray(diff.materials)) next.materials = diff.materials;
  if (Array.isArray(diff.layers)) next.layers = diff.layers;
  if (Array.isArray(diff.parameters)) next.parameters = diff.parameters;
  if (diff.categoryOverrides && typeof diff.categoryOverrides === 'object') {
    next.categoryOverrides = diff.categoryOverrides;
  }

  if (diff.elements && typeof diff.elements === 'object') {
    const remove = new Set(Array.isArray(diff.elements.remove) ? diff.elements.remove : []);
    const put = Array.isArray(diff.elements.put) ? diff.elements.put : [];
    const merged = new Map();
    for (const element of document.elements) {
      if (!remove.has(element.id)) merged.set(element.id, element);
    }
    for (const element of put) merged.set(element.id, element);
    next.elements = [...merged.values()];
  }
  return next;
}

export function isEmptyDiff(diff) {
  if (!diff) return true;
  return Object.keys(diff).length === 0
    || (diff.elements && !diff.elements.put?.length && !diff.elements.remove?.length
      && Object.keys(diff).length === 1);
}
