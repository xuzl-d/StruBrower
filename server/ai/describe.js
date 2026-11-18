/**
 * 只读特征树查询（describe）的请求规范化。
 *
 * 项目上下文为了装进模型窗口，只列前 48 个特征，复杂 shape 还会被省略。
 * 模型在自检时可以用 describe 把某个构件 / 特征的**原始定义**取回来，
 * 结果由前端对当前文档求值后以文字回灌（和 measure 同一条通道），不写任何数据。
 *
 * 三类请求：
 * - element { target?, from?, count? }   按序号分页列出构件的完整特征树
 * - feature { target?, feature }         取单个特征的完整定义（含完整 shape）
 * - search  { query, target? }           按关键词检索构件 / 特征，找 id 与序号
 */

export const MAX_DESCRIBE_REQUESTS = 4;
/** 一次 element 请求最多列多少个特征，超了用 from 翻页 */
export const MAX_DESCRIBE_COUNT = 24;
const MAX_REF_CHARS = 80;

function ref(value) {
  if (typeof value === 'number' && Number.isInteger(value) && value >= 1) return value;
  if (typeof value === 'string' && value.trim()) return value.trim().slice(0, MAX_REF_CHARS);
  return undefined;
}

function intInRange(value, min, max, fallback) {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(parsed)));
}

export function normalizeDescribe(raw) {
  const list = Array.isArray(raw) ? raw : [];
  const out = [];
  for (const item of list) {
    if (out.length >= MAX_DESCRIBE_REQUESTS) break;
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const target = ref(item.target);
    // 没写 type 但有 target：按「看整个构件」处理，模型最常这么写
    const type = typeof item.type === 'string' ? item.type.toLowerCase() : (target !== undefined ? 'element' : '');
    const base = target === undefined ? {} : { target };
    if (type === 'element') {
      out.push({
        type: 'element',
        ...base,
        from: intInRange(item.from, 1, 100000, 1),
        count: intInRange(item.count, 1, MAX_DESCRIBE_COUNT, MAX_DESCRIBE_COUNT),
      });
    } else if (type === 'feature') {
      const feature = ref(item.feature);
      if (feature === undefined) continue;
      out.push({ type: 'feature', ...base, feature });
    } else if (type === 'search') {
      const query = typeof item.query === 'string' ? item.query.trim().slice(0, MAX_REF_CHARS) : '';
      if (!query) continue;
      out.push({ type: 'search', ...base, query });
    }
  }
  return out;
}
