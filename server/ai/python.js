/**
 * Python 工具的请求规范化。
 *
 * 模型在 plan 的 JSON 里写 "python": [{"code": "...", "note": "..."}]。
 * 脚本是纯计算：用 emit({'result': ...}) 提交结果，也可以带 ops / images。
 * 认不出的项直接丢掉，别让一次格式错误把整轮建模打断。
 */
import { MAX_PYTHON_SCRIPTS, MAX_SCRIPT_CHARS } from './python-runner.js';

export { MAX_PYTHON_SCRIPTS, MAX_SCRIPT_CHARS };

export function normalizePython(raw) {
  const list = Array.isArray(raw) ? raw
    : typeof raw === 'string' ? [raw]
      : (raw && typeof raw === 'object' ? [raw] : []);
  const out = [];
  for (const item of list) {
    if (out.length >= MAX_PYTHON_SCRIPTS) break;
    if (typeof item === 'string') {
      const code = item.trim().slice(0, MAX_SCRIPT_CHARS);
      if (code) out.push({ code });
      continue;
    }
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const code = typeof item.code === 'string' ? item.code.trim().slice(0, MAX_SCRIPT_CHARS) : '';
    if (!code) continue;
    const note = typeof item.note === 'string' ? item.note.trim().slice(0, 60) : '';
    out.push(note ? { code, note } : { code });
  }
  return out;
}
