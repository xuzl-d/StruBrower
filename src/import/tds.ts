/**
 * 3DS（3D Studio）与 3MF（3D Manufacturing Format）。
 *
 * 两者都没有可靠的「单位」字段：3DS 是 Z-up 且单位随建模软件而定；
 * 3MF 规范默认毫米、Z-up，但 unit 属性在外层 zip 的 model XML 里，
 * 这里按规范默认毫米处理，导入对话框可以改。
 */
import { Group } from 'three';
import { TDSLoader } from 'three/examples/jsm/loaders/TDSLoader.js';
import { ThreeMFLoader } from 'three/examples/jsm/loaders/3MFLoader.js';
import { partsFromObject } from './scene';
import type { ImportedModel } from './types';

export function parse3ds(data: ArrayBuffer): ImportedModel {
  const group: Group = new TDSLoader().parse(data, '');
  const parts = partsFromObject(group);
  if (!parts.length) throw new Error('3DS 文件里没有可读取的网格。');
  return {
    format: '3ds',
    formatLabel: '3DS（3D Studio）',
    parts,
    upAxis: 'z',
    unitMeters: null,
    notices: ['3DS 不含单位信息，已按自动判断换算（可在导入前改单位）。'],
  };
}

export function parse3mf(data: ArrayBuffer): ImportedModel {
  const group: Group = new ThreeMFLoader().parse(data);
  const parts = partsFromObject(group);
  if (!parts.length) throw new Error('3MF 文件里没有可读取的网格。');
  return {
    format: '3mf',
    formatLabel: '3MF',
    parts,
    upAxis: 'z',
    unitMeters: 0.001,
    notices: ['3MF 默认以毫米为单位，已按 1:1000 换算成米（可在单位下拉里改）。'],
  };
}
