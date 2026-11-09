/**
 * 流式请求的自动重试（客户端链路）。
 *
 * 真实场景：隧道 / 反代会掐断长连接，前端拿到的是一个「有 content-type 但没 result 就结束」的流。
 * 这里用假的 fetch 复现各种收尾方式，验证：
 *   - 流被截断 → 自动重试，且两次请求复用同一个 requestId（服务端据此不重复插用户消息）
 *   - 连续中断 3 次才放弃，报错还是那句「没有收到结果」
 *   - 4xx（配置/输入问题）不重试，直接抛给用户
 *   - 用户点「停止」不重试
 *   - 服务端推 error 事件且属于瞬时故障（超时 / 5xx）→ 重试
 */
import { ApiError, createAiApi } from '../src/data/http';

let passed = 0;
let failed = 0;
function check(name: string, ok: boolean, detail?: unknown) {
  if (ok) {
    passed += 1;
    console.log('  ✓', name);
  } else {
    failed += 1;
    console.log('  ✗', name, detail ?? '');
  }
}

const encoder = new TextEncoder();
const frame = (event: Record<string, unknown>) => encoder.encode(`data: ${JSON.stringify(event)}\n\n`);
const SSE = { 'content-type': 'text/event-stream' };

const START = { type: 'start', provider: 'openai', model: 'test-model' };
const RESULT = {
  type: 'result',
  reply: '建好了一面墙',
  ops: [{ op: 'addWall' }],
  summary: {},
  provider: 'openai',
  model: 'test-model',
  mock: false,
};

function streamOf(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
}

type Call = { url: string; body: Record<string, unknown> | null };
let calls: Call[] = [];
let handler: (call: Call, index: number) => Response;

(globalThis as unknown as { fetch: typeof fetch }).fetch = (async (input: unknown, init?: { body?: string }) => {
  const call: Call = {
    url: String(input),
    body: typeof init?.body === 'string' ? JSON.parse(init.body) as Record<string, unknown> : null,
  };
  calls.push(call);
  return handler(call, calls.length);
}) as unknown as typeof fetch;

const api = createAiApi('http://test.local');
const ask = (options: Parameters<typeof api.planStream>[4] = {}) =>
  api.planStream('proj-1', '建一面墙', [], [], options);

/* ---------- 1. 流被截断后自动重试 ---------- */
console.log('流被截断后自动重试');
calls = [];
const retryEvents: string[] = [];
handler = (_call, index) => (index === 1
  // 第一次：只推了 start 和半截草稿，连接就没了（没有 result，也没有 error）
  ? new Response(streamOf([frame(START), frame({ type: 'content', delta: '我先看看…' })]), { status: 200, headers: SSE })
  : new Response(streamOf([frame(START), frame(RESULT)]), { status: 200, headers: SSE }));
const plan = await ask({ onEvent: (event) => retryEvents.push(event.type) });
check('截断后自动重试并拿到结果', plan.reply === '建好了一面墙' && plan.ops.length === 1, plan);
check('一共发了两次请求', calls.length === 2, calls.length);
check('重试前推送 retry 事件', retryEvents.includes('retry'), retryEvents.join(','));
check('两次请求复用同一个 requestId',
  Boolean(calls[0]?.body?.requestId) && calls[0].body?.requestId === calls[1]?.body?.requestId,
  [calls[0]?.body?.requestId, calls[1]?.body?.requestId]);

/* ---------- 2. 连续中断：3 次才放弃 ---------- */
console.log('连续中断');
calls = [];
handler = () => new Response(streamOf([frame(START)]), { status: 200, headers: SSE });
let giveUp = '';
try {
  await ask();
} catch (error) {
  giveUp = error instanceof Error ? error.message : String(error);
}
check('连续中断共尝试 3 次', calls.length === 3, calls.length);
check('最终报错仍是「没有收到结果」', /没有收到结果/.test(giveUp), giveUp);

/* ---------- 3. 4xx 不重试 ---------- */
console.log('不该重试的情况');
calls = [];
handler = () => new Response(JSON.stringify({ error: '需求描述过长' }), {
  status: 400,
  headers: { 'content-type': 'application/json' },
});
let badRequest = '';
try {
  await ask();
} catch (error) {
  badRequest = error instanceof Error ? error.message : String(error);
}
check('400 只发一次请求', calls.length === 1, calls.length);
check('400 的错误原样交给用户', /需求描述过长/.test(badRequest), badRequest);

/* ---------- 4. 用户点停止不重试 ---------- */
calls = [];
handler = () => new Response(streamOf([frame(START)]), { status: 200, headers: SSE });
const controller = new AbortController();
let stopMessage = '';
try {
  await ask({
    signal: controller.signal,
    onEvent: (event) => {
      if (event.type === 'start') controller.abort();
    },
  });
} catch (error) {
  stopMessage = error instanceof Error ? error.message : String(error);
}
check('停止后不再重试', calls.length === 1, calls.length);
check('停止的报错是「已停止生成」', stopMessage === '已停止生成', stopMessage);

/* ---------- 5. 服务端 error 事件：瞬时故障重试 ---------- */
calls = [];
handler = (_call, index) => (index === 1
  ? new Response(streamOf([frame(START), frame({ type: 'error', message: 'AI 服务超时（timeout 180000ms）' })]), { status: 200, headers: SSE })
  : new Response(streamOf([frame(START), frame(RESULT)]), { status: 200, headers: SSE }));
const timeoutPlan = await ask();
check('上游超时后重试并成功', timeoutPlan.reply === '建好了一面墙' && calls.length === 2, calls.length);

/* ---------- 6. 服务端 error 事件：配置类错误不重试 ---------- */
calls = [];
handler = () => new Response(streamOf([
  frame(START),
  frame({ type: 'error', message: '主模型「x」不支持图片输入，请在 AI 设置里启用独立视觉模型' }),
]), { status: 200, headers: SSE });
let configMessage = '';
try {
  await ask();
} catch (error) {
  configMessage = error instanceof Error ? error.message : String(error);
}
check('配置类错误只发一次请求', calls.length === 1, calls.length);
check('配置类错误原样上抛', /独立视觉模型/.test(configMessage), configMessage);

/* ---------- 7. 非 SSE 响应（旧服务端）仍然可用 ---------- */
calls = [];
handler = () => new Response(JSON.stringify({ ...RESULT, type: undefined }), {
  status: 200,
  headers: { 'content-type': 'application/json' },
});
const legacy = await ask();
check('旧服务端退回一次性请求',
  legacy.reply === '建好了一面墙' && calls.length === 2 && calls[1].url.endsWith('/ai/plan'), calls.map((call) => call.url));

check('抛的是 ApiError', new ApiError(502, 'x') instanceof Error);

console.log(`\n流式自动重试测试${failed ? `失败 ${failed} 项` : '通过'}（${passed} 项）`);
if (failed) process.exitCode = 1;
