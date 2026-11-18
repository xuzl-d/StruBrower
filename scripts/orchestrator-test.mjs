/**
 * 多角色编排回归测试：
 * 1) mock 配置下全链路（拆件 → 零件 → 曲面采样 → 贴合件 → 拼接 → 合并）离线跑通；
 * 2) OpenAI 兼容桩服务下，验证 callRoleJson 的纯 JSON 请求/解析/取消；
 * 3) 有 BASE 时（npm test 起的临时服务端）验证 /ai/assemble 两条端点与 mode 开关。
 */
import http from 'node:http';
import { applyOps } from '../server/ai/ops.js';
import { loadGeometryKernel } from '../server/ai/kernel.js';
import { planAssembly } from '../server/ai/orchestrator.js';
import { callRoleJson, parseRoleJson, resolveAiConfig } from '../server/ai/provider.js';

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

const mockConfig = resolveAiConfig({ STRU_AI_PROVIDER: 'mock' });
const emptyDoc = {
  schemaVersion: 2, id: 'assembly-test', name: '编排测试', units: 'metric',
  levels: [{ id: 'l1', name: '标高 1', elevation: 0 }],
  grids: [], materials: [], types: [], elements: [],
};

console.log('角色 JSON 解析');
check('带 Markdown 代码块的 JSON 能捞回来', parseRoleJson('好的\n```json\n{"parts":[1,2]}\n```\n完毕')?.parts?.length === 2);
check('前后夹解释文字也能捞回来', parseRoleJson('结果是 {"placements":[]} 就这样')?.placements?.length === 0);
check('纯文本返回 null', parseRoleJson('我看不到图片') === null);

console.log('Mock 全链路（离线，真实几何内核）');
const events = [];
const result = await planAssembly({
  config: mockConfig,
  message: '建一台黄色运动轿跑',
  document: emptyDoc,
  onEvent: (event) => events.push(event),
});
const stages = result.assembly.stages.map((item) => item.name);
check('六个阶段按序走完', stages.join('>') === 'plan>parts>surface>conform>placement>merge', stages);
check('阶段事件推给前端', events.length >= 6 && events.every((event) => event.type === 'status'), events.length);
check('输出唯一一条 addSolid', result.ops.length === 1 && result.ops[0].op === 'addSolid', result.ops.length);
check('顶层特征就是各零件 group', result.ops[0].features.length === 4, result.ops[0].features.length);
check('每个 group 有全局唯一 id', new Set(result.ops[0].features.map((feature) => feature.id)).size === 4);
check('零件清单齐了（含贴合件）', result.assembly.report.parts.map((item) => item.id).join(',') === 'body,wheel-front,wheel-rear,mirror');
check('材质约定挂在 group（预设已展开成色值）', result.ops[0].features.every(
  (feature) => feature.material && typeof feature.material.color === 'string',
), result.ops[0].features.map((feature) => feature.material));
check('特征数在预算内', result.assembly.report.featureCount <= result.assembly.report.limit, result.assembly.report.featureCount);
check('贴合件拿到了主体曲面采样点', result.assembly.samplePoints >= 30, result.assembly.samplePoints);
check('拼接 Agent 给了 3 条变换', result.assembly.placements.length === 4
  && result.assembly.placements.filter((item) => item.translate).length === 3, result.assembly.placements);
check('接缝复核全部贴合', result.assembly.seams.length === 3
  && result.assembly.seams.every((item) => item.relation !== 'gap'), result.assembly.seams);
check('合并后自动巡检视角', result.inspect.length === 3 && result.inspect[0].view === 'front', result.inspect);
check('done=false（交给前端自检闭环继续微调）', result.done === false);
check('产物过服务端 dry-run', applyOps(emptyDoc, result.ops).document.elements.length === 1);
check('无警告', result.assembly.warnings.length === 0, result.assembly.warnings);

console.log('几何内核按需打包');
const kernel = await loadGeometryKernel();
check('内核同一进程复用同一个模块', kernel === await loadGeometryKernel());
const listed = kernel.runQueries(result.ops, [{ type: 'parts', frame: 'root' }]).results[0];
check('查询内核能看到 4 个零件', listed.ok && listed.parts.length === 4, listed);
const gap = kernel.runQueries(result.ops, [{ type: 'gap', frame: 'root', a: 'part-body', b: 'part-mirror' }]).results[0];
check('查询内核能按 group 名算接缝', gap.ok && ['contact', 'intersect'].includes(gap.relation), gap);

/* ---------------- OpenAI 兼容桩：角色调用链 ---------------- */
console.log('OpenAI 兼容上游的角色调用');
const roleCalls = [];
const partIdOf = (payload) => String(payload.messages?.[1]?.content ?? '').match(/【零件 id: ([a-zA-Z0-9_-]+)】/)?.[1] ?? 'body';
const cannedFeatures = {
  body: [
    { shape: 'roundedBox', width: 4.2, depth: 1.8, height: 0.6, radius: 0.28, translate: [0, 0, 0.62] },
    { shape: 'roundedBox', width: 2.1, depth: 1.6, height: 0.5, radius: 0.22, translate: [-0.15, 0, 1.08] },
  ],
  wheel: [
    { shape: 'cylinder', radius: 0.34, height: 0.2, rotate: [90, 0, 0], translate: [0, 0.82, 0], pattern: { type: 'mirror', axis: 'y', center: [0, 0, 0] } },
  ],
  mirror: [{ shape: 'roundedBox', width: 0.22, depth: 0.14, height: 0.1, radius: 0.04 }],
};
const stub = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (chunk) => { raw += chunk; });
  req.on('end', () => {
    const payload = JSON.parse(raw || '{}');
    roleCalls.push(payload);
    const system = String(payload.messages?.[0]?.content ?? '');
    let reply;
    if (system.includes('拆件规划 Agent')) {
      reply = {
        name: '桩服务样车', color: '#e2a32c',
        parts: [
          { id: 'body', name: '车身主轮廓', kind: 'body', brief: '车体', quota: 6, material: 'paintOrange' },
          { id: 'wheel-front', name: '前轮总成', kind: 'independent', brief: '轮胎', quota: 3, material: 'rubber' },
          { id: 'mirror', name: '后视镜', kind: 'conforming', brief: '贴合侧面', quota: 4, material: 'glass', attachTo: 'body' },
        ],
      };
    } else if (system.includes('零件 Agent') || system.includes('贴合件 Agent')) {
      const id = partIdOf(payload);
      reply = { features: id.startsWith('wheel') ? cannedFeatures.wheel : id === 'mirror' ? cannedFeatures.mirror : cannedFeatures.body };
    } else if (system.includes('拼接 Agent')) {
      reply = { placements: [{ part: 'body' }, { part: 'wheel-front', translate: [1.3, 0, 0.34] }, { part: 'mirror', translate: [0.72, 0.78, 1.02] }] };
    } else {
      reply = { ok: true };
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: `分析如下：\n\`\`\`json\n${JSON.stringify(reply)}\n\`\`\`` } }] }));
  });
});
await new Promise((resolve) => stub.listen(0, '127.0.0.1', resolve));
const stubConfig = {
  ...resolveAiConfig({ STRU_AI_PROVIDER: 'openai', STRU_AI_API_KEY: 'test-key' }),
  baseUrl: `http://127.0.0.1:${stub.address().port}/v1`,
  timeoutMs: 5000,
};
const viaStub = await planAssembly({ config: stubConfig, message: '建一台车', document: emptyDoc });
check('桩服务全链路产出唯一 addSolid', viaStub.ops.length === 1 && viaStub.ops[0].op === 'addSolid');
check('桩服务拆出 3 个零件', viaStub.assembly.report.parts.length === 3, viaStub.assembly.report.parts.map((item) => item.id));
check('每类角色都被调用', roleCalls.length >= 5, roleCalls.length);
check('角色请求不带 tools（纯 JSON 子任务）', roleCalls.every((payload) => !payload.tools));
check('角色请求显式 stream:false', roleCalls.every((payload) => payload.stream === false));
check('规划角色拿到了用户需求与预算', String(roleCalls[0].messages?.[1]?.content ?? '').includes('顶层特征预算'));
check('角色输出过服务端 dry-run', applyOps(emptyDoc, viaStub.ops).document.elements.length === 1);

const direct = await callRoleJson(stubConfig, { role: 'probe', system: '探测', user: '给个 JSON' });
check('callRoleJson 可直接单角色调用', direct.ok === true, direct);
const controller = new AbortController();
controller.abort();
let aborted = '';
try {
  await callRoleJson(stubConfig, { role: 'probe', system: '探测', user: '给个 JSON', signal: controller.signal });
} catch (error) {
  aborted = error instanceof Error ? error.message : String(error);
}
check('用户停止时角色调用立即中断', aborted.includes('已停止生成'), aborted);
stub.close();

/* ---------------- HTTP 端点（只在 npm test 的临时服务端里跑） ---------------- */
if (process.env.BASE) {
  const BASE = process.env.BASE;
  const api = async (method, path, { token, body } = {}) => {
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
  };
  const stamp = Date.now();
  const user = (await api('POST', '/api/auth/register', {
    body: { email: `assemble-${stamp}@example.com`, name: '装配测试', password: 'secret123' },
  })).data;
  const token = user.token;
  const project = (await api('POST', '/api/projects', {
    token,
    body: { id: `assemble-project-${stamp}`, name: '装配测试项目', document: emptyDoc },
  })).data.project;
  const root = `/api/projects/${project.id}/ai`;

  console.log('HTTP：/ai/assemble 与 /ai/assemble/stream');
  const once = await api('POST', `${root}/assemble`, { token, body: { message: '建一台黄色运动轿跑' } });
  check('assemble 返回 200', once.status === 200, once.data);
  check('assemble 返回 1 条 addSolid', once.data.ops?.length === 1 && once.data.ops[0].op === 'addSolid', once.data.ops?.length);
  check('assemble 带合并报告', once.data.assembly?.report?.parts?.length === 4, once.data.assembly);
  check('assemble 不落库', (await api('GET', `/api/projects/${project.id}/document`, { token })).data.rev === 1);

  const legacy = await api('POST', `${root}/plan`, { token, body: { message: '建一台车', mode: 'assemble' } });
  check('/ai/plan + mode=assemble 走同一条链', legacy.status === 200 && Boolean(legacy.data.assembly), legacy.data);
  const normal = await api('POST', `${root}/plan`, { token, body: { message: '建一个 6×4 米、层高 3 米的房间' } });
  check('普通 plan 不受影响', normal.status === 200 && normal.data.assembly == null, normal.data);

  const streamResponse = await fetch(BASE + `${root}/assemble/stream`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ message: '建一台车' }),
  });
  const text = await streamResponse.text();
  const frames = text.split('\n').filter((line) => line.startsWith('data:'))
    .map((line) => { try { return JSON.parse(line.slice(5).trim()); } catch { return null; } })
    .filter(Boolean);
  const started = frames[0];
  const final = frames.find((event) => event.type === 'result');
  check('流式是 SSE 且 start 标了 assemble', started?.type === 'start' && started.mode === 'assemble', started);
  check('流式推了多角色阶段状态', frames.filter((event) => event.type === 'status').length >= 6, frames.map((event) => event.type).join(','));
  check('流式 result 带 assembly 报告', Boolean(final?.assembly?.report), final?.assembly && Object.keys(final.assembly));
  check('流式 result 的 ops 与非流式一致', final?.ops?.length === 1, final?.ops?.length);
}

console.log(`\n编排测试：${passed} 通过 / ${failed} 失败`);
process.exit(failed ? 1 : 0);
