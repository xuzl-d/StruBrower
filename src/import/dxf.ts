/**
 * DXF（ASCII）的曲面导入。
 *
 * 建筑 / 结构专业最常拿到的交换文件就是 DXF，但 DXF 主体是线框；能变成面的只有：
 * - 3DFACE / SOLID：三维面片（最常见的「三维面」）；
 * - POLYLINE + VERTEX（三维多段线 / 多边形网格）：按网格面记录三角化；
 * - MESH：AutoCAD 2011 起的面网格实体。
 * 线框（LINE / LWPOLYLINE / ARC）会被明确忽略，并在提示里写清楚，避免用户以为导入失败。
 *
 * 单位读 $INSUNITS（1=英寸 2=英尺 4=毫米 5=厘米 6=米），轴向固定 Z-up。
 */
import { BufferGeometry, Float32BufferAttribute } from 'three';
import type { ImportedModel, ImportedPart } from './types';

interface Pair {
  code: number;
  value: string;
}

const LAYER_COLORS = ['#b9c2cc', '#c8b79a', '#9fb6c8', '#c1a6a6', '#a9c0a4', '#b3a8c4'];

function decodeText(data: ArrayBuffer): string {
  const bytes = new Uint8Array(data);
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return new TextDecoder('utf-8').decode(bytes.subarray(3));
  }
  // DXF R12 及以前常见 GBK 注释，但组码与数值都是 ASCII，用 latin1 兜底不会破坏结构
  return new TextDecoder('utf-8').decode(bytes);
}

function toPairs(text: string): Pair[] {
  const lines = text.split(/\r?\n/);
  const pairs: Pair[] = [];
  let i = 0;
  while (i + 1 < lines.length) {
    const code = Number(lines[i]!.trim());
    if (!Number.isFinite(code)) {
      // 组码行对不上（空行 / 编码问题）时向后滑动一行重新对齐
      i += 1;
      continue;
    }
    pairs.push({ code, value: lines[i + 1]!.trim() });
    i += 2;
  }
  return pairs;
}

export function parseDxf(data: ArrayBuffer): ImportedModel {
  const pairs = toPairs(decodeText(data));
  if (!pairs.length) throw new Error('DXF 文件为空或不是 ASCII DXF。');

  let insUnits = 0;
  /** layer → 位置数组 + 索引数组 */
  const layers = new Map<string, { positions: number[]; indices: number[] }>();
  const layerOf = (name: string) => {
    const key = name || '0';
    let bucket = layers.get(key);
    if (!bucket) {
      bucket = { positions: [], indices: [] };
      layers.set(key, bucket);
    }
    return bucket;
  };
  const addTriangle = (layer: string, a: number[], b: number[], c: number[]) => {
    const bucket = layerOf(layer);
    const base = bucket.positions.length / 3;
    bucket.positions.push(...a, ...b, ...c);
    bucket.indices.push(base, base + 1, base + 2);
  };

  let section = '';
  let i = 0;
  let ignoredPrimitives = 0;
  let currentPolyline: { layer: string; kind: 'mesh' | '3d' | 'other'; vertices: number[][]; faces: number[][] } | null = null;

  while (i < pairs.length) {
    const pair = pairs[i]!;
    if (pair.code === 0 && pair.value === 'SECTION') {
      section = pairs[i + 1]?.code === 2 ? pairs[i + 1]!.value.toUpperCase() : '';
      i += 2;
      continue;
    }
    if (pair.code === 0 && pair.value === 'ENDSEC') {
      section = '';
      i += 1;
      continue;
    }
    if (section === 'HEADER') {
      if (pair.code === 9 && pair.value === '$INSUNITS') {
        const next = pairs[i + 1];
        if (next?.code === 70) insUnits = Number(next.value);
      }
      i += 1;
      continue;
    }
    if (section !== 'ENTITIES') {
      i += 1;
      continue;
    }
    if (pair.code !== 0) {
      i += 1;
      continue;
    }

    const type = pair.value.toUpperCase();
    const body: Pair[] = [];
    i += 1;
    while (i < pairs.length && pairs[i]!.code !== 0) body.push(pairs[i++]!);
    const first = (code: number) => body.find((item) => item.code === code)?.value ?? '';
    const all = (code: number) => body.filter((item) => item.code === code).map((item) => item.value);
    const point = (codes: [number, number, number]) => codes.map((code) => {
      const value = Number(first(code));
      return Number.isFinite(value) ? value : 0;
    });

    if (type === '3DFACE' || type === 'SOLID') {
      const a = point([10, 20, 30]);
      const b = point([11, 21, 31]);
      const c = point([12, 22, 32]);
      const layer = first(8);
      const hasFourth = body.some((item) => item.code === 13);
      addTriangle(layer, a, b, c);
      if (hasFourth) {
        const d = point([13, 23, 33]);
        const degenerate = Math.abs(d[0] - c[0]) < 1e-9 && Math.abs(d[1] - c[1]) < 1e-9 && Math.abs(d[2] - c[2]) < 1e-9;
        if (!degenerate) addTriangle(layer, a, c, d);
      }
      continue;
    }

    if (type === 'POLYLINE') {
      const flags = Number(first(70)) || 0;
      const kind = flags & 16 ? 'mesh' : flags & 8 ? '3d' : 'other';
      currentPolyline = { layer: first(8), kind, vertices: [], faces: [] };
      continue;
    }

    if (type === 'VERTEX' && currentPolyline) {
      const flags = Number(first(70)) || 0;
      if (currentPolyline.kind === 'mesh' && flags & 128) {
        const face = [71, 72, 73, 74]
          .map((code) => Number(first(code)))
          .filter((value) => Number.isFinite(value) && value > 0)
          .map((value) => value - 1);
        if (face.length >= 3) currentPolyline.faces.push(face);
      } else {
        currentPolyline.vertices.push(point([10, 20, 30]));
      }
      continue;
    }

    if (type === 'SEQEND' && currentPolyline) {
      if (currentPolyline.kind === 'mesh') {
        const { layer, vertices, faces } = currentPolyline;
        for (const face of faces) {
          const ring = face.map((index) => vertices[index]).filter(Boolean) as number[][];
          if (ring.length < 3) continue;
          for (let corner = 1; corner + 1 < ring.length; corner += 1) {
            addTriangle(layer, ring[0]!, ring[corner]!, ring[corner + 1]!);
          }
        }
      } else {
        ignoredPrimitives += 1;
      }
      currentPolyline = null;
      continue;
    }

    if (type === 'MESH') {
      // MESH 的顶点坐标是重复的 10/20/30，面索引是重复的 90
      const xs = all(10).map(Number);
      const ys = all(20).map(Number);
      const zs = all(30).map(Number);
      const vertexCount = Math.min(xs.length, ys.length, zs.length);
      const faceCount = Number(first(92)) || 0;
      const indices = all(90).map(Number);
      const vertices: number[][] = [];
      for (let v = 0; v < vertexCount; v += 1) vertices.push([xs[v]!, ys[v]!, zs[v]!]);
      const layer = first(8);
      let cursor = 0;
      for (let f = 0; f < faceCount && cursor < indices.length; f += 1) {
        const corners = indices[cursor]!;
        cursor += 1;
        const ring: number[][] = [];
        for (let corner = 0; corner < corners && cursor < indices.length; corner += 1) {
          const index = indices[cursor + corner]!;
          const vertex = vertices[index];
          if (vertex) ring.push(vertex);
        }
        cursor += corners;
        for (let corner = 1; corner + 1 < ring.length; corner += 1) {
          addTriangle(layer, ring[0]!, ring[corner]!, ring[corner + 1]!);
        }
      }
      continue;
    }

    if (['LINE', 'LWPOLYLINE', 'ARC', 'CIRCLE', 'TEXT', 'MTEXT', 'DIMENSION', 'INSERT', 'HATCH', 'POINT'].includes(type)) {
      ignoredPrimitives += 1;
    }
  }

  const parts: ImportedPart[] = [];
  let layerIndex = 0;
  for (const [layer, bucket] of layers) {
    if (!bucket.indices.length) continue;
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new Float32BufferAttribute(bucket.positions, 3));
    geometry.setIndex(bucket.indices);
    parts.push({
      name: `图层 ${layer}`,
      geometry,
      color: LAYER_COLORS[layerIndex % LAYER_COLORS.length]!,
    });
    layerIndex += 1;
  }
  if (!parts.length) {
    throw new Error(
      ignoredPrimitives
        ? '这份 DXF 只有线框（LINE / LWPOLYLINE / INSERT 等），没有可导入的面。请在 CAD 里把三维面（3DFACE）或网格导出后再试。'
        : 'DXF 里没有可导入的三维面（3DFACE / POLYLINE 网格 / MESH）。',
    );
  }

  const unitTable: Record<number, number> = { 1: 0.0254, 2: 0.3048, 4: 0.001, 5: 0.01, 6: 1, 10: 0.9144 };
  const notices: string[] = [];
  if (ignoredPrimitives) {
    notices.push(`已忽略 ${ignoredPrimitives} 个线框 / 标注 / 块参照实体（DXF 线框不能直接变成构件）。`);
  }
  return {
    format: 'dxf',
    formatLabel: 'DXF（三维面）',
    parts,
    upAxis: 'z',
    unitMeters: unitTable[insUnits] ?? null,
    notices,
  };
}
