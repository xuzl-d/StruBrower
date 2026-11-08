/**
 * 无 WebGL 的离屏预览渲染器（仅供 scripts 里的造型实验用）。
 *
 * 目的：造型内核（buildSolidModel）是纯 CPU 几何计算，不需要浏览器就能求值；
 * 但「看看它长什么样」需要一个能跑的渲染器。这里用 z-buffer 软光栅 + 透视投影，
 * 按 geometry.groups 的材质槽上色，输出 PNG（自带极简 PNG 编码，不引第三方依赖）。
 *
 * 不做：阴影、抗锯齿（用 2× 超采样代替）、透明混合（玻璃按不透明处理）。
 */
import fs from 'node:fs';
import zlib from 'node:zlib';
import { Box3, BufferGeometry, Matrix4, Sphere, Vector3 } from 'three';
import type { SolidMaterial } from '../../src/bim/types';

export interface RasterView {
  name: string;
  /** 方位角（度）：0 = 从 +X（机头）方向看，90 = 从 +Y 看 */
  azimuth: number;
  /** 仰角（度）：0 = 水平，90 = 俯视 */
  elevation: number;
  /** 取景倍数，1 = 刚好装下 */
  zoom?: number;
  /** 取景中心（世界坐标），缺省用包围盒中心 */
  focus?: [number, number, number];
  /** 聚焦时的取景半径（米） */
  radius?: number;
}

export interface RasterOptions {
  width: number;
  height: number;
  /** 超采样倍率，默认 2 */
  ss?: number;
  /** 天空渐变（上、下） */
  sky?: [string, string];
  /** 视图网格列数 */
  columns?: number;
  /** 贴花文字覆盖层（预览里没有 canvas，用内置点阵字体近似） */
  decals?: RasterDecal[];
}

/**
 * 预览用的贴花：给四个角（顺序：左上、右上、右下、左下）与文字。
 * 真机上文字由视口用 canvas 渲染，这里只为了在离屏预览里也能看出贴没贴对位置。
 */
export interface RasterDecal {
  corners: Array<[number, number, number]>;
  text: string;
  color?: string;
}

/** 5×7 点阵字体，只收涂装常用字符（其余字符画成实心块，方便发现拼错） */
const GLYPHS: Record<string, number[]> = {
  ' ': [0, 0, 0, 0, 0, 0, 0],
  A: [0b01110, 0b10001, 0b10001, 0b11111, 0b10001, 0b10001, 0b10001],
  B: [0b11110, 0b10001, 0b10001, 0b11110, 0b10001, 0b10001, 0b11110],
  I: [0b11111, 0b00100, 0b00100, 0b00100, 0b00100, 0b00100, 0b11111],
  R: [0b11110, 0b10001, 0b10001, 0b11110, 0b10100, 0b10010, 0b10001],
  S: [0b01111, 0b10000, 0b10000, 0b01110, 0b00001, 0b00001, 0b11110],
  U: [0b10001, 0b10001, 0b10001, 0b10001, 0b10001, 0b10001, 0b01110],
  W: [0b10001, 0b10001, 0b10001, 0b10101, 0b10101, 0b11011, 0b10001],
  X: [0b10001, 0b10001, 0b01010, 0b00100, 0b01010, 0b10001, 0b10001],
  '0': [0b01110, 0b10001, 0b10011, 0b10101, 0b11001, 0b10001, 0b01110],
  '3': [0b11110, 0b00001, 0b00001, 0b01110, 0b00001, 0b00001, 0b11110],
  '5': [0b11111, 0b10000, 0b10000, 0b11110, 0b00001, 0b00001, 0b11110],
};

/** 点阵取样：u/v ∈ [0,1]，返回该点是否落在字里 */
function glyphAt(text: string, u: number, v: number): boolean {
  const cols = text.length * 6 - 1;
  const col = Math.floor(u * cols);
  const row = Math.floor(v * 7);
  if (col < 0 || row < 0 || row > 6) return false;
  const char = text[Math.floor(col / 6)] ?? ' ';
  const bit = col % 6;
  if (bit === 5) return false;
  const glyph = GLYPHS[char.toUpperCase()] ?? [0b11111, 0b11111, 0b11111, 0b11111, 0b11111, 0b11111, 0b11111];
  return ((glyph[row]! >> (4 - bit)) & 1) === 1;
}

type Rgb = [number, number, number];

interface Tri {
  p: [Vector3, Vector3, Vector3];
  n: [Vector3, Vector3, Vector3];
  color: Rgb;
}

function hexToRgb(hex: string): Rgb {
  const value = hex.replace('#', '');
  const full = value.length === 3 ? value.split('').map((c) => c + c).join('') : value;
  return [
    parseInt(full.slice(0, 2), 16) / 255,
    parseInt(full.slice(2, 4), 16) / 255,
    parseInt(full.slice(4, 6), 16) / 255,
  ];
}

/* ---------- PNG 编码（RGB8，无滤波） ---------- */

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    table[index] = value;
  }
  return table;
})();

function crc32(buffer: Buffer): number {
  let crc = -1;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ -1) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(4);
  head.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([head, body, crc]);
}

export function encodePng(width: number, height: number, rgb: Buffer): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 2; // truecolor
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (width * 3 + 1)] = 0;
    rgb.copy(raw, y * (width * 3 + 1) + 1, y * width * 3, (y + 1) * width * 3);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ---------- 三角形提取（按材质分组上色） ---------- */

function collectTriangles(geometry: BufferGeometry, materials: Array<SolidMaterial | null>): Tri[] {
  const position = geometry.getAttribute('position');
  const normal = geometry.getAttribute('normal');
  const index = geometry.index;
  const count = index ? index.count : position.count;
  const at = (i: number) => (index ? index.getX(i) : i);
  const groups = geometry.groups.length
    ? geometry.groups
    : [{ start: 0, count, materialIndex: 0 }];

  const tri: Tri[] = [];
  const v = [new Vector3(), new Vector3(), new Vector3()];
  const n = [new Vector3(), new Vector3(), new Vector3()];
  for (const group of groups) {
    const material = materials[group.materialIndex] ?? null;
    const color = hexToRgb(material?.color ?? '#d5dbe2');
    const end = Math.min(count, group.start + group.count);
    for (let i = group.start; i + 2 < end; i += 3) {
      for (let k = 0; k < 3; k += 1) {
        const vi = at(i + k);
        v[k].set(position.getX(vi), position.getY(vi), position.getZ(vi));
        if (normal) n[k].set(normal.getX(vi), normal.getY(vi), normal.getZ(vi));
        else n[k].set(0, 0, 0);
      }
      if (!normal) {
        const face = new Vector3().subVectors(v[1], v[0]).cross(new Vector3().subVectors(v[2], v[0])).normalize();
        n[0].copy(face);
        n[1].copy(face);
        n[2].copy(face);
      }
      tri.push({
        p: [v[0].clone(), v[1].clone(), v[2].clone()],
        n: [n[0].clone(), n[1].clone(), n[2].clone()],
        color,
      });
    }
  }
  return tri;
}

/* ---------- 光栅化 ---------- */

interface Frame {
  width: number;
  height: number;
  rgb: Buffer;
}

function renderOne(
  tris: Tri[],
  box: Box3,
  view: RasterView,
  width: number,
  height: number,
  ss: number,
  sky: [string, string],
  decals: RasterDecal[] = [],
): Frame {
  const [skyTop, skyBottom] = [hexToRgb(sky[0]), hexToRgb(sky[1])];
  const pw = width * ss;
  const ph = height * ss;
  const color = new Float32Array(pw * ph * 3);
  const depth = new Float32Array(pw * ph).fill(Infinity);

  for (let y = 0; y < ph; y += 1) {
    const t = y / (ph - 1);
    for (let x = 0; x < pw; x += 1) {
      const index = (y * pw + x) * 3;
      color[index] = skyTop[0] + (skyBottom[0] - skyTop[0]) * t;
      color[index + 1] = skyTop[1] + (skyBottom[1] - skyTop[1]) * t;
      color[index + 2] = skyTop[2] + (skyBottom[2] - skyTop[2]) * t;
    }
  }

  const center = view.focus ? new Vector3(...view.focus) : box.getCenter(new Vector3());
  const sphere = box.getBoundingSphere(new Sphere());
  const radius = Math.max(0.5, view.radius ?? sphere.radius);
  const fov = (32 * Math.PI) / 180;
  const zoom = view.zoom ?? 1;
  const distance = (radius / Math.sin(fov / 2)) * 1.02 / zoom;

  const az = (view.azimuth * Math.PI) / 180;
  const el = (view.elevation * Math.PI) / 180;
  const dir = new Vector3(Math.cos(el) * Math.cos(az), Math.cos(el) * Math.sin(az), Math.sin(el));
  const eye = center.clone().addScaledVector(dir, distance);
  // Matrix4.lookAt 只给旋转（相机 → 世界），补上位置再求逆才是世界 → 相机
  const viewMatrix = new Matrix4().lookAt(eye, center, new Vector3(0, 0, 1));
  viewMatrix.setPosition(eye);
  viewMatrix.invert();

  const aspect = width / height;
  const f = 1 / Math.tan(fov / 2);
  const key = new Vector3(0.45, -0.55, 0.7).normalize();
  const fill = new Vector3(-0.7, 0.45, 0.15).normalize();

  const a = new Vector3();
  const b = new Vector3();
  const c = new Vector3();
  const na = new Vector3();
  const nb = new Vector3();
  const nc = new Vector3();

  const project = (source: Vector3, target: Vector3) => {
    target.copy(source).applyMatrix4(viewMatrix);
  };

  for (const tri of tris) {
    project(tri.p[0], a);
    project(tri.p[1], b);
    project(tri.p[2], c);
    if (a.z > -0.05 || b.z > -0.05 || c.z > -0.05) continue;

    na.copy(tri.n[0]).transformDirection(viewMatrix);
    nb.copy(tri.n[1]).transformDirection(viewMatrix);
    nc.copy(tri.n[2]).transformDirection(viewMatrix);

    const ax = ((a.x * f) / aspect / -a.z * 0.5 + 0.5) * pw;
    const ay = (0.5 - (a.y * f) / -a.z * 0.5) * ph;
    const bx = ((b.x * f) / aspect / -b.z * 0.5 + 0.5) * pw;
    const by = (0.5 - (b.y * f) / -b.z * 0.5) * ph;
    const cx = ((c.x * f) / aspect / -c.z * 0.5 + 0.5) * pw;
    const cy = (0.5 - (c.y * f) / -c.z * 0.5) * ph;

    const minX = Math.max(0, Math.floor(Math.min(ax, bx, cx)));
    const maxX = Math.min(pw - 1, Math.ceil(Math.max(ax, bx, cx)));
    const minY = Math.max(0, Math.floor(Math.min(ay, by, cy)));
    const maxY = Math.min(ph - 1, Math.ceil(Math.max(ay, by, cy)));
    if (minX > maxX || minY > maxY) continue;

    const area = (bx - ax) * (cy - ay) - (cx - ax) * (by - ay);
    if (Math.abs(area) < 1e-9) continue;
    const inv = 1 / area;

    for (let y = minY; y <= maxY; y += 1) {
      const py = y + 0.5;
      for (let x = minX; x <= maxX; x += 1) {
        const px = x + 0.5;
        let w0 = ((bx - px) * (cy - py) - (cx - px) * (by - py)) * inv;
        let w1 = ((cx - px) * (ay - py) - (ax - px) * (cy - py)) * inv;
        let w2 = 1 - w0 - w1;
        if (w0 < -1e-6 || w1 < -1e-6 || w2 < -1e-6) continue;
        w0 = Math.max(0, w0);
        w1 = Math.max(0, w1);
        w2 = Math.max(0, w2);

        // 透视校正：屏幕空间重心 → 视空间深度的倒数插值
        const invZ = w0 / -a.z + w1 / -b.z + w2 / -c.z;
        if (invZ <= 0) continue;
        const z = 1 / invZ;
        const offset = y * pw + x;
        if (z >= depth[offset]) continue;
        depth[offset] = z;

        const nx = na.x * w0 + nb.x * w1 + nc.x * w2;
        const ny = na.y * w0 + nb.y * w1 + nc.y * w2;
        const nz = na.z * w0 + nb.z * w1 + nc.z * w2;
        const length = Math.hypot(nx, ny, nz) || 1;
        const dotKey = Math.max(0, (nx * key.x + ny * key.y + nz * key.z) / length);
        const dotFill = Math.max(0, (nx * fill.x + ny * fill.y + nz * fill.z) / length);
        const shade = 0.34 + 0.72 * dotKey + 0.16 * dotFill;

        const index = offset * 3;
        color[index] = tri.color[0] * shade;
        color[index + 1] = tri.color[1] * shade;
        color[index + 2] = tri.color[2] * shade;
      }
    }
  }

  /* 贴花：把四边形反投影成 uv，用点阵字体直接画进颜色缓冲 */
  if (decals.length) {
    const projectPoint = (world: [number, number, number]): [number, number] | null => {
      const view = new Vector3(world[0], world[1], world[2]).applyMatrix4(viewMatrix);
      if (view.z > -0.05) return null;
      return [
        ((view.x * f) / aspect / -view.z * 0.5 + 0.5) * pw,
        (0.5 - (view.y * f) / -view.z * 0.5) * ph,
      ];
    };
    for (const decal of decals) {
      // 背对镜头的贴花直接跳过（另一侧的那张），否则会隔着机身画上来
      const [c0, c1, c2] = decal.corners;
      const ux = c1[0] - c0[0], uy = c1[1] - c0[1], uz = c1[2] - c0[2];
      const vx = c2[0] - c0[0], vy = c2[1] - c0[1], vz = c2[2] - c0[2];
      const nx = uy * vz - uz * vy;
      const ny = uz * vx - ux * vz;
      const nz = ux * vy - uy * vx;
      const facing = nx * (eye.x - c0[0]) + ny * (eye.y - c0[1]) + nz * (eye.z - c0[2]);
      if (facing >= 0) continue;
      const corners = decal.corners.slice(0, 3).map(projectPoint);
      if (corners.some((corner) => !corner)) continue;
      const [tl, tr, bl] = corners as Array<[number, number]>;
      const ax = tr[0] - tl[0];
      const ay = tr[1] - tl[1];
      const bx = bl[0] - tl[0];
      const by = bl[1] - tl[1];
      const det = ax * by - ay * bx;
      if (Math.abs(det) < 1e-6) continue;
      const ink = hexToRgb(decal.color ?? '#ffffff');
      const minX = Math.max(0, Math.floor(Math.min(tl[0], tr[0], bl[0])));
      const maxX = Math.min(pw - 1, Math.ceil(Math.max(tl[0], tr[0], bl[0])));
      const minY = Math.max(0, Math.floor(Math.min(tl[1], tr[1], bl[1])));
      const maxY = Math.min(ph - 1, Math.ceil(Math.max(tl[1], tr[1], bl[1])));
      for (let y = minY; y <= maxY; y += 1) {
        for (let x = minX; x <= maxX; x += 1) {
          const dx = x + 0.5 - tl[0];
          const dy = y + 0.5 - tl[1];
          const u = (dx * by - dy * bx) / det;
          const v = (dy * ax - dx * ay) / det;
          if (u < 0 || u > 1 || v < 0 || v > 1) continue;
          if (!glyphAt(decal.text, u, v)) continue;
          const index = (y * pw + x) * 3;
          color[index] = ink[0];
          color[index + 1] = ink[1];
          color[index + 2] = ink[2];
        }
      }
    }
  }

  const rgb = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      let r = 0;
      let g = 0;
      let bl = 0;
      for (let sy = 0; sy < ss; sy += 1) {
        for (let sx = 0; sx < ss; sx += 1) {
          const index = ((y * ss + sy) * pw + (x * ss + sx)) * 3;
          r += color[index];
          g += color[index + 1];
          bl += color[index + 2];
        }
      }
      const total = ss * ss;
      const out = (y * width + x) * 3;
      rgb[out] = Math.min(255, Math.round((r / total) * 255));
      rgb[out + 1] = Math.min(255, Math.round((g / total) * 255));
      rgb[out + 2] = Math.min(255, Math.round((bl / total) * 255));
    }
  }
  return { width, height, rgb };
}

/** 把多张图拼成一张（网格），便于一次看完多个视角 */
export function renderSheet(
  geometry: BufferGeometry,
  materials: Array<SolidMaterial | null>,
  views: RasterView[],
  outPath: string,
  options: RasterOptions,
): void {
  geometry.computeBoundingBox();
  const box = geometry.boundingBox ?? new Box3();
  const tris = collectTriangles(geometry, materials);
  const { width, height, ss = 2, sky = ['#4f89c4', '#dbe9f6'], columns = 2, decals = [] } = options;
  const rows = Math.ceil(views.length / columns);
  const sheet = Buffer.alloc(width * columns * height * rows * 3, 0x20);

  views.forEach((view, order) => {
    const frame = renderOne(tris, box, view, width, height, ss, sky, decals);
    const column = order % columns;
    const row = Math.floor(order / columns);
    for (let y = 0; y < height; y += 1) {
      const target = ((row * height + y) * width * columns + column * width) * 3;
      frame.rgb.copy(sheet, target, y * width * 3, (y + 1) * width * 3);
    }
  });

  fs.writeFileSync(outPath, encodePng(width * columns, height * rows, sheet));
}
