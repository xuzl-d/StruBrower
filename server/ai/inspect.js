/**
 * 视角巡检（inspect）：AI 不只是「读特征树」，还可以要求把界面转到某个角度、
 * 甚至凑近某个构件看一眼，截图回传给它看——这是它自己「操作软件」的那部分能力。
 *
 * 约定（与前端 AiPanel / ModelViewport 共用）：
 * - 一轮最多 4 个视角（图片上限也是 4 张，多了要么被截断要么白烧 token）
 * - 用预设视角：iso / front / back / left / right / top / bottom
 * - 或用自定义角度：{ azimuth, elevation }（度；方位角从 +X 起沿 +Y 逆时针，仰角从水平面向上）
 * - focus：只框住某个构件（按名字或 id 模糊匹配），用来放大看细节
 * - zoom：取景倍数，1 = 整机框满，2 = 推进一倍，0.5 = 退远一半
 */

export const MAX_INSPECT_VIEWS = 4;
/** 放大倍数范围：再大就会穿进构件内部，再小整机只剩几个像素 */
export const MIN_INSPECT_ZOOM = 0.4;
export const MAX_INSPECT_ZOOM = 4;
/** focus 只用来匹配构件名，不需要长文本 */
const MAX_FOCUS_CHARS = 40;

const PRESET_LABELS = {
  iso: '等轴测',
  front: '前视',
  back: '后视',
  left: '左视',
  right: '右视',
  top: '俯视',
  bottom: '仰视',
};

export const INSPECT_PRESETS = Object.keys(PRESET_LABELS);

function num(value) {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function angleLabel(azimuth, elevation) {
  return `方位 ${Math.round(azimuth)}° / 仰角 ${Math.round(elevation)}°`;
}

/** 取景说明拼在视角名后面：「右视 · 聚焦「夹头」 × 2.5」 */
function framingLabel(focus, zoom) {
  const parts = [];
  if (focus) parts.push(`聚焦「${focus}」`);
  if (zoom !== 1) parts.push(`× ${zoom}`);
  return parts.join(' ');
}

/**
 * 归一化模型给出的 inspect 列表。
 * 宽容一些：允许写字符串（"front"）、允许 { view }、允许 { angle:[az, el] }，
 * 也允许在任意一项上加 focus / zoom；认不出的直接丢掉（而不是整轮报错——
 * 看不成图不该让这次生成失败）。
 */
export function normalizeInspect(raw) {
  const list = Array.isArray(raw) ? raw : typeof raw === 'string' ? [raw] : [];
  const out = [];
  for (const item of list) {
    if (out.length >= MAX_INSPECT_VIEWS) break;
    if (typeof item === 'string') {
      const view = item.trim().toLowerCase();
      if (!PRESET_LABELS[view]) continue;
      out.push({ view, label: PRESET_LABELS[view] });
      continue;
    }
    if (!item || typeof item !== 'object') continue;

    // 取景：只留「真的改变了什么」的字段，默认值不写进 payload（前端好判断要不要特写）
    const rawFocus = typeof item.focus === 'string' ? item.focus.trim().slice(0, MAX_FOCUS_CHARS) : '';
    const zoomValue = num(item.zoom ?? item.scale);
    const zoom = zoomValue === null
      ? 1
      : Math.min(MAX_INSPECT_ZOOM, Math.max(MIN_INSPECT_ZOOM, Math.round(zoomValue * 10) / 10));
    const framing = framingLabel(rawFocus, zoom);

    const view = typeof item.view === 'string' ? item.view.trim().toLowerCase() : '';
    if (PRESET_LABELS[view]) {
      out.push({
        view,
        ...(rawFocus ? { focus: rawFocus } : {}),
        ...(zoom !== 1 ? { zoom } : {}),
        label: framing ? `${PRESET_LABELS[view]} · ${framing}` : PRESET_LABELS[view],
      });
      continue;
    }
    const pair = Array.isArray(item.angle) ? item.angle : null;
    const azimuth = num(item.azimuth ?? item.azimuthDeg ?? pair?.[0]);
    const elevation = num(item.elevation ?? item.elevationDeg ?? pair?.[1]);
    if (azimuth === null || elevation === null) continue;
    const base = angleLabel(azimuth, elevation);
    out.push({
      azimuth: ((azimuth % 360) + 360) % 360,
      // 仰角限制在 ±88°，±90° 时视线与 up 平行，lookAt 会退化
      elevation: Math.max(-88, Math.min(88, elevation)),
      ...(rawFocus ? { focus: rawFocus } : {}),
      ...(zoom !== 1 ? { zoom } : {}),
      label: framing ? `${base} · ${framing}` : base,
    });
  }
  return out;
}

/** 给模型看的一句话说明：它自己请求的视角在实际截图里对应什么 */
export function describeInspect(views) {
  return (Array.isArray(views) ? views : [])
    .map((view, index) => `${index + 1}. ${view.label}${view.view ? `（${view.view}）` : ''}`)
    .join('\n');
}
