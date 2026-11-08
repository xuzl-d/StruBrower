/**
 * glTF 2.0 / GLB。
 *
 * 用 three 的 GLTFLoader（它处理了 accessor 归一化、稀疏、节点矩阵、材质基色），
 * 我们只补两件它不管的事：
 * - 同目录的 .bin / 贴图：靠 resources（拖入的附属文件 → blob URL）改写 URL；
 * - 压缩扩展（Draco / KTX2）缺失时给出可读提示，而不是让用户看堆栈。
 */
import { LoadingManager } from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { partsFromObject } from './scene';
import type { ImportContext, ImportedModel, ImportedPart } from './types';

function isGlb(data: ArrayBuffer): boolean {
  if (data.byteLength < 4) return false;
  return new DataView(data).getUint32(0, true) === 0x46546c67;
}

function baseName(url: string): string {
  const clean = url.split('?')[0] ?? url;
  const segments = clean.split('/');
  return decodeURIComponent(segments[segments.length - 1] ?? clean);
}

export function parseGltf(data: ArrayBuffer, context: ImportContext): Promise<ImportedModel> {
  const notices: string[] = [];
  const manager = new LoadingManager();
  if (context.resources?.size) {
    manager.setURLModifier((url) => {
      const hit = context.resources!.get(baseName(url));
      return hit ?? url;
    });
  }
  const loader = new GLTFLoader(manager);
  return new Promise<ImportedModel>((resolve, reject) => {
    loader.parse(
      data,
      '',
      (gltf) => {
        const parts: ImportedPart[] = partsFromObject(gltf.scene);
        if (!parts.length) {
          reject(new Error('glTF 里没有可读取的网格（可能只有相机 / 灯光 / 空节点）。'));
          return;
        }
        const extensions = (gltf as unknown as { parser?: { json?: { extensionsRequired?: string[] } } }).parser?.json?.extensionsRequired ?? [];
        if (extensions.some((name) => /draco|meshopt/i.test(name))) {
          notices.push('模型使用了 Draco / meshopt 压缩，几何可能不完整。');
        }
        if (!isGlb(data) && context.resources && !context.resources.size) {
          notices.push('这是 .gltf（JSON），若引用了外部 .bin，请把 .bin 一起拖进来。');
        }
        resolve({
          format: 'gltf',
          formatLabel: isGlb(data) ? 'glTF 二进制（.glb）' : 'glTF（.gltf）',
          parts,
          upAxis: 'y',
          unitMeters: 1,
          notices,
        });
      },
      (error) => reject(new Error(`glTF 解析失败：${error instanceof Error ? error.message : String(error)}`)),
    );
  });
}
