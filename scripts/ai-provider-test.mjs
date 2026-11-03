/** AI provider 适配测试：用本地桩服务模拟 OpenAI 兼容接口，验证工具调用解析与错误处理。 */
import http from 'node:http';
import { createProvider, resolveAiConfig } from '../server/ai/provider.js';

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
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (chunk) => { body += chunk; });
  req.on('end', () => {
    requested.push({ method: req.method, url: req.url, auth: req.headers.authorization, body });
    if (req.url === '/fail/chat/completions') {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'boom' }));
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

server.close();
console.log(`\n${passed} 项通过${failed ? `，${failed} 项失败` : '，全部通过'}`);
process.exit(failed ? 1 : 0);
