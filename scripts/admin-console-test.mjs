/** 超管后台：概览、全部项目、审计日志、删除项目与权限。 */
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
const adminLogin = await api('POST', '/api/auth/login', {
  body: { email: 'admin-test@example.com', password: 'secret123' },
});
const adminToken = adminLogin.data?.token;
check('复用系统管理员登录', adminLogin.status === 200 && adminLogin.data.user.isAdmin === true, adminLogin.status);

const overview = await api('GET', '/api/admin/overview', { token: adminToken });
check('概览返回统计', overview.status === 200
  && typeof overview.data.users === 'number'
  && typeof overview.data.projects === 'number'
  && typeof overview.data.dbBytes === 'number'
  && overview.data.admins >= 1, overview.data);
check('概览包含 AI 与协作状态', Boolean(overview.data.ai) && Boolean(overview.data.collab) && Array.isArray(overview.data.features) === false, overview.data.ai);
check('概览包含版本与数据目录', typeof overview.data.version === 'string' && typeof overview.data.dataDir === 'string', overview.data.version);

const projectName = `后台测试项目 ${stamp}`;
const created = await api('POST', '/api/projects', {
  token: adminToken,
  body: {
    id: `admin-console-${stamp}`,
    name: projectName,
    document: {
      schemaVersion: 2, id: 'doc', name: projectName, units: 'metric',
      levels: [{ id: 'l1', name: '标高 1', elevation: 0 }],
      grids: [], materials: [], types: [], elements: [],
    },
  },
});
check('管理员创建测试项目', created.status === 201, created.status);

const projects = await api('GET', `/api/admin/projects?q=${encodeURIComponent(projectName)}`, { token: adminToken });
check('项目列表可按名称搜索', projects.status === 200 && projects.data.total === 1, projects.data);
check('项目带所有者与大小', projects.data.projects?.[0]?.ownerEmail === 'admin-test@example.com'
  && typeof projects.data.projects?.[0]?.documentBytes === 'number', projects.data.projects?.[0]);

const audit = await api('GET', '/api/admin/audit?action=project.create&limit=5', { token: adminToken });
check('审计日志可过滤', audit.status === 200 && audit.data.events.every((event) => event.action.includes('project.create')), audit.data?.events?.[0]);
check('审计带用户/项目名称', audit.data.events.some((event) => event.userEmail && event.projectName !== undefined), audit.data.events[0]);
check('审计总数可用', typeof audit.data.total === 'number' && audit.data.total >= 1, audit.data.total);

const many = await api('GET', '/api/admin/audit?limit=2&offset=0', { token: adminToken });
check('审计分页 limit 生效', many.data.events.length <= 2, many.data.events.length);

const deleted = await api('DELETE', `/api/admin/projects/${created.data.project.id}`, { token: adminToken });
check('管理员删除项目', deleted.status === 200, deleted.status);
const afterDelete = await api('GET', `/api/admin/projects?q=${encodeURIComponent(projectName)}`, { token: adminToken });
check('删除后项目消失', afterDelete.data.total === 0, afterDelete.data.total);
const deleteAudit = await api('GET', '/api/admin/audit?action=admin.project.delete', { token: adminToken });
check('删除项目写入审计', deleteAudit.data.events.some((event) => event.action === 'admin.project.delete'), deleteAudit.data.events[0]);

const normal = await api('POST', '/api/auth/register', {
  body: { email: `console-user-${stamp}@example.com`, name: 'Console User', password: 'secret123' },
});
const adminLoginEndpoint = await api('POST', '/api/admin/login', {
  body: { email: 'admin-test@example.com', password: 'secret123' },
});
check('独立管理后台登录（管理员）', adminLoginEndpoint.status === 200 && adminLoginEndpoint.data.user.isAdmin === true, adminLoginEndpoint.status);
check('普通账号不能登录管理后台', (await api('POST', '/api/admin/login', {
  body: { email: `console-user-${stamp}@example.com`, password: 'secret123' },
})).status === 403);

check('注册普通用户', normal.status === 201, normal.status);
check('普通用户读概览 403', (await api('GET', '/api/admin/overview', { token: normal.data.token })).status === 403);
check('普通用户读项目列表 403', (await api('GET', '/api/admin/projects', { token: normal.data.token })).status === 403);
check('普通用户读审计 403', (await api('GET', '/api/admin/audit', { token: normal.data.token })).status === 403);

console.log(`\n${passed} 项通过${failed ? `，${failed} 项失败` : '，全部通过'}`);
process.exit(failed ? 1 : 0);
