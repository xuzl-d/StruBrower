/**
 * 导入管线回归测试：为每种格式现场生成一个立方体，走 parseModelBuffer 再核对三角形 / 尺寸 / 轴向。
 *
 * 覆盖：OBJ GLB STL(二进制) STL(ASCII) PLY OFF 3DS 3MF DXF DAE FBX(ASCII) SKP
 * DAE 需要 DOMParser，这里用 linkedom 提供（浏览器里是原生的）。
 *
 * 运行：npx esbuild scripts/import-test.ts --bundle --platform=node --format=esm \
 *        --outfile=.tmp/import-test.mjs --log-level=warning && node .tmp/import-test.mjs
 */
import { buildImportGeometry, countImportTriangles, guessUnitMeters, measureImport, parseModelBuffer } from '../src/import';
import type { ImportedModel } from '../src/import';
import { strToU8, zipSync } from 'three/examples/jsm/libs/fflate.module.js';

// DAE 走 ColladaLoader，需要 DOMParser；浏览器原生有，Node 里用 linkedom 顶一下
const { DOMParser: LinkedomDOMParser } = await import('linkedom');
(globalThis as unknown as { DOMParser: unknown }).DOMParser = LinkedomDOMParser;

let failures = 0;
function check(label: string, condition: boolean, detail = ''): void {
  if (condition) {
    console.log(`  ✓ ${label}`);
    return;
  }
  failures += 1;
  console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`);
}

/* ---------------- 立方体（边长 2，中心在原点） ---------------- */
const CUBE_VERTICES: number[][] = [
  [-1, -1, -1], [1, -1, -1], [1, 1, -1], [-1, 1, -1],
  [-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1],
];
const CUBE_FACES: number[][] = [
  [0, 2, 1], [0, 3, 2], // 底
  [4, 5, 6], [4, 6, 7], // 顶
  [0, 1, 5], [0, 5, 4],
  [1, 2, 6], [1, 6, 5],
  [2, 3, 7], [2, 7, 6],
  [3, 0, 4], [3, 4, 7],
];

/* ---------------- 各格式 writer ---------------- */
function writeObj(): ArrayBuffer {
  const lines = ['# fixture cube'];
  for (const [x, y, z] of CUBE_VERTICES) lines.push(`v ${x} ${y} ${z}`);
  for (const [a, b, c] of CUBE_FACES) lines.push(`f ${a! + 1} ${b! + 1} ${c! + 1}`);
  return new TextEncoder().encode(lines.join('\n')).buffer as ArrayBuffer;
}

function writeStlBinary(): ArrayBuffer {
  const buffer = new ArrayBuffer(84 + CUBE_FACES.length * 50);
  const view = new DataView(buffer);
  new Uint8Array(buffer, 0, 20).set(new TextEncoder().encode('STRUBROWSER FIXTURE'));
  view.setUint32(80, CUBE_FACES.length, true);
  CUBE_FACES.forEach((face, index) => {
    const base = 84 + index * 50;
    view.setFloat32(base, 0, true);
    face.forEach((vertexIndex, corner) => {
      const vertex = CUBE_VERTICES[vertexIndex]!;
      view.setFloat32(base + 12 + corner * 12, vertex[0]!, true);
      view.setFloat32(base + 16 + corner * 12, vertex[1]!, true);
      view.setFloat32(base + 20 + corner * 12, vertex[2]!, true);
    });
  });
  return buffer;
}

function writeStlAscii(): ArrayBuffer {
  const lines = ['solid cube'];
  for (const face of CUBE_FACES) {
    lines.push('  facet normal 0 0 0', '    outer loop');
    for (const vertexIndex of face) {
      const vertex = CUBE_VERTICES[vertexIndex]!;
      lines.push(`      vertex ${vertex[0]} ${vertex[1]} ${vertex[2]}`);
    }
    lines.push('    endloop', '  endfacet');
  }
  lines.push('endsolid cube');
  return new TextEncoder().encode(lines.join('\n')).buffer as ArrayBuffer;
}

function writePlyAscii(): ArrayBuffer {
  const lines = [
    'ply', 'format ascii 1.0', `element vertex ${CUBE_VERTICES.length}`,
    'property float x', 'property float y', 'property float z',
    'property uchar red', 'property uchar green', 'property uchar blue',
    `element face ${CUBE_FACES.length}`, 'property list uchar int vertex_indices', 'end_header',
  ];
  for (const [x, y, z] of CUBE_VERTICES) lines.push(`${x} ${y} ${z} 200 120 90`);
  for (const [a, b, c] of CUBE_FACES) lines.push(`3 ${a} ${b} ${c}`);
  return new TextEncoder().encode(lines.join('\n')).buffer as ArrayBuffer;
}

function writeOff(): ArrayBuffer {
  const lines = ['COFF', `${CUBE_VERTICES.length} ${CUBE_FACES.length} 0`];
  for (const [x, y, z] of CUBE_VERTICES) lines.push(`${x} ${y} ${z} 0.2 0.6 0.9 1`);
  for (const face of CUBE_FACES) lines.push(`3 ${face.join(' ')}`);
  return new TextEncoder().encode(lines.join('\n')).buffer as ArrayBuffer;
}

function chunk(id: number, payload: Buffer): Buffer {
  const head = Buffer.alloc(6);
  head.writeUInt16LE(id, 0);
  head.writeUInt32LE(payload.length + 6, 2);
  return Buffer.concat([head, payload]);
}

function write3ds(): ArrayBuffer {
  const name = Buffer.concat([Buffer.from('Cube\0', 'latin1')]);
  const vertexData = Buffer.alloc(2 + CUBE_VERTICES.length * 12);
  vertexData.writeUInt16LE(CUBE_VERTICES.length, 0);
  CUBE_VERTICES.forEach((vertex, index) => {
    vertexData.writeFloatLE(vertex[0]!, 2 + index * 12);
    vertexData.writeFloatLE(vertex[1]!, 6 + index * 12);
    vertexData.writeFloatLE(vertex[2]!, 10 + index * 12);
  });
  const faceData = Buffer.alloc(2 + CUBE_FACES.length * 8);
  faceData.writeUInt16LE(CUBE_FACES.length, 0);
  CUBE_FACES.forEach((face, index) => {
    faceData.writeUInt16LE(face[0]!, 2 + index * 8);
    faceData.writeUInt16LE(face[1]!, 4 + index * 8);
    faceData.writeUInt16LE(face[2]!, 6 + index * 8);
    faceData.writeUInt16LE(0, 8 + index * 8);
  });
  const mesh = chunk(0x4100, Buffer.concat([chunk(0x4110, vertexData), chunk(0x4120, faceData)]));
  const object = chunk(0x4000, Buffer.concat([name, mesh]));
  const editor = chunk(0x3d3d, object);
  const main = chunk(0x4d4d, editor);
  return main.buffer.slice(main.byteOffset, main.byteOffset + main.byteLength) as ArrayBuffer;
}

/** 3MF：zip（fflate）+ 3dmodel.model XML，单位按规范默认毫米。 */
function write3mf(): ArrayBuffer {
  const vertices = CUBE_VERTICES
    .map(([x, y, z]) => `<vertex x="${x}" y="${y}" z="${z}"/>`)
    .join('');
  const triangles = CUBE_FACES
    .map(([a, b, c]) => `<triangle v1="${a}" v2="${b}" v3="${c}"/>`)
    .join('');
  const model = `<?xml version="1.0" encoding="UTF-8"?>
<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">
 <resources><object id="1" type="model"><mesh>
  <vertices>${vertices}</vertices><triangles>${triangles}</triangles>
 </mesh></object></resources>
 <build><item objectid="1"/></build>
</model>`;
  const types = `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
 <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
 <Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>
</Types>`;
  const rels = `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
 <Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>
</Relationships>`;
  const zip = zipSync({
    '[Content_Types].xml': strToU8(types),
    '_rels/.rels': strToU8(rels),
    '3D/3dmodel.model': strToU8(model),
  });
  return zip.buffer.slice(zip.byteOffset, zip.byteOffset + zip.byteLength) as ArrayBuffer;
}

function writeDae(upAxis: 'Y_UP' | 'Z_UP' = 'Y_UP', meter = 1): ArrayBuffer {
  const positions = CUBE_VERTICES.flat().join(' ');
  const indices = CUBE_FACES.flat().join(' ');
  const text = `<?xml version="1.0" encoding="utf-8"?>
<COLLADA xmlns="http://www.collada.org/2005/11/COLLADASchema" version="1.4.1">
  <asset>
    <unit name="unit" meter="${meter}"/>
    <up_axis>${upAxis}</up_axis>
  </asset>
  <library_effects>
    <effect id="mat0-effect">
      <profile_COMMON><technique sid="common"><lambert><diffuse><color>0.7 0.75 0.8 1</color></diffuse></lambert></technique></profile_COMMON>
    </effect>
  </library_effects>
  <library_materials>
    <material id="mat0" name="mat0"><instance_effect url="#mat0-effect"/></material>
  </library_materials>
  <library_geometries>
    <geometry id="cube-mesh" name="Cube">
      <mesh>
        <source id="cube-positions">
          <float_array id="cube-positions-array" count="${CUBE_VERTICES.length * 3}">${positions}</float_array>
          <technique_common>
            <accessor source="#cube-positions-array" count="${CUBE_VERTICES.length}" stride="3">
              <param name="X" type="float"/><param name="Y" type="float"/><param name="Z" type="float"/>
            </accessor>
          </technique_common>
        </source>
        <vertices id="cube-vertices"><input semantic="POSITION" source="#cube-positions"/></vertices>
        <triangles material="mat0" count="${CUBE_FACES.length}">
          <input semantic="VERTEX" source="#cube-vertices" offset="0"/>
          <p>${indices}</p>
        </triangles>
      </mesh>
    </geometry>
  </library_geometries>
  <library_visual_scenes>
    <visual_scene id="Scene" name="Scene">
      <node id="Cube" name="Cube" type="NODE">
        <instance_geometry url="#cube-mesh">
          <bind_material><technique_common><instance_material symbol="mat0" target="#mat0"/></technique_common></bind_material>
        </instance_geometry>
      </node>
    </visual_scene>
  </library_visual_scenes>
  <scene><instance_visual_scene url="#Scene"/></scene>
</COLLADA>`;
  return new TextEncoder().encode(text).buffer as ArrayBuffer;
}

/** ASCII FBX：Tab 缩进 + PolygonVertexIndex 的「末顶点取反」约定。 */
function writeFbxAscii(): ArrayBuffer {
  const tab = '\t';
  const vertices = CUBE_VERTICES.flat().join(',');
  const polygonIndices = CUBE_FACES
    .map((face) => [face[0]!, face[1]!, -(face[2]! + 1)])
    .flat()
    .join(',');
  const text = `; FBX 7.4.0 project file
FBXHeaderExtension:  {
${tab}FBXHeaderVersion: 1003
${tab}FBXVersion: 7400
}
GlobalSettings:  {
${tab}Version: 1000
${tab}Properties70:  {
${tab}${tab}P: "UpAxis", "int", "Integer", "",1
${tab}${tab}P: "UnitScaleFactor", "double", "Number", "",100
${tab}}
}
Objects:  {
${tab}Geometry: 140, "Geometry::Cube", "Mesh" {
${tab}${tab}Vertices: *24 {
${tab}${tab}${tab}a: ${vertices}
${tab}${tab}}
${tab}${tab}PolygonVertexIndex: *36 {
${tab}${tab}${tab}a: ${polygonIndices}
${tab}${tab}}
${tab}${tab}GeometryVersion: 124
${tab}}
${tab}Model: 150, "Model::Cube", "Mesh" {
${tab}${tab}Version: 232
${tab}}
}
Connections:  {
${tab}C: "OO",150,0
${tab}C: "OO",140,150
}
`;
  return new TextEncoder().encode(text).buffer as ArrayBuffer;
}

function writeDxf(): ArrayBuffer {
  const pair = (code: number, value: string | number) => `${code}\n${value}`;
  const lines: string[] = [
    pair(0, 'SECTION'), pair(2, 'HEADER'), pair(9, '$INSUNITS'), pair(70, 6), pair(0, 'ENDSEC'),
    pair(0, 'SECTION'), pair(2, 'ENTITIES'),
  ];
  for (const face of CUBE_FACES) {
    lines.push(pair(0, '3DFACE'), pair(8, 'Wall'));
    face.forEach((vertexIndex, corner) => {
      const vertex = CUBE_VERTICES[vertexIndex]!;
      lines.push(pair(10 + corner, vertex[0]!), pair(20 + corner, vertex[1]!), pair(30 + corner, vertex[2]!));
    });
  }
  lines.push(pair(0, 'LINE'), pair(8, 'Axis'), pair(10, 0), pair(20, 0), pair(30, 0), pair(11, 1), pair(21, 0), pair(31, 0));
  lines.push(pair(0, 'ENDSEC'), pair(0, 'EOF'));
  return new TextEncoder().encode(lines.join('\n')).buffer as ArrayBuffer;
}

/* ---------------- 最小 CFB（OLE 复合文档）writer，用于造一个 .skp ---------------- */
const SECTOR = 512;
const FREESECT = 0xffffffff;
const ENDOFCHAIN = 0xfffffffe;

function writeSkp(): ArrayBuffer {
  const meta = Buffer.from(
    '<?xml version="1.0" encoding="UTF-8"?><meta><version>23.0.0</version>'
    + '<units>Inches</units><num_faces>12</num_faces></meta>',
    'utf8',
  );
  // 逻辑大小都撑到 4096，走常规 FAT（不碰 mini stream），容器仍然合法
  const streams = [
    { name: 'meta.dat', data: padTo(meta, 4096) },
    { name: 'model.dat', data: padTo(Buffer.from('proprietary geometry payload'), 4096) },
    { name: 'preview.png', data: padTo(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]), 4096) },
  ];

  const sectorCount = 2 + streams.reduce((sum, stream) => sum + stream.data.length / SECTOR, 0);
  const fatSectors = Math.ceil((sectorCount * 4) / SECTOR);
  const header = Buffer.alloc(SECTOR);
  Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]).copy(header, 0);
  header.writeUInt16LE(0x003e, 24);
  header.writeUInt16LE(0x0003, 26);
  header.writeUInt16LE(0xfffe, 28);
  header.writeUInt16LE(9, 30);
  header.writeUInt16LE(6, 32);
  header.writeUInt32LE(0, 40);
  header.writeUInt32LE(fatSectors, 44);
  header.writeUInt32LE(fatSectors, 48); // 目录紧跟在 FAT 之后
  header.writeUInt32LE(4096, 56);
  header.writeUInt32LE(ENDOFCHAIN, 60);
  header.writeUInt32LE(0, 64);
  header.writeUInt32LE(ENDOFCHAIN, 68);
  header.writeUInt32LE(0, 72);
  for (let i = 0; i < 109; i += 1) header.writeUInt32LE(i < fatSectors ? i : FREESECT, 76 + i * 4);

  const fat = Buffer.alloc(fatSectors * SECTOR, 0xff);
  for (let sector = 0; sector < fatSectors; sector += 1) fat.writeUInt32LE(ENDOFCHAIN, sector * 4 + 0 * 4);
  let cursor = fatSectors;
  const dirSector = cursor;
  cursor += 1;
  fat.writeUInt32LE(ENDOFCHAIN, dirSector * 4);
  const streamSectors: Array<{ start: number; count: number; size: number }> = [];
  for (const stream of streams) {
    const count = stream.data.length / SECTOR;
    for (let i = 0; i < count; i += 1) {
      fat.writeUInt32LE(i === count - 1 ? ENDOFCHAIN : cursor + i + 1, (cursor + i) * 4);
    }
    streamSectors.push({ start: cursor, count, size: stream.data.length });
    cursor += count;
  }

  const directory = Buffer.alloc(SECTOR);
  const writeEntry = (index: number, name: string, type: number, start: number, size: number) => {
    const offset = index * 128;
    const nameBuffer = Buffer.from(`${name}\0`, 'utf16le');
    nameBuffer.copy(directory, offset);
    directory.writeUInt16LE(nameBuffer.length, offset + 64);
    directory.writeUInt8(type, offset + 66);
    directory.writeUInt8(1, offset + 67); // black
    directory.writeUInt32LE(FREESECT, offset + 68);
    directory.writeUInt32LE(FREESECT, offset + 72);
    directory.writeUInt32LE(index + 1 < streams.length + 1 ? index + 1 : FREESECT, offset + 76);
    directory.writeUInt32LE(start, offset + 116);
    directory.writeUInt32LE(size, offset + 120);
  };
  writeEntry(0, 'Root Entry', 5, ENDOFCHAIN, 0);
  streams.forEach((stream, index) => {
    writeEntry(index + 1, stream.name, 2, streamSectors[index]!.start, streamSectors[index]!.size);
  });

  const parts = [header, fat, directory, ...streams.map((stream) => stream.data)];
  const output = Buffer.concat(parts);
  return output.buffer.slice(output.byteOffset, output.byteOffset + output.byteLength) as ArrayBuffer;
}

function padTo(buffer: Buffer, size: number): Buffer {
  const out = Buffer.alloc(size);
  buffer.copy(out, 0);
  return out;
}

/* ---------------- VFF 容器（65 字节 SketchUp 头 + ZIP）writer ---------------- */
/** meta.dat 的二进制 TLV：外层 'd' 容器，里面是 tag(u16) + len(u32) + value（无对齐填充）。 */
function buildMetaTlv(fields: Array<[string, string]>): Uint8Array {
  const chunks = fields.map(([tag, value]) => {
    const body = strToU8(value);
    const chunk = new Uint8Array(6 + body.length);
    const view = new DataView(chunk.buffer);
    view.setUint16(0, tag.charCodeAt(0), true);
    view.setUint32(2, body.length, true);
    chunk.set(body, 6);
    return chunk;
  });
  const inner = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0));
  let cursor = 0;
  for (const chunk of chunks) {
    inner.set(chunk, cursor);
    cursor += chunk.length;
  }
  const out = new Uint8Array(6 + inner.length);
  const view = new DataView(out.buffer);
  view.setUint16(0, 0x64, true);
  view.setUint32(2, inner.length, true);
  out.set(inner, 6);
  return out;
}

/** 真实的 VFF 头：UTF-16LE 的 "SketchUp Model" + "{版本}" + "VFF"，共 65 字节，之后接 ZIP。 */
function vffHeader(version: string): Uint8Array {
  const head = new Uint8Array(65);
  const write = (offset: number, text: string): void => {
    for (let i = 0; i < text.length; i += 1) {
      head[offset + i * 2] = text.charCodeAt(i) & 0xff;
      head[offset + i * 2 + 1] = (text.charCodeAt(i) >> 8) & 0xff;
    }
  };
  head.set([0xff, 0xfe, 0xff, 14], 0);
  write(4, 'SketchUp Model');
  head.set([0xff, 0xfe, 0xff, version.length + 2], 32);
  write(36, `{${version}}`);
  head.set(strToU8('VFF'), 52);
  head.set([8, 0, 1, 0, 8, 0, 0, 0, 0], 55);
  return head;
}

function writeSkpVff(): ArrayBuffer {
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
  const zip = zipSync({
    'meta/model_thumbnail.png': png,
    'meta/preview_thumbnail.png': png,
    'meta/meta.dat': buildMetaTlv([
      ['u', '26.2.0'],
      ['m', 'Centimeter'],
      ['o', 'C:/Renderbot/versions/0bf0655/temp/s17.skp'],
    ]),
    'materials/Layer0/material.xml': strToU8('<material name="Layer0"/>'),
    'materials/Layer0/tex.jpg': new Uint8Array([0xff, 0xd8, 0xff, 0xd9]),
    'model.dat': strToU8('proprietary geometry payload'),
  });
  const head = vffHeader('26.2.0');
  const out = new Uint8Array(head.length + zip.length);
  out.set(head, 0);
  out.set(zip, head.length);
  return out.buffer as ArrayBuffer;
}

/** 只有 ZIP、没有 SketchUp 头 → 必须明确拒绝，而不是当成 SKP 硬读。 */
function writePlainZipAsSkp(): ArrayBuffer {
  const zip = zipSync({ 'model.dat': strToU8('not a sketchup file') });
  return zip.buffer.slice(zip.byteOffset, zip.byteOffset + zip.byteLength) as ArrayBuffer;
}

/* ---------------- 断言 ---------------- */
function expectCube(model: ImportedModel, label: string, expectedTriangles = 12): void {
  check(`${label}：解析出部件`, model.parts.length > 0, `parts=${model.parts.length}`);
  check(`${label}：三角形数量 ${expectedTriangles}`, countImportTriangles(model) === expectedTriangles, `实际 ${countImportTriangles(model)}`);
  const unit = guessUnitMeters(model);
  const size = measureImport(model, { upAxis: model.upAxis, unitMeters: unit });
  const longest = Math.max(size.x, size.y, size.z);
  check(`${label}：轴向换算后仍在 2 m 量级`, Math.abs(longest - 2) < 0.01, `最长边 ${longest.toFixed(3)} m`);
  check(`${label}：三个方向尺寸一致`, Math.abs(size.x - size.y) < 1e-3 && Math.abs(size.y - size.z) < 1e-3, `${size.x.toFixed(2)}/${size.y.toFixed(2)}/${size.z.toFixed(2)}`);
  const geometry = buildImportGeometry(model, { upAxis: model.upAxis, unitMeters: unit });
  const position = geometry.getAttribute('position');
  const color = geometry.getAttribute('color');
  check(`${label}：合并后带顶点色`, Boolean(color) && color!.count === position.count);
  geometry.dispose();
}

async function run(name: string, data: ArrayBuffer): Promise<ImportedModel | undefined> {
  console.log(`\n▶ ${name}`);
  try {
    const model = await parseModelBuffer(name, data);
    console.log(`  格式：${model.formatLabel} · 部件 ${model.parts.length} · 三角面 ${countImportTriangles(model)} · up=${model.upAxis} · unit=${model.unitMeters ?? '未声明'}`);
    if (model.blocked) {
      console.log(`  阻止：${model.blocked.reason}`);
      console.log(`  步骤：${model.blocked.steps.join(' / ')}`);
    }
    if (model.notices.length) console.log(`  提示：${model.notices.join('；')}`);
    return model;
  } catch (error) {
    failures += 1;
    console.error(`  ✗ 解析失败：${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }
}

async function main(): Promise<void> {
  const cases: Array<[string, () => ArrayBuffer]> = [
    ['cube.obj', writeObj],
    ['cube.stl', writeStlBinary],
    ['ascii.stl', writeStlAscii],
    ['cube.ply', writePlyAscii],
    ['cube.off', writeOff],
    ['cube.3ds', write3ds],
    ['cube.dxf', writeDxf],
    ['cube.fbx', writeFbxAscii],
    ['cube.dae', () => writeDae('Y_UP', 1)],
  ];
  for (const [name, writer] of cases) {
    const model = await run(name, writer());
    if (model?.parts) expectCube(model, name);
  }

  // openCASCADE 与 glTF 用真实样例：下载的凉亭（38 节点 / 9364 面）
  console.log('\n▶ pavilion.glb（真实样例）');
  try {
    const { readFileSync } = await import('node:fs');
    const buffer = readFileSync('downloads/pavilion-ref/pavilion.glb');
    const data = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer;
    const model = await parseModelBuffer('pavilion.glb', data);
    check('glb：节点数 38', model.parts.length === 38, `实际 ${model.parts.length}`);
    check('glb：三角面 9364', countImportTriangles(model) === 9364, `实际 ${countImportTriangles(model)}`);
    check('glb：声明 Y-up / 米', model.upAxis === 'y' && model.unitMeters === 1);
    const size = measureImport(model, { upAxis: model.upAxis, unitMeters: 1 });
    console.log(`  导入后尺寸：${size.x.toFixed(2)} × ${size.y.toFixed(2)} × ${size.z.toFixed(2)} m`);
    check('glb：高度落在 Z 轴（Y-up 已转 Z-up）', Math.abs(size.z - 6.74) < 0.2, `Z=${size.z.toFixed(2)}`);
  } catch (error) {
    failures += 1;
    console.error(`  ✗ glb：${error instanceof Error ? error.message : String(error)}`);
  }

  // SKP：容器可读、几何被明确拒绝、元信息与预览能取出来
  console.log('\n▶ cube.skp（最小 CFB 容器）');
  try {
    const model = await parseModelBuffer('cube.skp', writeSkp());
    check('skp：识别为容器并给出阻止原因', Boolean(model.blocked));
    check('skp：读到版本号', model.notices.some((notice) => notice.includes('23.0.0')), model.notices.join('；'));
    check('skp：读到单位', model.notices.some((notice) => notice.includes('Inches')));
    check('skp：提取到预览图', Boolean(model.previewDataUrl?.startsWith('data:image/png')));
    check('skp：列出内部流', (model.details?.length ?? 0) === 3, JSON.stringify(model.details));
    check('skp：不产生几何', model.parts.length === 0);
    check('skp：英寸单位已识别', model.unitMeters === 0.0254);
  } catch (error) {
    failures += 1;
    console.error(`  ✗ skp：${error instanceof Error ? error.message : String(error)}`);
  }

  // VFF 容器（65 字节头 + ZIP）：这是 Trimble 在线服务 / 渲染服务产出的 .skp，
  // 以前会被判成「不是 SketchUp 文件」，是真实的导入失败来源
  console.log('\n▶ vff.skp（65 字节头 + ZIP 容器）');
  try {
    const model = await parseModelBuffer('vff.skp', writeSkpVff());
    check('vff-skp：不再报错，走「容器可读 + 几何受阻」路径', Boolean(model.blocked));
    check('vff-skp：认出 ZIP 容器', model.blocked!.reason.includes('VFF'), model.blocked!.reason.slice(0, 60));
    check('vff-skp：读到 TLV 版本号', model.notices.some((notice) => notice.includes('26.2.0')), model.notices.join('；'));
    check('vff-skp：读到单位 Centimeter', model.notices.some((notice) => notice.includes('Centimeter')));
    check('vff-skp：厘米换算正确', model.unitMeters === 0.01, String(model.unitMeters));
    check('vff-skp：提取到预览图', Boolean(model.previewDataUrl?.startsWith('data:image/png')));
    check('vff-skp：列出条目（含 model.dat）', (model.details ?? []).some((item) => item.includes('model.dat')));
    check('vff-skp：统计到材质', model.notices.some((notice) => notice.includes('材质 1 个')));
    check('vff-skp：记录原始路径', (model.details ?? []).some((item) => item.includes('Renderbot')));
    check('vff-skp：不产生几何', model.parts.length === 0);
  } catch (error) {
    failures += 1;
    console.error(`  ✗ vff-skp：${error instanceof Error ? error.message : String(error)}`);
  }

  console.log('\n▶ plain.skp（只有 ZIP，没有 SketchUp 头）');
  try {
    await parseModelBuffer('plain.skp', writePlainZipAsSkp());
    check('改名的 ZIP：应当被拒绝', false);
  } catch (error) {
    check('改名的 ZIP：明确报「不是 SketchUp 文件」', error instanceof Error && error.message.includes('不是 SketchUp 文件'));
  }

  console.log('\n▶ cube.3mf（毫米）');
  try {
    const model = await parseModelBuffer('cube.3mf', write3mf());
    check('3mf：12 个三角面', countImportTriangles(model) === 12, String(countImportTriangles(model)));
    check('3mf：按规范默认毫米', model.unitMeters === 0.001, String(model.unitMeters));
    const size = measureImport(model, { upAxis: model.upAxis, unitMeters: model.unitMeters! });
    check('3mf：2 mm 立方体换算后 0.002 m', Math.abs(size.x - 0.002) < 1e-9, `${size.x}`);
  } catch (error) {
    failures += 1;
    console.error(`  ✗ 3mf：${error instanceof Error ? error.message : String(error)}`);
  }

  // DAE 的 <unit meter> 要能读出来（SketchUp 导出的 DAE 靠它才能对上尺寸）
  console.log('\n▶ units.dae（厘米）');
  try {
    const model = await parseModelBuffer('units.dae', writeDae('Z_UP', 0.01));
    // ColladaLoader 已经把 unit / up_axis 烘焙进 scene，交付时统一是「米 + Y-up」
    check('dae：单位与轴向已由解析器归一', model.unitMeters === 1 && model.upAxis === 'y');
    check('dae：读到 <unit meter=\"0.01\">', model.notices.some((notice) => notice.includes('0.01')), model.notices.join('；'));
    check('dae：读到 <up_axis>Z_UP</up_axis>', model.notices.some((notice) => notice.includes('Z 向上')));
    const size = measureImport(model, { upAxis: model.upAxis, unitMeters: model.unitMeters! });
    check('dae：2 cm 立方体换算后 0.02 m', Math.abs(size.x - 0.02) < 1e-6, `${size.x}`);
  } catch (error) {
    failures += 1;
    console.error(`  ✗ dae 单位：${error instanceof Error ? error.message : String(error)}`);
  }

  console.log(`\n${failures === 0 ? '全部通过' : `${failures} 项失败`}`);
  if (failures) process.exitCode = 1;
}

void main();
