/** 系统管理测试：用户管理、AI 设置（含加密/掩码）、权限与保护规则。 */
import http from 'node:http';

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

const adminEmail = 'admin-test@example.com';
const userEmail = 'admin-test-user@example.com';
const createdEmail = 'admin-test-created@example.com';

const admin = (await api('POST', '/api/auth/register', {
  body: { email: adminEmail, name: 'Admin', password: 'secret123' },
})).data;
const user = (await api('POST', '/api/auth/register', {
  body: { email: userEmail, name: 'User', password: 'secret123' },
})).data;

console.log('管理员角色');
check('STRU_ADMIN_EMAILS 中的用户注册即管理员', admin.user.isAdmin === true, admin.user);
check('普通用户默认非管理员', user.user.isAdmin === false, user.user);
check('/api/me 返回 isAdmin', (await api('GET', '/api/me', { token: user.token })).data.user.isAdmin === false);

console.log('用户管理权限');
const listAsAdmin = await api('GET', '/api/admin/users', { token: admin.token });
check('管理员可读用户列表', listAsAdmin.status === 200 && listAsAdmin.data.users.length >= 2, listAsAdmin.status);
check('列表带项目/成员计数', listAsAdmin.data.users.every((item) => typeof item.ownedProjects === 'number' && typeof item.memberships === 'number'));
check('普通用户读列表 403', (await api('GET', '/api/admin/users', { token: user.token })).status === 403);

console.log('创建 / 修改 / 删除用户');
const created = await api('POST', '/api/admin/users', {
  token: admin.token,
  body: { email: createdEmail, name: 'Created', password: 'secret123' },
});
check('管理员创建用户 201', created.status === 201 && created.data.user.isAdmin === false, created.data);
check('重复邮箱 409', (await api('POST', '/api/admin/users', {
  token: admin.token,
  body: { email: createdEmail, name: 'Dup', password: 'secret123' },
})).status === 409);
check('非法邮箱 400', (await api('POST', '/api/admin/users', {
  token: admin.token,
  body: { email: 'bad', name: 'X', password: 'secret123' },
})).status === 400);

const createdId = created.data.user.id;
const renamed = await api('PATCH', `/api/admin/users/${createdId}`, { token: admin.token, body: { name: 'Created 2' } });
check('改名成功', renamed.status === 200 && renamed.data.user.name === 'Created 2');
check('重置密码成功', (await api('PATCH', `/api/admin/users/${createdId}`, { token: admin.token, body: { password: 'newpass123' } })).status === 200);
check('新密码可登录', (await api('POST', '/api/auth/login', { body: { email: createdEmail, password: 'newpass123' } })).status === 200);

console.log('管理员保护规则');
check('提升为管理员', (await api('PATCH', `/api/admin/users/${user.user.id}`, { token: admin.token, body: { isAdmin: true } })).data.user.isAdmin === true);
check('取消管理员', (await api('PATCH', `/api/admin/users/${user.user.id}`, { token: admin.token, body: { isAdmin: false } })).data.user.isAdmin === false);
check('不能降级最后一名管理员', (await api('PATCH', `/api/admin/users/${admin.user.id}`, { token: admin.token, body: { isAdmin: false } })).status === 400);
check('不能删除自己', (await api('DELETE', `/api/admin/users/${admin.user.id}`, { token: admin.token })).status === 400);

const project = await api('POST', '/api/projects', {
  token: admin.token,
  body: {
    id: `admin-project-${Date.now()}`,
    name: 'Admin 项目',
    document: {
      schemaVersion: 2, id: 'doc', name: 'Admin 项目', units: 'metric',
      levels: [{ id: 'l1', name: '标高 1', elevation: 0 }],
      grids: [], materials: [], types: [], elements: [],
    },
  },
});
check('创建项目', project.status === 201, project.status);
check('拥有项目的用户不可删除', (await api('DELETE', `/api/admin/users/${admin.user.id}`, { token: admin.token })).status === 400);
await api('POST', `/api/projects/${project.data.project.id}/members`, {
  token: admin.token,
  body: { email: createdEmail, role: 'viewer' },
});
check('删除无项目的成员用户', (await api('DELETE', `/api/admin/users/${createdId}`, { token: admin.token })).status === 200);
const members = await api('GET', `/api/projects/${project.data.project.id}/members`, { token: admin.token });
check('删除用户会移除其项目成员关系', members.data.members.every((item) => item.email !== createdEmail), members.data.members);

console.log('AI 设置');
check('普通用户读 AI 设置 403', (await api('GET', '/api/admin/settings/ai', { token: user.token })).status === 403);
const initial = await api('GET', '/api/admin/settings/ai', { token: admin.token });
check('默认 Mock 且就绪', initial.status === 200 && initial.data.provider === 'mock' && initial.data.ready === true && initial.data.hasKey === false, initial.data);

const saved = await api('PUT', '/api/admin/settings/ai', {
  token: admin.token,
  body: { provider: 'openai', baseUrl: 'http://127.0.0.1:9', model: 'test-model', timeoutMs: 5000, apiKey: 'sk-secret-test' },
});
check('保存 AI 配置', saved.status === 200 && saved.data.provider === 'openai' && saved.data.hasKey === true, saved.data);
check('key 以掩码返回', saved.data.keyHint === '****test' && !JSON.stringify(saved.data).includes('sk-secret-test'), saved.data.keyHint);
check('配置来源标记为数据库', saved.data.source.apiKey === 'db', saved.data.source);
check('非法 provider 400', (await api('PUT', '/api/admin/settings/ai', { token: admin.token, body: { provider: 'nope' } })).status === 400);
check('非法 baseUrl 400', (await api('PUT', '/api/admin/settings/ai', { token: admin.token, body: { baseUrl: 'not-a-url' } })).status === 400);
check('思考强度可保存', (await api('PUT', '/api/admin/settings/ai', { token: admin.token, body: { reasoningEffort: 'high' } })).data.reasoningEffort === 'high');
check('思考强度读取一致', (await api('GET', '/api/admin/settings/ai', { token: admin.token })).data.reasoningEffort === 'high');
check('非法思考强度 400', (await api('PUT', '/api/admin/settings/ai', { token: admin.token, body: { reasoningEffort: 'invalid' } })).status === 400);
check('可关闭思考强度参数', (await api('PUT', '/api/admin/settings/ai', { token: admin.token, body: { reasoningEffort: '' } })).data.reasoningEffort === '');

const tested = await api('POST', '/api/admin/settings/ai/test', { token: admin.token });
check('测试连接返回结构化结果', tested.status === 200 && typeof tested.data.ok === 'boolean', tested.data);
check('不可达地址测试失败', tested.data.ok === false, tested.data);

const gateway = http.createServer((request, response) => {
  response.writeHead(200, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify({ data: [{ id: 'model-a', input_modalities: ['text', 'image'] }, { id: 'model-b' }] }));
});
await new Promise((resolve) => gateway.listen(0, '127.0.0.1', resolve));
await api('PUT', '/api/admin/settings/ai', { token: admin.token, body: { baseUrl: `http://127.0.0.1:${gateway.address().port}/v1` } });
const models = await api('GET', '/api/admin/settings/ai/models', { token: admin.token });
check('管理员可获取已保存网关的模型列表', models.status === 200 && models.data.models.length === 2 && models.data.models[0].id === 'model-a' && models.data.models[0].image === true, models.data);
check('模型列表不返回密钥', !JSON.stringify(models.data).includes('sk-secret-test'));
check('普通用户不能获取模型列表', (await api('GET', '/api/admin/settings/ai/models', { token: user.token })).status === 403);
await new Promise((resolve) => gateway.close(resolve));

const cleared = await api('PUT', '/api/admin/settings/ai', { token: admin.token, body: { clearKey: true } });
check('清除 key 后未就绪', cleared.data.hasKey === false && cleared.data.ready === false, cleared.data);
const backToMock = await api('PUT', '/api/admin/settings/ai', { token: admin.token, body: { provider: 'mock', model: 'mock' } });
check('切回 Mock 后恢复就绪', backToMock.data.ready === true && backToMock.data.provider === 'mock', backToMock.data);

console.log('健康信息');
const health = (await api('GET', '/api/health')).data;
check('health 暴露 features（用于识别旧服务端）', Array.isArray(health.features) && health.features.includes('ai'), health.features);

console.log(`\n${passed} 项通过${failed ? `，${failed} 项失败` : '，全部通过'}`);
process.exit(failed ? 1 : 0);
