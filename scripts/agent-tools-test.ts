/**
 * 通用 agent（注册表驱动的工具循环）测试。
 *
 * 覆盖：
 * 1. 工具注册表：单一真相源、schema 生成、只读工具执行不落库；
 * 2. 知识检索：用户说"坦克履带"能召回 crawler-crane 配方与模型；
 * 3. 多工具解析：一次多个 tool_calls、老格式兼容、纯 JSON 兜底 envelope；
 * 4. 服务端工具循环：只读工具执行后回灌、模型据此再决策；
 * 5. 前端 extractActions：calls[] 拆分、依赖顺序、打转召回换策略。
 */
import {
  toolDefinitions, toolNames, serverToolNames, getTool, runServerTool,
} from '../server/ai/tools.js';
import { searchKnowledge, formatKnowledge } from '../server/ai/knowledge.js';
import { parseToolArguments, runWithToolLoop, createProvider } from '../server/ai/provider.js';
import { extractActions, runAgentLoop } from '../src/ai/agentLoop';

let failed = 0;
function check(name, ok, detail) {
  if (ok) console.log('  ✓', name);
  else { failed += 1; console.log('  ✗', name, detail ?? ''); }
}

// ── 1. 工具注册表 ───────────────────────────────────────────
{
  const names = toolNames();
  check('注册表含三类工具', ['apply_bim_ops', 'inspect', 'search_recipes'].every((n) => names.includes(n)), names);
  check('工具数与 schema 数一致', toolDefinitions().length === names.length);
  check('每个工具都有参数 schema', toolDefinitions().every((d) => d.function.parameters?.properties));
  check('只读工具在服务端', serverToolNames().includes('search_recipes') && serverToolNames().includes('describe_model'));
  check('apply 不在服务端只读列表', !serverToolNames().includes('apply_bim_ops'));
  check('run_python 注册为服务端工具', toolNames().includes('run_python') && serverToolNames().includes('run_python'));
  const pyTool = toolDefinitions().find((d) => d.function.name === 'run_python');
  check('run_python schema 暴露 scripts 与 emit 契约', Boolean(pyTool?.function.parameters?.properties?.scripts)
    && String(pyTool?.function.description).includes('emit'), pyTool?.function.description?.slice(0, 80));
  check('未知工具 getTool 返回 null', getTool('no_such_tool') === null);
  check('客户端工具不在服务端执行', await runServerTool('apply_bim_ops', {}, {}) === null);
}

// ── 2. 知识检索 ─────────────────────────────────────────────
{
  const tank = searchKnowledge('坦克履带轮子');
  check('坦克召回履带吊模型', tank.models.some((m) => m.id === 'crawler-crane'), tank.models);
  check('坦克命中配方章节', tank.recipes.length > 0, tank.recipes.map((r) => r.title));
  check('别名被识别', tank.alias.includes('坦克') || tank.alias.includes('履带'), tank.alias);
  const pavilion = searchKnowledge('古建亭子瓦顶');
  check('古建召回亭子模型', pavilion.models.some((m) => m.id.startsWith('pavilion')), pavilion.models);
  const text = formatKnowledge('坦克履带', { recipeLimit: 1, modelLimit: 2 });
  check('注入文本含配方与模型', text.includes('配方') && text.includes('crawler-crane'));
  check('无匹配时注入文本为空', formatKnowledge('qwertyuiopasdfghjkl', {}) === '');
}

// ── 3. 只读工具执行 ─────────────────────────────────────────
{
  const described = await runServerTool('describe_model', { id: 'crawler-crane' });
  check('describe_model 返回履带吊特征清单', described.ok && described.text.includes('履带'), described.text.slice(0, 80));
  check('describe_model 列出参数或静态说明', /参数|静态/.test(described.text));
  const unknown = await runServerTool('describe_model', { id: 'nonexistent' });
  check('未知模型给出可用 id 提示', unknown.text.includes('未知模型') && unknown.text.includes('crawler-crane'));
  const tree = await runServerTool('inspect_tree', { target: '' }, {
    document: { elements: [{ id: 't1', name: '坦克', primitive: { kind: 'solid', features: [{ label: '履带', shape: { shape: 'sweep' } }] } }] },
  });
  check('inspect_tree 列出特征', tree.ok && tree.text.includes('履带'), tree.text);
}

// ── 3b. run_python 工具：执行脚本、回灌结果、合并脚本 ops 与贴图 ──
{
  const { collectPythonToolResult } = await import('../server/ai/python-runner.js');
  const sink: any[] = [];
  const code = 'import math\npts=[round(0.1*math.cos(2*math.pi*i/9),4) for i in range(9)]\nemit({"result":{"count":len(pts)}})';
  const ran = await runServerTool('run_python', { scripts: [{ code, note: '算点位' }] }, { document: null, pythonSink: sink });
  // 这里经 esbuild 打包，python-runner 的 import.meta.url 指向 .tmp/，bootstrap 路径失效，
  // 因此不要求执行成功（成功执行由 scripts/python-runner-test.mjs 直接 node 跑覆盖）；
  // 只验证工具确实执行了脚本、结果/错误都回灌文字并写进 sink。
  check('run_python 执行脚本并回灌文字', typeof ran.text === 'string' && ran.text.includes('Python 1'), ran.text.slice(0, 160));
  check('run_python 把结果写进 sink', sink.length === 1 && sink[0]?.report?.scripts === 1, sink.length);

  const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==';
  const fakeExecuted = [{ text: '图', requests: [{ code }], images: [{ name: 't', dataUrl: png }], ops: [], report: { mode: 'restricted', isolated: false, scripts: 1, ok: 1, failed: 0, opsCount: 0, images: 1, ms: 1, errors: [] } }];
  const modelOps = [{ op: 'addSolid', name: 'M', features: [{ shape: { shape: 'box', width: 1, depth: 1, height: 1 }, material: { color: '#fff', map: 'python:1' } }] }];
  const merged: any = collectPythonToolResult(fakeExecuted, modelOps, null);
  check('合并阶段把模型 python:1 换成脚本贴图', merged.ops.length === 1
    && String(merged.ops[0].features[0].material.map).startsWith('data:image/png'), merged.ops[0]?.features?.[0]?.material?.map?.slice?.(0, 30));
  check('合并阶段汇总执行报告', merged.report.scripts === 1 && merged.report.ok === 1 && merged.report.images === 1, merged.report);
}

// ── 4. 多工具解析 ───────────────────────────────────────────
{
  const multi = parseToolArguments({
    tool_calls: [
      { id: 'c1', function: { name: 'search_recipes', arguments: '{"query":"坦克履带"}' } },
      { id: 'c2', function: { name: 'apply_bim_ops', arguments: '{"reply":"查到了，用现成模板","ops":[{"op":"addSolid","library":"crawler-crane"}],"done":false}' } },
      { id: 'c3', function: { name: 'inspect', arguments: '{"views":[{"view":"iso"}]}' } },
    ],
  });
  check('解析出 3 个工具调用', multi?.calls?.length === 3, multi?.calls);
  check('按名字分发', multi.calls.map((c) => c.name).join(',') === 'search_recipes,apply_bim_ops,inspect');
  check('保留 tool_call_id', multi.calls[0].id === 'c1');
  check('扁平 ops 视图仍可用', multi.ops.length === 1 && multi.ops[0].library === 'crawler-crane');
  check('扁平 inspect 视图仍可用', multi.inspect.length === 1);
  check('reply 取自 apply 工具', multi.reply.includes('查到了'));

  const old = parseToolArguments({
    tool_calls: [{ function: { name: 'apply_bim_ops', arguments: '{"reply":"旧格式","ops":[],"inspect":[{"view":"front"}],"done":true}' } }],
  });
  check('老格式拆成调用', old.calls.length === 1 && old.inspect.length === 1 && old.done === true);

  const envelope = parseToolArguments({
    content: '{"reply":"json 兜底","tool_calls":[{"name":"finish","arguments":{"note":"好了"}}]}',
  });
  check('纯 JSON envelope 解析', envelope.calls.length === 1 && envelope.calls[0].name === 'finish' && envelope.done === true);

  check('纯文本当作回复', parseToolArguments({ content: '你好' })?.reply === '你好');
}

// ── 5. 服务端工具循环 ───────────────────────────────────────
{
  // 模拟：模型先只调 search_recipes，拿到结果后再调 apply + finish
  const responses = [
    { tool_calls: [{ id: 'r1', function: { name: 'search_recipes', arguments: '{"query":"坦克履带"}' } }] },
    { tool_calls: [
      { id: 'r2', function: { name: 'apply_bim_ops', arguments: '{"reply":"用履带吊模板改","ops":[{"op":"addSolid","library":"crawler-crane"}]}' } },
      { id: 'r3', function: { name: 'finish', arguments: '{"note":"已按模板完成"}' } },
    ] },
  ];
  let turn = 0;
  const seenMessages = [];
  const config = { model: 'test', reasoningEffort: '' };
  const { parsed, toolTurns, degraded } = await runWithToolLoop(config, {
    base: config,
    messages: [{ role: 'user', content: '画坦克' }],
    firstError: { value: null },
    env: { context: {}, document: null },
    invoke: async ({ messages }) => {
      seenMessages.push(messages);
      return responses[Math.min(turn++, responses.length - 1)];
    },
  });
  check('工具循环跑了 2 轮', turn === 2 && toolTurns === 1, { turn, toolTurns });
  check('只读工具执行后才给出建模指令', parsed.ops.length === 1 && parsed.ops[0].library === 'crawler-crane');
  check('finish 转成 done', parsed.done === true);
  check('没有触发降级', degraded === false);
  // Responses API 兼容：回灌轮不能出现 role:tool / tool_calls（否则网关 400）
  const round2 = seenMessages[1] ?? [];
  check('回灌轮无 role:tool 消息', !round2.some((m) => m.role === 'tool'), round2.map((m) => m.role));
  check('回灌轮无 tool_calls 字段', !round2.some((m) => Array.isArray(m.tool_calls) && m.tool_calls.length));
  check('工具结果以纯文本出现', round2.some((m) => m.role === 'user' && String(m.content).includes('crawler-crane')));
}

// ── 6. 前端 extractActions（calls 拆分与依赖） ──────────────
{
  const front = { view: 'front', label: '前视' };
  const actions = extractActions({
    calls: [
      { name: 'search_recipes', args: { query: '坦克' }, side: 'server' },
      { name: 'apply_bim_ops', args: { ops: [{ op: 'addSolid' }] } },
      { name: 'inspect', args: { views: [front] } },
      { name: 'finish', args: { note: 'ok' } },
    ],
  }, true, true);
  check('只读工具被分到 serverCalls', actions.serverCalls.length === 1);
  check('ops/views/finish 分别提取', actions.ops.length === 1 && actions.views.length === 1 && actions.finish === true);
  const legacy = extractActions({ ops: [{ op: 'addSolid' }], done: true });
  check('老决策也能拆出动作', legacy.ops.length === 1 && legacy.finish === true && legacy.serverCalls.length === 0);
  const noTool = extractActions({ calls: [{ name: 'search_recipes', side: 'server' }] }, true, false);
  check('无 callTool 时忽略只读工具', noTool.serverCalls.length === 0);
  // 服务端工具循环已执行过的工具带 result，前端不再重复调用（尤其 run_python 不能跑两遍）
  const already = extractActions({ calls: [
    { name: 'run_python', args: { scripts: [] }, side: 'server', result: '已算完' },
    { name: 'search_recipes', args: { query: 'x' }, side: 'server' },
  ] }, true, true);
  check('已执行的服务端工具不再重复调用', already.serverCalls.length === 1 && already.serverCalls[0].name === 'search_recipes', already.serverCalls.map((c) => c.name));
}

// ── 7. 前端：只读工具回灌 + 打转召回 ────────────────────────
{
  const first = { text: '画坦克', images: [], thumbs: [], files: [], shots: 0 };
  // 模型先查资料（只读工具），查完就 finish
  let turn = 0;
  const calls = [];
  const run = await runAgentLoop(first, {
    goal: '画坦克',
    plan: async (round) => {
      calls.push(round.text);
      turn += 1;
      return turn === 1
        ? { calls: [{ name: 'search_recipes', args: { query: '坦克履带' }, side: 'server', title: '检索建模配方' }], reply: '先查一下' }
        : { done: true, reply: '查到了，用模板完成' };
    },
    apply: async () => ({ note: '' }),
    inspect: async () => [],
    callTool: async () => '履带吊 crawler-crane：闭合 sweep 履带环…',
    stopped: () => false,
  });
  check('只调只读工具也算有效动作', run.reason === 'done' && run.steps === 2, run);
  check('工具结果回灌给模型', calls[1]?.includes('crawler-crane'), calls[1]);
  check('统计了工具调用次数', run.toolCalls === 1, run);

  // 打转时召回换策略：先重复空看两次，召回后给一次带配方的新视角
  let step = 0;
  const front = { view: 'front', label: '前视' };
  let recalled = false;
  const loop = await runAgentLoop(first, {
    goal: '画坦克履带',
    plan: async () => {
      step += 1;
      return { inspect: [front], done: false };
    },
    apply: async () => ({ note: '' }),
    inspect: async () => [{ label: '前视', dataUrl: 'x', thumb: 't' }],
    recall: async () => { recalled = true; return '召回配方：履带是闭合 sweep 环，用 crawler-crane 模板。'; },
    stopped: () => false,
    maxSteps: 6,
  });
  check('打转触发了召回', recalled && loop.recalls >= 1, { recalled, recalls: loop.recalls });
}

// ── 6. plan / planStream 的 document 作用域回归 ─────────────────────────
// 曾经 planStream 签名漏了 document，函数体却引用它 → 一重启就 ReferenceError。
// 用打不通的假地址强制走到底，断言抛的是网络/配置错误而非 ReferenceError。
{
  const ctx = { project: '测试', units: 'meter', coordinateSystem: 'Z-up', levels: [], types: [], grids: [], counts: {}, elements: [], selected: [] };
  const doc = { id: 'd1', grids: [], elements: [], levels: [], types: [] };
  const provider = createProvider({ provider: 'openai', model: 'fake', apiKey: 'sk-fake', baseUrl: 'http://127.0.0.1:1/v1', contextTokens: 8000 });
  for (const [name, run] of [
    ['plan', () => provider.plan({ message: '画坦克', context: ctx, document: doc })],
    ['planStream', () => provider.planStream({ message: '画坦克', context: ctx, document: doc })],
  ]) {
    let msg = '';
    try { await run(); } catch (e) { msg = e instanceof Error ? e.message : String(e); }
    check(`${name} 不再抛 document is not defined`, !/document is not defined/.test(msg), msg.slice(0, 120));
  }
}

console.log(failed === 0 ? '\n通用 agent 测试全部通过' : `\n通用 agent 测试失败：${failed} 项`);
process.exit(failed === 0 ? 0 : 1);
