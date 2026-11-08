/**
 * 导入总入口：格式分派 + 轴向/单位归一。
 *
 * 分工：
 * - catalog.ts 放「支持哪些格式」的元信息（Ribbon / 拖拽提示用，不含解析器）；
 * - 各格式解析器只出「三角形 + 颜色 + 文件声明的轴向/单位」，并按需动态加载；
 * - 这里负责把解析结果旋到 Z-up、缩到米、合并成一个 MeshInstance 几何。
 *
 * 解析器用动态 import：FBX / COLLADA / glTF 三个 loader 加起来近 600 KB，
 * 不导入模型的项目不应该为它们付启动成本。
 */
import { BufferGeometry, Float32BufferAttribute, Matrix4, Vector3 } from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { disposeParts } from './scene';
import { formatForFile } from './catalog';
import type { ImportContext, ImportedModel, UpAxis } from './types';
import { DEFAULT_IMPORT_COLOR } from './types';

export { IMPORT_ACCEPT, IMPORT_FORMATS, IMPORT_LABELS, formatForFile } from './catalog';
export type { ImportFormatMeta } from './catalog';
export { disposeParts };

type Parser = (data: ArrayBuffer, context: ImportContext) => ImportedModel | Promise<ImportedModel>;

const PARSERS: Record<string, () => Promise<Parser>> = {
  glb: () => import('./gltf').then((module) => module.parseGltf),
  obj: () => import('./obj').then((module) => module.parseObj),
  fbx: () => import('./fbx').then((module) => module.parseFbx),
  dae: () => import('./dae').then((module) => module.parseDae),
  stl: () => import('./stl').then((module) => module.parseStl),
  ply: () => import('./ply').then((module) => module.parsePly),
  off: () => import('./off').then((module) => module.parseOff),
  '3ds': () => import('./tds').then((module) => module.parse3ds),
  '3mf': () => import('./tds').then((module) => module.parse3mf),
  dxf: () => import('./dxf').then((module) => module.parseDxf),
  skp: () => import('./skp').then((module) => module.parseSkp),
};

/** 解析一个文件（不写项目）。name 用于判断格式与生成构件名。 */
export async function parseModelBuffer(
  name: string,
  data: ArrayBuffer,
  resources?: Map<string, string>,
): Promise<ImportedModel> {
  const format = formatForFile(name);
  if (!format) {
    throw new Error(`不支持的文件格式 .${name.split('.').pop() ?? ''}；支持：${Object.keys(PARSERS).join(' / ')}。`);
  }
  const load = PARSERS[format.id];
  if (!load) throw new Error(`格式 ${format.label} 尚未接入解析器。`);
  if (!data.byteLength) throw new Error('文件是空的。');
  const parse = await load();
  const model = await parse(data, { fileName: name, resources });
  if (!model.parts.length && !model.blocked) {
    throw new Error('文件里没有可导入的几何。');
  }
  return model;
}

export interface ImportTransform {
  upAxis: UpAxis;
  /** 1 个文件单位等于多少米 */
  unitMeters: number;
}

/** 无单位格式的启发式：按包围盒最大边猜米/厘米/毫米。 */
export function guessUnitMeters(model: ImportedModel): number {
  if (model.unitMeters && model.unitMeters > 0) return model.unitMeters;
  const size = rawSize(model);
  const longest = Math.max(size.x, size.y, size.z);
  if (longest >= 2000) return 0.001;
  if (longest >= 200) return 0.01;
  return 1;
}

/** 文件里声明的（未换算的）包围盒尺寸。 */
export function rawSize(model: ImportedModel): Vector3 {
  const min = new Vector3(Infinity, Infinity, Infinity);
  const max = new Vector3(-Infinity, -Infinity, -Infinity);
  for (const part of model.parts) {
    const geometry = part.geometry;
    if (!geometry.boundingBox) geometry.computeBoundingBox();
    const bounds = geometry.boundingBox!;
    min.min(bounds.min);
    max.max(bounds.max);
  }
  if (!Number.isFinite(min.x)) return new Vector3();
  return new Vector3(max.x - min.x, max.y - min.y, max.z - min.z);
}

/** 换算到项目空间（Z-up / 米）后的包围盒尺寸，用于对话框里实时预览。 */
export function measureImport(model: ImportedModel, transform: ImportTransform): Vector3 {
  const matrix = importMatrix(transform);
  const min = new Vector3(Infinity, Infinity, Infinity);
  const max = new Vector3(-Infinity, -Infinity, -Infinity);
  const corner = new Vector3();
  for (const part of model.parts) {
    const geometry = part.geometry;
    if (!geometry.boundingBox) geometry.computeBoundingBox();
    const bounds = geometry.boundingBox!;
    for (let i = 0; i < 8; i += 1) {
      corner.set(
        i & 1 ? bounds.max.x : bounds.min.x,
        i & 2 ? bounds.max.y : bounds.min.y,
        i & 4 ? bounds.max.z : bounds.min.z,
      ).applyMatrix4(matrix);
      min.min(corner);
      max.max(corner);
    }
  }
  if (!Number.isFinite(min.x)) return new Vector3();
  return new Vector3(max.x - min.x, max.y - min.y, max.z - min.z);
}

function importMatrix(transform: ImportTransform): Matrix4 {
  const matrix = new Matrix4();
  if (transform.upAxis === 'y') matrix.makeRotationX(Math.PI / 2);
  const scale = transform.unitMeters;
  if (Number.isFinite(scale) && scale > 0 && Math.abs(scale - 1) > 1e-12) {
    matrix.premultiply(new Matrix4().makeScale(scale, scale, scale));
  }
  return matrix;
}

/**
 * 合并所有部件成一个带顶点色的几何（Z-up / 米）。
 * 调用方负责 dispose 返回值。
 */
export function buildImportGeometry(model: ImportedModel, transform: ImportTransform): BufferGeometry {
  const matrix = importMatrix(transform);
  const geometries: BufferGeometry[] = [];
  for (const part of model.parts) {
    const geometry = part.geometry.clone();
    geometry.applyMatrix4(matrix);
    if (!geometry.getAttribute('color')) {
      const tint = parseInt((part.color || DEFAULT_IMPORT_COLOR).replace('#', ''), 16);
      const rgb = [((tint >> 16) & 255) / 255, ((tint >> 8) & 255) / 255, (tint & 255) / 255];
      const count = geometry.getAttribute('position').count;
      const colors = new Float32Array(count * 3);
      for (let i = 0; i < count; i += 1) colors.set(rgb, i * 3);
      geometry.setAttribute('color', new Float32BufferAttribute(colors, 3));
    }
    geometries.push(geometry);
  }
  if (!geometries.length) throw new Error('没有可合并的几何。');
  if (geometries.length === 1) return geometries[0]!;
  const merged = mergeGeometries(geometries, false);
  geometries.forEach((geometry) => geometry.dispose());
  if (merged) return merged;

  // 属性集不一致时退化为逐个累加，保证导入不失败
  const positions: number[] = [];
  const colors: number[] = [];
  for (const part of model.parts) {
    const geometry = part.geometry.clone();
    geometry.applyMatrix4(matrix);
    const position = geometry.getAttribute('position');
    const color = geometry.getAttribute('color');
    const tint = parseInt((part.color || DEFAULT_IMPORT_COLOR).replace('#', ''), 16);
    const fallback = [((tint >> 16) & 255) / 255, ((tint >> 8) & 255) / 255, (tint & 255) / 255];
    for (let i = 0; i < position.count; i += 1) {
      positions.push(position.getX(i), position.getY(i), position.getZ(i));
      if (color) colors.push(color.getX(i), color.getY(i), color.getZ(i));
      else colors.push(fallback[0]!, fallback[1]!, fallback[2]!);
    }
    geometry.dispose();
  }
  const fallbackGeometry = new BufferGeometry();
  fallbackGeometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
  fallbackGeometry.setAttribute('color', new Float32BufferAttribute(colors, 3));
  return fallbackGeometry;
}

export function countImportTriangles(model: ImportedModel): number {
  return model.parts.reduce((sum, part) => sum + Math.floor((part.geometry.getAttribute('position')?.count ?? 0) / 3), 0);
}

export type { ImportedModel, UpAxis };
