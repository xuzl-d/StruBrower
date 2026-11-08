/**
 * 把 three 的对象树（GLTFLoader / FBXLoader / TDSLoader / ColladaLoader …）
 * 摊平成「带颜色的三角形部件数组」。
 *
 * 规则：
 * - 每个 Mesh 烘焙 matrixWorld；多材质（geometry.groups）按组拆成独立部件，颜色各自保留；
 * - 几何自带顶点色（PLY / 点云扫描）时优先用顶点色，材质基色只作兜底；
 * - 统一转成非索引 + position + color 两条属性，后续合并不会因属性集不同而失败。
 */
import { BufferGeometry, Color, Float32BufferAttribute, Mesh, type Material, type Object3D } from 'three';
import type { ImportedPart } from './types';
import { DEFAULT_IMPORT_COLOR } from './types';

function hexOf(material: Material | undefined): string {
  const color = (material as { color?: Color } | undefined)?.color;
  return color && typeof color.getHexString === 'function' ? `#${color.getHexString()}` : DEFAULT_IMPORT_COLOR;
}

function nameOf(object: Object3D, index: number): string {
  return object.name?.trim() || `构件 ${index + 1}`;
}

/** 单个几何 → 非索引 + color 属性（顶点色优先）。 */
function finalize(source: BufferGeometry, fallbackColor: string): BufferGeometry {
  const geometry = source.index ? source.toNonIndexed() : source.clone();
  if (!geometry.getAttribute('position')) {
    geometry.dispose();
    throw new Error('网格缺少 position 属性。');
  }
  if (geometry.getAttribute('color')) {
    // 顶点色可能是 0-255 的 ubyte，统一归一到 0-1
    const attribute = geometry.getAttribute('color');
    if (attribute.array instanceof Uint8Array || attribute.array instanceof Uint8ClampedArray) {
      const normalized = new Float32Array(attribute.count * 3);
      for (let i = 0; i < attribute.count; i += 1) {
        normalized[i * 3] = attribute.getX(i) / 255;
        normalized[i * 3 + 1] = attribute.getY(i) / 255;
        normalized[i * 3 + 2] = attribute.getZ(i) / 255;
      }
      geometry.setAttribute('color', new Float32BufferAttribute(normalized, 3));
    }
  } else {
    const tint = new Color(fallbackColor);
    const count = geometry.getAttribute('position').count;
    const colors = new Float32Array(count * 3);
    for (let i = 0; i < count; i += 1) colors.set([tint.r, tint.g, tint.b], i * 3);
    geometry.setAttribute('color', new Float32BufferAttribute(colors, 3));
  }
  for (const key of Object.keys(geometry.attributes)) {
    if (key !== 'position' && key !== 'color') geometry.deleteAttribute(key);
  }
  if (!geometry.getAttribute('normal')) geometry.computeVertexNormals();
  return geometry;
}

export function partsFromObject(root: Object3D): ImportedPart[] {
  root.updateMatrixWorld(true);
  const parts: ImportedPart[] = [];
  let index = 0;
  root.traverse((node) => {
    const mesh = node as Mesh;
    if (!(mesh as { isMesh?: boolean }).isMesh || !mesh.geometry) return;
    const geometry = mesh.geometry.clone();
    geometry.applyMatrix4(mesh.matrixWorld);
    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    const groups = geometry.groups.filter((group) => group.count > 0);
    const splitByGroup = Array.isArray(mesh.material) && groups.length > 1;

    if (!splitByGroup) {
      const part = finalize(geometry, hexOf(materials[0]));
      geometry.dispose();
      parts.push({ name: nameOf(node, index), geometry: part, color: hexOf(materials[0]) });
      index += 1;
      return;
    }

    for (const [groupIndex, group] of groups.entries()) {
      const source = Array.isArray(mesh.material) ? mesh.material[group.materialIndex ?? 0] : mesh.material;
      const sub = new BufferGeometry();
      const position = geometry.getAttribute('position');
      const color = geometry.getAttribute('color');
      const start = group.start;
      const end = Math.min(position.count, start + group.count);
      const count = end - start;
      if (count < 3) continue;
      const positions = new Float32Array(count * 3);
      for (let i = 0; i < count; i += 1) {
        positions[i * 3] = position.getX(start + i);
        positions[i * 3 + 1] = position.getY(start + i);
        positions[i * 3 + 2] = position.getZ(start + i);
      }
      sub.setAttribute('position', new Float32BufferAttribute(positions, 3));
      if (color) {
        const colors = new Float32Array(count * 3);
        for (let i = 0; i < count; i += 1) {
          colors[i * 3] = color.getX(start + i);
          colors[i * 3 + 1] = color.getY(start + i);
          colors[i * 3 + 2] = color.getZ(start + i);
        }
        sub.setAttribute('color', new Float32BufferAttribute(colors, 3));
      }
      const part = finalize(sub, hexOf(source));
      sub.dispose();
      parts.push({ name: `${nameOf(node, index)} · ${groupIndex + 1}`, geometry: part, color: hexOf(source) });
    }
    geometry.dispose();
    index += 1;
  });
  return parts;
}

/** 释放解析结果里的几何（导入被取消时调用）。 */
export function disposeParts(parts: ImportedPart[]): void {
  for (const part of parts) part.geometry.dispose();
  parts.length = 0;
}
