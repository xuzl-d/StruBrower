/**
 * 履带式起重机：走一遍真实链路（addSolid → 服务端校验 → 文档 → 求值）并离线出图。
 *
 * 模型本体是 `shared/models/crawler-crane.json`（特征树数据，设计库与 AI 用的是同一份），
 * 这里用 `addSolid { library: 'crawler-crane' }` 取，等于把「模型库 → 服务端校验 → 求值」整条路走一遍。
 * 运行：npm run crane
 */
import fs from 'node:fs';
import path from 'node:path';
import { Vector3 } from 'three';
import { buildElementModel } from '../src/bim/geometry';
import { createProject } from '../src/bim/template';
import { applyOps } from '../server/ai/ops.js';
import { libraryFeatures } from '../shared/library.js';
import { renderSheet } from './lib/mini-render';

const MODEL = 'crawler-crane';
const NAME = '履带式起重机';
const OUT = 'diagnostics/crane';

fs.mkdirSync(OUT, { recursive: true });

const features = libraryFeatures(MODEL);
const project = createProject({ name: '履带吊实验' });
const json = JSON.stringify(features, (key, value) => (key === 'id' ? undefined : value));

const started = performance.now();
const result = applyOps(project, [
  { op: 'addSolid', name: NAME, library: MODEL, position: [0, 0, 0], color: '#ffffff' },
]);
const appliedMs = performance.now() - started;

const element = result.document.elements[0];
const buildStart = performance.now();
const model = buildElementModel(result.document, element)!;
const buildMs = performance.now() - buildStart;
const { geometry, materials } = model;

geometry.computeBoundingBox();
const box = geometry.boundingBox!;
const size = box.getSize(new Vector3());
const triangles = Math.floor((geometry.index?.count ?? geometry.getAttribute('position').count) / 3);
const numbers = (json.match(/-?\d+(?:\.\d+)?/g) ?? []).length;

console.log(`\n=== ${NAME} ===`);
console.log(`特征数 ${features.length} · 三角面 ${triangles.toLocaleString()} · 特征树 JSON ${(json.length / 1024).toFixed(1)} KB`);
console.log(`applyOps 校验落库 ${appliedMs.toFixed(1)} ms · 几何求值 ${buildMs.toFixed(0)} ms`);
console.log(`坐标/参数数字 ${numbers} 个（整棵树 ≈ ${Math.round(json.length / 3.4)} token）`);
console.log(`包围盒 纵向 ${size.x.toFixed(2)} m · 横向 ${size.y.toFixed(2)} m · 高 ${size.z.toFixed(2)} m`);
console.log(`底面标高 ${box.min.z.toFixed(3)} m（应贴地 0.000）`);

renderSheet(
  geometry,
  materials,
  [
    { name: '整机', azimuth: 34, elevation: 16, zoom: 1.08 },
    { name: '正侧', azimuth: 270, elevation: 4, zoom: 1.05 },
    { name: '正视', azimuth: 0, elevation: 6, zoom: 1.05 },
    { name: '俯视', azimuth: 24, elevation: 58, zoom: 1.02 },
  ],
  `${OUT}/crawler-crane.png`,
  { width: 720, height: 540, columns: 2 },
);
console.log(`图片 ${path.relative(process.cwd(), `${OUT}/crawler-crane.png`)}`);

renderSheet(
  geometry,
  materials,
  [
    // 履带：白色分段履带架、轮盘螺栓孔、支重轮端盖、履带齿
    { name: '履带', azimuth: 306, elevation: 10, focus: [0, -1.39, 0.62], radius: 2.5 },
    { name: '履带端', azimuth: 250, elevation: 8, focus: [1.86, -1.39, 0.68], radius: 1.3 },
    // 车头：流线车身 + 斜切圆角 + 笼式驾驶室
    { name: '车头', azimuth: 322, elevation: 14, focus: [0.4, -0.5, 2.2], radius: 2.9 },
    { name: '车身侧面', azimuth: 268, elevation: 6, focus: [-1.4, 0, 2.0], radius: 4.6 },
    // 变幅液压缸 + 臂根
    { name: '变幅缸', azimuth: 300, elevation: 12, focus: [2.6, 0.3, 3.6], radius: 3.2 },
    // 臂头 + 滑轮 + 起升绳
    { name: '臂头', azimuth: 348, elevation: 10, focus: [12.6, 0, 10.6], radius: 2.2 },
    { name: '吊钩', azimuth: 20, elevation: 6, focus: [12.55, 0, 2.5], radius: 1.2 },
    // 下车俯视：看履带齿是否连成一条带
    { name: '下车俯视', azimuth: 302, elevation: 46, focus: [0, 0, 0.72], radius: 4.4 },
  ],
  `${OUT}/crawler-crane-detail.png`,
  { width: 720, height: 540, columns: 2 },
);
console.log(`图片 ${path.relative(process.cwd(), `${OUT}/crawler-crane-detail.png`)}`);

geometry.dispose();
