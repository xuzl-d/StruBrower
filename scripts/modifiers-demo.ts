/**
 * 曲面修饰（倒圆 / 抽壳 / 偏移）与 192 阵列的对照出图。
 *
 * 全部走真实链路：buildSolidGeometry 就是视口里用的那套求值，
 * 所以这些图能说明「接口补上了、样子对不对」，而不是另画一份示意。
 */
import { buildSolidGeometry } from '../src/bim/solid';
import { renderSheet } from './lib/mini-render';
import type { SolidFeature } from '../src/bim/types';

const feature = (spec: Record<string, unknown>): SolidFeature => ({ id: 'f', ...spec } as SolidFeature);

function stats(label: string, features: SolidFeature[]): number {
  const start = process.hrtime.bigint();
  const geometry = buildSolidGeometry(features);
  const ms = Number(process.hrtime.bigint() - start) / 1e6;
  const triangles = Math.floor((geometry.index?.count ?? geometry.getAttribute('position').count) / 3);
  geometry.dispose();
  console.log(`${label.padEnd(26)} ${String(triangles).padStart(6)} 面  ${ms.toFixed(1).padStart(6)} ms`);
  return triangles;
}

function sheet(features: SolidFeature[], views: Parameters<typeof renderSheet>[2], out: string, columns = 1): number {
  const geometry = buildSolidGeometry(features);
  const triangles = Math.floor((geometry.index?.count ?? geometry.getAttribute('position').count) / 3);
  renderSheet(geometry, [null], views, out, { width: columns > 1 ? 460 : 720, height: columns > 1 ? 400 : 440, columns });
  geometry.dispose();
  return triangles;
}

console.log('=== 曲面修饰对照 ===');

/* 1. 倒圆：三对「无 / 有」，同一视角一眼看出差别 */
const box = { shape: 'box', width: 0.8, depth: 0.55, height: 0.45 } as const;
const cyl = { shape: 'cylinder', radius: 0.3, height: 0.5, segments: 32 } as const;
const hex = {
  shape: 'prism',
  height: 0.45,
  profile: Array.from({ length: 6 }, (_, i) => {
    const t = (i / 6) * Math.PI * 2;
    return [Math.cos(t) * 0.34, Math.sin(t) * 0.34] as [number, number];
  }),
} as const;

// 三组对照沿 X 排开，每组「左原件 / 右倒圆」，用三个特写分别取景
const filletScene = [
  feature({ shape: box, translate: [-1.85, -0.42, 0] }),
  feature({ shape: box, fillet: 0.09, translate: [-1.85, 0.42, 0] }),
  feature({ shape: cyl, translate: [0, -0.42, 0] }),
  feature({ shape: cyl, fillet: { radius: 0.07, segments: 24 }, translate: [0, 0.42, 0] }),
  feature({ shape: hex, translate: [1.85, -0.42, 0] }),
  feature({ shape: hex, fillet: 0.07, translate: [1.85, 0.42, 0] }),
];
const plainTriangles = stats('盒/圆柱/棱柱 无倒圆', [filletScene[0]!, filletScene[2]!, filletScene[4]!]);
const filletTriangles = stats('盒/圆柱/棱柱 倒圆', [filletScene[1]!, filletScene[3]!, filletScene[5]!]);
const pair = (x: number, name: string) => ({ name, azimuth: 34, elevation: 26, focus: [x, 0, 0] as [number, number, number], radius: 0.72 });
sheet(filletScene, [pair(-1.85, '盒：左原件 / 右 fillet'), pair(0, '圆柱：左原件 / 右 fillet'), pair(1.85, '六棱柱：左原件 / 右 fillet')], 'diagnostics/modifiers/fillet.png', 3);

/* 2. 抽壳：杯子剖开看壁厚 + 两端开口的管壳 */
const cupBase = feature({
  shape: { shape: 'box', width: 0.86, depth: 0.86, height: 0.72 },
  fillet: 0.06,
  shell: { thickness: 0.07, open: 'z+' },
  translate: [-0.75, 0, 0],
});
const cup = [cupBase, feature({ shape: { shape: 'box', width: 1.2, depth: 0.6, height: 0.6 }, mode: 'cut', translate: [-0.75, 0.55, 0] })];
const pipe = feature({
  shape: { shape: 'cylinder', radius: 0.34, height: 0.86, segments: 40 },
  fillet: { radius: 0.05, segments: 20 },
  shell: { thickness: 0.05, open: ['z+', 'z-'] },
  translate: [0.8, 0, 0],
});
const shellTriangles = sheet([...cup, pipe], [
  { name: '抽壳杯（剖切看壁厚）/ 两端开口管壳', azimuth: 26, elevation: 24, focus: [0, 0, -0.05], radius: 1.35 },
  { name: '俯视：开口与内壁', azimuth: 26, elevation: 66, focus: [0, 0, -0.05], radius: 1.35 },
], 'diagnostics/modifiers/shell.png');
stats('抽壳杯 + 管壳', [...cup, pipe]);

/* 3. 偏移：同一尺寸往外 +0.07 / 原样 / 往里 -0.07 */
const base = { shape: 'box', width: 0.7, depth: 0.7, height: 0.5 } as const;
const offsetScene = [
  // 视角从 +Y 看，X 在画面上是镜像的；把内收放 x=+0.95，画面上就变成「左小右大」
  feature({ shape: base, offset: 0.07, translate: [-0.95, 0, 0] }),
  feature({ shape: base, translate: [0, 0, 0] }),
  feature({ shape: base, offset: -0.07, translate: [0.95, 0, 0] }),
];
sheet(offsetScene, [{ name: '+0.07 / 原样 / −0.07（同一视距）', azimuth: 86, elevation: 18, focus: [0, 0, 0], radius: 1.6 }], 'diagnostics/modifiers/offset.png');
stats('偏移 −/+ 0.07', offsetScene);

/* 4. 阵列：一排 90 个舷窗写在同一个特征里（原上限 64） */
const plate = feature({ shape: { shape: 'box', width: 4.6, depth: 0.9, height: 0.1 }, fillet: 0.02, translate: [0, 0, 0] });
const windows = feature({
  // 圆柱沿 Z（默认方向），高度比板厚大一倍，切出来才是圆孔；转了 90° 就变成一条通槽
  shape: { shape: 'cylinder', radius: 0.026, height: 0.3, segments: 14 },
  mode: 'cut',
  translate: [-2.24, 0, 0],
  pattern: { type: 'linear', count: 90, step: [0.05, 0, 0] },
});
const arrayTriangles = sheet([plate, windows], [
  { name: '90 个孔 · 1 个特征', azimuth: 90, elevation: 58, focus: [0, 0, 0], radius: 2.35 },
  { name: '近处看孔', azimuth: 58, elevation: 30, focus: [-1.75, 0, 0], radius: 0.6 },
], 'diagnostics/modifiers/array.png', 2);
stats('板 + 90 孔阵列', [plate, windows]);

console.log('\n=== 小结 ===');
console.log(`倒圆代价：${plainTriangles} → ${filletTriangles} 面（同一批形状）`);
console.log(`抽壳杯 + 管壳：${shellTriangles} 面`);
console.log(`90 孔阵列：${arrayTriangles} 面，特征数仍是 2`);
