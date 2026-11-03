/**
 * 差分工具测试：diffDocuments / applyDocumentDiff 与服务端语义一致。
 */
import { createDemoProject } from '../src/bim/template';
import { applyDocumentDiff, diffDocuments } from '../src/collab/diff';
import type { ProjectDocument } from '../src/bim/types';

let failed = 0;
function check(name: string, ok: boolean, detail?: unknown) {
  if (ok) console.log('  ✓', name);
  else { failed += 1; console.log('  ✗', name, detail ?? ''); }
}

const base = createDemoProject();
check('相同引用不产生补丁', diffDocuments(base, base) === null);

const wallType = base.types.find((type) => type.category === 'wall')!;
const next: ProjectDocument = {
  ...base,
  name: '协作后的项目',
  levels: base.levels.map((level, index) => (index === 0 ? { ...level, elevation: 0.5 } : level)),
  types: base.types.map((type) => (type.id === wallType.id ? { ...type, thickness: 0.35 } : type)),
  elements: [
    ...base.elements.filter((element) => element.category !== 'column'),
    {
      id: 'new-wall-1',
      name: '新墙',
      category: 'wall',
      typeId: wallType.id,
      levelId: base.levels[0]!.id,
      visible: true,
      start: [0, 0],
      end: [2, 0],
      baseOffset: 0,
      topLevelId: base.levels[1]!.id,
      topOffset: 0,
    },
  ],
};

const diff = diffDocuments(base, next);
check('产生补丁', Boolean(diff), diff);
check('项目名进入补丁', diff?.name === '协作后的项目');
check('标高数组进入补丁', Array.isArray(diff?.levels));
check('类型数组进入补丁', Array.isArray(diff?.types));
check('只 put 新增构件（未改动构件按引用跳过）', diff?.elements?.put?.length === 1 && diff?.elements?.put?.[0]?.id === 'new-wall-1', diff?.elements?.put?.map((element) => element.id));
check('remove 只包含被删除的柱', diff?.elements?.remove?.length === 4, diff?.elements?.remove);

const applied = applyDocumentDiff(base, diff!);
check('应用补丁后与原文档一致', JSON.stringify(applied) === JSON.stringify(next));
check('apply 不修改入参', base.elements.length === 9 && base.name === '示例项目 · 建筑');
check('未改动的构件保持引用不变', applied.elements.find((element) => element.id === base.elements[0]!.id) === base.elements[0], '引用应复用');

const removeOnly = diffDocuments(next, { ...next, elements: next.elements.filter((element) => element.id !== 'new-wall-1') });
check('删除补丁形状', removeOnly?.elements?.remove?.length === 1 && removeOnly?.elements?.remove?.[0] === 'new-wall-1', removeOnly);

console.log(failed ? `\n${failed} 项失败` : '\n全部通过');
process.exit(failed ? 1 : 0);
