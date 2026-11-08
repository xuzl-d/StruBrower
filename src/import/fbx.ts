/**
 * FBX（二进制 / ASCII）。
 *
 * FBXLoader 只负责几何与节点变换，不读 GlobalSettings，所以轴向与单位要自己补：
 * - GlobalSettings.Properties70 里的 `UpAxis`（1=Y，2=Z）；
 * - `UnitScaleFactor`：FBX 内部以厘米为基准，1 表示 1 单位 = 1 cm，100 表示 1 单位 = 1 m。
 *
 * 这里实现的是「只读几项全局设置」的轻量节点解析，不碰几何：
 * 二进制按 EndOffset 逐节点前进；ASCII 直接正则找 P 记录。
 */
import { Group } from 'three';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';
import { partsFromObject } from './scene';
import type { ImportedModel } from './types';

interface FbxSettings {
  upAxis: 'y' | 'z';
  /** 1 单位等于多少米 */
  unitMeters: number;
}

const DEFAULT_SETTINGS: FbxSettings = { upAxis: 'y', unitMeters: 0.01 };

function isBinary(bytes: Uint8Array): boolean {
  const head = new TextDecoder('latin1').decode(bytes.subarray(0, 18));
  return head.startsWith('Kaydara FBX Binary');
}

/** 二进制 FBX 的节点：宽偏移（7.5 起用 64 位）与属性表。 */
interface FbxNode {
  name: string;
  props: Array<string | number | null>;
  children: FbxNode[];
}

function readBinarySettings(bytes: Uint8Array): FbxSettings {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const version = view.getUint32(23, true);
  const wide = version >= 7500;

  const readProperty = (offset: number): { value: string | number | null; next: number } => {
    const type = String.fromCharCode(view.getUint8(offset));
    let cursor = offset + 1;
    switch (type) {
      case 'Y': return { value: view.getInt16(cursor, true), next: cursor + 2 };
      case 'C': return { value: view.getUint8(cursor), next: cursor + 1 };
      case 'I': return { value: view.getInt32(cursor, true), next: cursor + 4 };
      case 'F': return { value: view.getFloat32(cursor, true), next: cursor + 4 };
      case 'D': return { value: view.getFloat64(cursor, true), next: cursor + 8 };
      case 'L': return { value: Number(view.getBigInt64(cursor, true)), next: cursor + 8 };
      case 'S':
      case 'R': {
        const length = view.getUint32(cursor, true);
        cursor += 4;
        const raw = bytes.subarray(cursor, cursor + length);
        return { value: type === 'S' ? new TextDecoder('utf-8').decode(raw) : null, next: cursor + length };
      }
      case 'f': case 'd': case 'l': case 'i': case 'b': {
        // 数组：ArrayLength + Encoding + CompressedLength，内容对我们无用，整体跳过
        const length = view.getUint32(cursor, true);
        const encoding = view.getUint32(cursor + 4, true);
        const compressed = view.getUint32(cursor + 8, true);
        cursor += 12;
        const size = encoding === 1 ? compressed : length * (type === 'd' || type === 'l' ? 8 : type === 'f' || type === 'i' ? 4 : 1);
        return { value: null, next: cursor + size };
      }
      default:
        throw new Error(`未知的 FBX 属性类型 ${type}`);
    }
  };

  const readNode = (offset: number): { node: FbxNode | null; next: number } => {
    const headerSize = wide ? 25 : 13;
    if (offset + headerSize > bytes.byteLength) return { node: null, next: bytes.byteLength };
    const endOffset = wide ? Number(view.getBigUint64(offset, true)) : view.getUint32(offset, true);
    const propertyCount = wide ? Number(view.getBigUint64(offset + 8, true)) : view.getUint32(offset + 8, true);
    const nameLength = view.getUint8(offset + (wide ? 24 : 12));
    if (endOffset === 0) return { node: null, next: offset + headerSize };
    let cursor = offset + headerSize + nameLength;
    const name = new TextDecoder('utf-8').decode(bytes.subarray(offset + headerSize, cursor));
    const props: Array<string | number | null> = [];
    for (let i = 0; i < propertyCount; i += 1) {
      const property = readProperty(cursor);
      props.push(property.value);
      cursor = property.next;
    }
    const children: FbxNode[] = [];
    while (cursor < endOffset) {
      const child = readNode(cursor);
      if (!child.node) break;
      children.push(child.node);
      if (child.next <= cursor) break;
      cursor = child.next;
    }
    return { node: { name, props, children }, next: endOffset };
  };

  const settings: FbxSettings = { ...DEFAULT_SETTINGS };
  const visit = (node: FbxNode) => {
    if (node.name === 'UpAxis') {
      const axis = Number(node.props[0]);
      if (axis === 1) settings.upAxis = 'y';
      if (axis === 2) settings.upAxis = 'z';
    }
    if (node.name === 'UnitScaleFactor') {
      const factor = Number(node.props[0]);
      if (Number.isFinite(factor) && factor > 0) settings.unitMeters = factor / 100;
    }
    node.children.forEach(visit);
  };
  // GlobalSettings 一定在根层级，只需要遍历顶层两三层
  let offset = 27;
  while (offset < bytes.byteLength) {
    const { node, next } = readNode(offset);
    if (!node) break;
    if (node.name === 'GlobalSettings') visit(node);
    if (next <= offset) break;
    offset = next;
  }
  return settings;
}

function readAsciiSettings(text: string): FbxSettings {
  const read = (key: string): number | null => {
    const pattern = new RegExp(`P:\\s*"${key}"[^\\n]*?,\\s*(-?[0-9.]+)\\s*$`, 'm');
    const value = pattern.exec(text)?.[1];
    return value === undefined ? null : Number(value);
  };
  const axis = read('UpAxis');
  const unit = read('UnitScaleFactor');
  return {
    upAxis: axis === 2 ? 'z' : 'y',
    unitMeters: unit && unit > 0 ? unit / 100 : DEFAULT_SETTINGS.unitMeters,
  };
}

export function parseFbx(data: ArrayBuffer): ImportedModel {
  const bytes = new Uint8Array(data);
  let settings = DEFAULT_SETTINGS;
  try {
    settings = isBinary(bytes)
      ? readBinarySettings(bytes)
      : readAsciiSettings(new TextDecoder('utf-8').decode(bytes));
  } catch (error) {
    console.warn('FBX 全局设置读取失败，按 Y-up / 厘米处理。', error);
  }
  const binary = isBinary(bytes);
  const group: Group = new FBXLoader().parse(data, '');
  const parts = partsFromObject(group);
  if (!parts.length) throw new Error('FBX 文件里没有可读取的网格。');
  const notices: string[] = [];
  if (!binary) notices.push('ASCII FBX 的解析较慢，建议导出为二进制 FBX。');
  if (settings.unitMeters !== 0.01) {
    notices.push(`按文件内的 UnitScaleFactor 换算：1 单位 = ${settings.unitMeters} 米。`);
  }
  return {
    format: 'fbx',
    formatLabel: binary ? 'FBX（二进制）' : 'FBX（ASCII）',
    parts,
    upAxis: settings.upAxis,
    unitMeters: settings.unitMeters,
    notices,
  };
}
