/**
 * 纹理贴图链路测试：材质字段 → UV 投影 → PNG 编解码 → 软光栅采样 → AI 生图占位符替换。
 * 与 template-test 一样走真实链路（applyOps / buildElementModel / renderSheet），不做内核直连的假断言。
 */
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createProject } from '../src/bim/template';
import { buildElementModel } from '../src/bim/geometry';
import { buildSolidModel, countSolidFeatures } from '../src/bim/solid';
import { applyOps } from '../server/ai/ops.js';
import { buildProjectContext } from '../server/ai/context.js';
import { buildRoleContext } from '../server/ai/role-context.js';
import { runDescribe } from '../src/ai/describe';
import { generatePorcelainTexture, generateProceduralTexture, encodePngRgb } from '../server/ai/texture-pattern.js';
import {
  generateTexture, resolveTextureOps, slimOpsForHistory, HISTORY_MAP_MARKER, isHistoryMapMarker,
} from '../server/ai/textures.js';
import {
  LIBRARY_MODELS,
  libraryFeatures,
  modelDocument,
} from '../shared/library.js';
import {
  SOLID_MAP_MAX_CHARS,
  SOLID_BUMP_SCALE_MAX,
  normalizeSolidMap,
  normalizeSolidBumpMap,
  resolveSolidMaterial,
  solidMaterialKey,
  solidMaterialLabel,
} from '../shared/materials.js';
import { decodePng } from './lib/png';
import { renderSheet, type RasterView } from './lib/mini-render';
import type { SolidFeature } from '../src/bim/types';

let passed = 0;
const failures: string[] = [];
function check(name: string, condition: boolean, detail = ''): void {
  if (condition) {
    passed += 1;
    console.log(`  ✓ ${name}`);
  } else {
    failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

const texture = generatePorcelainTexture();
const opsPath = path.join(process.cwd(), 'diagnostics/blue-white-vase.textured.ops.json');
const texturedOps = fs.existsSync(opsPath)
  ? JSON.parse(fs.readFileSync(opsPath, 'utf8')) as Array<Record<string, unknown>>
  : null;

console.log('\n材质字段：校验与分组');
{
  const data = 'data:image/png;base64,iVBORw0KGgo=';
  check('data URL 归一化', normalizeSolidMap(data) === data);
  check('ai: 提示词归一化', normalizeSolidMap('  ai:青花缠枝莲纹  ') === 'ai:青花缠枝莲纹');
  check('data URL 里的空白被清掉', normalizeSolidMap('data:image/png;base64,iVBO\nRw0=') === 'data:image/png;base64,iVBORw0=');
  check('拒绝外链 URL', normalizeSolidMap('https://example.com/a.png') === null);
  check('拒绝 svg（避免 XSS 面）', normalizeSolidMap('data:image/svg+xml;base64,PHN2Zz4=') === null);
  check('拒绝空提示词', normalizeSolidMap('ai:   ') === null);
  check('拒绝超长提示词', normalizeSolidMap(`ai:${'x'.repeat(400)}`) === null);
  check('拒绝超长图片', normalizeSolidMap(`data:image/png;base64,${'A'.repeat(SOLID_MAP_MAX_CHARS)}`) === null);

  const ok = resolveSolidMaterial({
    name: '甜白釉', roughness: 0.16, map: 'ai:青花', mapMode: 'cylindrical', mapRepeat: [2, 1],
  });
  check('合法贴图材质通过', ok.errors.length === 0 && ok.material?.map === 'ai:青花', ok.errors.join('；'));
  check('mapMode / mapRepeat 保留', ok.material?.mapMode === 'cylindrical' && ok.material?.mapRepeat?.[0] === 2);
  check('非法 map 被拒绝', resolveSolidMaterial({ map: 'http://x/y.png' }).errors.length === 1);
  check('非法 mapMode 被拒绝', resolveSolidMaterial({ mapMode: 'tubular' }).errors.length === 1);
  check('非法 mapRepeat 被拒绝', resolveSolidMaterial({ mapRepeat: [0, 99] }).errors.length === 1);
  check('未知字段仍被忽略', resolveSolidMaterial({ normalMap: 'x' }).material === null);
  check('bumpMap:auto 合法', normalizeSolidBumpMap('auto') === 'auto'
    && resolveSolidMaterial({ bumpMap: 'auto' }).material?.bumpMap === 'auto');
  check('bumpMap 拒绝 ai: 提示词', normalizeSolidBumpMap('ai:足球') === null);
  check('bumpScale 越界被拒绝', resolveSolidMaterial({ bumpScale: SOLID_BUMP_SCALE_MAX + 1 }).errors.length === 1);
  check('合法 bumpScale 保留', resolveSolidMaterial({ bumpScale: 0.004 }).material?.bumpScale === 0.004);

  const a = solidMaterialKey({ color: '#ffffff', map: 'data:image/png;base64,AAAA' });
  const b = solidMaterialKey({ color: '#ffffff', map: 'data:image/png;base64,BBBB' });
  check('不同贴图分到不同材质槽', a !== b);
  check('相同贴图共用一个槽', a === solidMaterialKey({ color: '#ffffff', map: 'data:image/png;base64,AAAA' }));
  check('不同凹凸图分到不同材质槽', a !== solidMaterialKey({ color: '#ffffff', map: 'data:image/png;base64,AAAA', bumpMap: 'data:image/png;base64,CCCC' }));
  check('分组 key 不含完整 base64', a.length < 200 && a.includes('map:'), `key=${a}`);
  check('贴图材质显示名', solidMaterialLabel({ map: 'ai:x' }) === 'AI 生成贴图'
    && solidMaterialLabel({ map: data }) === '纹理贴图');
}

console.log('\n程序化青花纹理：编码 / 解码');
{
  check('返回 PNG data URL', texture.dataUrl.startsWith('data:image/png;base64,'));
  check(`体积在接口上限内（${texture.dataUrl.length} < ${SOLID_MAP_MAX_CHARS}）`, texture.dataUrl.length < SOLID_MAP_MAX_CHARS);
  const decoded = decodePng(texture.dataUrl);
  check('PNG 能解码（filter 1/2）', Boolean(decoded), decoded ? '' : 'decodePng 返回 null');
  if (decoded) {
    check('解码尺寸正确', decoded.width === texture.width && decoded.height === texture.height,
      `${decoded.width}×${decoded.height}`);
    let blue = 0;
    for (let i = 0; i < decoded.rgb.length; i += 3) {
      const r = decoded.rgb[i];
      const g = decoded.rgb[i + 1];
      const b = decoded.rgb[i + 2];
      if (b - r > 45 && g < 190 && r < 170) blue += 1;
    }
    check('纹样里有成片钴蓝', blue > 5000, `蓝色像素 ${blue}`);
    const corner = (0 * decoded.width + 2) * 3;
    check('白釉底保持高亮', decoded.rgb[corner] > 225 && decoded.rgb[corner + 2] > 210,
      `rgba≈${decoded.rgb[corner]},${decoded.rgb[corner + 1]},${decoded.rgb[corner + 2]}`);
  }
  const tiny = encodePngRgb(2, 2, new Uint8Array([
    10, 20, 30, 10, 20, 30,
    10, 20, 30, 10, 20, 30,
  ]));
  const tinyDecoded = decodePng(tiny);
  check('编码器输出可被解码器读回', tinyDecoded?.rgb[0] === 10 && tinyDecoded?.rgb[2] === 30);
  check('非 PNG data URL 降级为 null', decodePng('data:image/jpeg;base64,AAAA') === null);
}

console.log('\n模型库：青花瓷已注册且能求值');
{
  const entry = LIBRARY_MODELS.find((item) => item.id === 'blue-white-vase');
  check('出现在模型库清单里', Boolean(entry), entry?.name ?? '');
  const features = libraryFeatures('blue-white-vase');
  check('顶层 7 个特征', features.length === 7, String(features.length));
  check('全树 35 个特征', countSolidFeatures(features) === 35, String(countSolidFeatures(features)));
  check('摘要写明不依赖贴图', Boolean(modelDocument('blue-white-vase')?.summary?.includes('不依赖贴图')));
  const doc = applyOps(createProject({ name: '模型库测试' }), [
    { op: 'addSolid', name: '库里的青花瓷', library: 'blue-white-vase' },
  ]);
  const element = doc.document.elements[0];
  const model = element ? buildElementModel(doc.document, element) : null;
  const triangles = model ? Math.floor((model.geometry.index?.count ?? model.geometry.getAttribute('position').count) / 3) : 0;
  check('走 applyOps + buildElementModel 求值成功', triangles > 1000, `${triangles} 面`);
  check('分出 4 档青花料材质槽', model?.materials.length === 4, String(model?.materials.length));
}

console.log('\nUV 投影：按材质槽生成、跨缝解卷、无贴图零回归');
{
  const body = (texturedOps?.[0]?.features as Array<Record<string, unknown>> | undefined)?.[0];
  const shape = body?.shape as SolidFeature['shape'] | undefined;
  check('贴图版样例存在且取到胎体', Boolean(shape), shape ? String(shape.shape) : '缺少 ops 文件');
  if (shape) {
    const withMap: SolidFeature[] = [{ id: 'uv-1', label: '带贴图', shape, material: { map: 'ai:x', mapMode: 'cylindrical' } }];
    const built = buildSolidModel(withMap);
    const uv = built.geometry.getAttribute('uv');
    const position = built.geometry.getAttribute('position');
    check('带贴图时生成 uv 属性', Boolean(uv));
    check('uv 顶点数与 position 一致', Boolean(uv && uv.count === position.count),
      uv ? `${uv.count} vs ${position.count}` : '');
    if (uv) {
      let minU = Infinity;
      let maxU = -Infinity;
      let minV = Infinity;
      let maxV = -Infinity;
      let unwrapped = 0;
      for (let i = 0; i < uv.count; i += 1) {
        const u = uv.getX(i);
        const v = uv.getY(i);
        minU = Math.min(minU, u);
        maxU = Math.max(maxU, u);
        minV = Math.min(minV, v);
        maxV = Math.max(maxV, v);
        if (u > 1.001) unwrapped += 1;
      }
      check('v 覆盖 0~1', minV >= -1e-6 && maxV <= 1.000001 && maxV - minV > 0.9,
        `v=${minV.toFixed(3)}~${maxV.toFixed(3)}`);
      check('柱面接缝做了 u 解卷', unwrapped > 0, `解卷顶点 ${unwrapped}`);
      check('u 不会被拉成整张图', maxU - minU < 1.6, `u=${minU.toFixed(3)}~${maxU.toFixed(3)}`);
    }
    const plain = buildSolidModel([{ id: 'uv-2', label: '无贴图', shape }]);
    check('无贴图时几何保持原样（没有 uv 属性）', !plain.geometry.getAttribute('uv'));
    plain.geometry.dispose();
    built.geometry.dispose();
  }
}

console.log('\n真实链路：applyOps → buildElementModel → 软光栅贴图采样');
{
  if (!texturedOps) {
    check('贴图版 ops.json 已生成', false);
  } else {
    const applied = applyOps(createProject({ name: '贴图测试' }), texturedOps);
    const element = applied.document.elements[0];
    const model = element ? buildElementModel(applied.document, element) : null;
    check('带 461KB 贴图的 ops 通过服务端校验', Boolean(model));
    check('落库后材质保留 map / mapMode', Boolean(
      (element?.primitive as { features?: Array<{ material?: { map?: string; mapMode?: string } }> })
        ?.features?.[0]?.material?.map?.startsWith('data:image/png;base64,'),
    ));
    check('求值结果带 uv', Boolean(model?.geometry.getAttribute('uv')));
    if (model) {
      const view: RasterView[] = [{ name: '正面', azimuth: -90, elevation: 4, zoom: 1.3 }];
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stru-texture-'));
      const texturedPng = path.join(dir, 'textured.png');
      const plainPng = path.join(dir, 'plain.png');
      const options = { width: 180, height: 200, columns: 1, ss: 1, sky: ['#ffffff', '#ffffff'] as [string, string] };
      renderSheet(model.geometry, model.materials, view, texturedPng, options);
      const plainMaterials = model.materials.map((material) => (material ? { ...material, map: undefined } : null));
      renderSheet(model.geometry, plainMaterials, view, plainPng, options);
      const a = decodePng(fs.readFileSync(texturedPng));
      const b = decodePng(fs.readFileSync(plainPng));
      let different = 0;
      if (a && b && a.rgb.length === b.rgb.length) {
        for (let i = 0; i < a.rgb.length; i += 3) {
          if (Math.abs(a.rgb[i] - b.rgb[i]) > 24 || Math.abs(a.rgb[i + 2] - b.rgb[i + 2]) > 24) different += 1;
        }
      }
      check('贴图版与纯色版像素明显不同（贴图确实被采样）', different > 800, `差异像素 ${different}`);
      fs.rmSync(dir, { recursive: true, force: true });
      model.geometry.dispose();
    }
  }
}

console.log('\n上下文：几百 KB 的贴图不回灌给模型');
{
  if (texturedOps) {
    const doc = applyOps(createProject({ name: '上下文测试' }), texturedOps).document;
    const context = buildProjectContext(doc, []);
    const contextText = JSON.stringify(context);
    check('项目上下文不内联贴图', !contextText.includes('data:image/png;base64,'));
    check('项目上下文标出已有贴图', contextText.includes('"textured":true'), contextText.slice(0, 200));
    const role = buildRoleContext({ document: doc, context });
    check('编排角色上下文不内联贴图', !`${role.detailed}${role.brief}`.includes('data:image/png;base64,'));
    const described = runDescribe(doc, [{ type: 'feature', feature: 1 }]);
    check('describe 把内联贴图换成短标记', !described.includes('data:image/png;base64,')
      && described.includes('内联贴图'), described.slice(0, 200));
  }
}

console.log('\nAI 生图占位符：替换、去重、历史瘦身');
{
  const config = { baseUrl: '', apiKey: '', timeoutMs: 5000, image: { model: '', baseUrl: '', apiKey: '' } };
  const ops = [
    { op: 'addSolid', features: [{ material: { map: 'ai:缠枝莲' } }] },
    { op: 'editFeature', patch: { material: { map: 'ai:缠枝莲' } } },
  ];
  const resolved = await resolveTextureOps(ops, config);
  const first = (resolved.ops[0] as { features: Array<{ material: { map: string } }> }).features[0].material.map;
  const second = (resolved.ops[1] as { patch: { material: { map: string } } }).patch.material.map;
  check('ai: 占位符换成 data URL', first.startsWith('data:image/png;base64,'));
  check('嵌套在 patch 里的占位符也替换', second.startsWith('data:image/png;base64,'));
  check('同一提示词只生成一次', resolved.textures.length === 1, String(resolved.textures.length));
  check('生成报告标出程序化来源', resolved.textures[0]?.source === 'procedural');
  check('生成报告不含图片本体', JSON.stringify(resolved.textures).length < 1000);
  const slim = slimOpsForHistory(resolved.ops);
  check('历史副本去掉图片本体', JSON.stringify(slim).length < 2000, String(JSON.stringify(slim).length));
  const stillInline = (resolved.ops[0] as { features: Array<{ material: { map: string } }> }).features[0].material.map;
  check('瘦身不影响这一轮要落库的 ops', stillInline.startsWith('data:image/png;base64,'));

  // 凹凸图通道：足球自动配套、auto 显式请求、孤立 auto 删除、历史里不回灌
  const bumpOps = [
    { op: 'addSolid', features: [{ material: { map: 'ai:黑白足球皮革拼块，白色五边形' } }] },
    { op: 'addSolid', features: [{ material: { map: 'ai:黑白足球皮革拼块，白色五边形', bumpMap: 'auto' } }] },
    { op: 'addSolid', features: [{ material: { color: '#fff', bumpMap: 'auto' } }] },
  ];
  const bumpResolved = await resolveTextureOps(bumpOps, config);
  const ballMats = bumpResolved.ops.map((op) => (op as unknown as {
    features: Array<{ material: Record<string, unknown> }>;
  }).features[0].material);
  check('足球自动附配套高度图', typeof ballMats[0].bumpMap === 'string'
    && String(ballMats[0].bumpMap).startsWith('data:image/png;base64,')
    && ballMats[0].bumpScale === 0.004);
  check('bumpMap:auto 被替换成真实高度图', typeof ballMats[1].bumpMap === 'string'
    && String(ballMats[1].bumpMap).startsWith('data:image/png;base64,'));
  check('孤立 bumpMap:auto 被删掉（不会判非法材质）', !('bumpMap' in ballMats[2]));
  check('贴图报告带 bumpChars', (bumpResolved.textures[0]?.bumpChars ?? 0) > 1000);
  check('贴图报告带拼法标记', bumpResolved.textures[0]?.layout === 'pentagons');
  const bumpSlim = slimOpsForHistory(bumpResolved.ops);
  check('历史里不回灌凹凸图本体', !JSON.stringify(bumpSlim).includes('data:image/png;base64,')
    && !JSON.stringify(bumpSlim).includes('bumpMap'));

  const untouched = await resolveTextureOps([{ op: 'addSolid', features: [{ material: { color: '#fff' } }] }], config);
  check('没有贴图请求时原样返回', untouched.textures.length === 0 && untouched.ops.length === 1);

  // 没配图像模型时，程序化兜底要按提示词选图案，不能永远只画青花
  const football = generateProceduralTexture('经典黑白足球皮革，12 黑五边形 + 20 白六边形');
  const pentagonBall = generateProceduralTexture('黑白足球皮革拼块，白色和黑色都是五边形，缝线凹陷');
  const stats = (dataUrl: string) => {
    const image = decodePng(dataUrl);
    let dark = 0;
    let mid = 0;
    for (let i = 0; i < image.rgb.length; i += 3) {
      const r = image.rgb[i];
      const g = image.rgb[i + 1];
      if (r < 80 && g < 80) dark += 1;
      else if (r > 90 && r < 215) mid += 1; // 沟壁 / bevel 的过渡灰
    }
    const total = image.width * image.height;
    return { dark: dark / total, mid: mid / total };
  };
  const ratio = stats(football.dataUrl);
  const pentagonRatio = stats(pentagonBall.dataUrl);
  check('足球提示词选黑白拼块图案', football.pattern === 'football');
  check('明确经典 32 面时走 classic 拼法', football.layout === 'classic');
  check('默认足球走全五边形拼法', pentagonBall.layout === 'pentagons');
  check('经典拼法含成片黑色五边形', ratio.dark > 0.12 && ratio.dark < 0.45, `黑色占比 ${ratio.dark.toFixed(2)}`);
  check('五边形拼法黑白都有', pentagonRatio.dark > 0.12 && pentagonRatio.dark < 0.65,
    `黑色占比 ${pentagonRatio.dark.toFixed(2)}`);
  check('拼缝有明暗过渡（凹感）', ratio.mid > 0.01 && pentagonRatio.mid > 0.01,
    `classic ${ratio.mid.toFixed(3)} / pentagons ${pentagonRatio.mid.toFixed(3)}`);
  check('足球贴图内联体积受控', football.dataUrl.length < SOLID_MAP_MAX_CHARS
    && pentagonBall.dataUrl.length < SOLID_MAP_MAX_CHARS);
  for (const [label, ball] of [['classic', football], ['pentagons', pentagonBall]] as const) {
    check(`${label} 产出配套高度图`, typeof ball.bumpDataUrl === 'string'
      && ball.bumpDataUrl.startsWith('data:image/png;base64,')
      && ball.bumpDataUrl.length < SOLID_MAP_MAX_CHARS);
    if (!ball.bumpDataUrl) continue;
    const bump = decodePng(ball.bumpDataUrl);
    let gray = true;
    for (let i = 0; i < bump.rgb.length; i += 3) {
      if (bump.rgb[i] !== bump.rgb[i + 1] || bump.rgb[i] !== bump.rgb[i + 2]) { gray = false; break; }
    }
    check(`${label} 高度图是灰度且与颜色图同尺寸`, gray
      && bump.width === decodePng(ball.dataUrl).width && bump.height === decodePng(ball.dataUrl).height);
    check(`${label} 高度图能通过材质校验`, resolveSolidMaterial({ bumpMap: ball.bumpDataUrl }).errors.length === 0);
  }
  check('青花提示词仍走青花', generateProceduralTexture('青花缠枝莲纹').pattern === 'porcelain');

  // 历史瘦身标记不能被当成新的生图提示词（旧版会每轮重新吐一张青花，永远改不掉）
  check('历史标记可被识别', isHistoryMapMarker(HISTORY_MAP_MARKER)
    && isHistoryMapMarker('ai:贴图已生成（历史记录省略图片数据）'));
  const stale = await resolveTextureOps([
    { op: 'editFeature', target: '足球', feature: 1, patch: { material: { map: 'ai:贴图已生成（历史记录省略图片数据）' } } },
  ], config);
  check('旧历史标记不触发生图', stale.textures.length === 0);
  check('旧历史标记变空的 op 被剔除', stale.ops.length === 0, JSON.stringify(stale.ops));
  const kept = await resolveTextureOps([
    { op: 'editFeature', target: '足球', feature: 1, patch: { material: { map: HISTORY_MAP_MARKER, roughness: 0.8 } } },
  ], config);
  const keptMaterial = (kept.ops[0] as { patch: { material: Record<string, unknown> } }).patch.material;
  check('历史标记不覆盖已有贴图', kept.textures.length === 0 && !('map' in keptMaterial));
  check('历史标记保留其它材质字段', keptMaterial.roughness === 0.8);
}

console.log('\n外部图像模型：调用 /images/generations 与失败降级');
{
  const tiny = encodePngRgb(2, 2, new Uint8Array(12).fill(40)).toString('base64');
  const requests: Array<{ url: string; auth: string; body: Record<string, unknown> }> = [];
  let fail = false;
  const stub = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
      requests.push({ url: req.url ?? '', auth: String(req.headers.authorization ?? ''), body });
      if (fail) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end('{"error":"boom"}');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: [{ b64_json: tiny }] }));
    });
  });
  await new Promise<void>((resolve) => stub.listen(0, '127.0.0.1', resolve));
  const address = stub.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  const baseUrl = `http://127.0.0.1:${port}/v1`;
  const config = {
    baseUrl,
    apiKey: 'sk-test',
    timeoutMs: 5000,
    image: { model: 'test-image', baseUrl: '', apiKey: '', size: '512x512' },
  };
  const generated = await generateTexture(config, '青花缠枝莲纹');
  check('走图像模型时来源是 model', generated.source === 'model', generated.source);
  check('请求路径是 /images/generations', requests[0]?.url === '/v1/images/generations', requests[0]?.url);
  check('带 Bearer Key', requests[0]?.auth === 'Bearer sk-test');
  check('请求体带模型名与尺寸', requests[0]?.body.model === 'test-image' && requests[0]?.body.size === '512x512');
  check('提示词追加无缝 UV 约束', String(requests[0]?.body.prompt ?? '').includes('Seamless cylindrical UV'));
  check('返回可写进 material.map 的 data URL', generated.dataUrl.startsWith('data:image/png;base64,'));

  fail = true;
  const degraded = await generateTexture(config, '青花');
  check('上游失败自动降级为程序化纹理', degraded.source === 'procedural-fallback', degraded.source);
  check('降级仍返回可用图片', degraded.dataUrl.startsWith('data:image/png;base64,'));
  check('降级报告带原因', Boolean(degraded.warning));
  await new Promise<void>((resolve) => stub.close(() => resolve()));
}

console.log(`\n贴图链路测试${failures.length ? '失败' : '通过'}（${passed} 项）`);
if (failures.length) {
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
