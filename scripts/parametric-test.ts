/**
 * 参数化模型测试：**参数表和绑定表都是数据**（模型 JSON 里的 params / bindings），
 * 代码只负责「深拷贝 + 按表达式把数写进特征字段」，没有任何模型专用生成器。
 *
 * 关注的是「改一个数，整组尺寸跟着变」这件事有没有真的贯通：
 *   参数表 → 绑定表求值 → 服务端校验 → 文档 → 求值 → 公式联动 → 断开。
 * 全走真实链路（applyOps / buildElementModel / recomputeParameters），不直连内核。
 *
 * 用 L 型支架当样本：它有宽 / 深 / 高 / 板厚四个参数，孔位、立板位置都绑在参数上。
 * 亭子、飞机这类复杂件在库里是静态特征树（改尺寸用 editFeature / setConstraints）。
 */
import { Vector3 } from 'three';
import { buildElementModel } from '../src/bim/geometry';
import { createProject } from '../src/bim/template';
import { applyOps } from '../server/ai/ops.js';
import { elementParameterSpec, recomputeParameters } from '../src/bim/parameters';
import { SOLID_TEMPLATES } from '../src/bim/solidTemplates';
import {
  PARAM_TEMPLATES,
  buildParametricFeatures,
  coerceParams,
  defaultParams,
  disconnectParametric,
  paramTemplate,
  solidFeaturesOf,
  withParam,
} from '../src/bim/parametric';
import { checkModelDocument, LIBRARY_MODELS, libraryFeatures } from '../shared/library.js';
import { countSolidFeatures } from '../src/bim/solid';
import type { MeshInstance } from '../src/bim/types';

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

/** 从模型库落一个构件，返回文档与构件 */
function buildElement(model: string, params?: Record<string, number>) {
  const project = createProject({ name: '参数化' });
  const { document } = applyOps(project, [
    { op: 'addSolid', name: '试验件', library: model, ...(params ? { params } : {}), position: [0, 0, 0] },
  ]);
  return { document, element: document.elements[0] as MeshInstance };
}

/** 求值并返回包围盒尺寸 */
function sizeOf(document: ReturnType<typeof createProject>, element: MeshInstance) {
  const model = buildElementModel(document, element);
  if (!model) return null;
  model.geometry.computeBoundingBox();
  const box = model.geometry.boundingBox!;
  const size = box.getSize(new Vector3());
  const result = { minZ: box.min.z, maxZ: box.max.z, x: size.x, y: size.y, z: size.z };
  model.geometry.dispose();
  return result;
}

console.log('模型文档：参数层是数据');
{
  check(`每份模型文档都自洽（${LIBRARY_MODELS.length} 份）`,
    LIBRARY_MODELS.every((entry) => checkModelDocument(entry.id).length === 0),
    LIBRARY_MODELS.flatMap((entry) => checkModelDocument(entry.id).map((issue) => `${entry.id}: ${issue}`)).join('；'));

  const ids = new Set<string>();
  let schemaOk = true;
  const issues: string[] = [];
  for (const template of PARAM_TEMPLATES) {
    if (ids.has(template.id)) { schemaOk = false; issues.push(`重复 id ${template.id}`); }
    ids.add(template.id);
    const keys = new Set<string>();
    for (const spec of template.params) {
      if (keys.has(spec.key)) { schemaOk = false; issues.push(`${template.id}.${spec.key} 重复`); }
      keys.add(spec.key);
      if (!(spec.min <= spec.default && spec.default <= spec.max)) {
        schemaOk = false;
        issues.push(`${template.id}.${spec.key} 默认值 ${spec.default} 不在 ${spec.min}~${spec.max}`);
      }
      if (!(spec.step > 0)) { schemaOk = false; issues.push(`${template.id}.${spec.key} step 应为正`); }
      if (spec.integer && !Number.isInteger(spec.default)) {
        schemaOk = false;
        issues.push(`${template.id}.${spec.key} 是整数参数但默认值不是整数`);
      }
    }
  }
  check(`参数表合法（${PARAM_TEMPLATES.length} 个带参数的模型）`, schemaOk, issues.join('；'));
  check('带参数的模型都能列出来', PARAM_TEMPLATES.some((template) => template.id === 'bracket'));
  check('未知模型返回 null', paramTemplate('nope') === null);
  check('亭子是静态特征树，不是参数模型', paramTemplate('pavilion-hex') === null && libraryFeatures('pavilion-hex').length > 10);
  check('支架有四个驱动参数', paramTemplate('bracket')?.params.length === 4);
  check('默认参数补齐全部键', Object.keys(defaultParams('bracket')).sort().join(',') === 'depth,height,thickness,width');
  check('缺失参数用默认值补齐', coerceParams('bracket', { width: 0.2 }).params.depth === 0.1);
}

console.log('\n参数归一化');
{
  const out = coerceParams('bracket', { width: 99, depth: 0.2, bogus: 1 });
  check('越界值被夹到上限', near(out.params.width, 2), `${out.params.width}`);
  check('合法值原样保留', near(out.params.depth, 0.2), `${out.params.depth}`);
  check('越界与未知键都报出来', out.issues.length === 2, out.issues.join(' / '));
  check('未知模型给出可用列表', coerceParams('nope', {}).issues[0].includes('bracket'));
}

console.log('\n绑定表联动（支架）');
{
  const base = buildElement('bracket');
  const wide = buildElement('bracket', { width: 0.3 });
  const tall = buildElement('bracket', { height: 0.2 });
  const thick = buildElement('bracket', { thickness: 0.02 });

  check('构件带模型 id', base.element.parametric?.template === 'bracket');
  check('落库带完整参数', JSON.stringify(base.element.parametric?.params)
    === '{"width":0.16,"depth":0.1,"height":0.12,"thickness":0.01}');
  check('source 标记为参数化', String(base.element.source).includes('参数化'));

  const snapshot = base.element.primitive?.kind === 'solid' ? base.element.primitive.features : [];
  const expected = buildParametricFeatures(base.element.parametric!);
  check(
    `特征树快照与按参数重建的一致（${countSolidFeatures(snapshot)} 个特征）`,
    countSolidFeatures(snapshot) === countSolidFeatures(expected) && snapshot.length === expected.length,
  );

  const a = sizeOf(base.document, base.element)!;
  const w = sizeOf(wide.document, wide.element)!;
  const t = sizeOf(tall.document, tall.element)!;
  const k = sizeOf(thick.document, thick.element)!;
  check(`宽 0.16 → ${w.x.toFixed(2)} m（只改一个参数，整件跟着变）`, near(w.x, 0.3, 0.01));
  check(`高 0.12 → ${a.z.toFixed(2)} m，改高后 ${t.z.toFixed(2)} m`, near(a.z, 0.12, 0.01) && near(t.z, 0.2, 0.01));
  check(`板厚 0.01 → ${a.minZ.toFixed(3)} m 落地不变`, near(a.minZ, 0, 0.02) && near(k.minZ, 0, 0.02));

  // 绑定表里的派生位置：孔位随宽度外移、立板随板厚贴边
  const holeX = (wide.element.primitive as { features: Array<{ translate?: number[] }> } | undefined)
    ?.features?.[2]?.translate?.[0] ?? 0;
  check(`孔位随宽度重算（${holeX.toFixed(3)}）`, near(holeX, -(0.3 / 2 - 0.022), 1e-6));
  const wallY = (thick.element.primitive as { features: Array<{ translate?: number[] }> } | undefined)
    ?.features?.[1]?.translate?.[1] ?? 0;
  check(`立板随板厚贴边（${wallY.toFixed(3)}）`, near(wallY, 0.1 / 2 - 0.02 / 2, 1e-6));
}

console.log('\n求值与快照解耦');
{
  const { document, element } = buildElement('bracket', { width: 0.24 });
  const sizeFromParams = sizeOf(document, element)!;
  // 把快照清掉：几何必须仍然来自「文档特征树 + 绑定表」，否则说明求值读的是旧快照
  const hollowed: MeshInstance = { ...element, primitive: { kind: 'solid', features: [] } };
  const sizeFromBinding = sizeOf(document, hollowed)!;
  check('特征树快照被清空后仍能求值（按参数重建）', sizeFromBinding !== null && near(sizeFromBinding.x, 0.24, 0.01));
  check('重建结果与快照一致', near(sizeFromParams.x, sizeFromBinding.x, 1e-6));

  const bumped = withParam(element, 'width', 0.32);
  const rebuiltCount = bumped.parametric ? buildParametricFeatures(bumped.parametric).length : -1;
  check('withParam 更新参数并刷新快照', bumped.parametric?.params.width === 0.32
    && solidFeaturesOf(bumped).length === rebuiltCount, `${solidFeaturesOf(bumped).length} / ${rebuiltCount}`);
  const bumpedSize = sizeOf(document, bumped)!;
  check(`withParam 后几何变宽（${sizeFromParams.x.toFixed(2)} → ${bumpedSize.x.toFixed(2)}）`, bumpedSize.x > sizeFromParams.x + 0.05);

  const detached = disconnectParametric(bumped);
  check('断开后 parametric 清空', detached.parametric === undefined);
  check(`断开后特征树保留（${solidFeaturesOf(detached).length} 个特征）`, solidFeaturesOf(detached).length === rebuiltCount);
}

console.log('\n服务端：setParams');
{
  const { document, element } = buildElement('bracket');
  const result = applyOps(document, [
    { op: 'setParams', target: element.id, params: { height: 0.18 } },
  ]);
  const updated = result.document.elements[0] as MeshInstance;
  check('setParams 落库', updated.parametric?.params.height === 0.18);
  check('setParams 保持其余参数', updated.parametric?.params.width === 0.16 && updated.parametric?.params.depth === 0.1);
  const before = sizeOf(document, element)!;
  const after = sizeOf(result.document, updated)!;
  check(`setParams 后变高（${before.z.toFixed(2)} → ${after.z.toFixed(2)}）`, near(after.z - before.z, 0.06, 0.01));

  const rejected = (() => {
    try {
      applyOps(document, [{ op: 'setParams', target: element.id, params: { height: 99 } }]);
      return '未报错';
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  })();
  check('越界参数被服务端拒绝', rejected.includes('应在'), rejected);

  const unknown = (() => {
    try {
      applyOps(document, [{ op: 'setParams', target: element.id, params: { tall: 3 } }]);
      return '未报错';
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  })();
  check('未知参数被服务端拒绝并列出可用键', unknown.includes('没有参数「tall」') && unknown.includes('height'), unknown);

  const featureOp = (() => {
    try {
      applyOps(document, [
        { op: 'addFeature', target: element.id, feature: { shape: 'box', width: 1, depth: 1, height: 1 } },
      ]);
      return '未报错';
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  })();
  check('参数化构件拒绝直接加特征（会被重建覆盖）', featureOp.includes('参数化构件'), featureOp);
}

console.log('\n服务端：addSolid 校验');
{
  const badModel = (() => {
    try {
      const project = createProject({ name: 'x' });
      applyOps(project, [{ op: 'addSolid', name: 'x', library: 'spaceship' }]);
      return '未报错';
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  })();
  check('未知模型被拒绝并列出可用模型', badModel.includes('未知模型') && badModel.includes('pavilion-hex'), badModel);

  const staticWithParams = (() => {
    try {
      const project = createProject({ name: 'x' });
      applyOps(project, [{ op: 'addSolid', name: '亭', library: 'pavilion-hex', params: { height: 3 } }]);
      return '未报错';
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  })();
  check('静态模型不接受 params', staticWithParams.includes('静态特征树'), staticWithParams);

  const staticSolid = (() => {
    const project = createProject({ name: 'y' });
    const { document } = applyOps(project, [
      { op: 'addSolid', name: '静态', features: [{ shape: 'box', width: 1, depth: 1, height: 1 }] },
    ]);
    try {
      applyOps(document, [{ op: 'setParams', target: document.elements[0].id, params: { height: 3 } }]);
      return '未报错';
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  })();
  check('静态特征树调 setParams 报错并给出替代方案', staticSolid.includes('不是参数化构件'), staticSolid);
}

console.log('\n公式约束（支架宽度 = 0.2）');
{
  const { document, element } = buildElement('bracket', { width: 0.16 });
  const linked = {
    ...document,
    elements: document.elements.map((item) => (
      item.id === element.id ? { ...item, formulas: { 'param.width': '0.2' } } : item
    )),
  };
  const { project: next, report } = recomputeParameters(linked);
  const updated = next.elements[0] as MeshInstance;
  check('公式写入参数模型', near(updated.parametric?.params.width ?? 0, 0.2), `${updated.parametric?.params.width}`);
  check('公式变更进入报告', report.updates.some((item) => item.key === 'param.width'));

  const before = sizeOf(document, element)!;
  const after = sizeOf(next, updated)!;
  check(`公式联动几何（${before.x.toFixed(2)} → ${after.x.toFixed(2)}）`, near(after.x, 0.2, 0.01));
  check('参数表暴露 param.width', elementParameterSpec(updated, 'param.width')?.label === '宽');
  check('参数表给出范围', elementParameterSpec(updated, 'param.width')?.max === 2);
}

console.log('\n模板库集成');
{
  const pavilion = SOLID_TEMPLATES.find((item) => item.id === 'pavilion-hex');
  const bracket = SOLID_TEMPLATES.find((item) => item.id === 'bracket');
  const gear = SOLID_TEMPLATES.find((item) => item.id === 'gear');
  check('亭子模板是静态特征树', Boolean(pavilion) && !pavilion?.parametric);
  check('支架模板标记为参数化', Boolean(bracket?.parametric));
  check('齿轮模板仍是静态特征树', !gear?.parametric);

  const project = createProject({ name: 'z' });
  const { document } = applyOps(project, [{
    op: 'addSolid',
    name: bracket!.name,
    library: bracket!.id,
    params: bracket!.parametric!.params,
  }]);
  const element = document.elements[0] as MeshInstance;
  const size = sizeOf(document, element)!;
  check(`模板落成参数化构件（宽 ${size.x.toFixed(2)} m）`, near(size.x, 0.16, 0.01) && element.parametric?.template === 'bracket');
}

if (failures.length) {
  console.error(`\n参数化测试失败 ${failures.length} 项：`);
  failures.forEach((failure) => console.error(` - ${failure}`));
  process.exit(1);
}
console.log(`\n参数化测试通过（${passed} 项）`);
