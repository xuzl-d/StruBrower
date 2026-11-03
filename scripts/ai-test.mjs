/** AI 建模助手集成测试（Mock provider）：方案生成、校验、落库、权限、审计。 */
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
check('plan 不修改文档', (await api('GET', `/api/projects/${projectId}/document`, { token })).data.rev === 1);

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

console.log('审计');
const audit = await api('GET', `/api/projects/${projectId}/audit`, { token });
const actions = audit.data.events.map((event) => event.action);
check('记录 ai.plan / ai.apply', actions.includes('ai.plan') && actions.includes('ai.apply'), actions.slice(0, 8));

console.log(`\n${passed} 项通过${failed ? `，${failed} 项失败` : '，全部通过'}`);
process.exit(failed ? 1 : 0);
