/**
 * 设计库（案例库）冒烟测试：每个模板都必须能走通真实链路。
 *
 * 模板是"用户点一下就落到模型里"的东西，坏了比 AI 写错更难发现——所以这里不用内核直连，
 * 而是走 `applyOps`（服务端校验）→ `buildElementModel`（前端求值），与「应用到模型」同一条路。
 */
import { Vector3 } from 'three';
import { buildElementModel } from '../src/bim/geometry';
import { createProject } from '../src/bim/template';
import { applyOps } from '../server/ai/ops.js';
import { SOLID_TEMPLATES } from '../src/bim/solidTemplates';
import { libraryFeatures } from '../shared/library.js';
import { countSolidFeatures } from '../src/bim/solid';

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

/**
 * 上限是**分层**的（server/ai/solid.js 的 SOLID_LIMITS，与 src/bim/solid.ts 同值）：
 * 整棵树 ≤ 96 个特征、任何一层数组 ≤ 96、group 的子特征 ≤ 48、group 最多嵌套 2 层。
 * 这里原来只比对「总数 ≤ 48」当代理指标 —— 那个数其实是 nestedFeatures（单个 group 的
 * 子特征上限），不是总数；吊车这种「顶层 29 + 子装配 32」的模型会被误判成超限。
 */
const LIMIT_TOTAL = 96;
const LIMIT_NESTED = 48;

function maxNestedFeatures(features: { shape?: { shape?: string; features?: unknown } }[]): number {
  let deepest = 0;
  for (const feature of features) {
    if (feature?.shape?.shape !== 'group') continue;
    const children = feature.shape.features as typeof features;
    deepest = Math.max(deepest, children.length, maxNestedFeatures(children));
  }
  return deepest;
}

for (const template of SOLID_TEMPLATES) {
  console.log(`\n模板「${template.name}」`);
  const features = template.build();
  check('能建出特征树', Array.isArray(features) && features.length > 0, `${features?.length}`);

  const total = countSolidFeatures(features);
  const nested = maxNestedFeatures(features as never);
  check(
    `特征数 ${total}（顶层 ${features.length}、最深 group ${nested} 个子特征）在分层上限内`,
    total <= LIMIT_TOTAL && features.length <= LIMIT_TOTAL && nested <= LIMIT_NESTED,
  );

  let geometry: ReturnType<typeof buildElementModel> = null;
  try {
    const project = createProject({ name: '模板冒烟' });
    const result = applyOps(project, [
      { op: 'addSolid', name: template.name, features, position: [0, 0, 0] },
    ]);
    geometry = buildElementModel(result.document, result.document.elements[0]);
    check('服务端校验通过并落库', result.document.elements.length === 1);
  } catch (error) {
    check('服务端校验通过并落库', false, error instanceof Error ? error.message : String(error));
  }

  if (!geometry) continue;
  const count = Math.floor((geometry.geometry.index?.count ?? geometry.geometry.getAttribute('position').count) / 3);
  check(`求值出三角面（${count}）`, count > 100);
  check('材质槽非空', geometry.materials.length > 0, `${geometry.materials.length}`);

  geometry.geometry.computeBoundingBox();
  const size = geometry.geometry.boundingBox!.getSize(new Vector3());
  const maxSize = Math.max(size.x, size.y, size.z);
  check(`尺寸在合理范围（最大 ${maxSize.toFixed(2)} m）`, maxSize > 0.01 && maxSize < 200);
  geometry.geometry.dispose();
}

console.log('\n案例专项');
{
  // 飞机：模型文档按 1:10 建模（根特征 scale=0.1），改成 1 就是真机尺度
  const scaled = libraryFeatures('aircraft-a350');
  check('飞机模型库是 1:10 展示比例', Math.abs((scaled[0].scale ?? 1) - 0.1) < 1e-9, `${scaled[0].scale}`);
  const real = libraryFeatures('aircraft-a350');
  real[0].scale = 1;
  real[0].translate = [0, 0, (real[0].translate?.[2] ?? 0) / (scaled[0].scale ?? 1)];
  check('把根 scale 改回 1 就是真机尺寸', real[0].scale === 1);

  // 涂装是 addDecal 指令（独立构件），不属于模型文档
  const DECALS = [1, -1].flatMap((side) => [
    { op: 'addDecal', name: '机身标题', text: 'AIRBUS A350', width: 8.4, height: 0.95, position: [3.0, side * 2.99, 3.35], normal: side > 0 ? 'y' : '-y', color: '#1c3f74' },
    { op: 'addDecal', name: '垂尾字样', text: 'A350', width: 2.3, height: 0.8, position: [-22.6, side * 0.45, 8.6], normal: side > 0 ? 'y' : '-y', color: '#ffffff' },
  ]);
  check('飞机贴花给了 4 条', DECALS.length === 4);

  const project = createProject({ name: '飞机' });
  const { document } = applyOps(project, [
    { op: 'addSolid', name: 'A350', features: real, position: [0, 0, 0] },
    ...DECALS,
  ]);
  const model = buildElementModel(document, document.elements[0]);
  check('飞机 + 贴花一起落库（5 个构件）', document.elements.length === 5, `${document.elements.length}`);
  model!.geometry.computeBoundingBox();
  const size = model!.geometry.boundingBox!.getSize(new Vector3());
  // 1:1 时全长应接近真机 66.8 m
  check(`真实尺寸全长 ${size.x.toFixed(1)} m`, Math.abs(size.x - 66.9) < 1.5);
  model!.geometry.dispose();

  // 亭子：六角 / 八角是两份文档（同一套构图，只是边数不同）
  const hex = libraryFeatures('pavilion-hex');
  const oct = libraryFeatures('pavilion-oct');
  const columnOf = (list: typeof hex) => list.find((feature) => feature.id === 'pv-column');
  check('六角亭 6 根檐柱（圆周阵列）', columnOf(hex)?.pattern?.count === 6, `${columnOf(hex)?.pattern?.count}`);
  check(
    '八角亭（八边文档）同构：特征一一对应，柱数 8',
    oct.length === hex.length && columnOf(oct)?.pattern?.count === 8,
    `${oct.length} / ${hex.length}`,
  );

  // 屋顶：望板 + 逐片瓦 + 翼角，都是「屋顶不够精细」反馈之后补的，别悄悄退回实心锥
  // 望板不再是独立 loft：它由瓦片同一个 `tiles` 形状出，只是关掉瓦、留下 `board` 衬板，
  // 这样两者共用同一条曲面和同一批横向顶点，构造上就不可能「望板从瓦缝里顶出来」。
  const roofFeature = hex.find((feature) => feature.id === 'pv-roof');
  const roofShape = roofFeature && roofFeature.shape.shape === 'tiles' ? roofFeature.shape : null;
  check(
    '望板由瓦面同一套曲面生成（board 衬板，不铺瓦）',
    Boolean(roofShape) && (roofShape?.board ?? 0) > 0 && roofShape?.showTiles === false,
    `板厚 ${roofShape?.board} / showTiles ${roofShape?.showTiles}`,
  );

  // 瓦面：一片片铺出来的板瓦 + 筒瓦。以前给截面加余弦波只能做出「圆脊」，远看像石棉瓦。
  const tileFeature = hex.find((feature) => feature.id === 'pv-tiles');
  const tileShape = tileFeature && tileFeature.shape.shape === 'tiles' ? tileFeature.shape : null;
  check('瓦面独立成特征（板瓦 + 筒瓦逐片铺）', Boolean(tileShape));
  check(
    '每面 ≥6 列、沿坡 ≥8 层（是一片片，不是一条波浪）',
    (tileShape?.rows ?? 0) >= 6 && (tileShape?.courses ?? 0) >= 8,
    `${tileShape?.rows} 列 × ${tileShape?.courses} 层`,
  );
  check(
    '瓦有厚度且层层叠压（thickness / lift 都非零）',
    (tileShape?.thickness ?? 0) > 0 && (tileShape?.lift ?? 0) > 0,
    `厚 ${tileShape?.thickness} 抬 ${tileShape?.lift}`,
  );
  check(
    '瓦口外挑（第一站半径大于檐口站，瓦当与滴水才露得出来）',
    (tileShape?.rings?.[0]?.radius ?? 0) > (tileShape?.rings?.[1]?.radius ?? 1e9),
    `${tileShape?.rings?.[0]?.radius?.toFixed(2)} > ${tileShape?.rings?.[1]?.radius?.toFixed(2)}`,
  );
  // 以前屋面是实心锥，靠一个 cut 特征掏内腔；现在望板本身就是一块 10 cm 的衬板，
  // 屋面天然是薄壳，不需要再挖。这里守住「是薄壳」这件事。
  check(
    '屋面是薄壳构造（望板 2–20 cm + 瓦），不是实心锥',
    (roofShape?.board ?? 0) >= 0.02 && (roofShape?.board ?? 0) <= 0.2,
    `望板 ${roofShape?.board} m`,
  );
  check(
    '翼角长在瓦面上（角部起翘 + 外挑，不是另贴一块板）',
    (tileShape?.cornerLift ?? 0) > 0.1 && (tileShape?.cornerOut ?? 0) > 0.05 && !hex.some((feature) => feature.id === 'pv-wing'),
    `抬 ${tileShape?.cornerLift?.toFixed(2)} 出 ${tileShape?.cornerOut}`,
  );
  check('斗拱独立成特征（柱头科 + 平身科 + 挑檐枋）',
    ['pv-dougong', 'pv-dougong-mid', 'pv-purlin'].every((id) => hex.some((feature) => feature.id === id)));
  check('内部有雷公柱与由戗', hex.some((feature) => feature.id === 'pv-king-post')
    && hex.some((feature) => feature.id === 'pv-strut'));

  const pavilionProject = createProject({ name: '亭子' });
  const pavilion = applyOps(pavilionProject, [
    { op: 'addSolid', name: '六角亭', features: hex, position: [0, 0, 0] },
  ]);
  const pavilionModel = buildElementModel(pavilion.document, pavilion.document.elements[0]);
  pavilionModel!.geometry.computeBoundingBox();
  const box = pavilionModel!.geometry.boundingBox!;
  check('亭子落地：底面贴 z=0', Math.abs(box.min.z) < 0.02, `${box.min.z.toFixed(3)}`);
  check(`亭子总高 ${box.max.z.toFixed(2)} m（真人尺度 3–7 m）`, box.max.z > 3 && box.max.z < 7);
  pavilionModel!.geometry.dispose();

  // 履带吊：一辆车就是一个造型实体，靠「子装配 + 阵列」拼，别退化成几个大方块
  const crane = libraryFeatures('crawler-crane');
  const craneOf = (id: string) => crane.find((feature) => feature.id === id);
  const groupChildren = (id: string) => {
    const feature = craneOf(id);
    return feature && feature.shape.shape === 'group' ? feature.shape.features : [];
  };
  check(
    '履带镜像成对（group + mirror，不是手抄两份）',
    craneOf('cc-track')?.pattern?.type === 'mirror',
    `${craneOf('cc-track')?.pattern?.type}`,
  );
  const trackParts = groupChildren('cc-track');
  const part = (id: string) => trackParts.find((feature) => feature.id === id);
  check(
    '履带环是闭合 sweep（stadium 路径 + 矩形截面）',
    part('cc-belt')?.shape.shape === 'sweep'
      && Boolean((part('cc-belt') as { shape: { closed?: boolean } }).shape.closed),
  );
  const grouserLow = part('cc-grouser-low');
  const grouserEnd = part('cc-grouser-front');
  check(
    `履带齿连成一条带（直段 ${grouserLow?.pattern?.count ?? 0} 齿 + 两端圆弧各 ${grouserEnd?.pattern?.count ?? 0} 齿）`,
    (grouserLow?.pattern?.count ?? 0) >= 20 && grouserEnd?.pattern?.type === 'circular',
  );
  check(
    '履带架是白色分段侧板（3 段→看得见接缝），不是一根黑梁',
    trackParts.filter((feature) => feature.id.startsWith('cc-frame-')).length === 3
      && trackParts.filter((feature) => feature.id.startsWith('cc-frame-'))
        .every((feature) => feature.shape.shape === 'prism'),
  );
  check(
    '支重轮端盖排成一行 + 端部轮盘有一圈螺栓孔（这两个是「像履带」的关键）',
    (part('cc-roller-cap')?.pattern?.count ?? 0) >= 6
      && (part('cc-idler-hole')?.pattern?.count ?? 0) >= 12,
  );
  // 上车梯：真机是**斜爬梯**（两根斜梁 + 一级级水平踏板 + 两侧扶手），不是竖直小爬梯。
  // 早先做过两版都不对：一版「立杆沿 y 间隔」整架侧对着车体、一半插进履带；
  // 一版竖直落地、只有两杆五档，正侧图里就是挂在半空的晾衣架。
  const ladderStringer = craneOf('cc-ladder-stringer') as
    | { translate?: number[]; rotate?: number[]; pattern?: { count?: number; step?: number[] }; shape?: { height?: number } }
    | undefined;
  const ladderStep = craneOf('cc-ladder-step') as
    | { translate?: number[]; pattern?: { count?: number; step?: number[] } }
    | undefined;
  const stAng = ladderStringer?.rotate?.[1] ?? 0;            // 绕 +y 的倾角（= 90° − 梯子与地面夹角）
  const stLen = ladderStringer?.shape?.height ?? 0;
  const stBottom = (ladderStringer?.translate?.[2] ?? 9) - (stLen / 2) * Math.cos((stAng * Math.PI) / 180);
  const stBottomX = (ladderStringer?.translate?.[0] ?? 0) - (stLen / 2) * Math.sin((stAng * Math.PI) / 180);
  check(
    `上车梯是斜梯：与地面夹角 ${(90 - stAng).toFixed(0)}°（45–70° 才是楼梯，不是直梯）`,
    stAng >= 20 && stAng <= 45,
  );
  check(
    `上车梯底端落地（z=${stBottom.toFixed(2)}）且落在履带后端之后（x=${stBottomX.toFixed(2)} < −2.5）`,
    Math.abs(stBottom) < 0.06 && stBottomX < -2.5,
  );
  check(
    `斜梯有 ${ladderStep?.pattern?.count ?? 0} 级水平踏板（阵列 step 同时有 Δx 与 Δz，踩的是水平面）`,
    (ladderStep?.pattern?.count ?? 0) >= 7
      && (ladderStep?.pattern?.step?.[0] ?? 0) > 0.05
      && (ladderStep?.pattern?.step?.[2] ?? 0) > 0.1,
  );
  check(
    '上车梯两侧扶手 + 立柱 + 顶端横杆都在（缺一件就退回「几根杆」）',
    ['cc-ladder-handrail', 'cc-ladder-post', 'cc-ladder-post-in', 'cc-ladder-topbar']
      .every((id) => Boolean(craneOf(id))),
  );
  const body = craneOf('cc-body');
  check(
    '车头是放样曲面（loft，斜切 + 顶圆角），不是一个圆角盒',
    body?.shape.shape === 'loft' && (body.shape as { sections: unknown[] }).sections.length >= 12,
    `${body?.shape.shape}`,
  );
  const sections = (body?.shape as { sections: Array<{ z: number; profile: number[][] }> })?.sections ?? [];
  const frontOf = (section: { profile: number[][] }) => Math.max(...section.profile.map((point) => point[0]));
  const lower = sections.find((section) => section.z > 1.7);
  const upper = sections[sections.length - 2];
  check(
    '前脸连续前倾：越往上前端越靠后（复刻参考件的斜切车头）',
    Boolean(lower && upper) && frontOf(upper) < frontOf(lower) - 0.15,
    lower && upper ? `${frontOf(lower).toFixed(2)} → ${frontOf(upper).toFixed(2)}` : '-',
  );
  // 参考件量出来前脸后倾 ≈38°（z=1.57 处 1.28 m → z=2.55 处 0.50 m），这里卡 0.55 m 后退 / ≥30°
  const rakeLow = sections.filter((section) => section.z > 1.55).sort((a, b) => a.z - b.z);
  const rakeA = rakeLow[0];
  const rakeB = rakeLow[rakeLow.length - 2];
  const drop = rakeA && rakeB ? frontOf(rakeA) - frontOf(rakeB) : 0;
  const rakeDeg = rakeA && rakeB ? (Math.atan2(drop, rakeB.z - rakeA.z) * 180) / Math.PI : 0;
  check(
    `前脸后倾 ${rakeDeg.toFixed(0)}°（参考件量到 ≈38°，竖直墙是 0°）`,
    drop >= 0.55 && rakeDeg >= 30,
    `z ${rakeA?.z.toFixed(2)}→${rakeB?.z.toFixed(2)}：x ${frontOf(rakeA ?? { profile: [[0]] }).toFixed(2)}→${frontOf(rakeB ?? { profile: [[0]] }).toFixed(2)}`,
  );
  // 机罩要给驾驶室让位：驾驶室那一侧（y<−0.9）的机罩前端只到 x≈−0.5，另一侧才伸到 1.2+
  const notchSection = sections.find((section) => section.z > 2.0 && section.z < 2.3);
  const notchPts = (notchSection?.profile ?? []).filter((p) => p[1] < -0.9);
  const farPts = (notchSection?.profile ?? []).filter((p) => p[1] > 0.9);
  check(
    '机罩在驾驶室那一侧让位（挖了缺口，驾驶室才站得住）',
    notchPts.length > 0 && farPts.length > 0
      && Math.max(...notchPts.map((p) => p[0])) < -0.45
      && Math.max(...farPts.map((p) => p[0])) > 0.6,
    notchPts.length ? `驾驶室侧 ${Math.max(...notchPts.map((p) => p[0])).toFixed(2)} / 另一侧 ${Math.max(...farPts.map((p) => p[0])).toFixed(2)}` : '-',
  );
  // 逐层单调后退，杜绝「竖直墙 + 顶倒角」
  const wall = sections.filter((section) => section.z >= 1.58 && section.z <= 2.3).sort((a, b) => a.z - b.z);
  check(
    '前脸逐层单调后退（没有先竖直再突然倒角的台阶）',
    wall.length >= 4 && wall.every((section, i) => i === 0 || frontOf(section) < frontOf(wall[i - 1]) + 1e-6),
    `${wall.length} 层`,
  );
  const boomParts = groupChildren('cc-boom');
  const boomMain = boomParts.find((feature) => feature.id === 'cc-boom-main');
  check(
    '主臂是整体锥形箱型节（prism + taper），不是拼出来的方块',
    boomMain?.shape.shape === 'prism'
      && (boomMain.shape.taper ?? 1) < 0.8
      && boomMain.shape.height > 10,
    `${boomMain?.shape.shape} taper=${boomMain?.shape.shape === 'prism' ? boomMain.shape.taper : '-'}`,
  );
  check(
    `臂节套 ${boomParts.filter((feature) => feature.id.startsWith('cc-boom-collar-')).length} 处（伸缩臂的节间带）`,
    boomParts.filter((feature) => feature.id.startsWith('cc-boom-collar-')).length >= 2,
  );
  check(
    '臂头是开放框架（立柱 + 横杆 + 3 只起升滑轮），不是实心盒子',
    boomParts.filter((feature) => feature.id.startsWith('cc-head-post')).length === 2
      && (boomParts.find((feature) => feature.id === 'cc-sheave')?.pattern?.count ?? 0) === 3,
  );
  const raise = craneOf('cc-boom')?.rotate?.[1] ?? 0;
  check(`主臂仰角 ${(90 - raise).toFixed(0)}°（30–70°，太陡/太平都不像在吊装）`, 90 - raise > 30 && 90 - raise < 70);
  check(
    '变幅用双液压缸（缸筒 + 镀铬活塞杆，各镜像一对）',
    ['cc-cyl-barrel', 'cc-cyl-rod'].every((id) => craneOf(id)?.pattern?.type === 'mirror'),
  );
  const cabKids = groupChildren('cc-cab');
  const cabKid = (id: string) => cabKids.find((feature) => feature.id === id);
  check(
    '起升绳 + 吊钩滑轮组 + 驾驶室都在',
    ['cc-rope', 'cc-hook', 'cc-hook-sheave', 'cc-cab'].every((id) => Boolean(craneOf(id))),
  );

  /* 驾驶室：镂空必须靠几何（离屏渲染不支持透明度）。
   * 骨架围出窗洞 + 窗洞里真的空着 + 内装填进去 —— 这三件缺一件就退回「塑料盒子」。 */
  const cabFrameIds = ['cc-cab-sill', 'cc-cab-panel', 'cc-cab-belt', 'cc-cab-header', 'cc-cab-roof'];
  check(
    '驾驶室是深色骨架（底裙/下围/腰梁/窗楣/顶盖 5 道横框）',
    cabFrameIds.every((id) => {
      const feature = cabKid(id) as { shape?: { shape?: string } } | undefined;
      return feature?.shape?.shape === 'loft';
    }),
    cabFrameIds.map((id) => (cabKid(id) ? '✓' : '✗')).join(''),
  );
  check(
    '驾驶室有 3 组立柱 × 左右两侧（后柱 / B 柱 / 前柱）',
    ['cc-cab-post-rear', 'cc-cab-post-mid', 'cc-cab-post-front'].every(
      (id) => (cabKid(id) as { pattern?: { count?: number } } | undefined)?.pattern?.count === 2,
    ),
  );
  // 窗洞高度 = 窗楣下沿 − 腰梁上沿；要求占舱体总高 ≥ 40%（否则又成了「一坨」）
  const cabRoof = cabKid('cc-cab-roof') as { shape: { sections: Array<{ z: number }> } } | undefined;
  const cabRoofZ = (cabRoof?.shape.sections ?? []).map((section) => section.z);
  const cabTopZ = Math.max(...cabRoofZ);
  const cabHeader = cabKid('cc-cab-header') as { shape: { sections: Array<{ z: number }> } } | undefined;
  const cabHeaderZ = (cabHeader?.shape.sections ?? []).map((section) => section.z);
  const cabBelt = cabKid('cc-cab-belt') as { shape: { sections: Array<{ z: number }> } } | undefined;
  const cabBeltZ = (cabBelt?.shape.sections ?? []).map((section) => section.z);
  const winH = Math.min(...(cabHeaderZ.length ? cabHeaderZ : [NaN])) - Math.max(...(cabBeltZ.length ? cabBeltZ : [NaN]));
  const cabH = cabTopZ - Math.min(...(cabFrameIds.includes('cc-cab-sill')
    ? ((cabKid('cc-cab-sill') as { shape: { sections: Array<{ z: number }> } }).shape.sections).map((sec) => sec.z)
    : [0]));
  check(
    `窗洞高 ${winH.toFixed(2)} m / 舱体 ${cabH.toFixed(2)} m（占 ${(winH / cabH * 100).toFixed(0)}%，≥40% 才是「框架」不是「罐子」）`,
    winH / cabH >= 0.4,
  );
  check(
    '侧面窗是分格的：下半格玻璃 + 上半格敞开（离屏渲染不透明，只能靠上格留空看到内部）',
    (() => {
      const glass = cabKid('cc-cab-glass-o') as { shape?: { height?: number } } | undefined;
      return Boolean(glass?.shape?.height) && (glass!.shape!.height as number) < winH * 0.6;
    })(),
    `玻璃高 ${(cabKid('cc-cab-glass-o') as { shape?: { height?: number } } | undefined)?.shape?.height ?? 0} / 窗洞 ${winH.toFixed(2)}`,
  );
  check(
    '窗洞里有内装（座椅 + 操纵台 + 操纵杆），镂空才不是黑洞',
    ['cc-cab-seat', 'cc-cab-seat-back', 'cc-cab-console', 'cc-cab-lever'].every((id) => Boolean(cabKid(id))),
  );
  check(
    '外侧防护网悬挑在窗外：9 根竖条 + 横条 + 四边框',
    (cabKid('cc-cab-net-v') as { pattern?: { count?: number } } | undefined)?.pattern?.count === 9
      && ['cc-cab-net-h', 'cc-cab-net-frame-h', 'cc-cab-net-frame-v'].every((id) => Boolean(cabKid(id))),
  );
  // 防护网要比玻璃更靠外（悬挑），不然读成「窗上贴的贴纸」
  const netY = (cabKid('cc-cab-net-v') as { translate?: number[] } | undefined)?.translate?.[1] ?? 0;
  const glassY = (cabKid('cc-cab-glass-o') as { translate?: number[] } | undefined)?.translate?.[1] ?? 0;
  check(
    `防护网悬挑 ${Math.abs(netY - glassY).toFixed(2)} m 挂在玻璃外面（不是贴在窗上）`,
    Math.abs(netY - glassY) >= 0.05,
  );

  const craneProject = createProject({ name: '履带吊' });
  const craneDoc = applyOps(craneProject, [
    { op: 'addSolid', name: '履带式起重机', features: crane, position: [0, 0, 0] },
  ]);
  const craneModel = buildElementModel(craneDoc.document, craneDoc.document.elements[0]);
  craneModel!.geometry.computeBoundingBox();
  const craneBox = craneModel!.geometry.boundingBox!;
  const craneSize = craneBox.getSize(new Vector3());
  check('履带吊落地：履带板贴 z=0', Math.abs(craneBox.min.z) < 0.02, `${craneBox.min.z.toFixed(3)}`);
  check(
    `履带吊总高 ${craneBox.max.z.toFixed(1)} m / 前伸 ${craneSize.x.toFixed(1)} m（60 t 级真机尺度）`,
    craneBox.max.z > 10 && craneBox.max.z < 20 && craneSize.x > 8 && craneSize.x < 20,
  );
  check(
    `横向 ${craneSize.y.toFixed(1)} m（履带轨距 + 履带板宽，2.5–7 m）`,
    craneSize.y > 2.5 && craneSize.y < 7,
  );
  craneModel!.geometry.dispose();
}

if (failures.length) {
  console.error(`\n模板测试失败 ${failures.length} 项：`);
  failures.forEach((failure) => console.error(` - ${failure}`));
  process.exit(1);
}
console.log(`\n设计库模板测试通过（${passed} 项）`);
