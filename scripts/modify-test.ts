/** Revit 式修改命令内核、参数化体量与几何变换测试。 */
import {
  MODIFY_LABELS, MODIFY_SHORTCUTS, advanceModify, constrainVector, createModifySession,
  finishModify, immediateModify, isReady, mirrorElementAboutLine, modifyPreview,
  reflectPoint, scaleMeshElement, stepBack, withSelection,
} from '../src/bim/modify';
import type { ModifyClick, ModifyOptions, ModifySession } from '../src/bim/modify';
import { createDemoProject } from '../src/bim/template';
import { createPrimitiveElement, buildPrimitiveGeometry, primitiveTriangles, updatePrimitiveField } from '../src/bim/primitives';
import { buildElementGeometry } from '../src/bim/geometry';
import type { ColumnInstance, MeshInstance, ProjectDocument, Vec2, WallInstance } from '../src/bim/types';

let failed = 0;
function check(name: string, ok: boolean, detail?: unknown) {
  if (ok) console.log('  ✓', name);
  else { failed += 1; console.log('  ✗', name, detail ?? ''); }
}

const demo = createDemoProject();
const wall = demo.elements.find((element) => element.id === 'demo-wall-1') as WallInstance;
const column = demo.elements.find((element) => element.id === 'demo-column-1') as ColumnInstance;

function play(
  project: ProjectDocument,
  command: Parameters<typeof createModifySession>[0],
  ids: string[],
  clicks: ModifyClick[],
  options: Partial<ModifyOptions> = {},
  cursor: Vec2 | null = null,
): { session: ModifySession; outcome: ReturnType<typeof finishModify> } {
  let session = createModifySession(command, project, ids, options);
  for (const click of clicks) session = advanceModify(session, click);
  return { session, outcome: finishModify(project, session, cursor) };
}

const click = (point: Vec2, hitId: string | null = null): ModifyClick => ({ point, hitId });

/* ------------------------------ 状态机 ------------------------------ */
check('命令标签与双字母快捷键齐全',
  Object.keys(MODIFY_SHORTCUTS).length >= 15 && MODIFY_SHORTCUTS.MV === 'move' && MODIFY_SHORTCUTS.MM === 'mirror-draw'
  && MODIFY_LABELS['array-radial'] === '环形阵列');
check('无选择时进入「等待选择」', createModifySession('move', demo, []).status === 'await-selection');
check('测量命令无需选择即可开始', createModifySession('measure', demo, []).status === 'active');
check('带选择时直接进入取点', createModifySession('move', demo, [wall.id]).status === 'active');
check('等待选择后用选集激活会话', (() => {
  const pending = createModifySession('move', demo, []);
  const active = withSelection(pending, demo, [wall.id, column.id]);
  return active.status === 'active' && active.ids.length === 2 && active.center[0] > 0;
})());
check('Esc 逐级退出：先退回取点，再结束命令', (() => {
  const first = advanceModify(createModifySession('move', demo, [wall.id]), click([0, 0]));
  const back = stepBack(first);
  return back.points.length === 0 && back.status === 'active' && stepBack(back).status === 'finished';
})());
check('两点取齐后才算可完成', (() => {
  const zero = createModifySession('move', demo, [wall.id]);
  const one = advanceModify(zero, click([0, 0]));
  const two = advanceModify(one, click([1, 0]));
  return !isReady(zero, null) && !isReady(one, null) && isReady(two, null);
})());
check('临时尺寸数值输入可替代第二次取点', (() => {
  let session = advanceModify(createModifySession('move', demo, [wall.id]), click([0, 0]));
  session = { ...session, numeric: 2.5 };
  return isReady(session, [3, 0]) && finishModify(demo, session, [3, 0]).error === undefined;
})());
check('约束只保留主导轴', constrainVector([3, 1], true)[1] === 0 && constrainVector([1, 4], true)[0] === 0);

/* ------------------------------ 移动 / 复制 ------------------------------ */
const moved = play(demo, 'move', [wall.id], [click([0, 0]), click([2, 3])]).outcome;
check('移动：两点差值写入墙端点', (() => {
  const result = moved.elements.find((element) => element.id === wall.id) as WallInstance;
  return Math.abs(result.start[0] - 2) < 1e-6 && Math.abs(result.end[1] - 3) < 1e-6 && !moved.error;
})(), moved.error);
check('移动：选集保持不变', moved.selection.length === 1 && moved.selection[0] === wall.id);
check('移动：约束后只剩 X 位移', (() => {
  const outcome = play(demo, 'move', [wall.id], [click([0, 0]), click([5, 2])], { constrain: true }).outcome;
  const result = outcome.elements.find((element) => element.id === wall.id) as WallInstance;
  return Math.abs(result.start[0] - 5) < 1e-6 && Math.abs(result.start[1]) < 1e-6;
})());
check('移动：数值 2.5 m 沿光标方向', (() => {
  let session = advanceModify(createModifySession('move', demo, [wall.id]), click([0, 0]));
  session = { ...session, numeric: 2.5 };
  const outcome = finishModify(demo, session, [1, 0]);
  const result = outcome.elements.find((element) => element.id === wall.id) as WallInstance;
  return Math.abs(result.start[0] - 2.5) < 1e-6;
})());
check('复制：生成副本并保留原构件', (() => {
  const outcome = play(demo, 'copy', [wall.id], [click([0, 0]), click([1, 0])]).outcome;
  return outcome.elements.length === demo.elements.length + 1
    && outcome.elements.some((element) => element.id === wall.id)
    && outcome.selection.length === 1 && outcome.selection[0] !== wall.id;
})());
check('复制「多个」：提交后命令继续，基点保留', (() => {
  const outcome = play(demo, 'copy', [wall.id], [click([0, 0]), click([1, 0])], { multiple: true }).outcome;
  return Boolean(outcome.keepSession) && outcome.keepSession?.points.length === 1
    && outcome.keepSession?.points[0]![0] === 0;
})());

/* ------------------------------ 旋转 / 镜像 ------------------------------ */
check('旋转：数值角度绕选集形心', (() => {
  let session = createModifySession('rotate', demo, [wall.id], { angle: 90 });
  session = advanceModify(session, click([1, 0]));
  session = { ...session, numeric: 90 };
  const outcome = finishModify(demo, session, null);
  const result = outcome.elements.find((element) => element.id === wall.id) as WallInstance;
  return !outcome.error && outcome.label.includes('90.0°') && Math.abs(result.start[0] - 3) < 1e-6;
})(), '');
check('旋转：两条方向射线求夹角', (() => {
  const outcome = play(demo, 'rotate', [wall.id], [click([4, 0]), click([3, 1])]).outcome;
  return !outcome.error && Math.abs(Number(outcome.label.match(/([\d.-]+)°/)?.[1]) - 90) < 1e-6;
})(), '');
check('镜像：绘制轴 x=3 翻转墙端点', (() => {
  const outcome = play(demo, 'mirror-draw', [wall.id], [click([3, -1]), click([3, 1])]).outcome;
  const result = outcome.elements.find((element) => element.id === wall.id) as WallInstance;
  return !outcome.error && Math.abs(result.start[0] - 6) < 1e-6 && Math.abs(result.end[0]) < 1e-6;
})());
check('镜像：拾取墙作为镜像轴', (() => {
  const outcome = play(demo, 'mirror-pick', [wall.id], [click([0, 0], 'demo-wall-4')]).outcome;
  return !outcome.error;
})(), '');
check('镜像：导入网格用 flip + 转角表达，不重写顶点', (() => {
  const mesh: MeshInstance = {
    id: 'mesh-1', name: '导入模型', category: 'mesh', levelId: wall.levelId, typeId: '',
    visible: true, positions: [0, 0, 0, 1, 0, 0, 0, 1, 0], indices: [0, 1, 2],
    color: '#ffffff', source: 'test', offset: [2, 0, 0], rotation: 0,
  };
  const result = mirrorElementAboutLine(mesh, [0, 0], [0, 1]) as MeshInstance;
  return result.flip === true && Math.abs(result.offset![0] + 2) < 1e-6
    && result.positions === mesh.positions && Math.abs(result.rotation! - Math.PI) < 1e-6;
})());
check('关于任意斜线反射：点到线距离保持不变', (() => {
  const point: Vec2 = [3, 1];
  const reflected = reflectPoint(point, [0, 0], [1, 1]);
  return Math.abs(reflected[0] - 1) < 1e-6 && Math.abs(reflected[1] - 3) < 1e-6;
})());
check('缩放：只改 offset 与 scale，不重写顶点', (() => {
  const mesh: MeshInstance = {
    id: 'mesh-2', name: '导入模型', category: 'mesh', levelId: wall.levelId, typeId: '',
    visible: true, positions: [0, 0, 0], indices: [0], color: '#ffffff', source: 'test', offset: [2, 0, 0],
  };
  const result = scaleMeshElement(mesh, 2, [0, 0]) as MeshInstance;
  return result.scale === 2 && Math.abs(result.offset![0] - 4) < 1e-6 && result.positions === mesh.positions
    && scaleMeshElement(wall, 2, [0, 0]) === wall;
})());

/* ------------------------------ 阵列 / 对齐 / 偏移 ------------------------------ */
check('线性阵列：间距与个数', (() => {
  const outcome = play(demo, 'array-linear', [wall.id], [click([0, 0]), click([2, 0])], { number: 4 }).outcome;
  const added = outcome.elements.slice(demo.elements.length) as WallInstance[];
  return !outcome.error && added.length === 3 && Math.abs(added[0]!.start[0] - 2) < 1e-6
    && Math.abs(added[2]!.start[0] - 6) < 1e-6;
})());
check('线性阵列：到最后一个时按 (个数-1) 等分', (() => {
  const outcome = play(demo, 'array-linear', [wall.id], [click([0, 0]), click([6, 0])], { number: 4, moveToLast: true }).outcome;
  const added = outcome.elements.slice(demo.elements.length) as WallInstance[];
  return Math.abs(added[0]!.start[0] - 2) < 1e-6 && Math.abs(added[2]!.start[0] - 6) < 1e-6;
})());
check('环形阵列：按总角度生成副本', (() => {
  const outcome = play(demo, 'array-radial', [wall.id], [click([4, 0]), click([3, 1])], { number: 3 }).outcome;
  return !outcome.error && outcome.elements.length === demo.elements.length + 2 && outcome.label.includes('90.0°');
})(), '');
check('对齐：参照点减去构件锚点', (() => {
  const outcome = play(demo, 'align', [wall.id], [click([10, 0]), click([0, 0])]).outcome;
  const result = outcome.elements.find((element) => element.id === wall.id) as WallInstance;
  return !outcome.error && Math.abs(result.start[0] - 10) < 1e-6;
})(), '');
check('偏移：沿墙法线按选项距离偏移', (() => {
  const outcome = play(demo, 'offset', [wall.id], [click([3, 0], wall.id), click([3, 2])], { distance: 1 }).outcome;
  const result = outcome.elements.find((element) => element.id === wall.id) as WallInstance;
  return !outcome.error && Math.abs(result.start[1] - 1) < 1e-6;
})(), '');
check('偏移：复制选项保留原构件', (() => {
  const outcome = play(demo, 'offset', [wall.id], [click([3, 0], wall.id), click([3, 2])], { distance: 1, copy: true }).outcome;
  return !outcome.error && outcome.elements.length === demo.elements.length + 1;
})());
check('缩放命令：墙柱板被拒绝', (() => {
  const outcome = play(demo, 'scale', [wall.id], [click([0, 0]), click([1, 0]), click([2, 0])]).outcome;
  return Boolean(outcome.error) && outcome.error!.includes('仅支持');
})());

/* ------------------------------ 修剪 / 拆分 / 测量 ------------------------------ */
const trimProject = createDemoProject();
const wallA: WallInstance = {
  ...wall, id: 'trim-a', name: '墙 A', start: [0, 0], end: [6, 0],
};
const wallB: WallInstance = {
  ...wall, id: 'trim-b', name: '墙 B', start: [3, -3], end: [3, 3],
};
trimProject.elements = [wallA, wallB];
check('修剪/延伸到角点：两墙端点落到交点', (() => {
  const outcome = play(trimProject, 'trim', [wallA.id, wallB.id],
    [click([1, 0], wallA.id), click([3, 1], wallB.id)]).outcome;
  const a = outcome.elements.find((element) => element.id === wallA.id) as WallInstance;
  const b = outcome.elements.find((element) => element.id === wallB.id) as WallInstance;
  return !outcome.error && Math.abs(a.end[0] - 3) < 1e-6 && Math.abs(b.start[1]) < 1e-6;
})(), '');
check('拆分墙：按点击位置切成两段', (() => {
  const outcome = play(trimProject, 'split', [wallA.id], [click([3, 0], wallA.id)]).outcome;
  return !outcome.error && outcome.elements.length === trimProject.elements.length + 1
    && outcome.elements.every((element) => element.category === 'wall')
    && outcome.selection.length === 2;
})(), '');
check('拆分墙：带间隙时两段不重叠', (() => {
  const outcome = play(trimProject, 'split', [wallA.id], [click([3, 0], wallA.id)], { splitGap: 0.4 }).outcome;
  const walls = (outcome.elements as WallInstance[]).filter((element) => element.start[1] === 0 && element.end[1] === 0);
  const a = walls.find((element) => element.end[0] < 3)!;
  const b = walls.find((element) => element.start[0] > 3)!;
  return Boolean(a && b) && Math.abs(b!.start[0] - a!.end[0] - 0.4) < 1e-6;
})());
check('测量：只给读数不改文档', (() => {
  const outcome = play(demo, 'measure', [], [click([0, 0]), click([3, 4])]).outcome;
  return outcome.elements === demo.elements && outcome.label.includes('5.000 m');
})(), '');

/* ------------------------------ 锁定保护 ------------------------------ */
const pinnedProject = createDemoProject();
pinnedProject.elements = pinnedProject.elements.map((element) => (
  element.id === wall.id ? { ...element, pinned: true } : element
));
check('锁定构件不可删除', (() => {
  const outcome = immediateModify(pinnedProject, 'delete', [wall.id]);
  return Boolean(outcome.error) && outcome.elements.length === pinnedProject.elements.length;
})());
check('锁定构件被移动命令跳过并给出提示', (() => {
  const outcome = play(pinnedProject, 'move', [wall.id], [click([0, 0]), click([2, 2])]).outcome;
  const result = outcome.elements.find((element) => element.id === wall.id) as WallInstance;
  return Boolean(outcome.error) && Math.abs(result.start[0]) < 1e-6;
})(), '');
check('解锁后可正常删除', (() => {
  const unlocked = immediateModify(pinnedProject, 'unpin', [wall.id]);
  const deleted = immediateModify({ ...pinnedProject, elements: unlocked.elements }, 'delete', [wall.id]);
  return !deleted.error && deleted.elements.length === pinnedProject.elements.length - 1;
})());

/* ------------------------------ 幽灵预览 ------------------------------ */
check('移动预览：一份幽灵 + 临时尺寸文本', (() => {
  const session = advanceModify(createModifySession('move', demo, [wall.id]), click([0, 0]));
  const preview = modifyPreview(demo, session, [3, 4]);
  return preview.ghosts.length === 1 && preview.ghosts[0]!.kind === 'translate'
    && preview.label.includes('5.00 m') && preview.guides.length === 1;
})(), '');
check('阵列预览：幽灵份数 = 个数 - 1', (() => {
  const session = advanceModify(createModifySession('array-linear', demo, [wall.id], { number: 5 }), click([0, 0]));
  return modifyPreview(demo, session, [2, 0]).ghosts.length === 4;
})());
check('旋转预览：标出旋转中心', (() => {
  const session = advanceModify(createModifySession('rotate', demo, [wall.id]), click([4, 0]));
  const preview = modifyPreview(demo, session, [3, 1]);
  return preview.markers.length === 1 && preview.ghosts[0]?.kind === 'rotate';
})());
check('镜像拾取轴：无效拾取被拒绝', (() => {
  const outcome = play(demo, 'mirror-pick', [wall.id], [click([50, 50], null)]).outcome;
  return Boolean(outcome.error);
})());

/* ------------------------------ 参数化基本体 ------------------------------ */
check('六类参数化基本体都能生成几何', (() => {
  const kinds = ['box', 'cylinder', 'sphere', 'extrude', 'revolve', 'pyramid'] as const;
  return kinds.every((kind) => {
    const spec = kind === 'extrude'
      ? { kind: 'extrude', profile: [[0, 0], [1, 0], [1, 1], [0, 1]] as Vec2[], height: 2 }
      : kind === 'revolve'
        ? { kind: 'revolve', profile: [[0, 0], [1, 0], [1, 2], [0, 2]] as Vec2[], segments: 12 }
        : kind === 'box' ? { kind: 'box', width: 1, depth: 1, height: 2 }
          : kind === 'cylinder' ? { kind: 'cylinder', radius: 1, height: 2, segments: 12 }
            : kind === 'sphere' ? { kind: 'sphere', radius: 1, segments: 12 }
              : { kind: 'pyramid', radius: 1, height: 2, sides: 4 };
    const geometry = buildPrimitiveGeometry(spec);
    const count = geometry.getAttribute('position').count;
    geometry.dispose();
    return count >= 3;
  });
})());
check('基本体三角面计数与几何一致', primitiveTriangles({ kind: 'box', width: 1, depth: 1, height: 2 }) === 12);
check('基本体参数可更新且有下限', (() => {
  const spec = { kind: 'box', width: 2, depth: 1, height: 3 } as const;
  const updated = updatePrimitiveField(spec, 'width', -5);
  return 'width' in updated && updated.width === 0.01 && updatePrimitiveField(spec, 'height', 4).height === 4;
})());
check('基本体构件：参数落盘、几何实时生成', (() => {
  const element = createPrimitiveElement({
    project: demo, kind: 'extrude', position: [2, 3], levelId: wall.levelId,
    spec: { kind: 'extrude', profile: [[-1, -1], [1, -1], [1, 1], [-1, 1]], height: 2 },
  });
  const geometry = buildElementGeometry({ ...demo, elements: [element] }, element);
  const ok = Boolean(geometry) && element.positions.length === 0 && element.primitive?.kind === 'extrude'
    && element.offset?.[0] === 2;
  geometry?.dispose();
  return ok;
})());
check('基本体镜像：flip 生效后几何仍可生成', (() => {
  const element = createPrimitiveElement({ project: demo, kind: 'box', position: [1, 1], levelId: wall.levelId });
  const mirrored = mirrorElementAboutLine(element, [0, 0], [0, 1]) as MeshInstance;
  const geometry = buildElementGeometry({ ...demo, elements: [mirrored] }, mirrored);
  const ok = Boolean(geometry) && mirrored.flip === true;
  geometry?.dispose();
  return ok;
})());

console.log(failed ? `\n${failed} 项失败` : '\n全部通过');
process.exit(failed ? 1 : 0);
