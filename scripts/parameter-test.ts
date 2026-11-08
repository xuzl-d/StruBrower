/** 参数关联更新：公式求值器、依赖拓扑、循环检测、全局→类型→实例联动、协作差分测试。 */
import {
  defaultParameters, evaluateFormula, formulaReferences, parameterIssues, parameterUsage,
  previewFormula, readElementParameter, readTypeParameter, recomputeParameters,
  removeParameter, renameParameterReferences, setElementFormula, setTypeFormula,
  upsertParameter, ensureDocumentParameters,
} from '../src/bim/parameters';
import { createDemoProject, createProject } from '../src/bim/template';
import { createPrimitiveElement } from '../src/bim/primitives';
import { migrateDocument } from '../src/bim/document';
import { buildSchedule } from '../src/bim/schedule';
import { diffDocuments, applyDocumentDiff } from '../src/collab/diff';
import { validateDiff } from '../server/validate.js';
import type { BimElement, ProjectDocument, ProjectParameter } from '../src/bim/types';

let failed = 0;
function check(name: string, ok: boolean, detail?: unknown) {
  if (ok) console.log('  ✓', name);
  else { failed += 1; console.log('  ✗', name, detail ?? ''); }
}

const near = (a: number, b: number) => Math.abs(a - b) < 1e-6;
const param = (project: ProjectDocument, name: string): ProjectParameter =>
  (project.parameters ?? []).find((item) => item.name === name)!;
const withValue = (project: ProjectDocument, name: string, value: number) =>
  upsertParameter(project, { ...param(project, name), value });
const typeOf = (project: ProjectDocument, id: string) => project.types.find((item) => item.id === id)!;
const elementOf = (project: ProjectDocument, id: string): BimElement => project.elements.find((item) => item.id === id)!;

/* ---------------------- 1. 安全公式求值器 ---------------------- */
check('四则运算与优先级：2 + 3 * 4 = 14', near(evaluateFormula('2 + 3 * 4').value, 14));
check('括号与右结合幂：2 ^ 3 ^ 2 = 512', near(evaluateFormula('2 ^ 3 ^ 2').value, 512));
check('单位字面量：200mm + 0.3m = 0.5', near(evaluateFormula('200mm + 0.3m').value, 0.5));
check('角度字面量：180deg = π', near(evaluateFormula('180deg').value, Math.PI));
check('百分比字面量：50% = 0.5', near(evaluateFormula('50%').value, 0.5));
check('中文参数名引用', near(evaluateFormula('标准墙厚 * 2', { 标准墙厚: 0.2 }).value, 0.4));
check('常量与函数：max / round / clamp / if', (
  near(evaluateFormula('max(1, 3, 2)').value, 3)
  && near(evaluateFormula('round(1.2345, 2)').value, 1.23)
  && near(evaluateFormula('clamp(5, 0, 3)').value, 3)
  && near(evaluateFormula('if(2 > 1, 10, 20)').value, 10)
  && near(evaluateFormula('sqrt(PI ^ 2)').value, Math.PI)
));
check('负号与括号：- (2 + 3) * 2 = -10', near(evaluateFormula('-(2 + 3) * 2').value, -10));
check('未知标识符报错（不执行宿主代码）', (() => {
  const result = evaluateFormula('process.exit(1) + 未知参数');
  const dangling = evaluateFormula('未知参数 * 2');
  return !result.ok && /未知函数|未知参数/.test(result.error ?? '')
    && !dangling.ok && /未知参数/.test(dangling.error ?? '');
})());
check('除零结果不是有限数值 → 报错', !evaluateFormula('1 / 0').ok);
check('语法错误 → 报错', !evaluateFormula('1 +').ok);
check('引用列表排除函数与常量', (() => {
  const refs = formulaReferences('max(标准墙厚, 层高) * PI + 2');
  return refs.length === 2 && refs.includes('标准墙厚') && refs.includes('层高');
})(), formulaReferences('max(标准墙厚, 层高) * PI + 2'));

/* ---------------------- 2. 默认参数与稳定状态 ---------------------- */
const demo = createDemoProject();
check('默认参数表 7 项、4 个派生公式', (
  defaultParameters().length === 7 && defaultParameters().filter((item) => item.formula).length === 4
));
check('新建项目带参数表与类型公式', (
  (createProject().parameters?.length ?? 0) === 7
  && typeOf(createProject(), 'type-wall-200').formulas?.thickness === '标准墙厚'
));
check('一致文档重算后返回原引用（不污染撤销栈/差分）', recomputeParameters(demo).project === demo);
check('依赖关系图：基准厚度被标准墙厚引用', (() => {
  const usage = parameterUsage(demo);
  return usage.find((item) => item.name === '基准厚度')?.usedBy.some((ref) => ref.label === '标准墙厚') ?? false;
})());
check('parameterIssues：默认文档无公式问题', parameterIssues(demo).length === 0, parameterIssues(demo));

/* ---------------------- 3. 改一处动全身 ---------------------- */
const thicker = withValue(demo, '基准厚度', 0.25);
const linked = recomputeParameters(thicker);
check('链式全局参数按拓扑序重算', (
  near(param(linked.project, '标准墙厚').value, 0.25)
  && near(param(linked.project, '内墙厚').value, 0.125)
  && near(param(linked.project, '标准板厚').value, 0.1875)
  && near(param(linked.project, '标准柱截面').value, 0.5)
));
check('类型参数跟随全局参数重算', (
  near(readTypeParameter(typeOf(linked.project, 'type-wall-200'), 'thickness')!, 0.25)
  && near(readTypeParameter(typeOf(linked.project, 'type-column-400'), 'width')!, 0.5)
  && near(readTypeParameter(typeOf(linked.project, 'type-slab-150'), 'thickness')!, 0.1875)
));
check('重算报告含全局与类型更新、影响 9 个构件', (
  linked.report.updates.some((item) => item.scope === 'parameter')
  && linked.report.updates.some((item) => item.scope === 'type')
  && linked.report.affectedElements === 9
), linked.report);
check('明细表体积随类型厚度联动（0.20 → 0.25）', (() => {
  const before = buildSchedule(demo).find((row) => row.id === 'demo-wall-1')!.volume!;
  const after = buildSchedule(linked.project).find((row) => row.id === 'demo-wall-1')!.volume!;
  return Math.abs(after / before - 1.25) < 1e-6;
})());
check('重算后再次重算无新增更新（收敛）', recomputeParameters(linked.project).report.updates.length === 0);

/* ---------------------- 4. 异常与循环 ---------------------- */
const cyclic: ProjectDocument = {
  ...createProject(),
  parameters: [
    { id: 'a', name: 'A', value: 1, unit: 'number', formula: 'B * 2' },
    { id: 'b', name: 'B', value: 2, unit: 'number', formula: 'A / 2' },
  ],
  types: [],
  elements: [],
};
const cycleResult = recomputeParameters(cyclic);
check('循环引用被检出并保留原值', (
  cycleResult.report.issues.some((issue) => issue.message.includes('循环引用'))
  && param(cycleResult.project, 'A').value === 1
  && param(cycleResult.project, 'B').value === 2
), cycleResult.report.issues);
check('未知参数公式报错且不影响类型尺寸', (() => {
  const bad = upsertParameter(demo, { ...param(demo, '标准墙厚'), formula: '不存在的参数 * 2' });
  const result = recomputeParameters(bad);
  return result.report.issues.some((issue) => (issue.message ?? '').includes('未知参数'))
    && near(readTypeParameter(typeOf(result.project, 'type-wall-200'), 'thickness')!, 0.2);
})(), parameterIssues(upsertParameter(demo, { ...param(demo, '标准墙厚'), formula: '不存在的参数 * 2' })));
check('公式实时预览使用相同求值器', (() => {
  const ok = previewFormula(demo, '标准墙厚 * 2');
  const bad = previewFormula(demo, '1 / 0');
  return ok.ok && near(ok.value, 0.4) && !bad.ok;
})());

/* ---------------------- 5. 实例参数与上下文联动 ---------------------- */
const bound = setElementFormula(demo, 'demo-wall-1', 'baseOffset', '顶部标高 * 0.1');
const boundResult = recomputeParameters(bound);
check('实例参数公式：底部偏移 = 顶部标高 × 0.1 = 0.3', (
  near(readElementParameter(elementOf(boundResult.project, 'demo-wall-1'), 'baseOffset')!, 0.3)
  && boundResult.report.updates.some((item) => item.scope === 'element')
), boundResult.report.updates);
check('改标高后实例参数自动重算（3 m → 4 m ⇒ 0.4 m）', (() => {
  const withLevel = {
    ...boundResult.project,
    levels: boundResult.project.levels.map((level, index) => (index === 1 ? { ...level, elevation: 4 } : level)),
  };
  const result = recomputeParameters(withLevel);
  return near(readElementParameter(elementOf(result.project, 'demo-wall-1'), 'baseOffset')!, 0.4);
})());
check('实例几何参数公式：终点 X = 长度 / 2', (() => {
  const withFormula = setElementFormula(demo, 'demo-wall-1', 'end.x', '长度 / 2');
  const result = recomputeParameters(withFormula);
  return near(readElementParameter(elementOf(result.project, 'demo-wall-1'), 'end.x')!, 3);
})());
check('参数化体量尺寸公式：height = 标准层高 / 2', (() => {
  const levelId = demo.levels[0]!.id;
  const box = createPrimitiveElement({ project: demo, kind: 'box', position: [2, 2], levelId });
  const project = { ...demo, elements: [...demo.elements, box] };
  const withFormula = setElementFormula(project, box.id, 'primitive.height', '标准层高 / 2');
  const result = recomputeParameters(withFormula);
  return near(readElementParameter(elementOf(result.project, box.id), 'primitive.height')!, 1.5);
})());
check('只读检查不会修改文档', (() => {
  const before = JSON.stringify(demo);
  parameterIssues(bound);
  return JSON.stringify(demo) === before;
})());

/* ---------------------- 6. 编辑辅助与解除关联 ---------------------- */
check('重命名参数同步改写所有公式引用', (() => {
  const renamed = renameParameterReferences(demo, '基准厚度', '基准墙厚');
  return param(renamed, '标准墙厚').formula === '基准墙厚 * 墙厚系数'
    && param(renamed, '基准墙厚').name === '基准墙厚';
})());
check('解除类型关联后手动改值不被公式覆盖', (() => {
  const unbound = setTypeFormula(demo, 'type-wall-200', 'thickness', null);
  const manual = {
    ...unbound,
    types: unbound.types.map((type) => (type.id === 'type-wall-200' ? { ...type, thickness: 0.33 } : type)),
  };
  const result = recomputeParameters(manual);
  return near(readTypeParameter(typeOf(result.project, 'type-wall-200'), 'thickness')!, 0.33)
    && typeOf(result.project, 'type-wall-200').formulas?.['thickness'] === undefined;
})());
check('删除参数后不残留引用', removeParameter(demo, 'param-factor').parameters?.length === 6);
check('ensureDocumentParameters 对旧文档补齐参数且不自动绑定公式', (() => {
  const legacy = { ...demo, parameters: undefined } as unknown as ProjectDocument;
  const migrated = ensureDocumentParameters(legacy);
  return migrated.parameters?.length === 7
    && typeOf(migrated, 'type-wall-200').formulas === undefined
    && near(readTypeParameter(typeOf(migrated, 'type-wall-200'), 'thickness')!, 0.2);
})());
check('migrateDocument 保留已有参数表', (() => {
  const migrated = migrateDocument(JSON.parse(JSON.stringify(demo)) as unknown);
  return migrated.parameters?.length === 7
    && typeOf(migrated, 'type-wall-200').formulas?.thickness === '标准墙厚';
})());

/* ---------------------- 7. 协作与服务端口径 ---------------------- */
check('协作差分识别全局参数变化并可应用', (() => {
  const next = withValue(demo, '基准厚度', 0.4);
  const diff = diffDocuments(demo, next);
  const restored = applyDocumentDiff(demo, diff!);
  return Boolean(diff?.parameters) && near(param(restored, '基准厚度').value, 0.4);
})());
check('无参数变化时不产生 parameters 补丁', (() => {
  const diff = diffDocuments(demo, { ...demo, name: '改名' });
  return diff?.name === '改名' && diff.parameters === undefined;
})());
check('服务端允许 parameters 补丁并拒绝未知字段', (
  validateDiff({ parameters: defaultParameters() }) === null
  && validateDiff({ evil: [] }) !== null
));

console.log(failed ? `\n${failed} 项失败` : '\n全部通过');
process.exit(failed ? 1 : 0);
