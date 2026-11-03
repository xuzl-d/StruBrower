/** 部署相关行为：监听地址、关闭开放注册、首个管理员引导、认证限流。 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

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

const probe = net.createServer();
await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
const port = probe.address().port;
await new Promise((resolve) => probe.close(resolve));

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'strubrowser-deploy-'));
const child = spawn(process.execPath, ['--experimental-sqlite', 'server/index.js'], {
  cwd: ROOT,
  env: {
    ...process.env,
    HOST: '127.0.0.1',
    PORT: String(port),
    STRU_DATA_DIR: dataDir,
    STRU_SECRET: 'deploy-test-secret',
    STRU_ALLOW_REGISTER: '0',
    STRU_AUTH_RATE_LIMIT: '5',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});

const BASE = `http://127.0.0.1:${port}`;
async function api(method, requestPath, { token, body } = {}) {
  const response = await fetch(BASE + requestPath, {
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

const ready = await (async () => {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const response = await fetch(`${BASE}/api/health`);
      if (response.ok) return await response.json();
    } catch {
      // 继续等待
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return null;
})();

try {
  check('服务端启动并监听指定地址', ready?.ok === true, ready);
  check('健康检查带实例标识', typeof ready?.instance === 'string' && ready.instance.length > 0, ready?.instance);
  check('健康检查包含功能标记', Array.isArray(ready?.features) && ready.features.includes('ai'), ready?.features);

  console.log('关闭开放注册');
  const first = await api('POST', '/api/auth/register', {
    body: { email: 'deploy-admin@example.com', name: 'Deploy Admin', password: 'secret123' },
  });
  check('空库时仍允许注册第一个管理员', first.status === 201 && first.data.user.isAdmin === true, first.data);
  const second = await api('POST', '/api/auth/register', {
    body: { email: 'deploy-user@example.com', name: 'Deploy User', password: 'secret123' },
  });
  check('关闭注册后第二个账号被拒绝', second.status === 403, second.status);

  const adminLogin = await api('POST', '/api/auth/login', {
    body: { email: 'deploy-admin@example.com', password: 'secret123' },
  });
  check('管理员可以登录', adminLogin.status === 200 && Boolean(adminLogin.data.token));
  const created = await api('POST', '/api/admin/users', {
    token: adminLogin.data.token,
    body: { email: 'deploy-created@example.com', name: 'Created', password: 'secret123' },
  });
  check('关闭注册后管理员仍可创建用户', created.status === 201, created.status);
  const createdLogin = await api('POST', '/api/auth/login', {
    body: { email: 'deploy-created@example.com', password: 'secret123' },
  });
  check('管理员创建的用户可登录', createdLogin.status === 200, createdLogin.status);

  console.log('认证限流');
  const wrong = await api('POST', '/api/auth/login', {
    body: { email: 'deploy-admin@example.com', password: 'wrong-password' },
  });
  check('错误密码返回 401', wrong.status === 401, wrong.status);
  const limited = await api('POST', '/api/auth/login', {
    body: { email: 'deploy-admin@example.com', password: 'wrong-password' },
  });
  check('超过尝试次数返回 429', limited.status === 429, limited.status);
  child.kill('SIGTERM');
  const exitCode = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve('timeout'), 6000);
    child.once('exit', (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
  check('SIGTERM 优雅退出', exitCode === 0, exitCode);
} finally {
  child.kill('SIGTERM');
  await new Promise((resolve) => {
    const timer = setTimeout(resolve, 3000);
    child.on('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  });
  fs.rmSync(dataDir, { recursive: true, force: true });
}

console.log(`\n${passed} 项通过${failed ? `，${failed} 项失败` : '，全部通过'}`);
process.exit(failed ? 1 : 0);
