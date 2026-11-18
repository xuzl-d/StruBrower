/**
 * 输入法（IME）组合态判定。
 *
 * 中文 / 日文 / 韩文输入法按回车「上屏候选词」时，浏览器同样会派发 keydown(Enter)。
 * 所有「回车即提交 / 即发送」的处理器必须先问 isImeComposing，否则候选词还没选完，
 * 半截拼音就被当成用户主动敲的回车发出去了。
 *
 * 组合状态在 document 捕获阶段统一跟踪，任何 input / textarea 自动生效，
 * 不需要给每个输入框单独挂 onCompositionStart / onCompositionEnd。
 */

/**
 * compositionend 在某些浏览器（Safari、部分 Firefox 输入法）会早于那一次 keydown，
 * 此时 isComposing 已复位，留一个很短的宽限窗口兜底。80ms 远小于人手连按两次回车的间隔。
 */
const GRACE_MS = 80;

/** 只取判定所需的最小按键形状：React KeyboardEvent 与原生 KeyboardEvent 都能直接传 */
export interface KeyLike {
  key?: string;
  keyCode?: number;
  isComposing?: boolean;
  nativeEvent?: KeyLike;
}

export interface ImeTracker {
  noteStart(): void;
  noteEnd(at?: number): void;
  noteReset(): void;
  isComposing(event?: KeyLike, at?: number): boolean;
}

export function createImeTracker(graceMs = GRACE_MS): ImeTracker {
  let composing = false;
  let endedAt = -Infinity;
  return {
    noteStart() {
      composing = true;
    },
    noteEnd(at = Date.now()) {
      composing = false;
      endedAt = at;
    },
    noteReset() {
      // 切窗口 / 点别处时输入法可能直接收起，收不到 compositionend，别让标志卡住
      composing = false;
    },
    isComposing(event, at = Date.now()) {
      if (composing) return true;
      const native = event?.nativeEvent;
      // Chrome：上屏那一下 isComposing 仍为 true；Safari / 部分输入法给 229 或 'Process'
      if (event?.isComposing || native?.isComposing) return true;
      if (event?.keyCode === 229 || native?.keyCode === 229) return true;
      if (event?.key === 'Process' || native?.key === 'Process') return true;
      // compositionend 早于 keydown 且上面几个标志都没给：靠时间窗口兜底
      return at - endedAt < graceMs;
    },
  };
}

/** 应用内共用的全局 tracker */
export const ime = createImeTracker();

type EventTargetLike = Pick<Document, 'addEventListener' | 'removeEventListener'>;

/** 把 DOM 组合事件接到 tracker；返回解绑函数（测试可传 fake document / window） */
export function attachImeTracker(
  doc: EventTargetLike,
  win: Pick<Window, 'addEventListener' | 'removeEventListener'>,
  tracker: ImeTracker = ime,
): () => void {
  const start = () => tracker.noteStart();
  const end = () => tracker.noteEnd();
  const reset = () => tracker.noteReset();
  doc.addEventListener('compositionstart', start, true);
  doc.addEventListener('compositionend', end, true);
  doc.addEventListener('focusout', reset, true);
  win.addEventListener('blur', reset);
  return () => {
    doc.removeEventListener('compositionstart', start, true);
    doc.removeEventListener('compositionend', end, true);
    doc.removeEventListener('focusout', reset, true);
    win.removeEventListener('blur', reset);
  };
}

if (typeof document !== 'undefined' && typeof window !== 'undefined') {
  attachImeTracker(document, window);
}

/** 回车类处理器 / 表单隐式提交前的统一判定 */
export function isImeComposing(event?: KeyLike, at?: number): boolean {
  return ime.isComposing(event, at);
}

/**
 * 表单 onSubmit 是否是输入法上屏误触发的隐式提交。
 * 明确点了 type=submit 按钮的提交永远不算，避免宽限窗口吞掉用户主动点击。
 */
export function isImeSubmit(event: { nativeEvent: Event }): boolean {
  const native = event.nativeEvent;
  const clicked = typeof SubmitEvent !== 'undefined'
    && native instanceof SubmitEvent
    && native.submitter != null;
  return !clicked && isImeComposing();
}
