/**
 * 文本附件：用户上传的 txt / md / json / csv / 代码等，当成参考资料随这一轮需求一起发给模型。
 *
 * 图片走 vision.js（先让视觉模型读成零件清单），这里只处理「本来就是文字」的文件：
 * - 上限在服务端再兜一遍：前端可以绕过，模型上下文却会被一个 10 万字的日志直接吃光；
 * - 附件块用 `[[附件 n/m：名字]] … [[/附件]]` 包起来，前端靠它把历史消息里的附件重新折成一条，
 *   正文里只留用户自己写的那几句话。
 */

/** 一次最多带几个文件 */
export const MAX_ATTACHMENTS = 3;
/** 单个文件最多读多少字（再长就截断，并在块头标出来） */
export const MAX_ATTACHMENT_CHARS = 12_000;
/** 所有附件加起来最多多少字 */
export const MAX_ATTACHMENT_TOTAL = 24_000;

export const ATTACHMENT_TAIL = '[[/附件]]';

/** 附件块第一行的格式：前端用同一条规则解析（改这里要同步 src/components/AiPanel.tsx） */
export function attachmentHead(index, count, name, truncated = false) {
  return `[[附件 ${index + 1}/${count}：${name}${truncated ? '（较长，已截断）' : ''}]]`;
}

/**
 * 校验并截断前端传来的附件。
 * @param {unknown} value `[{ name, text }]`
 * @returns {Array<{ name: string, text: string, truncated: boolean }>}
 */
export function parseAttachments(value) {
  const list = Array.isArray(value) ? value : [];
  const out = [];
  let total = 0;
  for (const item of list) {
    if (out.length >= MAX_ATTACHMENTS) break;
    const name = typeof item?.name === 'string' ? item.name.trim().slice(0, 120) : '';
    const raw = typeof item?.text === 'string' ? item.text : '';
    if (!raw.trim()) continue;
    const room = MAX_ATTACHMENT_TOTAL - total;
    if (room <= 0) break;
    let text = raw;
    let truncated = false;
    if (text.length > MAX_ATTACHMENT_CHARS) {
      text = text.slice(0, MAX_ATTACHMENT_CHARS);
      truncated = true;
    }
    if (text.length > room) {
      text = text.slice(0, room);
      truncated = true;
    }
    total += text.length;
    out.push({ name: name || `附件 ${out.length + 1}`, text, truncated });
  }
  return out;
}

/**
 * 把附件拼到需求后面。用户自己写的那句在最前，模型先看需求再看资料。
 * @param {string} message
 * @param {Array<{ name: string, text: string, truncated?: boolean }>} attachments
 */
export function applyAttachments(message, attachments) {
  const list = Array.isArray(attachments) ? attachments : [];
  if (!list.length) return message;
  const blocks = list.map((item, index) => [
    attachmentHead(index, list.length, item.name, item.truncated),
    item.text,
    ATTACHMENT_TAIL,
  ].join('\n'));
  return [message, ...blocks].filter(Boolean).join('\n\n');
}

/** 审计/日志用：`design.md 2.4k 字+1` —— 只记名字和规模，不记内容 */
export function describeAttachments(attachments) {
  const list = Array.isArray(attachments) ? attachments : [];
  if (!list.length) return '';
  return list
    .map((item) => `${item.name} ${(item.text.length / 1000).toFixed(1)}k 字${item.truncated ? '+' : ''}`)
    .join('、');
}
