/**
 * 忘记密码时的兜底：直接在服务端重置某个账号的密码。
 *   npm run reset-password -- user@example.com 新密码
 * 数据目录与服务端一致（默认 server/data，可用 STRU_DATA_DIR / STRU_DB 覆盖）。
 * 服务端在运行时也可以执行：SQLite 的 WAL 允许并发写，改完立即生效。
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { hashPassword } from '../server/auth.js';
import { createStore } from '../server/store.js';

const ROOT = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const DATA_DIR = process.env.STRU_DATA_DIR ?? path.join(ROOT, 'server', 'data');
const DB_FILE = process.env.STRU_DB ?? path.join(DATA_DIR, 'strubrowser.db');

const [email, password] = process.argv.slice(2);

if (!email || !password) {
  console.error('用法：npm run reset-password -- <邮箱> <新密码>');
  process.exit(1);
}
if (password.length < 6) {
  console.error('新密码至少 6 位');
  process.exit(1);
}

const store = createStore(DB_FILE);
const record = store.findUserByEmail(email.trim());
if (!record) {
  console.error(`找不到账号：${email}`);
  process.exit(2);
}

store.updateUser(record.id, { passwordHash: hashPassword(password) });
store.audit(null, record.id, 'auth.password.reset.cli', { email: record.email });
console.log(`已重置 ${record.email} 的密码（${password.length} 位）。请登录后尽快在账户中心修改。`);
