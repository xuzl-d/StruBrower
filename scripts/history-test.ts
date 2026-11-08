/**
 * 撤销 / 重做栈单元测试：连续撤销、重做、分支清理与步数上限。
 * 运行：node scripts/test.mjs（内部用 esbuild 打包后执行）
 */
import {
  emptyHistory, pushHistory, redoHistory, undoHistory,
} from '../src/history';

let failed = 0;
function check(name: string, condition: boolean) {
  if (condition) console.log(`  ✓ ${name}`);
  else {
    failed += 1;
    console.error(`  ✗ ${name}`);
  }
}

/* 1. 连续撤销：模拟键盘连按（每步都从最新栈读取） */
let history = emptyHistory<string>();
let current = 'v3';
history = pushHistory(history, 'v1');
history = pushHistory(history, 'v2');

const first = undoHistory(history, current)!;
check('第一次撤销回到 v2', first.value === 'v2' && first.history.future[0] === 'v3');
const second = undoHistory(first.history, first.value)!;
check('第二次撤销回到 v1（连按不会读到旧栈）', second.value === 'v1');
const third = undoHistory(second.history, second.value);
check('没有更多历史时返回 null', third === null);

/* 2. 重做：按相反顺序回到 v2 / v3 */
const redo1 = redoHistory(second.history, 'v1')!;
check('重做一次回到 v2', redo1.value === 'v2');
const redo2 = redoHistory(redo1.history, redo1.value)!;
check('重做两次回到 v3', redo2.value === 'v3');
check('重做到头后返回 null', redoHistory(redo2.history, 'v3') === null);

/* 3. 撤销后产生新编辑：重做分支被清空 */
const branched = pushHistory(second.history, 'v1-new');
check('新编辑清空 future', branched.future.length === 0 && branched.past.at(-1) === 'v1-new');

/* 4. 步数上限：只保留最近 limit 步 */
let capped = emptyHistory<number>();
for (let index = 0; index < 60; index += 1) capped = pushHistory(capped, index, 50);
check('past 最多保留 50 步', capped.past.length === 50);
check('保留的是最近的 50 步', capped.past[0] === 10 && capped.past.at(-1) === 59);

/* 5. 空历史：撤销 / 重做都返回 null */
check('空栈撤销返回 null', undoHistory(emptyHistory<string>(), 'x') === null);
check('空栈重做返回 null', redoHistory(emptyHistory<string>(), 'x') === null);

/* 6. 不可变：操作不修改入参 */
const source = pushHistory(emptyHistory<string>(), 'a');
const snapshot = JSON.stringify(source);
undoHistory(source, 'b');
redoHistory(source, 'b');
check('入参栈未被修改', JSON.stringify(source) === snapshot);

console.log(failed ? `\n${failed} 项失败` : '\n全部通过');
process.exit(failed ? 1 : 0);
