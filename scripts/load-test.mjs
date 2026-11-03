/**
 * 并发压测（默认针对单实例）：
 *   BASE=http://127.0.0.1:8787 USERS=20 ROUNDS=20 npm run load-test
 * 每个用户独立项目，循环 PUT 文档（带 baseRev），统计延迟、冲突与错误。
 */
const BASE = process.env.BASE ?? 'http://127.0.0.1:8787';
const USERS = Math.max(1, Number(process.env.USERS ?? 10));
const ROUNDS = Math.max(1, Number(process.env.ROUNDS ?? 20));

const stamp = Date.now();
const latencies = [];
let ok = 0;
let conflicts = 0;
let errors = 0;

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

function documentFor(name) {
  return {
    schemaVersion: 2,
    id: `load-${stamp}`,
    name,
    units: 'metric',
    levels: [
      { id: 'l1', name: '标高 1', elevation: 0 },
      { id: 'l2', name: '标高 2', elevation: 3 },
    ],
    grids: [],
    materials: [{ id: 'm1', name: '混凝土', color: '#a3adb8' }],
    types: [{ id: 't1', category: 'wall', name: '基本墙 200mm', thickness: 0.2, materialId: 'm1' }],
    elements: [
      { id: 'w1', name: '墙 1', category: 'wall', typeId: 't1', levelId: 'l1', visible: true, start: [0, 0], end: [6, 0], baseOffset: 0, topLevelId: 'l2', topOffset: 0 },
    ],
  };
}

const register = await api('POST', '/api/auth/register', {
  body: { email: `load-${stamp}@example.com`, name: 'Load Test', password: 'secret123' },
});
if (register.status !== 201) {
  console.error('注册失败：', register.status, register.data);
  process.exit(1);
}
const owner = register.data;

const users = [owner];
for (let index = 1; index < USERS; index += 1) {
  const created = await api('POST', '/api/auth/register', {
    body: { email: `load-${stamp}-${index}@example.com`, name: `Load ${index}`, password: 'secret123' },
  });
  if (created.status === 201) users.push(created.data);
}

const projects = [];
for (const [index, user] of users.entries()) {
  const created = await api('POST', '/api/projects', {
    token: user.token,
    body: { id: `load-project-${stamp}-${index}`, name: `压测项目 ${index}`, document: documentFor(`压测项目 ${index}`) },
  });
  if (created.status !== 201) {
    console.error('创建项目失败：', created.status, created.data);
    process.exit(1);
  }
  projects.push({ token: user.token, projectId: created.data.project.id });
}
console.log(`用户 ${users.length} 个，项目 ${projects.length} 个，每项目 ${ROUNDS} 次保存…`);

const started = Date.now();
await Promise.all(projects.map(async ({ token, projectId }, projectIndex) => {
  let rev = 1;
  for (let round = 0; round < ROUNDS; round += 1) {
    const document = documentFor(`压测项目 ${projectIndex} - ${round}`);
    const begin = performance.now();
    const result = await api('PUT', `/api/projects/${projectId}/document`, {
      token,
      body: { document, baseRev: rev },
    });
    latencies.push(performance.now() - begin);
    if (result.status === 200) {
      ok += 1;
      rev = result.data.rev;
    } else if (result.status === 409) {
      conflicts += 1;
      rev = result.data.rev ?? rev;
    } else {
      errors += 1;
    }
  }
}));

const elapsed = Date.now() - started;
latencies.sort((a, b) => a - b);
const percentile = (ratio) => latencies[Math.min(latencies.length - 1, Math.floor(latencies.length * ratio))] ?? 0;

console.log('\n结果');
console.log(`  请求：${ok + conflicts + errors}  成功 ${ok}  冲突 ${conflicts}  错误 ${errors}`);
console.log(`  耗时：${elapsed} ms  吞吐：${((ok + conflicts + errors) / (elapsed / 1000)).toFixed(1)} req/s`);
console.log(`  延迟：p50 ${percentile(0.5).toFixed(1)} ms  p95 ${percentile(0.95).toFixed(1)} ms  max ${latencies.at(-1)?.toFixed(1)} ms`);
process.exit(errors ? 1 : 0);
