/**
 * 古建筑攒尖亭：走一遍真实链路（addSolid → 服务端校验 → 文档 → 求值）并离线出图。
 *
 * 模型本体是 `shared/models/pavilion-hex.json`（特征树数据，设计库与 AI 用的是同一份），
 * 这里用 `addSolid { library: 'pavilion-hex' }` 取，等于把「模型库 → 服务端校验 → 求值」整条路走一遍。
 * 运行：npm run pavilion
 */
import fs from 'node:fs';
import path from 'node:path';
import { Vector3 } from 'three';
import { buildElementModel } from '../src/bim/geometry';
import { createProject } from '../src/bim/template';
import { applyOps } from '../server/ai/ops.js';
import { libraryFeatures } from '../shared/library.js';
import { renderSheet } from './lib/mini-render';

function report(options: { name: string; model: string; out: string; detailed: boolean }) {
  // 只用来统计特征树体积；落库那份由服务端按 library 自己取
  const features = libraryFeatures(options.model);
  const project = createProject({ name: '攒尖亭实验' });
  const json = JSON.stringify(features, (key, value) => (key === 'id' ? undefined : value));

  const started = performance.now();
  const result = applyOps(project, [
    { op: 'addSolid', name: options.name, library: options.model, position: [0, 0, 0], color: '#ffffff' },
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

  console.log(`\n=== ${options.name} ===`);
  console.log(`特征数 ${features.length} · 三角面 ${triangles} · 特征树 JSON ${(json.length / 1024).toFixed(1)} KB`);
  console.log(`applyOps 校验落库 ${appliedMs.toFixed(1)} ms · 几何求值 ${buildMs.toFixed(0)} ms`);
  console.log(`坐标/参数数字 ${numbers} 个（整棵树 ≈ ${Math.round(json.length / 3.4)} token）`);
  console.log(`包围盒 面宽 ${size.x.toFixed(2)} m · 进深 ${size.y.toFixed(2)} m · 高 ${size.z.toFixed(2)} m`);

  renderSheet(
    geometry,
    materials,
    [
      { name: '三视角', azimuth: 38, elevation: 22, zoom: 1.15 },
      { name: '正视', azimuth: 270, elevation: 8, zoom: 1.1 },
      { name: '侧视', azimuth: 0, elevation: 6, zoom: 1.1 },
      { name: '俯视', azimuth: 20, elevation: 62, zoom: 1.05 },
    ],
    options.out,
    { width: 720, height: 480, columns: 2 },
  );
  console.log(`图片 ${path.relative(process.cwd(), options.out)}`);

  if (options.detailed) {
    renderSheet(
      geometry,
      materials,
      [
        { name: '翼角', azimuth: 22, elevation: 14, focus: [2.55, 0.6, 3.75], radius: 1.5 },
        // 斗拱：柱头科就在柱头正上方，平视才看得见坐斗 + 拱 + 散斗这一摞
        { name: '斗拱', azimuth: 6, elevation: -4, focus: [1.9, 0.15, 3.2], radius: 0.9 },
        { name: '屋顶', azimuth: 320, elevation: 34, focus: [0, 0, 4.4], radius: 3.4 },
        // 檐口：瓦当是实心圆饼、滴水是实心舌片，从掠射角看有没有薄片
        { name: '檐口掠射', azimuth: 24, elevation: 7, focus: [2.55, 1.1, 3.42], radius: 1.3 },
        { name: '座凳挂落', azimuth: 300, elevation: 6, focus: [0, -2.1, 1.2], radius: 2.6 },
        { name: '柱础台基', azimuth: 246, elevation: 12, focus: [0, -2.4, 0.5], radius: 2.2 },
      ],
      options.out.replace('.png', '-detail.png'),
      { width: 720, height: 480, columns: 3 },
    );
  }

  geometry.dispose();
}

const OUT = 'diagnostics/pavilion';
fs.mkdirSync(OUT, { recursive: true });
report({ name: '六角攒尖亭', model: 'pavilion-hex', out: `${OUT}/pavilion-hex.png`, detailed: true });
report({ name: '八角攒尖亭', model: 'pavilion-oct', out: `${OUT}/pavilion-oct.png`, detailed: false });
