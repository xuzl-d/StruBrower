/**
 * 长对话的滚动记忆。
 *
 * 会话消息在库里永不删除（历史可回看），但回灌给模型时只保留最近一段原文：
 * 更早的部分由当前模型压成一段技术备忘，存在 ai_conversations.summary 里。
 * 这样对话可以无限长下去，而单次请求的上下文始终有上界。
 *
 * 触发不再只看条数：小窗口模型攒到 18 条早就爆了，所以条数与 token 谁先到算谁。
 * 摘要长度与回灌预算对齐（压到 4000 字却只发 2400 字 = 白花钱）。
 */
import { estimateTokens } from './budget.js';

/** 未压缩消息超过这个条数才触发压缩（约 8~9 轮往返） */
export const SUMMARY_TRIGGER = 18;
/** 压缩时保留最近几条原文，保证「刚才那句」的细节不丢 */
export const SUMMARY_KEEP = 6;
/** 保留窗口的 token 上限：消息本身都很长时，按条数留 6 条会留不下压缩空间 */
export const SUMMARY_KEEP_TOKENS = 4000;
/** 未压缩消息的 token 压力上限：小窗口模型靠这个提前压缩 */
export const SUMMARY_TOKEN_TRIGGER = 6000;
/** 单次最多压多少条：一次调用塞太多，摘要质量反而下降 */
const SUMMARY_CHUNK = 24;
/** 单次喂给摘要模型的输入 token 上限（同上，防压糊） */
const SUMMARY_CHUNK_TOKENS = 12000;
/** 摘要正文上限：与回灌预算对齐，避免「压了但塞不进上下文」 */
export const SUMMARY_LIMIT = 1800;
/**
 * 手动压缩的最小收益门槛：被压的那段本身还不到 800 token 时，
 * 摘要（结构化备忘约 300 字）比原文还长，压完上下文反而更大。
 */
export const MIN_COMPACT_TOKENS = 800;

/** 已经在压缩中的会话，避免同一会话被并发压两遍 */
const inFlight = new Set();

/**
 * 把这次生成的指令压成一行短标签（如 `addSolid、editFeature(机身)`）。
 * 历史消息只存自然语言回复，模型光看回复不知道自己上一轮到底改了什么。
 */
export function describeOpsBrief(ops, limit = 12) {
  if (!Array.isArray(ops) || !ops.length) return '';
  const parts = [];
  for (const op of ops.slice(0, limit)) {
    if (!op || typeof op !== 'object') continue;
    const type = String(op.op ?? op.type ?? '');
    if (!type) continue;
    const target = op.name ?? op.target ?? op.feature ?? op.elementId ?? op.id ?? '';
    parts.push(target ? `${type}(${String(target).slice(0, 24)})` : type);
  }
  return parts.join('、');
}

/** 摘要之后还没压过的消息（user/assistant 且有内容） */
function pendingOf(store, conversation) {
  if (!conversation?.id) return [];
  return store.listMessages(conversation.id, { afterSeq: conversation.summarySeq ?? 0, limit: 400 })
    .filter((item) => (item.role === 'user' || item.role === 'assistant') && item.content);
}

/** 该不该压：条数或 token 压力，谁先到算谁 */
export function needsCompact(pending) {
  if (!Array.isArray(pending) || pending.length < 4) return false;
  if (pending.length >= SUMMARY_TRIGGER) return true;
  return estimateTokens(pending.map((item) => item.content).join('\n')) >= SUMMARY_TOKEN_TRIGGER;
}

/**
 * 选本次要压的一段：从最新往前保留「最近 keep 条 / keepTokens 以内」，其余按条数与 token
 * 双上限装填。消息都很短时等于保留 6 条；某几条特别长时只保留最近那条，否则永远压不动。
 * 返回的是「从旧到新」的一段连续消息，seq 必须连续才能把 summarySeq 往前推。
 */
export function pickChunk(pending, { keep = SUMMARY_KEEP, keepTokens = SUMMARY_KEEP_TOKENS } = {}) {
  if (!Array.isArray(pending) || !pending.length) return [];

  let keepCount = 0;
  let keptTokens = 0;
  for (let index = pending.length - 1; index >= 0; index -= 1) {
    if (keepCount >= keep) break;
    const cost = estimateTokens(pending[index].content);
    if (keepCount > 0 && keptTokens + cost > keepTokens) break;
    keptTokens += cost;
    keepCount += 1;
  }
  keepCount = Math.max(1, keepCount);

  const candidates = pending.slice(0, pending.length - keepCount);
  const chunk = [];
  let tokens = 0;
  for (const item of candidates.slice(0, SUMMARY_CHUNK)) {
    const cost = estimateTokens(item.content);
    if (chunk.length && tokens + cost > SUMMARY_CHUNK_TOKENS) break;
    chunk.push(item);
    tokens += cost;
  }
  return chunk;
}

/**
 * 会话变长时压缩更早的消息。返回新摘要（未触发压缩时返回 null）。
 * 失败一律静默：摘要只是省 token 的优化，不该影响建模主流程。
 */
export async function maybeSummarize({ store, provider, session, log = console.warn }) {
  if (!session?.id || typeof provider?.summarize !== 'function') return null;
  if (inFlight.has(session.id)) return null;

  const conversation = store.getConversation(session.id, { withMessages: false });
  if (!conversation) return null;

  const pending = pendingOf(store, conversation);
  if (!needsCompact(pending)) return null;

  const compressible = pickChunk(pending, { keep: SUMMARY_KEEP });
  if (!compressible.length) return null;

  inFlight.add(session.id);
  try {
    const summary = await provider.summarize({
      previous: conversation.summary ?? '',
      messages: compressible,
    });
    if (!summary || !summary.trim()) return null;
    const text = summary.trim().slice(0, SUMMARY_LIMIT);
    store.setConversationSummary(session.id, text, compressible.at(-1).seq);
    return text;
  } catch (error) {
    log(`[ai] 会话摘要失败（不影响本次对话）：${error instanceof Error ? error.message : String(error)}`);
    return null;
  } finally {
    inFlight.delete(session.id);
  }
}

/**
 * 手动压缩（面板上的「压缩上下文」）：把未压缩的消息成块压进备忘，直到只剩最近 keep 条。
 * 与自动压缩的区别：
 * - 不看阈值，点了就压；
 * - 要报错给用户（自动压缩失败是静默的，手动点了没反应会让人以为坏了）；
 * - 返回 before/after token 估算，前端才能说清「从多少降到多少」。
 * 每次最多 maxBlocks 块（每块一次模型调用），压不完的把 remaining 交回去。
 */
export async function compactConversation({
  store,
  provider,
  conversationId,
  keep = SUMMARY_KEEP,
  maxBlocks = 2,
  log = console.warn,
}) {
  if (typeof provider?.summarize !== 'function') throw new Error('当前模型不支持摘要压缩');
  const conversation = store.getConversation(conversationId, { withMessages: false });
  if (!conversation) throw new Error('会话不存在');
  if (inFlight.has(conversationId)) {
    return { summary: conversation.summary ?? '', compacted: 0, remaining: 0, before: 0, after: 0, busy: true };
  }

  // before = 当前上下文规模（已压的摘要 + 还没压的原文），不是「库里全部消息」
  const all = pendingOf(store, conversation);
  const before = estimateTokens(conversation.summary ?? '')
    + estimateTokens(all.map((item) => item.content).join('\n'));

  let summary = conversation.summary ?? '';
  let cursor = conversation.summarySeq ?? 0;
  let compacted = 0;
  let reason = '';

  inFlight.add(conversationId);
  try {
    for (let block = 0; block < maxBlocks; block += 1) {
      const pending = pendingOf(store, { id: conversationId, summarySeq: cursor });
      const chunk = pickChunk(pending, { keep });
      if (!chunk.length) break;
      // 收益门槛：被压部分太短时摘要反而更长，直接告诉调用方「不值得压」
      const chunkTokens = estimateTokens(chunk.map((item) => item.content).join('\n'));
      if (chunkTokens < MIN_COMPACT_TOKENS) {
        reason = 'too-small';
        break;
      }
      const next = await provider.summarize({ previous: summary, messages: chunk });
      if (!next || !next.trim()) break;
      summary = next.trim().slice(0, SUMMARY_LIMIT);
      cursor = chunk.at(-1).seq;
      store.setConversationSummary(conversationId, summary, cursor);
      compacted += chunk.length;
    }
  } catch (error) {
    log(`[ai] 手动压缩失败：${error instanceof Error ? error.message : String(error)}`);
    throw error instanceof Error ? error : new Error('压缩失败');
  } finally {
    inFlight.delete(conversationId);
  }

  const rest = pendingOf(store, { id: conversationId, summarySeq: cursor });
  const after = estimateTokens(summary) + estimateTokens(rest.map((item) => item.content).join('\n'));
  return {
    summary,
    compacted,
    remaining: rest.length,
    // 再点一次还能压出东西吗（只看「保留窗口以外」还有没有消息，且压得动）
    hasMore: estimateTokens(pickChunk(rest, { keep }).map((item) => item.content).join('\n')) >= MIN_COMPACT_TOKENS,
    before,
    after,
    reason,
    busy: false,
  };
}
