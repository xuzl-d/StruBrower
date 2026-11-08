/**
 * OFF / COFF / NOFF（Geomview 的对象文件格式）。
 *
 * 格式非常朴素：一行头 `OFF nv nf ne`，nv 行顶点，nf 行多边形（每行 `n i0 … i(n-1)`）。
 * 多边形在这里按扇形三角化；COFF 的顶点色（0-1 或 0-255）会被保留。
 */
import { BufferGeometry, Color, Float32BufferAttribute, Mesh } from 'three';
import { partsFromObject } from './scene';
import type { ImportContext, ImportedModel } from './types';

function decodeText(data: ArrayBuffer): string {
  const bytes = new Uint8Array(data);
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return new TextDecoder('utf-8').decode(bytes.subarray(3));
  }
  return new TextDecoder('utf-8').decode(bytes);
}

export function parseOff(data: ArrayBuffer, context: ImportContext): ImportedModel {
  const lines = decodeText(data)
    .split(/\r?\n/)
    .map((line) => {
      const cut = line.indexOf('#');
      return (cut >= 0 ? line.slice(0, cut) : line).trim();
    })
    .filter(Boolean);
  if (!lines.length) throw new Error('OFF 文件是空的。');

  const header = lines[0]!.split(/\s+/);
  const kind = header[0]!.toUpperCase();
  if (!/^(C?N?OFF|STOFF|CNOFF)$/.test(kind)) {
    throw new Error(`不是 OFF 文件（首行是 “${header[0]}”）。`);
  }
  const hasColor = kind.includes('C');
  let cursor = 1;
  let counts = header.slice(1);
  if (counts.length < 3) {
    counts = (lines[cursor] ?? '').split(/\s+/).filter(Boolean);
    cursor += 1;
  }
  const vertexCount = Number(counts[0]);
  const faceCount = Number(counts[1]);
  if (!Number.isFinite(vertexCount) || !Number.isFinite(faceCount) || vertexCount <= 0 || faceCount <= 0) {
    throw new Error('OFF 头部没有合法的顶点 / 面数量。');
  }

  const positions: number[] = [];
  const colors: number[] = [];
  for (let i = 0; i < vertexCount; i += 1) {
    const tokens = (lines[cursor + i] ?? '').split(/\s+/).filter(Boolean);
    if (tokens.length < 3) throw new Error(`OFF 顶点行 ${i + 1} 不完整。`);
    positions.push(Number(tokens[0]), Number(tokens[1]), Number(tokens[2]));
    if (hasColor && tokens.length >= 6) {
      const rgb = tokens.slice(3, 6).map(Number);
      const scale = rgb.some((value) => value > 1.0001) ? 1 / 255 : 1;
      const color = new Color(rgb[0]! * scale, rgb[1]! * scale, rgb[2]! * scale);
      colors.push(color.r, color.g, color.b);
    }
  }
  cursor += vertexCount;

  // 面：从剩余文本读 token 流（OFF 允许一个面跨行）
  const faceTokens = lines.slice(cursor).join(' ').split(/\s+/).filter(Boolean);
  let index = 0;
  const triangles: number[] = [];
  for (let face = 0; face < faceCount && index < faceTokens.length; face += 1) {
    const corners = Number(faceTokens[index]);
    index += 1;
    if (!Number.isFinite(corners) || corners < 3) {
      index += Math.max(0, Math.floor(corners) || 0);
      continue;
    }
    const ring: number[] = [];
    for (let corner = 0; corner < corners; corner += 1) {
      const value = Number(faceTokens[index + corner]);
      if (Number.isFinite(value) && value >= 0 && value < vertexCount) ring.push(value);
    }
    index += corners;
    for (let corner = 1; corner + 1 < ring.length; corner += 1) {
      triangles.push(ring[0]!, ring[corner]!, ring[corner + 1]!);
    }
  }
  if (!triangles.length) throw new Error('OFF 文件里没有合法的三角面。');

  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
  geometry.setIndex(triangles);
  if (colors.length === vertexCount * 3) {
    geometry.setAttribute('color', new Float32BufferAttribute(colors, 3));
  }
  const mesh = new Mesh(geometry);
  mesh.name = context.fileName.replace(/\.(off|coff)$/i, '') || 'OFF 模型';
  const parts = partsFromObject(mesh);
  geometry.dispose();
  return {
    format: 'off',
    formatLabel: hasColor ? 'OFF（带顶点色）' : 'OFF',
    parts,
    upAxis: 'y',
    unitMeters: null,
    notices: hasColor ? ['已读取顶点色。'] : [],
  };
}
