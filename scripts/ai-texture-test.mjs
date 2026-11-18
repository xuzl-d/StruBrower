/** AI 生图贴图集成测试（Mock provider）：独立生图端点、plan/SSE 占位符替换、落库与历史瘦身。 */
const BASE = process.env.BASE ?? 'http://127.0.0.1:8787';

let passed = 0;
let failed = 0;
function check(name, ok, detail) {
  if (ok) {
    passed += 1;
    console.log('  ✓', name);
  } else {
    failed += 1;
    console.log('  ✗', name, detail === undefined ? '' : JSON.stringify(detail).slice(0, 300));
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

async function streamPlan(path, body, token) {
  const response = await fetch(BASE + path, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  const events = text.split('\n')
    .filter((line) => line.startsWith('data:'))
    .map((line) => {
      try {
        return JSON.parse(line.slice(5).trim());
      } catch {
        return null;
      }
    })
    .filter(Boolean);
  return { status: response.status, events, contentType: response.headers.get('content-type') ?? '' };
}

const stamp = Date.now();
const user = (await api('POST', '/api/auth/register', {
  body: { email: `ai-texture-${stamp}@example.com`, name: '贴图测试', password: 'secret123' },
})).data;
const token = user?.token;
check('测试用户注册成功', Boolean(token));

const document = {
  schemaVersion: 2,
  id: 'ai-texture-doc',
  name: '贴图测试项目',
  units: 'metric',
  levels: [{ id: 'l1', name: '标高 1', elevation: 0 }],
  grids: [],
  materials: [{ id: 'm1', name: '混凝土', color: '#a3adb8' }],
  types: [{ id: 't-wall', category: 'wall', name: '基本墙 200mm', thickness: 0.2, materialId: 'm1' }],
  elements: [],
};
const created = await api('POST', '/api/projects', {
  token,
  body: { id: `ai-texture-project-${stamp}`, name: '贴图测试项目', document },
});
const projectId = created.data?.project?.id;
check('测试项目创建成功', Boolean(projectId), created.data);
const planPath = `/api/projects/${projectId}/ai/plan`;
const streamPath = `/api/projects/${projectId}/ai/plan/stream`;
const applyPath = `/api/projects/${projectId}/ai/apply`;

console.log('\n能力声明与独立生图端点');
const status = await api('GET', '/api/ai/status', { token });
check('status 声明贴图能力可用', status.data?.texture?.enabled === true, status.data?.texture);
check('Mock 环境标出程序化兜底', status.data?.texture?.procedural === true, status.data?.texture);
const generated = await api('POST', '/api/ai/texture', { token, body: { prompt: '青花缠枝莲纹，甜白釉' } });
check('生图端点 200', generated.status === 200, generated.data);
check('返回可直接写进 material.map 的 PNG', typeof generated.data?.image === 'string'
  && generated.data.image.startsWith('data:image/png;base64,'), generated.data?.source);
check('标出程序化来源', generated.data?.source === 'procedural', generated.data?.source);
check('返回体积信息', generated.data?.bytes > 10000 && generated.data?.chars > 10000, generated.data?.bytes);
check('未登录 401', (await api('POST', '/api/ai/texture', { body: { prompt: 'x' } })).status === 401);
check('空提示词 400', (await api('POST', '/api/ai/texture', { token, body: { prompt: '' } })).status === 400);
const footballTexture = await api('POST', '/api/ai/texture', {
  token, body: { prompt: '黑白足球皮革拼块，白色也是五边形，缝线凹陷' },
});
check('足球生图返回配套高度图', typeof footballTexture.data?.bumpImage === 'string'
  && footballTexture.data.bumpImage.startsWith('data:image/png;base64,'), footballTexture.data?.source);
check('足球生图给了默认 bumpScale', footballTexture.data?.bumpScale === 0.004);
check('青花生图没有高度图', !generated.data?.bumpImage);

console.log('\n普通 plan：AI 写 ai: 占位符，服务端换成图片');
const conversation = await api('POST', `/api/projects/${projectId}/ai/conversations`, { token, body: {} });
const conversationId = conversation.data?.conversation?.id;
check('会话创建成功', Boolean(conversationId), conversation.data);
const plan = await api('POST', planPath, {
  token,
  body: { message: '生成一只带 AI 贴图的青花瓷瓶', conversationId },
});
check('plan 200', plan.status === 200, plan.data);
check('一次通过预校验（占位符合法）', plan.data?.repaired === 0 && !plan.data?.warning,
  { repaired: plan.data?.repaired, warning: plan.data?.warning });
const planMap = plan.data?.ops?.[0]?.features?.[0]?.material?.map;
check('ops 里已是内联 PNG', typeof planMap === 'string' && planMap.startsWith('data:image/png;base64,'),
  typeof planMap === 'string' ? planMap.slice(0, 40) : planMap);
check('贴图报告 1 条且标明来源', plan.data?.textures?.length === 1
  && plan.data.textures[0].source === 'procedural', plan.data?.textures);
check('贴图报告不含图片本体', JSON.stringify(plan.data?.textures ?? {}).length < 1000);
check('材质带柱面投影方式', plan.data?.ops?.[0]?.features?.[0]?.material?.mapMode === 'cylindrical');
check('plan 不落库', (await api('GET', `/api/projects/${projectId}/document`, { token })).data?.rev === 1);

console.log('\n应用落库与会话历史');
const applied = await api('POST', applyPath, { token, body: { ops: plan.data.ops, message: '贴图青花瓷' } });
check('apply 200', applied.status === 200, applied.data);
const saved = await api('GET', `/api/projects/${projectId}/document`, { token });
const savedMap = saved.data?.document?.elements?.[0]?.primitive?.features?.[0]?.material?.map;
check('文档里保存了贴图', typeof savedMap === 'string' && savedMap.startsWith('data:image/png;base64,'));
const history = await api('GET', `/api/ai/conversations/${conversationId}`, { token });
const historyText = JSON.stringify(history.data ?? '');
check('会话历史不存图片本体（已瘦身）', historyText.length > 100
  && historyText.length < 20000 && !historyText.includes('data:image/png;base64,iVB'),
historyText.length);
check('历史里保留贴图占位说明', historyText.includes('历史省略'));
check('历史标记不是 ai: 提示词', !historyText.includes('ai:贴图已生成'));

console.log('\n流式 plan：SSE 结果同样带贴图');
const streamed = await streamPlan(streamPath, { message: '生成青花瓷贴图版' }, token);
check('SSE 200', streamed.status === 200 && /text\/event-stream/.test(streamed.contentType), streamed.contentType);
const result = streamed.events.find((event) => event.type === 'result');
check('收到 status 生图进度事件', streamed.events.some((event) => event.type === 'status'
  && String(event.text ?? '').includes('生成贴图')), streamed.events.map((event) => event.type).join(','));
check('收到 result 事件', Boolean(result));
check('流式 result 带 textures 报告', result?.textures?.length === 1, result?.textures);
const streamMap = result?.ops?.[0]?.features?.[0]?.material?.map;
check('流式 ops 里也是内联 PNG', typeof streamMap === 'string' && streamMap.startsWith('data:image/png;base64,'));

console.log(`\nAI 贴图集成测试${failed ? '失败' : '通过'}（${passed} 项）`);
if (failed) process.exit(1);
