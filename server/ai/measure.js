/**
 * 几何测量请求（measure）：AI 在自检时可以要求前端对当前特征树求值后量一量。
 * 与 inspect 同理，认不出的项直接丢掉，不让一次格式错误打断生成。
 *
 * 三类请求（坐标均为造型构件局部坐标，单位米，与特征的 translate 一致）：
 * - bounds  { target?, feature? }                    包围盒
 * - surface { target?, feature?, axis?, at:[a,b] }   沿轴向穿过一点的射线与表面的交点（axis=z 时 at=[x,y]，x 时 [y,z]，y 时 [x,z]）
 * - gap     { target?, a, b }                        两个特征之间的最近距离与穿插估计
 */

export const MAX_MEASURE_REQUESTS = 6;
const MAX_REF_CHARS = 60;
const MAX_COORD = 20000;

const AXES = new Set(['x', 'y', 'z']);

function ref(value) {
  if (typeof value === 'number' && Number.isInteger(value) && value >= 1) return value;
  if (typeof value === 'string' && value.trim()) return value.trim().slice(0, MAX_REF_CHARS);
  return undefined;
}

function coordinate(value) {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) && Math.abs(parsed) <= MAX_COORD ? parsed : null;
}

export function normalizeMeasure(raw) {
  const list = Array.isArray(raw) ? raw : [];
  const out = [];
  for (const item of list) {
    if (out.length >= MAX_MEASURE_REQUESTS) break;
    if (!item || typeof item !== 'object') continue;
    const target = ref(item.target);
    const base = target === undefined ? {} : { target };
    if (item.type === 'bounds') {
      const feature = ref(item.feature);
      out.push({ type: 'bounds', ...base, ...(feature === undefined ? {} : { feature }) });
    } else if (item.type === 'surface') {
      const at = Array.isArray(item.at) ? [coordinate(item.at[0]), coordinate(item.at[1])] : null;
      if (!at || at.some((value) => value === null)) continue;
      const axis = typeof item.axis === 'string' && AXES.has(item.axis.toLowerCase()) ? item.axis.toLowerCase() : 'z';
      const feature = ref(item.feature);
      out.push({ type: 'surface', ...base, ...(feature === undefined ? {} : { feature }), axis, at });
    } else if (item.type === 'gap') {
      const a = ref(item.a);
      const b = ref(item.b);
      if (a === undefined || b === undefined) continue;
      out.push({ type: 'gap', ...base, a, b });
    }
  }
  return out;
}
