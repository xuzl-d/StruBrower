import type { ElementCategory } from './types';

/**
 * 视图配色方案：只影响视口显示，不修改项目里已保存的材质/图层数据，
 * 因此切换即时生效、可反复切换，也不会污染导出与明细表。
 *
 * - project   项目原色：沿用构件自身的材质色 / 图层覆盖色（导入时的颜色）。
 * - revitGray Revit 灰模：中性灰阶，接近 Revit 默认着色视图的真实混凝土观感。
 * - revitSoft Revit 柔和分类色：低饱和、按类别柔和区分，介于灰模与原色之间。
 * - yjk       盈建科结构配色：取自 StruMaterials.xml 的经典结构分类辨识色（梁青/柱黄/墙绿/支撑品红/板灰蓝）。
 */
export type ColorScheme = 'project' | 'revitGray' | 'revitSoft' | 'yjk';

export const COLOR_SCHEME_LABELS: Record<ColorScheme, string> = {
  project: '项目原色',
  revitGray: 'Revit 灰模',
  revitSoft: 'Revit 柔和分类',
  yjk: '盈建科 YJK 结构配色',
};

export const COLOR_SCHEME_HINTS: Record<ColorScheme, string> = {
  project: '沿用构件材质色与图层覆盖色（导入时的配色）',
  revitGray: '中性灰阶，楼板浅灰、梁柱深灰、墙米灰，接近 Revit 默认着色视图',
  revitSoft: '低饱和分类色，楼板暖白、梁青灰、柱蓝灰、墙米色，柔和且有层次',
  yjk: '盈建科 StruMaterials.xml 结构分类色：梁青、柱黄、墙绿、支撑品红、楼板灰蓝',
};

/** 参与配色方案着色的语义构件类别（mesh 导入几何保留自身的顶点色/自定义色）。 */
const SCHEME_CATEGORIES: ReadonlySet<ElementCategory> = new Set<ElementCategory>([
  'wall', 'column', 'beam', 'brace', 'slab',
]);

/**
 * Revit 灰模：中性灰阶。楼板最浅、墙米灰、柱中灰、梁支撑深灰，
 * 明暗分层让结构在灰色视图里依然可辨。
 */
const REVIT_GRAY: Record<Exclude<ElementCategory, 'mesh'>, string> = {
  wall: '#b8b3aa',
  column: '#8d949b',
  beam: '#7a838c',
  brace: '#6e767e',
  slab: '#cfcdc7',
};

/**
 * Revit 柔和分类色：低饱和但按类别区分。
 * 在深蓝灰背景上用偏暖/中性的低饱和色，避免原方案高饱和蓝的塑料感。
 */
const REVIT_SOFT: Record<Exclude<ElementCategory, 'mesh'>, string> = {
  wall: '#d3c6b1',
  column: '#9fb0be',
  beam: '#8ba2b3',
  brace: '#9bb2a6',
  slab: '#dfe1dd',
};

/**
 * 盈建科 YJK 结构配色 —— 严格取自 StruMaterials.xml（Diffuse 颜色）：
 *   结构梁 #2de4ff、结构柱 #ffd964、结构墙 #7ee07e、
 *   混凝土支撑 #ff00ff、yjk楼板 #8e9aa4。
 * 这是 YJK 的经典高饱和分类辨识色，便于按构件类别快速区分。
 */
const YJK_STRUCTURE: Record<Exclude<ElementCategory, 'mesh'>, string> = {
  beam: '#2de4ff',
  column: '#ffd964',
  wall: '#7ee07e',
  brace: '#ff00ff',
  slab: '#8e9aa4',
};

/**
 * 返回该方案下构件类别应使用的颜色；返回 null 表示不覆盖（保留项目原色）。
 * 用户在图层/类别里手动设置的「颜色替换」优先级更高，由调用方先判断 colorLock。
 */
export function schemeColor(scheme: ColorScheme, category: ElementCategory): string | null {
  if (scheme === 'project' || !SCHEME_CATEGORIES.has(category)) return null;
  const palette = scheme === 'revitGray'
    ? REVIT_GRAY
    : scheme === 'yjk'
      ? YJK_STRUCTURE
      : REVIT_SOFT;
  return palette[category as Exclude<ElementCategory, 'mesh'>] ?? null;
}
