/**
 * 贴图版青花瓷：同一个胎体，纹样不再用薄片几何，改成一张柱面 UV 贴图。
 *
 * 运行：node diagnostics/blue-white-vase.textured.gen.mjs
 * 产出：
 *   - diagnostics/blue-white-vase.textured.ops.json（可直接喂 addSolid / npm run query）
 *   - diagnostics/blue-white-vase/texture.png（生成出来的贴图展开图）
 *
 * 贴图由 `server/ai/texture-pattern.js` 生成 —— 与 AI 面板「material.map: "ai:…"」
 * 在未配置图像模型时走的是同一个生成器，因此这份样例就是产品内链路的离线等价物。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { generatePorcelainTexture } from '../server/ai/texture-pattern.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const source = JSON.parse(fs.readFileSync(path.join(here, 'blue-white-vase.ops.json'), 'utf8'));
const body = source[0].features.find((feature) => feature.label === '胎体·甜白釉');
if (!body?.shape) throw new Error('几何版 ops.json 里找不到胎体特征');

const texture = generatePorcelainTexture();
const ops = [{
  op: 'addSolid',
  name: '青花缠枝莲纹瓶（贴图版）',
  color: '#ffffff',
  features: [{
    id: 'bwv-tex-01',
    label: '薄壁瓶胎·青花釉',
    shape: body.shape,
    ...(body.translate ? { translate: body.translate } : {}),
    material: {
      name: '甜白釉·青花贴图',
      roughness: 0.14,
      metalness: 0.02,
      mapMode: 'cylindrical',
      map: texture.dataUrl,
    },
  }],
}];

const opsPath = path.join(here, 'blue-white-vase.textured.ops.json');
fs.writeFileSync(opsPath, `${JSON.stringify(ops, null, 2)}\n`);
const outDir = path.join(here, 'blue-white-vase');
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(
  path.join(outDir, 'texture.png'),
  Buffer.from(texture.dataUrl.slice(texture.dataUrl.indexOf(',') + 1), 'base64'),
);

console.log(`已写出 ${path.relative(root, opsPath)}`);
console.log(`贴图 ${texture.width}×${texture.height}、${texture.bytes} 字节、data URL ${texture.dataUrl.length} 字符`);
console.log('特征数 1（对比几何化版的 7 顶层 / 35 全树）');
