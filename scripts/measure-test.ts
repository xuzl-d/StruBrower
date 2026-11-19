/**
 * measure 几何测量测试：悬浮 / 嵌入 / 表面高度 / 包围盒 / 错误提示。
 */
import { runMeasure } from '../src/ai/measure';
import type { ProjectDocument } from '../src/bim/types';

let failed = 0;
function check(name: string, ok: boolean, detail?: unknown) {
  if (ok) console.log('  ✓', name);
  else { failed += 1; console.log('  ✗', name, detail ?? ''); }
}

const box = (id: string, label: string, size: [number, number, number], translate: [number, number, number]) => ({
  id,
  label,
  mode: 'add',
  shape: { shape: 'box', width: size[0], depth: size[1], height: size[2] },
  translate,
});

function docWith(features: unknown[]): ProjectDocument {
  return {
    elements: [{ id: 'e1', name: '测试体', category: 'mesh', primitive: { kind: 'solid', features } }],
  } as unknown as ProjectDocument;
}

// 底座 1×1×1（z 0..1，居中于原点）；顶部小块分别悬浮 2cm / 嵌入 3cm / 贴合
const base = box('f1', '底座', [1, 1, 1], [0, 0, 0.5]);
const floating = box('f2', '悬浮块', [0.2, 0.2, 0.2], [0, 0, 1.12]);
const embedded = box('f3', '嵌入块', [0.2, 0.2, 0.2], [0, 0, 1.07]);

{
  const text = runMeasure(docWith([base, floating]), [{ type: 'gap', a: '底座', b: '悬浮块' }]);
  check('悬浮块判为有间隙', text.includes('有间隙'), text);
  check('距离约 0.020', text.includes('0.020'), text);
}
{
  const text = runMeasure(docWith([base, embedded]), [{ type: 'gap', a: '底座', b: '嵌入块' }]);
  check('嵌入块判为穿插', text.includes('穿插'), text);
}
{
  const text = runMeasure(docWith([base]), [{ type: 'surface', at: [0, 0], axis: 'z' }]);
  check('顶面 z=1.000', text.includes('z=1.000'), text);
}
{
  const text = runMeasure(docWith([base]), [{ type: 'bounds' }]);
  check('包围盒尺寸 1×1×1', text.includes('1.000 × 1.000 × 1.000'), text);
}
{
  const text = runMeasure(docWith([base]), [{ type: 'bounds', feature: '不存在' }, { type: 'bounds', target: '别的' }]);
  check('特征找不到给出可用列表', text.includes('找不到特征') && text.includes('底座'), text);
  check('构件找不到给出可用列表', text.includes('找不到造型构件'), text);
}
{
  const text = runMeasure({ elements: [] } as unknown as ProjectDocument, [{ type: 'bounds' }]);
  check('没有造型构件时给出说明', text.includes('没有造型构件'), text);
}

// 几何体检 anomalies：抓出飘离/超大零件（AI 无截图时的自查数字证据）
{
  // 两个尺寸相近、位置合理的零件：不应误报
  const normal = box('f4', '正常块', [0.9, 0.9, 0.9], [0, 0, 1.5]);
  const text = runMeasure(docWith([base, normal]), [{ type: 'anomalies' }]);
  check('正常模型不误报离群', text.includes('未发现明显离群'), text);
}
{
  // 一个横向 8m 的薄板：其余零件整体 1m，明显超大
  const huge = box('h1', '甩散的环', [8, 0.02, 0.02], [0, 0, 0.5]);
  const text = runMeasure(docWith([base, huge]), [{ type: 'anomalies' }]);
  check('超大零件被报出', text.includes('甩散的环') && text.includes('跨度达'), text);
}
{
  // circular 阵列中心留在世界原点：4 个小环绕原点散开，整组特征跨度巨大
  const ring: Record<string, unknown> = {
    id: 'r1', label: '同心丝', mode: 'add',
    shape: { shape: 'torus', radius: 0.15, tube: 0.005 },
    pattern: { type: 'circular', axis: 'z', count: 4, center: [0, 0, 0] },
    translate: [2, 0, 2],
  };
  const text = runMeasure(docWith([base, ring]), [{ type: 'anomalies' }]);
  check('阵列散开的环被报出', text.includes('同心丝') && (text.includes('跨度达') || text.includes('飘离')), text);
}

// 语义级 measure：包覆关系与轴向收口（区分「罩子」和「平面圆盘」）
{
  const guard = box('g1', '罩体', [0.6, 0.4, 0.6], [0, 0.1, 0.5]);
  const blade = box('b1', '叶片', [0.3, 0.02, 0.1], [0, 0.1, 0.5]);
  const text = runMeasure(docWith([blade, guard]), [{ type: 'enclosure', outer: '罩体', inner: '叶片', axis: 'y', margin: 0.01 }]);
  check('包住时给出三向包覆结论', text.includes('外件在三个方向都包住内件'), text);
}
{
  const guard = box('g2', '罩体', [0.2, 0.02, 0.2], [0, 0.1, 0.5]);
  const blade = box('b2', '叶片', [0.3, 0.02, 0.1], [0, 0.1, 0.5]);
  const text = runMeasure(docWith([blade, guard]), [{ type: 'enclosure', outer: '罩体', inner: '叶片', axis: 'y' }]);
  check('没包住时明确指出未包住', text.includes('没有完整包住内件'), text);
}
{
  const rings = [
    box('p1', '前罩环1', [0.5, 0.01, 0.5], [0, 0.12, 0.5]),
    box('p2', '前罩环2', [0.35, 0.01, 0.35], [0, 0.15, 0.5]),
    box('p3', '前罩环3', [0.2, 0.01, 0.2], [0, 0.18, 0.5]),
  ];
  const text = runMeasure(docWith(rings), [{ type: 'axialProfile', feature: '前罩环', axis: 'y' }]);
  check('递缩截面判为收口明显', text.includes('收口明显'), text);
  check('轴向轮廓列出三个截面', (text.match(/半径≈/g) ?? []).length === 3, text);
}
{
  const flat = [
    box('q1', '平盘环1', [0.3, 0.01, 0.3], [0, 0.12, 0.5]),
    box('q2', '平盘环2', [0.3, 0.01, 0.3], [0, 0.15, 0.5]),
    box('q3', '平盘环3', [0.3, 0.01, 0.3], [0, 0.18, 0.5]),
  ];
  const text = runMeasure(docWith(flat), [{ type: 'axialProfile', feature: '平盘环', axis: 'y' }]);
  check('等半径截面判为几乎不收口', text.includes('几乎不收口'), text);
}

// 对齐诊断：抓「护条阵列偏心」与「护条戳出罩体」——现有包覆/轮廓测量都漏掉
{
  // 罩体 y∈[0.05,0.15] 中心 0.1；护条 y∈[0.14,0.22] 中心 0.18：既偏心又戳出高端
  const cage = box('a1', '罩体', [0.5, 0.1, 0.5], [0, 0.1, 0.5]);
  const bars = box('a2', '弯曲护条', [0.5, 0.08, 0.5], [0, 0.18, 0.5]);
  const text = runMeasure(docWith([cage, bars]), [{ type: 'alignment', base: '罩体', compare: '弯曲护条', axis: 'y' }]);
  check('对齐诊断报出 y 方向偏心', text.includes('y: 中心偏移 0.080 m 偏心'), text);
  check('对齐诊断给出判断结论', text.includes('弯曲护条') || text.includes('compare'), text);
  check('对齐诊断含阵列中心修正建议', text.includes('pattern.center') || text.includes('阵列中心'), text);
}
{
  // 同轴同界：中心偏移为 0，判为对齐
  const cage = box('a3', '罩体', [0.5, 0.1, 0.5], [0, 0.1, 0.5]);
  const bars = box('a4', '弯曲护条', [0.4, 0.08, 0.4], [0, 0.1, 0.5]);
  const text = runMeasure(docWith([cage, bars]), [{ type: 'alignment', base: '罩体', compare: '弯曲护条', axis: 'y' }]);
  check('同轴时判为三者中心对齐', text.includes('三者中心对齐'), text);
}

// 实心面遮挡：抓「防护网被做成实心锅盖 / 镂空网架」——填充率给出数字证据
{
  // 一块实心板铺满投影面：应判为实心面（锅盖）。box 沿 y 很薄，投影到 xz 是整块面。
  const lid = box('s1', '实心锅盖', [0.5, 0.02, 0.5], [0, 0.12, 0.5]);
  const text = runMeasure(docWith([lid]), [{ type: 'solidCover', feature: '实心锅盖', axis: 'y', grid: 9 }]);
  check('实心板判为疑似实心面', text.includes('疑似实心面'), text);
  check('实心板给出锅盖/网罩修正建议', text.includes('锅盖') && text.includes('sweep'), text);
}
{
  // 一条细环（torus）投影稀疏：应判为镂空骨架，不误报锅盖。
  const ring: Record<string, unknown> = {
    id: 's2', label: '镂空网圈', mode: 'add',
    shape: { shape: 'torus', radius: 0.25, tube: 0.004 },
    translate: [0, 0.12, 0.5], rotate: [90, 0, 0],
  };
  const text = runMeasure(docWith([ring]), [{ type: 'solidCover', feature: '镂空网圈', axis: 'y', grid: 9 }]);
  check('细网圈判为镂空骨架', text.includes('镂空骨架'), text);
}
{
  // 密集 grille 网罩 + 实心锅盖：默认网格必须能把两者分开（9×9 会把细丝过度计数误判）
  const grille: Record<string, unknown> = {
    id: 'g1', label: '镂空穹顶', mode: 'add',
    shape: { shape: 'grille', radius: 0.285, depth: 0.07, rings: 5, spokes: 24, wire: 0.0035 },
    rotate: [90, 0, 0],
  };
  const lid: Record<string, unknown> = {
    id: 'g2', label: '实心锅盖', mode: 'add',
    shape: { shape: 'loft', sections: [{ z: -0.04, ellipse: { rx: 0.18, ry: 0.18 } }, { z: 0.04, ellipse: { rx: 0.255, ry: 0.255 } }] },
    rotate: [90, 0, 0],
  };
  const cageText = runMeasure(docWith([grille]), [{ type: 'solidCover', feature: '镂空穹顶', axis: 'y' }]);
  const lidText = runMeasure(docWith([lid]), [{ type: 'solidCover', feature: '实心锅盖', axis: 'y' }]);
  check('默认网格下密集网罩判为镂空骨架', cageText.includes('镂空骨架'), cageText);
  check('默认网格下实心 loft 判为实心面', lidText.includes('疑似实心面'), lidText);
  const cageFill = Number(cageText.match(/填充率 (\d+)%/)?.[1]);
  const lidFill = Number(lidText.match(/填充率 (\d+)%/)?.[1]);
  check('网罩与实心面填充率至少差 30 个百分点', lidFill - cageFill >= 30, `cage=${cageFill} lid=${lidFill}`);
}
{
  const text = runMeasure(docWith([base]), [{ type: 'solidCover', feature: '不存在', axis: 'y' }]);
  check('solidCover 特征找不到给出列表', text.includes('找不到特征') && text.includes('底座'), text);
}

console.log(failed === 0 ? '\nmeasure 测试全部通过' : `\nmeasure 测试失败：${failed} 项`);
process.exit(failed === 0 ? 0 : 1);
