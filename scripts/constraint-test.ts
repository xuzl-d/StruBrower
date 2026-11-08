/**
 * 通用约束测试：任意特征树上的「尺寸寻址 → 驱动式 → 校验式」全链路。
 *
 * 关注四件事有没有真的贯通：
 *   1. 尺寸寻址：任意形状/阵列/修饰字段都能被路径指到、读、写；
 *   2. 驱动式：别名 + 表达式 → 拓扑序求值 → 写回特征字段 → 几何重建；
 *   3. 校验式：要求不成立时**只报告**，不偷改模型；
 *   4. 工程细节：成环、引用不存在、特征增删后的路径搬家、服务端拒绝。
 * 全走真实链路（applyOps / recomputeParameters / buildElementModel），不直连内核。
 */
import { Vector3 } from 'three';
import { buildElementModel } from '../src/bim/geometry';
import { createProject } from '../src/bim/template';
import { applyOps } from '../server/ai/ops.js';
import { buildProjectContext } from '../server/ai/context.js';
import { elementParameterSpec, readElementParameter, recomputeParameters } from '../src/bim/parameters';
import { resolveElementConstraints } from '../src/bim/constraints';
import { buildParametricFeatures } from '../src/bim/parametric';
import { clampDimension, listDimensions, readDimension, writeDimension } from '../shared/dimensions.js';
import { planConstraints, rebaseConstraints, resolveConstraints } from '../shared/constraints.js';
import type { MeshInstance, ProjectDocument } from '../src/bim/types';

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

const near = (a: number, b: number, tolerance = 1e-6) => Math.abs(a - b) <= tolerance;

/** 一座小亭子（静态特征树，不是模板）：台基 / 檐柱阵列 / 宝顶 / 压顶 */
const FEATURES = [
  { shape: 'box', label: '台基', width: 2.4, depth: 2.4, height: 0.2, translate: [0, 0, 0.1] },
  {
    shape: 'cylinder', label: '檐柱', radius: 0.12, height: 2.5, translate: [0, 0, 1.55],
    pattern: { type: 'circular', count: 6, axis: 'z' },
  },
  { shape: 'sphere', label: '宝顶', radius: 0.2, translate: [0, 0, 3.0] },
  { shape: 'box', label: '压顶', width: 2.6, depth: 2.6, height: 0.1, translate: [0, 0, 2.85], fillet: 0.02 },
];

function buildSolid(features: unknown[] = FEATURES, name = '试验亭') {
  const project = createProject({ name: '约束' });
  const { document } = applyOps(project, [
    { op: 'addSolid', name, features, position: [0, 0, 0] },
  ]);
  return { document, element: document.elements[0] as MeshInstance };
}

function sizeOf(document: ProjectDocument, element: MeshInstance) {
  const model = buildElementModel(document, element);
  if (!model) return null;
  model.geometry.computeBoundingBox();
  const box = model.geometry.boundingBox!;
  const size = box.getSize(new Vector3());
  const result = { minZ: box.min.z, maxZ: box.max.z, x: size.x, y: size.y, z: size.z };
  model.geometry.dispose();
  return result;
}

/* ------------------------------ 尺寸寻址 ------------------------------ */

console.log('尺寸寻址：任意模型都能被指到');
{
  const { element } = buildSolid();
  const dims = listDimensions(element);
  const paths = dims.map((spec) => spec.path);

  check(`枚举出 ${dims.length} 个可驱动尺寸`, dims.length >= 12, paths.join(','));
  check('形状字段：台基高 f1.height', paths.includes('f1.height'));
  check('阵列字段：柱半径 f2.radius', paths.includes('f2.radius'));
  check('阵列数量 f2.count', paths.includes('f2.count'));
  check('平移可按轴寻址 f2.translate.2', paths.includes('f2.translate.2'));
  check('球半径 f3.radius', paths.includes('f3.radius'));
  check('修饰字段 f4.fillet（倒圆半径）', paths.includes('f4.fillet'));
  check('没有抽壳就没有 f4.shell', !paths.includes('f4.shell'));

  const count = dims.find((spec) => spec.path === 'f2.count');
  check('阵列数量是整数尺寸', Boolean(count?.integer), JSON.stringify(count));
  check('阵列数量范围 1–192', count?.min === 1 && count?.max === 192, `${count?.min}~${count?.max}`);
  check('倒圆半径标为长度', dims.find((spec) => spec.path === 'f4.fillet')?.unit === 'length');
  check('分组带上特征名（第 2 特征）', (dims.find((spec) => spec.path === 'f2.radius')?.group ?? []).some((item) => item.includes('檐柱')));

  check('读尺寸：柱高 2.5', near(readDimension(element, 'f2.height') ?? -1, 2.5));
  check('读尺寸：平移 z 1.55', near(readDimension(element, 'f2.translate.2') ?? -1, 1.55));
  check('读不存在的路径返回 null', readDimension(element, 'f9.height') === null);

  const taller = writeDimension(element, 'f2.height', 3.2);
  check('写尺寸不改原对象', near(readDimension(element, 'f2.height') ?? -1, 2.5));
  check('写尺寸得到新值', near(readDimension(taller, 'f2.height') ?? -1, 3.2));
  check('写数组下标：translate.2', near(readDimension(writeDimension(element, 'f2.translate.2', 9), 'f2.translate.2') ?? -1, 9));
  check('写 f4.fillet 保留对象其它键', (() => {
    const next = writeDimension(element, 'f4.fillet', 0.01);
    const fillet = next.primitive?.kind === 'solid' ? next.primitive.features[3]!.fillet : undefined;
    return Boolean(fillet && typeof fillet === 'object' && near(fillet.radius, 0.01));
  })());

  const stripped = writeDimension(element, 'f4.fillet', 0);
  const feature = stripped.primitive?.kind === 'solid' ? stripped.primitive.features[3]! : null;
  check('倒圆写成 0 时把修饰去掉', feature !== null && feature.fillet === undefined);

  const heightSpec = dims.find((spec) => spec.path === 'f2.height')!;
  check('clamp 到上限', near(clampDimension(heightSpec, 1e6) ?? -1, heightSpec.max));
  check('整数字段取整', clampDimension(count!, 6.6) === 7);
  check('非有限值夹成 null', clampDimension(heightSpec, Number.NaN) === null);
}

console.log('\n尺寸寻址：放样截面与子特征组');
{
  const { element } = buildSolid([
    { shape: 'box', label: '基体', width: 1, depth: 1, height: 0.2 },
    {
      shape: 'loft', label: '机身',
      sections: [
        { z: 0, ellipse: { rx: 0.5, ry: 0.4 } },
        { z: 2, ellipse: { rx: 0.3, ry: 0.25 } },
      ],
    },
    {
      shape: 'group', label: '桨组',
      features: [{ shape: 'box', label: '桨叶', width: 0.2, depth: 0.05, height: 0.01 }],
    },
  ]);
  const paths = listDimensions(element).map((spec) => spec.path);
  check('放样椭圆半径可寻址 f2.sections.0.ellipse.rx', paths.includes('f2.sections.0.ellipse.rx'));
  check('第二个截面也能寻址 f2.sections.1.ellipse.ry', paths.includes('f2.sections.1.ellipse.ry'));
  check('子特征组内的字段 f3.g1.width', paths.includes('f3.g1.width'));
  check('读放样截面值 0.5', near(readDimension(element, 'f2.sections.0.ellipse.rx') ?? -1, 0.5));
  const widened = writeDimension(element, 'f2.sections.1.ellipse.rx', 0.45);
  check('写放样截面值', near(readDimension(widened, 'f2.sections.1.ellipse.rx') ?? -1, 0.45));
  check('写子特征组字段', near(readDimension(writeDimension(element, 'f3.g1.width', 0.4), 'f3.g1.width') ?? -1, 0.4));
}

console.log('\n尺寸寻址：参数化构件只暴露模型参数');
{
  const project = createProject({ name: '约束' });
  const { document } = applyOps(project, [
    { op: 'addSolid', name: '支架', library: 'bracket' },
  ]);
  const element = document.elements[0] as MeshInstance;
  const dims = listDimensions(element);
  check('参数化构件只列 param.*（4 个）', dims.length === 4 && dims.every((spec) => spec.path.startsWith('param.')), dims.map((spec) => spec.path).join(','));
  check('param.width 可读', near(readDimension(element, 'param.width') ?? -1, 0.16));
}

/* ------------------------------ 驱动式约束 ------------------------------ */

console.log('\n驱动式约束：别名 → 表达式 → 特征字段');
{
  const { element } = buildSolid();
  const constrained: MeshInstance = {
    ...element,
    constraints: {
      dimensions: [
        { name: '柱高', path: 'f2.height' },
        { name: '宝顶标高', path: 'f3.translate.2' },
      ],
    },
    formulas: { 柱高: '2.5 + 0.4', 宝顶标高: '柱高 + 0.5' },
  };
  const result = resolveElementConstraints(constrained);

  check('别名驱动的尺寸被改写（2.5 → 2.9）', near(readDimension(result.element, 'f2.height') ?? -1, 2.9), String(readDimension(result.element, 'f2.height')));
  check('二级依赖按拓扑序求值（宝顶 3.4）', near(readDimension(result.element, 'f3.translate.2') ?? -1, 3.4), String(readDimension(result.element, 'f3.translate.2')));
  check('没有违规', result.violations.length === 0, result.violations.map((item) => item.message).join('；'));
  check('updates 记录 from/to', result.updates.length === 2 && near(result.updates[0]!.from, 2.5) && near(result.updates[0]!.to, 2.9));
  check('updates 带中文标签', result.updates.some((item) => item.label === '柱高'));
  check('不改入参', near(readDimension(constrained, 'f3.translate.2') ?? -1, 3.0));
}

console.log('\n驱动式约束：不起名，直接用路径');
{
  const { element } = buildSolid();
  const constrained: MeshInstance = { ...element, formulas: { 'f2.height': 'f1.height * 12' } };
  const result = resolveElementConstraints(constrained);
  check('路径当公式键', near(readDimension(result.element, 'f2.height') ?? -1, 2.4), String(readDimension(result.element, 'f2.height')));
  check('路径之间可以互相引用', result.violations.length === 0, result.violations.map((item) => item.message).join('；'));
}

console.log('\n驱动式约束：几何真的跟着变');
{
  const { document, element } = buildSolid();
  // 柱高 → 宝顶标高、压顶标高：改一个数，整座亭子的竖向尺寸跟着走
  const constraintDef = {
    dimensions: [
      { name: '柱高', path: 'f2.height' },
      { name: '宝顶标高', path: 'f3.translate.2' },
      { name: '压顶标高', path: 'f4.translate.2' },
    ],
    checks: [],
  };
  const constrained: MeshInstance = {
    ...element,
    constraints: { dimensions: constraintDef.dimensions },
    formulas: { 柱高: '3.1', 宝顶标高: '柱高 + 0.5', 压顶标高: '柱高 + 0.35' },
  };
  const before = sizeOf(document, element)!;
  const result = resolveElementConstraints(constrained);
  const after = sizeOf(document, result.element)!;
  check(`柱高 2.5→3.1 总高 +0.6（${before.maxZ.toFixed(2)} → ${after.maxZ.toFixed(2)}）`, near(after.maxZ - before.maxZ, 0.6, 0.02));
  check('平面尺寸不受影响', near(after.x, before.x, 0.01));

  const shorter = resolveElementConstraints({
    ...constrained,
    formulas: { 柱高: '2.0', 宝顶标高: '柱高 + 0.5', 压顶标高: '柱高 + 0.35' },
  });
  const smaller = sizeOf(document, shorter.element)!;
  check(`柱高 2.5→2.0 总高 −0.5（${before.maxZ.toFixed(2)} → ${smaller.maxZ.toFixed(2)}）`, near(before.maxZ - smaller.maxZ, 0.5, 0.02));
}

console.log('\n驱动式约束：夹紧与整数');
{
  const { element } = buildSolid();
  const result = resolveElementConstraints({
    ...element,
    constraints: { dimensions: [{ name: '柱数', path: 'f2.count' }, { name: '柱高', path: 'f2.height' }] },
    formulas: { 柱数: '6.6', 柱高: '9999' },
  });
  check('整数尺寸取整（6.6 → 7）', readDimension(result.element, 'f2.count') === 7, String(readDimension(result.element, 'f2.count')));
  check('越界尺寸夹到上限（500）', near(readDimension(result.element, 'f2.height') ?? -1, 500), String(readDimension(result.element, 'f2.height')));
}

/* ------------------------------ 校验式约束 ------------------------------ */

console.log('\n校验式约束：只报告，不改值');
{
  const { element } = buildSolid();
  const passing = resolveElementConstraints({
    ...element,
    constraints: {
      dimensions: [{ name: '柱高', path: 'f2.height' }],
      checks: [{ id: 'c1', expr: '柱高 >= 2.2', message: '柱高不足 2.2 m' }],
    },
  });
  check('要求成立时无违规', passing.violations.length === 0, passing.violations.map((item) => item.message).join('；'));

  const failing = resolveElementConstraints({
    ...element,
    formulas: { 'f2.height': '1.8' },
    constraints: {
      dimensions: [{ name: '柱高', path: 'f2.height' }],
      checks: [{ id: 'c1', expr: '柱高 >= 2.2', message: '柱高不足 2.2 m，亭下站不直' }],
    },
  });
  check('要求不成立时报违规', failing.violations.length === 1, String(failing.violations.length));
  check('违规带上人话说明', failing.violations[0]?.message.includes('站不直'), failing.violations[0]?.message);
  check('校验违规不阻止求值（柱高仍是 1.8）', near(readDimension(failing.element, 'f2.height') ?? -1, 1.8));
  check('校验式不影响其它尺寸', near(readDimension(failing.element, 'f3.translate.2') ?? -1, 3.0));

  const warned = resolveElementConstraints({
    ...element,
    constraints: { checks: [{ id: 'w1', expr: 'f2.height <= 2.0', severity: 'warn' }] },
  });
  check('severity=warn 也报，但级别是 warn', warned.violations[0]?.severity === 'warn', JSON.stringify(warned.violations[0]));

  const cross = resolveElementConstraints({
    ...element,
    constraints: { checks: [{ id: 'c2', expr: 'f3.translate.2 > f2.height', message: '宝顶压在柱身里' }] },
  });
  check('校验式可以跨特征比较（用路径）', cross.violations.length === 0, cross.violations.map((item) => item.message).join('；'));
}

/* ------------------------------ 出错时的行为 ------------------------------ */

console.log('\n出错：不静默、不半更新');
{
  const { element } = buildSolid();
  const cycle = resolveElementConstraints({
    ...element,
    constraints: { dimensions: [{ name: '甲', path: 'f2.height' }, { name: '乙', path: 'f3.translate.2' }] },
    formulas: { 甲: '乙 - 0.5', 乙: '甲 + 0.5' },
  });
  check('成环被识别', cycle.violations.some((item) => item.message.includes('循环引用')), cycle.violations.map((item) => item.message).join('；'));
  check('成环时保留原值', near(readDimension(cycle.element, 'f2.height') ?? -1, 2.5) && near(readDimension(cycle.element, 'f3.translate.2') ?? -1, 3.0));

  const unknown = resolveElementConstraints({ ...element, constraints: { dimensions: [{ name: '柱高', path: 'f2.height' }] }, formulas: { 柱高: '檐口高 + 0.4' } });
  check('引用不存在的量被点出来', unknown.violations.some((item) => item.message.includes('檐口高')), unknown.violations.map((item) => item.message).join('；'));

  const badAlias = resolveElementConstraints({ ...element, constraints: { dimensions: [{ name: '柱高', path: 'f9.height' }] } });
  check('别名指向不存在的尺寸被点出来', badAlias.violations.some((item) => item.message.includes('f9.height')));

  const duplicate = resolveElementConstraints({
    ...element,
    formulas: { 'f2.height': '2', '柱高': '3' },
    constraints: { dimensions: [{ name: '柱高', path: 'f2.height' }] },
  });
  check('一个尺寸被两条公式驱动被点出来', duplicate.violations.some((item) => item.message.includes('同时驱动')), duplicate.violations.map((item) => item.message).join('；'));

  const dry = resolveConstraints(element, { globals: {}, dryRun: true });
  check('dryRun 不改 element', dry.element === element && dry.updates.length === 0);

  const plan = planConstraints(element);
  check('planConstraints 不写回（可服务端只校验）', plan.dimensions.length > 0 && plan.errors.length === 0);
}

/* ------------------------------ 公式联动（文档级） ------------------------------ */

console.log('\n文档级联动：recomputeParameters 走约束引擎');
{
  const { document, element } = buildSolid();
  const linked: ProjectDocument = {
    ...document,
    elements: document.elements.map((item) => (item.id === element.id ? {
      ...item,
      constraints: { dimensions: [{ name: '柱高', path: 'f2.height' }, { name: '宝顶标高', path: 'f3.translate.2' }] },
      formulas: { 柱高: '层高 - 0.3', 宝顶标高: '柱高 + 0.5' },
    } : item)),
  };
  const { project: next, report } = recomputeParameters(linked);
  const updated = next.elements[0] as MeshInstance;
  check('公式用到了构件上下文变量「层高」（3 → 2.7）', near(readDimension(updated, 'f2.height') ?? -1, 2.7), String(readDimension(updated, 'f2.height')));
  check('二级别名一起算（宝顶 3.2）', near(readDimension(updated, 'f3.translate.2') ?? -1, 3.2));
  check('报告里有尺寸更新', report.updates.some((item) => item.key === 'f2.height'));
  check('报告里没有误报问题', report.issues.length === 0, report.issues.map((item) => item.message).join('；'));
  check('受影响的构件计数为 1', report.affectedElements === 1, String(report.affectedElements));

  const again = recomputeParameters(next);
  check('收敛后不再产生更新', again.report.updates.length === 0 && again.project === next);
}

console.log('\n文档级联动：校验违规进报告');
{
  const { document, element } = buildSolid();
  const linked: ProjectDocument = {
    ...document,
    elements: document.elements.map((item) => (item.id === element.id ? {
      ...item,
      constraints: { checks: [{ id: 'c1', expr: 'f2.height >= 3', message: '柱高不足 3 m' }] },
    } : item)),
  };
  const { report } = recomputeParameters(linked);
  check('校验不满足写进 report.issues', report.issues.some((item) => item.message.includes('柱高不足 3')), report.issues.map((item) => item.message).join('；'));
  check('违规不产生更新（不改模型）', report.updates.length === 0);
}

console.log('\n参数表：被约束的尺寸会出现');
{
  const { element } = buildSolid();
  const constrained: MeshInstance = {
    ...element,
    constraints: { dimensions: [{ name: '柱高', path: 'f2.height' }] },
    formulas: { 'f3.translate.2': '2.9' },
  };
  const spec = elementParameterSpec(constrained, 'f2.height');
  check('别名尺寸进参数表', spec?.label === '柱高（高）', spec?.label);
  check('参数表给出范围', spec?.max === 500, String(spec?.max));
  check('公式目标也进参数表', Boolean(elementParameterSpec(constrained, 'f3.translate.2')));
  check('读参数走同一个寻址层', near(readElementParameter(constrained, 'f2.height') ?? -1, 2.5));
  check('未被约束的特征尺寸不进参数表', elementParameterSpec(constrained, 'f1.width') === undefined);
}

/* ------------------------------ 服务端：setConstraints ------------------------------ */

console.log('\n服务端：setConstraints 落库与拒绝');
{
  const { document, element } = buildSolid();
  const applied = applyOps(document, [{
    op: 'setConstraints',
    target: element.name,
    dimensions: [{ name: '柱高', path: 'f2.height' }, { name: '宝顶标高', path: 'f3.translate.2' }],
    formulas: { 柱高: '层高 - 0.3', 宝顶标高: '柱高 + 0.5' },
    checks: [{ expr: '柱高 >= 2.2', message: '柱高不足' }],
  }]);
  const next = applied.document.elements[0] as MeshInstance;
  check('别名写入文档', next.constraints?.dimensions?.length === 2);
  check('公式写入文档', Object.keys(next.formulas ?? {}).length === 2);
  check('校验式写入文档并带 id', Boolean(next.constraints?.checks?.[0]?.id), JSON.stringify(next.constraints?.checks));
  check('摘要可读', applied.applied[0]?.includes('柱高'), applied.applied[0]);

  // 容错：模型偶尔把三个字段包进 constraints 里，或把 formulas 写成 formula
  const nested = applyOps(document, [{
    op: 'setConstraints',
    target: element.name,
    constraints: {
      dimensions: [{ name: '柱高', path: 'f2.height' }],
      checks: [{ expr: '柱高 >= 2' }],
    },
  }]).document.elements[0] as MeshInstance;
  check('认掉嵌套写法 constraints.dimensions', nested.constraints?.dimensions?.[0]?.name === '柱高');
  check('认掉嵌套写法 constraints.checks', nested.constraints?.checks?.length === 1);
  const singular = applyOps(document, [{
    op: 'setConstraints',
    target: element.name,
    formula: { 'f2.height': '3' },
  }]).document.elements[0] as MeshInstance;
  check('认掉 formula 单数写法', singular.formulas?.['f2.height'] === '3');

  const context = buildProjectContext(applied.document);
  const entry = context.elements.find((item: { name: string }) => item.name === element.name) as
    { solid?: { constraints?: { dimensions?: Array<{ name: string; value: number | null }>; formulas?: Record<string, string> } } } | undefined;
  check('上下文里能看到别名', entry?.solid?.constraints?.dimensions?.some((item) => item.name === '柱高') === true);
  check('上下文里能看到公式', Boolean(entry?.solid?.constraints?.formulas?.柱高));

  const reject = (patch: Record<string, unknown>, hint: string) => {
    try {
      applyOps(document, [{ op: 'setConstraints', target: element.name, ...patch }]);
      return `未被拒绝（${hint}）`;
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  };

  const badPath = reject({ dimensions: [{ name: '柱高', path: 'f9.height' }] }, '不存在的尺寸');
  check('拒绝不存在的尺寸路径，并提示可用路径', badPath.includes('f9.height') && badPath.includes('f2.height'), badPath);
  const badRef = reject({ formulas: { 'f2.height': '檐口高 + 1' } }, '不存在的引用');
  check('拒绝引用不存在的量', badRef.includes('檐口高'), badRef);
  const badCycle = reject({ formulas: { 'f2.height': 'f3.translate.2', 'f3.translate.2': 'f2.height' } }, '成环');
  check('拒绝成环', badCycle.includes('循环引用'), badCycle);
  const clash = reject({ dimensions: [{ name: '标准层高', path: 'f2.height' }] }, '与项目参数同名');
  check('拒绝与项目参数同名的别名', clash.includes('标准层高'), clash);
  const badExpr = reject({ formulas: { 'f2.height': '2 +* 3' } }, '语法错');
  check('拒绝语法错的表达式', badExpr.includes('无法求值'), badExpr);
  const badCheck = reject({ checks: [{ expr: '甲 <= 3' }] }, '校验式引用不存在');
  check('拒绝校验式里的未知量', badCheck.includes('甲'), badCheck);

  const cleared = applyOps(applied.document, [{ op: 'setConstraints', target: element.name, replace: true }]);
  const clearedElement = cleared.document.elements[0] as MeshInstance;
  check('replace 清空别名与校验', clearedElement.constraints === undefined, JSON.stringify(clearedElement.constraints));
  check('replace 清空公式', clearedElement.formulas === undefined, JSON.stringify(clearedElement.formulas));
}

console.log('\n服务端：约束写在参数化构件上（改 param.*）');
{
  const project = createProject({ name: '约束' });
  const { document } = applyOps(project, [
    { op: 'addSolid', name: '支架', library: 'bracket' },
  ]);
  const applied = applyOps(document, [{
    op: 'setConstraints',
    target: '支架',
    dimensions: [{ name: '宽', path: 'param.width' }],
    formulas: { 宽: '0.24' },
  }]);
  const element = applied.document.elements[0] as MeshInstance;
  const resolved = resolveElementConstraints(element);
  check('参数化构件的 param.* 可被约束驱动', near(resolved.element.parametric?.params.width ?? -1, 0.24), String(resolved.element.parametric?.params.width));
  const snapshot = resolved.element.primitive?.kind === 'solid' ? resolved.element.primitive.features : [];
  const expected = buildParametricFeatures(resolved.element.parametric!);
  const snapshotWidth = Number((snapshot[0] as { shape?: { width?: number } } | undefined)?.shape?.width ?? 0);
  const expectedWidth = Number((expected[0] as { shape?: { width?: number } } | undefined)?.shape?.width ?? -1);
  check(
    `写回后特征树快照同步刷新（底板宽 ${snapshotWidth.toFixed(3)}）`,
    near(snapshotWidth, expectedWidth, 1e-6) && near(expectedWidth, 0.24, 0.001),
    `${snapshotWidth} vs ${expectedWidth}`,
  );
}

/* ------------------------------ 特征增删后的路径搬家 ------------------------------ */

console.log('\n特征增删：约束跟着特征走');
{
  const { document, element } = buildSolid();
  const withConstraint = applyOps(document, [{
    op: 'setConstraints',
    target: element.name,
    dimensions: [{ name: '柱高', path: 'f2.height' }],
    formulas: { 柱高: '3.0' },
    checks: [{ expr: 'f2.height <= 4' }],
  }]).document;

  const inserted = applyOps(withConstraint, [{
    op: 'addFeature',
    target: element.name,
    index: 2,
    feature: { shape: 'box', label: '插进来的', width: 0.1, depth: 0.1, height: 0.1 },
  }]).document;
  const afterInsert = inserted.elements[0] as MeshInstance;
  check('插入特征后别名搬到 f3', afterInsert.constraints?.dimensions?.[0]?.path === 'f3.height', afterInsert.constraints?.dimensions?.[0]?.path);
  check('插入特征后公式键一起搬', Boolean(afterInsert.formulas?.['柱高']) && afterInsert.formulas?.['柱高'] === '3.0');
  check('插入特征后校验式里的路径一起搬', afterInsert.constraints?.checks?.[0]?.expr.includes('f3.height') === true, afterInsert.constraints?.checks?.[0]?.expr);
  check('搬完之后柱高仍然指着一根檐柱', (() => {
    const features = afterInsert.primitive?.kind === 'solid' ? afterInsert.primitive.features : [];
    return features[2]?.label === '檐柱';
  })());

  const removed = applyOps(withConstraint, [{ op: 'deleteFeature', target: element.name, feature: 2 }]).document;
  const afterDelete = removed.elements[0] as MeshInstance;
  check('删掉被约束的特征后别名被清掉', !afterDelete.constraints?.dimensions?.length, JSON.stringify(afterDelete.constraints));
  check('删掉被约束的特征后公式被清掉', afterDelete.formulas === undefined, JSON.stringify(afterDelete.formulas));

  const front = applyOps(withConstraint, [{
    op: 'addFeature',
    target: element.name,
    index: 1,
    feature: { shape: 'box', label: '插在最前', width: 0.1, depth: 0.1, height: 0.1 },
  }]).document;
  const frontElement = front.elements[0] as MeshInstance;
  check('插到最前：别名 f2 → f3', frontElement.constraints?.dimensions?.[0]?.path === 'f3.height', frontElement.constraints?.dimensions?.[0]?.path);

  const back = applyOps(front, [{ op: 'deleteFeature', target: element.name, feature: 2 }]).document;
  const backElement = back.elements[0] as MeshInstance;
  const backFeatures = backElement.primitive?.kind === 'solid' ? backElement.primitive.features : [];
  check('删掉它前面的特征：别名回到 f2', backElement.constraints?.dimensions?.[0]?.path === 'f2.height', backElement.constraints?.dimensions?.[0]?.path);
  check('搬家之后别名仍指着一根檐柱', backFeatures[1]?.label === '檐柱', backFeatures.map((item) => item.label).join('/'));
  check('校验式也一起往前搬', backElement.constraints?.checks?.[0]?.expr.includes('f2.height') === true, backElement.constraints?.checks?.[0]?.expr);
}

/* ------------------------------ 直接调用 data 层 ------------------------------ */

console.log('\n数据层：rebaseConstraints');
{
  const { element } = buildSolid();
  const constrained: MeshInstance = {
    ...element,
    constraints: { dimensions: [{ name: '柱高', path: 'f2.height' }], checks: [{ id: 'c', expr: 'f2.height > 1' }] },
    formulas: { 柱高: 'f1.height * 12' },
  };
  const rebased = rebaseConstraints(constrained, { 1: 1, 2: 3, 3: 4, 4: 5 });
  check('别名路径重排', rebased.constraints?.dimensions?.[0]?.path === 'f3.height', rebased.constraints?.dimensions?.[0]?.path);
  check('公式键重排', Boolean(rebased.formulas?.['柱高']));
  check('校验式里的路径重排', rebased.constraints?.checks?.[0]?.expr === 'f3.height > 1', rebased.constraints?.checks?.[0]?.expr);
  check('公式表达式里的路径重排', rebased.formulas?.['柱高'] === 'f1.height * 12', JSON.stringify(rebased.formulas));
  const pathKeyed = rebaseConstraints(
    { ...element, formulas: { 'f2.height': 'f1.height * 12' } },
    { 1: 1, 2: 3, 3: 4, 4: 5 },
  );
  check('公式键是路径时一起重排', pathKeyed.formulas?.['f3.height'] === 'f1.height * 12', JSON.stringify(pathKeyed.formulas));
  const exprRef = rebaseConstraints(
    { ...element, formulas: { 'f4.translate.2': 'f2.height + 0.35' } },
    { 1: 1, 2: 3, 3: 4, 4: 5 },
  );
  check('表达式里引用别的特征路径时一起重排', exprRef.formulas?.['f5.translate.2'] === 'f3.height + 0.35', JSON.stringify(exprRef.formulas));
  check('无变化时返回原引用', rebaseConstraints(element, { 1: 1, 2: 2, 3: 3, 4: 4 }) === element);
}

/* ------------------------------ 汇总 ------------------------------ */

console.log('');
if (failures.length) {
  console.error(`约束测试失败（${failures.length} 项）`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
console.log(`约束测试通过（${passed} 项）`);
