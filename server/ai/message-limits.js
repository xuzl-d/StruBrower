/**
 * 「需求描述」长度闸门。
 *
 * 4000 字符只该约束**用户自己敲进去的那句话**。
 * 自检闭环从第 2 步起，前端发回来的是 stepPrompt 拼出来的回执，
 * 里面带 describe / measure 的工具结果——青花瓷瓶一次 element 查询就有 1.2 万字符，
 * 再按 4000 拦，就变成「明明没写长需求，却报需求描述过长」。
 *
 * 所以内部轮单独给一个上限：够装下裁剪后的工具结果，又不至于把模型窗口灌爆。
 */
export const MAX_USER_MESSAGE = 4000;
export const MAX_INTERNAL_MESSAGE = 32000;

/**
 * 超限时返回给人看的错误文案，没超返回 null。
 * 内部轮不该提示「需求描述过长」——用户根本没写需求，是工具结果太长。
 */
export function messageTooLong(text, internal) {
  const length = typeof text === 'string' ? text.length : 0;
  const limit = internal ? MAX_INTERNAL_MESSAGE : MAX_USER_MESSAGE;
  if (length <= limit) return null;
  return internal
    ? `自检回执过长（${length} 字符，上限 ${limit}）：describe 请用 from/count 分页取，不要一次拉整棵特征树`
    : '需求描述过长';
}
