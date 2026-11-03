/**
 * 客户端解码器测试：调用服务端转换接口并用 src/step/convert.ts 解码。
 * 转换器未安装时跳过。
 */
import fs from 'node:fs';
import { decodeServerMesh } from '../src/step/convert';
import { getAuthToken, setAuthToken } from '../src/data/http';

const BASE = process.env.BASE ?? 'http://127.0.0.1:8787';
let failed = 0;
function check(name: string, ok: boolean, detail?: unknown) {
  if (ok) console.log('  ✓', name);
  else { failed += 1; console.log('  ✗', name, detail ?? ''); }
}

const status = await (await fetch(`${BASE}/api/convert/step/status`)).json() as { available: boolean; error?: string };
if (!status.available) {
  console.log(`  - STEP 转换器未安装（${status.error ?? 'unknown'}），跳过`);
  process.exit(0);
}

const email = `decode-${Date.now()}@example.com`;
const registered = await (await fetch(`${BASE}/api/auth/register`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ email, name: 'Decode', password: 'secret123' }),
})).json() as { token: string };
setAuthToken(registered.token);
check('token 已写入内存', Boolean(getAuthToken()));

const fixture = fs.readFileSync('server/convert/fixtures/box-colors.step');
const response = await fetch(`${BASE}/api/convert/step`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/octet-stream', Authorization: `Bearer ${registered.token}` },
  body: fixture,
});
check('转换请求成功', response.status === 200, response.status);

const mesh = decodeServerMesh(await response.arrayBuffer());
check('顶点数正确', mesh.vertexCount === 36, mesh.vertexCount);
check('三角面数正确', mesh.triangleCount === 12, mesh.triangleCount);
check('位置数组长度匹配', mesh.positions.length === mesh.vertexCount * 3, mesh.positions.length);
check('颜色数组长度匹配', mesh.colors.length === mesh.vertexCount * 3, mesh.colors.length);
check('面带色统计', mesh.stats.coloredFaces === 6 && mesh.stats.faces === 6, mesh.stats);
check('单位换算为米（10mm 盒 → 0.01m）', Math.max(...mesh.positions) <= 0.011 && Math.max(...mesh.positions) >= 0.009, Math.max(...mesh.positions));

const distinct = new Set<string>();
for (let index = 0; index < mesh.colors.length; index += 3) {
  distinct.add([mesh.colors[index], mesh.colors[index + 1], mesh.colors[index + 2]].map((value) => value.toFixed(2)).join(','));
}
check('解码后仍有红面与灰面', distinct.has('1.00,0.00,0.00') && distinct.has('0.50,0.50,0.50'), [...distinct]);

console.log(failed ? `\n${failed} 项失败` : '\n全部通过');
process.exit(failed ? 1 : 0);
