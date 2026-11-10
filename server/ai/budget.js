/**
 * 上下文预算：把模型窗口当成一个要分配的预算，而不是「塞不下就截字符串」。
 *
 * 之前的两处硬伤：
 * 1. 项目上下文用 `JSON.stringify(context).slice(0, 24000)` —— 切在半个括号上，
 *    模型收到的是残缺 JSON，后半段构件直接消失且没有任何提示；
 * 2. 历史按固定 6 条 / 24000 字符，与模型窗口无关，32k 和 128k 的模型吃一样的量。
 *
 * 现在按 token 估算分配：窗口 - 输出预留 - 系统提示 - 当前消息 → 剩下的按比例
 * 分给「滚动摘要 / 项目上下文 / 历史原文」，各段自己按预算收缩（项目上下文是结构化裁剪）。
 */

/** 中日韩统一表意文字 + 全角标点：这些字大致 1 字 1 token */
const CJK = /[\u3000-\u303f\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff00-\uffef]/g;

/**
 * 估算 token 数。中文按 1 字 ≈ 1 token、拉丁与符号按 3.4 字符 ≈ 1 token。
 * 刻意估大一点：宁可少塞一点，也不要让请求被网关按超长拒掉。
 */
export function estimateTokens(input) {
  if (input === null || input === undefined) return 0;
  const text = typeof input === 'string' ? input : JSON.stringify(input);
  if (!text) return 0;
  const cjk = (text.match(CJK) ?? []).length;
  const rest = Math.max(0, text.length - cjk);
  return Math.ceil(cjk * 1.02 + rest / 3.4);
}

/** 一张图大致占的 token（视觉编码器按 1024 长边压过，取经验值） */
export const IMAGE_TOKENS = 1100;

/**
 * 模型窗口大小：按模型名分档。认不出来时按 64k 保守处理 —— 估小了只是多压缩一点，
 * 估大了会直接把请求打到 400。
 */
const WINDOW_HINTS = [
  [/1m|1000000|gemini-1\.5|gemini-2|gemini-pro/i, 1_000_000],
  [/200k|claude|gpt-4\.1|gpt-4o|qwen-long|qwen2\.5-1m|glm-4-long/i, 200_000],
  [/128k|deepseek|qwen3|qwen-max|qwen-plus|kimi|moonshot|yi-|glm-4\b/i, 128_000],
  [/32k|gpt-3\.5|qwen-turbo/i, 32_000],
  [/16k|8k/i, 16_000],
];

export function contextWindowOf(model, override) {
  const forced = Number(override);
  if (Number.isFinite(forced) && forced >= 8000) return Math.min(Math.round(forced), 2_000_000);
  const name = String(model ?? '');
  for (const [pattern, size] of WINDOW_HINTS) {
    if (pattern.test(name)) return size;
  }
  return 64_000;
}

/** 输出预留：模型要给完整特征树 + 思考过程，留太少会被截在半路 */
function outputReserveOf(window) {
  return Math.min(16_000, Math.round(window * 0.16));
}

/**
 * 分配预算。
 * @returns {{window:number, output:number, available:number, memory:number, project:number, history:number, fixed:number}}
 */
export function planBudget({ model, contextTokens, systemTokens = 0, messageTokens = 0, imageCount = 0 }) {
  const window = contextWindowOf(model, contextTokens);
  const output = outputReserveOf(window);
  const fixed = Math.max(0, systemTokens) + Math.max(0, messageTokens) + Math.max(0, imageCount) * IMAGE_TOKENS;
  const available = Math.max(1200, window - output - fixed);

  // 摘要只是「更早对话的备忘」，不该挤占项目上下文；项目上下文与历史原文看谁更需要
  const memory = Math.min(1600, Math.round(available * 0.12));
  const project = Math.round(available * 0.42);
  const history = Math.max(600, available - memory - project);
  return { window, output, fixed, available, memory, project, history };
}

/** 单条历史的 token 上限：思考型模型的回复上万字，整段塞回去下一轮就爆 */
export const HISTORY_ITEM_TOKENS = 1500;

/** 把一段文本压到指定 token 以内（按比例收缩后逐步校正，避免切出半个字/半个转义） */
export function clipToTokens(text, maxTokens) {
  if (estimateTokens(text) <= maxTokens) return text;
  let cut = Math.max(40, Math.floor(text.length * (maxTokens / Math.max(1, estimateTokens(text)))));
  while (cut > 40 && estimateTokens(text.slice(0, cut)) > maxTokens) {
    cut = Math.floor(cut * 0.9);
  }
  return `${text.slice(0, cut)}\n…（本条过长已截断）`;
}

/**
 * 按预算裁剪历史原文：从最新往前累积，塞不下的更早消息会被丢掉
 * （它们应该已经被 memory.js 压成摘要了）。
 */
export function fitHistory(history, limitTokens = 12_000) {
  const list = Array.isArray(history) ? history : [];
  const limit = Math.max(400, Number(limitTokens) || 0);
  const kept = [];
  let tokens = 0;
  let dropped = 0;

  for (let index = list.length - 1; index >= 0; index -= 1) {
    const item = list[index];
    if (!item || (item.role !== 'user' && item.role !== 'assistant') || typeof item.content !== 'string') continue;
    const text = clipToTokens(item.content, HISTORY_ITEM_TOKENS);
    const cost = estimateTokens(text);
    if (tokens + cost > limit) {
      // 这一条和它之前的全部放不下（先前的已经进摘要，不会再回来）
      dropped = list.slice(0, index + 1).filter(
        (entry) => entry && (entry.role === 'user' || entry.role === 'assistant') && typeof entry.content === 'string',
      ).length;
      break;
    }
    tokens += cost;
    kept.unshift({ role: item.role, content: text });
  }

  return { items: kept, tokens, dropped };
}

/** 项目上下文默认预算（无窗口信息时的兜底） */
export const PROJECT_CONTEXT_TOKENS = 12_000;
/** 特征数逐级收缩的档位：放不下大表就先给骨架 */
const FEATURE_STEPS = [48, 24, 12, 6];

function scaleSolid(element, maxFeatures) {
  const solid = element?.solid;
  if (!solid || !Array.isArray(solid.features)) return element;
  if (solid.features.length <= maxFeatures) return element;
  return {
    ...element,
    solid: {
      ...solid,
      features: solid.features.slice(0, maxFeatures),
      truncated: true,
    },
  };
}

function compactSolidShapes(element) {
  if (!Array.isArray(element?.solid?.features)) return element;
  return {
    ...element,
    solid: {
      ...element.solid,
      features: element.solid.features.map((feature) => {
        if (!Object.hasOwn(feature, 'shapeData')) return feature;
        const { shapeData: _shapeData, ...summary } = feature;
        return { ...summary, shapeDataOmitted: true };
      }),
    },
  };
}

/**
 * 结构化裁剪项目上下文：绝不切 JSON 字符串。
 * 保留骨架（项目/标高/类型/网格/统计），元素按「选中 → 造型 → 其它」优先级装填，
 * 装不下时逐级降特征数，再按顺序少放元素，并把省略量写进 `omitted` 让模型知道「还有没列出来的」。
 */
export function trimProjectContext(context, limitTokens = PROJECT_CONTEXT_TOKENS) {
  const limit = Math.max(1200, Number(limitTokens) || PROJECT_CONTEXT_TOKENS);
  const source = context && typeof context === 'object' ? context : {};
  const elements = Array.isArray(source.elements) ? source.elements : [];
  const selected = Array.isArray(source.selected) ? source.selected : [];
  const head = { ...source, elements: [], selected: [] };
  const headTokens = estimateTokens(head);

  // ① 选中构件：优先完整信息（AI 就是在改它们）；实在占太多就降级成寻址简表
  let selectedOut = selected;
  let selectedTokens = estimateTokens(selected);
  let selectedDegraded = false;
  if (headTokens + selectedTokens > limit * 0.55) {
    selectedOut = selected.map((item) => ({ id: item?.id, name: item?.name, category: item?.category }));
    selectedTokens = estimateTokens(selectedOut);
    selectedDegraded = true;
  }

  const budget = Math.max(300, limit - headTokens - selectedTokens);
  const solids = elements.filter((element) => element?.solid);
  const others = elements.filter((element) => !element?.solid);

  // ② 先试「特征降档 + 全部装下」
  for (const features of FEATURE_STEPS) {
    const full = solids.map((element) => scaleSolid(element, features));
    const variants = [full, full.map(compactSolidShapes)];
    for (const scaled of variants) {
      if (estimateTokens([...scaled, ...others]) <= budget) {
        const omittedFeatures = scaled.reduce((sum, element) => sum + Math.max(0, (element.solid.featureCount ?? element.solid.features.length) - element.solid.features.length), 0);
        const omitted = { elements: 0, features: omittedFeatures };
        return {
          context: { ...head, selected: selectedOut, elements: [...scaled, ...others], ...(omittedFeatures ? { truncated: true, omitted: { ...omitted, note: '部分特征未列出，不能据此推断其不存在' } } : {}) },
          tokens: headTokens + selectedTokens + estimateTokens([...scaled, ...others]),
          omitted,
          featureLimit: features,
          selectedDegraded,
        };
      }
    }
  }

  // ③ 最小档还装不下：先砍「其它构件」，再砍造型实体（保留靠前的，AI 通常在建/改头一个）
  const minimal = solids.map((element) => compactSolidShapes(scaleSolid(element, FEATURE_STEPS.at(-1))));
  let keptSolids = minimal;
  let keptOthers = others;
  let solidTokens = estimateTokens(keptSolids);
  let otherTokens = estimateTokens(keptOthers);

  if (solidTokens > budget) {
    keptOthers = [];
    otherTokens = 0;
    keptSolids = [];
    solidTokens = 0;
    for (const element of minimal) {
      const cost = estimateTokens(element);
      if (solidTokens + cost > budget) break;
      keptSolids.push(element);
      solidTokens += cost;
    }
  } else {
    keptOthers = [];
    otherTokens = 0;
    for (const element of others) {
      const cost = estimateTokens(element);
      if (solidTokens + otherTokens + cost > budget) break;
      keptOthers.push(element);
      otherTokens += cost;
    }
  }

  const omittedElements = elements.length - keptSolids.length - keptOthers.length;
  const totalFeatures = solids.reduce((sum, element) => sum + (element.solid.featureCount ?? element.solid.features.length), 0);
  const keptFeatures = keptSolids.reduce((sum, element) => sum + element.solid.features.length, 0);
  const omittedFeatures = Math.max(0, totalFeatures - keptFeatures);

  return {
    context: {
      ...head,
      selected: selectedOut,
      elements: [...keptSolids, ...keptOthers],
      truncated: true,
      omitted: {
        elements: omittedElements,
        features: omittedFeatures,
        note: omittedElements
          ? `还有 ${omittedElements} 个构件没列出来；需要时先用查询指令确认，不要凭空猜测 id`
          : '',
      },
    },
    tokens: headTokens + selectedTokens + solidTokens + otherTokens,
    omitted: { elements: omittedElements, features: omittedFeatures },
    featureLimit: FEATURE_STEPS.at(-1),
    selectedDegraded,
  };
}

/** 把用量整理成给前端/审计看的一行 <summary> */
export function describeUsage(usage) {
  if (!usage) return '';
  const k = (value) => `${Math.round(value / 100) / 10}k`;
  return `${k(usage.tokens)}/${k(usage.window)} tokens`
    + `（历史 ${k(usage.breakdown?.history ?? 0)}、项目 ${k(usage.breakdown?.project ?? 0)}`
    + `、摘要 ${k(usage.breakdown?.memory ?? 0)}）`
    + (usage.compressed ? `，已压缩 ${usage.compressed} 条更早消息` : '');
}
