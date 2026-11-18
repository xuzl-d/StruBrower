/**
 * 青花瓷特征树的离线预览 —— 与视口同一套造型内核，只是不用 WebGL。
 *
 * 链路和 AI 面板点「应用到模型」一致：addSolid → applyOps 校验落库 →
 * buildElementModel 求值 → mini-render 按材质槽软光栅出 PNG。
 *
 * 运行（项目根目录）：
 *   npx esbuild diagnostics/blue-white-vase.view.ts --bundle --platform=node \
 *     --format=esm --outfile=.tmp/vase-view.mjs --log-level=warning && node .tmp/vase-view.mjs
 * 输出：diagnostics/blue-white-vase/{views,detail,plain}.png
 */
import fs from 'node:fs';
import path from 'node:path';
import { createProject } from '../src/bim/template';
import { applyOps } from '../server/ai/ops.js';
import { buildElementModel } from '../src/bim/geometry';
import { renderSheet, type RasterView } from '../scripts/lib/mini-render';

const ROOT = process.cwd();
const OUT = path.join(ROOT, 'diagnostics/blue-white-vase');
const SRC = path.join(ROOT, 'diagnostics/blue-white-vase.ops.json');
fs.mkdirSync(OUT, { recursive: true });

const ops = JSON.parse(fs.readFileSync(SRC, 'utf8')) as Array<Record<string, unknown>>;

function evaluate(list: Array<Record<string, unknown>>) {
  const started = performance.now();
  const result = applyOps(createProject({ name: '青花瓷预览' }), list);
  const element = result.document.elements[0];
  if (!element) throw new Error('applyOps 没有生成构件');
  const model = buildElementModel(result.document, element);
  if (!model) throw new Error('造型求值失败');
  const ms = performance.now() - started;
  const { geometry, materials } = model;
  const triangles = Math.floor((geometry.index?.count ?? geometry.getAttribute('position').count) / 3);
  return { geometry, materials, triangles, ms };
}

const sky: [string, string] = ['#5d6a78', '#c9d2da'];

const full = evaluate(ops);
console.log(`完整版：${full.triangles} 三角面 · ${full.ms.toFixed(0)} ms · ${full.materials.length} 个材质槽`);

/* 正面纹样在 -Y（θ = -90°），所以主视是 azimuth -90；背面那组在 +Y。 */
const views: RasterView[] = [
  { name: '正面', azimuth: -90, elevation: 4, zoom: 1.22 },
  { name: '斜前 45°', azimuth: -45, elevation: 12, zoom: 1.28 },
  { name: '背面', azimuth: 90, elevation: 4, zoom: 1.22 },
  { name: '俯视口沿', azimuth: -90, elevation: 72, zoom: 1.3 },
];
renderSheet(full.geometry, full.materials, views, path.join(OUT, 'views.png'), {
  width: 500, height: 560, columns: 2, ss: 2, sky,
});
console.log('已出图 views.png');

// 注意：mini-render 的 radius 有 Math.max(0.5, …) 下限（为建筑尺度写的），
// 小器物不能用 radius 取景，只能用 focus + zoom 放大。
const details: RasterView[] = [
  { name: '主花特写', azimuth: -90, elevation: 2, focus: [0, -0.11, 0.152], zoom: 5.2 },
  { name: '下腹仰莲', azimuth: -90, elevation: -4, focus: [0, -0.09, 0.07], zoom: 5.2 },
  { name: '口沿颈部', azimuth: -90, elevation: 14, focus: [0, -0.07, 0.29], zoom: 5.2 },
  { name: '侧转 30°', azimuth: -60, elevation: 8, focus: [0, -0.11, 0.16], zoom: 3.4 },
];
renderSheet(full.geometry, full.materials, details, path.join(OUT, 'detail.png'), {
  width: 500, height: 500, columns: 2, ss: 2, sky,
});
console.log('已出图 detail.png');

/* 对照：只留胎体，一眼看出几何化纹样到底加了什么 */
const plain = evaluate([{ ...ops[0], features: (ops[0].features as unknown[]).slice(0, 1) }]);
console.log(`纯胎体：${plain.triangles} 三角面 · ${plain.ms.toFixed(0)} ms`);
renderSheet(plain.geometry, plain.materials, views.slice(0, 2), path.join(OUT, 'plain.png'), {
  width: 500, height: 560, columns: 2, ss: 2, sky,
});
console.log('已出图 plain.png');
