/**
 * 用「造型特征树」复现一张参考照片里的客机（A350 级宽体机），检验现有接口表达复杂外形够不够。
 *
 * 模型本体是 `shared/models/aircraft-a350.json`（特征树数据，设计库与 AI few-shot 用的是同一份），
 * 这里只负责：取数据（顺便改成 1:1）→ 走真实链路校验落库 → 求值 → 离线出图 → 统计。
 *
 * 运行：npm run aircraft
 * 输出：diagnostics/aircraft/*.png + 终端统计（特征数 / 三角面 / 特征树体积）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { Vector3 } from 'three';
import { buildElementModel } from '../src/bim/geometry';
import { createProject } from '../src/bim/template';
import { applyOps } from '../server/ai/ops.js';
import { libraryFeatures } from '../shared/library.js';
import type { BimElement } from '../src/bim/types';
import { renderSheet, type RasterDecal } from './lib/mini-render';

const AIRCRAFT_Z = 6; // 整机离地高度（写进 addSolid 的 position）

/**
 * 机身涂装：addDecal 指令（不是特征），1:1 尺寸。
 * 模型库里那份文档是 1:10 的展示模型，涂装不进文档——它是贴在模型外面的独立构件。
 */
function decalOps(scale = 1): Array<Record<string, unknown>> {
  const ops: Array<Record<string, unknown>> = [];
  for (const side of [1, -1]) {
    ops.push({
      op: 'addDecal',
      name: side > 0 ? '机身标题·右' : '机身标题·左',
      text: 'AIRBUS A350',
      width: 8.4 * scale,
      height: 0.95 * scale,
      position: [3.0 * scale, side * 2.99 * scale, AIRCRAFT_Z + 0.55 * scale],
      normal: side > 0 ? 'y' : '-y',
      color: '#1c3f74',
    });
    ops.push({
      op: 'addDecal',
      name: side > 0 ? '垂尾字样·右' : '垂尾字样·左',
      text: 'A350',
      width: 2.3 * scale,
      height: 0.8 * scale,
      position: [-22.6 * scale, side * 0.45 * scale, AIRCRAFT_Z + 8.6 * scale],
      normal: side > 0 ? 'y' : '-y',
      color: '#ffffff',
    });
  }
  return ops;
}

/**
 * 走一遍真实链路：addSolid / addDecal → 服务端 applyOps 校验 → 文档 → buildElementModel 求值。
 * 和用户在 AI 面板点「应用到模型」完全一致，只是不经过 HTTP/权限层。
 */
function report(name: string, detail: 'high' | 'low', outPath: string) {
  // 文档按 1:10 建模（根特征 scale = 0.1）；这里要看真机尺度，把根 scale 提到 1、离地高度同比放大
  const features = libraryFeatures('aircraft-a350');
  const root = features[0];
  const bakedScale = root.scale ?? 1;
  root.scale = 1;
  root.translate = [root.translate?.[0] ?? 0, root.translate?.[1] ?? 0, (root.translate?.[2] ?? 0) / bakedScale];
  const decals = detail === 'high' ? decalOps(1) : [];
  const project = createProject({ name: 'A350 实验' });
  // 统计 token 时去掉 id：真实模型不会写 id，服务端会补；带上 id 会虚高 ~10%
  const json = JSON.stringify({ features, decals }, (key, value) => (key === 'id' ? undefined : value));

  const started = performance.now();
  const result = applyOps(project, [
    { op: 'addSolid', name: 'A350-900', features, position: [0, 0, AIRCRAFT_Z], color: '#eef2f5' },
    ...decals,
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

  // 贴花：取平面四角的投影四边形，交给预览渲染器画文字
  const decalQuads: RasterDecal[] = [];
  for (const item of result.document.elements.slice(1)) {
    const spec = (item as BimElement & { primitive?: { kind?: string; text?: string; color?: string } }).primitive;
    if (spec?.kind !== 'decal' || !spec.text) continue;
    const plane = buildElementModel(result.document, item)?.geometry;
    if (!plane) continue;
    const position = plane.getAttribute('position');
    const corners = [0, 1, 2, 3].map(
      (i) => [position.getX(i), position.getY(i), position.getZ(i)] as [number, number, number],
    );
    decalQuads.push({ corners, text: spec.text, color: spec.color });
    plane.dispose();
  }

  const numbers = (json.match(/-?\d+(?:\.\d+)?/g) ?? []).length;
  console.log(`\n=== ${name} ===`);
  console.log(`特征数 ${features.length} + 贴花 ${decals.length} · 三角面 ${triangles} · 特征树 JSON ${(json.length / 1024).toFixed(1)} KB`);
  console.log(`applyOps 校验落库 ${appliedMs.toFixed(0)} ms · 几何求值 ${buildMs.toFixed(0)} ms`);
  console.log(`坐标/参数数字 ${numbers} 个（整棵树 ≈ ${Math.round(json.length / 3.4)} token）`);
  console.log(`包围盒 长 ${size.x.toFixed(2)} m · 翼展 ${size.y.toFixed(2)} m · 高 ${size.z.toFixed(2)} m`);

  renderSheet(
    geometry,
    materials,
    [
      { name: '三视角', azimuth: 28, elevation: 15, zoom: 1.42 },
      { name: '侧视', azimuth: 90, elevation: 2, zoom: 1.42 },
      { name: '前视', azimuth: 6, elevation: 6, zoom: 1.3 },
      { name: '俯视', azimuth: 10, elevation: 80, zoom: 1.32 },
    ],
    outPath,
    { width: 720, height: 480, columns: 2, decals: decalQuads },
  );
  console.log(`图片 ${path.relative(process.cwd(), outPath)}`);

  const dz = element.offset?.[2] ?? 0;
  renderSheet(
    geometry,
    materials,
    [
      { name: '机头', azimuth: 34, elevation: 12, focus: [29.5, 0, dz + 0.4], radius: 6.5 },
      { name: '短舱', azimuth: 42, elevation: 8, focus: [8.2, -5.9, dz - 3.35], radius: 7 },
      { name: '尾翼', azimuth: 88, elevation: 4, focus: [-27, 0, dz + 5], radius: 13 },
      { name: '涂装', azimuth: 118, elevation: 8, focus: [2, 0, dz + 0.6], radius: 9 },
    ],
    outPath.replace('.png', '-detail.png'),
    { width: 720, height: 480, columns: 2, decals: decalQuads },
  );

  geometry.dispose();
}

const OUT = 'diagnostics/aircraft';
fs.mkdirSync(OUT, { recursive: true });
// 模型只有一份（数据里存的就是高细节那版），这里出 1:1 比例 + 贴花的总图与细节
report('A350 模型（1:1，含贴花）', 'high', `${OUT}/aircraft-high.png`);
