/**
 * 「需求描述过长」这道闸门的回归测试。
 *
 * 背景：自检闭环第 2 步起，前端发回来的是 stepPrompt 拼出来的回执，
 * 里面带 describe / measure 的工具结果（青花瓷瓶一次 element 查询 1.2 万字符）。
 * 以前这两个端点在解析完 message 后一律按 4000 字拒，用户没写长需求也看到「需求描述过长」。
 * 现在只对用户自己写的那句话生效，内部轮单独给上限。
 */
import { MAX_INTERNAL_MESSAGE, MAX_USER_MESSAGE, messageTooLong } from '../server/ai/message-limits.js';

let failed = 0;
function check(name, ok, detail) {
  if (ok) console.log('  ✓', name);
  else { failed += 1; console.log('  ✗', name, detail ?? ''); }
}

check('用户需求上限还是 4000', MAX_USER_MESSAGE === 4000, MAX_USER_MESSAGE);
check('内部轮上限更大且不至于失控', MAX_INTERNAL_MESSAGE > MAX_USER_MESSAGE && MAX_INTERNAL_MESSAGE <= 64000, MAX_INTERNAL_MESSAGE);

check('刚好 4000 的用户需求放行', messageTooLong('字'.repeat(4000), false) === null);
check('4001 的用户需求仍然拒绝', messageTooLong('字'.repeat(4001), false) === '需求描述过长');
check('空字符串 / 非字符串不炸', messageTooLong('', false) === null && messageTooLong(undefined, true) === null);

check('internal 轮的 5000 字回执放行（这正是截图里被误杀的场景）',
  messageTooLong('字'.repeat(5000), true) === null);
check('internal 轮的 1.2 万 describe 结果放行', messageTooLong('字'.repeat(12000), true) === null);
check('internal 轮刚好到上限放行', messageTooLong('字'.repeat(MAX_INTERNAL_MESSAGE), true) === null);

const over = messageTooLong('字'.repeat(MAX_INTERNAL_MESSAGE + 1), true);
check('internal 轮超上限有自己的文案', typeof over === 'string' && over.includes('自检回执过长'), over);
check('internal 轮不再误报「需求描述过长」', typeof over === 'string' && !over.includes('需求描述过长'), over);
check('内部轮的错误文案给出翻页办法', typeof over === 'string' && over.includes('from/count'), over);

console.log(failed === 0 ? '\n消息长度闸门测试全部通过' : `\n消息长度闸门测试失败：${failed} 项`);
process.exit(failed === 0 ? 0 : 1);
