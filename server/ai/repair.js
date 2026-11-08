/**
 * 生成阶段的「预校验 + 自动修正」。
 *
 * 以前只有 apply 会校验指令，于是模型给出边界外的尺寸（例如 5 mm 顶盖写 20 mm 倒圆）时，
 * 用户看到的是「生成成功 → 点应用到模型 → 报错」两段式体验，错误还得自己贴回聊天框，
 * 模型往往反问一句「请告诉我期望尺寸」——一次能改好的事变成三轮对话。
 *
 * 这里在把结果交给前端之前先 dry-run 一次 applyOps（纯内存、不写库、不建几何）：
 * - 通过：原样返回（附 repaired: 0）
 * - 不通过：把错误原文回灌给模型，让它自己改一轮（只改 1 轮，避免无限烧 token）
 * - 改完还不过：保留这次的指令但带上 warning，前端据此禁用「应用到模型」并给出「让 AI 修正」
 */
import { applyOps, OpsError } from './ops.js';

/** 只允许自动修正一轮：第二轮再错多半是理解问题，继续重试只会烧 token 和用户时间 */
const MAX_REPAIR = 1;

/** dry-run：只验证，不落库；返回第一条错误信息（null 表示通过） */
export function dryRun(document, ops) {
  if (!Array.isArray(ops) || !ops.length) return null;
  try {
    applyOps(document, ops);
    return null;
  } catch (error) {
    if (error instanceof OpsError) return error.message;
    // 非预期异常不能吞：说明 applyOps 有 bug，直接抛出去留痕
    throw error;
  }
}

function repairPrompt(problem) {
  return `【服务端校验反馈】上一次输出的指令被拒绝，原因：${problem}

请直接修正这个字段（尺寸必须在允许范围内；提示里给了上限就用它），然后重新输出**完整的** reply + ops。
不要只输出差异，不要在 reply 里解释校验过程，也不要反问用户——用户已经说清需求了，需要的是能通过校验的指令。`;
}

/**
 * @param {object} options
 * @param {(args: { message: string, context: object, history: Array, images?: Array }) => Promise<object>} options.run
 *   真正调用模型的函数（plan 或 planStream，两者返回同构结果）
 * @param {string} options.message 用户需求
 * @param {object} options.context 项目上下文
 * @param {Array} options.history 对话历史
 * @param {string} [options.memory] 更早对话压成的滚动摘要（长会话才有）
 * @param {Array} [options.images] 用户上传的参考图片（只在第一轮传，修正轮图片已被转成文字规格）
 * @param {object} options.document 当前项目文档（dry-run 的基准）
 * @param {(event: object) => void} [options.onEvent] 阶段事件（SSE 用）
 */
export async function planWithRepair({ run, message, context, history = [], memory = '', images = [], document, onEvent }) {
  const first = await run({ message, context, history, memory, images });
  let problem = dryRun(document, first?.ops);
  if (!problem) return { result: first, repaired: 0 };

  for (let attempt = 1; attempt <= MAX_REPAIR; attempt += 1) {
    onEvent?.({ type: 'status', text: `参数没通过校验（${problem}），正在自动修正…` });
    try {
      const fixed = await run({ message: `${message}\n\n${repairPrompt(problem)}`, context, history, memory });
      // 修正轮把指令删空（改成只回文字）等于推翻重来，保留第一轮更有价值
      if (!Array.isArray(fixed?.ops) || !fixed.ops.length) break;
      const stillBad = dryRun(document, fixed.ops);
      if (!stillBad) return { result: fixed, repaired: attempt };
      problem = stillBad;
    } catch {
      // 修正轮自己失败（超时 / 网关抖动）：保留第一轮结果，交给下面的 warning 分支
      break;
    }
  }

  const warning = `生成的参数未通过服务端校验（已自动修正仍未通过）：${problem}`;
  onEvent?.({ type: 'status', text: warning });
  return {
    result: {
      ...first,
      reply: `${warning}\n\n${first?.reply ?? ''}`.trim(),
      // 指令过不了校验就不能算「已满足需求」：清掉 done，让自检闭环把错误交回模型再改一轮
      done: false,
    },
    repaired: 0,
    warning,
  };
}
