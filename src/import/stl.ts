/**
 * STL（二进制 / ASCII）。
 *
 * STL 没有单位也没有轴向声明，工程上按 Z-up、单位交给启发式判断；
 * 导入对话框里可以改成 Y-up / 毫米，所以这里不做任何猜测。
 */
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';
import { partsFromObject } from './scene';
import type { ImportContext, ImportedModel } from './types';
import { DEFAULT_IMPORT_COLOR } from './types';
import { Mesh } from 'three';

export function parseStl(data: ArrayBuffer, context: ImportContext): ImportedModel {
  const geometry = new STLLoader().parse(data);
  if (!geometry.getAttribute('position')?.count) {
    geometry.dispose();
    throw new Error('STL 文件里没有三角形（可能是空文件或只有顶点没有面）。');
  }
  const name = context.fileName.replace(/\.stl$/i, '') || 'STL 模型';
  const mesh = new Mesh(geometry);
  mesh.name = name;
  const parts = partsFromObject(mesh);
  geometry.dispose();
  return {
    format: 'stl',
    formatLabel: 'STL',
    parts,
    upAxis: 'z',
    unitMeters: null,
    notices: [`STL 不含单位与材质信息，已按默认色 ${DEFAULT_IMPORT_COLOR} 着色。`],
  };
}
