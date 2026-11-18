/**
 * 极简 PNG 解码（Node 侧，无第三方依赖），供 mini-render 采样材质贴图用。
 *
 * 支持：8-bit truecolor (colorType 2) / truecolor+alpha (6) / 灰度 (0) / 灰度+alpha (4)，
 * 非隔行、filter 0~4。不支持调色板、16-bit、隔行、动画；这些在软光栅里直接降级为纯色。
 * JPEG / WebP 由浏览器视口解码，离线预览只在 PNG 上采样贴图。
 */
import zlib from 'node:zlib';

export interface DecodedImage {
  width: number;
  height: number;
  /** RGB 0~255，行优先；alpha 已按白底合成 */
  rgb: Uint8Array;
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

export function decodePng(input: Buffer | string): DecodedImage | null {
  let buffer: Buffer;
  if (typeof input === 'string') {
    if (!/^data:image\/png;base64,/i.test(input.trim())) return null;
    const base64 = input.trim().slice(input.indexOf(',') + 1).replace(/\s+/g, '');
    buffer = Buffer.from(base64, 'base64');
  } else {
    buffer = input;
  }
  if (buffer.length < 24 || buffer.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') return null;

  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let interlace = 0;
  const idat: Buffer[] = [];
  let offset = 8;
  while (offset + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.subarray(offset + 4, offset + 8).toString('ascii');
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    if (data.length !== length) return null;
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      interlace = data[12];
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      break;
    }
    offset += 12 + length;
  }
  const channels = colorType === 0 ? 1 : colorType === 2 ? 3 : colorType === 4 ? 2 : colorType === 6 ? 4 : 0;
  if (!width || !height || !channels || bitDepth !== 8 || interlace !== 0 || !idat.length) return null;
  if (width * height > 64_000_000) return null;

  let raw: Buffer;
  try {
    raw = zlib.inflateSync(Buffer.concat(idat));
  } catch {
    return null;
  }
  const stride = width * channels;
  if (raw.length < (stride + 1) * height) return null;

  const pixels = Buffer.alloc(stride * height);
  let read = 0;
  for (let y = 0; y < height; y += 1) {
    const filter = raw[read];
    read += 1;
    const row = y * stride;
    const prev = row - stride;
    for (let x = 0; x < stride; x += 1) {
      const value = raw[read + x];
      const left = x >= channels ? pixels[row + x - channels] : 0;
      const up = y > 0 ? pixels[prev + x] : 0;
      const upLeft = y > 0 && x >= channels ? pixels[prev + x - channels] : 0;
      let predicted = 0;
      if (filter === 1) predicted = left;
      else if (filter === 2) predicted = up;
      else if (filter === 3) predicted = (left + up) >> 1;
      else if (filter === 4) predicted = paeth(left, up, upLeft);
      else if (filter !== 0) return null;
      pixels[row + x] = (value + predicted) & 0xff;
    }
    read += stride;
  }

  const rgb = new Uint8Array(width * height * 3);
  const alpha = colorType === 4 || colorType === 6 ? channels - 1 : -1;
  for (let i = 0; i < width * height; i += 1) {
    const from = i * channels;
    const to = i * 3;
    let r: number;
    let g: number;
    let b: number;
    if (channels <= 2) {
      r = g = b = pixels[from];
    } else {
      r = pixels[from];
      g = pixels[from + 1];
      b = pixels[from + 2];
    }
    if (alpha >= 0) {
      // 贴图落在本来就是白釉的底色上，半透明按白底合成
      const a = pixels[from + alpha] / 255;
      r = Math.round(r * a + 255 * (1 - a));
      g = Math.round(g * a + 255 * (1 - a));
      b = Math.round(b * a + 255 * (1 - a));
    }
    rgb[to] = r;
    rgb[to + 1] = g;
    rgb[to + 2] = b;
  }
  return { width, height, rgb };
}
