/** 服务端 STEP 转换接口测试（需要 OCP；未安装时跳过）。 */
import fs from 'node:fs';

const BASE = process.env.BASE ?? 'http://127.0.0.1:8787';
const FIXTURE = 'server/convert/fixtures/box-colors.step';

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

async function waitForStatus(timeoutMs = 25000) {
  const deadline = Date.now() + timeoutMs;
  let last = { available: false, checked: false };
  while (Date.now() < deadline) {
    last = await (await fetch(`${BASE}/api/convert/step/status`)).json();
    if (last.checked) return last;
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  return last;
}

const status = await waitForStatus();
if (!status.available) {
  console.log(`  - STEP 转换器未安装（${status.error ?? 'unknown'}），跳过。运行 npm run setup:step 安装`);
  process.exit(0);
}
check('转换器状态可用', status.available === true && status.checked === true, status);

const fixture = fs.readFileSync(FIXTURE);
const email = `step-${Date.now()}@example.com`;
const registered = await (await fetch(`${BASE}/api/auth/register`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ email, name: 'Step', password: 'secret123' }),
})).json();

const unauthorized = await fetch(`${BASE}/api/convert/step`, { method: 'POST', body: fixture });
check('未登录返回 401', unauthorized.status === 401, unauthorized.status);

const response = await fetch(`${BASE}/api/convert/step`, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/octet-stream',
    Authorization: `Bearer ${registered.token}`,
  },
  body: fixture,
});
check('转换返回 200', response.status === 200, response.status);
check('返回二进制类型', (response.headers.get('content-type') ?? '').includes('octet-stream'), response.headers.get('content-type'));

const buffer = Buffer.from(await response.arrayBuffer());
check('magic 正确', buffer.subarray(0, 8).toString() === 'STRUMESH', buffer.subarray(0, 8).toString());
check('版本为 1', buffer.readUInt32LE(8) === 1);

const headerLength = buffer.readUInt32LE(12);
const header = JSON.parse(buffer.subarray(16, 16 + headerLength).toString('utf8'));
check('顶点/三角面数量', header.vertexCount === 36 && header.triangleCount === 12, header);
check('面带色统计', header.stats.faces === 6 && header.stats.coloredFaces === 6, header.stats);
check('单位换算为米', header.unitScale === 0.001, header.unitScale);

const offset = 16 + headerLength;
const colors = new Float32Array(buffer.buffer, buffer.byteOffset + offset + header.vertexCount * 3 * 4, header.vertexCount * 3);
const distinct = new Set();
for (let index = 0; index < colors.length; index += 3) {
  distinct.add([colors[index], colors[index + 1], colors[index + 2]].map((value) => value.toFixed(2)).join(','));
}
check('保留了逐面颜色（红 + 灰）', distinct.has('1.00,0.00,0.00') && distinct.has('0.50,0.50,0.50'), [...distinct]);

console.log(`\n${passed} 项通过${failed ? `，${failed} 项失败` : '，全部通过'}`);
process.exit(failed ? 1 : 0);
