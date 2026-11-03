/**
 * 客户端数据层集成测试：HttpProjectRepository 直接打真实服务端，
 * 覆盖 rev 跟踪、双会话冲突、版本恢复、成员权限。
 */
import {
  ApiError,
  ConflictError,
  createAuthApi,
  createMembersApi,
  createVersionsApi,
  HttpProjectRepository,
  setAuthToken,
} from '../src/data/http';
import { createDemoProject } from '../src/bim/template';

const BASE = process.env.BASE ?? 'http://127.0.0.1:8787';
const auth = createAuthApi(BASE);
const versions = createVersionsApi(BASE);
const members = createMembersApi(BASE);
let failures = 0;

function check(name: string, ok: boolean, detail?: unknown) {
  if (ok) console.log('  ✓', name);
  else {
    failures += 1;
    console.log('  ✗', name, detail ?? '');
  }
}

const stamp = Date.now();
const emailA = `client-a-${stamp}@example.com`;
const emailB = `client-b-${stamp}@example.com`;

console.log('客户端数据层（HttpProjectRepository）');
const a = await auth.register(emailA, 'Alice', 'secret123');
setAuthToken(a.token);
const repoA = new HttpProjectRepository(BASE);
const repoA2 = new HttpProjectRepository(BASE);

check('初始列表为空', (await repoA.list()).length === 0);

const project = createDemoProject();
project.name = '客户端测试项目';
check('首次保存 → POST 创建 rev=1', (await repoA.save(project)).rev === 1);

const projects = await repoA.list();
check('服务端保留客户端项目 id', projects[0]?.id === project.id);
check('列表带 role/rev/elementCount', projects[0]?.role === 'admin' && projects[0]?.rev === 1 && projects[0]?.elementCount === 9, projects[0]);

const loaded = await repoA.load(project.id);
check('load 返回同一文档', Boolean(loaded) && loaded!.elements.length === 9);

const edited = { ...loaded!, name: '客户端测试项目 v2' };
check('第二次保存 rev=2', (await repoA.save(edited)).rev === 2);

const other = await repoA2.load(project.id);
check('另一会话保存 rev=3', (await repoA2.save({ ...other!, name: '另一会话写入' })).rev === 3);

let conflict: ConflictError | null = null;
try {
  await repoA.save({ ...edited, name: '过期写入' });
} catch (error) {
  if (error instanceof ConflictError) conflict = error;
  else throw error;
}
check('过期 rev 触发 ConflictError(3)', conflict?.rev === 3, conflict);

check('force 覆盖 rev=4', (await repoA.save({ ...edited, name: '强制覆盖' }, { force: true })).rev === 4);

console.log('版本 API');
check('创建版本 v1', (await versions.create(project.id, '客户端快照')).version === 1);
const list = await versions.list(project.id);
check('版本列表', list.versions.length === 1 && list.versions[0]!.label === '客户端快照');
await repoA.save({ ...edited, name: '版本之后' });
check('恢复版本 rev=6', (await versions.restore(project.id, 1)).rev === 6);
check('恢复后文档内容回到快照', (await repoA.load(project.id))?.name === '强制覆盖');

console.log('成员与权限');
const b = await auth.register(emailB, 'Bob', 'secret123');
setAuthToken(b.token);
const repoB = new HttpProjectRepository(BASE);
check('Bob 看不到项目', (await repoB.list()).length === 0);
check('Bob load 返回 null', (await repoB.load(project.id)) === null);

setAuthToken(a.token);
check('添加 Bob viewer', (await members.add(project.id, emailB, 'viewer')).members.length === 2);

setAuthToken(b.token);
const bobView = await repoB.load(project.id);
check('viewer 可读', Boolean(bobView));
let denied: ApiError | null = null;
try {
  await repoB.save({ ...bobView!, name: 'viewer 写入' });
} catch (error) {
  if (error instanceof ApiError) denied = error;
  else throw error;
}
check('viewer 写入被拒 403', denied?.status === 403, denied);

setAuthToken(a.token);
await members.update(project.id, b.user.id, 'editor');
setAuthToken(b.token);
const bobEdit = await repoB.load(project.id);
check('editor 保存成功', typeof (await repoB.save({ ...bobEdit!, name: 'editor 写入' })).rev === 'number');

let memberDenied: ApiError | null = null;
try {
  await members.update(project.id, b.user.id, 'viewer');
} catch (error) {
  if (error instanceof ApiError) memberDenied = error;
  else throw error;
}
check('editor 不能改成员 403', memberDenied?.status === 403, memberDenied);

setAuthToken(a.token);
await members.remove(project.id, b.user.id);
setAuthToken(b.token);
check('被移除后 load 为 null', (await repoB.load(project.id)) === null);

setAuthToken(a.token);
await repoA.remove(project.id);
check('删除项目后列表为空', (await repoA.list()).length === 0);

console.log(failures ? `\n${failures} 项失败` : '\n全部通过');
process.exit(failures ? 1 : 0);
