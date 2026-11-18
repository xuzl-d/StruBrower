/**
 * 输入框历史导航（↑/↓）测试。
 */
import { canNavigateWithArrow, createInputHistory } from '../src/ai/inputHistory';

let failed = 0;
function check(name, ok, detail) {
  if (ok) console.log('  ✓', name);
  else { failed += 1; console.log('  ✗', name, detail ?? ''); }
}

// ── 记录 ───────────────────────────────────────────────────
{
  const h = createInputHistory();
  h.push('画坦克');
  h.push('  加履带  ');
  h.push(''); // 空文本不记
  h.push('  加履带  '); // trim 后与上一条相同，连续重复不记
  check('空输入不记、连续重复去重', h.size === 2, h.size);
}

// ── ↑ 回溯 / ↓ 前进 ────────────────────────────────────────
{
  const h = createInputHistory();
  h.push('第一条');
  h.push('第二条');
  h.push('第三条');
  check('首次 ↑ 返回最新一条', h.prev('') === '第三条');
  check('再次 ↑ 返回上一条', h.prev('第三条') === '第二条');
  check('继续 ↑ 到最早一条', h.prev('第二条') === '第一条');
  check('到头后再 ↑ 停留不越界', h.prev('第一条') === '第一条');
  check('↓ 往新翻', h.next() === '第二条');
  check('↓ 翻到最新', h.next() === '第三条');
  check('↓ 越过最新回到草稿', h.next() === '');
  check('回到草稿后不再被 ↓ 拦截', h.next() === null);
}

// ── 草稿保护 ──────────────────────────────────────────────
{
  const h = createInputHistory();
  h.push('历史A');
  h.push('历史B');
  check('有草稿时首次 ↑ 暂存草稿', h.prev('我打到一半的话') === '历史B');
  check('↓ 回到底恢复草稿', h.next() === '我打到一半的话');
}

// ── 手动编辑打断浏览 ──────────────────────────────────────
{
  const h = createInputHistory();
  h.push('旧输入');
  h.prev('');
  check('进入浏览后 browsing=true', h.browsing === true);
  h.cancel();
  check('手动编辑后退出浏览', h.browsing === false);
  check('退出后 ↑ 从最新重新进入', h.prev('新草稿') === '旧输入');
  check('新草稿被正确暂存', (h.next()) === '新草稿');
}

// ── 上限 ──────────────────────────────────────────────────
{
  const h = createInputHistory(3);
  for (let i = 1; i <= 5; i += 1) h.push(`记录${i}`);
  check('超出上限只保留最近 limit 条', h.size === 3);
  check('最早的记录已被挤掉', h.prev('') === '记录5' && (h.prev(''), h.prev('')) === '记录3');
}

// ── 持久化（初始加载 / 快照） ──────────────────────────────
{
  const saved = ['旧消息1', '旧消息2'];
  const h = createInputHistory(100, saved);
  check('从持久化列表恢复历史', h.size === 2 && h.prev('') === '旧消息2');
  h.push('新消息');
  check('items() 导出可写盘的快照', JSON.stringify(h.items()) === JSON.stringify(['旧消息1', '旧消息2', '新消息']));
  const snapshot = h.items() as string[];
  snapshot.push('篡改'); // 修改快照不应污染内部
  check('items() 返回副本，改它不影响内部', h.size === 3);
  const trimmed = createInputHistory(2, ['a', 'b', 'c', 'd']);
  check('初始加载也遵守上限', trimmed.size === 2 && trimmed.prev('') === 'd');
}

// ── 多行光标判断 ──────────────────────────────────────────
{
  const two = '第一行\n第二行';
  check('首行可取 ↑（光标在第一行内）', canNavigateWithArrow(two, 2, true) === true);
  check('第二行不取 ↑（让光标正常上移）', canNavigateWithArrow(two, 6, true) === false);
  check('末行可取 ↓', canNavigateWithArrow(two, 6, false) === true);
  check('第一行不取 ↓（让光标正常下移）', canNavigateWithArrow(two, 2, false) === false);
  check('单行文本 ↑↓ 都可导航', canNavigateWithArrow('abc', 1, true) && canNavigateWithArrow('abc', 1, false));
}

console.log(failed === 0 ? '\n输入历史测试全部通过' : `\n输入历史测试失败：${failed} 项`);
process.exit(failed === 0 ? 0 : 1);
