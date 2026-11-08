/** AI 建模助手集成测试（Mock provider）：方案生成、校验、落库、权限、审计。 */
import { libraryFeatures } from '../shared/library.js';

const BASE = process.env.BASE ?? 'http://127.0.0.1:8787';

let passed = 0;
let failed = 0;
function check(name, ok, detail) {
  if (ok) {
    passed += 1;
    console.log('  ✓', name);
  } else {
    failed += 1;
    console.log('  ✗', name, detail ?? '');
  }
}

async function api(method, path, { token, body } = {}) {
  const response = await fetch(BASE + path, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try {
    data = await response.json();
  } catch {
    data = null;
  }
  return { status: response.status, data };
}

const stamp = Date.now();
const alice = (await api('POST', '/api/auth/register', {
  body: { email: `ai-alice-${stamp}@example.com`, name: 'AI Alice', password: 'secret123' },
})).data;
const token = alice.token;

const document = {
  schemaVersion: 2,
  id: 'ai-doc',
  name: 'AI 测试项目',
  units: 'metric',
  levels: [
    { id: 'l1', name: '标高 1', elevation: 0 },
    { id: 'l2', name: '标高 2', elevation: 3 },
  ],
  grids: [],
  materials: [{ id: 'm1', name: '混凝土', color: '#a3adb8' }],
  types: [
    { id: 't-wall', category: 'wall', name: '基本墙 200mm', thickness: 0.2, materialId: 'm1' },
    { id: 't-col', category: 'column', name: '矩形柱 400×400', width: 0.4, depth: 0.4, materialId: 'm1' },
    { id: 't-slab', category: 'slab', name: '楼板 150mm', thickness: 0.15, materialId: 'm1' },
  ],
  elements: [],
};

const project = (await api('POST', '/api/projects', {
  token,
  body: { id: `ai-project-${stamp}`, name: 'AI 测试项目', document },
})).data.project;
const projectId = project.id;
const planPath = `/api/projects/${projectId}/ai/plan`;
const applyPath = `/api/projects/${projectId}/ai/apply`;

console.log('AI 状态与鉴权');
const status = await api('GET', '/api/ai/status', { token });
check('Mock provider 就绪', status.status === 200 && status.data.provider === 'mock' && status.data.ready === true && status.data.mock === true, status.data);
check('未登录访问 401', (await api('GET', '/api/ai/status')).status === 401);

console.log('生成方案（不落库）');
const plan1 = await api('POST', planPath, { token, body: { message: '建一个 6×4 米、层高 3 米的房间' } });
check('plan 200', plan1.status === 200, plan1.data);
check('4 面墙 + 1 块楼板', plan1.data.summary['墙'] === 4 && plan1.data.summary['楼板'] === 1, plan1.data.summary);
check('返回 Mock 标记', plan1.data.mock === true);
check('返回预校验结果（一次通过）', plan1.data.repaired === 0 && !plan1.data.warning, { repaired: plan1.data.repaired, warning: plan1.data.warning });
check('plan 不修改文档', (await api('GET', `/api/projects/${projectId}/document`, { token })).data.rev === 1);

console.log('流式生成（SSE 中间过程）');
async function streamPlan(path, body, { token: bearer } = {}) {
  const response = await fetch(BASE + path, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
      ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
    },
    body: JSON.stringify(body),
  });
  const contentType = response.headers.get('content-type') ?? '';
  const events = [];
  if (/text\/event-stream/i.test(contentType)) {
    const text = await response.text();
    for (const line of text.split('\n')) {
      if (!line.startsWith('data:')) continue;
      try {
        events.push(JSON.parse(line.slice(5).trim()));
      } catch { /* 忽略坏帧 */ }
    }
  }
  return { status: response.status, contentType, events };
}

const streamed = await streamPlan(`/api/projects/${projectId}/ai/plan/stream`, { message: '建一个 6×4 米、层高 3 米的房间' }, { token });
check('流式返回 text/event-stream', streamed.status === 200 && /text\/event-stream/i.test(streamed.contentType), streamed.contentType);
check('先发 start 事件', streamed.events[0]?.type === 'start', streamed.events.map((event) => event.type).join(','));
check('中间带阶段事件', streamed.events.some((event) => event.type === 'status'), streamed.events.map((event) => event.type).join(','));
const streamedResult = streamed.events.find((event) => event.type === 'result');
check('最后给出 result 事件', Boolean(streamedResult), streamed.events.map((event) => event.type).join(','));
check('流式结果与普通 plan 一致', streamedResult?.summary?.['墙'] === 4 && streamedResult?.summary?.['楼板'] === 1, streamedResult?.summary);
check('流式结果带耗时', typeof streamedResult?.ms === 'number' && streamedResult.ms >= 0, streamedResult?.ms);
const streamedEmpty = await streamPlan(`/api/projects/${projectId}/ai/plan/stream`, { message: '  ' }, { token });
check('空需求在开流前就 400', streamedEmpty.status === 400, streamedEmpty.status);
const streamedUnauth = await streamPlan(`/api/projects/${projectId}/ai/plan/stream`, { message: 'x' });
check('未登录不能流式生成', streamedUnauth.status === 401, streamedUnauth.status);

console.log('看图建模（HTTP 层）');
// 1×1 红点 PNG：只验证链路与校验，不依赖真实视觉模型
const TINY_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const badImage = await api('POST', planPath, { token, body: { message: '照图建模', images: [{ dataUrl: 'https://example.com/a.png' }] } });
check('非 dataURL 图片被拒 400', badImage.status === 400 && String(badImage.data?.error ?? '').includes('dataURL'), badImage.data);
const tooManyImages = await api('POST', planPath, { token, body: { message: '照图建模', images: Array.from({ length: 5 }, () => ({ dataUrl: TINY_PNG })) } });
check('超过 4 张图片被拒 400', tooManyImages.status === 400 && /最多/.test(String(tooManyImages.data?.error ?? '')), tooManyImages.data);
const imageOnly = await api('POST', planPath, { token, body: { images: [{ dataUrl: TINY_PNG }] } });
check('只传图不写字也能提交', imageOnly.status === 200, imageOnly.status);
check('Mock 模式说明自己不读图', String(imageOnly.data?.reply ?? '').includes('Mock'), imageOnly.data?.reply);
const streamedImage = await streamPlan(`/api/projects/${projectId}/ai/plan/stream`, { images: [{ dataUrl: TINY_PNG }] }, { token });
check('流式通道同样接受图片', streamedImage.status === 200 && streamedImage.events.some((event) => event.type === 'result'), streamedImage.events.map((event) => event.type).join(','));

console.log('应用方案');
const applied1 = await api('POST', applyPath, { token, body: { ops: plan1.data.ops, message: '建房间' } });
check('apply 200 且 rev=2', applied1.status === 200 && applied1.data.rev === 2, applied1.data.rev);
check('生成 5 个构件', applied1.data.document.elements.length === 5, applied1.data.document.elements.length);
check('返回执行摘要', applied1.data.applied.length === 5, applied1.data.applied);
const stored = (await api('GET', `/api/projects/${projectId}/document`, { token })).data;
check('文档已落库', stored.rev === 2 && stored.document.elements.length === 5);

console.log('对话式修改');
const plan2 = await api('POST', planPath, { token, body: { message: '把墙加厚到 300' } });
check('识别“加厚到 300”', plan2.status === 200 && plan2.data.ops.some((op) => op.op === 'setTypeProperty' && Math.abs(op.thickness - 0.3) < 1e-9), plan2.data.ops);
const applied2 = await api('POST', applyPath, { token, body: { ops: plan2.data.ops } });
const wallType = applied2.data.document.types.find((type) => type.category === 'wall');
check('类型厚度更新为 0.3', applied2.status === 200 && wallType.thickness === 0.3, wallType);

const plan3 = await api('POST', planPath, { token, body: { message: '删除墙 1' } });
check('识别删除目标', plan3.data.ops.length === 1 && plan3.data.ops[0].op === 'deleteElement' && plan3.data.ops[0].target === '墙 1', plan3.data.ops);
const applied3 = await api('POST', applyPath, { token, body: { ops: plan3.data.ops } });
check('删除后剩 4 个构件', applied3.status === 200 && applied3.data.document.elements.length === 4, applied3.data.document.elements.length);

console.log('协作广播');
const wsUrl = `${BASE.replace(/^http/, 'ws')}/ws/projects/${projectId}?token=${encodeURIComponent(token)}`;
const socket = new WebSocket(wsUrl);
const messages = [];
socket.addEventListener('message', (event) => {
  try { messages.push(JSON.parse(event.data)); } catch { /* 忽略 */ }
});
await new Promise((resolve, reject) => {
  socket.addEventListener('open', resolve);
  socket.addEventListener('error', reject);
  setTimeout(() => reject(new Error('WebSocket 连接超时')), 5000);
});
const waitFor = async (predicate, timeoutMs = 5000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = messages.find(predicate);
    if (found) return found;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return null;
};
check('协作房间 hello', Boolean(await waitFor((message) => message.type === 'hello')));

const applied4 = await api('POST', applyPath, {
  token,
  body: { ops: [{ op: 'addWall', level: '标高 1', start: [0, 0], end: [2, 0] }] },
});
const docBroadcast = await waitFor((message) => message.type === 'doc' && message.rev === applied4.data.rev);
check('AI 应用后向房间广播 doc', Boolean(docBroadcast) && docBroadcast.document.elements.length === applied4.data.document.elements.length, docBroadcast?.rev);
socket.close();

console.log('校验与权限');
const invalid = await api('POST', applyPath, { token, body: { ops: [{ op: 'explode' }] } });
check('非法指令 400', invalid.status === 400 && String(invalid.data.error).includes('不支持'), invalid.data);
check('非法指令不落库', (await api('GET', `/api/projects/${projectId}/document`, { token })).data.rev === applied4.data.rev);

const bob = (await api('POST', '/api/auth/register', {
  body: { email: `ai-bob-${stamp}@example.com`, name: 'AI Bob', password: 'secret123' },
})).data;
await api('POST', `/api/projects/${projectId}/members`, { token, body: { email: `ai-bob-${stamp}@example.com`, role: 'viewer' } });
const bobPlan = await api('POST', planPath, { token: bob.token, body: { message: '建一个房间' } });
check('查看者可以生成方案', bobPlan.status === 200, bobPlan.data);
const bobApply = await api('POST', applyPath, { token: bob.token, body: { ops: bobPlan.data.ops } });
check('查看者不能应用 403', bobApply.status === 403, bobApply.status);

console.log('造型：AI 造四翼螺旋桨无人机');
const dronePlan = await api('POST', planPath, { token, body: { message: '造一台四翼螺旋桨无人机，轴距 60cm' } });
check('识别造型需求 → addSolid', dronePlan.status === 200 && dronePlan.data.ops.length === 1 && dronePlan.data.ops[0].op === 'addSolid', dronePlan.data.ops?.[0]?.op);
check('摘要记为造型', dronePlan.data.summary['造型'] === 1, dronePlan.data.summary);
const droneOp = dronePlan.data.ops[0];
// Mock 现在用 library 引用模型库（特征树是数据，不在指令里展开）；解析出实际特征树再断言
check('用模型库引用（library）而不是内联特征树', droneOp.library === 'quadcopter', droneOp.library ?? droneOp.features?.length);
const droneFeatures = Array.isArray(droneOp.features) ? droneOp.features : libraryFeatures(droneOp.library);
check('特征树 ≥ 20 个顶层特征（精细模型）', droneFeatures.length >= 20, droneFeatures.length);
check('特征树含切除与圆周阵列',
  droneFeatures.some((feature) => feature.mode === 'cut')
  && droneFeatures.some((feature) => feature.pattern?.type === 'circular'),
  droneFeatures.map((feature) => feature.mode ?? feature.pattern?.type ?? 'add'));

const appliedDrone = await api('POST', applyPath, { token, body: { ops: dronePlan.data.ops } });
check('造型 apply 200', appliedDrone.status === 200, appliedDrone.data);
const droneElement = appliedDrone.data.document.elements.find((element) => element.primitive?.kind === 'solid');
check('文档里是多边形网格构件', Boolean(droneElement) && droneElement.category === 'mesh' && droneElement.primitive.features.length === droneFeatures.length);
check('特征都补上了 id', droneElement.primitive.features.every((feature) => typeof feature.id === 'string' && feature.id.length > 0));
const bodyFeature = droneElement.primitive.features.find((feature) => feature.label === '机身');
check('机身是圆角盒 0.26×0.18×0.05（带倒圆）',
  bodyFeature.shape.shape === 'roundedBox'
  && Math.abs(bodyFeature.shape.width - 0.26) < 1e-9
  && Math.abs(bodyFeature.shape.height - 0.05) < 1e-9
  && bodyFeature.shape.radius > 0.005,
  bodyFeature.shape);
const armFeature0 = droneElement.primitive.features.find((feature) => feature.label === '机臂');
check('机臂绕 Z 轴圆周阵列 4 份', armFeature0.pattern?.count === 4 && armFeature0.pattern?.axis === 'z', armFeature0.pattern);
check('旋翼组是嵌套子装配（电机/桨叶/桨毂罩）', droneElement.primitive.features.some((feature) => feature.shape.shape === 'group' && feature.shape.features.length >= 5));
check('机身带预设材质（paintWhite 展开成具体参数）',
  bodyFeature.material?.name === '白色烤漆' && bodyFeature.material?.color === '#eef2f5' && typeof bodyFeature.material?.roughness === 'number',
  bodyFeature.material);
const droneMaterials = new Set();
const walkMaterials = (list) => {
  for (const feature of list) {
    if (feature.material?.color) droneMaterials.add(feature.material.color);
    if (feature.shape?.shape === 'group') walkMaterials(feature.shape.features);
  }
};
walkMaterials(droneElement.primitive.features);
check('整机至少 3 种零件颜色（不是灰模）', droneMaterials.size >= 3, [...droneMaterials].join(','));

const armPlan = await api('POST', planPath, { token, body: { message: '把无人机机臂加长到 30cm' } });
check('生成 editFeature', armPlan.data.ops?.[0]?.op === 'editFeature' && armPlan.data.ops[0].feature === '机臂', armPlan.data.ops);
const appliedArm = await api('POST', applyPath, { token, body: { ops: armPlan.data.ops } });
const armFeature = appliedArm.data.document.elements
  .find((element) => element.primitive?.kind === 'solid')
  .primitive.features.find((feature) => feature.label === '机臂');
check('只改机臂长度为 0.3', Math.abs(armFeature.shape.height - 0.3) < 1e-9 && armFeature.shape.shape === 'tube', armFeature.shape);
check('其它特征未受影响', appliedArm.data.document.elements.find((item) => item.primitive?.kind === 'solid').primitive.features.length === droneFeatures.length);

// 材质接口：改单个特征的材质（不重建实体）
const recolored = await api('POST', applyPath, {
  token,
  body: {
    ops: [{
      op: 'editFeature',
      target: '四翼螺旋桨无人机',
      feature: '机身',
      patch: { material: { name: '深空灰', color: '#20303F', roughness: 0.42, metalness: 0.18 } },
    }],
  },
});
const recoloredBody = recolored.data.document?.elements
  ?.find((element) => element.primitive?.kind === 'solid')
  ?.primitive.features.find((feature) => feature.label === '机身');
check('editFeature 可以只改材质', recolored.status === 200 && recoloredBody?.material?.color === '#20303f', recoloredBody?.material);
check('材质颜色归一化成小写 #rrggbb', recoloredBody?.material?.color === '#20303f' && recoloredBody?.material?.name === '深空灰');

console.log('视角巡检（AI 让界面转起来看模型）');
const inspectPlan = await api('POST', planPath, { token, body: { message: '把模型转一圈看看，检查一下比例和朝向' } });
check('Mock 也能请求视角巡检', inspectPlan.status === 200 && Array.isArray(inspectPlan.data.inspect), inspectPlan.data.inspect);
check('巡检轮不带建模指令', (inspectPlan.data.ops ?? []).length === 0, inspectPlan.data.ops);
check('视角带中文名（前视/右视/等轴测）',
  (inspectPlan.data.inspect ?? []).map((item) => item.label).join('/') === '前视/右视/等轴测',
  inspectPlan.data.inspect);

console.log('自检闭环（done 收工信号 + 巡检回执不污染历史）');
check('plan 返回 done 字段且默认 false', inspectPlan.data.done === false, inspectPlan.data.done);
const loopConv = await api('POST', `/api/projects/${projectId}/ai/conversations`, { token, body: {} });
const loopConvId = loopConv.data.conversation.id;
// 闭环里前端代发的巡检回执：不写字的需求 → 带 internal 落库
const stepPlan = await api('POST', planPath, {
  token,
  body: {
    message: '[自检第 2/5 步] 你要的视角已经切好并截图：1. 前视 2. 右视',
    conversationId: loopConvId,
    internal: true,
  },
});
check('巡检回执这一轮拿到 done=true', stepPlan.data.done === true, stepPlan.data.done);
check('巡检回执轮不再要求看图', (stepPlan.data.inspect ?? []).length === 0, stepPlan.data.inspect);
const loopDetail = await api('GET', `/api/ai/conversations/${loopConvId}`, { token });
const loopMessages = loopDetail.data.conversation.messages ?? [];
check('回执在历史里标 internal（前端据此不显示成用户发言）',
  loopMessages.some((item) => item.internal === true), loopMessages.map((item) => item.internal));
check('回执仍然进上下文（消息数包含它）', loopMessages.length >= 2, loopMessages.length);

// 「换成红色」→ 只改材质，不重建实体
const colorPlan = await api('POST', planPath, { token, body: { message: '把无人机机身改成红色' } });
check('换色意图生成 editFeature + material',
  colorPlan.status === 200 && colorPlan.data.ops?.[0]?.op === 'editFeature' && colorPlan.data.ops[0].patch?.material?.color === '#c8382f',
  colorPlan.data.ops);
const appliedColor = await api('POST', applyPath, { token, body: { ops: colorPlan.data.ops } });
const paintedBody = appliedColor.data.document?.elements
  ?.find((element) => element.primitive?.kind === 'solid')
  ?.primitive.features.find((feature) => feature.label === '机身');
check('应用后机身换成红色材质', appliedColor.status === 200 && paintedBody?.material?.color === '#c8382f', paintedBody?.material);

const drilled = await api('POST', applyPath, {
  token,
  body: {
    ops: [{
      op: 'addFeature',
      target: '四翼螺旋桨无人机',
      feature: { label: '相机孔', mode: 'cut', shape: { shape: 'cylinder', radius: 0.008, height: 0.06 }, translate: [0.13, 0, 0.012] },
    }],
  },
});
const drilledFeatures = drilled.data.document.elements.find((element) => element.primitive?.kind === 'solid').primitive.features;
check('addFeature 追加切除特征', drilled.status === 200 && drilledFeatures.length === droneFeatures.length + 1 && drilledFeatures.at(-1).mode === 'cut', drilledFeatures.length);

const badShape = await api('POST', applyPath, { token, body: { ops: [{ op: 'addSolid', features: [{ shape: { shape: 'trapezoid' } }] }] } });
check('未知形状 400', badShape.status === 400 && String(badShape.data.error).includes('不支持'), badShape.data);
const badCut = await api('POST', applyPath, { token, body: { ops: [{ op: 'addSolid', features: [{ mode: 'cut', shape: { shape: 'box', width: 1, depth: 1, height: 1 } }] }] } });
check('首个特征不能是切除', badCut.status === 400, badCut.data);
const badTarget = await api('POST', applyPath, { token, body: { ops: [{ op: 'editFeature', target: '墙 2', feature: 1, patch: { shape: { height: 1 } } }] } });
check('对非造型实体改特征 400', badTarget.status === 400 && String(badTarget.data.error).includes('不是造型实体'), badTarget.data);
const badIndex = await api('POST', applyPath, { token, body: { ops: [{ op: 'deleteFeature', target: '四翼螺旋桨无人机', feature: 999 }] } });
check('特征序号越界 400', badIndex.status === 400, badIndex.data);
const badFirst = await api('POST', applyPath, { token, body: { ops: [{ op: 'deleteFeature', target: '四翼螺旋桨无人机', feature: 1 }] } });
check('不能删基础特征', badFirst.status === 400, badFirst.data);
const badMaterial = await api('POST', applyPath, {
  token,
  body: {
    ops: [{
      op: 'addSolid',
      features: [{ shape: { shape: 'box', width: 0.1, depth: 0.1, height: 0.1 }, material: { color: 'red' } }],
    }],
  },
});
check('非法材质颜色 400 且提示 material', badMaterial.status === 400 && String(badMaterial.data.error).includes('material'), badMaterial.data);
const badPreset = await api('POST', applyPath, {
  token,
  body: {
    ops: [{
      op: 'addSolid',
      features: [{ shape: { shape: 'box', width: 0.1, depth: 0.1, height: 0.1 }, material: 'unobtainium' }],
    }],
  },
});
check('未知材质预设 400 并列出可用预设', badPreset.status === 400 && String(badPreset.data.error).includes('aluminum'), badPreset.data);

console.log('圆角盒倒圆半径（只看平面尺寸，不看板厚）');
const thinPlate = await api('POST', applyPath, {
  token,
  body: {
    ops: [{
      op: 'addSolid',
      name: '顶盖测试',
      features: [{ label: '顶盖', shape: { shape: 'roundedBox', width: 0.2, depth: 0.16, height: 0.006, radius: 0.02 } }],
    }],
  },
});
check('6mm 薄板用 20mm 倒圆可以建（不再被 height 卡住）', thinPlate.status === 200, thinPlate.data);
const fatRadius = await api('POST', applyPath, {
  token,
  body: {
    ops: [{
      op: 'addSolid',
      features: [{ label: '过圆', shape: { shape: 'roundedBox', width: 0.2, depth: 0.16, height: 0.006, radius: 0.12 } }],
    }],
  },
});
check('倒圆超过 min(width, depth)/2 时 400 并说明上限',
  fatRadius.status === 400 && String(fatRadius.data.error).includes('min(width, depth)/2'),
  fatRadius.data);
// 报错要能让模型一次改对：给出建议值，且不能出现与上限矛盾的措辞（曾写「薄板可以取大倒圆」把模型带偏）
const fatError = String(fatRadius.data.error ?? '');
check('越界倒圆报错给出可直接照抄的建议值',
  /建议 \d/.test(fatError) && !fatError.includes('薄板可以取大倒圆'),
  fatError);
const narrowRadius = await api('POST', applyPath, {
  token,
  body: {
    ops: [{
      op: 'addSolid',
      features: [{ label: '窄条', shape: { shape: 'roundedBox', width: 0.0015, depth: 0.0012, height: 0.5, radius: 0.001 } }],
    }],
  },
});
check('平面窄到放不下最小圆角时提示改用 box（而不是死循环报区间）',
  narrowRadius.status === 400 && String(narrowRadius.data.error).includes('无法倒圆'),
  narrowRadius.data);

console.log('审计');
const audit = await api('GET', `/api/projects/${projectId}/audit`, { token });
const actions = audit.data.events.map((event) => event.action);
check('记录 ai.plan / ai.apply', actions.includes('ai.plan') && actions.includes('ai.apply'), actions.slice(0, 8));

console.log(`\n${passed} 项通过${failed ? `，${failed} 项失败` : '，全部通过'}`);
process.exit(failed ? 1 : 0);
