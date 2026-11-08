/**
 * COLLADA（.dae）。
 *
 * three 的 ColladaLoader 负责几何 / 节点矩阵 / 材质，但当前版本既不读
 * `<up_axis>` 也不读 `<unit meter>`，这两项由本文件从 XML 头里补读：
 * - `<up_axis>Z_UP</up_axis>` → 直接可用；`Y_UP`（默认） → 导入时转 Z-up；
 * - `<unit meter="0.01">` → 直接得到米制缩放，SketchUp 导出的 DAE 靠这个才能对上尺寸。
 */
import { ColladaLoader } from 'three/examples/jsm/loaders/ColladaLoader.js';
import { partsFromObject } from './scene';
import type { ImportedModel } from './types';

function decodeText(data: ArrayBuffer): string {
  const bytes = new Uint8Array(data);
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return new TextDecoder('utf-8').decode(bytes.subarray(3));
  }
  return new TextDecoder('utf-8').decode(bytes);
}

function readHeader(text: string): { upAxis: 'y' | 'z'; unitMeters: number | null } {
  const upAxis = /<up_axis>\s*(X_UP|Y_UP|Z_UP)\s*<\/up_axis>/i.exec(text)?.[1]?.toUpperCase();
  const unitMatch = /<unit\b[^>]*\bmeter\s*=\s*"([^"]+)"/i.exec(text);
  const meters = unitMatch ? Number(unitMatch[1]) : NaN;
  return {
    upAxis: upAxis === 'Z_UP' ? 'z' : 'y',
    unitMeters: Number.isFinite(meters) && meters > 0 ? meters : null,
  };
}

export function parseDae(data: ArrayBuffer): ImportedModel {
  if (typeof DOMParser === 'undefined') {
    throw new Error('COLLADA 解析需要浏览器环境（DOMParser 不可用）。');
  }
  const text = decodeText(data);
  const header = readHeader(text);
  // ColladaLoader 自己会做两件事：Z_UP → Y_UP（旋转 scene）、unit → 米（缩放 scene），
  // 下面的 partsFromObject 会把这两层变换烘焙进顶点，所以这里按「米 + Y-up」交付。
  const scene = new ColladaLoader().parse(text, '').scene;
  if (!scene) throw new Error('COLLADA 文件里没有 scene。');
  const parts = partsFromObject(scene);
  if (!parts.length) throw new Error('COLLADA 文件里没有可读取的网格（可能只有相机 / 灯光）。');
  const notices: string[] = [];
  if (header.unitMeters && Math.abs(header.unitMeters - 1) > 1e-9) {
    notices.push(`文件声明 1 单位 = ${header.unitMeters} 米，已按此换算。`);
  }
  if (header.upAxis === 'z') {
    notices.push('文件声明 Z 向上，解析器已转成 Y-up，导入时再转回项目 Z-up。');
  }
  if (/<init_from>\s*[^<]*\.(png|jpe?g|tga|tif)/i.test(text)) {
    notices.push('模型引用了外部贴图，几何正常导入，贴图不会带入（按材质基色显示）。');
  }
  return {
    format: 'dae',
    formatLabel: 'COLLADA（.dae）',
    parts,
    upAxis: 'y',
    unitMeters: 1,
    notices,
  };
}
