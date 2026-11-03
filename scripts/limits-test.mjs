/** 进程内限流器单测。 */
import { createRateLimiter } from '../server/limits.js';

let passed = 0;
let failed = 0;
function check(name, ok, detail) {
  if (ok) { passed += 1; console.log('  ✓', name); }
  else { failed += 1; console.log('  ✗', name, detail ?? ''); }
}

let clock = 0;
const limiter = createRateLimiter({ limit: 2, windowMs: 1000, now: () => clock });
check('前两次放行', limiter.take('u1').allowed && limiter.take('u1').allowed);
const blocked = limiter.take('u1');
check('第三次拒绝并给出重试时间', !blocked.allowed && blocked.retryAfterSec >= 1, blocked);
check('不同 key 独立', limiter.take('u2').allowed);
clock = 1001;
check('窗口过期后恢复', limiter.take('u1').allowed);

const unlimited = createRateLimiter({ limit: 0 });
check('limit=0 关闭限流', unlimited.take('x').allowed && unlimited.take('x').allowed);

console.log(`\n${passed} 项通过${failed ? `，${failed} 项失败` : '，全部通过'}`);
process.exit(failed ? 1 : 0);
