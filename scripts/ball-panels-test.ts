/**
 * 球面皮革拼块（ballPanels）回归测试：面划分、服务端校验、AI 全链路、真实空隙。
 *
 * 重点验证「缝是真几何」：从球外沿各个方向打射线，第一个交点必须既有
 * 鼓起的皮革面（半径 > radius），也有穿过空隙打到内胆球的点（半径 < radius - thickness）。
 * 贴图 / bumpMap 版不可能同时满足这两条。
 */
import { Mesh, MeshBasicMaterial, Raycaster, Vector3, DoubleSide } from 'three';
import { createProject } from '../src/bim/template';
import { buildElementModel } from '../src/bim/geometry';
import { buildSolidModel } from '../src/bim/solid';
import { checkModelDocument, libraryFeatures, libraryModelIds } from '../shared/library.js';
import { ballPanelLayout, buildBallPanelParts } from '../src/bim/ball-panels';
import { applyOps } from '../server/ai/ops.js';
import { describeShape, normalizeFeature, patchFeature } from '../server/ai/solid.js';
import { listDimensions } from '../shared/dimensions.js';

let passed = 0;
let failed = 0;
function check(name: string, condition: unknown, detail = ''): void {
  if (condition) {
    passed += 1;
    console.log(`  ✓ ${name}`);
  } else {
    failed += 1;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

console.log('面划分');
const pentagons = ballPanelLayout('pentagons');
check('pentagons 是 12 块五边形', pentagons.length === 12 && pentagons.every((f) => f.corners === 5));
check('pentagons 默认 3 块黑皮', pentagons.filter((f) => f.dark).length === 3);
check('pentagons 黑皮互不相邻', pentagons.filter((f) => f.dark).every((f) => f.darkNeighbors === 0));
const classic = ballPanelLayout('classic');
check('classic 是 32 面（12 五 + 20 六）', classic.length === 32
  && classic.filter((f) => f.corners === 5).length === 12
  && classic.filter((f) => f.corners === 6).length === 20);
check('classic 是 12 块黑五边形', classic.filter((f) => f.dark).length === 12
  && classic.filter((f) => f.dark).every((f) => f.corners === 5));
check('classic 黑皮互不相邻', classic.filter((f) => f.dark).every((f) => f.darkNeighbors === 0));

console.log('几何生成');
const parts = buildBallPanelParts({ shape: 'ballPanels', radius: 0.12, layout: 'classic' });
check('输出三块材质槽', parts.length === 3 && parts.every((p) => p.geometry !== null));
check('白皮 / 黑皮 / 缝底都有面', parts.every((p) => (p.geometry?.getAttribute('position').count ?? 0) > 0));
check('所有几何只带 position + normal', parts.every((p) =>
  Object.keys(p.geometry?.attributes ?? {}).sort().join(',') === 'normal,position'));
check('都是 non-indexed 三角形', parts.every((p) => !p.geometry?.index
  && (p.geometry?.getAttribute('position').count ?? 1) % 3 === 0));
for (const part of parts) {
  const normal = part.geometry!.getAttribute('normal');
  let unit = true;
  for (let i = 0; i < normal.count; i += 1) {
    const length = Math.hypot(normal.getX(i), normal.getY(i), normal.getZ(i));
    if (Math.abs(length - 1) > 0.02) { unit = false; break; }
  }
  check(`${part.role} 法线均为单位向量`, unit);
  part.geometry!.dispose();
}

console.log('服务端校验');
const normalized = normalizeFeature({ shape: 'ballPanels', radius: 0.12, layout: 'classic', light: '#f5f2e8' }, 'f1');
const shape = normalized.shape as Record<string, unknown>;
check('默认补齐三套颜色材质', ['light', 'dark', 'core'].every((k) =>
  typeof shape[k] === 'object' && !!shape[k] && typeof (shape[k] as Record<string, unknown>).color === 'string'));
check('light 用上了自定义颜色', (shape.light as Record<string, unknown>).color === '#f5f2e8');
check('segments 96 夹到 64', normalizeFeature({ shape: 'ballPanels', radius: 0.12, segments: 96 }, 'f1').shape.segments === 64);
check('形状摘要可读', describeShape(shape).includes('皮革拼球'));
const withMap = normalizeFeature({
  shape: 'ballPanels', radius: 0.12, light: { color: '#ffffff', map: 'data:image/png;base64,AAAA' },
}, 'f1').shape as Record<string, unknown>;
check('形状材质剥离 map（不让 base64 进历史）',
  !JSON.stringify(withMap).includes('data:image') && !JSON.stringify(withMap).includes('map'));
for (const [label, raw] of [
  ['缝宽过大', { shape: 'ballPanels', radius: 0.12, seam: 0.05 }],
  ['皮厚过大', { shape: 'ballPanels', radius: 0.12, thickness: 0.1 }],
  ['黑块数越界', { shape: 'ballPanels', radius: 0.12, darkCount: 20 }],
  ['颜色非法', { shape: 'ballPanels', radius: 0.12, light: 'not-a-color' }],
  ['半径缺失', { shape: 'ballPanels' }],
] as Array<[string, Record<string, unknown>]>) {
  let rejected = false;
  try { normalizeFeature(raw, 'f1'); } catch { rejected = true; }
  check(`拒绝${label}`, rejected);
}
const patched = patchFeature(normalized, { shape: { light: '#e8d9b0', seam: 0.003 } }, 'f1') as { shape: Record<string, unknown> };
check('editFeature 能改皮革配色与缝宽', (patched.shape.light as Record<string, unknown>).color === '#e8d9b0'
  && patched.shape.seam === 0.003);

console.log('AI 全链路 applyOps → buildElementModel');
const ops = [{
  op: 'addSolid',
  name: '缝制足球',
  color: '#ffffff',
  features: [{ id: 'fb-01', label: '皮革拼球', shape: { shape: 'ballPanels', radius: 0.12, layout: 'classic', seam: 0.0024 } }],
}];
const result = applyOps(createProject({ name: '皮革足球预览' }), ops);
const element = result.document.elements[0];
check('addSolid 生成构件', !!element);
const model = element ? buildElementModel(result.document, element) : null;
check('造型求值成功', !!model);
const geometry = model!.geometry;
const materials = model!.materials;
check('三材质槽颜色正确', materials.length === 3
  && materials.some((m) => m?.color === '#f1eee5')
  && materials.some((m) => m?.color === '#191c22')
  && materials.some((m) => m?.color === '#0b0d10'));
check('groups 指向三个槽', geometry.groups.length === 3);
geometry.computeBoundingBox();
const box = geometry.boundingBox!;
check('包围盒接近球体尺寸', box.max.x > 0.119 && box.max.x < 0.125 && Math.abs(box.min.x + box.max.x) < 0.002,
  `max.x=${box.max.x.toFixed(5)}`);
const position = geometry.getAttribute('position');
let maxRadius = 0;
let minRadius = Infinity;
for (let i = 0; i < position.count; i += 1) {
  const r = Math.hypot(position.getX(i), position.getY(i), position.getZ(i));
  maxRadius = Math.max(maxRadius, r);
  minRadius = Math.min(minRadius, r);
}
check('外表面鼓起到 radius 之上', maxRadius > 0.121, `maxRadius=${maxRadius.toFixed(5)}`);
check('内胆球低于皮革内表面', minRadius < 0.117, `minRadius=${minRadius.toFixed(5)}`);

// 真缝的关键证据：沿各方向从球外射线，第一交点既有鼓起的皮，也有穿过空隙打到内胆的点
const rayGeometry = geometry.clone();
rayGeometry.clearGroups();
const mesh = new Mesh(rayGeometry, new MeshBasicMaterial({ side: DoubleSide }));
mesh.updateMatrixWorld();
const raycaster = new Raycaster();
let hitLeather = 0;
let hitCore = 0;
const rays = 1200;
for (let i = 0; i < rays; i += 1) {
  const y = 1 - (2 * (i + 0.5)) / rays;
  const ring = Math.sqrt(Math.max(0, 1 - y * y));
  const phi = i * 2.399963229728653; // 黄金角，球面均匀采样
  const direction = new Vector3(ring * Math.cos(phi), ring * Math.sin(phi), y).normalize();
  raycaster.set(direction.clone().multiplyScalar(0.5), direction.clone().negate());
  const hit = raycaster.intersectObject(mesh, false)[0];
  if (!hit) continue;
  const radius = hit.point.length();
  if (radius > 0.1205) hitLeather += 1;
  if (radius < 0.1175) hitCore += 1;
}
check('射线能打到鼓起的皮革面', hitLeather > 40, `hitLeather=${hitLeather}`);
check('射线能穿过真实缝打到内胆', hitCore > 8, `hitCore=${hitCore}/${rays}`);
rayGeometry.dispose();

console.log('尺寸驱动');
const dimensionText = JSON.stringify(listDimensions(element!));
check('尺寸面板能列出球半径与缝宽', dimensionText.includes('"f1.radius"')
  && dimensionText.includes('"f1.seam"'));

console.log('模型库');
check('football 已入库', libraryModelIds().includes('football'));
check('模型库文档通过自检', checkModelDocument('football').length === 0,
  checkModelDocument('football').join('；'));
const libraryBuild = buildSolidModel(libraryFeatures('football') as never);
check('模型库特征能求值出三材质槽', libraryBuild.materials.length === 3
  && libraryBuild.geometry.getAttribute('position').count > 0);

console.log(`\n${failed ? '✗ 失败' : '✓ 全部通过'}：${passed} 项通过，${failed} 项失败`);
if (failed) process.exitCode = 1;
