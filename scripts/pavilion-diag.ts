/**
 * 凉亭几何自检：把每个特征单独求值，然后
 * 1. 两两做真实三角形相交测试（three-mesh-bvh），找出「穿模」的那一对；
 * 2. 从屋面法向打射线，统计瓦面对望板的覆盖率（找出露屋面的地方）；
 * 3. 出一张按特征分色的近景图，肉眼核对。
 *
 * 运行：npx esbuild scripts/pavilion-diag.ts --bundle --platform=node --format=esm \
 *        --outfile=.tmp/pavilion-diag.mjs --log-level=warning && node .tmp/pavilion-diag.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { BufferGeometry, DoubleSide, Matrix4, Ray, Vector3 } from 'three';
import { MeshBVH } from 'three-mesh-bvh';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { buildSolidParts } from '../src/bim/solid';
import { libraryFeatures } from '../shared/library.js';
import { renderSheet } from './lib/mini-render';

interface Piece {
  id: string;
  label: string;
  geometry: BufferGeometry;
  color: string;
  bounds: { min: [number, number, number]; max: [number, number, number] };
  triangles: number;
}

const PALETTE_FALLBACK = ['#94a3b8', '#a3a3a3', '#71717a'];

/** 固定色表：每种构件一个不会撞色的颜色，便于在图上直接指出「谁穿了谁」 */
const FIXED_COLORS: Record<string, string> = {
  'pv-base': '#9aa3ab',
  'pv-base-top': '#b6bec5',
  'pv-step': '#8c949b',
  'pv-plinth': '#7b838a',
  'pv-column': '#c2410c',
  'pv-beam': '#ea580c',
  'pv-frieze': '#f59e0b',
  'pv-seat': '#d97706',
  'pv-roof': '#1d4ed8',
  'pv-tiles': '#cbd5e1',
  'pv-dougong': '#a21caf',
  'pv-dougong-mid': '#c026d3',
  'pv-purlin': '#facc15',
  'pv-eave': '#16a34a',
  'pv-ridge': '#dc2626',
  'pv-corner-beam': '#f472b6',
  'pv-king-post': '#7c3aed',
  'pv-strut': '#4f46e5',
  'pv-finial': '#e11d48',
};

function boundsOf(geometry: BufferGeometry) {
  geometry.computeBoundingBox();
  const box = geometry.boundingBox!;
  return {
    min: [box.min.x, box.min.y, box.min.z] as [number, number, number],
    max: [box.max.x, box.max.y, box.max.z] as [number, number, number],
  };
}

const features = libraryFeatures('pavilion-hex') as Array<{ id: string; label: string }>;
// 必须走 buildSolidParts：它把整棵树的屋面上下文带进去，onRoof 才解析得到 pv-tiles。
// 早先这里用 buildSolidGeometry([feature]) 逐个求值，贴面特征会静默退回硬编码 path，
// 量出来的穿模数据全是假的。
const partGeometries = buildSolidParts(features as never);
const pieces: Piece[] = features.map((feature, index) => {
  const own = partGeometries.filter((part) => part.id === feature.id);
  const geometry = own.length === 1
    ? own[0]!.geometry
    : mergeGeometries(own.map((part) => part.geometry), false) ?? new BufferGeometry();
  const indexCount = geometry.index ? geometry.index.count : geometry.getAttribute('position').count;
  return {
    id: feature.id,
    label: feature.label,
    geometry,
    color: FIXED_COLORS[feature.id] ?? PALETTE_FALLBACK[index % PALETTE_FALLBACK.length]!,
    bounds: boundsOf(geometry),
    triangles: Math.floor(indexCount / 3),
  };
});

console.log(`特征 ${pieces.length} 个\n`);
for (const piece of pieces) {
  const { min, max } = piece.bounds;
  console.log(
    `${piece.id.padEnd(18)} ${piece.label.padEnd(12)} 面 ${String(piece.triangles).padStart(6)}`
    + `  x[${min[0].toFixed(2)}, ${max[0].toFixed(2)}]`
    + ` y[${min[1].toFixed(2)}, ${max[1].toFixed(2)}]`
    + ` z[${min[2].toFixed(2)}, ${max[2].toFixed(2)}]`,
  );
}

/* ---------------- 1. 两两相交 ---------------- */
console.log('\n=== 三角形级相交（穿模） ===');
const bvhs = pieces.map((piece) => new MeshBVH(piece.geometry));
const identity = new Matrix4();
let collisions = 0;
for (let i = 0; i < pieces.length; i += 1) {
  for (let j = i + 1; j < pieces.length; j += 1) {
    const a = pieces[i]!;
    const b = pieces[j]!;
    // 包围盒先粗筛，省掉大部分 BVH 查询
    const overlap = (['x', 'y', 'z'] as const).every(
      (axis, k) => a.bounds.min[k]! <= b.bounds.max[k]! && b.bounds.min[k]! <= a.bounds.max[k]!,
    );
    if (!overlap) continue;
    let hit = false;
    try {
      hit = bvhs[i]!.intersectsGeometry(b.geometry, identity);
    } catch (error) {
      console.log(`  ! ${a.id} × ${b.id} 测试异常：${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    if (hit) {
      collisions += 1;
      console.log(`  ✗ ${a.id.padEnd(18)} × ${b.id}`);
    }
  }
}
if (!collisions) console.log('  （无相交）');

/* ---------------- 2. 瓦面覆盖（沿法向打射线） ---------------- */
console.log('\n=== 瓦面对望板的覆盖 ===');
{
  const roof = pieces.find((piece) => piece.id === 'pv-roof')!;
  const tiles = pieces.find((piece) => piece.id === 'pv-tiles')!;
  const geometry = roof.geometry;
  const position = geometry.getAttribute('position');
  const normal = geometry.getAttribute('normal');
  const index = geometry.index;
  const count = index ? index.count : position.count;
  const tilesBvh = new MeshBVH(tiles.geometry);
  let samples = 0;
  let exposed = 0;
  let exposedArea = 0;
  let totalArea = 0;
  const spots: string[] = [];
  const a = new Vector3();
  const b = new Vector3();
  const c = new Vector3();
  for (let t = 0; t + 2 < count; t += 3) {
    const ia = index ? index.getX(t) : t;
    const ib = index ? index.getX(t + 1) : t + 1;
    const ic = index ? index.getX(t + 2) : t + 2;
    a.set(position.getX(ia), position.getY(ia), position.getZ(ia));
    b.set(position.getX(ib), position.getY(ib), position.getZ(ib));
    c.set(position.getX(ic), position.getY(ic), position.getZ(ic));
    const nx = (normal.getX(ia) + normal.getX(ib) + normal.getX(ic)) / 3;
    const ny = (normal.getY(ia) + normal.getY(ib) + normal.getY(ic)) / 3;
    const nz = (normal.getZ(ia) + normal.getZ(ib) + normal.getZ(ic)) / 3;
    const len = Math.hypot(nx, ny, nz) || 1;
    if (nz / len < 0.08) continue; // 只看朝上的外表面
    const area = b.clone().sub(a).cross(c.clone().sub(a)).length() / 2;
    totalArea += area;
    samples += 1;
    const origin = a.clone().add(b).add(c).divideScalar(3);
    const dir = new Vector3(nx / len, ny / len, nz / len);
    origin.addScaledVector(dir, 0.0015);
    const hits = tilesBvh.raycast(new Ray(origin, dir), DoubleSide, 0, 0.25);
    if (!hits.length) {
      exposed += 1;
      exposedArea += area;
      if (spots.length < 16) {
        spots.push(`(${origin.x.toFixed(2)}, ${origin.y.toFixed(2)}, ${origin.z.toFixed(2)}) 面朝法向 ${nx / len > 0 ? '' : ''}${(nz / len).toFixed(2)}`);
      }
    }
  }
  const pct = (exposedArea / Math.max(1e-9, totalArea)) * 100;
  console.log(`  朝上望板 ${samples} 个三角面 / ${totalArea.toFixed(2)} m²：${exposed} 个面在法向上没被瓦挡住，占 ${pct.toFixed(1)}% 面积`);
  if (spots.length) console.log(`  裸露位置样例：\n    ${spots.join('\n    ')}`);
}

/* ---------------- 3. 木构件有没有从瓦面顶出来 ---------------- */
console.log('\n=== 木构件相对瓦面的位置 ===');
{
  const tiles = pieces.find((piece) => piece.id === 'pv-tiles');
  const watch = ['pv-eave', 'pv-corner-beam', 'pv-ridge'];
  if (tiles) {
    /**
     * 屋面在平面上是**高度场**（同一个 xy 只有一片瓦），于是判据可以做得非常干净：
     *   - 从 (x, y, 100) 往下打不中 → 这点在瓦面轮廓之外（檐口外挑的木构件），跳过；
     *   - 从该点往上打**打得中**瓦 → 它被瓦盖住了，正确；
     *   - 往上打打不中 → 它在瓦面之上，也就是从屋面里顶了出来。
     * 不用最近点：瓦是薄壳，最近点会挑到瓦的底面，法向符号就翻了。
     */
    const tilesBvh = new MeshBVH(tiles.geometry);
    const up = new Vector3(0, 0, 1);
    const down = new Vector3(0, 0, -1);
    for (const id of watch) {
      const piece = pieces.find((item) => item.id === id);
      if (!piece) continue;
      const position = piece.geometry.getAttribute('position');
      let inside = 0;
      let hidden = 0;
      let poking = 0;
      let worst = 0;
      const spots: string[] = [];
      for (let v = 0; v < position.count; v += 1) {
        const x = position.getX(v);
        const y = position.getY(v);
        const z = position.getZ(v);
        if (!tilesBvh.raycast(new Ray(new Vector3(x, y, 100), down), DoubleSide, 0, 200).length) continue;
        inside += 1;
        if (tilesBvh.raycast(new Ray(new Vector3(x, y, z), up), DoubleSide, 0, 3).length) {
          hidden += 1;
          continue;
        }
        poking += 1;
        // 顶出来多少：该点上方的瓦面高度减去构件高度
        const top = tilesBvh.raycast(new Ray(new Vector3(x, y, 100), down), DoubleSide, 0, 200)[0]!;
        const above = (top.point.z - z) * -1;
        worst = Math.max(worst, above);
        if (spots.length < 4) spots.push(`(${x.toFixed(2)}, ${y.toFixed(2)}, z=${z.toFixed(2)}) 瓦顶 ${top.point.z.toFixed(2)} Δ${above.toFixed(3)}`);
      }
      const pct = inside ? (poking / inside) * 100 : 0;
      const line =
        `  ${id.padEnd(18)} 轮廓内顶点 ${String(inside).padStart(5)}：被瓦盖住 ${hidden}，` +
        `顶出瓦面 ${poking}（${pct.toFixed(1)}%）`;
      console.log(line + (poking ? `，最高 ${worst.toFixed(3)} m` : ''));
      if (spots.length) console.log(`      ${spots.join('  ')}`);
    }
    console.log('  说明：戗脊压在瓦面上，允许有顶点在瓦面之上；封檐板 / 角梁应当 0 个顶出。');
  }
}

/* ---------------- 4. 分色近景 ---------------- */
const merged = mergeGeometries(pieces.map((piece) => piece.geometry), true);
if (merged) {
  merged.groups.forEach((group, index) => { group.materialIndex = index; });
  const materials = pieces.map((piece) => ({
    name: piece.id,
    color: piece.color,
    roughness: 0.62,
    metalness: 0.04,
  }));
  const out = 'diagnostics/pavilion/pavilion-diag.png';
  fs.mkdirSync(path.dirname(out), { recursive: true });
  renderSheet(
    merged,
    materials as never,
    [
      { name: '翼角-外', azimuth: 12, elevation: 10, focus: [2.75, 0.4, 3.75], radius: 1.15 },
      { name: '翼角-侧', azimuth: 40, elevation: 6, focus: [2.7, 0.3, 3.7], radius: 1.1 },
      { name: '翼角-俯', azimuth: 20, elevation: 45, focus: [2.6, 0.5, 3.85], radius: 1.2 },
      { name: '檐口-仰', azimuth: 14, elevation: -16, focus: [2.6, 0.6, 3.45], radius: 1.1 },
      { name: '屋面-中', azimuth: 24, elevation: 30, focus: [0.9, 0.2, 4.4], radius: 1.9 },
      { name: '全亭', azimuth: 34, elevation: 20, zoom: 1.1 },
    ],
    out,
    { width: 760, height: 560, columns: 3 },
  );
  console.log(`\n分色图 ${out}`);
  console.log(`图例：${pieces.map((piece) => `${piece.id}=${piece.color}`).join('  ')}`);
}

/* ---------------- 4. 角部半径剖面：谁高过谁 ---------------- */
console.log('\n=== 角部剖面（同一半径上，各构件的 z 范围） ===');
{
  // 只看角部 12° 扇区内的顶点，按半径分桶，输出每个桶里各构件的 z 上下界
  const sector = (x: number, y: number) => {
    const angle = Math.atan2(y, x); // 角在 0°、60°…
    const nearest = Math.round(angle / (Math.PI / 3)) * (Math.PI / 3);
    return Math.abs(angle - nearest) < (12 * Math.PI) / 180;
  };
  const picks = ['pv-tiles', 'pv-roof', 'pv-eave', 'pv-ridge', 'pv-corner-beam', 'pv-purlin'];
  const buckets = new Map<number, Record<string, { min: number; max: number }>>();
  for (const piece of pieces) {
    if (!picks.includes(piece.id)) continue;
    const position = piece.geometry.getAttribute('position');
    for (let i = 0; i < position.count; i += 1) {
      const x = position.getX(i);
      const y = position.getY(i);
      const z = position.getZ(i);
      if (!sector(x, y)) continue;
      const r = Math.hypot(x, y);
      if (r > 4.0) continue;
      const key = Math.round(r * 10) / 10;
      const row = buckets.get(key) ?? {};
      const cell = row[piece.id] ?? { min: Infinity, max: -Infinity };
      cell.min = Math.min(cell.min, z);
      cell.max = Math.max(cell.max, z);
      row[piece.id] = cell;
      buckets.set(key, row);
    }
  }
  const header = ['r', ...picks.map((id) => id.replace('pv-', ''))];
  console.log('  ' + header.map((text) => text.padEnd(15)).join(''));
  for (const r of [...buckets.keys()].sort((a, b) => b - a)) {
    const row = buckets.get(r)!;
    const cells = picks.map((id) => {
      const cell = row[id];
      if (!cell) return '—';
      return `${cell.min.toFixed(2)}~${cell.max.toFixed(2)}`;
    });
    console.log('  ' + [r.toFixed(1), ...cells].map((text) => text.padEnd(15)).join(''));
  }
}

/* ---------------- 5. 只看屋面层（瓦 / 望板 / 封檐板 / 戗脊） ---------------- */
{
  const keep = ['pv-roof', 'pv-tiles', 'pv-eave', 'pv-ridge'];
  const subset = pieces.filter((piece) => keep.includes(piece.id));
  const geometry = mergeGeometries(subset.map((piece) => piece.geometry), true);
  if (geometry) {
    geometry.groups.forEach((group, index) => { group.materialIndex = index; });
    renderSheet(
      geometry,
      subset.map((piece) => ({ name: piece.id, color: piece.color, roughness: 0.6, metalness: 0.04 })) as never,
      [
        { name: '角-外', azimuth: 10, elevation: 8, focus: [2.85, 0.35, 3.72], radius: 1.0 },
        { name: '角-底', azimuth: 20, elevation: -22, focus: [2.75, 0.45, 3.6], radius: 1.05 },
        { name: '角-正', azimuth: 0, elevation: 2, focus: [3.0, 0, 3.7], radius: 0.95 },
        { name: '檐口一排', azimuth: 30, elevation: -6, focus: [2.3, 1.2, 3.55], radius: 1.5 },
        { name: '屋面', azimuth: 20, elevation: 42, focus: [0.7, 0.2, 4.35], radius: 2.2 },
        { name: '顶视', azimuth: 30, elevation: 74, focus: [0, 0, 4.6], radius: 3.0 },
      ],
      'diagnostics/pavilion/pavilion-roof-only.png',
      { width: 760, height: 560, columns: 3 },
    );
    console.log('\n屋面层图 diagnostics/pavilion/pavilion-roof-only.png');
  }
}
