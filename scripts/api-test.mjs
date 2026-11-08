// HTTP 接口集成测试：需要一个运行中的服务端（npm test 会自动拉起）
const BASE = process.env.BASE ?? 'http://127.0.0.1:8787';

let passed = 0;
function check(name, condition, detail) {
  if (condition) { passed++; console.log('  ✓', name); }
  else { console.log('  ✗', name, detail ?? ''); process.exitCode = 1; }
}

async function call(method, path, { token, body } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: 'Bearer ' + token } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch {}
  return { status: res.status, data };
}

const doc = (name, extra = {}) => ({
  schemaVersion: 2,
  id: 'doc-1',
  name,
  updatedAt: new Date().toISOString(),
  units: 'metric',
  levels: [{ id: 'l1', name: '标高 1', elevation: 0 }, { id: 'l2', name: '标高 2', elevation: 3 }],
  grids: [],
  materials: [{ id: 'm1', name: '混凝土', color: '#a3adb8' }],
  types: [{ id: 't1', category: 'wall', name: '基本墙', thickness: 0.2, materialId: 'm1' }],
  elements: [{
    id: 'w1', name: '墙 1', category: 'wall', typeId: 't1', levelId: 'l1', visible: true,
    start: [0, 0], end: [4, 0], baseOffset: 0, topLevelId: 'l2', topOffset: 0,
  }],
  ...extra,
});

const stamp = Date.now();
const emailA = `alice-${stamp}@example.com`;
const emailB = `bob-${stamp}@example.com`;

console.log('1. 注册 / 登录 / 身份');
let r = await call('POST', '/api/auth/register', { body: { email: emailA, name: 'Alice', password: 'secret123' } });
check('register 201', r.status === 201, JSON.stringify(r.data));
const tokenA = r.data.token;
r = await call('GET', '/api/me', { token: tokenA });
check('me 返回用户', r.status === 200 && r.data.user.email === emailA);
r = await call('POST', '/api/auth/login', { body: { email: emailA, password: 'wrong-pass' } });
check('错误密码 401', r.status === 401);
r = await call('POST', '/api/auth/register', { body: { email: emailA, name: 'A2', password: 'secret123' } });
check('重复邮箱 409', r.status === 409);
r = await call('POST', '/api/auth/register', { body: { email: 'bad', name: 'x', password: '123' } });
check('非法输入 400', r.status === 400);

console.log('2. 项目与文档 rev');
r = await call('POST', '/api/projects', { token: tokenA, body: { name: '测试项目', document: doc('测试项目') } });
check('创建项目 201', r.status === 201 && r.data.project.role === 'admin', JSON.stringify(r.data));
const projectId = r.data.project.id;
r = await call('GET', `/api/projects/${projectId}/document`, { token: tokenA });
check('读取文档 rev=1', r.status === 200 && r.data.rev === 1 && r.data.document.elements.length === 1);
const rev1 = r.data.rev;
r = await call('PUT', `/api/projects/${projectId}/document`, { token: tokenA, body: { document: doc('测试项目 v2'), baseRev: rev1 } });
check('保存 → rev=2', r.status === 200 && r.data.rev === 2, JSON.stringify(r.data));
r = await call('PUT', `/api/projects/${projectId}/document`, { token: tokenA, body: { document: doc('过期写入'), baseRev: rev1 } });
check('旧 baseRev → 409 冲突', r.status === 409 && r.data.rev === 2, JSON.stringify(r.data));
r = await call('PUT', `/api/projects/${projectId}/document`, { token: tokenA, body: { document: doc('强制覆盖'), baseRev: rev1, force: true } });
check('force 覆盖 → rev=3', r.status === 200 && r.data.rev === 3);
r = await call('PUT', `/api/projects/${projectId}/document`, { token: tokenA, body: { document: { nope: true }, baseRev: 3 } });
check('非法文档 400', r.status === 400);

console.log('3. 版本');
r = await call('POST', `/api/projects/${projectId}/versions`, { token: tokenA, body: { label: '方案 A' } });
check('创建版本 v1', r.status === 201 && r.data.version === 1, JSON.stringify(r.data));
r = await call('PUT', `/api/projects/${projectId}/document`, { token: tokenA, body: { document: doc('方案 B'), baseRev: 3 } });
check('保存 rev=4', r.status === 200 && r.data.rev === 4);
r = await call('GET', `/api/projects/${projectId}/versions`, { token: tokenA });
check('版本列表', r.status === 200 && r.data.versions.length === 1 && r.data.versions[0].label === '方案 A');
r = await call('POST', `/api/projects/${projectId}/restore`, { token: tokenA, body: { version: 1 } });
check('恢复版本 v1 → rev=5 且内容为方案 A', r.status === 200 && r.data.rev === 5 && r.data.document.name === '强制覆盖');

console.log('4. 成员与权限');
r = await call('POST', '/api/auth/register', { body: { email: emailB, name: 'Bob', password: 'secret123' } });
const tokenB = r.data.token;
const bobId = r.data.user.id;
r = await call('GET', '/api/projects', { token: tokenB });
check('Bob 看不到项目', r.status === 200 && r.data.projects.length === 0);
r = await call('GET', `/api/projects/${projectId}/document`, { token: tokenB });
check('Bob 直接访问 404', r.status === 404);
r = await call('POST', `/api/projects/${projectId}/members`, { token: tokenA, body: { email: emailB, role: 'viewer' } });
check('添加 Bob 为 viewer', r.status === 201 && r.data.members.length === 2);
r = await call('GET', `/api/projects/${projectId}/document`, { token: tokenB });
check('viewer 可读', r.status === 200);
r = await call('PUT', `/api/projects/${projectId}/document`, { token: tokenB, body: { document: doc('viewer 写入'), baseRev: 5 } });
check('viewer 写入 403', r.status === 403);
r = await call('PATCH', `/api/projects/${projectId}/members/${bobId}`, { token: tokenA, body: { role: 'editor' } });
check('提升为 editor', r.status === 200 && r.data.members.find((m) => m.id === bobId).role === 'editor');
r = await call('PUT', `/api/projects/${projectId}/document`, { token: tokenB, body: { document: doc('editor 写入'), baseRev: 5 } });
check('editor 写入 rev=6', r.status === 200 && r.data.rev === 6);
r = await call('PATCH', `/api/projects/${projectId}/members/${bobId}`, { token: tokenB, body: { role: 'viewer' } });
check('editor 不能改成员 403', r.status === 403);
r = await call('GET', `/api/projects/${projectId}/audit`, { token: tokenA });
check('管理员可读审计', r.status === 200 && r.data.events.length > 3);
r = await call('GET', `/api/projects/${projectId}/audit`, { token: tokenB });
check('非管理员审计 403', r.status === 403);

// 最后一名 admin 保护：把 Alice 降级
const aliceId = (await call('GET', '/api/me', { token: tokenA })).data.user.id;
r = await call('PATCH', `/api/projects/${projectId}/members/${aliceId}`, { token: tokenA, body: { role: 'editor' } });
check('唯一管理员不可降级 400', r.status === 400, JSON.stringify(r.data));
r = await call('DELETE', `/api/projects/${projectId}/members/${bobId}`, { token: tokenA });
check('移除 Bob', r.status === 200 && r.data.members.length === 1);
r = await call('GET', `/api/projects/${projectId}/document`, { token: tokenB });
check('Bob 移除后 404', r.status === 404);

console.log('5. 项目元数据');
r = await call('PATCH', `/api/projects/${projectId}`, { token: tokenA, body: { name: '重命名项目' } });
check('重命名项目', r.status === 200 && r.data.project.name === '重命名项目');
r = await call('GET', '/api/projects', { token: tokenA });
check('列表包含 rev 与构件数', r.status === 200 && r.data.projects[0].rev === 6 && r.data.projects[0].elementCount === 1);
r = await call('DELETE', `/api/projects/${projectId}`, { token: tokenA });
check('删除项目', r.status === 200);
r = await call('GET', `/api/projects/${projectId}`, { token: tokenA });
check('删除后 404', r.status === 404);

console.log('6. 账户中心（个人资料 / 自助改密码）');
r = await call('GET', '/api/me', { token: tokenA });
check('me 返回 createdAt', r.status === 200 && typeof r.data.user.createdAt === 'string');
r = await call('PATCH', '/api/me', { token: tokenA, body: { name: 'Alice Chen' } });
check('改显示名称', r.status === 200 && r.data.user.name === 'Alice Chen');
r = await call('PATCH', '/api/me', { token: tokenA, body: { name: '   ' } });
check('空名称 400', r.status === 400);
r = await call('POST', '/api/me/password', { token: tokenB, body: { currentPassword: 'wrong', newPassword: 'brandnew8' } });
check('旧密码错误 400', r.status === 400);
r = await call('POST', '/api/me/password', { token: tokenB, body: { currentPassword: 'secret123', newPassword: '123' } });
check('新密码过短 400', r.status === 400);
r = await call('POST', '/api/me/password', { token: tokenB, body: { currentPassword: 'secret123', newPassword: 'secret123' } });
check('新旧密码相同 400', r.status === 400);
r = await call('POST', '/api/me/password', { token: tokenB, body: { currentPassword: 'secret123', newPassword: 'brandnew8' } });
check('自助改密码 200', r.status === 200, JSON.stringify(r.data));
r = await call('POST', '/api/auth/login', { body: { email: emailB, password: 'secret123' } });
check('旧密码登录 401', r.status === 401);
r = await call('POST', '/api/auth/login', { body: { email: emailB, password: 'brandnew8' } });
check('新密码登录 200', r.status === 200);

console.log(`\n${passed} 项通过${process.exitCode ? '，存在失败' : '，全部通过'}`);
