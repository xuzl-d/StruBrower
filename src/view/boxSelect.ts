import { Box3, Camera, Vector3 } from 'three';

/** 视口像素坐标（左上角原点）的矩形。 */
export interface ScreenRect {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/** Revit 约定：从左往右拖 = 完全包含；从右往左拖 = 相交。 */
export type BoxSelectionMode = 'window' | 'crossing';

export interface SelectionEntry {
  id: string;
  box: Box3;
}

const CORNER_SIGNS: Array<[number, number, number]> = [
  [0, 0, 0], [1, 0, 0], [0, 1, 0], [1, 1, 0],
  [0, 0, 1], [1, 0, 1], [0, 1, 1], [1, 1, 1],
];

export function rectFromPoints(ax: number, ay: number, bx: number, by: number): ScreenRect {
  return {
    minX: Math.min(ax, bx),
    minY: Math.min(ay, by),
    maxX: Math.max(ax, bx),
    maxY: Math.max(ay, by),
  };
}

export function rectWidth(rect: ScreenRect): number {
  return rect.maxX - rect.minX;
}

export function rectHeight(rect: ScreenRect): number {
  return rect.maxY - rect.minY;
}

/** 把世界坐标包围盒的 8 个角投影到视口像素坐标；完全在相机远侧时返回 null。 */
export function projectBoxToScreen(
  box: Box3,
  camera: Camera,
  viewport: { width: number; height: number },
): ScreenRect | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let visible = false;
  const point = new Vector3();
  for (const [sx, sy, sz] of CORNER_SIGNS) {
    point
      .set(sx ? box.max.x : box.min.x, sy ? box.max.y : box.min.y, sz ? box.max.z : box.min.z)
      .project(camera);
    if (point.z > 1) continue;
    visible = true;
    const x = (point.x * 0.5 + 0.5) * viewport.width;
    const y = (-point.y * 0.5 + 0.5) * viewport.height;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  if (!visible || !Number.isFinite(minX) || !Number.isFinite(minY)) return null;
  return { minX, minY, maxX, maxY };
}

export function rectContains(outer: ScreenRect, inner: ScreenRect, tolerance = 0): boolean {
  return inner.minX >= outer.minX - tolerance
    && inner.maxX <= outer.maxX + tolerance
    && inner.minY >= outer.minY - tolerance
    && inner.maxY <= outer.maxY + tolerance;
}

export function rectIntersects(a: ScreenRect, b: ScreenRect): boolean {
  return a.minX <= b.maxX && a.maxX >= b.minX && a.minY <= b.maxY && a.maxY >= b.minY;
}

const WINDOW_TOLERANCE_PX = 1.5;

export function rectMatches(selection: ScreenRect, target: ScreenRect, mode: BoxSelectionMode): boolean {
  return mode === 'window'
    ? rectContains(selection, target, WINDOW_TOLERANCE_PX)
    : rectIntersects(selection, target);
}

/**
 * 框选：按投影后的包围盒判断构件是否命中。
 * window = 完全包含（左→右），crossing = 相交（右→左）。
 */
export function pickByScreenRect(
  entries: SelectionEntry[],
  camera: Camera,
  viewport: { width: number; height: number },
  rect: ScreenRect,
  mode: BoxSelectionMode,
): string[] {
  const result: string[] = [];
  for (const entry of entries) {
    const projected = projectBoxToScreen(entry.box, camera, viewport);
    if (!projected) continue;
    if (rectMatches(rect, projected, mode)) result.push(entry.id);
  }
  return result;
}
