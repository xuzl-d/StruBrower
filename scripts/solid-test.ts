/**
 * 特征造型内核断言（npm test 会跑）。
 * 只依赖 three 的几何计算，不需要 WebGL。
 */
import { Vector3 } from 'three';
import { buildSolidGeometry, buildSolidModel, countSolidFeatures, solidFeatureGroups, updateSolidFeatureField } from '../src/bim/solid';
import { libraryFeatures } from '../shared/library.js';
import { buildPrimitiveGeometry } from '../src/bim/primitives';
import { normalizeFeatures } from '../server/ai/solid.js';
import { applyOps } from '../server/ai/ops.js';
import { createProject } from '../src/bim/template';
import type { SolidFeature } from '../src/bim/types';

let passed = 0;
const failures: string[] = [];

function check(name: string, condition: boolean, detail = ''): void {
  if (condition) {
    passed += 1;
    console.log(`  ✓ ${name}`);
    return;
  }
  failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
  console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
}

function near(a: number, b: number, tolerance = 1e-3): boolean {
  return Math.abs(a - b) <= tolerance;
}

function triangles(features: SolidFeature[]): number {
  const geometry = buildSolidGeometry(features);
  const count = Math.floor((geometry.index?.count ?? geometry.getAttribute('position').count) / 3);
  geometry.dispose();
  return count;
}

/** 有向体积：> 0 说明三角形绕序一致朝外（镜像后最容易翻车的地方） */
function signedVolume(geometry: any): number {
  const position = geometry.getAttribute('position');
  const index = geometry.index;
  const at = (i: number) => (index ? index.getX(i) : i);
  const count = index ? index.count : position.count;
  let volume = 0;
  for (let i = 0; i + 2 < count; i += 3) {
    const a = at(i);
    const b = at(i + 1);
    const c = at(i + 2);
    const ax = position.getX(a), ay = position.getY(a), az = position.getZ(a);
    const bx = position.getX(b), by = position.getY(b), bz = position.getZ(b);
    const cx = position.getX(c), cy = position.getY(c), cz = position.getZ(c);
    volume += (ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx)) / 6;
  }
  return volume;
}

function bounds(features: SolidFeature[]) {
  const geometry = buildSolidGeometry(features);
  geometry.computeBoundingBox();
  const box = geometry.boundingBox;
  const result = box
    ? { min: [box.min.x, box.min.y, box.min.z], max: [box.max.x, box.max.y, box.max.z] }
    : null;
  geometry.dispose();
  return result;
}

console.log('造型特征：基本形状');
{
  const box = buildPrimitiveGeometry({
    kind: 'solid',
    features: [{ id: 'a', shape: { shape: 'box', width: 0.4, depth: 0.2, height: 0.1 } }],
  });
  box.computeBoundingBox();
  const b = box.boundingBox!;
  check('长方体尺寸正确', near(b.max.x - b.min.x, 0.4) && near(b.max.z - b.min.z, 0.1));
  check('长方体 12 个三角形', (box.index?.count ?? box.getAttribute('position').count) / 3 === 12);
  check('长方体 XY 居中', near((b.max.x + b.min.x) / 2, 0) && near((b.max.y + b.min.y) / 2, 0));
  box.dispose();

  const cylinder = buildSolidGeometry([{ id: 'b', shape: { shape: 'cylinder', radius: 0.1, height: 0.3, segments: 32 } }]);
  cylinder.computeBoundingBox();
  const c = cylinder.boundingBox!;
  check('圆柱轴向为 Z', near(c.max.z - c.min.z, 0.3, 1e-6) && near(c.max.x, 0.1, 1e-6));
  cylinder.dispose();

  const prism = buildSolidGeometry([{
    id: 'c',
    shape: { shape: 'prism', profile: [[-0.1, -0.05], [0.1, -0.05], [0.1, 0.05], [-0.1, 0.05]], height: 0.2, twist: 30, taper: 0.5 },
  }]);
  prism.computeBoundingBox();
  const p = prism.boundingBox!;
  check('扭转拉伸高度正确', near(p.max.z - p.min.z, 0.2, 1e-6));
  check('扭转拉伸顶面收窄', p.max.x < 0.11);
  prism.dispose();

  const revolve = buildSolidGeometry([{
    id: 'd',
    shape: { shape: 'revolve', profile: [[0, 0], [0.08, 0], [0.05, 0.2], [0, 0.2]], segments: 48 },
  }]);
  revolve.computeBoundingBox();
  const r = revolve.boundingBox!;
  check('旋转体半径与高度正确', near(r.max.x, 0.08, 2e-3) && near(r.max.z - r.min.z, 0.2, 1e-6));
  revolve.dispose();

  const loft = buildSolidGeometry([{
    id: 'e',
    shape: {
      shape: 'loft',
      sections: [
        { z: 0, profile: [[-0.1, -0.1], [0.1, -0.1], [0.1, 0.1], [-0.1, 0.1]] },
        { z: 0.2, profile: [[-0.03, -0.03], [0.03, -0.03], [0.03, 0.03], [-0.03, 0.03]] },
      ],
    },
  }]);
  check('放样生成实体', (loft.getAttribute('position').count / 3) > 8);
  loft.computeBoundingBox();
  check('放样高度正确', near(loft.boundingBox!.max.z - loft.boundingBox!.min.z, 0.2, 1e-6));
  loft.dispose();

  const sweepPath: Array<[number, number, number]> = [[0, 0, 0], [0.1, 0, 0.05], [0.2, 0, 0.2]];
  const circle = Array.from({ length: 12 }, (_, index) => {
    const angle = (index / 12) * Math.PI * 2;
    return [Math.cos(angle) * 0.02, Math.sin(angle) * 0.02] as [number, number];
  });
  const sweep = buildSolidGeometry([{ id: 'f', shape: { shape: 'sweep', profile: circle, path: sweepPath } }]);
  sweep.computeBoundingBox();
  check('扫掠沿路径延伸', sweep.boundingBox!.max.z > 0.15 && sweep.getAttribute('position').count > 0);
  sweep.dispose();
}

console.log('造型特征：精细形状（圆角 / 管 / 胶囊 / 椭球 / 凸包）');
{
  const measure = (features: SolidFeature[]) => {
    const geometry = buildSolidGeometry(features);
    geometry.computeBoundingBox();
    const box = geometry.boundingBox!;
    const result = {
      size: [box.max.x - box.min.x, box.max.y - box.min.y, box.max.z - box.min.z] as [number, number, number],
      triangles: geometry.getAttribute('position').count / 3,
      geometry,
    };
    return result;
  };

  const rounded = measure([{
    id: 'rb',
    shape: { shape: 'roundedBox', width: 0.26, depth: 0.18, height: 0.05, radius: 0.012, segments: 40 },
  }]);
  check('圆角盒外形尺寸不变', near(rounded.size[0], 0.26, 2e-3) && near(rounded.size[2], 0.05, 2e-3), rounded.size.map((v) => v.toFixed(3)).join('×'));
  check('圆角盒细分足够（不是 12 面的方块）', rounded.triangles > 800, `${rounded.triangles}`);
  const normal = rounded.geometry.getAttribute('normal');
  check('圆角盒法线平滑（非法线为 0）', Number.isFinite(normal.getX(10)) && Math.abs(normal.getY(10)) + Math.abs(normal.getZ(10)) > 0);
  rounded.geometry.dispose();

  // 薄板大倒圆：6mm 厚顶盖配 20mm 圆角是常规做法，倒圆只按平面尺寸归一，不能被板厚压成尖角
  const plate = measure([{
    id: 'pl',
    shape: { shape: 'roundedBox', width: 0.2, depth: 0.16, height: 0.006, radius: 0.02, segments: 32 },
  }]);
  check('薄板外形尺寸不变', near(plate.size[0], 0.2, 2e-3) && near(plate.size[1], 0.16, 2e-3) && near(plate.size[2], 0.006, 1e-3),
    plate.size.map((v) => v.toFixed(4)).join('×'));
  check('薄板大倒圆有足够细分', plate.triangles > 400, `${plate.triangles}`);
  plate.geometry.dispose();

  // 圆角盒必须是「平面 + 棱边倒圆」，不能是超椭球那种整块胖起来的蛋形：
  // 判据是侧壁（y≈±b）上顶点的 x 跨度 —— 超椭球只有 x≈0 一个点，真圆角盒有一整条直边。
  {
    const boxHalf = { a: 0.13, b: 0.09, c: 0.025, r: 0.012 };
    const geometry = buildSolidGeometry([{
      id: 'flat', shape: { shape: 'roundedBox', width: 0.26, depth: 0.18, height: 0.05, radius: 0.012, segments: 40 },
    }]);
    const position = geometry.getAttribute('position');
    let sideSpan = 0;
    let topSpan = 0;
    for (let i = 0; i < position.count; i += 1) {
      const x = Math.abs(position.getX(i));
      const y = Math.abs(position.getY(i));
      const z = Math.abs(position.getZ(i));
      if (y > boxHalf.b - 1e-4) sideSpan = Math.max(sideSpan, x);
      if (z > boxHalf.c - 1e-4) topSpan = Math.max(topSpan, x);
    }
    check('圆角盒侧面是平的（不是蛋形截面）', sideSpan > boxHalf.a - 4 * boxHalf.r, sideSpan.toFixed(4));
    check('圆角盒顶面是平面，只缩进一个倒圆', topSpan > boxHalf.a - boxHalf.r - 1e-3 && topSpan <= boxHalf.a + 1e-6, topSpan.toFixed(4));
    geometry.dispose();
  }

  const tube = measure([{ id: 'tb', shape: { shape: 'tube', radius: 0.02, thickness: 0.004, height: 0.3, segments: 32 } }]);
  check('圆管外径与高度正确', near(tube.size[0], 0.04, 2e-3) && near(tube.size[2], 0.3, 1e-6));
  check('圆管有内壁（三角数明显多于实心圆柱）', tube.triangles > 32 * 6, `${tube.triangles}`);
  tube.geometry.dispose();

  const capsule = measure([{ id: 'cp', shape: { shape: 'capsule', radius: 0.02, height: 0.14, segments: 32 } }]);
  check('胶囊总高等于 height', near(capsule.size[2], 0.14, 2e-3), capsule.size[2].toFixed(4));
  check('胶囊直径等于 2×radius', near(capsule.size[0], 0.04, 2e-3));
  capsule.geometry.dispose();

  const ellipsoid = measure([{ id: 'el', shape: { shape: 'ellipsoid', rx: 0.1, ry: 0.06, rz: 0.03, segments: 32 } }]);
  check('椭球三轴独立', near(ellipsoid.size[0], 0.2, 2e-3) && near(ellipsoid.size[1], 0.12, 2e-3) && near(ellipsoid.size[2], 0.06, 2e-3));
  ellipsoid.geometry.dispose();

  const hull = measure([{
    id: 'hl',
    shape: { shape: 'hull', points: [[0, 0, 0], [0.2, 0, 0], [0, 0.1, 0], [0, 0, 0.05], [0.2, 0.1, 0.05], [0.1, 0.05, 0.1]] },
  }]);
  check('凸包包住点集', hull.size[0] > 0.19 && hull.size[2] > 0.09 && hull.triangles >= 4, `${hull.triangles}`);
  hull.geometry.dispose();

  // 变截面扫掠：末端 taper 越小，末端截面越细
  const tapered = measure([{
    id: 'sw',
    shape: {
      shape: 'sweep',
      profile: [[-0.02, -0.02], [0.02, -0.02], [0.02, 0.02], [-0.02, 0.02]],
      path: [[0, 0, 0], [0.1, 0, 0], [0.2, 0, 0]],
      taper: [1, 0.3],
    },
  }]);
  check('扫掠支持变截面（taper）', near(tapered.size[1], 0.04, 3e-3), tapered.size[1].toFixed(4));
  tapered.geometry.dispose();
}

console.log('造型特征：布尔与阵列');
{
  const base: SolidFeature = { id: 'g', shape: { shape: 'box', width: 0.2, depth: 0.2, height: 0.2 } };
  const cut = buildSolidGeometry([
    base,
    { id: 'h', mode: 'cut', shape: { shape: 'cylinder', radius: 0.05, height: 0.4, segments: 24 } },
  ]);
  cut.computeBoundingBox();
  check('切除不改变外轮廓', near(cut.boundingBox!.max.x, 0.1));
  check('切除后三角数增加', cut.getAttribute('position').count / 3 > 12);
  cut.dispose();

  const intersect = buildSolidGeometry([
    { id: 'i', shape: { shape: 'box', width: 0.2, depth: 0.2, height: 0.2 } },
    { id: 'j', mode: 'intersect', shape: { shape: 'sphere', radius: 0.2, segments: 16 }, translate: [0, 0, 0.1] },
  ]);
  intersect.computeBoundingBox();
  check('相交结果被两个体量裁剪', intersect.boundingBox!.max.z <= 0.101);
  intersect.dispose();

  const pattern = buildSolidGeometry([{
    id: 'k',
    shape: { shape: 'cylinder', radius: 0.02, height: 0.05, segments: 12 },
    translate: [0.2, 0, 0],
    pattern: { type: 'circular', count: 4, axis: 'z', angle: 360 },
  }]);
  pattern.computeBoundingBox();
  check('圆周阵列 4 份分布到四周', near(pattern.boundingBox!.min.x, -0.22, 1e-3) && near(pattern.boundingBox!.max.y, 0.22, 1e-3));
  pattern.dispose();

  const linear = buildSolidGeometry([{
    id: 'l',
    shape: { shape: 'box', width: 0.02, depth: 0.02, height: 0.02 },
    pattern: { type: 'linear', count: 5, step: [0.05, 0, 0] },
  }]);
  linear.computeBoundingBox();
  check('线性阵列按步距排列', near(linear.boundingBox!.max.x, 0.21, 1e-3));
  linear.dispose();

  const group = buildSolidGeometry([{
    id: 'm',
    shape: {
      shape: 'group',
      features: [
        { id: 'm1', shape: { shape: 'box', width: 0.1, depth: 0.1, height: 0.02 } },
        { id: 'm2', shape: { shape: 'cylinder', radius: 0.02, height: 0.05, segments: 12 }, translate: [0, 0, 0.03] },
      ],
    },
    pattern: { type: 'circular', count: 4, axis: 'z', angle: 360 },
    translate: [0.2, 0, 0],
  }]);
  group.computeBoundingBox();
  check('子装配整体阵列', near(group.boundingBox!.min.x, -0.25, 2e-2) && group.boundingBox!.max.z > 0.05);
  group.dispose();
}

console.log('造型特征：模板');
{
  const drone = libraryFeatures('quadcopter');
  const droneTriangles = triangles(drone);
  const droneBounds = bounds(drone)!;
  check('无人机特征数 ≥ 8', countSolidFeatures(drone) >= 8, `${countSolidFeatures(drone)}`);
  check('无人机用到了精细形状（圆角盒 / 圆管 / 胶囊 / 放样 / 扫掠）', (() => {
    const kinds = new Set<string>();
    const walk = (features: SolidFeature[]) => {
      for (const feature of features) {
        kinds.add(feature.shape.shape);
        if (feature.shape.shape === 'group') walk(feature.shape.features);
      }
    };
    walk(drone);
    return ['roundedBox', 'tube', 'capsule', 'loft', 'sweep', 'revolve'].every((kind) => kinds.has(kind));
  })(), '');
  check('无人机三角数在合理区间', droneTriangles > 3000 && droneTriangles < 200000, `${droneTriangles}`);
  check('无人机左右对称', near(droneBounds.min[0], -droneBounds.max[0], 5e-3) && near(droneBounds.min[1], -droneBounds.max[1], 5e-3),
    `${droneBounds.min.map((v) => v.toFixed(3)).join(',')} / ${droneBounds.max.map((v) => v.toFixed(3)).join(',')}`);
  check('无人机整体包络约 0.66 m（含桨叶外沿）', near(droneBounds.max[0], 0.33, 4e-2), `${droneBounds.max[0].toFixed(3)}`);
  check('无人机有起落架（低于机身）', droneBounds.min[2] < -0.03, `${droneBounds.min[2].toFixed(3)}`);
  check('无人机旋翼高于机身', droneBounds.max[2] > 0.07, `${droneBounds.max[2].toFixed(3)}`);

  // 切除特征的回归：BVH CSG 下切 11 个孔不应把网格炸成几万面
  const withoutCuts = triangles(drone.filter((feature) => feature.mode !== 'cut'));
  check('切除特征不会让网格爆炸（< 2 倍）', droneTriangles < withoutCuts * 2, `${withoutCuts} → ${droneTriangles}`);
  check('切除后外形不塌陷', near(droneBounds.max[0], bounds(drone.filter((feature) => feature.mode !== 'cut'))!.max[0], 1e-3));

  check('L 型支架有安装孔切除', triangles(libraryFeatures('bracket')) > 12);
  check('齿轮有 12 齿', countSolidFeatures(libraryFeatures('gear')) >= 4 && triangles(libraryFeatures('gear')) > 200);
  check('花瓶是旋转体', triangles(libraryFeatures('vase')) > 100);
  check('弯管是扫掠体', triangles(libraryFeatures('pipe')) > 100);
}

console.log('造型特征：字段编辑与边界');
{
  const feature: SolidFeature = { id: 'n', shape: { shape: 'box', width: 0.2, depth: 0.2, height: 0.2 } };
  const wider = updateSolidFeatureField(feature, 'shape.width', 0.6);
  check('改宽度生效', wider.shape.shape === 'box' && (wider.shape as { width: number }).width === 0.6);
  check('不改原对象', (feature.shape as { width: number }).width === 0.2);

  const moved = updateSolidFeatureField(feature, 'translate.z', 1.5);
  check('改位置生效', moved.translate?.[2] === 1.5);

  const segments = updateSolidFeatureField(
    { id: 'o', shape: { shape: 'cylinder', radius: 0.05, height: 0.1, segments: 24 } },
    'shape.segments',
    999,
  );
  check('分段数被限制到 64', segments.shape.shape === 'cylinder' && (segments.shape as { segments: number }).segments === 64);

  const tiny = updateSolidFeatureField(feature, 'shape.width', 0);
  check('尺寸不允许为 0', (tiny.shape as { width: number }).width >= 0.001);

  const fields = solidFeatureGroups({
    id: 'p',
    shape: { shape: 'cylinder', radius: 0.05, height: 0.1, segments: 16 },
    pattern: { type: 'circular', count: 4, angle: 360 },
  });
  check('字段分组包含尺寸/位置/旋转/阵列', fields.length === 4 && fields.some((group) => group.title === '圆周阵列'));

  check('空特征树返回空几何', buildSolidGeometry([]).getAttribute('position') === undefined
    || buildSolidGeometry([]).getAttribute('position').count === 0);

  const huge = buildSolidGeometry([{
    id: 'q',
    shape: { shape: 'box', width: 0.01, depth: 0.01, height: 0.01 },
    pattern: { type: 'linear', count: 9999, step: [0.02, 0, 0] },
  }]);
  huge.computeBoundingBox();
  check('阵列数量被限制', huge.boundingBox!.max.x < 0.01 + 0.02 * 192 + 0.01);
  huge.dispose();
}

console.log('造型特征：AI 指令 → 服务端校验 → 内核求值');
{
  // AI 不写代码、也不二次编译：模型返回特征树 JSON，服务端 normalizeFeatures 校验后原样存进文档。
  // 这里验证「服务端校验过的特征树」能被前端内核直接求值，和模板库里的同一台无人机结果一致。
  const serverFeatures = normalizeFeatures(libraryFeatures('quadcopter'), 'features');
  check('校验后补齐特征 id', serverFeatures.every((feature) => typeof feature.id === 'string' && feature.id.length > 0));
  check('校验后补齐分段默认值', serverFeatures.find((feature) => feature.label === '机身') !== undefined);
  const shape = (serverFeatures.find((feature) => feature.label === '机身') as { shape: { width: number; shape: string } }).shape;
  check('机身尺寸保持不变', near(shape.width, 0.26, 1e-9) && shape.shape === 'roundedBox');

  const serverTriangles = triangles(serverFeatures as unknown as SolidFeature[]);
  check('校验后仍能求值出实体', serverTriangles > 3000, `${serverTriangles}`);
  const serverBounds = bounds(serverFeatures as unknown as SolidFeature[])!;
  check('校验后左右对称', near(serverBounds.min[0], -serverBounds.max[0], 5e-3));
  check('校验后整体包络与模板一致（0.66 m 含桨叶）', near(serverBounds.max[0], 0.33, 4e-2), `${serverBounds.max[0].toFixed(3)}`);

  const rejects = [
    { features: [{ shape: { shape: 'trapezoid' } }], name: '未知形状' },
    { features: [{ shape: { shape: 'box', width: 0, depth: 1, height: 1 } }], name: '尺寸为 0' },
    { features: [{ shape: { shape: 'prism', profile: [[0, 0], [1, 0]], height: 1 } }], name: '轮廓点不足' },
    { features: [{ shape: { shape: 'box', width: 1, depth: 1, height: 1 }, pattern: { type: 'spiral', count: 4 } }], name: '未知阵列' },
    { features: [{ shape: { shape: 'roundedBox', width: 0.1, depth: 0.1, height: 0.1, radius: 0.2 } }], name: '倒圆半径大于半边长' },
    { features: [{ shape: { shape: 'tube', radius: 0.02, thickness: 0.05, height: 0.1 } }], name: '壁厚大于半径' },
    { features: [{ shape: { shape: 'hull', points: [[0, 0, 0], [1, 0, 0], [0, 1, 0]] } }], name: '凸包点太少' },
  ];
  for (const item of rejects) {
    let rejected = false;
    try {
      normalizeFeatures(item.features);
    } catch {
      rejected = true;
    }
    check(`拒绝${item.name}`, rejected);
  }

  // 精细形状也要能过服务端校验
  const detailed = normalizeFeatures([
    { shape: { shape: 'roundedBox', width: 0.2, depth: 0.16, height: 0.08, radius: 0.01, segments: 40 } },
    { shape: { shape: 'tube', radius: 0.02, thickness: 0.004, height: 0.3, segments: 24 } },
    { shape: { shape: 'capsule', radius: 0.02, height: 0.12, segments: 24 } },
    { shape: { shape: 'ellipsoid', rx: 0.08, ry: 0.05, rz: 0.03, segments: 24 } },
    { shape: { shape: 'hull', points: [[0, 0, 0], [0.1, 0, 0], [0, 0.1, 0], [0, 0, 0.1]] } },
    { shape: { shape: 'sweep', profile: [[-0.01, -0.01], [0.01, -0.01], [0.01, 0.01], [-0.01, 0.01]], path: [[0, 0, 0], [0.05, 0, 0.05]], taper: [1, 0.5] } },
  ], 'features');
  check('服务端接受全部精细形状', detailed.length === 6);
  check('服务端保留 sweep taper', (detailed[5].shape as { taper?: number[] }).taper?.[1] === 0.5);
}

console.log('造型材质：逐零件材质分组');
{
  // 单材质：不需要分组，材质表只有一项
  const single = buildSolidModel([{
    id: 'm1',
    shape: { shape: 'box', width: 0.1, depth: 0.1, height: 0.1 },
    material: { name: '红漆', color: '#cc3322', roughness: 0.4, metalness: 0.1 },
  }]);
  check('单材质只占一个材质槽', single.materials.length === 1, `${single.materials.length}`);
  check('单材质颜色生效', single.materials[0]?.color === '#cc3322');
  single.geometry.dispose();

  // 两种材质：几何被切成两个 group，各自指向自己的材质
  const two = buildSolidModel([
    { id: 'm2', shape: { shape: 'box', width: 0.1, depth: 0.1, height: 0.1 }, material: { color: '#112233' } },
    {
      id: 'm3',
      shape: { shape: 'sphere', radius: 0.05, segments: 16 },
      translate: [0.2, 0, 0],
      material: { color: '#ddeeff', metalness: 0.9 },
    },
  ]);
  check('两种材质占两个材质槽', two.materials.length === 2, `${two.materials.length}`);
  check('几何按材质切成 2 个 group', two.geometry.groups.length === 2, `${two.geometry.groups.length}`);
  const indices = two.geometry.groups.map((group) => group.materialIndex);
  check('group 的 materialIndex 指向有效材质槽', indices.every((index) => index >= 0 && index < two.materials.length), indices.join(','));
  check('两种材质都覆盖到几何', two.geometry.groups.every((group) => group.count > 0));
  two.geometry.dispose();

  // 相同材质复用同一个槽（否则每加一个零件就多一个材质）
  const same = buildSolidModel([
    { id: 'm4', shape: { shape: 'box', width: 0.1, depth: 0.1, height: 0.1 }, material: 'aluminum' },
    { id: 'm5', shape: { shape: 'box', width: 0.1, depth: 0.1, height: 0.1 }, translate: [0.2, 0, 0], material: 'aluminum' },
  ]);
  check('相同材质共用一个槽', same.materials.length === 1, `${same.materials.length}`);
  same.geometry.dispose();

  // 子装配：父级材质作为默认，子特征自己写的材质优先
  const grouped = buildSolidModel([{
    id: 'm6',
    material: { name: '铝', color: '#b9c2cb', metalness: 0.92 },
    shape: {
      shape: 'group',
      features: [
        { id: 'm6a', shape: { shape: 'cylinder', radius: 0.02, height: 0.04, segments: 16 } },
        { id: 'm6b', shape: { shape: 'cylinder', radius: 0.01, height: 0.06, segments: 16 }, material: { color: '#101010', roughness: 0.9 } },
      ],
    },
  }]);
  check('子装配保留子特征材质（父级材质 + 子级覆盖）', grouped.materials.length === 2, `${grouped.materials.length}`);
  check('子装配仍然是 2 段几何', grouped.geometry.groups.length === 2, `${grouped.geometry.groups.length}`);
  grouped.geometry.dispose();

  // 切除特征不该把材质刷掉
  const cut = buildSolidModel([
    { id: 'm7', shape: { shape: 'box', width: 0.2, depth: 0.2, height: 0.1 }, material: { color: '#445566' } },
    { id: 'm8', mode: 'cut', shape: { shape: 'cylinder', radius: 0.03, height: 0.4, segments: 16 }, translate: [0, 0, 0.05] },
  ]);
  check('切除后材质仍然保留', cut.materials.length === 1 && cut.materials[0]?.color === '#445566');
  cut.geometry.dispose();

  // 服务端：预设展开 / 非法值拒绝 / 自定义颜色
  const server = normalizeFeatures([
    { shape: { shape: 'box', width: 0.1, depth: 0.1, height: 0.1 }, material: 'aluminum' },
    { shape: { shape: 'sphere', radius: 0.05, material: { name: '哑光白', color: '#eef2f5', roughness: 0.5, metalness: 0.05 } } },
    // 扁平写法：material 不能被当成形状参数塞进 shape
    { shape: 'box', width: 0.05, depth: 0.05, height: 0.05, material: 'rubber' },
  ], 'features');
  check('服务端把预设展开成完整参数', server[0].material?.color === '#b9c2cb' && server[0].material?.metalness === 0.92, JSON.stringify(server[0].material));
  check('服务端保留自定义材质', server[1].material?.name === '哑光白' && server[1].material?.roughness === 0.5);
  check('扁平写法不会把 material 当成形状字段', !('material' in (server[2].shape as unknown as Record<string, unknown>)));
  check('预设展开后带上显示名', server[2].material?.name === '橡胶', server[2].material?.name);

  const materialRejects = [
    { material: { color: 'red' }, name: '非十六进制颜色' },
    { material: { preset: 'unobtainium' }, name: '未知预设' },
    { material: { metalness: 3 }, name: '金属度越界' },
    { material: { opacity: 0 }, name: '不透明度为 0' },
  ];
  for (const item of materialRejects) {
    let rejected = false;
    try {
      normalizeFeatures([{ shape: { shape: 'box', width: 0.1, depth: 0.1, height: 0.1 }, material: item.material }]);
    } catch {
      rejected = true;
    }
    check(`拒绝${item.name}`, rejected);
  }
}

console.log('整机构图：一体化电动螺丝刀模板');
{
  const features = libraryFeatures('screwdriver');
  const geometry = buildSolidGeometry(features);
  geometry.computeBoundingBox();
  const box = geometry.boundingBox!;
  const size = [box.max.x - box.min.x, box.max.y - box.min.y, box.max.z - box.min.z];
  const tri = Math.floor((geometry.index?.count ?? geometry.getAttribute('position').count) / 3);
  geometry.dispose();
  check('整机是一条特征树（14 个特征）', features.length === 14, `${features.length}`);
  check('11 个添加特征 + 3 个切除特征', features.filter((f) => (f.mode ?? 'add') === 'add').length === 11);
  check('三个切除特征（分瓣缝 / 六角孔 / 散热槽）', features.filter((f) => f.mode === 'cut').length === 3);
  const materials = new Set(features.map((f) => (typeof f.material === 'string' ? f.material : f.material?.color)));
  check('零件用 6 种以上材质', materials.size >= 6, `${materials.size}`);
  check('包围盒总长 ≈ 23.6 cm（含后倾伸出的握把）', near(size[0], 0.236, 0.012), size[0].toFixed(3));
  check('总高 ≈ 17 cm（握把真的往下伸）', size[2] > 0.15 && size[2] < 0.19, size[2].toFixed(3));
  check('机身是扁截面（宽 62 > 厚 48）', size[1] < 0.07 && size[1] > 0.055, size[1].toFixed(3));
  check('网格足够细（> 8000 三角形）', tri > 8000, `${tri}`);
  const grip = features.find((f) => f.id === 'sd-grip');
  check('握把按轴向倾斜 20°，不是竖直向下', grip?.rotate?.[1] === 20);
  // 握把中心必须落在「根部 + 0.5×长度×轴向」上，否则会与机身脱开
  const [gx, , gz] = grip?.translate ?? [0, 0, 0];
  check('握把中心与倾斜轴一致', near(gx, -0.0705, 2e-3) && near(gz, -0.0644, 2e-3), `${gx},${gz}`);
}

console.log('参数化截面（椭圆 / 翼型）与镜像');
{
  // 椭圆放样：机身这种外形过去要手写 22×32 个坐标，现在每段 3 个数字
  const ellipse = normalizeFeatures([{
    label: '机身',
    shape: 'loft',
    sections: [
      { z: 0, ellipse: { rx: 1, ry: 1.4 } },
      { z: 4, ellipse: { rx: 1, ry: 1.4, power: 2.4 } },
    ],
  }], 'f') as SolidFeature[];
  const g1 = buildSolidGeometry(ellipse);
  g1.computeBoundingBox();
  const s1 = g1.boundingBox!.getSize(new Vector3());
  g1.dispose();
  check('椭圆截面放样：宽 = 2×rx', near(s1.x, 2, 0.02), s1.x.toFixed(3));
  check('椭圆截面放样：深 = 2×ry', near(s1.y, 2.8, 0.02), s1.y.toFixed(3));
  check('椭圆截面放样：长 = z 跨度', near(s1.z, 4, 0.02), s1.z.toFixed(3));

  // 翼型：弦长沿 x、厚度沿 y
  const wing = normalizeFeatures([{
    label: '机翼',
    shape: 'loft',
    sections: [
      { z: 0, airfoil: { chord: 6, thickness: 0.12, le: 3 } },
      { z: 6, airfoil: { chord: 3, thickness: 0.1, le: 0.5 } },
    ],
  }], 'w') as SolidFeature[];
  const g2 = buildSolidGeometry(wing);
  g2.computeBoundingBox();
  const s2 = g2.boundingBox!.getSize(new Vector3());
  g2.dispose();
  check('翼型放样：x 跨度 = 根弦长', near(s2.x, 6, 0.05), s2.x.toFixed(3));
  check('翼型放样：y 厚度 ≈ chord×thickness', near(s2.y, 0.72, 0.08), s2.y.toFixed(3));
  check('翼型放样：展向 = z 跨度', near(s2.z, 6, 0.01));

  // 截面偏移 / 扭转
  const offset = normalizeFeatures([{
    shape: 'loft',
    sections: [
      { z: 0, ellipse: { rx: 0.5, ry: 0.5 } },
      { z: 1, ellipse: { rx: 0.5, ry: 0.5 }, offset: [2, 0] },
    ],
  }], 'o') as SolidFeature[];
  const g3 = buildSolidGeometry(offset);
  g3.computeBoundingBox();
  const box3 = g3.boundingBox!;
  g3.dispose();
  check('截面 offset 生效（顶端整体移到 x=2）', near(box3.min.x, -0.5, 0.01) && near(box3.max.x, 2.5, 0.01), `${box3.min.x.toFixed(2)}..${box3.max.x.toFixed(2)}`);

  // 镜像：一份原件 + 一份镜像件，法线仍朝外（有向体积为正）
  const mirrored = normalizeFeatures([{
    label: '机翼',
    shape: 'loft',
    sections: [
      { z: 0, airfoil: { chord: 4, thickness: 0.12, le: 2 } },
      { z: 6, airfoil: { chord: 2, thickness: 0.1, le: 0 } },
    ],
    // 展向沿 +z 建，再绕 X 转 90° 指向 -y；镜像轴 y 自动补出 +y 那一侧
    rotate: [90, 0, 0],
    translate: [0, -3, 0],
    pattern: { type: 'mirror', axis: 'y' },
  }], 'm') as SolidFeature[];
  check('镜像特征被归一化成 mirror', mirrored[0].pattern?.type === 'mirror');
  const g4 = buildSolidGeometry(mirrored);
  g4.computeBoundingBox();
  const s4 = g4.boundingBox!.getSize(new Vector3());
  const volume = signedVolume(g4);
  g4.dispose();
  check('镜像后总宽 = 两倍（-9..+9）', near(s4.y, 18, 0.02), s4.y.toFixed(2));
  check('镜像件法线朝外（有向体积为正）', volume > 0, volume.toFixed(3));

  // 同样一个机身，参数化写法要省两个数量级的数字
  const compact = JSON.stringify(ellipse).length;
  check('参数化截面体积可忽略（< 400 字符）', compact < 400, `${compact}`);
}

console.log('曲面修饰：偏移 / 倒圆 / 抽壳');
{
  const cube = { shape: 'box', width: 2, depth: 2, height: 2 } as const;
  const cubeFeature = (extra: Record<string, unknown>) => [{ id: 'a', shape: cube, ...extra } as unknown as SolidFeature];

  const grew = bounds(cubeFeature({ offset: 0.1 }));
  check('偏移 +0.1：外形每边各涨 0.1', grew !== null && near(grew.max[0]! - grew.min[0]!, 2.2, 1e-3), `${grew?.min[0]}..${grew?.max[0]}`);
  const shrunk = bounds(cubeFeature({ offset: -0.1 }));
  check('偏移 -0.1：外形每边各收 0.1', shrunk !== null && near(shrunk.max[0]! - shrunk.min[0]!, 1.8, 1e-3), `${shrunk?.min[0]}..${shrunk?.max[0]}`);

  // 倒圆：外形尺寸不变，只把 12 条棱削掉（体积略减）
  const rounded = buildSolidGeometry(cubeFeature({ fillet: 0.2 }));
  rounded.computeBoundingBox();
  const roundedSize = rounded.boundingBox!.getSize(new Vector3());
  const roundedVolume = signedVolume(rounded);
  const roundedTriangles = (rounded.index?.count ?? rounded.getAttribute('position').count) / 3;
  rounded.dispose();
  check('倒圆 0.2：外形尺寸 2×2×2 保持不变', near(roundedSize.x, 2, 1e-3) && near(roundedSize.z, 2, 1e-3), `${roundedSize.x}`);
  check('倒圆 0.2：体积 7.79（只少了棱角料）', near(roundedVolume, 7.797, 0.02), roundedVolume.toFixed(3));
  check('倒圆 0.2：确实生成了圆角面', roundedTriangles > 400, String(roundedTriangles));

  // 圆柱（也是凸体）：滚球倒圆后上下面收圆、侧壁不变
  const cylinder = [{ id: 'a', shape: { shape: 'cylinder', radius: 1, height: 2, segments: 32 }, fillet: 0.15 } as unknown as SolidFeature];
  const cylinderBounds = bounds(cylinder)!;
  const cylinderGeometry = buildSolidGeometry(cylinder);
  const cylinderVolume = signedVolume(cylinderGeometry);
  cylinderGeometry.dispose();
  check('圆柱倒圆：高度/直径基本不变（滚球采样内接，误差 < 2%）', near(cylinderBounds.max[2]! - cylinderBounds.min[2]!, 2, 0.03) && near(cylinderBounds.max[0]! - cylinderBounds.min[0]!, 2, 0.03), `${(cylinderBounds.max[2]! - cylinderBounds.min[2]!).toFixed(3)}`);
  check('圆柱倒圆：体积略小于原圆柱（π·2≈6.243）', cylinderVolume < 6.243 && cylinderVolume > 5.9, cylinderVolume.toFixed(3));

  // 非凸体不做倒圆：宁可不做，也不能被滚成凸包把凹口填掉
  const lShape = {
    shape: 'prism',
    height: 0.6,
    // L 形轮廓（左下角缺一块），是非凸的
    profile: [[-0.5, -0.5], [0.5, -0.5], [0.5, -0.1], [-0.1, -0.1], [-0.1, 0.5], [-0.5, 0.5]],
  } as const;
  const plainL = buildSolidGeometry([{ id: 'a', shape: lShape } as unknown as SolidFeature]);
  const plainLVolume = signedVolume(plainL);
  plainL.dispose();
  const filletedL = buildSolidGeometry([{ id: 'a', shape: lShape, fillet: 0.1 } as unknown as SolidFeature]);
  const filletedLVolume = signedVolume(filletedL);
  filletedL.dispose();
  check('非凸体（L 形拉伸）跳过倒圆，凹口不被填掉', near(filletedLVolume, plainLVolume, 1e-6), `${plainLVolume.toFixed(3)} → ${filletedLVolume.toFixed(3)}`);

  // 抽壳：封口 = 外面表减内腔；开口时内腔穿出那个面
  const sealed = buildSolidGeometry(cubeFeature({ shell: 0.1 }));
  const sealedVolume = signedVolume(sealed);
  sealed.dispose();
  check('抽壳 0.1（封口）：体积 = 8 − 1.8³ = 2.168', near(sealedVolume, 2.168, 0.02), sealedVolume.toFixed(3));
  const opened = buildSolidGeometry(cubeFeature({ shell: { thickness: 0.1, open: 'z+' } }));
  const openedVolume = signedVolume(opened);
  opened.dispose();
  check('抽壳 0.1 开口：体积 1.844（顶壁被掏穿）', near(openedVolume, 1.844, 0.03), openedVolume.toFixed(3));
  const twoFaces = buildSolidGeometry(cubeFeature({ shell: { thickness: 0.1, open: ['z+', 'z-'] } }));
  const twoFacesVolume = signedVolume(twoFaces);
  twoFaces.dispose();
  check('抽壳双开口：体积继续减小（上下都通）', twoFacesVolume < openedVolume - 0.3, twoFacesVolume.toFixed(3));

  // 顺序：先倒圆再抽壳，内壁跟着外圆角走，壁厚仍然均匀
  const filletShell = buildSolidGeometry(cubeFeature({ fillet: 0.15, shell: { thickness: 0.1, open: 'z+' } }));
  const filletShellVolume = signedVolume(filletShell);
  filletShell.computeBoundingBox();
  const filletShellSize = filletShell.boundingBox!.getSize(new Vector3());
  filletShell.dispose();
  check('倒圆 + 抽壳可叠加，外形尺寸不变', near(filletShellSize.x, 2, 0.02), filletShellSize.x.toFixed(3));
  check('倒圆 + 抽壳：体积在两者之间', filletShellVolume > 1.5 && filletShellVolume < 1.85, filletShellVolume.toFixed(3));

  // 阵列上限：一排 90 个舷窗写在同一个特征里
  const windows = bounds([{
    id: 'a',
    shape: { shape: 'box', width: 0.06, depth: 0.06, height: 0.06 },
    pattern: { type: 'linear', count: 90, step: [0.1, 0, 0] },
  } as unknown as SolidFeature])!;
  check('阵列单特征 90 个实例（原上限 64）', near(windows.max[0]! - windows.min[0]!, 8.96, 1e-3), (windows.max[0]! - windows.min[0]!).toFixed(3));

  // 服务端：数字写法归一化成对象，非法开口面报错，概览里能看见修饰
  const normalized = normalizeFeatures([{
    label: '盖板',
    shape: 'box',
    width: 1,
    depth: 1,
    height: 0.1,
    fillet: 0.02,
    shell: { thickness: 0.01, open: 'z+' },
    offset: -0.002,
  }], 'modifiers') as SolidFeature[];
  check('fillet 数字写法归一化成 { radius }', (normalized[0]!.fillet as { radius: number })?.radius === 0.02);
  check('shell 开口面归一化成数组', Array.isArray((normalized[0]!.shell as { open: string[] })?.open));
  check('offset 保留为数字', normalized[0]!.offset === -0.002);
  let rejected = false;
  try {
    normalizeFeatures([{ shape: 'box', width: 1, depth: 1, height: 1, shell: { thickness: 0.1, open: 'top' } }], 'bad');
  } catch {
    rejected = true;
  }
  check('非法开口面被拒（只认 x+/z- 这类）', rejected);

  // 界面：修饰要能在「曲面修饰」分组里改
  const editable = { id: 'e', shape: cube, fillet: 0.02, shell: { thickness: 0.01, open: 'z+' }, offset: -0.002 } as unknown as SolidFeature;
  const group = solidFeatureGroups(editable).find((item) => item.title.startsWith('曲面修饰'));
  check('特征面板出现「曲面修饰」分组（偏移 / 倒圆 / 壁厚）', group?.fields.length === 3, group?.fields.map((field) => field.label).join('/'));
  const renamed = updateSolidFeatureField(editable, 'fillet.radius', 0.03);
  check('改倒圆半径只动 fillet，其余修饰保留',
    (renamed.fillet as { radius: number }).radius === 0.03 && renamed.shell !== undefined && renamed.offset === -0.002);
  const cleared = updateSolidFeatureField(editable, 'offset.distance', 0);
  check('偏移归零 = 去掉这个修饰', cleared.offset === undefined);
}

console.log('瓦面：一片片铺（板瓦 + 筒瓦 + 叠压 + 瓦当滴水）');
{
  const roofOf = (overrides: Record<string, unknown> = {}): SolidFeature => ({
    id: 'roof',
    label: '瓦面',
    shape: {
      shape: 'tiles',
      rings: [
        { z: 0.02, radius: 1.28 },
        { z: 0, radius: 1.2 },
        { z: 0.55, radius: 0.72 },
        { z: 1.05, radius: 0.05 },
      ],
      sides: 6,
      rows: 6,
      courses: 10,
      crown: 0.05,
      thickness: 0.014,
      lift: 0.012,
      sag: 0.01,
      ...overrides,
    },
  } as SolidFeature);

  const geometry = buildSolidGeometry([roofOf()]);
  const count = Math.floor((geometry.index?.count ?? geometry.getAttribute('position').count) / 3);
  check('六角攒尖瓦面能求值', count > 500, `${count} 三角`);

  geometry.computeBoundingBox();
  const box = geometry.boundingBox!;
  check('半径贴合 rings（外挑站 1.28 撑开）', near(Math.max(box.max.x, box.max.y), 1.28, 0.05), `${box.max.x.toFixed(2)}`);
  check('瓦口外挑段真的落到檐口以下（z 略低于 0）', box.min.z < 0.005 && box.min.z > -0.12, box.min.z.toFixed(3));

  // 每片瓦都是独立的薄壳：面数按「列 × 层」增长，而不是一个实心锥。
  // （不闭合网格没有有向体积，别拿体积断言薄壳——那会得出任意值。）
  check('三角面数与「每面 6 列 × 10 层」相当（一片片铺，不是一整个面）', count > 6 * 6 * 10 * 20, `${count} 三角`);

  const doubled = buildSolidGeometry([roofOf({ courses: 20 })]);
  const doubledCount = Math.floor((doubled.index?.count ?? doubled.getAttribute('position').count) / 3);
  check('叠瓦层数加倍 → 面数近似加倍', doubledCount > count * 1.7 && doubledCount < count * 2.3, `${count} → ${doubledCount}`);

  // 瓦当 / 滴水不能靠「正反两个三角」假装有厚度：那种片子在低角度下就是一张纸，
  // 正是「瓦当出现薄片」的成因。零厚度双面片的标志 = 同一组顶点出现两次、绕向相反。
  {
    const position = geometry.getAttribute('position');
    const sides = new Map<string, number>();
    const keyOf = (index: number) =>
      [
        Math.round(position.getX(index) * 1e5),
        Math.round(position.getY(index) * 1e5),
        Math.round(position.getZ(index) * 1e5),
      ].join(',');
    for (let i = 0; i + 2 < position.count; i += 3) {
      const order = [keyOf(i), keyOf(i + 1), keyOf(i + 2)];
      let first = 0;
      if (order[1]! < order[first]!) first = 1;
      if (order[2]! < order[first]!) first = 2;
      const ring = [order[first]!, order[(first + 1) % 3]!, order[(first + 2) % 3]!];
      const key = ring.join('|');
      sides.set(key, (sides.get(key) ?? 0) + (ring[1]! < ring[2]! ? 1 : -1));
    }
    const sheets = [...sides.values()].filter((sum) => sum === 0).length;
    check('檐口没有零厚度双面片（瓦当 / 滴水是实心的）', sheets === 0, `${sheets} 片双面三角`);
  }

  const round = buildSolidGeometry([roofOf({ sides: 0, rows: 16 })]);
  check('圆形屋面（sides 0）也能铺', Math.floor((round.index?.count ?? round.getAttribute('position').count) / 3) > 500);

  // 角部起翘（翼角）：屋面自己在角上抬起来 + 往外挑，而不是在角上另贴一块板。
  {
    const lifted = buildSolidGeometry([roofOf({ cornerLift: 0.25, cornerOut: 0.12 })]);
    const position = lifted.getAttribute('position');
    let cornerZ = -Infinity;
    let midZ = -Infinity;
    let reach = 0;
    for (let i = 0; i < position.count; i += 1) {
      const x = position.getX(i);
      const y = position.getY(i);
      const z = position.getZ(i);
      const radius = Math.hypot(x, y);
      const angle = Math.abs(Math.atan2(y, x));      // 0 = 角上（+X 是六边形的一个顶点）
      reach = Math.max(reach, radius);
      if (radius < 1.1) continue;                     // 只看檐口外圈
      if (angle < 0.03) cornerZ = Math.max(cornerZ, z);
      if (Math.abs(angle - Math.PI / 6) < 0.03) midZ = Math.max(midZ, z);
    }
    check('角部起翘：角上的檐口比面中高出一截', cornerZ > midZ + 0.15, `角 ${cornerZ.toFixed(2)} / 面中 ${midZ.toFixed(2)}`);
    check('角部外挑：角尖伸到檐口半径之外', reach > 1.28 * 1.08, reach.toFixed(2));
  }

  const degenerate = buildSolidGeometry([roofOf({ rings: [{ z: 0, radius: 1 }] })]);
  check('只有 1 站 rings 不出几何（无法定义坡面）',
    (degenerate.getAttribute('position')?.count ?? 0) === 0);

  // 服务端：AI 写这个形状时的校验与默认值
  const normalized = normalizeFeatures([roofOf({ rows: undefined, courses: undefined })], 'feature');
  const shape = normalized[0]!.shape;
  check('服务端补齐默认 rows / courses',
    shape.shape === 'tiles' && shape.rows === 9 && shape.courses === 12,
    shape.shape === 'tiles' ? `${shape.rows}×${shape.courses}` : shape.shape);
  let rejected = false;
  try {
    normalizeFeatures([roofOf({ rings: [] })], 'feature');
  } catch {
    rejected = true;
  }
  check('rings 为空要被服务端拒掉（并说明怎么改）', rejected);

  const fields = solidFeatureGroups(roofOf()).flatMap((group) => group.fields.map((field) => field.key));
  check('特征面板能改瓦列数 / 层数 / 瓦厚（不只是几何）',
    ['shape.rows', 'shape.courses', 'shape.thickness'].every((key) => fields.includes(key)),
    fields.join('/'));
}

console.log('贴花（涂装 / 文字）');
{
  const plane = buildPrimitiveGeometry({ kind: 'decal', width: 8, height: 1, normal: 'y', text: 'AIRBUS A350' });
  plane.computeBoundingBox();
  const size = plane.boundingBox!.getSize(new Vector3());
  const normal = plane.getAttribute('normal');
  check('贴花尺寸 8 × 1 m（高沿 z）', near(size.x, 8, 0.01) && near(size.z, 1, 0.01), `${size.x}x${size.z}`);
  check('法向 y 的贴花是竖直平面（y 向无厚度）', near(size.y, 0, 1e-6));
  check('贴花带 uv（贴图靠它采样）', Boolean(plane.getAttribute('uv')));
  check('朝向 +y（法线 y=1）', near(normal.getY(0), 1, 1e-6), String(normal.getY(0)));
  const back = buildPrimitiveGeometry({ kind: 'decal', width: 8, height: 1, normal: '-y', text: 'X' });
  check('朝向 -y 时法线反向', near(back.getAttribute('normal').getY(0), -1, 1e-6));

  // 指令通道：addDecal 落库成独立构件
  const project = createProject({ name: '贴花测试' });
  const { document } = applyOps(project, [
    { op: 'addDecal', text: 'AIRBUS A350', width: 8, height: 0.9, position: [-2, -2.99, 0.6], normal: '-y', color: '#1c3f74' },
  ]);
  const element = document.elements[0] as any;
  check('addDecal 生成贴花构件', element?.primitive?.kind === 'decal');
  check('贴花位置写进 offset', near(element.offset[1], -2.99, 1e-6) && near(element.offset[2], 0.6, 1e-6));
  check('文字与朝向入库', element.primitive.text === 'AIRBUS A350' && element.primitive.normal === '-y');
}

if (failures.length) {
  console.error(`\n造型测试失败 ${failures.length} 项：`);
  failures.forEach((failure) => console.error(` - ${failure}`));
  process.exit(1);
}
console.log(`\n造型特征测试通过（${passed} 项）`);
