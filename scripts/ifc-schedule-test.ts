/** IFC4 导出与构件明细表测试：由 esbuild 打包成 .mjs 后用 node 执行。 */
import assert from 'node:assert/strict';
import { buildElementGeometry } from '../src/bim/geometry';
import { exportIfc, ifcGlobalId } from '../src/bim/ifc';
import { buildSchedule, scheduleHeaders, scheduleToCsv } from '../src/bim/schedule';
import type { ScheduleRow } from '../src/bim/schedule';
import { createDemoProject } from '../src/bim/template';

let failed = 0;
function check(name: string, run: () => void) {
  try {
    run();
    console.log('  ✓', name);
  } catch (error) {
    failed += 1;
    console.log('  ✗', name, error instanceof Error ? error.message : error);
  }
}

const countOf = (text: string, needle: string): number => text.split(needle).length - 1;

const project = createDemoProject();
const ifc = exportIfc(project);
const rows = buildSchedule(project);
const csv = scheduleToCsv(rows);
const visible = project.elements.filter((element) => element.visible);

/* ------------------------------ IFC 文件结构 ------------------------------ */

check('STEP 头/尾与 DATA 段完整', () => {
  assert.ok(ifc.startsWith('ISO-10303-21;'));
  assert.ok(ifc.includes('HEADER;'));
  assert.ok(ifc.includes('ENDSEC;'));
  assert.ok(ifc.includes('DATA;'));
  assert.ok(ifc.trimEnd().endsWith('END-ISO-10303-21;'));
});

check("包含 FILE_SCHEMA(('IFC4'))", () => {
  assert.ok(ifc.includes("FILE_SCHEMA(('IFC4'))"));
});

check('IFCPROJECT / IFCBUILDING / 单位 / 几何上下文齐备', () => {
  assert.ok(ifc.includes('IFCPROJECT('));
  assert.ok(ifc.includes('IFCBUILDING('));
  assert.ok(ifc.includes('IFCUNITASSIGNMENT('));
  assert.ok(ifc.includes('IFCGEOMETRICREPRESENTATIONCONTEXT('));
});

check('长度单位为 .METRE.（米制，无 .MILLI. 前缀）', () => {
  assert.ok(ifc.includes('IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.)'));
  assert.ok(!ifc.includes('.MILLI.,.METRE.'));
});

check('IfcBuildingStorey 数量与 Elevation 正确', () => {
  assert.equal(countOf(ifc, 'IFCBUILDINGSTOREY('), project.levels.length);
  assert.equal(project.levels.length, 2);
  assert.ok(ifc.includes('.ELEMENT.,0.)'));
  assert.ok(ifc.includes('.ELEMENT.,3.)'));
});

check('IFCRELAGGREGATES 组织 项目→建筑→标高 层级', () => {
  assert.equal(countOf(ifc, 'IFCRELAGGREGATES('), 2);
});

check('IFCRELCONTAINEDINSPATIALSTRUCTURE 把构件挂到 storey', () => {
  assert.ok(countOf(ifc, 'IFCRELCONTAINEDINSPATIALSTRUCTURE(') >= 1);
  assert.ok(ifc.includes('IFCRELCONTAINEDINSPATIALSTRUCTURE('));
});

/* ------------------------------ IFC 产品与 GlobalId ------------------------------ */

check('每个可见构件都有对应类别的 IFC 产品', () => {
  assert.equal(countOf(ifc, 'IFCWALL('), 4);
  assert.equal(countOf(ifc, 'IFCCOLUMN('), 4);
  assert.equal(countOf(ifc, 'IFCSLAB('), 1);
  assert.equal(countOf(ifc, 'IFCBUILDINGELEMENTPROXY('), 0);
  assert.equal(countOf(ifc, 'IFCPRODUCTDEFINITIONSHAPE('), visible.length);
  assert.equal(visible.length, 9);
});

check('每个构件的稳定 GlobalId 都出现在文本中', () => {
  for (const element of project.elements) {
    assert.ok(ifc.includes(ifcGlobalId(`element:${element.id}`)), element.id);
  }
});

check('GlobalId 长度 22、字符集合法、首字符 0-3', () => {
  const ids = [...ifc.matchAll(/'([0-9A-Za-z_$]{22})'/g)].map((match) => match[1]!);
  assert.ok(ids.length >= 12, `GlobalId 数量偏少：${ids.length}`);
  assert.ok(ids.every((id) => id.length === 22));
  assert.ok(/^[0-9A-Za-z_$]{22}$/.test(ifcGlobalId('demo-wall-1')));
  assert.ok(/^[0-3]/.test(ifcGlobalId('demo-wall-1')));
});

check('GlobalId 确定性：同 key 相同、不同 key 不同、两次导出全等', () => {
  assert.equal(ifcGlobalId('demo-wall-1'), ifcGlobalId('demo-wall-1'));
  assert.notEqual(ifcGlobalId('demo-wall-1'), ifcGlobalId('demo-wall-2'));
  assert.equal(exportIfc(project), ifc);
});

/* ------------------------------ IFC 几何 ------------------------------ */

check('几何采用 IFCPOLYGONALFACESET + IFCCARTESIANPOINTLIST3D', () => {
  assert.equal(countOf(ifc, 'IFCPOLYGONALFACESET('), visible.length);
  assert.equal(countOf(ifc, 'IFCCARTESIANPOINTLIST3D('), visible.length);
  assert.equal(
    countOf(ifc, 'IFCINDEXEDPOLYGONALFACE('),
    rows.reduce((sum, row) => sum + row.triangles, 0),
  );
});

check('三角面索引从 1 开始且均为正整数', () => {
  assert.ok(ifc.includes('IFCINDEXEDPOLYGONALFACE((1,'));
  const faces = [...ifc.matchAll(/IFCINDEXEDPOLYGONALFACE\(\((\d+),(\d+),(\d+)\)\)/g)];
  assert.ok(faces.length > 0);
  for (const face of faces) {
    for (const group of [1, 2, 3]) {
      assert.ok(Number(face[group]) >= 1, `索引必须 >= 1：${face[group]}`);
    }
  }
});

check('点坐标数值全部有限，无 NaN / Infinity', () => {
  assert.ok(!/NaN|Infinity|undefined/.test(ifc));
  const triples = [...ifc.matchAll(/\(([-\d.Ee+]+),([-\d.Ee+]+),([-\d.Ee+]+)\)/g)];
  assert.ok(triples.length > 0, '未找到坐标三元组');
  for (const triple of triples) {
    for (const group of [1, 2, 3]) {
      assert.ok(Number.isFinite(Number(triple[group])), `非法坐标：${triple[group]}`);
    }
  }
});

check('几何为 Z-up 米制（墙的 Z 范围 [0, 3]）', () => {
  const wall = project.elements.find((element) => element.category === 'wall')!;
  const geometry = buildElementGeometry(project, wall);
  assert.ok(geometry, '墙应有有效几何');
  const position = geometry!.getAttribute('position');
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (let index = 0; index < position.count; index += 1) {
    const z = position.getZ(index);
    assert.ok(Number.isFinite(z));
    minZ = Math.min(minZ, z);
    maxZ = Math.max(maxZ, z);
  }
  geometry!.dispose();
  assert.ok(Math.abs(minZ) < 1e-5, `底面 Z 应为 0，实际 ${minZ}`);
  assert.ok(Math.abs(maxZ - 3) < 1e-5, `顶面 Z 应为 3，实际 ${maxZ}`);
});

check('STEP 字符串按规则转义中文名（\\X2\\…\\X0\\）', () => {
  assert.ok(ifc.includes('\\X2\\'));
  assert.ok(ifc.includes('\\X0\\'));
});

check('隐藏构件不输出 IFC 产品', () => {
  const hiddenProject = createDemoProject();
  const hiddenId = hiddenProject.elements[0]!.id;
  hiddenProject.elements[0]!.visible = false;
  const hiddenIfc = exportIfc(hiddenProject);
  assert.equal(countOf(hiddenIfc, 'IFCWALL('), countOf(ifc, 'IFCWALL(') - 1);
  assert.ok(!hiddenIfc.includes(ifcGlobalId(`element:${hiddenId}`)));
});

/* ------------------------------ 明细表 ------------------------------ */

check('buildSchedule 行数等于项目构件数', () => {
  assert.equal(rows.length, project.elements.length);
  assert.equal(rows.length, 9);
});

check('墙体积 = 长度 × 高度 × 厚度', () => {
  const wall = rows.find((row) => row.id === 'demo-wall-1')!;
  assert.equal(wall.length, 6);
  assert.ok(Math.abs((wall.volume ?? 0) - 3.6) < 1e-9, `墙体积 ${wall.volume}`);
});

check('柱体积 = 截面 × 高度', () => {
  const column = rows.find((row) => row.id === 'demo-column-1')!;
  assert.ok(Math.abs((column.volume ?? 0) - 0.48) < 1e-9, `柱体积 ${column.volume}`);
});

check('板面积 = polygonArea，板体积 = 面积 × 厚度', () => {
  const slab = rows.find((row) => row.id === 'demo-slab-1')!;
  assert.ok(Math.abs((slab.area ?? 0) - 24) < 1e-9, `板面积 ${slab.area}`);
  assert.ok(Math.abs((slab.volume ?? 0) - 3.6) < 1e-9, `板体积 ${slab.volume}`);
});

check('CSV 带 UTF-8 BOM', () => {
  assert.equal(csv.charCodeAt(0), 0xfeff);
});

check('CSV 表头为中文且与 scheduleHeaders 一致', () => {
  assert.ok(csv.includes(scheduleHeaders.join(',')));
  assert.ok(csv.includes('体积(m³)'));
});

check('CSV 行数 = 表头 1 行 + 构件行数', () => {
  assert.equal(csv.trim().split(/\r?\n/).length, rows.length + 1);
});

check('CSV 数值保留 3 位小数并正确转义逗号/引号', () => {
  assert.ok(csv.includes('3.600'));
  const tricky: ScheduleRow = {
    id: 'x', name: 'a,b"c', category: '墙', typeName: '', level: '', material: '', triangles: 0,
  };
  assert.ok(scheduleToCsv([tricky]).includes('"a,b""c"'));
});

console.log(failed ? `\n${failed} 项失败` : '\n全部通过');
process.exit(failed ? 1 : 0);
