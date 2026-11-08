/**
 * OBJ（Wavefront）。
 *
 * 用 three 的 OBJLoader：它处理 v / vn / vt、多边形拆三角、o / g 分组。
 * OBJ 规范没有单位，按米处理；轴向规范上是 Y-up，由导入对话框统一转 Z-up。
 */
import { Group } from 'three';
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js';
import { partsFromObject } from './scene';
import type { ImportedModel } from './types';

export function parseObj(data: ArrayBuffer): ImportedModel {
  const text = new TextDecoder('utf-8').decode(new Uint8Array(data));
  const group: Group = new OBJLoader().parse(text);
  const parts = partsFromObject(group);
  if (!parts.length) throw new Error('OBJ 文件里没有可读取的网格。');
  const notices: string[] = [];
  if (/^(usemtl|mtllib)\b/m.test(text)) {
    notices.push('OBJ 引用的 .mtl 材质文件不会自动加载，已按材质基色 / 默认色显示。');
  }
  return {
    format: 'obj',
    formatLabel: 'OBJ（Wavefront）',
    parts,
    upAxis: 'y',
    unitMeters: 1,
    notices,
  };
}
