/**
 * 协作（WebSocket）集成测试：房间、在线状态、差分合并、权限、断开清理。
 * 需要运行中的服务端；npm test 会自动拉起临时实例。
 */
const BASE = process.env.BASE ?? 'http://127.0.0.1:8787';
const WS_BASE = BASE.replace(/^http/, 'ws');

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

class CollabClient {
  constructor(url) {
    this.queue = [];
    this.waiters = [];
    this.socket = new WebSocket(url);
    this.socket.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      const index = this.waiters.findIndex((waiter) => waiter.match(message));
      if (index >= 0) {
        const [waiter] = this.waiters.splice(index, 1);
        clearTimeout(waiter.timer);
        waiter.resolve(message);
      } else {
        this.queue.push(message);
      }
    });
    this.opened = new Promise((resolve, reject) => {
      this.socket.addEventListener('open', resolve);
      this.socket.addEventListener('error', () => reject(new Error('websocket error')));
    });
    this.closed = new Promise((resolve) => this.socket.addEventListener('close', (event) => resolve(event.code)));
  }

  send(message) {
    this.socket.send(JSON.stringify(message));
  }

  next(type, timeoutMs = 5000, predicate = () => true) {
    const index = this.queue.findIndex((message) => message.type === type && predicate(message));
    if (index >= 0) return Promise.resolve(this.queue.splice(index, 1)[0]);
    return new Promise((resolve, reject) => {
      const waiter = {
        match: (message) => message.type === type && predicate(message),
        resolve,
        timer: setTimeout(() => {
          this.waiters = this.waiters.filter((item) => item !== waiter);
          reject(new Error(`等待 ${type} 超时`));
        }, timeoutMs),
      };
      this.waiters.push(waiter);
    });
  }

  close() {
    this.socket.close();
  }
}

const stamp = Date.now();
const emailA = `collab-a-${stamp}@example.com`;
const emailB = `collab-b-${stamp}@example.com`;

const a = (await api('POST', '/api/auth/register', { body: { email: emailA, name: '协作A', password: 'secret123' } })).data;
const b = (await api('POST', '/api/auth/register', { body: { email: emailB, name: '协作B', password: 'secret123' } })).data;

const document = {
  schemaVersion: 2,
  id: 'collab-doc',
  name: '协作测试项目',
  units: 'metric',
  levels: [
    { id: 'l1', name: '标高 1', elevation: 0 },
    { id: 'l2', name: '标高 2', elevation: 3 },
  ],
  grids: [],
  materials: [{ id: 'm1', name: '混凝土', color: '#a3adb8' }],
  types: [{ id: 't1', category: 'wall', name: '基本墙', thickness: 0.2, materialId: 'm1' }],
  elements: [],
};
const project = (await api('POST', '/api/projects', {
  token: a.token,
  body: { id: `collab-project-${stamp}`, name: '协作测试项目', document },
})).data.project;
await api('POST', `/api/projects/${project.id}/members`, { token: a.token, body: { email: emailB, role: 'editor' } });

console.log('协作 WebSocket');
const urlA = `${WS_BASE}/ws/projects/${project.id}?token=${encodeURIComponent(a.token)}`;
const urlB = `${WS_BASE}/ws/projects/${project.id}?token=${encodeURIComponent(b.token)}`;

const clientA = new CollabClient(urlA);
await clientA.opened;
const helloA = await clientA.next('hello');
check('A 收到 hello（rev + 文档）', helloA.rev === 1 && helloA.document.schemaVersion === 2 && helloA.role === 'admin', helloA);

const clientB = new CollabClient(urlB);
await clientB.opened;
const helloB = await clientB.next('hello');
check('B 收到 hello 且在线 2 人', helloB.users.length === 2, helloB.users);
const presenceAfterJoin = await clientA.next('presence', 5000, (message) => message.users.length === 2);
check('A 收到 B 加入的 presence', presenceAfterJoin.users.length === 2, presenceAfterJoin.users);

const wall = {
  id: 'collab-wall-1',
  name: '协作墙',
  category: 'wall',
  typeId: 't1',
  levelId: 'l1',
  visible: true,
  start: [0, 0],
  end: [4, 0],
  baseOffset: 0,
  topLevelId: 'l2',
  topOffset: 0,
};
clientA.send({ type: 'patch', diff: { elements: { put: [wall] } } });
const patchA = await clientA.next('patch');
const patchB = await clientB.next('patch');
check('A 广播自己的补丁 rev=2', patchA.rev === 2 && patchA.diff.elements.put[0].id === 'collab-wall-1', patchA);
check('B 收到同一补丁', patchB.rev === 2 && patchB.diff.elements.put[0].id === 'collab-wall-1', patchB);
check('hello 带连接 id，发送端可识别自己的回显', helloA.clientId === patchA.from
  && helloA.clientId !== helloB.clientId
  && patchB.from === patchA.from, { helloA: helloA.clientId, helloB: helloB.clientId, from: patchA.from });

const afterPatch = await api('GET', `/api/projects/${project.id}/document`, { token: a.token });
check('服务端已持久化补丁 rev=2', afterPatch.data.rev === 2 && afterPatch.data.document.elements.length === 1, afterPatch.data);

clientB.send({ type: 'patch', diff: { elements: { remove: ['collab-wall-1'] } } });
const removeA = await clientA.next('patch');
check('删除补丁 rev=3 且 B 端生效', removeA.rev === 3 && removeA.diff.elements.remove[0] === 'collab-wall-1', removeA);

await api('PATCH', `/api/projects/${project.id}/members/${b.user.id}`, { token: a.token, body: { role: 'viewer' } });
clientB.send({ type: 'patch', diff: { elements: { put: [wall] } } });
const denied = await clientB.next('error');
check('viewer 发送补丁被拒绝', String(denied.message).includes('只读'), denied);
const finalDoc = await api('GET', `/api/projects/${project.id}/document`, { token: a.token });
check('被拒绝的补丁未落库', finalDoc.data.rev === 3, finalDoc.data.rev);

clientB.close();
const presenceAfterLeave = await clientA.next('presence', 5000, (message) => message.users.length === 1);
check('B 断开后在线 1 人', presenceAfterLeave.users.length === 1, presenceAfterLeave.users);

const badToken = new CollabClient(`${WS_BASE}/ws/projects/${project.id}?token=invalid`);
let rejected = false;
try {
  await badToken.opened;
} catch {
  rejected = true;
}
check('非法 token 无法建立连接', rejected);

clientA.close();
await clientA.closed;

console.log(`\n${passed} 项通过${failed ? `，${failed} 项失败` : '，全部通过'}`);
process.exit(failed ? 1 : 0);
