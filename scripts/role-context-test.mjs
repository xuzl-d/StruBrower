/**
 * 多角色编排的项目上下文：必须是完整 JSON、按预算结构化降档、且真的带特征树。
 *
 * 回归目标：旧实现 clip(JSON.stringify(context), 2500) 会切在半个括号上，
 * 而且前 2500 字符里根本不含 elements / features，子角色看不到现有模型。
 */
import assert from 'node:assert/strict';
import { buildRoleContext } from '../server/ai/role-context.js';
import { buildProjectContext } from '../server/ai/context.js';

let total = 0;
function check(name, fn) {
  total += 1;
  fn();
  console.log(`  ✓ ${name}`);
}

function makeDoc(featureCount = 3, withBigLoft = false) {
  const features = Array.from({ length: featureCount }, (_, index) => ({
    id: `f${index}`,
    label: `特征${index}`,
    shape: withBigLoft
      ? {
        shape: 'loft',
        sections: Array.from({ length: 12 }, (_, k) => ({ z: k * 0.1, profile: [[0, 0], [1, 0], [1, 1], [0, 1]] })),
      }
      : { shape: 'box', width: 1 + index, depth: 1, height: 0.5 },
    translate: [0, 0, index * 0.1],
    material: 'steel',
  }));
  return {
    name: '测试项目',
    levels: [{ id: 'L0', name: '标高 0', elevation: 0 }],
    types: [],
    grids: [],
    materials: [],
    elements: [
      { id: 'e1', name: '样车', category: 'mesh', offset: [1, 2, 0], rotation: Math.PI / 2, scale: 1, primitive: { kind: 'solid', features } },
      { id: 'e2', name: '地坪', category: 'slab' },
      { id: 'e3', name: '另一台车', category: 'mesh', primitive: { kind: 'solid', features: [{ id: 'x', label: '车身', shape: { shape: 'box', width: 2, depth: 1, height: 0.6 } }] } },
    ],
  };
}

const JSON_OF = (text) => JSON.parse(text.slice(text.indexOf('\n') + 1));

check('详细版是完整可解析的 JSON（不再切字符串）', () => {
  const doc = makeDoc();
  const r = buildRoleContext({ document: doc, context: buildProjectContext(doc, ['e1']) });
  const parsed = JSON_OF(r.detailed);
  assert.equal(parsed.project, '测试项目');
  assert.equal(parsed.coordinateSystem, 'Z-up');
  assert.equal(parsed.selection.source, 'selected');
  assert.deepEqual(parsed.selection.ids, ['e1']);
});

check('详细版带选中构件的完整 shape 与变换', () => {
  const doc = makeDoc();
  const r = buildRoleContext({ document: doc, context: buildProjectContext(doc, ['e1']) });
  const first = JSON_OF(r.detailed).selected[0];
  assert.equal(first.featureCount, 3);
  assert.equal(first.features.length, 3);
  assert.deepEqual(first.features[0].shapeData, { shape: 'box', width: 1, depth: 1, height: 0.5 });
  assert.deepEqual(first.features[0].translate, [0, 0, 0]);
  assert.equal(first.features[0].material, 'steel');
  assert.equal(first.rotationDegrees, 90);
  assert.deepEqual(first.position, [1, 2]);
  assert.ok(first.features.every((feature, index) => feature.index === index + 1));
});

check('精简版只给骨架，不含 shape 原始数据', () => {
  const doc = makeDoc();
  const r = buildRoleContext({ document: doc, context: buildProjectContext(doc, ['e1']) });
  const brief = JSON_OF(r.brief);
  assert.ok(brief.selected[0].features.length > 0);
  assert.ok(brief.selected[0].features.every((feature) => !('shapeData' in feature)));
  assert.equal(brief.selected[0].features[0].shape, 'box');
  assert.ok(r.stats.briefTokens <= r.stats.detailedTokens);
});

check('明确标注只读，不让角色去 editFeature 已有构件', () => {
  const r = buildRoleContext({ document: makeDoc(), context: buildProjectContext(makeDoc(), ['e1']) });
  for (const text of [r.detailed, r.brief]) {
    const parsed = JSON_OF(text);
    assert.equal(parsed.readOnly, true);
    assert.match(parsed.note, /不要用 editFeature/);
  }
});

check('其它构件给简表，不会把无关特征树塞进来', () => {
  const doc = makeDoc();
  const r = buildRoleContext({ document: doc, context: buildProjectContext(doc, ['e1']) });
  const others = JSON_OF(r.detailed).otherElements;
  assert.ok(others.some((item) => item.id === 'e2'));
  assert.ok(others.every((item) => !('features' in item)));
});

check('预算不足时先保骨架、再减完整 shape，且逐条标注', () => {
  const doc = makeDoc(60, true);
  const r = buildRoleContext({ document: doc, context: buildProjectContext(doc, ['e1']) });
  const selected = JSON_OF(r.detailed).selected[0];
  assert.equal(selected.featureCount, 60);
  assert.equal(selected.features.length, 60, '60 个特征骨架都应列出');
  const rich = selected.features.filter((feature) => feature.shapeData);
  const summary = selected.features.filter((feature) => feature.shapeOmitted);
  assert.ok(rich.length > 0 && rich.length < 60, `应只给部分完整 shape，实际 ${rich.length}`);
  assert.equal(rich.length + summary.length, 60);
  assert.equal(r.stats.detailedShapeLimit, 6);
  assert.equal(JSON_OF(r.detailed).omitted.shapes, summary.length);
  assert.ok(r.stats.detailedTokens <= 4000);
});

check('自定义更小预算会进一步降档，仍然是可解析 JSON', () => {
  const doc = makeDoc(60, true);
  const r = buildRoleContext({ document: doc, context: buildProjectContext(doc, ['e1']), detailedTokens: 600, briefTokens: 200 });
  const detailed = JSON_OF(r.detailed);
  const brief = JSON_OF(r.brief);
  assert.ok(detailed.selected[0].features.length < 60);
  assert.ok(brief.selected[0].features.length <= 12);
  assert.ok(r.stats.detailedTokens <= 650);
});

check('没有选中构件时退回第一个造型构件', () => {
  const doc = makeDoc();
  const r = buildRoleContext({ document: doc, context: buildProjectContext(doc, []) });
  assert.equal(r.stats.source, 'firstSolid');
  assert.equal(JSON_OF(r.detailed).selected[0].id, 'e1');
});

check('context 被预算降级成 id 简表后仍能定位原始构件', () => {
  const doc = makeDoc();
  const degraded = { ...buildProjectContext(doc, ['e1']), selected: [{ id: 'e1', name: '样车', category: 'mesh' }] };
  const r = buildRoleContext({ document: doc, context: degraded });
  assert.equal(JSON_OF(r.detailed).selected[0].features.length, 3);
});

check('没有 document 时安全返回空上下文', () => {
  const r = buildRoleContext({ document: null, context: null });
  assert.equal(r.detailed, '');
  assert.equal(r.brief, '');
  assert.equal(r.stats.available, false);
});

check('超大单个 shape 只给摘要并标 shapeChars', () => {
  const doc = makeDoc();
  const shape = { shape: 'loft', sections: Array.from({ length: 300 }, (_, k) => ({ z: k, profile: [[0, 0], [1, 0], [1, 1]] })) };
  doc.elements[0].primitive.features = [{ id: 'huge', label: '超大曲面', shape }];
  const r = buildRoleContext({ document: doc, context: buildProjectContext(doc, ['e1']) });
  const feature = JSON_OF(r.detailed).selected[0].features[0];
  assert.equal(feature.shapeOmitted, true);
  assert.ok(feature.shapeChars > 4000);
  assert.ok(!('shapeData' in feature));
});

check('用量统计与实际输出一致', () => {
  const doc = makeDoc(10);
  const r = buildRoleContext({ document: doc, context: buildProjectContext(doc, ['e1']) });
  assert.equal(r.stats.selectedElements, 1);
  assert.equal(r.stats.selectedFeatures, 10);
  assert.equal(r.stats.detailedFeatureLimit, JSON_OF(r.detailed).selected[0].features.length);
  assert.equal(r.stats.briefFeatureLimit, JSON_OF(r.brief).selected[0].features.length);
  assert.equal(r.stats.overBudget, false);
});

console.log(`\n编排角色上下文测试 ${total} 项全部通过 ✅\n`);
