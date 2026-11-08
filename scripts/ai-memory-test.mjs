/**
 * 长对话「滚动摘要」单测：不连模型、不连库，用桩验证触发条件与写入位置。
 * 这段逻辑决定上下文会不会无限膨胀，写错了要么爆 token，要么把「刚说过的话」压掉。
 */
import {
  compactConversation,
  describeOpsBrief,
  maybeSummarize,
  needsCompact,
  pickChunk,
  SUMMARY_KEEP,
  SUMMARY_TOKEN_TRIGGER,
  SUMMARY_TRIGGER,
} from '../server/ai/memory.js';

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

/** 极简 store 桩：只实现 maybeSummarize 会用到的方法 */
function fakeStore(messages, { summary = null, summarySeq = 0 } = {}) {
  const state = { summary, summarySeq, writes: [] };
  return {
    state,
    getConversation: () => ({ id: 'c1', summary: state.summary, summarySeq: state.summarySeq }),
    listMessages: (id, { afterSeq = state.summarySeq } = {}) => messages.filter((item) => item.seq > afterSeq),
    setConversationSummary(id, text, seq) {
      state.summary = text;
      state.summarySeq = seq;
      state.writes.push({ id, text, seq });
    },
  };
}

function messagesOf(count, pad = 0) {
  return Array.from({ length: count }, (_, index) => ({
    id: `m${index + 1}`,
    seq: index + 1,
    role: index % 2 === 0 ? 'user' : 'assistant',
    content: `第 ${index + 1} 句${pad ? '细节'.repeat(pad / 2) : ''}`,
  }));
}

console.log('触发条件');
{
  const store = fakeStore(messagesOf(SUMMARY_TRIGGER - 1));
  let calls = 0;
  const provider = { async summarize() { calls += 1; return '摘要'; } };
  const result = await maybeSummarize({ store, provider, session: { id: 'c1' }, log: () => {} });
  check('消息不足阈值不压缩', result === null && calls === 0);
}

console.log('压缩窗口');
{
  const total = SUMMARY_TRIGGER + 4;
  const messages = messagesOf(total);
  const store = fakeStore(messages);
  const seen = [];
  const provider = {
    async summarize({ previous, messages: chunk }) {
      seen.push({ previous, count: chunk.length, first: chunk[0].seq, last: chunk.at(-1).seq });
      return '  压缩后的备忘  ';
    },
  };
  const result = await maybeSummarize({ store, provider, session: { id: 'c1' }, log: () => {} });
  check('返回压缩后的摘要（已 trim）', result === '压缩后的备忘', result);
  check('只调用一次', seen.length === 1);
  check(`保留最近 ${SUMMARY_KEEP} 条原文`, seen[0].count === total - SUMMARY_KEEP, seen[0]);
  check('从最新未压缩的那条开始压', seen[0].first === 1);
  check('摘要 seq 指向最后一条被压缩的消息', store.state.summarySeq === total - SUMMARY_KEEP, store.state);
  check('摘要写回会话', store.state.writes.length === 1 && store.state.writes[0].text === '压缩后的备忘');
  check('第一次压缩没有旧备忘', seen[0].previous === '', seen[0].previous);
}

console.log('二次压缩带上旧摘要');
{
  const messages = messagesOf(SUMMARY_TRIGGER + 10);
  const store = fakeStore(messages, { summary: '旧备忘', summarySeq: 4 });
  let previous = null;
  const provider = {
    async summarize({ previous: prev }) {
      previous = prev;
      return '新备忘';
    },
  };
  const result = await maybeSummarize({ store, provider, session: { id: 'c1' }, log: () => {} });
  check('旧摘要作为输入传入', previous === '旧备忘', previous);
  check('新摘要覆盖旧摘要', result === '新备忘' && store.state.writes[0].text === '新备忘');
  check('seq 前进到新的边界', store.state.summarySeq > 4);
}

console.log('异常与降级');
{
  const store = fakeStore(messagesOf(SUMMARY_TRIGGER));
  const provider = { async summarize() { throw new Error('网关 502'); } };
  const logs = [];
  const result = await maybeSummarize({ store, provider, session: { id: 'c1' }, log: (text) => logs.push(text) });
  check('压缩失败返回 null', result === null);
  check('失败不写库', store.state.writes.length === 0);
  check('失败留日志', logs.length === 1 && logs[0].includes('网关 502'), logs);
}
{
  const store = fakeStore(messagesOf(SUMMARY_TRIGGER));
  const result = await maybeSummarize({ store, provider: {}, session: { id: 'c1' }, log: () => {} });
  check('provider 没有 summarize 时跳过', result === null && store.state.writes.length === 0);
}
{
  const store = fakeStore(messagesOf(SUMMARY_TRIGGER));
  const provider = { async summarize() { return '   '; } };
  const result = await maybeSummarize({ store, provider, session: { id: 'c1' }, log: () => {} });
  check('空摘要不写库', result === null && store.state.writes.length === 0);
}

console.log('token 压力触发（条数不够也要压）');
{
  check('少于 4 条不压', needsCompact(messagesOf(3)) === false);
  check('条数到了就压', needsCompact(messagesOf(SUMMARY_TRIGGER)) === true);
  const shortConversation = messagesOf(6);
  check('短消息不触发 token 规则', needsCompact(shortConversation) === false);

  const long = Array.from({ length: 6 }, (_, index) => ({
    id: `m${index}`,
    seq: index + 1,
    role: index % 2 === 0 ? 'user' : 'assistant',
    content: '很长的需求'.repeat(1000),
  }));
  check('长消息按 token 触发', needsCompact(long) === true);
  check('token 阈值确实被超过', long.map((item) => item.content).join('').length > SUMMARY_TOKEN_TRIGGER);

  const store = fakeStore(long);
  const seen = [];
  const provider = { async summarize({ messages: chunk }) { seen.push(chunk.length); return '备忘'; } };
  const result = await maybeSummarize({ store, provider, session: { id: 'c1' }, log: () => {} });
  check('token 触发时也会真压', result === '备忘' && seen.length === 1);
  check('压完 summarySeq 前进', store.state.summarySeq > 0 && store.state.summarySeq < long.length);
}

console.log('分块选择');
{
  const long = Array.from({ length: 30 }, (_, index) => ({
    seq: index + 1,
    role: index % 2 === 0 ? 'user' : 'assistant',
    content: '字'.repeat(1000),
  }));
  const chunk = pickChunk(long, { keep: 6 });
  check('按 token 上限分块，不是一次 24 条', chunk.length >= 10 && chunk.length < 24, chunk.length);
  check('从最旧的一条开始', chunk[0].seq === 1);
  const short = pickChunk(messagesOf(30), { keep: 6 });
  check('短消息按条数上限 24', short.length === 24);
  check('消息不足保留窗口时不压', pickChunk(messagesOf(4), { keep: 6 }).length === 0);
  check('保留条数不会吃掉全部', pickChunk(messagesOf(3), { keep: 6 }).length === 0);
}

console.log('手动压缩（面板上的「压缩」按钮）');
{
  const store = fakeStore(messagesOf(40, 100), { summary: '旧备忘', summarySeq: 10 });
  const calls = [];
  const provider = {
    async summarize({ previous, messages: chunk }) {
      calls.push({ previous, count: chunk.length });
      return `备忘第${calls.length}版`;
    },
  };
  const result = await compactConversation({ store, provider, conversationId: 'c1', log: () => {} });
  check('压到只剩最近 6 条原文', store.state.summarySeq === 34, store.state.summarySeq);
  check('压掉的条数准确', result.compacted === 24, result.compacted);
  check('剩余条数回报正确', result.remaining === 6, result.remaining);
  check('一次调用压满 24 条上限', calls.length === 1 && calls[0].count === 24, calls);
  check('旧摘要作为输入', calls[0].previous === '旧备忘');
  check('before > after', result.before > result.after, { before: result.before, after: result.after });
  check('返回新摘要', result.summary === '备忘第1版');
}
{
  const store = fakeStore(messagesOf(5));
  let called = 0;
  const provider = { async summarize() { called += 1; return '不该被调用'; } };
  const result = await compactConversation({ store, provider, conversationId: 'c1', log: () => {} });
  check('消息太少时不动手', result.compacted === 0 && called === 0 && store.state.writes.length === 0);
}
{
  // 短对话压了反而更大（摘要比被压的原文还长）：要识别出来并告知，而不是白花一次调用
  const store = fakeStore(messagesOf(20));
  let called = 0;
  const provider = { async summarize() { called += 1; return '备忘'; } };
  const result = await compactConversation({ store, provider, conversationId: 'c1', log: () => {} });
  check('历史太短时判定不值得压', result.compacted === 0 && result.reason === 'too-small', result.reason);
  check('不值得压就不调用模型', called === 0);
  check('不做无收益的写入', store.state.writes.length === 0);
}
{
  const store = fakeStore(messagesOf(30, 100));
  const provider = { async summarize() { throw new Error('网关 502'); } };
  let caught = null;
  try {
    await compactConversation({ store, provider, conversationId: 'c1', log: () => {} });
  } catch (error) {
    caught = error;
  }
  check('手动压缩失败要抛给用户（不像自动压缩那样静默）', caught?.message === '网关 502');
  check('失败不写库', store.state.writes.length === 0);
}
{
  const store = fakeStore(messagesOf(30));
  let caught = null;
  try {
    await compactConversation({ store, provider: {}, conversationId: 'c1', log: () => {} });
  } catch (error) {
    caught = error;
  }
  check('provider 不支持摘要时报可操作错误', caught?.message.includes('不支持摘要压缩'), caught?.message);
}

console.log('指令摘要（给历史消息补「上一轮改了什么」）');
{
  check('空输入返回空串', describeOpsBrief([]) === '' && describeOpsBrief(null) === '');
  const text = describeOpsBrief([
    { op: 'addSolid', name: '电动螺丝刀' },
    { op: 'editFeature', target: '电动螺丝刀', feature: '机身' },
    { op: 'deleteFeature' },
  ]);
  check('生成可读标签', text === 'addSolid(电动螺丝刀)、editFeature(电动螺丝刀)、deleteFeature', text);
  check('超过上限截断', describeOpsBrief(Array.from({ length: 20 }, () => ({ op: 'addWall' }))).split('、').length === 12);
}

console.log(`\n长对话记忆测试${failed ? `失败 ${failed} 项` : '通过'}（${passed} 项）`);
if (failed) process.exitCode = 1;
