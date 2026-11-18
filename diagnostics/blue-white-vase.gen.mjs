/**
 * 青花瓷特征树生成器 —— 演示「没有贴图材质时，怎么把纹样变成几何」。
 *
 * 运行：node diagnostics/blue-white-vase.gen.mjs
 * 产出：
 *   - diagnostics/blue-white-vase.ops.json（可直接喂 addSolid / npm run query）
 *   - shared/models/blue-white-vase.json（模型库文档，注册在 shared/library.js）
 *
 * 核心思路：
 *   1. 器型 = 一条闭合母线 revolve（外壁上去 + 内壁回来），一次成型薄壁瓶；
 *   2. 纹样不做贴图，而是「贴在曲面上的薄几何」：按 z 在母线上插值出 r(z)，
 *      再用 (θ, z) 算出曲面点 P = [(r+δ)cosθ, (r+δ)sinθ, z]，δ 是离面的浮点余量；
 *   3. 每个纹样特征自带 material（4 档青花料），靠 geometry.groups 多材质分色；
 *   4. 一片「正面纹样」放进 group，group 带 circular 阵列绕瓶轴复制，背面自动有花纹。
 *
 * 这也是产品内编排里「贴合件 Agent 先拿 surface sample 再生成」的手工等价版。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(here, 'blue-white-vase.ops.json');

/* ---------- 母线：外壁 z↑、内壁 z↓，均以 [半径, 高度] 给出 ---------- */
const H = 0.32;
const outer = [
  [0.000, 0.052], [0.004, 0.056], [0.014, 0.056], [0.020, 0.050],
  [0.032, 0.070], [0.055, 0.092], [0.082, 0.110], [0.112, 0.120],
  [0.140, 0.122], [0.172, 0.118], [0.205, 0.107], [0.235, 0.092],
  [0.260, 0.078], [0.282, 0.064], [0.298, 0.059], [0.308, 0.064],
  [0.316, 0.078], [0.320, 0.082],
];
const inner = [
  [0.320, 0.076], [0.314, 0.072], [0.302, 0.057], [0.284, 0.054],
  [0.262, 0.060], [0.236, 0.072], [0.206, 0.086], [0.174, 0.100],
  [0.140, 0.106], [0.112, 0.104], [0.082, 0.094], [0.056, 0.076],
  [0.034, 0.052], [0.024, 0.044], [0.024, 0.000],
];
const profile = [
  [0, 0],
  ...outer.map(([z, r]) => [r, z]),
  ...inner.map(([z, r]) => [r, z]),
  [0, 0],
];

/** 母线插值：给定 z 求外壁半径 */
function radiusAt(z) {
  if (z <= outer[0][0]) return outer[0][1];
  for (let i = 1; i < outer.length; i += 1) {
    const [z1, r1] = outer[i];
    if (z <= z1) {
      const [z0, r0] = outer[i - 1];
      const t = z1 === z0 ? 0 : (z - z0) / (z1 - z0);
      return r0 + (r1 - r0) * t;
    }
  }
  return outer[outer.length - 1][1];
}

/** 曲面点：θ 用度，正面 = -90°（-Y）；δ 为沿法向外推的余量（米） */
function onSurface(thetaDeg, z, delta = 0.0008) {
  const t = (thetaDeg * Math.PI) / 180;
  const r = radiusAt(z) + delta;
  return [+(r * Math.cos(t)).toFixed(5), +(r * Math.sin(t)).toFixed(5), +z.toFixed(5)];
}

/* ---------- 青花料：4 档，靠逐特征 material 分色 ---------- */
const glaze = { name: '甜白釉', color: '#f3f1ec', roughness: 0.16, metalness: 0.02 };
const indigoDark = { name: '青花·浓', color: '#12356e', roughness: 0.22, metalness: 0.04 };
const indigoMid = { name: '青花·中', color: '#2b62ad', roughness: 0.22, metalness: 0.04 };
const indigoPale = { name: '青花·淡', color: '#6ea3d8', roughness: 0.24, metalness: 0.03 };

/* ---------- 叶 / 花瓣的二维轮廓（局部 XY，+Y 是生长方向），拉伸出 1.6 mm 薄片 ---------- */
const petal = [
  [0, 0], [-0.0055, 0.006], [-0.0080, 0.014], [-0.0048, 0.024],
  [0, 0.031], [0.0048, 0.024], [0.0080, 0.014], [0.0055, 0.006],
];
const leaf = [
  [0, 0], [-0.0040, 0.004], [-0.0055, 0.011], [-0.0028, 0.018],
  [0, 0.023], [0.0028, 0.018], [0.0055, 0.011], [0.0040, 0.004],
];

/**
 * 把一片薄叶摆到曲面上。
 * rotate = [90, φ, 0]：先绕 X 把 XY 平面立成 XZ 平面（厚度朝 -Y / 瓶外），
 * 再绕世界 Y 转 φ，让长轴在切平面内指向想要的方向。
 */
function blade(label, shape, thetaDeg, z, tiltDeg, material) {
  return {
    label,
    shape: { shape: 'prism', profile: shape, height: 0.0026 },
    rotate: [90, +tiltDeg.toFixed(2), 0],
    translate: onSurface(thetaDeg, z, 0.0022),
    material,
  };
}

const features = [];

/* 1. 胎体：一条闭合母线转出薄壁瓶，segments 落在 6~64 合法区间 */
features.push({
  label: '胎体·甜白釉',
  mode: 'add',
  shape: { shape: 'revolve', profile, segments: 48 },
  material: glaze,
});

/* 2. 口沿 / 圈足弦纹：torus 是绕 Z 的圆环，天然贴合回转体 */
features.push({
  label: '口沿·青花双弦',
  shape: { shape: 'torus', radius: 0.0805, tube: 0.0010, segments: 48, tubeSegments: 8 },
  translate: [0, 0, 0.318],
  material: indigoDark,
});
features.push({
  label: '颈根·青花弦',
  shape: { shape: 'torus', radius: 0.0615, tube: 0.0011, segments: 48, tubeSegments: 8 },
  translate: [0, 0, 0.303],
  material: indigoMid,
});
features.push({
  label: '圈足·青花弦',
  shape: { shape: 'torus', radius: 0.0562, tube: 0.0011, segments: 48, tubeSegments: 8 },
  translate: [0, 0, 0.012],
  material: indigoDark,
});

/* 3. 颈部回纹带：一个方块 + 绕瓶轴的 circular 阵列 = 24 个点，不占 24 个特征 */
features.push({
  label: '颈部·回纹带',
  shape: { shape: 'box', width: 0.005, depth: 0.0026, height: 0.008 },
  translate: onSurface(0, 0.288, 0.0022),
  pattern: { type: 'circular', axis: 'z', count: 24, angle: 360, center: [0, 0, 0] },
  material: indigoMid,
});

/* 4. 下腹仰莲瓣：一片莲瓣绕瓶一圈 */
features.push({
  label: '下腹·仰莲瓣',
  shape: { shape: 'prism', profile: petal, height: 0.0026 },
  rotate: [90, 0, 0],
  scale: [1.2, 0.8, 1],
  translate: onSurface(-90, 0.052, 0.0035),
  pattern: { type: 'circular', axis: 'z', count: 16, angle: 360, center: [0, 0, 0] },
  material: indigoDark,
});

/* ---------- 5. 腹部主纹样：一整组「正面缠枝莲」，整组绕瓶复制 2 面 ---------- */
const motif = [];
const FRONT = -90;
const FLOWER_Z = 0.152;
const r0 = radiusAt(FLOWER_Z);
const flowerCenter = onSurface(FRONT, FLOWER_Z, 0.0024);

/* 5a. 主花：8 瓣，逐瓣按曲面采样点摆位（不是把一片绕轴转，否则瓣尖会离开瓶面） */
for (let i = 0; i < 8; i += 1) {
  const phi = (i * Math.PI * 2) / 8;
  const dx = 0.006 * Math.cos(phi);
  const dz = 0.006 * Math.sin(phi);
  const theta = FRONT + (dx / r0) * (180 / Math.PI);
  const z = FLOWER_Z + dz;
  // 长轴指向 (cosφ, sinφ) 时，绕 Y 的角度是 90° - φ
  const tilt = 90 - (phi * 180) / Math.PI;
  motif.push(blade(
    `主花·花瓣${String(i + 1).padStart(2, '0')}`,
    petal, theta, z, tilt,
    i % 2 === 0 ? indigoMid : indigoPale,
  ));
}

/* 5b. 花心 + 一圈雄蕊小珠 */
motif.push({
  label: '主花·花心',
  shape: { shape: 'sphere', radius: 0.0060, segments: 16 },
  // 压扁成浅浮雕，别让花心变成一颗凸出的弹珠
  scale: [1, 0.45, 1],
  translate: flowerCenter,
  material: indigoPale,
});
motif.push({
  label: '主花·雄蕊',
  shape: { shape: 'sphere', radius: 0.0018, segments: 8 },
  translate: [flowerCenter[0] + 0.011, flowerCenter[1], flowerCenter[2]],
  pattern: { type: 'circular', axis: 'y', count: 12, angle: 360, center: flowerCenter },
  material: glaze,
});

/* 5c. 缠枝藤蔓：sweep 沿曲面采样路径走，截面用小方块，平行传输标架保证不扭转 */
const vineProfile = [
  [-0.0016, -0.0013], [0.0016, -0.0013], [0.0016, 0.0013], [-0.0016, 0.0013],
];
const vines = [
  { z0: 0.072, z1: 0.168, amp: 0.52, phase: 0.0, drift: 0.30 },
  { z0: 0.150, z1: 0.248, amp: 0.46, phase: 2.1, drift: -0.34 },
  { z0: 0.090, z1: 0.205, amp: 0.74, phase: 4.0, drift: 0.10 },
];
vines.forEach((v, vi) => {
  const pts = [];
  for (let k = 0; k <= 13; k += 1) {
    const t = k / 13;
    const z = v.z0 + (v.z1 - v.z0) * t;
    const theta = FRONT + (v.amp * Math.sin(Math.PI * 1.6 * t + v.phase) + v.drift * t) * (180 / Math.PI);
    pts.push(onSurface(theta, z, 0.0022));
  }
  motif.push({
    label: `缠枝·藤蔓${String(vi + 1).padStart(2, '0')}`,
    shape: { shape: 'sweep', profile: vineProfile, path: pts, taper: [1, 0.35] },
    material: indigoDark,
  });

  /* 5d. 每根藤上挂 4 片叶子：位置沿路径取，叶尖朝切线外撇 */
  for (let j = 0; j < 5; j += 1) {
    const t = 0.10 + j * 0.19;
    const [px, py, pz] = onSurface(
      FRONT + (v.amp * Math.sin(Math.PI * 1.6 * t + v.phase) + v.drift * t) * (180 / Math.PI),
      v.z0 + (v.z1 - v.z0) * t,
      0.0022,
    );
    const thetaDeg = (Math.atan2(py, px) * 180) / Math.PI;
    const tilt = 90 - (j % 2 === 0 ? 42 : -42) - 25 * vi;
    const item = blade(
      `卷草·叶${String(vi + 1).padStart(2, '0')}-${j + 1}`,
      leaf, thetaDeg, pz, tilt,
      j % 3 === 0 ? indigoDark : j % 3 === 1 ? indigoMid : indigoPale,
    );
    // 让叶片根部就落在藤蔓的采样点上（不再按 θ,z 重算）
    item.translate = [px, py, pz];
    motif.push(item);
  }
});

features.push({
  label: '腹部·缠枝莲纹',
  shape: { shape: 'group', features: motif },
  // 只复制正背两面：薄片的法向是照正面 −Y 算的，转 180° 后仍是径向、贴合；
  // 转 ±120° 会与曲面法向失配而翘出轮廓，所以不铺三面。
  pattern: { type: 'circular', axis: 'z', count: 2, angle: 360, center: [0, 0, 0] },
});

const ops = [{
  op: 'addSolid',
  name: '青花缠枝莲纹瓶',
  color: '#f3f1ec',
  features,
}];

fs.writeFileSync(OUT, `${JSON.stringify(ops, null, 2)}\n`);

/* 模型库：同一棵特征树，补稳定 id（UI 里能按 id / 序号 editFeature），写成库文档 */
let idSeq = 0;
const withIds = (list) => list.map((feature) => {
  idSeq += 1;
  const next = { id: feature.id || `bwv-${String(idSeq).padStart(2, '0')}`, ...feature };
  if (feature.shape?.shape === 'group') {
    next.shape = { ...feature.shape, features: withIds(feature.shape.features) };
  }
  return next;
});
const library = {
  id: 'blue-white-vase',
  name: '青花瓷瓶（几何纹样）',
  summary: '薄壁撇口瓶，四档青花料分色；缠枝莲、仰莲瓣与口沿回纹都是贴在曲面上的薄几何，不依赖贴图',
  features: withIds(features),
};
const LIBRARY_OUT = path.join(here, '../shared/models/blue-white-vase.json');
fs.writeFileSync(LIBRARY_OUT, `${JSON.stringify(library, null, 2)}\n`);

const count = (list) => list.reduce(
  (n, f) => n + 1 + (f.shape?.shape === 'group' ? count(f.shape.features) : 0), 0,
);
console.log(`已写出 ${OUT}`);
console.log(`已写出 ${LIBRARY_OUT}`);
console.log(`顶层特征 ${features.length}、含组内共 ${count(features)} 个特征、母线 ${profile.length} 点`);
