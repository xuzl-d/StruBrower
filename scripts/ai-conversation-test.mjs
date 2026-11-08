/**
 * AI 会话（长对话 / 历史查看）集成测试。
 *
 * 覆盖：会话 CRUD、消息落库、标题生成、缩略图、已应用标记、跨项目/跨用户权限、
 * 以及「带 conversationId 时服务端以库里的历史为准」这条链路。
 */
const BASE = process.env.BASE ?? 'http://127.0.0.1:8787';

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

const stamp = Date.now();
const alice = (await api('POST', '/api/auth/register', {
  body: { email: `conv-alice-${stamp}@example.com`, name: 'Conv Alice', password: 'secret123' },
})).data;
const token = alice.token;

const document = {
  schemaVersion: 2,
  id: 'conv-doc',
  name: '会话测试项目',
  units: 'metric',
  levels: [{ id: 'l1', name: '标高 1', elevation: 0 }],
  grids: [],
  materials: [{ id: 'm1', name: '混凝土', color: '#a3adb8' }],
  types: [
    { id: 't-wall', category: 'wall', name: '基本墙 200mm', thickness: 0.2, materialId: 'm1' },
    { id: 't-col', category: 'column', name: '矩形柱 400×400', width: 0.4, depth: 0.4, materialId: 'm1' },
    { id: 't-slab', category: 'slab', name: '楼板 150mm', thickness: 0.15, materialId: 'm1' },
  ],
  elements: [],
};

const projectId = `conv-project-${stamp}`;
await api('POST', '/api/projects', {
  token,
  body: { id: projectId, name: '会话测试项目', document },
});
const planPath = `/api/projects/${projectId}/ai/plan`;
const listPath = `/api/projects/${projectId}/ai/conversations`;

// 1×1 的 PNG 缩略图，够小、格式合法
const THUMB = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

console.log('会话 CRUD');
check('未登录列会话 401', (await api('GET', listPath)).status === 401);

const created = await api('POST', listPath, { token, body: {} });
check('创建会话返回 id', created.status === 201 && typeof created.data?.conversation?.id === 'string', created.data);
const conversationId = created.data.conversation.id;

const listed = await api('GET', listPath, { token });
check('列表包含新会话', listed.data.conversations.some((item) => item.id === conversationId));
check('新会话消息数为 0', listed.data.conversations.find((item) => item.id === conversationId)?.messageCount === 0);

console.log('消息落库');
const first = await api('POST', planPath, {
  token,
  body: {
    message: '建一个 6×4 米的房间，加四面墙',
    conversationId,
    imageThumbs: [THUMB, 'not-a-data-url'],
  },
});
check('plan 带回 conversationId', first.status === 200 && first.data.conversationId === conversationId, first.data);
check('plan 带回 messageId', typeof first.data.messageId === 'string' && first.data.messageId.length > 0);

const detail = await api('GET', `/api/ai/conversations/${conversationId}`, { token });
const messages = detail.data?.conversation?.messages ?? [];
check('会话里有两条消息（用户 + 助手）', messages.length === 2, messages.length);
check('第一条是用户消息', messages[0]?.role === 'user');
check('用户消息按 seq 递增', messages[0]?.seq === 1 && messages[1]?.seq === 2);
check('只保留合法缩略图', messages[0]?.thumbs?.length === 1, messages[0]?.thumbs);
check('助手消息带指令', Array.isArray(messages[1]?.ops) && messages[1].ops.length > 0);
check('助手消息带耗时/模型', typeof messages[1]?.model === 'string' && Number.isFinite(messages[1]?.ms));
check('标题取自第一句需求', String(detail.data.conversation.title ?? '').includes('6×4'), detail.data.conversation.title);

console.log('继续同一会话');
const second = await api('POST', planPath, {
  token,
  body: { message: '再加一面 5 米长的墙', conversationId },
});
check('第二轮也成功', second.status === 200, second.data);
const after = await api('GET', `/api/ai/conversations/${conversationId}`, { token });
check('累计四条消息', (after.data?.conversation?.messages ?? []).length === 4);
check('列表消息数同步', (await api('GET', listPath, { token })).data.conversations
  .find((item) => item.id === conversationId)?.messageCount === 4);

console.log('已应用标记');
const mark = await api('PATCH', `/api/ai/conversations/${conversationId}/messages/${first.data.messageId}`, {
  token,
  body: { applied: true, rev: 7 },
});
check('applied 写回成功', mark.status === 200 && mark.data.message.applied === true && mark.data.message.rev === 7, mark.data);
check('未知消息 404', (await api('PATCH', `/api/ai/conversations/${conversationId}/messages/nope`, {
  token, body: { applied: true },
})).status === 404);

console.log('重命名与删除');
const renamed = await api('PATCH', `/api/ai/conversations/${conversationId}`, { token, body: { title: '房间与墙' } });
check('重命名生效', renamed.data?.conversation?.title === '房间与墙', renamed.data);
check('空标题不改', (await api('PATCH', `/api/ai/conversations/${conversationId}`, { token, body: { title: '   ' } }))
  .data?.conversation?.title === '房间与墙');

console.log('权限与会话归属');
const bob = (await api('POST', '/api/auth/register', {
  body: { email: `conv-bob-${stamp}@example.com`, name: 'Conv Bob', password: 'secret123' },
})).data;
check('他人不可读会话 404', (await api('GET', `/api/ai/conversations/${conversationId}`, { token: bob.token })).status === 404);
check('他人不可删会话 404', (await api('DELETE', `/api/ai/conversations/${conversationId}`, { token: bob.token })).status === 404);
check('不存在的会话 404', (await api('GET', '/api/ai/conversations/not-exist', { token })).status === 404);

// 另一个项目的会话不能被这个项目的 plan 借用
const otherProjectId = `conv-other-${stamp}`;
await api('POST', '/api/projects', {
  token,
  body: { id: otherProjectId, name: '另一个项目', document },
});
const otherConversation = (await api('POST', `/api/projects/${otherProjectId}/ai/conversations`, { token, body: {} }))
  .data.conversation;
check('跨项目借会话 400', (await api('POST', planPath, {
  token,
  body: { message: '加一面墙', conversationId: otherConversation.id },
})).status === 400);

console.log('删除');
check('删除成功', (await api('DELETE', `/api/ai/conversations/${conversationId}`, { token })).status === 200);
check('删除后不在列表里', !(await api('GET', listPath, { token })).data.conversations
  .some((item) => item.id === conversationId));
check('删除后读取 404', (await api('GET', `/api/ai/conversations/${conversationId}`, { token })).status === 404);
check('删除后消息一并清掉', (await api('GET', `/api/ai/conversations/${conversationId}/messages/x`, { token })).status === 404);

console.log(`\nAI 会话测试${failed ? `失败 ${failed} 项` : '通过'}（${passed} 项）`);
if (failed) process.exitCode = 1;
