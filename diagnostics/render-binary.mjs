import fs from 'node:fs';
import zlib from 'node:zlib';

const [binPath, outPath, W = '1200', H = '800', mode = 'color'] = process.argv.slice(2);
const Wn = +W, Hn = +H;
const buf = fs.readFileSync(binPath);
const n = buf.readUInt32LE(0);
const pos = new Float32Array(buf.buffer, buf.byteOffset + 8, n * 3);
const col = new Float32Array(buf.buffer, buf.byteOffset + 8 + n * 12, n * 3);

// bbox
let mn = [1e9, 1e9, 1e9], mx = [-1e9, -1e9, -1e9];
for (let i = 0; i < n; i++) for (let k = 0; k < 3; k++) {
  const v = pos[i * 3 + k];
  if (v < mn[k]) mn[k] = v;
  if (v > mx[k]) mx[k] = v;
}
const c = [0, 1, 2].map((k) => (mn[k] + mx[k]) / 2);
const size = Math.max(...[0, 1, 2].map((k) => mx[k] - mn[k])) || 1;

// camera: iso-ish
const dir = [0.72, -0.62, 0.72];
const dl = Math.hypot(...dir);
const fwd = dir.map((v) => -v / dl);
let up = [0, 1, 0];
let right = [fwd[1] * up[2] - fwd[2] * up[1], fwd[2] * up[0] - fwd[0] * up[2], fwd[0] * up[1] - fwd[1] * up[0]];
const rl = Math.hypot(...right); right = right.map((v) => v / rl);
up = [right[1] * fwd[2] - right[2] * fwd[1], right[2] * fwd[0] - right[0] * fwd[2], right[0] * fwd[1] - right[1] * fwd[0]];
const scale = 1.25;
const z = new Float32Array(Wn * Hn).fill(Infinity);
const img = Buffer.alloc(Wn * Hn * 3, 255);
const light = (() => { const l = [-0.35, 0.75, 0.55]; const m = Math.hypot(...l); return l.map((v) => v / m); })();
const P = (i) => {
  const x = pos[i * 3] - c[0], y = pos[i * 3 + 1] - c[1], zz = pos[i * 3 + 2] - c[2];
  return [x * right[0] + y * right[1] + zz * right[2], x * up[0] + y * up[1] + zz * up[2], x * fwd[0] + y * fwd[1] + zz * fwd[2]];
};
const persp = 1.0;
for (let t = 0; t < n; t += 3) {
  const a = P(t), b = P(t + 1), cc = P(t + 2);
  const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
  const vx = cc[0] - a[0], vy = cc[1] - a[1], vz = cc[2] - a[2];
  let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
  const nl = Math.hypot(nx, ny, nz) || 1e-9;
  nx /= nl; ny /= nl; nz /= nl;
  const shade = 0.32 + 0.68 * Math.abs(nx * light[0] + ny * light[1] + nz * light[2]);
  const tri = [a, b, cc];
  const sx = tri.map((p) => (p[0] / size) * Math.min(Wn, Hn) * scale + Wn / 2);
  const sy = tri.map((p) => (-p[1] / size) * Math.min(Wn, Hn) * scale + Hn / 2);
  const sz = tri.map((p) => p[2]);
  const minX = Math.max(0, Math.floor(Math.min(...sx))), maxX = Math.min(Wn - 1, Math.ceil(Math.max(...sx)));
  const minY = Math.max(0, Math.floor(Math.min(...sy))), maxY = Math.min(Hn - 1, Math.ceil(Math.max(...sy)));
  if (minX > maxX || minY > maxY) continue;
  const d = (sy[1] - sy[2]) * (sx[0] - sx[2]) + (sx[2] - sx[1]) * (sy[0] - sy[2]);
  if (Math.abs(d) < 1e-9) continue;
  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      const px = x + 0.5, py = y + 0.5;
      const l0 = ((sy[1] - sy[2]) * (px - sx[2]) + (sx[2] - sx[1]) * (py - sy[2])) / d;
      const l1 = ((sy[2] - sy[0]) * (px - sx[2]) + (sx[0] - sx[2]) * (py - sy[2])) / d;
      const l2 = 1 - l0 - l1;
      if (l0 < -1e-6 || l1 < -1e-6 || l2 < -1e-6) continue;
      const depth = l0 * sz[0] + l1 * sz[1] + l2 * sz[2];
      const idx = y * Wn + x;
      if (depth >= z[idx]) continue;
      z[idx] = depth;
      let r, g, bl;
      if (mode === 'grey') { r = g = bl = 0.78; }
      else {
        r = (col[t * 3] * l0 + col[(t + 1) * 3] * l1 + col[(t + 2) * 3] * l2);
        g = (col[t * 3 + 1] * l0 + col[(t + 1) * 3 + 1] * l1 + col[(t + 2) * 3 + 1] * l2);
        bl = (col[t * 3 + 2] * l0 + col[(t + 1) * 3 + 2] * l1 + col[(t + 2) * 3 + 2] * l2);
      }
      // linear -> sRGB for display
      const enc = (v) => { const s = Math.max(0, Math.min(1, v)); return Math.round(255 * (s <= 0.0031308 ? s * 12.92 : 1.055 * Math.pow(s, 1 / 2.4) - 0.055)); };
      img[idx * 3] = enc(r * shade);
      img[idx * 3 + 1] = enc(g * shade);
      img[idx * 3 + 2] = enc(bl * shade);
    }
  }
}

// PNG encode
const crcTable = (() => { const t = new Int32Array(256); for (let i = 0; i < 256; i++) { let cc = i; for (let k = 0; k < 8; k++) cc = cc & 1 ? 0xedb88320 ^ (cc >>> 1) : cc >>> 1; t[i] = cc; } return t; })();
const crc32 = (b) => { let cc = -1; for (let i = 0; i < b.length; i++) cc = crcTable[(cc ^ b[i]) & 0xff] ^ (cc >>> 8); return (cc ^ -1) >>> 0; };
const chunk = (type, data) => {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const t = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, data])));
  return Buffer.concat([len, t, data, crc]);
};
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(Wn, 0); ihdr.writeUInt32BE(Hn, 4); ihdr[8] = 8; ihdr[9] = 2;
const raw = Buffer.alloc(Hn * (Wn * 3 + 1));
for (let y = 0; y < Hn; y++) { raw[y * (Wn * 3 + 1)] = 0; img.copy(raw, y * (Wn * 3 + 1) + 1, y * Wn * 3, (y + 1) * Wn * 3); }
const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
fs.writeFileSync(outPath, png);
console.log('wrote', outPath);
