/**
 * 程序化纹理生成器（纯 Node，无第三方依赖）。
 *
 * 用途有两个：
 * 1. 未配置图像生成模型 / 上游生图失败时的**确定性兜底**：AI 写了 `material.map: "ai:…"`
 *    也一定能拿到一张能贴的图，不会让整轮建模失败；
 * 2. 离线演示贴图链路（mock provider、npm test、diagnostics 出图）不需要任何 API Key。
 *
 * 默认画的是「青花缠枝莲纹」柱面展开图：x = 绕 Z 轴一圈的 u，y = 从瓶口到圈足的 v。
 * 所有笔触按 x 环绕（wrap），所以贴到回转体上不会有竖向拼接缝。
 */
import zlib from 'node:zlib';

/* ---------- PNG 编码（RGB8，无滤波，与 scripts/lib/mini-render.ts 同格式） ---------- */

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    table[index] = value;
  }
  return table;
})();

function crc32(buffer) {
  let crc = -1;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ -1) >>> 0;
}

function chunk(type, data) {
  const head = Buffer.alloc(4);
  head.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([head, body, crc]);
}

export function encodePngRgb(width, height, rgb) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  const stride = width * 3;
  const raw = Buffer.alloc((stride + 1) * height);
  // 首行用 Sub、其余用 Up 滤波：白釉大面积相近，差分后几乎全 0，
  // 比无滤波的 PNG 小 4~6 倍，内联进文档才不会撑爆体积。
  for (let y = 0; y < height; y += 1) {
    const filter = y === 0 ? 1 : 2;
    const row = y * stride;
    raw[y * (stride + 1)] = filter;
    for (let x = 0; x < stride; x += 1) {
      const left = filter === 1 && x >= 3 ? rgb[row + x - 3] : 0;
      const up = filter === 2 ? rgb[row - stride + x] : 0;
      raw[y * (stride + 1) + 1 + x] = (rgb[row + x] - left - up) & 0xff;
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ---------- 像素画笔 ---------- */

const INK = {
  deep: [16, 45, 104],
  mid: [38, 88, 158],
  pale: [108, 156, 203],
  wash: [166, 199, 224],
};

class Painter {
  constructor(width, height) {
    this.width = width;
    this.height = height;
    this.pixels = new Uint8Array(width * height * 3);
    // 甜白釉：极轻的青灰渐变 + 低频窑变波纹（避免逐像素噪声把 PNG 压不下去）
    for (let y = 0; y < height; y += 1) {
      const t = y / height;
      for (let x = 0; x < width; x += 1) {
        const wave = Math.sin(x * 0.012 + y * 0.019) * 1.8 + Math.sin(x * 0.037 - y * 0.013) * 1.1;
        const index = (y * width + x) * 3;
        this.pixels[index] = 243 + wave - t * 3;
        this.pixels[index + 1] = 244 + wave * 0.8 - t * 2;
        this.pixels[index + 2] = 239 + wave * 0.5;
      }
    }
  }

  blend(x, y, color, alpha) {
    if (alpha <= 0 || y < 0 || y >= this.height) return;
    const px = ((Math.round(x) % this.width) + this.width) % this.width;
    const index = (Math.round(y) * this.width + px) * 3;
    const a = Math.min(1, alpha);
    this.pixels[index] += (color[0] - this.pixels[index]) * a;
    this.pixels[index + 1] += (color[1] - this.pixels[index + 1]) * a;
    this.pixels[index + 2] += (color[2] - this.pixels[index + 2]) * a;
  }

  /** 椭圆笔触：边缘带羽化与轻微扰动，近似青花「分水」的浓淡晕染 */
  dab(cx, cy, rx, ry, color, strength = 0.9, feather = 0.45, rotation = 0) {
    const reach = Math.max(rx, ry) * 1.15;
    const cos = Math.cos(rotation);
    const sin = Math.sin(rotation);
    for (let y = Math.floor(cy - reach); y <= Math.ceil(cy + reach); y += 1) {
      for (let x = Math.floor(cx - reach); x <= Math.ceil(cx + reach); x += 1) {
        const dx = x - cx;
        const dy = y - cy;
        const lx = (dx * cos + dy * sin) / rx;
        const ly = (-dx * sin + dy * cos) / ry;
        const ripple = 0.045 * Math.sin(x * 0.29 + y * 0.17) + 0.035 * Math.sin(x * 0.11 - y * 0.31);
        const d = Math.hypot(lx, ly) + ripple;
        if (d >= 1) continue;
        const edge = Math.max(0, Math.min(1, (1 - d) / feather));
        this.blend(x, y, color, strength * edge * edge * (3 - 2 * edge));
      }
    }
  }

  /** 沿折线走笔：先铺一层淡蓝大笔（晕染），再压深蓝细笔（骨线） */
  stroke(points, radius, color = INK.deep, strength = 0.9) {
    if (points.length < 2) return;
    for (let k = 0; k < points.length - 1; k += 1) {
      const [x0, y0] = points[k];
      const [x1, y1] = points[k + 1];
      const steps = Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0) / Math.max(1, radius * 0.45)));
      for (let s = 0; s <= steps; s += 1) {
        const t = s / steps;
        const x = x0 + (x1 - x0) * t;
        const y = y0 + (y1 - y0) * t;
        this.dab(x, y, radius * 2.1, radius * 2.1, INK.wash, 0.16, 0.9);
        this.dab(x, y, radius, radius, color, strength, 0.55);
      }
    }
  }

  /** 水平弦纹：整圈 wrap，青花瓷的口沿 / 颈根 / 腹部分隔线 */
  band(y, thickness = 2, color = INK.deep, strength = 0.85) {
    for (let x = 0; x < this.width; x += 1) {
      for (let dy = -thickness; dy <= thickness; dy += 1) {
        const edge = 1 - Math.abs(dy) / (thickness + 1);
        this.blend(x, y + dy, color, strength * edge);
      }
      this.blend(x, y - thickness - 2, INK.wash, 0.18);
      this.blend(x, y + thickness + 2, INK.wash, 0.18);
    }
  }
}

function line(from, to, steps = 16) {
  const points = [];
  for (let i = 0; i <= steps; i += 1) {
    const t = i / steps;
    points.push([from[0] + (to[0] - from[0]) * t, from[1] + (to[1] - from[1]) * t]);
  }
  return points;
}

/** 花瓣：旋转椭圆 + 深色瓣脉，深浅分层 */
function petal(p, cx, cy, angle, length, width, color) {
  const px = cx + Math.cos(angle) * length * 0.5;
  const py = cy + Math.sin(angle) * length * 0.5;
  p.dab(px, py, length * 0.62, width, INK.wash, 0.2, 0.85, angle);
  p.dab(px, py, length * 0.52, width * 0.82, color, 0.82, 0.5, angle);
  p.stroke(line([cx, cy], [cx + Math.cos(angle) * length * 0.9, cy + Math.sin(angle) * length * 0.9], 8),
    Math.max(1, width * 0.09), INK.deep, 0.45);
}

/** 一朵缠枝莲：两层 8 瓣 + 留白花心 + 莲蓬点 */
function lotus(p, cx, cy, size, flip = false) {
  for (let k = 0; k < 8; k += 1) {
    const angle = (k / 8) * Math.PI * 2 + (flip ? Math.PI / 8 : 0);
    petal(p, cx, cy, angle, size * 0.86, size * 0.24, k % 2 ? INK.mid : INK.deep);
  }
  for (let k = 0; k < 8; k += 1) {
    const angle = (k / 8) * Math.PI * 2 + Math.PI / 8;
    petal(p, cx, cy, angle, size * 0.52, size * 0.15, INK.pale);
  }
  p.dab(cx, cy, size * 0.2, size * 0.2, [246, 246, 241], 0.92, 0.7);
  for (let k = 0; k < 7; k += 1) {
    const a = (k / 7) * Math.PI * 2;
    p.dab(cx + Math.cos(a) * size * 0.1, cy + Math.sin(a) * size * 0.1, size * 0.025, size * 0.025, INK.deep, 0.9, 0.8);
  }
}

/** 卷草尖叶：两笔弧线勾出叶形，中心一条叶脉 */
function leaf(p, cx, cy, angle, size, color = INK.mid) {
  const tip = [cx + Math.cos(angle) * size, cy + Math.sin(angle) * size];
  const side = angle + Math.PI / 2;
  const a = [cx + Math.cos(side) * size * 0.26, cy + Math.sin(side) * size * 0.26];
  const b = [cx - Math.cos(side) * size * 0.26, cy - Math.sin(side) * size * 0.26];
  p.dab(cx + Math.cos(angle) * size * 0.48, cy + Math.sin(angle) * size * 0.48,
    size * 0.5, size * 0.22, color, 0.5, 0.65, angle);
  p.stroke([a, ...line(a, tip, 8).slice(1)], Math.max(1, size * 0.055), INK.deep, 0.8);
  p.stroke([b, ...line(b, tip, 8).slice(1)], Math.max(1, size * 0.055), INK.deep, 0.8);
  p.stroke(line([cx, cy], tip, 8), Math.max(1, size * 0.04), INK.deep, 0.55);
}

/** 回纹 / 雷纹带：周期方折线 */
function meander(p, y, height, period, color = INK.mid) {
  for (let x0 = 0; x0 < p.width + period; x0 += period) {
    const q = period / 8;
    const points = [
      [x0, y + height], [x0, y], [x0 + q * 5, y], [x0 + q * 5, y + height * 0.62],
      [x0 + q * 2, y + height * 0.62], [x0 + q * 2, y + height * 0.3],
      [x0 + q * 3.6, y + height * 0.3],
    ];
    p.stroke(points, Math.max(1.2, height * 0.055), color, 0.75);
  }
}

/** 蕉叶 / 仰莲瓣：一整圈尖朝上的瓣 */
function petalsBand(p, yTop, yBottom, count, filled = true) {
  const step = p.width / count;
  for (let k = 0; k < count; k += 1) {
    const cx = (k + 0.5) * step;
    const half = step * 0.42;
    if (filled) {
      p.dab(cx, (yTop + yBottom) / 2, half * 0.8, (yBottom - yTop) * 0.45, INK.pale, 0.32, 0.75);
    }
    p.stroke([
      [cx - half, yBottom],
      ...line([cx - half, yBottom], [cx - half * 0.55, yTop + (yBottom - yTop) * 0.35], 6).slice(1),
      [cx, yTop],
      ...line([cx, yTop], [cx + half * 0.55, yTop + (yBottom - yTop) * 0.35], 6).slice(1),
      [cx + half, yBottom],
    ], 2.1, INK.deep, 0.85);
    p.stroke(line([cx, yTop + (yBottom - yTop) * 0.22], [cx, yBottom], 6), 1.1, INK.mid, 0.5);
  }
}

/**
 * 生成一张青花缠枝莲柱面展开图。
 * @returns {{ dataUrl: string, width: number, height: number, bytes: number, source: string }}
 */
export function generatePorcelainTexture({ width = 896, height = 560 } = {}) {
  const p = new Painter(width, height);
  const H = height;

  // 口沿 / 颈根 / 肩 / 腹 / 胫 的分隔弦纹
  p.band(H * 0.022, 2.4, INK.deep);
  p.band(H * 0.038, 1.4, INK.mid, 0.7);
  p.band(H * 0.128, 2.2, INK.deep);
  p.band(H * 0.142, 1.2, INK.mid, 0.65);
  p.band(H * 0.255, 2.2, INK.deep);
  p.band(H * 0.268, 1.2, INK.mid, 0.65);
  p.band(H * 0.735, 2.2, INK.deep);
  p.band(H * 0.748, 1.2, INK.mid, 0.65);
  p.band(H * 0.935, 2.4, INK.deep);

  // 颈部蕉叶纹、肩部回纹带
  petalsBand(p, H * 0.052, H * 0.122, 16, false);
  meander(p, H * 0.157, H * 0.075, width / 12);

  // 腹部主纹：四朵缠枝莲 + 贯穿的卷草藤 + 叶片
  const groups = 4;
  const period = width / groups;
  const midY = H * 0.49;
  const vine = [];
  for (let x = 0; x <= width; x += 6) {
    vine.push([x, midY + Math.sin((x / period) * Math.PI * 2) * H * 0.105]);
  }
  p.stroke(vine, 3.2, INK.mid, 0.78);
  // 第二条细藤，错位半周期
  const vine2 = [];
  for (let x = 0; x <= width; x += 6) {
    vine2.push([x, midY - Math.sin((x / period) * Math.PI * 2) * H * 0.105]);
  }
  p.stroke(vine2, 2.2, INK.pale, 0.6);

  for (let k = 0; k < groups; k += 1) {
    const cx = (k + 0.5) * period;
    const cy = midY + Math.sin((cx / period) * Math.PI * 2) * H * 0.105;
    lotus(p, cx, cy, Math.min(period * 0.42, H * 0.19), k % 2 === 1);
    // 主花上下的花苞与卷叶
    for (const [dx, dy, angle, size] of [
      [-period * 0.33, -H * 0.115, -0.8, H * 0.055],
      [period * 0.3, -H * 0.12, -2.2, H * 0.05],
      [-period * 0.28, H * 0.115, 0.9, H * 0.055],
      [period * 0.32, H * 0.12, 2.3, H * 0.05],
    ]) {
      leaf(p, cx + dx, cy + dy, angle, size, INK.mid);
    }
    p.dab(cx + period * 0.42, cy, H * 0.028, H * 0.028, INK.deep, 0.75, 0.6);
  }

  // 胫部仰莲瓣 + 圈足留白
  petalsBand(p, H * 0.775, H * 0.925, 18, true);

  const png = encodePngRgb(width, height, p.pixels);
  return {
    dataUrl: `data:image/png;base64,${png.toString('base64')}`,
    width,
    height,
    bytes: png.length,
    source: 'procedural',
    pattern: 'porcelain',
  };
}

/* ---------- 足球皮革拼块：球面展开图 + 高度图 ---------- */

const GOLDEN = (1 + Math.sqrt(5)) / 2;

function unit3(v) {
  const length = Math.hypot(v[0], v[1], v[2]);
  return [v[0] / length, v[1] / length, v[2] / length];
}

function dot3(a, b) {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

/** 正二十面体 12 个顶点方向 = 正十二面体 12 个五边形面的法向 */
function icosahedronDirections() {
  const raw = [];
  for (const a of [-1, 1]) {
    for (const b of [-1, 1]) {
      raw.push([0, a, b * GOLDEN], [a, b * GOLDEN, 0], [a * GOLDEN, 0, b]);
    }
  }
  return raw.map(unit3);
}

/**
 * 正二十面体 20 个三角面的中心方向 = 截角二十面体 20 个白色六边形面的法向。
 * 直接从上面的顶点三元组算，不另写一套十二面体坐标：两套「标准」坐标的轴向轮换
 * 经常差 90°，混用会让白块方向偏约 10°，黑五边形被挤成菱形 / 花瓣。
 */
function icosahedronFaceDirections() {
  const vertices = icosahedronDirections();
  const centers = [];
  for (let i = 0; i < vertices.length; i += 1) {
    for (let j = i + 1; j < vertices.length; j += 1) {
      if (Math.hypot(...vertices[i].map((value, k) => value - vertices[j][k])) > 1.1) continue;
      for (let k = j + 1; k < vertices.length; k += 1) {
        if (Math.hypot(...vertices[i].map((value, c) => value - vertices[k][c])) > 1.1) continue;
        if (Math.hypot(...vertices[j].map((value, c) => value - vertices[k][c])) > 1.1) continue;
        const center = unit3([0, 1, 2].map((c) => vertices[i][c] + vertices[j][c] + vertices[k][c]));
        if (!centers.some((other) => dot3(other, center) > 0.9999)) centers.push(center);
      }
    }
  }
  return centers;
}

/**
 * 经典足球（截角二十面体）五边形面与六边形面到球心的距离比。
 * 外接球 R²/a² = (58+18√5)/16，五边形外接圆半径 a/(2 sin36°)，六边形为 a。
 * 用 score = dot(d, n)/h 取最大者，等价于「从球心沿 d 射出去先打到哪一块皮」，
 * 所以边界天然连成完整网格，不会像平面正多边形贴片那样断成短划。
 * h 用真实值（五边形略远）才能把黑块压到正确大小；只按 dot 做 Voronoi 会挤成花瓣。
 */
const CLASSIC_PENTAGON_H = (() => {
  const r2 = (58 + 18 * Math.sqrt(5)) / 16;
  const r5 = 1 / (2 * Math.sin(Math.PI / 5));
  return Math.sqrt(r2 - r5 * r5) / Math.sqrt(r2 - 1);
})();

/**
 * 两种拼法：
 * - pentagons（默认）：12 块球面正五边形，黑/白都是五边形，黑白交错；
 * - classic：经典 32 面，12 块黑五边形 + 20 块白六边形。
 */
function footballFaces(layout, pentagonH = CLASSIC_PENTAGON_H) {
  const ico = icosahedronDirections();
  if (layout === 'classic') {
    return [
      ...ico.map((n) => ({ n, h: pentagonH, dark: true })),
      ...icosahedronFaceDirections().map((n) => ({ n, h: 1, dark: false })),
    ];
  }
  const faces = ico.map((n) => ({ n, h: 1, dark: false }));
  // 最远点采样挑 5 个分散的黑块，避免黑五边形挤在一侧
  const chosen = [];
  while (chosen.length < 5) {
    let bestIndex = -1;
    let bestGap = -Infinity;
    for (let i = 0; i < faces.length; i += 1) {
      if (chosen.includes(i)) continue;
      let gap = Math.PI;
      for (const j of chosen) gap = Math.min(gap, Math.acos(Math.max(-1, Math.min(1, dot3(faces[i].n, faces[j].n)))));
      if (gap > bestGap) {
        bestGap = gap;
        bestIndex = i;
      }
    }
    chosen.push(bestIndex);
  }
  for (const index of chosen) faces[index].dark = true;
  return faces;
}

const clamp255 = (value) => Math.max(0, Math.min(255, value));

/**
 * 足球皮革的球面展开图：x = 经度 u（0~1 环绕），y = 极角 v（顶部北极、底部南极），
 * 与造型内核 `mapMode:'spherical'` 的 UV 完全一致。
 *
 * 同时产出一张对齐的灰度高度图（bump）：块面高、拼缝低、缝边有一圈 bevel，
 * 交给 Three.js 的 bumpMap 就能让凹缝跟着光照变明暗；颜色图里也烘焙了同样的
 * 沟底暗芯与缝边高光，即使渲染器不支持 bump，缝也看得出是凹进去的。
 */
export function generateFootballTexture({
  width = 768,
  height = 384,
  layout = 'pentagons',
  pentagonH = CLASSIC_PENTAGON_H,
  seamWidth = layout === 'classic' ? 0.032 : 0.042,
} = {}) {
  const faces = footballFaces(layout, pentagonH);
  // 烘焙一层固定的斜射光：与 mini-render 的主光方向一致。缝的迎光侧亮、背光侧暗，
  // 这样颜色图本身就是「凹槽」而不是一条对称的描边；浏览器里 bumpMap 再叠加动态光照。
  const light = unit3([0.45, -0.55, 0.70]);
  const pixels = new Uint8Array(width * height * 3);
  const bumpPixels = new Uint8Array(width * height * 3);

  for (let y = 0; y < height; y += 1) {
    // three 的 TextureLoader 默认 flipY：贴图第一行对应 v=1，也就是北极
    const theta = Math.PI * ((y + 0.5) / height);
    const st = Math.sin(theta);
    const ct = Math.cos(theta);
    for (let x = 0; x < width; x += 1) {
      const phi = Math.PI * 2 * ((x + 0.5) / width - 0.5);
      const d0 = st * Math.cos(phi);
      const d1 = st * Math.sin(phi);
      const d2 = ct;

      let best = -Infinity;
      let second = -Infinity;
      let face = faces[0];
      let rival = faces[0];
      for (const candidate of faces) {
        const score = (d0 * candidate.n[0] + d1 * candidate.n[1] + d2 * candidate.n[2]) / candidate.h;
        if (score > best) {
          second = best;
          rival = face;
          best = score;
          face = candidate;
        } else if (score > second) {
          second = score;
          rival = candidate;
        }
      }

      // margin 越小越靠近拼缝；smoothstep 出「沟底 → 斜坡 → 块面」的高度剖面
      const t = Math.min(1, Math.max(0, (best - second) / seamWidth));
      const relief = t * t * (3 - 2 * t);
      // 每块皮中间略微鼓起（皮革充气感），靠边自然收下去
      const towardCenter = d0 * face.n[0] + d1 * face.n[1] + d2 * face.n[2];
      const puff = Math.min(1, Math.max(0, (towardCenter - 0.72) / 0.28));
      const base = face.dark ? [25, 27, 32] : [242, 240, 233];
      const grain = Math.sin(x * 0.071 + y * 0.053) * 1.3 + Math.sin(x * 0.019 - y * 0.031) * 0.9;

      // 沟底宽而暗、两侧斜坡抬到块面、靠块一侧有一圈受光的 bevel —— 凹缝的三段剖面
      const groove = 0.22 + 0.78 * relief;
      const bevelDelta = (relief - 0.86) / 0.10;
      const bevel = Math.exp(-(bevelDelta ** 2)) * (face.dark ? 0.24 : 0.10);
      const stitch = 1 - 0.16 * Math.exp(-((relief / 0.20) ** 2)); // 沟中心再压一道缝线
      const lift = 0.96 + 0.04 * puff;

      // 缝的「上坡」方向 = 两个竞争面的 score 差的方向，投到球面切平面后与主光方向比，
      // 得到这一侧是迎光还是背光；只在斜坡段（slope 最大）生效，块面/沟底都不受影响。
      const gx = face.n[0] / face.h - rival.n[0] / rival.h;
      const gy = face.n[1] / face.h - rival.n[1] / rival.h;
      const gz = face.n[2] / face.h - rival.n[2] / rival.h;
      const gd = gx * d0 + gy * d1 + gz * d2;
      const ld = light[0] * d0 + light[1] * d1 + light[2] * d2;
      const tx = gx - gd * d0;
      const ty = gy - gd * d1;
      const tz = gz - gd * d2;
      const lx = light[0] - ld * d0;
      const ly = light[1] - ld * d1;
      const lz = light[2] - ld * d2;
      const denom = Math.hypot(tx, ty, tz) * Math.hypot(lx, ly, lz) + 1e-6;
      const slope = 1 - Math.abs(2 * relief - 1);
      const directed = 1 + 0.20 * ((tx * lx + ty * ly + tz * lz) / denom) * slope;

      const factor = (groove + bevel) * stitch * lift * directed;
      const height = 30 + 205 * relief + 18 * puff;

      const index = (y * width + x) * 3;
      for (let channel = 0; channel < 3; channel += 1) {
        pixels[index + channel] = clamp255(base[channel] * factor + grain * (0.25 + 0.75 * relief));
        bumpPixels[index + channel] = clamp255(height);
      }
    }
  }

  const png = encodePngRgb(width, height, pixels);
  const bumpPng = encodePngRgb(width, height, bumpPixels);
  return {
    dataUrl: `data:image/png;base64,${png.toString('base64')}`,
    bumpDataUrl: `data:image/png;base64,${bumpPng.toString('base64')}`,
    width,
    height,
    bytes: png.length,
    bumpBytes: bumpPng.length,
    source: 'procedural',
    pattern: 'football',
    layout,
  };
}

/**
 * 按提示词挑程序化兜底图案。没配图像模型时**只有这两种**；其它提示词继续用青花占位，
 * 但会在报告里明说，避免模型反复改提示词却永远拿到同一张青花图。
 * 足球默认「全五边形拼块」；明确写了经典 32 面 / 白六边形才走 12 黑五 + 20 白六。
 */
export function generateProceduralTexture(prompt = '', options = {}) {
  const text = String(prompt ?? '');
  if (/足球|soccer|football|黑白五边形|pentagon|皮革拼块/i.test(text)) {
    const classic = /经典\s*32|32\s*面|白(色)?六边形|20\s*个白|hexagon/i.test(text);
    return generateFootballTexture({ ...options, layout: classic ? 'classic' : 'pentagons' });
  }
  return generatePorcelainTexture(options);
}
