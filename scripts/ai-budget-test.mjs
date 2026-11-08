/**
 * 上下文预算单测：不连模型、不连库。
 * 这段逻辑决定「一次请求到底塞多少东西」，写错了要么爆 token，要么把模型正在改的
 * 特征树截掉（早期就是 JSON 硬切 24000 字符，切出半截结构）。
 */
import {
  contextWindowOf,
  estimateTokens,
  fitHistory,
  planBudget,
  trimProjectContext,
  HISTORY_ITEM_TOKENS,
} from '../server/ai/budget.js';
import { buildPrompt } from '../server/ai/provider.js';

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

console.log('token 估算');
{
  check('空输入是 0', estimateTokens('') === 0 && estimateTokens(null) === 0 && estimateTokens(undefined) === 0);
  const cn = estimateTokens('脚手架塔吊');
  check('中文按 1 字 ≈ 1 token', cn >= 5 && cn <= 7, cn);
  const en = estimateTokens('the quick brown fox jumps over the lazy dog');
  check('英文约 3.4 字符/token', en >= 9 && en <= 14, en);
  check('对象按 JSON 估', estimateTokens({ a: 1 }) > 0);
  check('估算随长度单调增长', estimateTokens('一二三四五六七八九十') > estimateTokens('一二三'));
}

console.log('窗口分档');
{
  check('deepseek → 128k', contextWindowOf('deepseek-v4-pro') === 128_000);
  check('claude → 200k', contextWindowOf('claude-3-5-sonnet') === 200_000);
  check('gemini 1.5 → 1M', contextWindowOf('gemini-1.5-pro') === 1_000_000);
  check('认不出来按 64k 保守处理', contextWindowOf('some-private-model') === 64_000);
  check('显式配置优先', contextWindowOf('deepseek-chat', 32_000) === 32_000);
  check('非法配置被忽略', contextWindowOf('deepseek-chat', 0) === 128_000 && contextWindowOf('x', -5) === 64_000);
  check('上限 2M', contextWindowOf('x', 9_000_000) === 2_000_000);
}

console.log('预算分配');
{
  const small = planBudget({ model: 'some-private-model', systemTokens: 8000, messageTokens: 300, imageCount: 1 });
  const large = planBudget({ model: 'gemini-1.5-pro', systemTokens: 8000, messageTokens: 300, imageCount: 1 });
  check('大窗口给的历史更多', large.history > small.history, { small: small.history, large: large.history });
  check('留出输出额度', small.output > 0 && small.output < small.window);
  check('三段加起来不超过可用额度', small.memory + small.project + small.history <= small.available + 1);
  check('窗口很小也给历史保底', planBudget({ model: 'x', contextTokens: 8000, systemTokens: 6000 }).history >= 600);
  check('图片算进固定开销', planBudget({ model: 'x', contextTokens: 32000, imageCount: 3 }).available
    < planBudget({ model: 'x', contextTokens: 32000, imageCount: 0 }).available);
}

console.log('历史裁剪');
{
  const short = [
    { role: 'user', content: '做一把螺丝刀' },
    { role: 'assistant', content: '好的，先建机身' },
  ];
  const fit = fitHistory(short, 4000);
  check('放得下就全留', fit.items.length === 2 && fit.dropped === 0);
  check('顺序不变', fit.items[0].content === '做一把螺丝刀');

  const many = Array.from({ length: 60 }, (_, index) => ({
    role: index % 2 === 0 ? 'user' : 'assistant',
    content: `第 ${index + 1} 轮：${'细节'.repeat(120)}`,
  }));
  const tight = fitHistory(many, 2000);
  check('预算紧时只留最新的几条', tight.items.length > 0 && tight.items.length < 10, tight.items.length);
  check('最后一条一定在', tight.items.at(-1)?.content.startsWith('第 60 轮'));
  check('丢弃条数 = 总数 - 保留数', tight.dropped === many.length - tight.items.length, tight.dropped);
  check('总 token 不超预算', tight.tokens <= 2000, tight.tokens);

  const huge = fitHistory([{ role: 'user', content: '长'.repeat(20000) }], 100_000);
  check('单条超长被截断', estimateTokens(huge.items[0].content) <= HISTORY_ITEM_TOKENS + 20);
  check('截断有标记', huge.items[0].content.includes('已截断'));

  const dirty = fitHistory([
    { role: 'system', content: 'x' },
    { role: 'user', content: 123 },
    { role: 'user', content: '正常' },
    null,
  ], 4000);
  check('过滤 system / 非字符串 / null', dirty.items.length === 1 && dirty.items[0].content === '正常');
}

function makeContext(elementCount, featureCount) {
  const elements = Array.from({ length: elementCount }, (_, index) => ({
    id: `e${index}`,
    name: `构件 ${index}`,
    category: 'solid',
    level: '标高 1',
    type: null,
    position: [0, 0],
    solid: {
      featureCount,
      features: Array.from({ length: featureCount }, (_, feature) => ({
        index: feature + 1,
        id: `f${index}-${feature}`,
        label: `零件 ${feature}`,
        shape: { type: 'roundedBox', width: 0.04, depth: 0.04, height: 0.2, radius: 0.005 },
        material: { name: 'aluminum', color: '#c8ccd2' },
      })),
    },
  }));
  return {
    project: 'proj',
    units: 'meter',
    coordinateSystem: 'Z-up',
    levels: [{ name: '标高 1', elevation: 0 }],
    types: [],
    grids: [],
    counts: { solid: elementCount },
    selected: [elements[0]],
    elements,
  };
}

console.log('项目上下文结构化裁剪');
{
  const small = makeContext(2, 3);
  const kept = trimProjectContext(small, 12_000);
  check('装得下就原样保留', kept.omitted.elements === 0 && kept.omitted.features === 0);
  check('特征不降档', kept.featureLimit === 48);
  check('骨架字段完整', kept.context.levels.length === 1 && kept.context.coordinateSystem === 'Z-up');

  const big = makeContext(120, 48);
  const trimmed = trimProjectContext(big, 6000);
  check('超预算时裁剪', trimmed.tokens <= 6000 * 1.2, trimmed.tokens);
  check('给出省略统计', trimmed.omitted.elements > 0 || trimmed.omitted.features > 0, trimmed.omitted);
  check('用结构化省略而不是切 JSON', typeof trimmed.context === 'object' && Array.isArray(trimmed.context.elements));
  check('省略时有提示文案', typeof trimmed.context.omitted?.note === 'string');
  check('选中构件仍保留', trimmed.context.selected.length === 1 && trimmed.context.selected[0].id === 'e0');

  const tiny = trimProjectContext(big, 2000);
  check('预算极小时也返回合法结构', Array.isArray(tiny.context.elements) && tiny.context.elements.length >= 0);
  check('极小预算下特征降到最低档', tiny.featureLimit === 6, tiny.featureLimit);

  const noSolid = { ...makeContext(0, 0), elements: Array.from({ length: 300 }, (_, index) => ({
    id: `w${index}`, name: `墙 ${index}`, category: 'wall', start: [0, 0], end: [6, 0],
  })) };
  const walls = trimProjectContext(noSolid, 3000);
  check('非造型构件同样受限', walls.context.elements.length < 300, walls.context.elements.length);
}

console.log('buildPrompt 端到端');
{
  const context = makeContext(60, 40);
  const history = Array.from({ length: 40 }, (_, index) => ({
    role: index % 2 === 0 ? 'user' : 'assistant',
    content: `第 ${index + 1} 轮对话：${'调整尺寸与材质。'.repeat(40)}`,
  }));
  const { messages, usage } = buildPrompt({
    message: '把夹头改成金属色',
    context,
    history,
    memory: '【目标】电动螺丝刀\n【关键参数】机身 φ48×190mm',
    model: 'deepseek-chat',
  });
  check('系统提示 + 项目上下文都在', messages[0].role === 'system' && messages.some((m) => m.content.includes('当前项目上下文')));
  check('摘要作为独立 system 段', messages.some((m) => m.content.includes('更早的对话摘要')));
  check('最后一条是当前需求', messages.at(-1).role === 'user' && messages.at(-1).content === '把夹头改成金属色');
  check('用量不超窗口', usage.tokens < usage.window, usage);
  check('窗口够大时历史全留', usage.historyItems === 40 && usage.historyDropped === 0, usage.historyItems);
  check('窗口够大时构件全留', usage.omittedElements === 0, usage);
  check('窗口按模型推断', usage.window === 128_000);
  check('分项加起来等于总量', Math.abs(
    Object.values(usage.breakdown).reduce((sum, value) => sum + value, 0) - usage.tokens,
  ) <= 1);

  // 同一个会话换到小窗口模型：历史与项目上下文都必须自动收缩，而不是把请求打到 400
  const tight = buildPrompt({
    message: '把夹头改成金属色',
    context,
    history,
    memory: '【目标】电动螺丝刀\n【关键参数】机身 φ48×190mm',
    model: 'deepseek-chat',
    contextTokens: 16_000,
  });
  check('窗口收紧后历史被丢', tight.usage.historyDropped > 0, tight.usage.historyDropped);
  check('窗口收紧后上下文被裁剪', tight.usage.omittedElements > 0 || tight.usage.omittedFeatures > 0, tight.usage);
  check('收紧后总量仍不超预算', tight.usage.tokens < 16_000, tight.usage.tokens);

  const withImages = buildPrompt({
    message: '看这张图建模',
    context: makeContext(1, 1),
    history: [],
    images: [{ dataUrl: 'data:image/jpeg;base64,AAAA' }],
    model: 'deepseek-chat',
  });
  check('图片计入用量但不解析 base64', withImages.usage.breakdown.images === 1100);

  const noBudget = buildPrompt({
    message: 'hi',
    context: makeContext(0, 0),
    history: [],
    model: 'unknown-model',
  });
  check('未知模型按 64k 兜底', noBudget.usage.window === 64_000);
}

console.log(`\n上下文预算测试${failed ? `失败 ${failed} 项` : '通过'}（${passed} 项）`);
if (failed) process.exitCode = 1;
