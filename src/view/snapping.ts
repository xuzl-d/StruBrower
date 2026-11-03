/**
 * 对象捕捉（OSNAP）：端点 / 中点 / 交点。
 * 纯计算，不依赖 three.js，便于单测；视口负责把候选点投影到屏幕并按像素距离挑选。
 */
import type { ProjectDocument } from '../bim/types';

export type SnapKind = 'endpoint' | 'midpoint' | 'intersection';

export interface SnapCandidate {
  point: [number, number];
  kind: SnapKind;
}

export const SNAP_LABELS: Record<SnapKind, string> = {
  endpoint: '端点',
  midpoint: '中点',
  intersection: '交点',
};

export const SNAP_PRIORITY: Record<SnapKind, number> = {
  endpoint: 3,
  intersection: 2,
  midpoint: 1,
};

type Segment = [number, number, number, number];

const round = (value: number): number => Math.round(value * 1e6) / 1e6;

function segmentIntersection(a: Segment, b: Segment): [number, number] | null {
  const [ax, ay, bx, by] = a;
  const [cx, cy, dx, dy] = b;
  const rx = bx - ax;
  const ry = by - ay;
  const sx = dx - cx;
  const sy = dy - cy;
  const denominator = rx * sy - ry * sx;
  if (Math.abs(denominator) < 1e-9) return null;
  const qpx = cx - ax;
  const qpy = cy - ay;
  const t = (qpx * sy - qpy * sx) / denominator;
  const u = (qpx * ry - qpy * rx) / denominator;
  if (t < -1e-9 || t > 1 + 1e-9 || u < -1e-9 || u > 1 + 1e-9) return null;
  return [round(ax + rx * t), round(ay + ry * t)];
}

/** 从文档生成捕捉候选点（墙、板、柱、轴网的端点/中点/交点）。 */
export function buildSnapCandidates(document: ProjectDocument): SnapCandidate[] {
  const candidates: SnapCandidate[] = [];
  const segments: Segment[] = [];
  const typeById = new Map(document.types.map((type) => [type.id, type]));

  const add = (x: number, y: number, kind: SnapKind) => {
    candidates.push({ point: [round(x), round(y)], kind });
  };
  const addSegment = (x1: number, y1: number, x2: number, y2: number) => {
    segments.push([x1, y1, x2, y2]);
    add(x1, y1, 'endpoint');
    add(x2, y2, 'endpoint');
    add((x1 + x2) / 2, (y1 + y2) / 2, 'midpoint');
  };

  for (const element of document.elements) {
    if (element.category === 'wall') {
      addSegment(element.start[0], element.start[1], element.end[0], element.end[1]);
      continue;
    }
    if (element.category === 'slab') {
      const points = element.points;
      for (let index = 0; index < points.length; index += 1) {
        const current = points[index];
        const next = points[(index + 1) % points.length];
        addSegment(current[0], current[1], next[0], next[1]);
      }
      continue;
    }
    if (element.category === 'column') {
      const type = typeById.get(element.typeId);
      const width = (type && 'width' in type ? type.width : 0.4) || 0.4;
      const depth = (type && 'depth' in type ? type.depth : 0.4) || 0.4;
      const rotation = element.rotation || 0;
      const cos = Math.cos(rotation);
      const sin = Math.sin(rotation);
      const hw = width / 2;
      const hd = depth / 2;
      const corners: Array<[number, number]> = [
        [-hw, -hd],
        [hw, -hd],
        [hw, hd],
        [-hw, hd],
      ];
      for (const [lx, ly] of corners) {
        add(element.position[0] + lx * cos - ly * sin, element.position[1] + lx * sin + ly * cos, 'endpoint');
      }
      add(element.position[0], element.position[1], 'midpoint');
    }
  }

  for (const grid of document.grids) {
    addSegment(grid.start[0], grid.start[1], grid.end[0], grid.end[1]);
  }

  const maxSegments = Math.min(segments.length, 120);
  for (let i = 0; i < maxSegments; i += 1) {
    for (let j = i + 1; j < maxSegments; j += 1) {
      const intersection = segmentIntersection(segments[i], segments[j]);
      if (intersection) add(intersection[0], intersection[1], 'intersection');
    }
  }

  // 去重：同一点保留优先级最高的捕捉类型
  const deduped = new Map<string, SnapCandidate>();
  for (const candidate of candidates) {
    const key = `${candidate.point[0].toFixed(3)},${candidate.point[1].toFixed(3)}`;
    const existing = deduped.get(key);
    if (!existing || SNAP_PRIORITY[candidate.kind] > SNAP_PRIORITY[existing.kind]) {
      deduped.set(key, candidate);
    }
  }
  return [...deduped.values()].slice(0, 2000);
}

/** 在候选点中挑屏幕距离最近、且优先级最高的一个。 */
export function pickSnapCandidate(
  candidates: SnapCandidate[],
  screenOf: (point: [number, number]) => { x: number; y: number } | null,
  pointer: { x: number; y: number },
  radiusPx = 14,
): { candidate: SnapCandidate; screen: { x: number; y: number }; distance: number } | null {
  let best: { candidate: SnapCandidate; screen: { x: number; y: number }; distance: number } | null = null;
  for (const candidate of candidates) {
    const screen = screenOf(candidate.point);
    if (!screen) continue;
    const distance = Math.hypot(screen.x - pointer.x, screen.y - pointer.y);
    if (distance > radiusPx) continue;
    if (!best) {
      best = { candidate, screen, distance };
      continue;
    }
    const priority = SNAP_PRIORITY[candidate.kind];
    const bestPriority = SNAP_PRIORITY[best.candidate.kind];
    if (priority > bestPriority || (priority === bestPriority && distance < best.distance)) {
      best = { candidate, screen, distance };
    }
  }
  return best;
}
