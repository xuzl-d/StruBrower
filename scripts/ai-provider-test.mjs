/** AI provider 适配测试：用本地桩服务模拟 OpenAI 兼容接口，验证工具调用解析与错误处理。 */
import http from 'node:http';
import { createProvider, resolveAiConfig } from '../server/ai/provider.js';
import { dryRun, planWithRepair } from '../server/ai/repair.js';
import { normalizeImages } from '../server/ai/vision.js';
import { MAX_INSPECT_VIEWS, normalizeInspect } from '../server/ai/inspect.js';

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

const requested = [];
let flakyHits = 0;
let repairHits = 0;

/** 造一个 2mm 级薄板 + 大倒圆的 addSolid（正常需求，但很容易写出越界参数） */
function plateOp(radius) {
  return {
    op: 'addSolid',
    name: '顶盖',
    features: [{ label: '顶盖', shape: { shape: 'roundedBox', width: 0.2, depth: 0.16, height: 0.006, radius } }],
  };
}

const toolReply = (payload) => JSON.stringify({
  choices: [{
    message: {
      content: '',
      tool_calls: [{ type: 'function', function: { name: 'apply_bim_ops', arguments: JSON.stringify(payload) } }],
    },
  }],
});
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (chunk) => { body += chunk; });
  req.on('end', () => {
    requested.push({ method: req.method, url: req.url, auth: req.headers.authorization, body, requestHeaders: req.headers });
    if (req.url === '/fail/chat/completions') {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'boom' }));
      return;
    }
    if (req.url === '/html/chat/completions') {
      // 反代/网关错误页：HTTP 200 + HTML，是最常见的「非 JSON 响应」
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<!doctype html><html><head><title>502 Bad Gateway</title></head><body>gateway</body></html>');
      return;
    }
    if (req.url === '/empty/chat/completions') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('');
      return;
    }
    if (req.url === '/sse/chat/completions') {
      // 网关无视 stream:false，强行按 SSE 返回
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
      send({ choices: [{ delta: { role: 'assistant', content: '' } }] });
      send({ choices: [{ delta: { content: '{"reply":"流式成功","ops":' } }] });
      send({ choices: [{ delta: { content: '[{"op":"addSlab","level":"标高 1","rect":{"x":0,"y":0,"width":2,"depth":2}}]}' } }] });
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }
    if (req.url === '/flaky/chat/completions') {
      flakyHits += 1;
      if (flakyHits === 1) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('');
        return;
      }
    }
    if (req.url === '/stream/chat/completions') {
      // 真正的流式上游：思考过程 + 分片 tool_calls
      res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' });
      const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
      res.write(': ping\n\n');
      send({ choices: [{ delta: { role: 'assistant', content: '' } }] });
      send({ choices: [{ delta: { reasoning_content: '先确定轴距 ' } }] });
      send({ choices: [{ delta: { reasoning_content: '62cm，机臂 45° 布置。' } }] });
      const sendToolArgs = (fragment) => send({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: fragment } }] } }] });
      send({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'apply_bim_ops', arguments: '' } }] } }] });
      sendToolArgs('{"reply":"造好了",');
      sendToolArgs('"ops":[{"op":"addWall","level":"标高 1","start":[0,0],');
      sendToolArgs('"end":[2,0]}]}');
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }
    if (req.url === '/stream-broken/chat/completions') {
      // 流式通道也不给数据：用来验证最终会退回普通请求并报可读错误
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(': ping\n\n');
      res.end();
      return;
    }
    if (req.url === '/unauthorized/chat/completions') {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'invalid api key' } }));
      return;
    }
    if (req.url === '/repair/chat/completions') {
      // 第一次给出越界倒圆（0.2 > min(0.2, 0.16)/2），收到校验反馈后改对
      repairHits += 1;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(toolReply(repairHits === 1
        ? { reply: '造好了顶盖', ops: [plateOp(0.2)] }
        : { reply: '已把倒圆改到 0.08', ops: [plateOp(0.08)] }));
      return;
    }
    if (req.url === '/repair-bad/chat/completions') {
      // 怎么改都越界：用来验证只修正一轮、并把问题原样交回前端
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(toolReply({ reply: '顶盖', ops: [plateOp(0.2)] }));
      return;
    }
    if (req.url === '/vision/models' || req.url === '/inline/models') {
      // 网关模型清单：只有 vision-model 支持 image 输入
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        data: req.url === '/inline/models'
          ? [{ id: 'vision-model', input_modalities: ['text', 'image'] }]
          : [
            { id: 'text-model', input_modalities: ['text'] },
            { id: 'vision-model', input_modalities: ['text', 'image'] },
          ],
      }));
      return;
    }
    if (req.url === '/vision/chat/completions') {
      const payload = JSON.parse(body || '{}');
      const userMessage = payload.messages?.find((message) => Array.isArray(message.content));
      const hasImage = Boolean(userMessage?.content?.some((part) => part.type === 'image_url'));
      if (!payload.tools) {
        // 读图请求：返回结构化规格（没有 tools 说明这是视觉通道）
        if (!hasImage) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { message: '读图请求里没有图片' } }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          choices: [{
            message: {
              content: '```json\n' + JSON.stringify({
                object: '陶瓷马克杯',
                bbox_mm: { length: 90, width: 90, height: 105 },
                parts: [
                  { name: '杯体', shape: 'tube', size_mm: { radius: 45, height: 105, thickness: 4 }, material: 'ceramic' },
                  { name: '手柄', shape: 'sweep', material: 'ceramic' },
                ],
                uncertain: ['壁厚按 4mm 估'],
              }) + '\n```',
            },
          }],
        }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(toolReply({ reply: '照图建了一个陶瓷杯', ops: [{ op: 'addSolid', name: '陶瓷杯', features: [] }] }));
      return;
    }
    if (req.url === '/blind/models') {
      // 只回 id/owned_by、完全不说模态（cc.yjk.cn 这类网关）。判成「不知道」→ 按能读图试。
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'mystery-model', object: 'model', owned_by: 'openai', type: 'model' }] }));
      return;
    }
    if (req.url === '/blind/chat/completions') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(toolReply({ reply: '看图建好了', ops: [{ op: 'addSolid', name: '看图产物', features: [] }] }));
      return;
    }
    if (req.url === '/inline/chat/completions') {
      // 主模型自己就能读图：图片应当内联进建模请求，不额外走描述通道
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(toolReply({ reply: '看图建好了', ops: [{ op: 'addSolid', name: '看图产物', features: [] }] }));
      return;
    }
    if (req.url === '/inspect/chat/completions') {
      // 只想先看模型：ops 为空、给出若干视角（含一个非法视角，应被丢掉）
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(toolReply({
        reply: '先切三个视角看一眼',
        ops: [],
        inspect: ['front', { azimuth: 200, elevation: 120 }, { view: 'bogus' }, { view: 'top' }],
      }));
      return;
    }
    if (req.url === '/thinking/chat/completions') {
      // 模拟 qwen3 / GLM 等 thinking 模型的真实返回：带 tools 时拒绝工具调用
      const payload = JSON.parse(body || '{}');
      if (Array.isArray(payload.tools) && payload.tools.length) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'Thinking mode does not support this tool_choice', type: 'invalid_request_error' } }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        choices: [{ message: { content: '{"reply":"降级成功","ops":[{"op":"addColumn","level":"标高 1","position":[1,1]}]}' } }],
      }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    if (req.url === '/content/chat/completions') {
      res.end(JSON.stringify({
        choices: [{ message: { content: '```json\n{"reply":"用内容里的 JSON","ops":[{"op":"addWall","level":"标高 1","start":[0,0],"end":[2,0]}]}\n```' } }],
      }));
      return;
    }
    res.end(JSON.stringify({
      choices: [{
        message: {
          content: '',
          tool_calls: [{
            type: 'function',
            function: {
              name: 'apply_bim_ops',
              arguments: JSON.stringify({
                reply: '好的，建一面墙',
                ops: [{ op: 'addWall', level: '标高 1', start: [0, 0], end: [3, 0] }],
              }),
            },
          }],
        },
      }],
    }));
  });
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
const baseUrl = `http://127.0.0.1:${port}`;

console.log('配置解析');
const mockConfig = resolveAiConfig({});
check('默认 mock 且 ready', mockConfig.provider === 'mock' && mockConfig.ready === true, mockConfig);
const openaiConfig = resolveAiConfig({ STRU_AI_PROVIDER: 'openai', STRU_AI_API_KEY: 'sk-test', STRU_AI_MODEL: 'test-model' });
check('openai 配置读取', openaiConfig.provider === 'openai' && openaiConfig.model === 'test-model' && openaiConfig.ready === true, openaiConfig);
const noKey = resolveAiConfig({ STRU_AI_PROVIDER: 'openai' });
check('无 key 时 ready=false', noKey.provider === 'openai' && noKey.ready === false, noKey);

console.log('工具调用解析');
const provider = createProvider({ provider: 'openai', baseUrl, model: 'test-model', apiKey: 'sk-test', timeoutMs: 5000, ready: true });
const plan = await provider.plan({
  message: '建一面 3 米的墙',
  context: { levels: [{ name: '标高 1', elevation: 0 }], types: [{ name: '基本墙 200mm', category: 'wall' }] },
});
check('解析 tool_calls', plan.reply === '好的，建一面墙' && plan.ops.length === 1 && plan.ops[0].op === 'addWall', plan);
check('携带 Bearer key', requested[0]?.auth === 'Bearer sk-test', requested[0]?.auth);
check('请求体包含 tools', JSON.parse(requested[0].body).tools?.[0]?.function?.name === 'apply_bim_ops');
check('不强制 tool_choice（thinking 模型会 400）', !('tool_choice' in JSON.parse(requested[0].body)), Object.keys(JSON.parse(requested[0].body)));

console.log('兜底与错误');
const contentProvider = createProvider({ provider: 'openai', baseUrl: `${baseUrl}/content`, model: 'm', apiKey: 'sk-test', timeoutMs: 5000, ready: true });
const fromContent = await contentProvider.plan({ message: '随便', context: {} });
check('从 content JSON 解析', fromContent.ops.length === 1 && fromContent.ops[0].op === 'addWall', fromContent);

const failing = createProvider({ provider: 'openai', baseUrl: `${baseUrl}/fail`, model: 'm', apiKey: 'sk-test', timeoutMs: 5000, ready: true });
let errorMessage = '';
try {
  await failing.plan({ message: 'x', context: {} });
} catch (error) {
  errorMessage = error instanceof Error ? error.message : String(error);
}
check('非 2xx 抛出可读错误', errorMessage.includes('500'), errorMessage);

console.log('thinking 模式降级');
const thinkingBase = requested.length;
const thinking = createProvider({ provider: 'openai', baseUrl: `${baseUrl}/thinking`, model: 'qwen3-max', apiKey: 'sk-test', timeoutMs: 5000, ready: true });
const downgraded = await thinking.plan({ message: '加一根柱', context: { levels: [{ name: '标高 1', elevation: 0 }] } });
check('带 tools 被 400 后自动降级', downgraded.reply === '降级成功' && downgraded.ops[0]?.op === 'addColumn', downgraded);
check('降级结果带 degraded 标记', downgraded.degraded === true, downgraded);
const attempts = requested.slice(thinkingBase).map((item) => JSON.parse(item.body));
check('第一次尝试带 tools', Array.isArray(attempts[0]?.tools) && attempts[0].tools.length === 1, attempts[0] && Object.keys(attempts[0]));
check('降级请求不带 tools', !('tools' in (attempts[1] ?? {})), attempts[1] && Object.keys(attempts[1]));
check('降级请求去掉 temperature', !('temperature' in (attempts[1] ?? {})), attempts[1] && Object.keys(attempts[1]));
check('降级请求附加 JSON 指令', String(attempts[1]?.messages?.at(-1)?.content ?? '').includes('严格') || String(attempts[1]?.messages?.at(-1)?.content ?? '').includes('JSON'));

console.log('认证错误不重试');
const unauthorizedBase = requested.length;
const unauthorized = createProvider({ provider: 'openai', baseUrl: `${baseUrl}/unauthorized`, model: 'm', apiKey: 'sk-bad', timeoutMs: 5000, ready: true });
let unauthorizedError = '';
try {
  await unauthorized.plan({ message: 'x', context: {} });
} catch (error) {
  unauthorizedError = error instanceof Error ? error.message : String(error);
}
check('401 直接抛出且带状态码', unauthorizedError.includes('401'), unauthorizedError);
check('401 不触发降级重试', requested.length - unauthorizedBase === 1, requested.length - unauthorizedBase);

console.log('上游异常响应（非 JSON / 空响应 / SSE）');
check('请求体显式 stream:false', JSON.parse(requested[0].body).stream === false, Object.keys(JSON.parse(requested[0].body)));

const htmlBase = requested.length;
const htmlProvider = createProvider({ provider: 'openai', baseUrl: `${baseUrl}/html`, model: 'm', apiKey: 'sk-test', timeoutMs: 5000, ready: true });
let htmlError = '';
try {
  await htmlProvider.plan({ message: 'x', context: {} });
} catch (error) {
  htmlError = error instanceof Error ? error.message : String(error);
}
check('返回网页时说明是网页而非接口数据', htmlError.includes('非 JSON') && htmlError.includes('网页'), htmlError);
check('200 非 JSON 自动重试一次', requested.length - htmlBase === 2, requested.length - htmlBase);

const emptyBase = requested.length;
const emptyProvider = createProvider({ provider: 'openai', baseUrl: `${baseUrl}/empty`, model: 'm', apiKey: 'sk-test', timeoutMs: 5000, ready: true });
let emptyError = '';
try {
  await emptyProvider.plan({ message: 'x', context: {} });
} catch (error) {
  emptyError = error instanceof Error ? error.message : String(error);
}
check('空响应提示「响应体为空」', emptyError.includes('响应体为空'), emptyError);
check('空响应重试后改走流式通道再试', requested.length - emptyBase === 3, requested.length - emptyBase);

const sseProvider = createProvider({ provider: 'openai', baseUrl: `${baseUrl}/sse`, model: 'm', apiKey: 'sk-test', timeoutMs: 5000, ready: true });
const fromSse = await sseProvider.plan({ message: 'x', context: { levels: [{ name: '标高 1', elevation: 0 }] } });
check('SSE 流能拼成完整响应', fromSse.reply === '流式成功' && fromSse.ops[0]?.op === 'addSlab', fromSse);

const flakyProvider = createProvider({ provider: 'openai', baseUrl: `${baseUrl}/flaky`, model: 'm', apiKey: 'sk-test', timeoutMs: 5000, ready: true });
const flakyPlan = await flakyProvider.plan({ message: '建一面墙', context: {} });
check('偶发空响应重试后成功', flakyPlan.ops.length === 1 && flakyPlan.ops[0].op === 'addWall', flakyPlan);

console.log('流式（SSE）');
const streamEvents = [];
const streamBase = requested.length;
const streamProvider = createProvider({ provider: 'openai', baseUrl: `${baseUrl}/stream`, model: 'stream-model', apiKey: 'sk-test', timeoutMs: 5000, ready: true });
const streamed = await streamProvider.planStream({
  message: '造一台无人机',
  context: { levels: [{ name: '标高 1', elevation: 0 }] },
  onEvent: (event) => streamEvents.push(event),
});
check('流式请求带 stream:true', JSON.parse(requested[streamBase].body).stream === true, JSON.parse(requested[streamBase].body).stream);
check('请求 Accept: text/event-stream', requested[streamBase].requestHeaders?.accept === 'text/event-stream', requested[streamBase].requestHeaders?.accept);
check('流式解析出 tool_calls', streamed.reply === '造好了' && streamed.ops[0]?.op === 'addWall', streamed);
const reasoning = streamEvents.filter((event) => event.type === 'reasoning').map((event) => event.delta).join('');
check('思考过程逐块回调', reasoning === '先确定轴距 62cm，机臂 45° 布置。', reasoning);
check('回调工具调用事件', streamEvents.some((event) => event.type === 'tool' && event.name === 'apply_bim_ops'), streamEvents.map((event) => event.type).join(','));
check('回调参数生成进度', streamEvents.some((event) => event.type === 'plan' && event.chars > 0), streamEvents.filter((event) => event.type === 'plan').length);

// 上游不支持流式（直接回整段 JSON）：也要能出结果
const jsonStreamEvents = [];
const jsonStreamProvider = createProvider({ provider: 'openai', baseUrl, model: 'm', apiKey: 'sk-test', timeoutMs: 5000, ready: true });
const jsonStreamPlan = await jsonStreamProvider.planStream({ message: '建一面墙', context: {}, onEvent: (event) => jsonStreamEvents.push(event) });
check('流式请求遇到 JSON 上游也能解析', jsonStreamPlan.ops[0]?.op === 'addWall', jsonStreamPlan);

// 流式通道完全为空：退回普通请求，最终给出可读错误（而不是挂住）
const brokenProvider = createProvider({ provider: 'openai', baseUrl: `${baseUrl}/stream-broken`, model: 'm', apiKey: 'sk-test', timeoutMs: 5000, ready: true });
let brokenError = '';
try {
  await brokenProvider.planStream({ message: 'x', context: {}, onEvent: () => {} });
} catch (error) {
  brokenError = error instanceof Error ? error.message : String(error);
}
check('流式无数据时给出可读错误', brokenError.length > 0 && /非 JSON|响应体为空|无法解析/.test(brokenError), brokenError);

console.log('看图建模（主模型 / 独立视觉模型）');
const TINY_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const imageList = normalizeImages([{ dataUrl: TINY_PNG }]);
check('解析 dataURL 图片并算出字节数', imageList.length === 1 && imageList[0].bytes > 0, imageList[0]);
let badImage = '';
try {
  normalizeImages(['https://example.com/a.png']);
} catch (error) {
  badImage = error instanceof Error ? error.message : String(error);
}
check('非 dataURL 图片被拒', badImage.includes('dataURL'), badImage);
check('图片数量上限生效', (() => {
  try {
    normalizeImages(Array.from({ length: 5 }, () => ({ dataUrl: TINY_PNG })));
    return false;
  } catch {
    return true;
  }
})());

// 主模型不支持图片 + 未启用独立视觉模型：直接给可操作的错误，不自动挑模型
const noVisionProvider = createProvider({
  provider: 'openai', baseUrl: `${baseUrl}/vision`, model: 'text-model', apiKey: 'sk-test', timeoutMs: 5000, ready: true,
  vision: { enabled: false, model: '', baseUrl: '', apiKey: '' },
});
let noVisionError = '';
try {
  await noVisionProvider.plan({ message: '照图建模', context: {}, images: imageList });
} catch (error) {
  noVisionError = error instanceof Error ? error.message : String(error);
}
check('主模型不支持且未启用视觉模型时报错', /独立视觉模型/.test(noVisionError), noVisionError);
check('报错里点名主模型不能读图', noVisionError.includes('text-model'), noVisionError);

// 主模型不支持 + 用户启用独立视觉模型（独立地址 / 独立 Key）
const visionEvents = [];
const visionBase = requested.length;
const visionProvider = createProvider({
  provider: 'openai', baseUrl: `${baseUrl}/vision`, model: 'text-model', apiKey: 'sk-main', timeoutMs: 5000, ready: true,
  vision: { enabled: true, model: 'vision-model', baseUrl: `${baseUrl}/vision`, apiKey: 'sk-vision' },
});
const visionPlan = await visionProvider.planStream({
  message: '照这张图建一个杯子',
  context: { levels: [{ name: '标高 1', elevation: 0 }] },
  images: imageList,
  onEvent: (event) => visionEvents.push(event),
});
check('主模型无视觉能力时改用用户填的视觉模型', visionPlan.vision?.model === 'vision-model' && visionPlan.vision?.inline === false, visionPlan.vision);
check('返回识别到的物体与零件数', visionPlan.vision?.object === '陶瓷马克杯' && visionPlan.vision?.parts === 2, visionPlan.vision);
check('流式通道推送读图事件', visionEvents.some((event) => event.type === 'vision' && event.object === '陶瓷马克杯'), visionEvents.map((event) => event.type).join(','));
const visionCall = requested.slice(visionBase).find((item) => item.url === '/vision/chat/completions' && !JSON.parse(item.body).tools);
check('读图请求用的是视觉模型的独立 Key', visionCall?.auth === 'Bearer sk-vision', visionCall?.auth);
check('读图请求带 image_url', JSON.stringify(JSON.parse(visionCall?.body ?? '{}')).includes('image_url'));
const planningCall = requested.slice(visionBase).filter((item) => item.url === '/vision/chat/completions' && JSON.parse(item.body).tools).at(-1);
check('建模请求里带上了视觉规格', String(JSON.parse(planningCall?.body ?? '{}').messages?.at(-1)?.content).includes('【参考图片的视觉分析】'));
check('建模请求不再重复带图片（已转成文字）', !JSON.stringify(JSON.parse(planningCall?.body ?? '{}').messages).includes('image_url'));
check('建模请求仍用主模型与主 Key', JSON.parse(planningCall?.body ?? '{}').model === 'text-model' && planningCall?.auth === 'Bearer sk-main');

// 主模型自己就能读图：图片内联进建模请求，不走描述通道
const inlineBase = requested.length;
const inlineProvider = createProvider({
  provider: 'openai', baseUrl: `${baseUrl}/inline`, model: 'vision-model', apiKey: 'sk-test', timeoutMs: 5000, ready: true,
  vision: { enabled: true, model: 'vision-model', baseUrl: '', apiKey: '' },
});
const inlinePlan = await inlineProvider.plan({ message: '照这张图建一个杯子', context: {}, images: imageList });
check('主模型能读图时走内联直传', inlinePlan.vision?.inline === true && inlinePlan.vision?.model === 'vision-model', inlinePlan.vision);
check('内联请求体包含 image_url', JSON.stringify(JSON.parse(requested[requested.length - 1].body).messages).includes('image_url'));
const inlineCalls = requested.slice(inlineBase).filter((item) => item.url.endsWith('/chat/completions')).length;
check('内联只发 1 次模型请求', inlineCalls === 1, inlineCalls);

// 网关不报模态（只回 id/owned_by）：必须当「不知道」，按能读图内联试，不能误判成纯文本
const blindBase = requested.length;
const blindProvider = createProvider({
  provider: 'openai', baseUrl: `${baseUrl}/blind`, model: 'mystery-model', apiKey: 'sk-test', timeoutMs: 5000, ready: true,
  vision: { enabled: false, model: '', baseUrl: '', apiKey: '' },
});
const blindPlan = await blindProvider.plan({ message: '照这张图建模', context: {}, images: imageList });
check('网关不报模态时不误判成纯文本', blindPlan.vision?.inline === true, blindPlan.vision);
check('网关不报模态时图片内联直传', JSON.stringify(JSON.parse(requested[requested.length - 1].body).messages).includes('image_url'));
check('网关不报模态时只发 1 次请求', requested.slice(blindBase).filter((item) => item.url.endsWith('/chat/completions')).length === 1);

console.log('生成阶段的预校验与自动修正');const repairDoc = {
  schemaVersion: 2,
  id: 'doc-repair',
  name: '预校验测试',
  units: 'metric',
  levels: [{ id: 'l1', name: '标高 1', elevation: 0 }],
  grids: [],
  materials: [{ id: 'm1', name: '铝合金', color: '#9aa7b4' }],
  types: [],
  elements: [],
};
const repairEvents = [];
const repairBase = requested.length;
const repairProvider = createProvider({ provider: 'openai', baseUrl: `${baseUrl}/repair`, model: 'm', apiKey: 'sk-test', timeoutMs: 5000, ready: true });
const repaired = await planWithRepair({
  run: (args) => repairProvider.plan(args),
  message: '做一个 200×160、6mm 厚、带圆角的顶盖',
  context: { levels: [{ name: '标高 1', elevation: 0 }] },
  history: [],
  document: repairDoc,
  onEvent: (event) => repairEvents.push(event),
});
check('越界参数自动修正一轮', repaired.repaired === 1, repaired.repaired);
check('修正后的指令通过预校验', dryRun(repairDoc, repaired.result.ops) === null, dryRun(repairDoc, repaired.result.ops));
check('修正请求带回了校验反馈',
  String(JSON.parse(requested[requested.length - 1].body).messages.at(-1).content).includes('服务端校验反馈'));
check('修正过程有阶段提示', repairEvents.some((event) => event.type === 'status' && event.text.includes('自动修正')), repairEvents.map((event) => event.type).join(','));

const warnProvider = createProvider({ provider: 'openai', baseUrl: `${baseUrl}/repair-bad`, model: 'm', apiKey: 'sk-test', timeoutMs: 5000, ready: true });
const warnBase = requested.length;
const warned = await planWithRepair({
  run: (args) => warnProvider.plan(args),
  message: '做一个顶盖',
  context: { levels: [{ name: '标高 1', elevation: 0 }] },
  history: [],
  document: repairDoc,
  onEvent: () => {},
});
check('改不好时保留指令并给出 warning', warned.repaired === 0 && String(warned.warning).includes('radius'), warned.warning);
check('最多只修正一轮（共 2 次请求）', requested.length - warnBase === 2, requested.length - warnBase);
check('预校验能挡住越界倒圆', dryRun(repairDoc, [plateOp(0.2)])?.includes('min(width, depth)/2'), dryRun(repairDoc, [plateOp(0.2)]));

console.log('视角巡检（AI 自己转视角看模型）');
check('工具参数里有 inspect 字段',
  JSON.parse(requested[0].body).tools?.[0]?.function?.parameters?.properties?.inspect?.type === 'array');
const inspectProvider = createProvider({ provider: 'openai', baseUrl: `${baseUrl}/inspect`, model: 'm', apiKey: 'sk-test', timeoutMs: 5000, ready: true });
const inspectPlan = await inspectProvider.plan({ message: '转一圈看看哪里不对', context: {} });
check('解析出视角请求', inspectPlan.inspect?.length === 3, inspectPlan.inspect);
check('巡检轮 ops 为空', inspectPlan.ops.length === 0, inspectPlan.ops);
check('预设视角带中文名', inspectPlan.inspect?.[0]?.view === 'front' && inspectPlan.inspect[0].label === '前视', inspectPlan.inspect?.[0]);
check('自定义角度被归一化（仰角夹到 ±88）',
  inspectPlan.inspect?.[1]?.azimuth === 200 && inspectPlan.inspect[1].elevation === 88, inspectPlan.inspect?.[1]);
check('非法视角被丢弃、顺序保持', inspectPlan.inspect?.[2]?.view === 'top', inspectPlan.inspect?.map((item) => item.view));
check('字符串写法也能认', normalizeInspect('back')[0]?.view === 'back', normalizeInspect('back'));
check('最多 4 个视角', normalizeInspect(['front', 'back', 'left', 'right', 'top', 'bottom']).length === MAX_INSPECT_VIEWS);
check('负方位角换算到 0–360', normalizeInspect([{ azimuth: -30, elevation: 0 }])[0]?.azimuth === 330, normalizeInspect([{ azimuth: -30, elevation: 0 }]));
check('缺角度的对象被丢弃', normalizeInspect([{ view: 'nope' }, {}, 42, null]).length === 0, normalizeInspect([{ view: 'nope' }, {}, 42, null]));

server.close();
console.log(`\n${passed} 项通过${failed ? `，${failed} 项失败` : '，全部通过'}`);
process.exit(failed ? 1 : 0);
