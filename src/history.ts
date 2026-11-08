/**
 * 撤销 / 重做栈（纯函数，UI 无关）。
 *
 * 之所以单独抽出来：键盘连按 Ctrl+Z 时 React 状态还没重渲染，
 * 若从闭包里读 history 会反复读到同一份旧栈，表现为“按了没反应”。
 * 这里所有操作都接收当前栈并返回新栈，调用方用 ref 同步保存即可。
 */

export interface History<T> {
  /** 末尾是上一步（最近一次可撤销的状态）。 */
  past: T[];
  /** 头部是下一步（最近一次可重做的状态）。 */
  future: T[];
}

export function emptyHistory<T>(): History<T> {
  return { past: [], future: [] };
}

/** 记录一次新编辑：清空重做分支，最多保留 limit 步。 */
export function pushHistory<T>(history: History<T>, previous: T, limit = 50): History<T> {
  return {
    past: [...history.past.slice(-(limit - 1)), previous],
    future: [],
  };
}

/** 撤销一步；没有可撤销内容时返回 null。 */
export function undoHistory<T>(
  history: History<T>,
  current: T,
  limit = 50,
): { history: History<T>; value: T } | null {
  if (!history.past.length) return null;
  const value = history.past[history.past.length - 1]!;
  return {
    value,
    history: {
      past: history.past.slice(0, -1),
      future: [current, ...history.future].slice(0, limit),
    },
  };
}

/** 重做一步；没有可重做内容时返回 null。 */
export function redoHistory<T>(
  history: History<T>,
  current: T,
  limit = 50,
): { history: History<T>; value: T } | null {
  if (!history.future.length) return null;
  const value = history.future[0]!;
  return {
    value,
    history: {
      past: [...history.past, current].slice(-limit),
      future: history.future.slice(1),
    },
  };
}
