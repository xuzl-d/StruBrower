/**
 * 通用约束演示：**同一个模型，AI 自定义约束，改一个源参数整座楼梯跟着长**。
 *
 * 这个演示刻意不用预置模板 —— 楼梯是现场手写的特征树（底板 + 踏步阵列 + 立柱阵列），
 * 约束是「后加的」：
 *   踏步数   = round((层高 − 板厚) / 0.16)     ← 按 160 mm 左右的踏步高反算级数
 *   踏步高   = (层高 − 板厚) / 踏步数           ← 级数定了，踏步高才定得下来
 *   立柱数   = 踏步数                           ← 每级一根立柱
 *   步距 Y/Z = 0.28 / 踏步高                    ← 阵列要跟着踏步走
 *   校验     = 踏步高 0.14–0.18 m               ← 建筑规范区间，超出只报警不改模型
 *
 * 出图：层高 2.8 / 3.3 / 3.9 三档，同一份特征树、同一组约束。
 * 走真实链路：applyOps → recomputeParameters（约束求值）→ buildElementModel → 离屏软光栅。
 */
import { Box3, Vector3 } from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { buildElementModel } from '../src/bim/geometry';
import { createProject } from '../src/bim/template';
import { applyOps } from '../server/ai/ops.js';
import { recomputeParameters } from '../src/bim/parameters';
import { resolveElementConstraints } from '../src/bim/constraints';
import { readDimension } from '../shared/dimensions.js';
import type { MeshInstance } from '../src/bim/types';
import { renderSheet } from './lib/mini-render';

const TREAD_DEPTH = 0.28;
const BASE_THICKNESS = 0.12;
const BOARD_Y = 0;

/** 手写的楼梯特征树：底板 + 踏步阵列 + 立柱阵列（全部是静态特征，没有任何模板代码） */
function stairFeatures(): unknown[] {
  return [
    {
      shape: 'box', label: '踏步', width: 1.2, depth: TREAD_DEPTH, height: 0.16,
      translate: [0, BOARD_Y + TREAD_DEPTH / 2, BASE_THICKNESS + 0.08],
      pattern: { type: 'linear', count: 20, step: [0, TREAD_DEPTH, 0.16] },
      material: 'wood',
    },
    {
      shape: 'cylinder', label: '立柱', radius: 0.022, height: 0.9,
      translate: [0.55, BOARD_Y + TREAD_DEPTH / 2, BASE_THICKNESS + 0.16 + 0.45],
      pattern: { type: 'linear', count: 20, step: [0, TREAD_DEPTH, 0.16] },
      material: 'steel',
    },
  ];
}

/** 约束定义：全部以「层高」为唯一输入，其余都是派生量 */
const CONSTRAINTS = {
  dimensions: [
    { name: '踏步数', path: 'f1.count' },
    { name: '踏步高', path: 'f1.height' },
    { name: '踏步步距Y', path: 'f1.step.1' },
    { name: '踏步起点Z', path: 'f1.translate.2' },
    { name: '踏步步距Z', path: 'f1.step.2' },
    { name: '立柱数', path: 'f2.count' },
    { name: '立柱起点Z', path: 'f2.translate.2' },
    { name: '立柱步距Z', path: 'f2.step.2' },
  ],
  checks: [
    { expr: '踏步高 >= 0.14', message: '踏步高小于 140 mm，上楼梯容易踩空' },
    { expr: '踏步高 <= 0.18', message: '踏步高大于 180 mm，上楼吃力' },
  ],
};

const FORMULAS = {
  踏步数: `round((层高 - ${BASE_THICKNESS}) / 0.16)`,
  踏步高: `(层高 - ${BASE_THICKNESS}) / 踏步数`,
  踏步步距Y: String(TREAD_DEPTH),
  踏步起点Z: `${BASE_THICKNESS} + 踏步高 / 2`,
  踏步步距Z: '踏步高',
  立柱数: '踏步数',
  立柱起点Z: `${BASE_THICKNESS} + 踏步高 + 0.45`,
  立柱步距Z: '踏步高',
};

interface Variant {
  height: number;
  document: ReturnType<typeof createProject>;
  element: MeshInstance;
  violations: string[];
}

function build(height: number): Variant {
  const project = createProject({ name: `楼梯 ${height}m` });
  const { document } = applyOps(project, [
    { op: 'addSolid', name: `楼梯 ${height}m`, features: stairFeatures(), position: [0, 0, 0] },
  ]);
  const element = document.elements[0] as MeshInstance;
  const constrained: MeshInstance = { ...element, formulas: FORMULAS, constraints: CONSTRAINTS };
  const resolved = resolveElementConstraints(constrained, { 层高: height });
  return {
    height,
    document,
    element: resolved.element,
    violations: resolved.violations.map((item) => item.message),
  };
}

function geometryOf(variant: Variant) {
  const model = buildElementModel(variant.document, variant.element);
  if (!model) throw new Error('求值失败');
  return model;
}

console.log('同一份特征树 + 一组自定义约束，只改「层高」');
console.log('  层高   踏步数  踏步高   外廓高   水平投影   违规');
const variants = [2.8, 3.3, 3.9].map((height) => {
  const variant = build(height);
  const model = geometryOf(variant);
  model.geometry.computeBoundingBox();
  const box = model.geometry.boundingBox ?? new Box3();
  const size = box.getSize(new Vector3());
  const steps = readDimension(variant.element, 'f1.count') ?? 0;
  const riser = readDimension(variant.element, 'f1.height') ?? 0;
  const run = readDimension(variant.element, 'f1.count') ?? 0;
  console.log(
    `  ${height.toFixed(1).padStart(4)} m ${String(Math.round(steps)).padStart(6)} `
    + `${(riser * 1000).toFixed(0).padStart(6)} mm ${size.z.toFixed(2).padStart(6)} m `
    + `${(run * TREAD_DEPTH).toFixed(2).padStart(8)} m   ${variant.violations.length ? variant.violations.join('；') : '无'}`,
  );
  model.geometry.dispose();
  return variant;
});

console.log('\n校验式：把踏步高强行推到规范外，只报警不改模型');
{
  const forced: MeshInstance = {
    ...variants[0]!.element,
    formulas: { ...FORMULAS, 踏步高: '0.22', 立柱步距Z: '踏步高' },
    constraints: CONSTRAINTS,
  };
  const resolved = resolveElementConstraints(forced, { 层高: 2.8 });
  console.log(`  踏步高改为 0.22 m → 踏步高实际 ${(Number(readDimension(resolved.element, 'f1.height')) * 1000).toFixed(0)} mm`);
  for (const item of resolved.violations) console.log(`   · [${item.severity}] ${item.message}`);
}

console.log('\n约束的可读形式');
console.log(`  dimensions: ${CONSTRAINTS.dimensions.map((item) => `${item.name}→${item.path}`).join('  ')}`);
for (const [key, value] of Object.entries(FORMULAS)) console.log(`  ${key.padEnd(6)} = ${value}`);

/* 三个方案并排渲染：合并成一个几何，逐视图取景 */
{
  const geometries = variants.map((variant) => {
    const model = geometryOf(variant);
    return { geometry: model.geometry, materials: model.materials };
  });
  const GAP = 22;
  const shifted = geometries.map((item, index) => {
    const clone = item.geometry.clone();
    clone.translate((index - 1) * GAP, 0, 0);
    return clone;
  });
  const merged = mergeGeometries(shifted, false);
  if (!merged) throw new Error('几何合并失败');
  const materials = geometries[0]!.materials;
  const views = variants.map((variant, index) => ({
    name: `层高 ${variant.height.toFixed(1)} m · ${Math.round(readDimension(variant.element, 'f2.count') ?? 0)} 级`,
    azimuth: 22,
    elevation: 44,
    focus: [(index - 1) * GAP, 2.6, 1.2] as [number, number, number],
    radius: 5.6,
  }));
  renderSheet(merged, materials, views, 'diagnostics/constraints/stair-height.png', {
    width: 560,
    height: 620,
    columns: 3,
  });
  for (const item of geometries) item.geometry.dispose();
  merged.dispose();
  console.log('\n出图：diagnostics/constraints/stair-height.png');
}

/* 规模对比：约束占多少字节 */
{
  const json = JSON.stringify({ dimensions: CONSTRAINTS.dimensions, formulas: FORMULAS, checks: CONSTRAINTS.checks });
  const features = JSON.stringify(stairFeatures());
  console.log(`  约束定义 ${json.length} B（${(json.match(/-?\d+(\.\d+)?/g) ?? []).length} 个数字）`);
  console.log(`  特征树本体 ${(features.length / 1024).toFixed(1)} KB —— 约束只是加了一层关系，没有复制几何`);
}
