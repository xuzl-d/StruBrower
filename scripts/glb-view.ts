/**
 * 看外部下载的 GLB：解析（不依赖 loader/WebGL）→ 统计 → 离线出图。
 *
 * 为什么要手写解析：GLTFLoader 在 Node 里要 DOM 与贴图解码，而我们只想看
 * 「节点怎么分、面有多少、材质几个、尺寸多大」以及几张软光栅预览。
 *
 * 运行：npx esbuild scripts/glb-view.ts --bundle --platform=node --format=esm \
 *        --outfile=.tmp/glb-view.mjs --log-level=warning && node .tmp/glb-view.mjs <file.glb> <out.png>
 */
import fs from 'node:fs';
import { Box3, BufferAttribute, BufferGeometry, Matrix4, Quaternion, Vector3 } from 'three';
import { renderSheet } from './lib/mini-render';

interface Gltf {
  asset?: { generator?: string; version?: string };
  scenes?: Array<{ nodes?: number[] }>;
  scene?: number;
  nodes?: Array<{
    name?: string; mesh?: number; children?: number[];
    matrix?: number[]; translation?: number[]; rotation?: number[]; scale?: number[];
  }>;
  meshes?: Array<{ name?: string; primitives: Array<{ attributes: Record<string, number>; indices?: number; material?: number; mode?: number }> }>;
  accessors?: Array<{ bufferView?: number; byteOffset?: number; componentType: number; count: number; type: string; normalized?: boolean; min?: number[]; max?: number[] }>;
  bufferViews?: Array<{ buffer: number; byteOffset?: number; byteLength: number; byteStride?: number }>;
  materials?: Array<{ name?: string; pbrMetallicRoughness?: { baseColorFactor?: number[]; metallicFactor?: number; roughnessFactor?: number }; doubleSided?: boolean }>;
  textures?: unknown[];
  images?: Array<{ name?: string; mimeType?: string }>;
}

function parseGlb(path: string): { json: Gltf; bin: Buffer } {
  const buf = fs.readFileSync(path);
  const magic = buf.readUInt32LE(0);
  if (magic !== 0x46546c67) throw new Error('不是 GLB（magic 不对）');
  let offset = 12;
  let json: Gltf | null = null;
  let bin = Buffer.alloc(0);
  while (offset < buf.length) {
    const length = buf.readUInt32LE(offset);
    const type = buf.readUInt32LE(offset + 4);
    const body = buf.subarray(offset + 8, offset + 8 + length);
    if (type === 0x4e4f534a) json = JSON.parse(body.toString('utf8')) as Gltf;
    if (type === 0x004e4942) bin = body;
    offset += 8 + length + ((4 - (length % 4)) % 4);
  }
  if (!json) throw new Error('GLB 里没有 JSON chunk');
  return { json, bin };
}

const COMPONENTS: Record<number, { size: number; read: (b: Buffer, o: number) => number }> = {
  5120: { size: 1, read: (b, o) => b.readInt8(o) },
  5121: { size: 1, read: (b, o) => b.readUInt8(o) },
  5122: { size: 2, read: (b, o) => b.readInt16LE(o) },
  5123: { size: 2, read: (b, o) => b.readUInt16LE(o) },
  5125: { size: 4, read: (b, o) => b.readUInt32LE(o) },
  5126: { size: 4, read: (b, o) => b.readFloatLE(o) },
};

const WIDTH: Record<string, number> = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };

function readAccessor(gltf: Gltf, bin: Buffer, index: number): Float64Array {
  const accessor = gltf.accessors![index]!;
  const view = gltf.bufferViews![accessor.bufferView ?? 0]!;
  const comp = COMPONENTS[accessor.componentType]!;
  const width = WIDTH[accessor.type]!;
  const base = (view.byteOffset ?? 0) + (accessor.byteOffset ?? 0);
  const stride = view.byteStride ?? comp.size * width;
  const out = new Float64Array(accessor.count * width);
  for (let i = 0; i < accessor.count; i += 1) {
    for (let c = 0; c < width; c += 1) {
      out[i * width + c] = comp.read(bin, base + i * stride + c * comp.size);
    }
  }
  return out;
}

function hexOf(color: number[] | undefined, fallback: string): string {
  if (!color) return fallback;
  const rgb = color.slice(0, 3).map((value) => Math.round(Math.min(1, Math.max(0, value)) * 255));
  return `#${rgb.map((v) => v.toString(16).padStart(2, '0')).join('')}`;
}

function main() {
  const [file, out] = [process.argv[2], process.argv[3] ?? '/tmp/glb.png'];
  if (!file) throw new Error('用法：node .tmp/glb-view.mjs <file.glb> [out.png]');
  const { json: gltf, bin } = parseGlb(file);

  /* ---------- 遍历节点，把每个 mesh 的三角形按材质归组 ---------- */
  const positions: number[] = [];
  const normals: number[] = [];
  const groups: Array<{ start: number; count: number; materialIndex: number }> = [];
  const materials: Array<{ color: string } | null> = [];
  const materialIndex = new Map<number, number>();
  const slotOf = (index: number | undefined) => {
    const key = index ?? -1;
    if (materialIndex.has(key)) return materialIndex.get(key)!;
    const color = hexOf(key >= 0 ? gltf.materials?.[key]?.pbrMetallicRoughness?.baseColorFactor : undefined, '#c8ccd2');
    const slot = materials.length;
    materials.push({ color });
    materialIndex.set(key, slot);
    return slot;
  };

  const nodeCount = gltf.nodes?.length ?? 0;
  const rows: Array<{ name: string; mesh: string; tris: number; color: string; size: Vector3 }> = [];
  let meshInstances = 0;

  const visit = (nodeIndex: number, parent: Matrix4) => {
    const node = gltf.nodes![nodeIndex]!;
    const local = new Matrix4();
    if (node.matrix) local.fromArray(node.matrix);
    else {
      local.compose(
        new Vector3(...(node.translation ?? [0, 0, 0])),
        new Quaternion(...((node.rotation ?? [0, 0, 0, 1]) as [number, number, number, number])),
        new Vector3(...(node.scale ?? [1, 1, 1])),
      );
    }
    const world = parent.clone().multiply(local);
    if (node.mesh !== undefined) {
      meshInstances += 1;
      const mesh = gltf.meshes![node.mesh]!;
      for (const primitive of mesh.primitives) {
        const mode = primitive.mode ?? 4;
        if (mode !== 4) continue; // 只处理三角形
        const pos = readAccessor(gltf, bin, primitive.attributes.POSITION!);
        const nor = primitive.attributes.NORMAL !== undefined ? readAccessor(gltf, bin, primitive.attributes.NORMAL!) : null;
        const idx = primitive.indices !== undefined ? readAccessor(gltf, bin, primitive.indices) : null;
        const count = idx ? idx.length : pos.length / 3;
        const slot = slotOf(primitive.material);
        const start = positions.length / 3;
        const v = new Vector3();
        const n = new Vector3();
        const normalMatrix = new Matrix4().copy(world).invert().transpose();
        // 顶点先用世界矩阵变换；法向用逆转置（会有非均匀缩放）
        const tri = [0, 0, 0];
        for (let i = 0; i < count; i += 1) {
          const vi = idx ? idx[i]! : i;
          v.set(pos[vi * 3]!, pos[vi * 3 + 1]!, pos[vi * 3 + 2]!).applyMatrix4(world);
          positions.push(v.x, v.y, v.z);
          if (nor) {
            n.set(nor[vi * 3]!, nor[vi * 3 + 1]!, nor[vi * 3 + 2]!).transformDirection(normalMatrix).normalize();
            normals.push(n.x, n.y, n.z);
          }
          tri[i % 3] = 0;
          if (i % 3 === 2) {
            // 每三个顶点记一个三角（法向缺失时软光栅会自己算面法向）
          }
        }
        groups.push({ start, count, materialIndex: slot });
        rows.push({
          name: node.name ?? `node${nodeIndex}`,
          mesh: mesh.name ?? `mesh${node.mesh}`,
          tris: count / 3,
          color: materials[slot]?.color ?? '#ccc',
          size: new Vector3(),
        });
        void tri;
      }
    }
    for (const child of node.children ?? []) visit(child, world);
  };

  // glTF 是 Y-up，本项目（和离屏渲染器）是 Z-up：先把整棵场景绕 X 转 +90°，
  // 不然模型是躺着的（Y 当成了进深）。
  const identity = new Matrix4().makeRotationX(Math.PI / 2);
  const scene = gltf.scenes?.[gltf.scene ?? 0];
  for (const nodeIndex of scene?.nodes ?? []) visit(nodeIndex, identity);

  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(new Float32Array(positions), 3));
  if (normals.length) geometry.setAttribute('normal', new BufferAttribute(new Float32Array(normals), 3));
  for (const group of groups) geometry.addGroup(group.start, group.count, group.materialIndex);
  geometry.computeBoundingBox();
  const box = geometry.boundingBox ?? new Box3();
  const size = box.getSize(new Vector3());

  const totalTris = positions.length / 9;
  console.log(`文件        ${file}  ${(fs.statSync(file).size / 1024 / 1024).toFixed(2)} MB`);
  console.log(`生成器      ${gltf.asset?.generator ?? '（未标注）'}`);
  console.log(`节点 / 网格  ${nodeCount} 个节点，${meshInstances} 个网格实例，${gltf.meshes?.length ?? 0} 个 mesh`);
  console.log(`三角面      ${totalTris.toFixed(0)}`);
  console.log(`材质        ${materials.length} 个：${materials.map((m) => m?.color).join(' ')}`);
  console.log(`贴图        ${gltf.images?.length ?? 0} 张图片，纹理槽 ${gltf.textures?.length ?? 0}`);
  console.log(`包围盒      ${size.x.toFixed(2)} × ${size.y.toFixed(2)} × ${size.z.toFixed(2)}`);
  console.log(`Z 范围      ${box.min.z.toFixed(2)} → ${box.max.z.toFixed(2)}`);
  console.log('节点树：');
  const printTree = (nodeIndex: number, depth: number) => {
    const node = gltf.nodes![nodeIndex]!;
    const mesh = node.mesh !== undefined ? gltf.meshes![node.mesh]! : null;
    const tris = mesh ? mesh.primitives.reduce((sum, p) => sum + (gltf.accessors![p.indices ?? p.attributes.POSITION!]!.count / 3), 0) : 0;
    console.log(`  ${'  '.repeat(depth)}- ${node.name ?? '(未命名)'}${mesh ? `  [mesh ${tris.toFixed(0)} 面]` : ''}`);
    for (const child of node.children ?? []) printTree(child, depth + 1);
  };
  for (const nodeIndex of scene?.nodes ?? []) printTree(nodeIndex, 1);

  const center = box.getCenter(new Vector3());
  fs.mkdirSync('diagnostics/download', { recursive: true });
  const strip = process.argv.includes('--strip');
  const views = [
    { name: 'front', azimuth: -90, elevation: 8 },
    { name: 'three-quarter', azimuth: -40, elevation: 16 },
    { name: 'corner', azimuth: 20, elevation: 10 },
  ];
  renderSheet(
    geometry,
    materials as never,
    strip ? views : [
      ...views,
      { name: 'top', azimuth: -60, elevation: 55, focus: [center.x, center.y, center.z], radius: Math.max(size.x, size.y) * 0.7 },
    ],
    out,
    { width: 640, height: 480, columns: strip ? 1 : 2, sky: ['#2a3f57', '#c9d6e3'] },
  );
  console.log(`\n出图        ${out}`);
}

main();
