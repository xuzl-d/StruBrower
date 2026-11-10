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

console.log(failed === 0 ? '\nmeasure 测试全部通过' : `\nmeasure 测试失败：${failed} 项`);
process.exit(failed === 0 ? 0 : 1);
