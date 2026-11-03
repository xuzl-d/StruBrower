/**
 * 文档校验与差分应用（服务端权威实现）。
 * 客户端 src/collab/diff.ts 保持同一套差分语义：按构件 id 合并、数组整包替换。
 */

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
  }
  return null;
}

/** 协作补丁的结构校验，防止异常客户端写入超大数据或错误形状。 */
export function validateDiff(diff) {
  if (!diff || typeof diff !== 'object') return '补丁格式无效';
  const allowed = new Set(['name', 'levels', 'grids', 'types', 'materials', 'elements']);
  for (const key of Object.keys(diff)) {
    if (!allowed.has(key)) return `补丁包含未知字段 ${key}`;
  }
  if (diff.name !== undefined && (typeof diff.name !== 'string' || diff.name.length > 200)) return '项目名无效';
  for (const key of ['levels', 'grids', 'types', 'materials']) {
    if (diff[key] !== undefined && (!Array.isArray(diff[key]) || diff[key].length > 5000)) {
      return `${key} 必须是数组且不超过 5000 项`;
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
