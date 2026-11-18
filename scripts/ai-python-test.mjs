/** AI Python 工具集成测试（Mock provider）：status 声明、plan / SSE 执行与结果回灌。 */
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
  try { data = await response.json(); } catch { data = null; }
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
      try { return JSON.parse(line.slice(5).trim()); } catch { return null; }
    })
    .filter(Boolean);
  return { status: response.status, events };
}

const stamp = Date.now();
const user = (await api('POST', '/api/auth/register', {
  body: { email: `ai-python-${stamp}@example.com`, name: 'Python 测试', password: 'secret123' },
})).data;
const token = user?.token;
check('测试用户注册成功', Boolean(token));

const document = {
  schemaVersion: 2,
  id: 'ai-python-doc',
  name: 'Python 测试项目',
  units: 'metric',
  levels: [{ id: 'l1', name: '标高 1', elevation: 0 }],
  grids: [],
  materials: [],
  types: [],
  elements: [],
};
const created = await api('POST', '/api/projects', {
  token,
  body: { id: `ai-python-project-${stamp}`, name: 'Python 测试项目', document },
});
const projectId = created.data?.project?.id;
check('测试项目创建成功', Boolean(projectId), created.data);
const planPath = `/api/projects/${projectId}/ai/plan`;
const streamPath = `/api/projects/${projectId}/ai/plan/stream`;

console.log('\n能力声明');
const status = await api('GET', '/api/ai/status', { token });
check('status 声明 Python 后端', typeof status.data?.python?.mode === 'string', status.data?.python);
check('status 给出隔离级别', typeof status.data?.python?.isolated === 'boolean', status.data?.python);
check('非容器模式带安全警告', status.data?.python?.isolated || typeof status.data?.python?.warning === 'string', status.data?.python);

console.log('\n普通 plan：模型请求脚本 → 服务端执行 → 结果回灌');
const plan = await api('POST', planPath, {
  token,
  body: { message: 'PYTHON_TOOL_TEST 用 python 算一圈阵列点位' },
});
check('plan 200', plan.status === 200, plan.data);
check('返回模型请求的 python 脚本', Array.isArray(plan.data?.python) && plan.data.python.length === 1, plan.data?.python);
check('脚本内容带回前端', typeof plan.data?.python?.[0]?.code === 'string' && plan.data.python[0].code.includes('emit('), plan.data?.python);
check('服务端执行成功', plan.data?.pythonReport?.ok === 1 && plan.data.pythonReport.failed === 0, plan.data?.pythonReport);
check('结果文字含 Python 算出的点列', typeof plan.data?.pythonText === 'string'
  && plan.data.pythonText.includes('"count": 9') && plan.data.pythonText.includes('0.1'), plan.data?.pythonText?.slice(0, 200));
check('报告不含图片本体 / 脚本外的敏感路径', !JSON.stringify(plan.data?.pythonReport ?? '').includes('data:image'), plan.data?.pythonReport);
check('python 工具不产生额外 ops', Array.isArray(plan.data?.ops) && plan.data.ops.length === 0, plan.data?.ops);
check('未登录 401', (await api('POST', planPath, { body: { message: 'PYTHON_TOOL_TEST' } })).status === 401);

console.log('\n流式 plan：SSE 的 result 事件同样带结果');
const streamed = await streamPlan(streamPath, { message: 'PYTHON_TOOL_TEST 用 python 算一圈阵列点位' }, token);
const result = streamed.events.find((event) => event.type === 'result');
check('流式通道 200', streamed.status === 200, streamed.status);
check('收到 result 事件', Boolean(result), streamed.events.map((event) => event.type).join(','));
check('result 带 python 请求', Array.isArray(result?.python) && result.python.length === 1, result?.python);
check('result 带执行结果文字', typeof result?.pythonText === 'string' && result.pythonText.includes('"count": 9'), result?.pythonText?.slice(0, 150));
check('result 带执行报告', result?.pythonReport?.ok === 1, result?.pythonReport);
check('执行阶段推了 status 事件', streamed.events.some((event) => event.type === 'status'
  && String(event.text).includes('Python 脚本')), streamed.events.filter((event) => event.type === 'status').map((event) => event.text));

console.log('\n不请求脚本时不触发沙箱');
const plain = await api('POST', planPath, {
  token,
  body: { message: '生成一只带 AI 贴图的青花瓷瓶' },
});
check('贴图链路仍然正常', plain.status === 200 && typeof plain.data?.ops?.[0]?.features?.[0]?.material?.map === 'string', plain.data?.ops?.[0]?.features?.[0]?.material?.map?.slice?.(0, 40));
check('没有 python 请求时报告为空', !plain.data?.pythonReport?.scripts && !plain.data?.pythonText, plain.data?.pythonReport);

console.log(`\nAI Python 集成测试 ${passed} 项通过${failed ? `，${failed} 项失败` : ''}`);
if (failed) process.exit(1);
