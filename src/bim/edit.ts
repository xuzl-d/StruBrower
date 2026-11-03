import { createId } from './id';
import type { BimElement, ProjectDocument } from './types';

export interface Translation {
  dx: number;
  dy: number;
  dz?: number;
}

const round = (value: number): number => Math.round(value * 1e6) / 1e6;

/**
 * 平移单个构件：
 * - 墙/柱/板：平面坐标偏移，ΔZ 调整底部/顶部偏移（保持墙高不变）
 * - 导入网格：累计 offset 属性，不重写顶点数组
 */
export function translateElement(element: BimElement, translation: Translation): BimElement {
  const { dx } = translation;
  const { dy } = translation;
  const dz = translation.dz ?? 0;
  if (!dx && !dy && !dz) return element;

  if (element.category === 'wall') {
    return {
      ...element,
      start: [round(element.start[0] + dx), round(element.start[1] + dy)],
      end: [round(element.end[0] + dx), round(element.end[1] + dy)],
      baseOffset: round(element.baseOffset + dz),
      topOffset: round(element.topOffset + dz),
    };
  }
  if (element.category === 'column') {
    return {
      ...element,
      position: [round(element.position[0] + dx), round(element.position[1] + dy)],
      baseOffset: round(element.baseOffset + dz),
    };
  }
  if (element.category === 'slab') {
    return {
      ...element,
      points: element.points.map((point) => [round(point[0] + dx), round(point[1] + dy)] as [number, number]),
      baseOffset: round(element.baseOffset + dz),
    };
  }
  const current = element.offset ?? [0, 0, 0];
  return {
    ...element,
    offset: [round(current[0] + dx), round(current[1] + dy), round(current[2] + dz)],
  };
}

export function translateElements(elements: BimElement[], translation: Translation): BimElement[] {
  return elements.map((element) => translateElement(element, translation));
}

function uniqueName(category: BimElement['category'], used: Set<string>): string {
  const prefix = category === 'wall' ? '墙' : category === 'column' ? '柱' : category === 'slab' ? '楼板' : '构件';
  for (let index = 1; index < 10000; index += 1) {
    const candidate = `${prefix} ${index}`;
    if (!used.has(candidate)) return candidate;
  }
  return `${prefix} ${Date.now()}`;
}

/**
 * 复制构件：生成新 id、自动命名，并按 translation 偏移。
 * 原来的构件不会被修改；导入网格的顶点数组是共享的（不可变数据），只新增 offset。
 */
export function duplicateElements(
  project: ProjectDocument,
  elements: BimElement[],
  translation: Translation = { dx: 1, dy: 0 },
): BimElement[] {
  const used = new Set(project.elements.map((element) => element.name));
  const copies: BimElement[] = [];
  for (const element of elements) {
    const moved = translateElement(element, translation);
    const copy = {
      ...moved,
      id: createId(),
      name: uniqueName(element.category, used),
    } as BimElement;
    used.add(copy.name);
    copies.push(copy);
  }
  return copies;
}

export interface RotateOptions {
  /** 旋转角度（弧度，绕 Z 轴，逆时针为正） */
  angle: number;
  /** 旋转基点（平面坐标） */
  center: [number, number];
}

/** 旋转单个构件：墙/板旋转顶点，柱累加 rotation，导入网格换算 offset + rotation。 */
export function rotateElement(element: BimElement, options: RotateOptions): BimElement {
  const { angle, center } = options;
  if (!angle) return element;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const [cx, cy] = center;
  const rotate = (x: number, y: number): [number, number] => [
    round(cx + (x - cx) * cos - (y - cy) * sin),
    round(cy + (x - cx) * sin + (y - cy) * cos),
  ];

  if (element.category === 'wall') {
    return { ...element, start: rotate(element.start[0], element.start[1]), end: rotate(element.end[0], element.end[1]) };
  }
  if (element.category === 'column') {
    return {
      ...element,
      position: rotate(element.position[0], element.position[1]),
      rotation: round(element.rotation + angle),
    };
  }
  if (element.category === 'slab') {
    return { ...element, points: element.points.map(([x, y]) => rotate(x, y)) };
  }
  const offset = element.offset ?? [0, 0, 0];
  const ox = offset[0] - cx;
  const oy = offset[1] - cy;
  return {
    ...element,
    offset: [round(cx + ox * cos - oy * sin), round(cy + ox * sin + oy * cos), offset[2]],
    rotation: round((element.rotation ?? 0) + angle),
  };
}

export interface MirrorOptions {
  /** vertical：关于直线 x = position 镜像；horizontal：关于直线 y = position */
  axis: 'vertical' | 'horizontal';
  position: number;
}

/** 镜像：墙/柱/板支持；导入网格需要翻转几何，暂不支持（调用方应跳过并提示）。 */
export function mirrorElement(element: BimElement, options: MirrorOptions): BimElement {
  const { axis, position } = options;
  if (element.category === 'mesh') {
    throw new Error('导入网格暂不支持镜像');
  }
  const map = (x: number, y: number): [number, number] => (
    axis === 'vertical' ? [round(2 * position - x), round(y)] : [round(x), round(2 * position - y)]
  );

  if (element.category === 'wall') {
    return { ...element, start: map(element.start[0], element.start[1]), end: map(element.end[0], element.end[1]) };
  }
  if (element.category === 'column') {
    const [x, y] = map(element.position[0], element.position[1]);
    return {
      ...element,
      position: [x, y],
      rotation: round(axis === 'vertical' ? Math.PI - element.rotation : -element.rotation),
    };
  }
  return { ...element, points: element.points.map(([x, y]) => map(x, y)) };
}

/** 选中构件的近似中心，用作旋转/环形阵列的默认基点。 */
export function selectionCenter(elements: BimElement[]): [number, number] {
  const points: Array<[number, number]> = [];
  for (const element of elements) {
    if (element.category === 'wall') {
      points.push([(element.start[0] + element.end[0]) / 2, (element.start[1] + element.end[1]) / 2]);
    } else if (element.category === 'column') {
      points.push(element.position);
    } else if (element.category === 'slab') {
      for (const point of element.points) points.push(point);
    } else {
      const offset = element.offset ?? [0, 0, 0];
      points.push([offset[0], offset[1]]);
    }
  }
  if (!points.length) return [0, 0];
  const sx = points.reduce((sum, point) => sum + point[0], 0) / points.length;
  const sy = points.reduce((sum, point) => sum + point[1], 0) / points.length;
  return [round(sx), round(sy)];
}

export type ArrayOptions =
  | { mode: 'linear'; count: number; dx: number; dy: number }
  | { mode: 'polar'; count: number; totalAngleDeg: number; center: [number, number] };

/**
 * 阵列：在原件基础上生成 count-1 个副本。
 * - linear：每个副本相对原件偏移 i × (dx, dy)
 * - polar：绕 center 旋转，总角度 360° 时按 count 等分，否则包含末端
 */
export function arrayElements(
  project: ProjectDocument,
  elements: BimElement[],
  options: ArrayOptions,
): BimElement[] {
  const count = Math.max(2, Math.min(200, Math.round(options.count)));
  const used = new Set(project.elements.map((element) => element.name));
  const copies: BimElement[] = [];

  for (let index = 1; index < count; index += 1) {
    for (const element of elements) {
      let copy: BimElement;
      if (options.mode === 'linear') {
        copy = translateElement(element, { dx: options.dx * index, dy: options.dy * index });
      } else {
        const total = options.totalAngleDeg;
        const step = Math.abs(total) >= 359.9 ? total / count : total / (count - 1);
        copy = rotateElement(element, {
          angle: (step * index * Math.PI) / 180,
          center: options.center,
        });
      }
      const named = { ...copy, id: createId(), name: uniqueName(element.category, used) } as BimElement;
      used.add(named.name);
      copies.push(named);
    }
  }
  return copies;
}
