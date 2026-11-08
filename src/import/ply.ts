/**
 * PLY（ascii / binary_little_endian / binary_big_endian）。
 *
 * 扫描件常带顶点色，PLYLoader 会把它们读成 color 属性，scene.ts 会原样保留。
 * PLY 没有轴向约定，默认按图形学惯例 Y-up，可在导入对话框切到 Z-up。
 */
import { Mesh } from 'three';
import { PLYLoader } from 'three/examples/jsm/loaders/PLYLoader.js';
import { partsFromObject } from './scene';
import type { ImportContext, ImportedModel } from './types';

export function parsePly(data: ArrayBuffer, context: ImportContext): ImportedModel {
  const geometry = new PLYLoader().parse(data);
  if (!geometry.getAttribute('position')?.count) {
    geometry.dispose();
    throw new Error('PLY 文件里没有顶点数据。');
  }
  if (geometry.index?.count === 0) {
    geometry.dispose();
    throw new Error('这是一个点云 PLY（只有顶点没有面），暂不支持以点云形式导入。');
  }
  const mesh = new Mesh(geometry);
  mesh.name = context.fileName.replace(/\.ply$/i, '') || 'PLY 模型';
  const parts = partsFromObject(mesh);
  geometry.dispose();
  if (!parts.length) throw new Error('PLY 文件里没有可读取的面。');
  const notices: string[] = [];
  if (parts.some((part) => part.geometry.getAttribute('color'))) {
    notices.push('已读取顶点色。');
  }
  return {
    format: 'ply',
    formatLabel: 'PLY',
    parts,
    upAxis: 'y',
    unitMeters: null,
    notices,
  };
}
