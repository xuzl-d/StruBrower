/**
 * 软件设置（视图与交互偏好）：保存在浏览器 localStorage，按用户/设备生效。
 * 不依赖服务端，本地模式同样可用；颜色统一用 #RRGGBB。
 */
export interface ViewSettings {
  /** 选中构件的高亮色 */
  highlightColor: string;
  /** 视口背景色 */
  backgroundColor: string;
  /** 轴网线颜色 */
  gridColor: string;
  /** 轴网端部气泡颜色 */
  bubbleColor: string;
  /** 地面参考网格 */
  showGroundGrid: boolean;
  /** 当前标高的工作面网格 */
  showLevelGrid: boolean;
  /** 轴网线 */
  showGrids: boolean;
  /** 轴网名称气泡 */
  showBubbles: boolean;
  /** 左下角坐标轴指示器 */
  showAxisIndicator: boolean;
  /** 底部光标坐标 */
  showCoordinates: boolean;
  /** 底部构件数与三角面统计 */
  showStats: boolean;
  /** 对象捕捉（端点/中点/交点） */
  objectSnap: boolean;
  /** 网格吸附（按 snapStep 取整） */
  gridSnap: boolean;
  /** 旋转惯性：松开鼠标后是否继续减速滑动 */
  rotateDamping: boolean;
  /** 渲染分辨率倍率（相对设备像素比），0.5 / 0.75 / 1 / 1.5 */
  renderScale: number;
  /** 界面字号倍率，0.9 / 1 / 1.1 / 1.25 / 1.4 */
  uiFontScale: number;
  /** 绘制吸附步长（米） */
  snapStep: number;
}

export const SNAP_STEPS = [0.01, 0.05, 0.1, 0.25, 0.5, 1] as const;

export const RENDER_SCALES = [0.5, 0.75, 1, 1.5] as const;

export const FONT_SCALES = [0.9, 1, 1.1, 1.25, 1.4] as const;

export const SETTINGS_STORAGE_KEY = 'strubrowser.settings.v1';

export const DEFAULT_VIEW_SETTINGS: ViewSettings = {
  highlightColor: '#2563eb',
  backgroundColor: '#0e1622',
  gridColor: '#68d3c1',
  bubbleColor: '#68d3c1',
  showGroundGrid: true,
  showLevelGrid: true,
  showGrids: true,
  showBubbles: true,
  showAxisIndicator: true,
  showCoordinates: true,
  showStats: true,
  objectSnap: true,
  gridSnap: true,
  rotateDamping: true,
  renderScale: 1,
  uiFontScale: 1,
  snapStep: 0.1,
};

const HEX_COLOR = /^#[0-9a-f]{6}$/i;

type StorageLike = Pick<Storage, 'getItem' | 'setItem'>;

function defaultStorage(): StorageLike | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

function color(value: unknown, fallback: string): string {
  return typeof value === 'string' && HEX_COLOR.test(value) ? value.toLowerCase() : fallback;
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function snap(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return SNAP_STEPS.includes(parsed as (typeof SNAP_STEPS)[number]) ? parsed : fallback;
}

/** 把任意输入归一化为合法设置，非法字段回退默认值。 */
export function normalizeViewSettings(input: unknown): ViewSettings {
  const source = input && typeof input === 'object' ? input as Record<string, unknown> : {};
  return {
    highlightColor: color(source.highlightColor, DEFAULT_VIEW_SETTINGS.highlightColor),
    backgroundColor: color(source.backgroundColor, DEFAULT_VIEW_SETTINGS.backgroundColor),
    gridColor: color(source.gridColor, DEFAULT_VIEW_SETTINGS.gridColor),
    bubbleColor: color(source.bubbleColor, DEFAULT_VIEW_SETTINGS.bubbleColor),
    showGroundGrid: bool(source.showGroundGrid, DEFAULT_VIEW_SETTINGS.showGroundGrid),
    showLevelGrid: bool(source.showLevelGrid, DEFAULT_VIEW_SETTINGS.showLevelGrid),
    showGrids: bool(source.showGrids, DEFAULT_VIEW_SETTINGS.showGrids),
    showBubbles: bool(source.showBubbles, DEFAULT_VIEW_SETTINGS.showBubbles),
    showAxisIndicator: bool(source.showAxisIndicator, DEFAULT_VIEW_SETTINGS.showAxisIndicator),
    showCoordinates: bool(source.showCoordinates, DEFAULT_VIEW_SETTINGS.showCoordinates),
    showStats: bool(source.showStats, DEFAULT_VIEW_SETTINGS.showStats),
    objectSnap: bool(source.objectSnap, DEFAULT_VIEW_SETTINGS.objectSnap),
    gridSnap: bool(source.gridSnap, DEFAULT_VIEW_SETTINGS.gridSnap),
    rotateDamping: bool(source.rotateDamping, DEFAULT_VIEW_SETTINGS.rotateDamping),
    renderScale: RENDER_SCALES.includes(Number(source.renderScale) as (typeof RENDER_SCALES)[number])
      ? Number(source.renderScale)
      : DEFAULT_VIEW_SETTINGS.renderScale,
    uiFontScale: FONT_SCALES.includes(Number(source.uiFontScale) as (typeof FONT_SCALES)[number])
      ? Number(source.uiFontScale)
      : DEFAULT_VIEW_SETTINGS.uiFontScale,
    snapStep: snap(source.snapStep, DEFAULT_VIEW_SETTINGS.snapStep),
  };
}

export function loadViewSettings(storage: StorageLike | null = defaultStorage()): ViewSettings {
  if (!storage) return { ...DEFAULT_VIEW_SETTINGS };
  try {
    const raw = storage.getItem(SETTINGS_STORAGE_KEY);
    if (!raw) return { ...DEFAULT_VIEW_SETTINGS };
    return normalizeViewSettings(JSON.parse(raw));
  } catch {
    return { ...DEFAULT_VIEW_SETTINGS };
  }
}

export function saveViewSettings(
  settings: ViewSettings,
  storage: StorageLike | null = defaultStorage(),
): void {
  if (!storage) return;
  try {
    storage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(normalizeViewSettings(settings)));
  } catch {
    // 忽略隐私模式 / 配额错误
  }
}
