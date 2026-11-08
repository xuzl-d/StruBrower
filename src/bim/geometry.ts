import {
  BoxGeometry,
  BufferGeometry,
  ExtrudeGeometry,
  Float32BufferAttribute,
  Matrix4,
  Mesh,
  Shape,
} from 'three';
import { CSG } from 'three-csg-ts';
import {
  baseElevation,
  columnTypeOf,
  elementHeight,
  slabTypeOf,
  wallLength,
  wallTypeOf,
} from './document';
import { buildPrimitiveModel } from './primitives';
import { solidPrimitiveOf } from './parametric';
import { createId } from './id';
import type { BimElement, MeshInstance, ProjectDocument, SolidMaterial } from './types';

/** 构件几何 + 逐特征材质（特征实体才有材质表，其余为空数组） */
export interface ElementModel {
  geometry: BufferGeometry;
  /** null 表示该分组跟随构件材质（材质浏览器指派的那个） */
  materials: Array<SolidMaterial | null>;
}

/** 镜像（负行列式）后翻转三角形绕序，避免背面被剔除。 */
function flipGeometryWinding(geometry: BufferGeometry): void {
  const index = geometry.index;
  if (index) {
    for (let i = 0; i + 2 < index.count; i += 3) {
      const second = index.getX(i + 1);
      index.setX(i + 1, index.getX(i + 2));
      index.setX(i + 2, second);
    }
    index.needsUpdate = true;
    return;
  }
  for (const attribute of Object.values(geometry.attributes)) {
    const array = attribute.array as Float32Array;
    const size = attribute.itemSize;
    for (let vertex = 0; vertex + 2 < attribute.count; vertex += 3) {
      const a = (vertex + 1) * size;
      const b = (vertex + 2) * size;
      for (let component = 0; component < size; component += 1) {
        const temp = array[a + component]!;
        array[a + component] = array[b + component]!;
        array[b + component] = temp;
      }
    }
    attribute.needsUpdate = true;
  }
}

/**
 * 按参数生成构件几何（世界坐标，Z-up，单位米）。
 * 参数非法时返回 null，由调用方跳过渲染。
 */
export function buildElementGeometry(project: ProjectDocument, element: BimElement): BufferGeometry | null {
  return buildElementModel(project, element)?.geometry ?? null;
}

/** 几何 + 材质：特征实体带逐零件材质，视口用它建多材质网格 */
export function buildElementModel(project: ProjectDocument, element: BimElement): ElementModel | null {
  if (element.category === 'wall') {
    const type = wallTypeOf(project, element);
    const length = wallLength(element);
    const height = elementHeight(project, element);
    if (!type || length < 0.01 || height < 0.01 || type.thickness <= 0) return null;
    const geometry = new BoxGeometry(length, type.thickness, height);
    const angle = Math.atan2(element.end[1] - element.start[1], element.end[0] - element.start[0]);
    geometry.rotateZ(angle);
    geometry.translate(
      (element.start[0] + element.end[0]) / 2,
      (element.start[1] + element.end[1]) / 2,
      baseElevation(project, element) + height / 2,
    );
    return { geometry, materials: [] };
  }

  if (element.category === 'column') {
    const type = columnTypeOf(project, element);
    const height = elementHeight(project, element);
    if (!type || height < 0.01 || type.width <= 0 || type.depth <= 0) return null;
    const geometry = new BoxGeometry(type.width, type.depth, height);
    if (element.rotation) geometry.rotateZ(element.rotation);
    geometry.translate(element.position[0], element.position[1], baseElevation(project, element) + height / 2);
    return { geometry, materials: [] };
  }

  if (element.category === 'slab') {
    const type = slabTypeOf(project, element);
    if (!type || type.thickness <= 0 || element.points.length < 3) return null;
    const shape = new Shape();
    element.points.forEach(([x, y], index) => {
      if (index === 0) shape.moveTo(x, y);
      else shape.lineTo(x, y);
    });
    shape.closePath();
    const geometry = new ExtrudeGeometry(shape, { depth: type.thickness, bevelEnabled: false, curveSegments: 1 });
    geometry.translate(0, 0, baseElevation(project, element));
    return { geometry, materials: [] };
  }

  let geometry: BufferGeometry;
  let materials: Array<SolidMaterial | null> = [];
  const positionCount = element.positions.length / 3;
  // 参数化构件在这里按参数重建特征树：文档里存的是 `{ template, params }`，
  // 因此改一个参数（哪怕是通过 element.formulas 联动写入的）会自动反映到几何上。
  const primitive = element.parametric ? solidPrimitiveOf(element) : element.primitive;
  if (primitive) {
    const model = buildPrimitiveModel(primitive);
    geometry = model.geometry;
    materials = model.materials;
  } else {
    if (positionCount < 3 || element.indices.length < 3) return null;
    geometry = new BufferGeometry();
    geometry.setAttribute('position', new Float32BufferAttribute(element.positions, 3));
    geometry.setIndex(element.indices);
    if (element.vertexColors?.length === element.positions.length) {
      geometry.setAttribute('color', new Float32BufferAttribute(element.vertexColors, 3));
    }
  }

  // 变换顺序与文档语义一致：局部镜像 → 缩放 → 绕 Z 旋转 → 平移
  if (element.flip) {
    geometry.scale(1, -1, 1);
    flipGeometryWinding(geometry);
  }
  if (element.scale && Math.abs(element.scale - 1) > 1e-9) geometry.scale(element.scale, element.scale, element.scale);
  // 参数化体量跟随标高（导入网格按既有约定居中、贴地）
  if (primitive) geometry.translate(0, 0, baseElevation(project, element));
  // 只补缺失的法线：造型特征自带平滑法线（圆角/放样/回转），无条件重算会把曲面压成面片
  if (!geometry.getAttribute('normal')) geometry.computeVertexNormals();
  if (element.rotation) geometry.rotateZ(element.rotation);
  if (element.offset) geometry.translate(element.offset[0], element.offset[1], element.offset[2]);
  geometry.computeBoundingSphere();
  return { geometry, materials };
}

/** 从任意几何生成可持久化的导入构件（Z-up）。 */
export function meshElementFromGeometry(
  geometry: BufferGeometry,
  options: { name: string; color: string; levelId: string; source: string },
): MeshInstance {
  const normalized = normalizeImportedGeometry(geometry);
  const position = normalized.getAttribute('position');
  const colors = normalized.getAttribute('color');
  const index = normalized.index
    ? Array.from(normalized.index.array)
    : Array.from({ length: position.count }, (_, value) => value);
  const element: MeshInstance = {
    id: createId(),
    name: options.name,
    category: 'mesh',
    levelId: options.levelId,
    typeId: '',
    visible: true,
    positions: Array.from(position.array),
    indices: index,
    color: options.color,
    source: options.source,
    ...(colors ? { vertexColors: Array.from(colors.array) } : {}),
  };
  normalized.dispose();
  return element;
}

/** 导入几何归一化：居中到 XY、底面贴 0，保持 Z-up。 */
export function normalizeImportedGeometry(geometry: BufferGeometry): BufferGeometry {
  const normalized = geometry.clone();
  normalized.computeBoundingBox();
  const bounds = normalized.boundingBox;
  if (!bounds) {
    normalized.dispose();
    throw new Error('导入模型没有有效的空间范围。');
  }
  const centerX = (bounds.min.x + bounds.max.x) / 2;
  const centerY = (bounds.min.y + bounds.max.y) / 2;
  normalized.translate(-centerX, -centerY, -bounds.min.z);
  if (!normalized.getAttribute('normal')) normalized.computeVertexNormals();
  normalized.computeBoundingSphere();
  return normalized;
}

/** 两个构件做布尔运算，结果作为导入几何保存。 */
export function booleanElement(
  project: ProjectDocument,
  first: BimElement,
  second: BimElement,
  operation: 'union' | 'subtract' | 'intersect',
): MeshInstance {
  const firstGeometry = buildElementGeometry(project, first);
  const secondGeometry = buildElementGeometry(project, second);
  if (!firstGeometry || !secondGeometry) {
    firstGeometry?.dispose();
    secondGeometry?.dispose();
    throw new Error('选中的构件缺少有效几何。');
  }
  const firstMesh = new Mesh(firstGeometry);
  const secondMesh = new Mesh(secondGeometry);
  firstMesh.updateMatrix();
  secondMesh.updateMatrix();
  const firstSolid = CSG.fromMesh(firstMesh);
  const secondSolid = CSG.fromMesh(secondMesh);
  const result = operation === 'union'
    ? firstSolid.union(secondSolid)
    : operation === 'subtract'
      ? firstSolid.subtract(secondSolid)
      : firstSolid.intersect(secondSolid);
  const output = CSG.toMesh(result, firstMesh.matrix);
  firstGeometry.dispose();
  secondGeometry.dispose();
  const label = operation === 'union' ? '并集' : operation === 'subtract' ? '差集' : '交集';
  const element = meshElementFromGeometry(output.geometry, {
    name: `${first.name} ${label} ${second.name}`,
    color: '#a8b3c1',
    levelId: first.levelId,
    source: `布尔${label}`,
  });
  output.geometry.dispose();
  return element;
}

/** 导出 OBJ（OBJ 习惯 Y-up，导出前把 Z-up 几何旋转到 Y-up）。 */
export function exportObj(project: ProjectDocument): string {
  const lines: string[] = [];
  const toObjSpace = new Matrix4().makeRotationX(-Math.PI / 2);
  let vertexOffset = 1;
  for (const element of project.elements) {
    if (!element.visible) continue;
    const geometry = buildElementGeometry(project, element);
    if (!geometry) continue;
    geometry.applyMatrix4(toObjSpace);
    const position = geometry.getAttribute('position');
    const index = geometry.index;
    lines.push(`o ${element.name.replace(/\s+/g, '_')}`);
    for (let i = 0; i < position.count; i += 1) {
      lines.push(`v ${position.getX(i)} ${position.getY(i)} ${position.getZ(i)}`);
    }
    if (index) {
      for (let i = 0; i < index.count; i += 3) {
        lines.push(`f ${index.getX(i) + vertexOffset} ${index.getX(i + 1) + vertexOffset} ${index.getX(i + 2) + vertexOffset}`);
      }
      vertexOffset += position.count;
    } else {
      for (let i = 0; i < position.count; i += 3) {
        lines.push(`f ${i + vertexOffset} ${i + 1 + vertexOffset} ${i + 2 + vertexOffset}`);
      }
      vertexOffset += position.count;
    }
    geometry.dispose();
  }
  return `${lines.join('\n')}\n`;
}
