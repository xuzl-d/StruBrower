/**
 * 自检闭环（agent loop）：让 AI 自己「改 → 落地 → 转视角看 → 再判断 → 再改」。
 *
 * 这里是纯逻辑，不碰 React 也不碰 WebGL：模型调用、应用指令、截图都由调用方注入，
 * 因此可以在 Node 里整套跑通（见 scripts/agent-loop-test.ts）。
 *
 * 一轮（step）里模型可能给五样东西：
 * - ops：要执行的修改。**先落地再截图**，否则它看到的是改之前的画面，会一直反复改同一个地方。
 * - inspect：要转过去截图的视角（最多 4 个）。截完把图连同说明发回给它。
 * - measure：要对当前特征树做的几何测量（表面位置 / 间距 / 包围盒），结果以文字回传。
 * - describe：只读查询完整特征树（被上下文裁掉的定义、id 与序号），结果以文字回传。
 * - done：它认为已经满足需求了。
 *
 * 什么时候停：
 * - done → 收工；
 * - 用户点了停止 → 立刻停（每轮开始、应用完、截完图都检查）；
 * - 没有 ops、inspect、measure、describe → 它停下来提问或只是给建议，交回用户；
 * - 反复要同样的视角或查询却什么都没改 → 在打转，停（防止无限烧 token）；
 * - 步数上限（默认 5）→ 停。
 */
import type { AiDescribeRequest, AiInspectView, AiMeasureRequest, AiPythonRequest } from '../data';

/** 一次自检闭环最多跑几轮。5 轮足够「初稿 → 看 → 修 → 再看 → 收尾」，再多基本是在打转 */
export const MAX_AGENT_STEPS = 5;
/** 连续几次空转（要同样的视角 / 改不动还不改）就判定为打转 */
export const MAX_AGENT_IDLE = 2;
/** 每轮复述用户需求时的截断长度：太长会把上下文挤掉，也不能短到语义残缺 */
export const GOAL_CLIP = 400;
/**
 * 工具结果回灌的字符预算。
 * describe 已经在源头上限到 1.6 万（`MAX_TOTAL_CHARS`），这里给 2 万是为了让那份结果**完整**进来：
 * 两边都设 1.6 万，尾部「用 from 继续查」的提示会正好被切掉。
 * measure 结果通常只有几百字，6 千足够。两项加上回执本身仍在服务端的内部轮上限（3.2 万）以内。
 */
export const TOOL_TEXT_CLIP = 20_000;
export const MEASURE_TEXT_CLIP = 6_000;
/** Python 脚本结果（服务端已限到 1.2 万），这里再兜一层 */
export const PYTHON_TEXT_CLIP = 12_000;
/**
 * 三段工具结果**合计**预算：describe 2 万 + measure 6 千 + python 1.2 万 = 3.8 万，
 * 单独设上限会超过服务端内部轮 3.2 万闸门，又变回「需求描述过长」。
 * 按 measure → describe → python 的顺序分配剩余额度，给回执本体留 4 千。
 */
export const TOOL_TOTAL_CLIP = 28_000;
/** 第一轮改完就说「完成」时，替它挑的默认复核视角（前视 / 右视 / 等轴测） */
export const FIRST_LOOK_VIEWS: AiInspectView[] = [
  { view: 'front', label: '前视' },
  { view: 'right', label: '右视' },
  { view: 'iso', label: '等轴测' },
];

/** 一轮请求要发出去的东西（与 aiApi.planStream 的参数一一对应） */
export interface AgentRound {
  text: string;
  images: string[];
  thumbs: string[];
  files: Array<{ name: string; text: string }>;
  /** 末尾几张缩略图是自动截的视口截图（落库时用来区分参考图与自检图） */
  shots: number;
}

/** 模型这一轮的决策 */
export interface AgentDecision {
  reply?: string;
  ops?: Array<Record<string, unknown>>;
  inspect?: AiInspectView[];
  measure?: AiMeasureRequest[];
  describe?: AiDescribeRequest[];
  /** 服务端执行的 Python 脚本（结果已经在 pythonText 里，前端不需要再跑一次） */
  python?: AiPythonRequest[];
  pythonText?: string;
  done?: boolean;
}

/** 截到的一张视角图 */
export interface AgentShot {
  label: string;
  dataUrl: string;
  thumb: string;
}

/** 循环对外广播的每一步（前端据此更新进度文案） */
export type AgentStage =
  | { type: 'plan'; step: number; decision: AgentDecision }
  | { type: 'applied'; step: number; count: number; note: string }
  | { type: 'apply-failed'; step: number; note: string }
  | { type: 'inspect'; step: number; views: string[]; shots: number }
  | { type: 'measure'; step: number; count: number }
  | { type: 'describe'; step: number; count: number }
  | { type: 'python'; step: number; count: number }
  | { type: 'stop'; step: number };

export type AgentEndReason =
  /** 模型自己说满足了 */
  | 'done'
  /** 用户点了停止 */
  | 'stopped'
  /** 跑满步数 */
  | 'max-steps'
  /** 模型没给动作（在提问 / 只给建议） */
  | 'no-action'
  /** 想看却一张也没截到（场景空、视口不可用） */
  | 'inspect-failed'
  | 'apply-failed'
  /** 反复要同样的视角 / 改不动，判定为打转 */
  | 'repeated';

export interface AgentRun {
  reason: AgentEndReason;
  /** 跑了几轮 */
  steps: number;
  /** 成功落地的轮数（不是指令条数） */
  applied: number;
  /** 累计截到几张 */
  shots: number;
  /** 最后一轮的说明 */
  reply: string;
  error?: string;
}

export interface AgentDeps {
  /** 用户这次的需求原话（每轮复述，防止历史被裁剪后它忘了要做什么） */
  goal: string;
  referenceImages?: string[];
  referenceThumbs?: string[];
  /** 请求模型（前端是流式，测试里可以是假函数） */
  plan(round: AgentRound): Promise<AgentDecision>;
  /** 把指令写进模型，返回一句给模型看的结果说明；失败就抛（错误会被回灌给它自己改） */
  apply(ops: Array<Record<string, unknown>>): Promise<{ note: string }>;
  /** 转视角 + 截图 */
  inspect(views: AiInspectView[]): Promise<AgentShot[]>;
  /** 对当前模型做几何测量，返回给模型看的文字；不提供则忽略模型的 measure */
  measure?(requests: AiMeasureRequest[]): Promise<string>;
  /** 只读查询当前文档的特征树，返回给模型看的文字；不提供则忽略模型的 describe */
  describe?(requests: AiDescribeRequest[]): Promise<string>;
  /** 用户是否已经点了停止 */
  stopped(): boolean;
  onStage?(stage: AgentStage): void;
  maxSteps?: number;
  /**
   * 第一轮改完就写 done、却一眼都没看时，替它截一组默认视角再让它判断。
   * 「自检」这个名字得对得起——光看特征树数字就说没问题，正是「不像」的老毛病。
   */
  ensureFirstLook?: boolean;
}

export function clipGoal(goal: string): string {
  const text = String(goal ?? '').replace(/\s+/g, ' ').trim();
  return text.length <= GOAL_CLIP ? text : `${text.slice(0, GOAL_CLIP)}…`;
}

/**
 * 工具结果按**行边界**截断：describe 一行就是一个特征的完整 JSON，
 * 从字符中间切开会让模型看到半个定义，反倒诱导它照着错的结构写 patch。
 * 截断后明确告诉它剩下的怎么取，否则它会原样重发同一个查询。
 */
export function clipToolText(
  text: string,
  budget: number,
  hint = '剩下的用 describe 的 from/count 分页取，不要重复请求同一段',
): string {
  const source = String(text ?? '');
  if (source.length <= budget) return source;
  const head = source.slice(0, budget);
  const lineBreak = head.lastIndexOf('\n');
  const kept = lineBreak > budget * 0.6 ? head.slice(0, lineBreak) : head;
  return `${kept}\n…（以上只是前 ${kept.length} 字，工具结果共 ${source.length} 字，已按 ${budget} 字截断；`
    + `${hint}）`;
}

/** 视角列表的指纹：只有「要的还是一样的视角」才算出重复（角度先归一化，400° 与 40° 是同一个方向） */
export function viewSignature(views: AiInspectView[] | undefined): string {
  const angle = (value: unknown, wrap: number) => {
    const num = Number(value);
    if (!Number.isFinite(num)) return 0;
    return wrap ? ((Math.round(num) % wrap) + wrap) % wrap : Math.round(num);
  };
  return (Array.isArray(views) ? views : [])
    .map((view) => {
      const direction = view.view ?? `${angle(view.azimuth, 360)}/${angle(view.elevation, 0)}`;
      const focus = typeof view.focus === 'string' ? view.focus.trim() : '';
      const zoom = typeof view.zoom === 'number' && Number.isFinite(view.zoom) ? Math.round(view.zoom * 10) / 10 : 1;
      return focus || zoom !== 1 ? `${direction}:${JSON.stringify(focus)}:${zoom}` : direction;
    })
    .join('|');
}

/**
 * 巡检回传给模型的那段话。
 * 三件事必须说清，否则模型会「看图不说话」或者干脆重复上一轮：
 * 1. 它的修改到底落没落地（落了 → 图里是改完的样子；没落 → 别以为改过了）；
 * 2. 附图分别是哪个视角（四张堆一起它分不清哪个是俯视）；
 * 3. 原始需求原话 + 现在还剩几步（长循环里它会跑偏）。
 */
export function stepPrompt(args: {
  step: number;
  maxSteps: number;
  goal: string;
  applyNote?: string;
  applyError?: string;
  shots: Array<{ label: string }>;
  referenceCount?: number;
  measureText?: string;
  describeText?: string;
  pythonText?: string;
}): string {
  const { step, maxSteps, goal, applyNote, applyError, shots, referenceCount = 0, measureText, describeText, pythonText } = args;
  const lines: string[] = [`[自检第 ${step}/${maxSteps} 步]`];

  if (applyError) {
    lines.push(`你上一步的修改没有落地：${applyError}`);
    lines.push(shots.length ? '所以下面这些图还是修改前的样子。' : '请按提示修正后重新输出 ops，不要再重复同样的问题。');
  } else if (applyNote) {
    lines.push(`上一步的修改已经应用到模型：${applyNote}。${shots.length ? '下面这些图就是改完之后的样子。' : ''}`);
  }

  if (shots.length) {
    if (referenceCount) lines.push(`前 ${referenceCount} 张是用户原始参考图，不是当前模型。先对照整体轮廓、比例和关键部件位置，再看细节；区分视角差异与几何差异，不可把遮挡部分当作已核实。`);
    lines.push('你要的视角已经切好并截图，按下面的顺序附在本条消息里：');
    lines.push(shots.map((shot, index) => `${index + referenceCount + 1}. ${shot.label}`).join('\n'));
  } else if (referenceCount) {
    lines.push(`本条附带 ${referenceCount} 张用户原始参考图。`);
  }
  let budget = TOOL_TOTAL_CLIP;
  const addToolText = (text: string | undefined, limit: number, hint?: string) => {
    if (!text || budget <= 0) return;
    const take = Math.min(limit, budget);
    lines.push(clipToolText(text, take, hint));
    budget -= Math.min(text.length, take);
  };
  addToolText(measureText, MEASURE_TEXT_CLIP);
  addToolText(describeText, TOOL_TEXT_CLIP);
  addToolText(pythonText, PYTHON_TEXT_CLIP, '剩下的请在脚本里只 emit 关键数值，不要重复同一段脚本');
  if (pythonText && budget <= 0) {
    lines.push('（本轮 Python 结果因工具结果总预算用尽未完整回灌，请减少 describe 的 count 再查一次）');
  }

  lines.push(`用户的需求原话仍然是：「${clipGoal(goal)}」`);
  lines.push(
    '现在自己判断，不要反问用户是否继续；只有关键尺寸、用途或参照无法合理估计时才提出具体问题：',
    '- 先列出观察到的主要差异，按整体轮廓、比例与位置、连接与间隙、显著细节排序；优先修影响最大的差异。',
    '- 修改前核对特征的形状和变换；曲面有凹凸或转折时使用足够的截面或轮廓点，不用叠放的方块掩盖主形状错误。'
      + '上下文里被裁剪或标了 shapeDataOmitted 的特征，先用 describe 取原始定义再改，不要照摘要猜字段；改过模型后要重新查。',
    '- 每次修改后用相近视角复核；对遮挡、未截到或缺少工具证据的部位标为未验证；需要核对位置、间距或穿插时用 measure，没有测量结果就不要声称已经测量。',
    '- 已经满足需求 → done 设 true、ops 留空，reply 说明你在图里核对到了什么；',
    '- 还没满足 → 优先用 setDimensions / editFeature / addFeature 精确修改；基本形状错误时用 replaceFeature 替换对应特征，并再给 inspect 复核；',
    '- 不要重复上一轮已经看过的同一组视角却不做任何修改。',
  );
  if (step >= maxSteps) {
    lines.push(`注意：这是最后一步（共 ${maxSteps} 步）；如果仍有差异或修改尚未复核，明确说明未完成，不要仅因步数用尽而宣称满足需求。`);
  }
  return lines.join('\n');
}

/**
 * 跑一轮闭环。出错（网络 / 模型异常 / 用户中止）直接冒泡给调用方处理，
 * 这里只负责「哪一轮做什么、什么时候停」。
 */
export async function runAgentLoop(first: AgentRound, deps: AgentDeps): Promise<AgentRun> {
  const maxSteps = Math.max(1, deps.maxSteps ?? MAX_AGENT_STEPS);
  let round = first;
  let steps = 0;
  let applied = 0;
  let shots = 0;
  let idle = 0;
  let lastViews = '';
  let reply = '';
  let unresolvedApplyFailure = false;
  let lastApplyError = '';
  /** 最近一次成功落地的说明（补拍复核时还要用它告诉模型「图里已经是改完的样子」） */
  let lastApplyNote = '';

  const finish = (reason: AgentEndReason): AgentRun => ({ reason, steps, applied, shots, reply, ...(reason === 'apply-failed' && lastApplyError ? { error: lastApplyError } : {}) });
  const follow = (info: { applyNote?: string; applyError?: string; shotList?: AgentShot[]; measureText?: string; describeText?: string; pythonText?: string }) => {
    const captured = info.shotList ?? [];
    const references = (deps.referenceImages ?? []).slice(0, captured.length ? 3 : 4);
    const referenceThumbs = (deps.referenceThumbs ?? []).slice(0, references.length);
    const includedShots = captured.slice(0, 4 - references.length);
    return {
      text: stepPrompt({
        step: steps + 1,
        maxSteps,
        goal: deps.goal,
        applyNote: info.applyNote,
        applyError: info.applyError,
        shots: includedShots,
        referenceCount: references.length,
        measureText: info.measureText,
        describeText: info.describeText,
        pythonText: info.pythonText,
      }),
      images: [...references, ...includedShots.map((shot) => shot.dataUrl)],
      thumbs: [...referenceThumbs, ...includedShots.map((shot) => shot.thumb)],
      files: [],
      shots: includedShots.length,
    };
  };

  for (;;) {
    if (steps >= maxSteps) return finish('max-steps');
    if (deps.stopped()) return finish('stopped');

    steps += 1;
    const decision = await deps.plan(round);
    reply = String(decision.reply ?? '');
    deps.onStage?.({ type: 'plan', step: steps, decision });
    // Python 脚本已经在服务端跑完，结果随本轮响应回来；这里只播报，不再发请求
    const pythons = Array.isArray(decision.python) ? decision.python : [];
    if (pythons.length) deps.onStage?.({ type: 'python', step: steps, count: pythons.length });

    // 1) 先落地：agent 必须看到自己改完的样子，否则下一张截图还是旧的
    let applyNote = '';
    let applyError = '';
    let appliedThisStep = false;
    if (decision.ops?.length) {
      try {
        const result = await deps.apply(decision.ops);
        applyNote = result?.note ?? '';
        lastApplyNote = applyNote;
        applied += 1;
        appliedThisStep = true;
        unresolvedApplyFailure = false;
        lastApplyError = '';
        deps.onStage?.({ type: 'applied', step: steps, count: decision.ops.length, note: applyNote });
      } catch (error) {
        applyError = error instanceof Error ? error.message : String(error);
        unresolvedApplyFailure = true;
        lastApplyError = applyError;
        deps.onStage?.({ type: 'apply-failed', step: steps, note: applyError });
      }
    }
    if (deps.stopped()) return finish('stopped');

    const views = Array.isArray(decision.inspect) ? decision.inspect : [];
    const measures = deps.measure && Array.isArray(decision.measure) ? decision.measure : [];
    const describes = deps.describe && Array.isArray(decision.describe) ? decision.describe : [];
    // python 的结果要回灌后模型才能据此写 ops，所以也算「还需要再走一轮」
    const queries = measures.length + describes.length + pythons.length;

    if (unresolvedApplyFailure && !applyError && !views.length && !queries && !appliedThisStep) return finish('apply-failed');

    // 2) 它说满足了、也没别的要看：正常情况下收工。
    //    但如果这是**第一轮**、它刚改了东西又一眼没看，就先替它复核一组默认视角再放行。
    if (!applyError && !views.length && !queries && (decision.done || (appliedThisStep && (deps.referenceImages?.length ?? 0) > 0))) {
      const needsLook = deps.ensureFirstLook !== false && appliedThisStep
        && (steps === 1 || shots > 0 || (deps.referenceImages?.length ?? 0) > 0);
      if (!needsLook) return finish(decision.done ? 'done' : 'no-action');
      if (steps >= maxSteps) return finish('max-steps');
      const captured = await deps.inspect(FIRST_LOOK_VIEWS);
      deps.onStage?.({
        type: 'inspect',
        step: steps,
        views: FIRST_LOOK_VIEWS.map((view) => view.label),
        shots: captured.length,
      });
      if (deps.stopped()) return finish('stopped');
      if (!captured.length) return finish('inspect-failed');
      shots += captured.length;
      reply = '';
      round = follow({
        applyNote: `${lastApplyNote || '修改已落地'}；这一组视角是系统补拍的（你没要求看图，但改完总得核对一眼）`,
        shotList: captured,
      });
      continue;
    }

    // 3) 没有要看的视角也没有要查的：要么等用户回答，要么带着校验错误让它自己再改一轮
    if (!views.length && !queries) {
      if (!applyError) return finish('no-action');
      idle += 1;
      if (idle >= MAX_AGENT_IDLE) return finish('repeated');
      round = follow({ applyError });
      continue;
    }

    // 4) 转过去看 / 量：图和数字都是刚改完的样子
    const signature = `${viewSignature(views)}#${JSON.stringify(measures)}#${JSON.stringify(describes)}`
      + `#${pythons.map((item) => String(item.code ?? '').slice(0, 120)).join('|')}`;
    if (!decision.ops?.length && signature === lastViews) {
      idle += 1;
      if (idle >= MAX_AGENT_IDLE) return finish('repeated');
    } else {
      idle = 0;
    }
    lastViews = signature;

    const captured = views.length ? await deps.inspect(views) : [];
    if (views.length) {
      deps.onStage?.({ type: 'inspect', step: steps, views: views.map((view) => view.label), shots: captured.length });
    }
    if (deps.stopped()) return finish('stopped');
    if (views.length && !captured.length && !queries) return finish('inspect-failed');
    shots += captured.length;

    let measureText = '';
    if (measures.length) {
      measureText = await deps.measure!(measures);
      if (views.length && !captured.length) measureText = `你要的视角没有截到图（场景为空或视口不可用）。\n${measureText}`;
      deps.onStage?.({ type: 'measure', step: steps, count: measures.length });
      if (deps.stopped()) return finish('stopped');
    }
    let describeText = '';
    if (describes.length) {
      describeText = await deps.describe!(describes);
      if (views.length && !captured.length && !measures.length) describeText = `你要的视角没有截到图（场景为空或视口不可用）。\n${describeText}`;
      deps.onStage?.({ type: 'describe', step: steps, count: describes.length });
      if (deps.stopped()) return finish('stopped');
    }

    round = follow({
      applyNote: applyNote || undefined,
      applyError: applyError || undefined,
      shotList: captured,
      measureText: measureText || undefined,
      describeText: describeText || undefined,
      pythonText: decision.pythonText || undefined,
    });
  }
}
