/**
 * 零件合并器 + 面向 Agent 的只读查询：全链路测试。
 *
 * 覆盖：manifest 校验（命名/材质/配额/嵌套）、group 包裹与变换、切除排序、
 * 镜像与连接点换算、96 上限、服务端归一化拒绝、唯一 addSolid；
 * 查询覆盖世界坐标包围盒 / 任意射线 / 表面 / 接触与穿插 / 曲面采样；
 * 最后用 diagnostics/yellow-sport-sedan.ops.json 做「拆分 → 合并」往返一致性验证。
 */
import fs from 'node:fs';
import path from 'node:path';
import { Box3, Vector3 } from 'three';
import { applyOps } from '../server/ai/ops.js';
import { createProject } from '../src/bim/template';
import { buildElementModel } from '../src/bim/geometry';
import {
  AssemblyError, assemblyFromOps, formatReport, mergeAssembly,
  type AssemblySpec, type Feature,
} from './lib/assembly';
import { runQueries, type QueryRequest } from './lib/query';

let failed = 0;
function check(name: string, ok: boolean, detail?: unknown) {
  if (ok) console.log('  ✓', name);
  else { failed += 1; console.log('  ✗', name, detail ?? ''); }
}

function expectError(name: string, fn: () => void, keyword: string) {
  try {
    fn();
    check(name, false, '没有抛错');
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error);
    check(name, text.includes(keyword), text);
  }
}

const box = (label: string, size: [number, number, number], at: [number, number, number], mode = 'add'): Feature => ({
  label, mode, shape: 'box', width: size[0], depth: size[1], height: size[2], translate: at,
});

console.log('\n[assembly] 零件合并器');

{
  const spec: AssemblySpec = {
    name: '双块装配',
    parts: [
      { id: 'base', name: '底座', material: 'steel', quota: 2, features: [box('底板', [1, 1, 0.2], [0, 0, 0.1])], anchors: [{ name: '根部', at: [0, 0, 0.2], normal: [0, 0, 1] }] },
      { id: 'post', name: '立柱', material: 'aluminum', features: [box('柱身', [0.2, 0.2, 0.6], [0, 0, 0])] },
    ],
    placements: [
      { part: 'base', translate: [0, 0, 0] },
      { part: 'post', translate: [0, 0, 0.5], rotate: [0, 0, 15] },
    ],
  };
  const { ops, report } = mergeAssembly(spec);
  const features = (ops[0]!.features as Feature[]);
  check('只产出 1 条 addSolid', ops.length === 1 && ops[0]!.op === 'addSolid');
  check('每个零件包成 group', features.length === 2 && features.every((f) => (f.shape as Feature).shape === 'group'));
  check('group id 稳定且可返工', features[0]!.id === 'part-base' && features[1]!.id === 'part-post');
  check('首特征是 add', features[0]!.mode === 'add');
  check('拼接变换只写在 group 上', JSON.stringify(features[1]!.translate) === '[0,0,0.5]' && JSON.stringify(features[1]!.rotate) === '[0,0,15]');
  check('子特征不带整车位置', (features[1] as Feature).shape !== undefined && JSON.stringify(((features[1]!.shape as Feature).features as Feature[])[0]!.translate) === '[0,0,0]');
  check('材质约定挂在 group', !!features[0]!.material && typeof features[0]!.material === 'object');
  check('特征 id 稳定可寻址', JSON.stringify(((features[0]!.shape as Feature).features as Feature[])[0]!.id) === '"base-f1"');
  check('连接点按 placement 换算', report.parts[1]!.anchors.length === 0 && Math.abs(report.parts[0]!.anchors[0]!.at[2]! - 0.2) < 1e-6);
  check('预算统计含 group 外壳', report.featureCount === 4 && report.limit === 96, report.featureCount);
  check('可读报告', formatReport(report).includes('双块装配'));
  // 产物必须能真的落库
  const result = applyOps(createProject({ name: '测试' }), ops as Array<Record<string, unknown>>) as { document: { elements: unknown[] } };
  check('合并结果能过 applyOps', result.document.elements.length === 1);
}

{
  const spec: AssemblySpec = {
    name: '切除排序',
    parts: [{
      id: 'body', name: '本体', material: 'plastic',
      features: [
        box('挖孔', [0.2, 0.2, 0.4], [0, 0, 0.2], 'cut'),
        box('实体', [1, 1, 0.4], [0, 0, 0.2]),
      ],
    }],
    cuts: [box('跨零件切除', [0.1, 0.1, 0.9], [0.4, 0, 0.2], 'cut')],
  };
  const { ops, report } = mergeAssembly(spec);
  const features = ops[0]!.features as Feature[];
  const children = (features[0]!.shape as Feature).features as Feature[];
  check('组内 add 排在 cut 之前', children[0]!.mode === 'add' && children[1]!.mode === 'cut');
  check('顶层切除排在所有零件之后', features.length === 2 && features[1]!.mode === 'cut');
  check('切除计数', report.innerCuts === 1 && report.rootCuts === 1);
}

{
  const spec: AssemblySpec = {
    name: '镜像',
    parts: [{
      id: 'mirror', name: '后视镜', material: 'plasticDark',
      features: [box('镜片', [0.2, 0.04, 0.12], [0, 0, 0])],
      anchors: [{ name: '镜座根部', at: [0, 0.8, 0], normal: [0, 1, 0] }],
    }],
    placements: [{ part: 'mirror', translate: [1, 0, 1], mirror: { axis: 'y', center: [0, 0, 0] } }],
  };
  const { ops, report } = mergeAssembly(spec);
  const group = (ops[0]!.features as Feature[])[0]!;
  check('镜像落成 pattern', (group.pattern as Feature).type === 'mirror');
  check('原件与镜像件各一个连接点', report.parts[0]!.anchors.length === 2);
  const mirrored = report.parts[0]!.anchors.find((anchor) => anchor.mirrored);
  check('镜像点按镜像面取反', !!mirrored && Math.abs(mirrored!.at[1]! + 0.8) < 1e-6 && Math.abs(mirrored!.at[0]! - 1) < 1e-6);
  check('镜像法向也取反', !!mirrored && Math.abs(mirrored!.normal![1]! + 1) < 1e-6);
}

{
  const base: AssemblySpec = {
    name: '校验', parts: [{ id: 'a', name: '甲', features: [box('块', [1, 1, 1], [0, 0, 0])] }],
  };
  expectError('重复零件 id 被拒', () => mergeAssembly({ ...base, parts: [base.parts[0]!, { ...base.parts[0]! }] }), '重复');
  expectError('重复特征名被拒', () => mergeAssembly({
    name: '校验', parts: [
      { id: 'a', name: '甲', features: [box('同名', [1, 1, 1], [0, 0, 0])] },
      { id: 'b', name: '乙', features: [box('同名', [1, 1, 1], [0, 0, 0])] },
    ],
  }), '特征名');
  expectError('配额不足被拒', () => mergeAssembly({
    name: '校验', parts: [{ id: 'a', name: '甲', quota: 1, features: [box('块1', [1, 1, 1], [0, 0, 0]), box('块2', [1, 1, 1], [0, 0, 0])] }],
  }), '配额');
  expectError('重复 placement 被拒', () => mergeAssembly({
    ...base, placements: [{ part: 'a' }, { part: 'a' }],
  }), '两条 placement');
  expectError('placement 指向不存在的零件', () => mergeAssembly({ ...base, placements: [{ part: 'nope' }] }), '不存在');
  expectError('非法形状被服务端归一化挡住', () => mergeAssembly({
    name: '校验', parts: [{ id: 'a', name: '甲', features: [{ label: '怪', shape: 'unicorn' }] }],
  }), '不支持');
  expectError('只有切除的组内零件被拒', () => mergeAssembly({
    name: '校验', parts: [{ id: 'a', name: '甲', features: [box('挖', [1, 1, 1], [0, 0, 0], 'cut')] }],
  }), 'scope');
  expectError('顶层 cuts 混入 add 被拒', () => mergeAssembly({ ...base, cuts: [box('加', [1, 1, 1], [0, 0, 0])] }), '顶层 cuts');
  expectError('超配额上限被拒', () => mergeAssembly({ name: '校验', budget: { total: 1 }, parts: [base.parts[0]!] }), '超过上限');
  try {
    mergeAssembly({ name: 'x', parts: [] });
    check('AssemblyError 可识别', false);
  } catch (error) {
    check('AssemblyError 可识别', error instanceof AssemblyError);
  }
}

console.log('\n[query] 只读几何查询');

const boxOps = [{
  op: 'addSolid', name: '方块', features: [box('底座', [1, 1, 1], [0, 0, 0.5])],
}];

function query(requests: QueryRequest[], input: unknown = boxOps) {
  return runQueries(input, requests) as { results: Array<Record<string, unknown>> };
}

{
  const { results } = query([{ type: 'bounds' }]);
  const bounds = results[0]!;
  check('世界坐标包围盒', JSON.stringify(bounds.min) === '[-0.5,-0.5,0]' && JSON.stringify(bounds.max) === '[0.5,0.5,1]', bounds);
}
{
  const { results } = query([{ type: 'ray', origin: [0, 0, 3], direction: [0, 0, -1] }]);
  const hits = results[0]!.hits as Array<{ point: number[]; normal: number[] }>;
  check('任意射线命中顶面', hits.length > 0 && Math.abs(hits[0]!.point[2]! - 1) < 1e-4, results[0]);
  check('命中法线朝外', Math.abs(hits[0]!.normal[2]! - 1) < 1e-4);
}
{
  const { results } = query([{ type: 'surface', axis: 'z', at: [0, 0] }]);
  const list = results[0]!.results as Array<{ hit: { point: number[] } | null }>;
  check('沿轴表面查询', !!list[0]!.hit && Math.abs(list[0]!.hit!.point[2]! - 1) < 1e-4, results[0]);
}
{
  const moved = [{ ...boxOps[0], position: [5, 0] }];
  const { results } = query([{ type: 'bounds' }, { type: 'bounds', frame: 'root' }], moved);
  const world = results[0]!;
  const root = results[1]!;
  check('world 含构件放置偏移', JSON.stringify(world.min) === '[4.5,-0.5,0]', world);
  check('root 仍是特征树局部坐标', JSON.stringify(root.min) === '[-0.5,-0.5,0]', root);
}
{
  const two = [{
    op: 'addSolid', name: '两块', features: [
      box('底座', [1, 1, 1], [0, 0, 0.5]),
      box('悬浮块', [0.2, 0.2, 0.2], [0, 0, 1.12]),
    ],
  }];
  const gap = query([{ type: 'gap', a: '底座', b: '悬浮块' }], two).results[0]!;
  check('悬浮判为有间隙', gap.relation === 'gap' && Math.abs((gap.distance as number) - 0.02) < 0.005, gap);
  const embedded = [{
    op: 'addSolid', name: '两块', features: [
      box('底座', [1, 1, 1], [0, 0, 0.5]),
      box('嵌入块', [0.2, 0.2, 0.2], [0, 0, 1.07]),
    ],
  }];
  const hit = query([{ type: 'gap', a: '底座', b: '嵌入块' }], embedded).results[0]!;
  check('嵌入判为穿插', hit.relation === 'intersect', hit);
}
{
  const { results } = query([{ type: 'sample', axis: 'z', grid: { a: [-0.4, 0.4, 3], b: [-0.4, 0.4, 3] } }]);
  const list = results[0]!.results as Array<{ at: number[]; hit: { normal: number[] } | null }>;
  check('曲面采样网格 9 点', list.length === 9, list.length);
  check('采样点都带表面法线', list.every((item) => !!item.hit && Math.abs(item.hit.normal[2]! - 1) < 1e-4));
}
{
  const { results } = query([{ type: 'ray', origin: [0, 0, 3] }, { type: 'gap', a: '底座' }]);
  check('单条查询失败不拖垮整批', results[0]!.ok === false && results[1]!.ok === false, results);
}

console.log('\n[roundtrip] 黄色运动轿跑：拆分 → 合并');
{
  const file = path.resolve('diagnostics/yellow-sport-sedan.ops.json');
  if (!fs.existsSync(file)) {
    check('轿车 ops 存在', false, file);
  } else {
    const ops = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown[];
    const boundsOf = (opsInput: unknown[]): Box3 => {
      const project = createProject({ name: '往返校验' });
      const result = applyOps(project, opsInput as Array<Record<string, unknown>>) as { document: typeof project };
      const element = result.document.elements[0]!;
      const geometry = buildElementModel(result.document, element)!.geometry;
      geometry.computeBoundingBox();
      return geometry.boundingBox!.clone();
    };
    const before = boundsOf(ops);
    const sameBounds = (candidate: unknown[], label: string) => {
      const after = boundsOf(candidate);
      const delta = before.getSize(new Vector3()).distanceTo(after.getSize(new Vector3()));
      const shift = before.getCenter(new Vector3()).distanceTo(after.getCenter(new Vector3()));
      check(`${label}：外廓尺寸一致`, delta < 0.02, { delta, before: before.min.toArray(), after: after.min.toArray() });
      check(`${label}：中心一致`, shift < 0.02, shift);
    };

    // A. 原树已经有 2 层 group → 自动退化成 scope:'root' 直通，不额外包外壳
    {
      const spec = assemblyFromOps(ops);
      const merged = mergeAssembly(spec);
      check('深嵌套原树自动直通（不再包一层）', spec.parts[0]!.scope === 'root' && (merged.ops[0]!.features as Feature[]).length === 21, merged.report);
      check('总特征数在 96 内', merged.report.featureCount <= 96, merged.report.featureCount);
      sameBounds(merged.ops, '直通往返');
    }

    // B. 手工拆成「车身」+「四轮总成」两个零件：真正走 group 包裹 + 阵列
    {
      const original = (ops[0] as Feature).features as Feature[];
      const groupIndex = original.findIndex((feature) => feature.shape === 'group');
      const wheelGroup = original[groupIndex]!;
      const wheelChildren = (wheelGroup.features ?? (wheelGroup.shape as Feature).features) as Feature[];
      const bodyFeatures = original.filter((_, index) => index !== groupIndex);
      const spec: AssemblySpec = {
        name: '黄色运动轿跑',
        color: '#e9b900',
        parts: [
          { id: 'body', name: '车身与外饰', features: bodyFeatures, quota: 40 },
          { id: 'wheels', name: '四轮总成', features: wheelChildren, quota: 12 },
        ],
        placements: [{ part: 'wheels', array: { type: 'linear', count: 2, step: [-2.86, 0, 0] } }],
      };
      const merged = mergeAssembly(spec);
      const features = merged.ops[0]!.features as Feature[];
      check('拆成 2 个 group 且首零件是 add', features.length === 2 && features.every((f) => (f.shape as Feature).shape === 'group'));
      check('线性阵列写在 wheels 的 group 上', (features[1]!.pattern as Feature).type === 'linear' && (features[1]!.pattern as Feature).count === 2);
      check('组内切除仍留在车身组里', merged.report.innerCuts >= 2, merged.report);
      sameBounds(merged.ops, '双零件往返');

      const listing = query([{ type: 'parts' }], merged.ops).results[0]!;
      check('合并后能按零件列出世界包围盒', Array.isArray(listing.parts) && (listing.parts as unknown[]).length === 2, listing);
    }
  }
}

console.log(failed === 0 ? '\n装配与查询测试全部通过 ✅' : `\n失败 ${failed} 项 ❌`);
if (failed) process.exit(1);
