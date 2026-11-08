/**
 * 文本附件（上传 txt / md / json / csv / 代码…）测试。
 *
 * 覆盖：纯函数的上限与截断、附件块格式、以及真实链路「附件随消息落库、标题仍取用户那句话」。
 * 附件块格式必须与前端 src/components/AiPanel.tsx 的解析规则一致，改这里要同步那边。
 */
import {
  MAX_ATTACHMENTS,
  MAX_ATTACHMENT_CHARS,
  applyAttachments,
  describeAttachments,
  parseAttachments,
} from '../server/ai/attachments.js';

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

console.log('附件解析与上限');
check('字符串输入被忽略', parseAttachments('oops').length === 0);
check('空文本被忽略', parseAttachments([{ name: 'a.txt', text: '   ' }]).length === 0);
check('最多取 3 个', parseAttachments(Array.from({ length: 5 }, (_, i) => ({ name: `f${i}.txt`, text: 'x' }))).length === MAX_ATTACHMENTS);
check('没名字时给个默认名', parseAttachments([{ text: 'abc' }])[0].name.startsWith('附件'));
check('名字过长被截', parseAttachments([{ name: 'a'.repeat(500), text: 'x' }])[0].name.length === 120);

const long = parseAttachments([{ name: 'big.log', text: 'x'.repeat(MAX_ATTACHMENT_CHARS + 500) }])[0];
check('单个文件按字数截断', long.text.length === MAX_ATTACHMENT_CHARS && long.truncated, long.text.length);
const huge = parseAttachments([
  { name: 'a.txt', text: 'a'.repeat(MAX_ATTACHMENT_CHARS) },
  { name: 'b.txt', text: 'b'.repeat(MAX_ATTACHMENT_CHARS) },
  { name: 'c.txt', text: 'c'.repeat(MAX_ATTACHMENT_CHARS) },
]);
const totalChars = huge.reduce((sum, item) => sum + item.text.length, 0);
check('总量按 24k 封顶', totalChars === 24000, totalChars);
check('额度用完之后的文件不再收', huge.length === 2, huge.length);
const partial = parseAttachments([
  { name: 'a.txt', text: 'a'.repeat(MAX_ATTACHMENT_CHARS) },
  { name: 'b.txt', text: 'b'.repeat(MAX_ATTACHMENT_CHARS - 4000) },
  { name: 'c.txt', text: 'c'.repeat(8000) },
]);
check('最后一个按剩余额度截断', partial.length === 3 && partial[2].text.length === 4000 && partial[2].truncated, partial[2]?.text.length);

console.log('附件块格式（前端按同一规则解析）');
const message = applyAttachments('按附件里的尺寸建一面墙', [
  { name: 'wall.md', text: '外墙 300mm\n净高 3.6m', truncated: false },
  { name: 'noise.csv', text: '1,2,3', truncated: true },
]);
check('没有附件时原样返回', applyAttachments('hi', []) === 'hi');
check('用户那句话在最前', message.startsWith('按附件里的尺寸建一面墙'));
check('带序号与文件名', message.includes('[[附件 1/2：wall.md]]'), message);
check('截断的在块头标出来', message.includes('[[附件 2/2：noise.csv（较长，已截断）]]'), message);
check('每块都有结束标记', (message.match(/\[\[\/附件\]\]/g) ?? []).length === 2);
check('正文在块内', message.includes('外墙 300mm\n净高 3.6m'));
check('审计描述只记名字与规模', describeAttachments([{ name: 'a.md', text: 'x'.repeat(2400), truncated: true }]) === 'a.md 2.4k 字+');

/* ---------- 真实链路 ---------- */
const BASE = process.env.BASE ?? 'http://127.0.0.1:8787';

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

const stamp = Date.now();
const account = (await api('POST', '/api/auth/register', {
  body: { email: `attach-${stamp}@example.com`, name: 'Attach', password: 'secret123' },
})).data;
const token = account.token;

const document = {
  schemaVersion: 2,
  id: 'attach-doc',
  name: '附件测试项目',
  units: 'metric',
  levels: [{ id: 'l1', name: '标高 1', elevation: 0 }],
  grids: [],
  materials: [{ id: 'm1', name: '混凝土', color: '#a3adb8' }],
  types: [],
  elements: [],
};
const projectId = `attach-project-${stamp}`;
await api('POST', '/api/projects', { token, body: { id: projectId, name: '附件测试项目', document } });

const created = await api('POST', `/api/projects/${projectId}/ai/conversations`, { token, body: {} });
const conversationId = created.data?.conversation?.id;
const planPath = `/api/projects/${projectId}/ai/plan`;

console.log('附件随消息落库');
const planned = await api('POST', planPath, {
  token,
  body: {
    message: '按附件里的尺寸建一面墙',
    conversationId,
    attachments: [{ name: 'wall.md', text: '外墙 300mm，净高 3.6m' }],
  },
});
check('带附件也能正常生成', planned.status === 200, planned.data);

const detail = await api('GET', `/api/ai/conversations/${conversationId}`, { token });
const userMessage = (detail.data?.conversation?.messages ?? []).find((item) => item.role === 'user');
check('用户消息落库', Boolean(userMessage));
check('落库内容带附件块', (userMessage?.content ?? '').includes('[[附件 1/1：wall.md]]'), userMessage?.content);
check('落库内容含文件正文', (userMessage?.content ?? '').includes('外墙 300mm，净高 3.6m'));
check('会话标题仍取用户那句话', (detail.data?.conversation?.title ?? '').startsWith('按附件里的尺寸建一面墙'), detail.data?.conversation?.title);

console.log('自检截图标记（气泡里不再冒充用户的参考图）');
const THUMB = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const shotConversation = (await api('POST', `/api/projects/${projectId}/ai/conversations`, { token, body: {} })).data?.conversation?.id;
await api('POST', planPath, {
  token,
  body: {
    message: '看看现在像不像',
    conversationId: shotConversation,
    imageThumbs: [THUMB, THUMB],
    imageShots: 1,
  },
});
const shotDetail = await api('GET', `/api/ai/conversations/${shotConversation}`, { token });
const shotMessage = (shotDetail.data?.conversation?.messages ?? []).find((item) => item.role === 'user');
check('末尾 1 张标成自检截图', shotMessage?.shots === 1 && shotMessage?.thumbs?.length === 2, JSON.stringify({ shots: shotMessage?.shots, thumbs: shotMessage?.thumbs?.length }));
const plainConversation = (await api('POST', `/api/projects/${projectId}/ai/conversations`, { token, body: {} })).data?.conversation?.id;
await api('POST', planPath, { token, body: { message: '建一面墙', conversationId: plainConversation, imageThumbs: [THUMB] } });
const plainDetail = await api('GET', `/api/ai/conversations/${plainConversation}`, { token });
const plainMessage = (plainDetail.data?.conversation?.messages ?? []).find((item) => item.role === 'user');
check('纯参考图不带自检标记', plainMessage?.shots === undefined, plainMessage?.shots);

console.log('边界');
const oversize = await api('POST', planPath, { token, body: { message: 'x'.repeat(4001), attachments: [{ name: 'a.txt', text: 'y' }] } });
check('用户正文超 4000 字仍被拒', oversize.status === 400, oversize.data);
const onlyFiles = await api('POST', planPath, {
  token,
  body: { conversationId, attachments: [{ name: 'brief.txt', text: '一个 6×4 米的房间' }] },
});
check('只给文件、不写字也能发', onlyFiles.status === 200, onlyFiles.data);
const empty = await api('POST', planPath, { token, body: { attachments: [{ name: 'blank.txt', text: '   ' }] } });
check('空附件不算附件，仍提示缺需求', empty.status === 400, empty.data);

console.log(`\n${failed === 0 ? '通过' : '失败'}：${passed} 项通过，${failed} 项失败`);
process.exit(failed === 0 ? 0 : 1);
