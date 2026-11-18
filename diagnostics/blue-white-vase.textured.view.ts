/**
 * 贴图版青花瓷的离线预览 —— 走与视口完全相同的链路：
 * addSolid → applyOps 校验 → buildElementModel（含按材质槽生成柱面 UV）→
 * mini-render 按 UV 透视校正采样贴图 → PNG。
 *
 * 运行（项目根目录）：
 *   npx esbuild diagnostics/blue-white-vase.textured.view.ts --bundle --platform=node \
 *     --format=esm --outfile=.tmp/vase-textured-view.mjs --log-level=warning \
 *     && node .tmp/vase-textured-view.mjs
 * 输出：diagnostics/blue-white-vase/textured-{views,detail}.png
 *
 * 换成 Python 沙箱生成的贴图版（见 blue-white-vase.python.mjs）：
 *   VASE_OPS=diagnostics/blue-white-vase.python.ops.json VASE_PREFIX=python node .tmp/vase-textured-view.mjs
 * 输出 python-{views,detail}.png；PREFIX 只是文件名前缀，渲染链路完全相同。
 */
import fs from 'node:fs';
import path from 'node:path';
import { createProject } from '../src/bim/template';
import { applyOps } from '../server/ai/ops.js';
import { buildElementModel } from '../src/bim/geometry';
import { renderSheet, type RasterView } from '../scripts/lib/mini-render';

const ROOT = process.cwd();
const OUT = path.join(ROOT, 'diagnostics/blue-white-vase');
/** 默认渲染内置纹理版；VASE_OPS / VASE_PREFIX 可切换到 Python 生成的贴图版 */
const SRC = process.env.VASE_OPS
  ? path.join(ROOT, process.env.VASE_OPS)
  : path.join(ROOT, 'diagnostics/blue-white-vase.textured.ops.json');
const PREFIX = process.env.VASE_PREFIX ?? 'textured';
fs.mkdirSync(OUT, { recursive: true });

const ops = JSON.parse(fs.readFileSync(SRC, 'utf8')) as Array<Record<string, unknown>>;
const started = performance.now();
const result = applyOps(createProject({ name: '青花瓷贴图预览' }), ops);
const element = result.document.elements[0];
if (!element) throw new Error('applyOps 没有生成构件');
const model = buildElementModel(result.document, element);
if (!model) throw new Error('造型求值失败');
const { geometry, materials } = model;
const triangles = Math.floor((geometry.index?.count ?? geometry.getAttribute('position').count) / 3);
const uv = geometry.getAttribute('uv');
console.log(`贴图版：${triangles} 三角面 · ${(performance.now() - started).toFixed(0)} ms · ${materials.length} 个材质槽`);
console.log(`UV 属性：${uv ? `${uv.count} 个顶点` : '缺失'}，材质带贴图：${materials.some((m) => m?.map)}`);
if (!uv) throw new Error('造型内核没有生成 UV，贴图不会显示');

const sky: [string, string] = ['#5d6a78', '#c9d2da'];
const views: RasterView[] = [
  { name: '正面', azimuth: -90, elevation: 4, zoom: 1.22 },
  { name: '斜前 45°', azimuth: -45, elevation: 12, zoom: 1.28 },
  { name: '转 90°', azimuth: 0, elevation: 4, zoom: 1.22 },
  { name: '俯视口沿', azimuth: -90, elevation: 72, zoom: 1.3 },
];
renderSheet(geometry, materials, views, path.join(OUT, `${PREFIX}-views.png`), {
  width: 500, height: 560, columns: 2, ss: 2, sky,
});
console.log(`已出图 ${PREFIX}-views.png`);

const details: RasterView[] = [
  { name: '主花特写', azimuth: -90, elevation: 2, focus: [0, -0.11, 0.152], zoom: 5.2 },
  { name: '下腹仰莲', azimuth: -90, elevation: -4, focus: [0, -0.09, 0.07], zoom: 5.2 },
  { name: '口沿颈部', azimuth: -90, elevation: 14, focus: [0, -0.07, 0.29], zoom: 5.2 },
  { name: '侧转 30°', azimuth: -60, elevation: 8, focus: [0, -0.11, 0.16], zoom: 3.4 },
];
renderSheet(geometry, materials, details, path.join(OUT, `${PREFIX}-detail.png`), {
  width: 500, height: 500, columns: 2, ss: 2, sky,
});
console.log(`已出图 ${PREFIX}-detail.png`);
