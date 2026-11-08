/**
 * IFC4（ISO 16739）STEP 文本导出。
 *
 * 坐标约定：buildElementGeometry 给出的是世界坐标、Z-up、单位米，
 * 因此所有 IfcLocalPlacement 都用恒等变换（相对轴放置指向原点），
 * 几何直接写在 IfcCartesianPointList3D 中，长度单位为 .METRE.（不加 .MILLI. 前缀）。
 *
 * 几何表达采用 IFC4 Add2 的镶嵌面集：
 *   IFCCARTESIANPOINTLIST3D → IFCPOLYGONALFACESET → IFCINDEXEDPOLYGONALFACE
 * 每个构件单独一份点表，三角面索引从 1 开始。
 */
import { buildElementGeometry } from './geometry';
import { layerOfElement, materialOfElement } from './layers';
import { categoryLabels } from './types';
import type { BufferGeometry } from 'three';
import type { ElementCategory, ProjectDocument } from './types';

/** IFC GlobalId 使用的 64 字符 base64 表。 */
const IFC_BASE64 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz_$';

/** 类别 → IFC4 产品实体名。 */
const PRODUCT_ENTITY: Record<ElementCategory, string> = {
  wall: 'IFCWALL',
  column: 'IFCCOLUMN',
  slab: 'IFCSLAB',
  mesh: 'IFCBUILDINGELEMENTPROXY',
};

/** FNV-1a 32 位哈希，纯整数运算，浏览器与 Node 结果一致。 */
function hash32(text: string, seed: number): number {
  let hash = (0x811c9dc5 ^ seed) >>> 0;
  for (let index = 0; index < text.length; index += 1) {
    hash = Math.imul(hash ^ text.charCodeAt(index), 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/**
 * 由任意 key 生成稳定的 22 字符 IfcGloballyUniqueId。
 * 5 个 32 位字共 160 bit，按 6 bit 一组取出 22 组；首字符压到 0..3，
 * 符合 IFC GUID 首字符只占 2 bit 的约定。
 */
export function ifcGlobalId(key: string): string {
  const words = [1, 2, 3, 4, 5].map((index) => hash32(key, Math.imul(0x9e3779b1, index)));
  let result = '';
  for (let group = 0; group < 22; group += 1) {
    let value = 0;
    for (let bit = 0; bit < 6; bit += 1) {
      const position = group * 6 + bit;
      const word = words[Math.floor(position / 32)]!;
      value = (value << 1) | ((word >>> (position % 32)) & 1);
    }
    result += IFC_BASE64[group === 0 ? value & 3 : value]!;
  }
  return result;
}

/**
 * STEP 字符串转义：单引号翻倍、反斜杠写成 \\，
 * 非 ASCII（及控制字符）用 \X2\<UTF-16 code unit 4 位十六进制>\X0\ 编码。
 */
function stepString(value: string): string {
  let body = '';
  let hex = '';
  const flushHex = () => {
    if (hex) {
      body += `\\X2\\${hex.toUpperCase()}\\X0\\`;
      hex = '';
    }
  };
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0x20 && code <= 0x7e) {
      flushHex();
      const char = value[index]!;
      if (char === "'") body += "''";
      else if (char === '\\') body += '\\\\';
      else body += char;
    } else {
      hex += code.toString(16).padStart(4, '0');
    }
  }
  flushHex();
  return `'${body}'`;
}

/** STEP REAL：必须带小数点，指数用大写 E；非有限值兜底为 0. */
function stepReal(value: number): string {
  if (!Number.isFinite(value) || value === 0) return '0.';
  const raw = String(value).toLowerCase();
  const exponentAt = raw.indexOf('e');
  const mantissa = exponentAt === -1 ? raw : raw.slice(0, exponentAt);
  const exponent = exponentAt === -1 ? '' : raw.slice(exponentAt + 1);
  const decimal = mantissa.includes('.') ? mantissa : `${mantissa}.`;
  return exponent ? `${decimal}E${Number(exponent).toString()}` : decimal;
}

/** STEP 实体编号分配器；STEP 允许前向引用，故按任意顺序写入均可。 */
class StepWriter {
  private readonly lines: string[] = [];
  private counter = 0;

  add(entity: string): string {
    this.counter += 1;
    const reference = `#${this.counter}`;
    this.lines.push(`${reference}=${entity};`);
    return reference;
  }

  body(): string {
    return this.lines.join('\n');
  }
}

interface TriangleMesh {
  points: Array<[number, number, number]>;
  faces: Array<[number, number, number]>;
}

/** 从 BufferGeometry 提取三角面，并按坐标去重，产出 1 起点索引的点表。 */
function triangleMeshOf(geometry: BufferGeometry): TriangleMesh {
  const position = geometry.getAttribute('position');
  const index = geometry.index;
  const count = index ? index.count : position.count;
  const points: Array<[number, number, number]> = [];
  const faces: Array<[number, number, number]> = [];
  const lookup = new Map<string, number>();

  for (let offset = 0; offset + 2 < count; offset += 3) {
    const face: number[] = [];
    for (let corner = 0; corner < 3; corner += 1) {
      const vertex = index ? index.getX(offset + corner) : offset + corner;
      const x = position.getX(vertex);
      const y = position.getY(vertex);
      const z = position.getZ(vertex);
      const px = Number.isFinite(x) ? x : 0;
      const py = Number.isFinite(y) ? y : 0;
      const pz = Number.isFinite(z) ? z : 0;
      const key = `${px},${py},${pz}`;
      let pointIndex = lookup.get(key);
      if (pointIndex === undefined) {
        pointIndex = points.length + 1;
        lookup.set(key, pointIndex);
        points.push([px, py, pz]);
      }
      face.push(pointIndex);
    }
    faces.push([face[0]!, face[1]!, face[2]!]);
  }
  return { points, faces };
}

function stepPointList(points: Array<[number, number, number]>): string {
  const coordinates = points
    .map(([x, y, z]) => `(${stepReal(x)},${stepReal(y)},${stepReal(z)})`)
    .join(',');
  return `IFCCARTESIANPOINTLIST3D((${coordinates}))`;
}

/** 恒等局部坐标系：每个 placement 独立建点/轴，避免共享轴放置。 */
function addPlacement(writer: StepWriter, parent: string): string {
  const origin = writer.add('IFCCARTESIANPOINT((0.,0.,0.))');
  const axis = writer.add(`IFCAXIS2PLACEMENT3D(${origin},$,$)`);
  return writer.add(`IFCLOCALPLACEMENT(${parent},${axis})`);
}

/** IFC4 中 IfcRoot.OwnerHistory 已改为 OPTIONAL，用 $ 省略整条所有权链。 */
const OWNER_HISTORY = '$';

/** 导出合法 IFC4 STEP 文本。 */
export function exportIfc(project: ProjectDocument): string {
  const writer = new StepWriter();

  // ---- 几何表示上下文与单位（米制） ----
  const contextOrigin = writer.add('IFCCARTESIANPOINT((0.,0.,0.))');
  const contextAxis = writer.add(`IFCAXIS2PLACEMENT3D(${contextOrigin},$,$)`);
  const geomContext = writer.add(
    `IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,${stepReal(0.0001)},${contextAxis},$)`,
  );
  const lengthUnit = writer.add('IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.)');
  const areaUnit = writer.add('IFCSIUNIT(*,.AREAUNIT.,$,.SQUARE_METRE.)');
  const volumeUnit = writer.add('IFCSIUNIT(*,.VOLUMEUNIT.,$,.CUBIC_METRE.)');
  const angleUnit = writer.add('IFCSIUNIT(*,.PLANEANGLEUNIT.,$,.RADIAN.)');
  const units = writer.add(
    `IFCUNITASSIGNMENT((${lengthUnit},${areaUnit},${volumeUnit},${angleUnit}))`,
  );

  // ---- 项目 / 建筑 ----
  const projectRef = writer.add(
    `IFCPROJECT(${stepString(ifcGlobalId(`project:${project.id}`))},${OWNER_HISTORY},${stepString(project.name)},$,$,$,$,(${geomContext}),${units})`,
  );
  const buildingPlacement = addPlacement(writer, '$');
  const buildingRef = writer.add(
    `IFCBUILDING(${stepString(ifcGlobalId(`building:${project.id}`))},${OWNER_HISTORY},'Building',$,$,${buildingPlacement},$,$,.ELEMENT.,$,$,$)`,
  );
  writer.add(
    `IFCRELAGGREGATES(${stepString(ifcGlobalId(`aggregate:project:${project.id}`))},${OWNER_HISTORY},$,$,${projectRef},(${buildingRef}))`,
  );

  // ---- 标高 → IfcBuildingStorey ----
  const storeyRefs = new Map<string, string>();
  const placementRefs = new Map<string, string>();
  for (const level of project.levels) {
    const placement = addPlacement(writer, buildingPlacement);
    const storey = writer.add(
      `IFCBUILDINGSTOREY(${stepString(ifcGlobalId(`storey:${level.id}`))},${OWNER_HISTORY},${stepString(level.name)},$,$,${placement},$,$,.ELEMENT.,${stepReal(level.elevation)})`,
    );
    storeyRefs.set(level.id, storey);
    placementRefs.set(level.id, placement);
  }
  if (project.levels.length) {
    const related = project.levels.map((level) => storeyRefs.get(level.id)!).join(',');
    writer.add(
      `IFCRELAGGREGATES(${stepString(ifcGlobalId(`aggregate:building:${project.id}`))},${OWNER_HISTORY},$,$,${buildingRef},(${related}))`,
    );
  }

  // ---- 材质 → IfcMaterial（图元覆盖优先于类型材质） ----
  const materialRefs = new Map<string, string>();
  for (const material of project.materials) {
    materialRefs.set(
      material.id,
      writer.add(`IFCMATERIAL(${stepString(material.name)},${material.description ? stepString(material.description) : '$'},$)`),
    );
  }

  // ---- 可见构件 → IfcProduct + 镶嵌几何 ----
  const contained = new Map<string, string[]>();
  const layerItems = new Map<string, string[]>();
  for (const element of project.elements) {
    if (!element.visible) continue;
    const geometry = buildElementGeometry(project, element);
    if (!geometry) continue;
    const mesh = triangleMeshOf(geometry);
    geometry.dispose();
    if (!mesh.faces.length) continue;

    const pointList = writer.add(stepPointList(mesh.points));
    const faces = mesh.faces
      .map(([a, b, c]) => `IFCINDEXEDPOLYGONALFACE((${a},${b},${c}))`)
      .join(',');
    const faceSet = writer.add(`IFCPOLYGONALFACESET(${pointList},$,(${faces}),$)`);
    const shapeRep = writer.add(
      `IFCSHAPEREPRESENTATION(${geomContext},'Body','Tessellation',(${faceSet}))`,
    );
    const definition = writer.add(`IFCPRODUCTDEFINITIONSHAPE($,$,(${shapeRep}))`);

    const parentPlacement = placementRefs.get(element.levelId) ?? buildingPlacement;
    const placement = addPlacement(writer, parentPlacement);
    const product = writer.add(
      `${PRODUCT_ENTITY[element.category]}(${stepString(ifcGlobalId(`element:${element.id}`))},${OWNER_HISTORY},${stepString(element.name)},${stepString(categoryLabels[element.category])},$,${placement},${definition},$)`,
    );

    const bucket = contained.get(element.levelId);
    if (bucket) bucket.push(product);
    else contained.set(element.levelId, [product]);

    // 材质关联：IfcRelAssociatesMaterial 把材质挂到构件
    const material = materialOfElement(project, element);
    const materialRef = material ? materialRefs.get(material.id) : undefined;
    if (materialRef) {
      writer.add(
        `IFCRELASSOCIATESMATERIAL(${stepString(ifcGlobalId(`material:${element.id}`))},${OWNER_HISTORY},$,$,(${product}),${materialRef})`,
      );
    }

    // 图层关联：IfcPresentationLayerAssignment（IFC 中图层的标准表达）
    const layer = layerOfElement(project, element);
    const layerKey = layer?.id ?? '0';
    const items = layerItems.get(layerKey);
    if (items) items.push(shapeRep);
    else layerItems.set(layerKey, [shapeRep]);
  }

  // ---- 图层 → IfcPresentationLayerAssignment ----
  for (const [layerId, items] of layerItems) {
    const layer = project.layers?.find((item) => item.id === layerId);
    writer.add(
      `IFCPRESENTATIONLAYERASSIGNMENT(${stepString(layer?.name ?? layerId)},$,(${items.join(',')}),${stepString(layerId)})`,
    );
  }

  // ---- IfcRelContainedInSpatialStructure：构件挂到对应 storey ----
  for (const [levelId, products] of contained) {
    const structure = storeyRefs.get(levelId) ?? buildingRef;
    writer.add(
      `IFCRELCONTAINEDINSPATIALSTRUCTURE(${stepString(ifcGlobalId(`contains:${levelId}`))},${OWNER_HISTORY},$,$,(${products.join(',')}),${structure})`,
    );
  }

  const header = [
    'ISO-10303-21;',
    'HEADER;',
    "FILE_DESCRIPTION(('ViewDefinition [CoordinationView_V2.0]'),'2;1');",
    `FILE_NAME(${stepString(`${project.name}.ifc`)},${stepString(project.updatedAt)},('StruBrowser'),(''),'StruBrowser IFC4 Exporter','StruBrowser','');`,
    "FILE_SCHEMA(('IFC4'));",
    'ENDSEC;',
    'DATA;',
  ].join('\n');

  return `${header}\n${writer.body()}\nENDSEC;\nEND-ISO-10303-21;\n`;
}
