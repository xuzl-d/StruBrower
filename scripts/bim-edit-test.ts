/** 通用编辑操作测试：平移（构件/类型/网格）与复制。 */
import { createDemoProject } from '../src/bim/template';
import { arrayElements, duplicateElements, mirrorElement, rotateElement, translateElement } from '../src/bim/edit';
import type { ColumnInstance, MeshInstance, SlabInstance, WallInstance } from '../src/bim/types';

let failed = 0;
function check(name: string, ok: boolean, detail?: unknown) {
  if (ok) console.log('  ✓', name);
  else { failed += 1; console.log('  ✗', name, detail ?? ''); }
}

const project = createDemoProject();
const wall = project.elements.find((element) => element.category === 'wall') as WallInstance;
const column = project.elements.find((element) => element.category === 'column') as ColumnInstance;
const slab = project.elements.find((element) => element.category === 'slab') as SlabInstance;

const movedWall = translateElement(wall, { dx: 2, dy: 3, dz: 0.5 }) as WallInstance;
check('墙：起点/终点平移', movedWall.start[0] === wall.start[0] + 2 && movedWall.start[1] === wall.start[1] + 3
  && movedWall.end[0] === wall.end[0] + 2 && movedWall.end[1] === wall.end[1] + 3, movedWall);
check('墙：ΔZ 同步调整底部/顶部偏移（高度不变）',
  Math.abs((movedWall.baseOffset - wall.baseOffset) - 0.5) < 1e-9
  && Math.abs((movedWall.topOffset - wall.topOffset) - 0.5) < 1e-9, movedWall);
check('墙：原构件未被修改', wall.baseOffset === 0, wall.baseOffset);

const movedColumn = translateElement(column, { dx: -1, dy: 4, dz: 2 }) as ColumnInstance;
check('柱：定位与底部偏移', movedColumn.position[0] === column.position[0] - 1
  && movedColumn.position[1] === column.position[1] + 4
  && movedColumn.baseOffset === column.baseOffset + 2, movedColumn);

const movedSlab = translateElement(slab, { dx: 1, dy: -2 }) as SlabInstance;
check('板：轮廓点平移', movedSlab.points[0]![0] === slab.points[0]![0] + 1
  && movedSlab.points[0]![1] === slab.points[0]![1] - 2, movedSlab.points[0]);
check('板：ΔZ 调整偏移', (translateElement(slab, { dx: 0, dy: 0, dz: 1.5 }) as SlabInstance).baseOffset === slab.baseOffset + 1.5);

const mesh: MeshInstance = {
  id: 'mesh-1', name: '导入模型', category: 'mesh', levelId: wall.levelId, typeId: '',
  visible: true, positions: [0, 0, 0, 1, 0, 0, 0, 1, 0], indices: [0, 1, 2], color: '#ffffff', source: 'test',
};
const movedMesh = translateElement(mesh, { dx: 1, dy: 2, dz: 3 }) as MeshInstance;
check('网格：写入 offset 而不改顶点', JSON.stringify(movedMesh.offset) === JSON.stringify([1, 2, 3])
  && movedMesh.positions === mesh.positions, movedMesh.offset);
const movedTwice = translateElement(movedMesh, { dx: 1, dy: 0, dz: 0 }) as MeshInstance;
check('网格：偏移可累加', JSON.stringify(movedTwice.offset) === JSON.stringify([2, 2, 3]), movedTwice.offset);

const copies = duplicateElements(project, [wall, column, mesh], { dx: 1, dy: 0 });
check('复制数量正确', copies.length === 3, copies.length);
check('复制生成新 id', copies.every((copy) => copy.id !== wall.id && copy.id !== column.id && copy.id !== mesh.id));
check('复制自动命名且不重复', new Set(copies.map((copy) => copy.name)).size === 3
  && copies.every((copy) => ![wall.name, column.name, mesh.name].includes(copy.name)), copies.map((copy) => copy.name));
check('复制保留类型与参数', (copies[0] as WallInstance).typeId === wall.typeId
  && (copies[0] as WallInstance).start[0] === wall.start[0] + 1);
check('复制网格共享顶点数组', (copies[2] as MeshInstance).positions === mesh.positions);
check('复制不修改原项目', project.elements.length === 9, project.elements.length);

const secondBatch = duplicateElements(project, [wall], { dx: 2, dy: 0 });
check('再次复制命名不冲突', !secondBatch[0]!.name.includes(wall.name), secondBatch[0]!.name);


/* ---- 旋转 / 镜像 / 阵列 ---- */
const rotatedWall = rotateElement(wall, { angle: Math.PI / 2, center: [0, 0] }) as WallInstance;
check('旋转：墙端点绕基点旋转 90°',
  Math.abs(rotatedWall.start[0]) < 1e-6 && Math.abs(rotatedWall.start[1]) < 1e-6
  && Math.abs(rotatedWall.end[0]) < 1e-6 && Math.abs(rotatedWall.end[1] - 6) < 1e-6,
  rotatedWall.end);

const rotatedColumn = rotateElement(column, { angle: Math.PI / 2, center: [0, 0] }) as ColumnInstance;
const expectedColumnX = -column.position[1];
const expectedColumnY = column.position[0];
check('旋转：柱定位绕基点旋转且自身转角累加',
  Math.abs(rotatedColumn.position[0] - expectedColumnX) < 1e-6
  && Math.abs(rotatedColumn.position[1] - expectedColumnY) < 1e-6
  && Math.abs(rotatedColumn.rotation - Math.PI / 2) < 1e-6,
  rotatedColumn);

const rotatedMesh = rotateElement({ ...mesh, offset: [2, 0, 0], rotation: 0 }, { angle: Math.PI / 2, center: [1, 0] }) as MeshInstance;
check('旋转：网格绕基点换算 offset + rotation',
  Math.abs(rotatedMesh.offset![0] - 1) < 1e-6 && Math.abs(rotatedMesh.offset![1] - 1) < 1e-6
  && Math.abs(rotatedMesh.rotation! - Math.PI / 2) < 1e-6,
  rotatedMesh.offset);

const mirroredWall = mirrorElement(wall, { axis: 'vertical', position: 0 }) as WallInstance;
check('镜像：墙关于 x=0 翻转', mirroredWall.end[0] === -6 && mirroredWall.start[0] === 0, mirroredWall.end);
const mirroredColumn = mirrorElement(column, { axis: 'horizontal', position: 0 }) as ColumnInstance;
check('镜像：柱位置与转角同步翻转',
  mirroredColumn.position[1] === -column.position[1] && mirroredColumn.rotation === -column.rotation, mirroredColumn);

const linear = arrayElements(project, [wall], { mode: 'linear', count: 3, dx: 2, dy: 0 });
check('线性阵列：副本数量与偏移', linear.length === 2
  && (linear[0] as WallInstance).start[0] === wall.start[0] + 2
  && (linear[1] as WallInstance).start[0] === wall.start[0] + 4, linear.map((copy) => (copy as WallInstance).start[0]));
check('线性阵列：命名唯一', new Set(linear.map((copy) => copy.name)).size === linear.length, linear.map((copy) => copy.name));

const polar = arrayElements(project, [wall], { mode: 'polar', count: 4, totalAngleDeg: 360, center: [0, 0] });
check('环形阵列：360° 等分', polar.length === 3
  && Math.abs((polar[0] as WallInstance).end[1] - 6) < 1e-6, (polar[0] as WallInstance).end);

console.log(failed ? `\n${failed} 项失败` : '\n全部通过');
process.exit(failed ? 1 : 0);
