/**
 * AI 输入框的「↑ 翻上一条输入 / ↓ 翻下一条」历史导航。
 *
 * 纯函数模块，不依赖 React，便于单测。行为对齐终端 / 常见 Agent：
 * - 发送时把文本压入历史，连续重复只留一条；
 * - ↑ 从最新往旧翻，↓ 往新翻，翻过最新一条后回到「进入历史前的草稿」；
 * - 第一次按 ↑ 时如果输入框有内容，视为草稿暂存，↓ 回到底时原样恢复，不丢字；
/**
 * - 只记录非空文本（纯图片 / 纯附件发送不产生空历史项）。
 * - 历史可持久化：createInputHistory 接受初始列表，items() 取快照供调用方写盘。
 *   模块本身不碰 localStorage，保证纯函数、可在 node 下测试。
 */

/**
 * 光标是否位于可触发历史导航的位置：↑ 仅在首行（光标前无换行）、↓ 仅在末行（光标后无换行）。
 * 这样在输入框里编辑多行文本时，方向键仍能正常移动光标，不会总被历史抢走。
 */
export function canNavigateWithArrow(value: string, caret: number, up: boolean): boolean {
  const pos = Math.max(0, Math.min(caret, value.length));
  return up ? !value.slice(0, pos).includes('\n') : !value.slice(pos).includes('\n');
}

export interface InputHistory {
  /** 记录一条已发送的输入；连续重复不重复入栈。 */
  push(text: string): void;
  /**
   * 按 ↑：返回上一条输入；没有更早的记录时返回 null（调用方不必拦截按键）。
   * draft 是当前输入框内容，仅当尚未进入历史浏览时会被暂存。
   */
  prev(draft: string): string | null;
  /** 按 ↓：返回下一条输入；已经回到草稿之后返回 null。 */
  next(): string | null;
  /** 用户手动编辑输入框：退出历史浏览（下次 ↑ 从最新一条重新开始，草稿以当前内容为准）。 */
  cancel(): void;
  /** 当前是否正在浏览历史（用于决定是否覆盖 onChange 对草稿的更新）。 */
  readonly browsing: boolean;
  /** 已记录条数。 */
  readonly size: number;
  /** 当前历史的只读快照（供持久化到 localStorage）。 */
  items(): readonly string[];
}

export function createInputHistory(limit = 100, initial: string[] = []): InputHistory {
  const items: string[] = initial
    .map((value) => String(value ?? '').trim())
    .filter(Boolean)
    .slice(-limit);
  let index = -1; // -1 = 未进入历史浏览（停在草稿 / 最新输入之后）
  let draft = '';

  return {
    push(text: string) {
      const value = String(text ?? '').trim();
      if (!value) return;
      if (items[items.length - 1] !== value) {
        items.push(value);
        if (items.length > limit) items.splice(0, items.length - limit);
      }
      index = -1;
      draft = '';
    },
    prev(current: string) {
      if (!items.length) return null;
      if (index === -1) {
        draft = current;
        index = items.length - 1;
      } else if (index > 0) {
        index -= 1;
      }
      return items[index] ?? null;
    },
    next() {
      if (index === -1) return null;
      if (index < items.length - 1) {
        index += 1;
        return items[index] ?? null;
      }
      index = -1;
      return draft; // 翻过最新一条：回到进入历史前的内容（可能为空）
    },
    cancel() {
      // 保留 items，重置游标；下次 ↑ 从最新一条重新进入，草稿取用户正在编辑的当前内容
      index = -1;
      draft = '';
    },
    get browsing() { return index !== -1; },
    get size() { return items.length; },
    items() { return items.slice(); },
  };
}
