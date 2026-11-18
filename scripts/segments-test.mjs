/**
 * segments 契约回归。
 *
 * 背景：AI 生成花瓶（revolve）时按通用 3D 习惯把分段写成 96 / 128 想让曲面更圆滑，
 * 或写 3~5 做低多边形；服务端用 num() 严格拒绝 6~64 以外的值，于是自检闭环里
 * 每次 editFeature 都整轮指令被打回，屏幕上反复出现
 * 「参数没通过校验（特征 1.segments 超出允许范围（6 ~ 64）），正在自动修正…」。
 *
 * 前端造型内核（src/bim/solid.ts）本来就 clamp 到 6~64，所以这些值渲染结果完全相同：
 * 服务端应当与内核对齐做夹取，而不是为一个纯画质参数烧掉一轮上游调用。
 * 尺寸 / 坐标 / 点数这些真正影响几何的字段仍必须严格拒绝。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { applyOps } from '../server/ai/ops.js';
import { dryRun } from '../server/ai/repair.js';
import { SOLID_LIMITS } from '../server/ai/solid.js';
import { listDimensions } from '../shared/dimensions.js';

let total = 0;
function check(name, fn) {
  total += 1;
  fn();
  console.log(`  ✓ ${name}`);
}

const read = (relative) => fs.readFileSync(new URL(relative, import.meta.url), 'utf8');

const PROFILE = [[0, 0], [0.12, 0], [0.1, 0.08], [0.06, 0.3], [0.04, 0.42]];

function vaseDoc() {
  return {
    name: '花瓶测试',
    levels: [{ id: 'L0', name: '标高 0', elevation: 0 }],
    grids: [],
    types: [],
    materials: [],
    elements: [{
      id: 'v1', name: '花瓶', category: 'mesh', offset: [0, 0, 0],
      primitive: {
        kind: 'solid',
        features: [{ id: 'f1', label: '瓶身', shape: { shape: 'revolve', profile: PROFILE, segments: 48 } }],
      },
    }],
  };
}

const addOps = (segmentsValue) => [{
  op: 'addSolid',
  name: '新花瓶',
  features: [{
    shape: 'revolve',
    profile: PROFILE,
    ...(segmentsValue === undefined ? {} : { segments: segmentsValue }),
  }],
}];

const addedShape = (value) => applyOps(vaseDoc(), addOps(value))
  .document.elements.at(-1).primitive.features[0].shape;

const editedFeature = (value) => applyOps(vaseDoc(), [{
  op: 'editFeature', target: '花瓶', feature: 1, patch: { shape: { segments: value } },
}]).document.elements[0].primitive.features[0];

check('服务端上限与前端内核一致（64）', () => {
  assert.equal(SOLID_LIMITS.segments, 64);
  assert.match(read('../src/bim/solid.ts'), /segments:\s*64/);
  assert.match(read('../src/bim/solid.ts'), /clamp\(Math\.round\(finite\(value, fallback\)\), 6, SOLID_LIMITS\.segments\)/);
});

check('addSolid 128 → 64', () => assert.equal(addedShape(128).segments, 64));
check('addSolid 96 → 64', () => assert.equal(addedShape(96).segments, 64));
check('addSolid 3 → 6', () => assert.equal(addedShape(3).segments, 6));
check('addSolid 0 / 负数 → 6', () => {
  assert.equal(addedShape(0).segments, 6);
  assert.equal(addedShape(-12).segments, 6);
});
check('addSolid 48 原样保留', () => assert.equal(addedShape(48).segments, 48));
check('addSolid 缺省 → revolve 缺省 48', () => assert.equal(addedShape(undefined).segments, 48));
check('数字字符串 "36" 容错为 36', () => assert.equal(addedShape('36').segments, 36));
check('夹取结果始终是整数', () => {
  for (const value of [128, 96, 3, 32.6, '41']) {
    assert.ok(Number.isInteger(addedShape(value).segments));
  }
});
check('非数字分段仍被拒绝', () => {
  assert.throws(() => applyOps(vaseDoc(), addOps('abc')), /必须是数字/);
  assert.throws(() => applyOps(vaseDoc(), addOps({})), /必须是数字/);
});

check('editFeature 128 不再报「特征 1.segments」', () => {
  assert.equal(editedFeature(128).shape.segments, 64);
});
check('editFeature 3 → 6', () => assert.equal(editedFeature(3).shape.segments, 6));
check('editFeature 保留其它形状字段', () => {
  const shape = editedFeature(96).shape;
  assert.equal(shape.shape, 'revolve');
  assert.deepEqual(shape.profile, PROFILE);
  assert.equal(shape.angle, 360);
});
check('editFeature 的 label 路径仍可用于其它报错', () => {
  // 旋转角超 3600° 仍走严格校验，证明只是放宽了 segments，没放宽整条链
  assert.throws(() => applyOps(vaseDoc(), [{
    op: 'editFeature', target: '花瓶', feature: 1, patch: { shape: { angle: 9999 } },
  }]), /特征 1/);
});

check('replaceFeature 128 → 64', () => {
  const doc = applyOps(vaseDoc(), [{
    op: 'replaceFeature', target: '花瓶', feature: 1,
    replacement: { shape: { shape: 'revolve', profile: PROFILE, segments: 128 } },
  }]).document;
  assert.equal(doc.elements[0].primitive.features[0].shape.segments, 64);
});

check('fillet.segments 128 → 64', () => {
  const shape = applyOps(vaseDoc(), [{
    op: 'addSolid', name: '圆角柱',
    features: [{ shape: 'cylinder', radius: 0.1, height: 0.2, fillet: { radius: 0.01, segments: 128 } }],
  }]).document.elements.at(-1).primitive.features[0];
  assert.equal(shape.fillet.segments, 64);
});

check('torus.tubeSegments 128 → 64', () => {
  const shape = applyOps(vaseDoc(), [{
    op: 'addSolid', name: '圆环',
    features: [{ shape: 'torus', radius: 0.1, tube: 0.02, tubeSegments: 128 }],
  }]).document.elements.at(-1).primitive.features[0].shape;
  assert.equal(shape.tubeSegments, 64);
});

check('尺寸字段仍严格拒绝（没有整体放松）', () => {
  assert.throws(() => applyOps(vaseDoc(), [{
    op: 'addSolid', name: '超大模型', features: [{ shape: 'cylinder', radius: 600, height: 1 }],
  }]), /超出允许范围/);
});

check('生成阶段 dry-run 不再因 segments 触发自动修正', () => {
  assert.equal(dryRun(vaseDoc(), addOps(128)), null);
  assert.equal(dryRun(vaseDoc(), addOps(3)), null);
  assert.equal(dryRun(vaseDoc(), [{
    op: 'editFeature', target: '花瓶', feature: 1, patch: { shape: { segments: 96 } },
  }]), null);
});
check('真正的越界仍会触发 dry-run 报错', () => {
  assert.match(dryRun(vaseDoc(), [{
    op: 'addSolid', name: '超大模型', features: [{ shape: 'cylinder', radius: 600, height: 1 }],
  }]) ?? '', /超出允许范围/);
});

check('基本体参数表上限统一到 6~64', () => {
  for (const kind of ['cylinder', 'sphere', 'revolve']) {
    const primitive = kind === 'cylinder'
      ? { kind, radius: 0.2, height: 0.4, segments: 32 }
      : kind === 'sphere'
        ? { kind, radius: 0.2, segments: 32 }
        : { kind, radius: 0.2, height: 0.4, segments: 32 };
    const spec = listDimensions({ primitive }).find((item) => item.path === 'primitive.segments');
    assert.ok(spec, `${kind} 没有 segments 参数`);
    assert.equal(spec.min, 6, kind);
    assert.equal(spec.max, 64, kind);
  }
});
check('参数表与前端参数定义都不再出现 128', () => {
  assert.doesNotMatch(read('../shared/dimensions.js'), /, 128, true\]/);
  assert.doesNotMatch(read('../src/bim/parameters.ts'), /, 128\)/);
});

check('主提示词写明合法范围与建议值', () => {
  const prompt = read('../server/ai/provider.js');
  assert.match(prompt, /6~64 的整数/);
  assert.match(prompt, /32~48 就足够圆滑/);
  assert.match(prompt, /editFeature 的 patch 里写 segments 同样受这条约束/);
});
check('编排角色提示词写明同一范围', () => {
  assert.match(read('../server/ai/orchestrator.js'), /合法范围 6~64 的整数/);
});
check('文档说明夹取而非拒绝', () => {
  const doc = read('../docs/AI.md');
  assert.match(doc, /合法范围 6 ~ 64 的整数/);
  assert.match(doc, /分段数不进这条链路/);
});

console.log(`\n分段数契约测试 ${total} 项全部通过 ✅\n`);
