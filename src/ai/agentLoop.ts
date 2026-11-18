/**
 * 工具循环（agent loop）：让 AI 自己「决定下一步做什么 → 调工具 → 看结果 → 再决定」。
 *
 * 这里是纯逻辑，不碰 React 也不碰 WebGL：模型调用、工具执行、截图都由调用方注入，
 * 因此可以在 Node 里整套跑通（见 scripts/agent-loop-test.ts）。
 *
 * 与「固定几步」的自检循环不同，这一版把工具做成了注册表驱动的通用循环：
 * - 模型每轮可返回 calls[]（想调用的工具列表），也可只给扁平字段（兼容 mock / 老模型）；
 * - 工具分两类：客户端副作用工具（apply / inspect / measure）由前端执行，
 *   服务端只读工具（search_recipes / describe_model / inspect_tree）通过 deps.callTool 执行；
 * - 依赖顺序：apply 先落地，再 inspect/measure，只读工具可并行穿插——否则模型看到的是改之前的画面；
 * - 打转时不再只是停下：先 deps.recall() 召回一条知识换策略，再决定要不要停。
 */
import type { AiInspectView, AiMeasureRequest } from '../data';

/** 一次通用工具调用（与 server/ai/tools.js 的注册表 call 同构） */
export interface AgentToolCall {
  id?: string;
  name: string;
  args?: Record<string, unknown>;
  side?: 'server' | 'client';
  title?: string;
  /** 服务端工具执行后回填的结果文本（由 callTool 返回） */
  result?: string;
  ok?: boolean;
}

/** 一次请求要发出去的东西（与 aiApi.planStream 的参数一一对应） */
export interface AgentRound {
  text: string;
  images: string[];
  thumbs: string[];
  files: Array<{ name: string; text: string }>;
  /** 末尾几张缩略图是自动截的视口截图（落库时用来区分参考图与自检图） */
  shots: number;
}

/** 模型这一轮的决策：calls 是真相源，扁平字段保留以兼容 mock / 老模型 */
export interface AgentDecision {
  reply?: string;
  ops?: Array<Record<string, unknown>>;
  inspect?: AiInspectView[];
  measure?: AiMeasureRequest[];
  done?: boolean;
  calls?: AgentToolCall[];
  /** 服务端工具在响应里已经执行好的只读结果（search_recipes 等），需回灌给模型 */
  notes?: string;
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
  | { type: 'tool'; step: number; name: string; title: string; ok: boolean }
  | { type: 'recall'; step: number; text: string }
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
  /** 累计执行了几次工具（含只读） */
  toolCalls: number;
  /** 打转时召回过几次知识 */
  recalls: number;
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
  /**
   * 执行服务端只读工具（search_recipes / describe_model / inspect_tree）。
   * 返回给模型看的文字；不提供时忽略这些工具调用。
   */
  callTool?(name: string, args: Record<string, unknown>): Promise<string>;
  /**
   * 打转时召回知识换策略：返回一段给模型的提示（如履带配方 / 可复用模型）。
   * 不提供时打转照旧直接停。
   */
  recall?(goal: string): Promise<string>;
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

/** 一次自检闭环最多跑几轮。5 轮足够「初稿 → 看 → 修 → 再看 → 收尾」，再多基本是在打转 */
export const MAX_AGENT_STEPS = 5;
/** 连续几次空转（要同样的视角 / 改不动还不改）就判定为打转 */
export const MAX_AGENT_IDLE = 2;
/** 每轮复述用户需求时的截断长度：太长会把上下文挤掉，也不能短到语义残缺 */
export const GOAL_CLIP = 400;
/** 第一轮改完就说「完成」时，替它挑的默认复核视角（前视 / 右视 / 等轴测） */
export const FIRST_LOOK_VIEWS: AiInspectView[] = [
  { view: 'front', label: '前视' },
  { view: 'right', label: '右视' },
  { view: 'iso', label: '等轴测' },
];

export function clipGoal(goal: string): string {
  const text = String(goal ?? '').replace(/\s+/g, ' ').trim();
  return text.length <= GOAL_CLIP ? text : `${text.slice(0, GOAL_CLIP)}…`;
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
 * 把模型这一轮的决策拆成可执行的动作。
 * calls[] 优先；没有 calls 时从扁平字段还原（兼容 mock 与不支持 tool calling 的老模型）。
 * 这样注册表驱动的新工具链和老自检循环可以在同一个循环里跑。
 */
export interface AgentActions {
  ops: Array<Record<string, unknown>>;
  views: AiInspectView[];
  measures: AiMeasureRequest[];
  serverCalls: AgentToolCall[];
  finish: boolean;
  finishNote: string;
}

export function extractActions(decision: AgentDecision, canMeasure = true, canTool = true): AgentActions {
  const actions: AgentActions = {
    ops: [], views: [], measures: [], serverCalls: [], finish: false, finishNote: '',
  };
  const calls = Array.isArray(decision.calls) ? decision.calls : [];
  if (!calls.length) {
    // 老格式：扁平字段
    actions.ops = Array.isArray(decision.ops) ? decision.ops : [];
    actions.views = Array.isArray(decision.inspect) ? decision.inspect : [];
    actions.measures = canMeasure && Array.isArray(decision.measure) ? decision.measure : [];
    actions.finish = decision.done === true;
    return actions;
  }
  for (const call of calls) {
    const args = call.args ?? {};
    switch (call.name) {
      case 'apply_bim_ops':
        if (Array.isArray(args.ops)) actions.ops.push(...args.ops as Array<Record<string, unknown>>);
        if (args.done === true) actions.finish = true;
        // 老格式兼容：apply_bim_ops 里直接带了 inspect / measure
        if (Array.isArray(args.inspect)) actions.views.push(...args.inspect as AiInspectView[]);
        if (canMeasure && Array.isArray(args.measure)) actions.measures.push(...args.measure as AiMeasureRequest[]);
        break;
      case 'inspect':
        if (Array.isArray(args.views)) actions.views.push(...args.views as AiInspectView[]);
        break;
      case 'measure':
        if (canMeasure && Array.isArray(args.requests)) actions.measures.push(...args.requests as AiMeasureRequest[]);
        break;
      case 'finish':
        actions.finish = true;
        if (typeof args.note === 'string') actions.finishNote = args.note;
        break;
      default:
        // 注册表里的服务端只读工具（search_recipes / describe_model / inspect_tree）
        if (canTool && (call.side === 'server' || !call.side)) actions.serverCalls.push(call);
    }
  }
  // 扁平 done 也算（有些模型在 calls 里没写 finish，但 done=true）
  if (decision.done === true) actions.finish = true;
  return actions;
}

/**
 * 巡检回传给模型的那段话。
 * 四件事必须说清，否则模型会「看图不说话」或者干脆重复上一轮：
 * 1. 它的修改到底落没落地（落了 → 图里是改完的样子；没落 → 别以为改过了）；
 * 2. 附图分别是哪个视角（四张堆一起它分不清哪个是俯视）；
 * 3. 工具结果（查到的配方 / 模板详情）原样回传；
 * 4. 原始需求原话 + 现在还剩几步（长循环里它会跑偏）。
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
  toolNotes?: string;
}): string {
  const { step, maxSteps, goal, applyNote, applyError, shots, referenceCount = 0, measureText, toolNotes } = args;
  const lines: string[] = [`[自检第 ${step}/${maxSteps} 步]`];

  if (applyError) {
    lines.push(`你上一步的修改没有落地：${applyError}`);
    lines.push(shots.length ? '所以下面这些图还是修改前的样子。' : '请按提示修正后重新输出工具调用，不要再重复同样的问题。');
  } else if (applyNote) {
    lines.push(`上一步的修改已经应用到模型：${applyNote}。${shots.length ? '下面这些图就是改完之后的样子。' : ''}`);
  }
  if (toolNotes) lines.push(toolNotes);

  if (shots.length) {
    if (referenceCount) lines.push(`前 ${referenceCount} 张是用户原始参考图，不是当前模型。先对照整体轮廓、比例和关键部件位置，再看细节；区分视角差异与几何差异，不可把遮挡部分当作已核实。`);
    lines.push('你要的视角已经切好并截图，按下面的顺序附在本条消息里：');
    lines.push(shots.map((shot, index) => `${index + referenceCount + 1}. ${shot.label}`).join('\n'));
  } else if (referenceCount) {
    lines.push(`本条附带 ${referenceCount} 张用户原始参考图。`);
  }
  if (measureText) lines.push(measureText);

  lines.push(`用户的需求原话仍然是：「${clipGoal(goal)}」`);
  lines.push(
    '现在自己决定下一步，不要反问用户；只有关键尺寸、用途或参照无法合理估计时才提出具体问题：',
    '- 先列出观察到的主要差异，按整体轮廓、比例与位置、连接与间隙、显著细节排序；优先修影响最大的差异。',
    '- 不确定某类物体怎么做、想复用现成案例时，先用 search_recipes / describe_model 查资料，再据结果建模，不要凭印象硬拼。',
    '- 修改前核对特征的形状和变换；曲面有凹凸或转折时使用足够的截面或轮廓点，不用叠放的方块掩盖主形状错误。',
    '- 每次修改后用相近视角复核；对遮挡、未截到或缺少工具证据的部位标为未验证；需要核对位置、间距或穿插时用 measure，没有测量结果就不要声称已经测量。',
    '- 已经满足需求 → 调用 finish（或 done:true），reply 说明你在图里核对到了什么；',
    '- 还没满足 → 优先用 apply_bim_ops 里的 setDimensions / editFeature / addFeature 精确修改；基本形状错误时用 replaceFeature 替换对应特征，并再给 inspect 复核；',
    '- 不要重复上一轮已经看过的同一组视角却不做任何修改。',
  );
  if (step >= maxSteps) {
    lines.push(`注意：这是最后一步（共 ${maxSteps} 步）；如果仍有差异或修改尚未复核，明确说明未完成，不要仅因步数用尽而宣称满足需求。`);
  }
  return lines.join('\n');
}

/**
 * 打转时召回知识换策略：成功返回一段提示（计入 recalls），失败返回空串。
 * 用 noteParts 里是否有「已召回知识」标记防止反复召回。
 */
async function maybeRecall(deps: AgentDeps, step: number, noteParts: string[]): Promise<string> {
  if (!deps.recall) return '';
  if (noteParts.some((part) => part.includes('【已召回知识】'))) return '';
  try {
    const text = await deps.recall(deps.goal);
    if (!text?.trim()) return '';
    deps.onStage?.({ type: 'recall', step, text });
    return `【已召回知识——换一个策略试试，不要重复上一轮】\n${text}`;
  } catch {
    return '';
  }
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
  let toolCalls = 0;
  let recalls = 0;
  let idle = 0;
  let lastViews = '';
  let reply = '';
  let unresolvedApplyFailure = false;
  let lastApplyError = '';
  /** 最近一次成功落地的说明（补拍复核时还要用它告诉模型「图里已经是改完的样子」） */
  let lastApplyNote = '';

  const finish = (reason: AgentEndReason): AgentRun => ({
    reason, steps, applied, shots, toolCalls, recalls, reply,
    ...(reason === 'apply-failed' && lastApplyError ? { error: lastApplyError } : {}),
  });
  const follow = (info: {
    applyNote?: string; applyError?: string; shotList?: AgentShot[];
    measureText?: string; toolNotes?: string;
  }) => {
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
        toolNotes: info.toolNotes,
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

    const actions = extractActions(decision, Boolean(deps.measure), Boolean(deps.callTool));

    // 1) 服务端只读工具（查配方 / 查模板 / 查特征树）：结果原样回灌，帮助它下一步决策。
    //    它们无副作用，可与本轮其它工具共存；结果先攒着，最后随截图一起回传。
    const toolNoteParts: string[] = [];
    if (decision.notes) toolNoteParts.push(decision.notes);
    for (const call of actions.serverCalls) {
      if (!deps.callTool) continue;
      try {
        const text = await deps.callTool(call.name, call.args ?? {});
        toolCalls += 1;
        call.result = text;
        call.ok = true;
        toolNoteParts.push(`【${call.title ?? call.name}的结果】\n${text}`);
        deps.onStage?.({ type: 'tool', step: steps, name: call.name, title: call.title ?? call.name, ok: true });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        call.ok = false;
        call.result = message;
        toolNoteParts.push(`【${call.title ?? call.name}执行失败】${message}`);
        deps.onStage?.({ type: 'tool', step: steps, name: call.name, title: call.title ?? call.name, ok: false });
      }
    }
    if (deps.stopped()) return finish('stopped');
    let toolNotes = toolNoteParts.join('\n\n') || undefined;

    // 2) 先落地 ops：agent 必须看到自己改完的样子，否则下一张截图还是旧的
    let applyNote = '';
    let applyError = '';
    let appliedThisStep = false;
    if (actions.ops.length) {
      try {
        const result = await deps.apply(actions.ops);
        applyNote = result?.note ?? '';
        lastApplyNote = applyNote;
        applied += 1;
        appliedThisStep = true;
        unresolvedApplyFailure = false;
        lastApplyError = '';
        deps.onStage?.({ type: 'applied', step: steps, count: actions.ops.length, note: applyNote });
      } catch (error) {
        applyError = error instanceof Error ? error.message : String(error);
        unresolvedApplyFailure = true;
        lastApplyError = applyError;
        deps.onStage?.({ type: 'apply-failed', step: steps, note: applyError });
      }
    }
    if (deps.stopped()) return finish('stopped');

    const views = actions.views;
    const measures = actions.measures;
    const finishRequested = actions.finish;

    if (unresolvedApplyFailure && !applyError && !views.length && !measures.length && !appliedThisStep) return finish('apply-failed');

    // 3) 它说满足了 / 第一轮刚落地就收工：先补拍一组默认视角自查，别放着没核对的模型就走。
    //    纯文字需求（无参考图）最容易踩这个坑：模型建完既不说 done 也不要求看，
    //    旧逻辑直接判 no-action，导致「履带画不好却从没复核」。只要第一轮成功落地就必须自检。
    const firstDraftNeedsLook = appliedThisStep && steps === 1 && (deps.ensureFirstLook !== false);
    if (!applyError && !views.length && !measures.length
      && (finishRequested || firstDraftNeedsLook || (appliedThisStep && (deps.referenceImages?.length ?? 0) > 0))) {
      const needsLook = deps.ensureFirstLook !== false && appliedThisStep
        && (steps === 1 || shots > 0 || (deps.referenceImages?.length ?? 0) > 0);
      if (!needsLook) return finish(finishRequested ? 'done' : 'no-action');
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
        toolNotes,
      });
      continue;
    }

    // 4) 没有要看的视角也没有要量的：要么等用户回答，要么带着校验错误让它自己再改一轮
    if (!views.length && !measures.length) {
      if (!applyError) {
        // 只调了只读工具（查资料）也是有效动作：结果已回灌，让它据此继续
        if (toolNotes) {
          round = follow({ toolNotes });
          continue;
        }
        return finish('no-action');
      }
      idle += 1;
      if (idle >= MAX_AGENT_IDLE) {
        const recalled = await maybeRecall(deps, steps, toolNoteParts);
        if (recalled) {
          recalls += 1;
          toolNotes = [toolNotes, recalled].filter(Boolean).join('\n\n');
          round = follow({ applyError, toolNotes });
          idle = 0;
          continue;
        }
        return finish('repeated');
      }
      round = follow({ applyError, toolNotes });
      continue;
    }

    // 5) 转过去看 / 量：图和数字都是刚改完的样子
    const signature = `${viewSignature(views)}#${JSON.stringify(measures)}`;
    if (!actions.ops.length && signature === lastViews) {
      idle += 1;
      if (idle >= MAX_AGENT_IDLE) {
        const recalled = await maybeRecall(deps, steps, toolNoteParts);
        if (recalled) {
          recalls += 1;
          toolNotes = [toolNotes, recalled].filter(Boolean).join('\n\n');
          round = follow({ applyNote: applyNote || undefined, applyError: applyError || undefined, shotList: [], toolNotes });
          idle = 0;
          continue;
        }
        return finish('repeated');
      }
    } else {
      idle = 0;
    }
    lastViews = signature;

    const captured = views.length ? await deps.inspect(views) : [];
    if (views.length) {
      deps.onStage?.({ type: 'inspect', step: steps, views: views.map((view) => view.label), shots: captured.length });
    }
    if (deps.stopped()) return finish('stopped');
    if (views.length && !captured.length && !measures.length) return finish('inspect-failed');
    shots += captured.length;

    let measureText = '';
    if (measures.length) {
      measureText = await deps.measure!(measures);
      if (views.length && !captured.length) measureText = `你要的视角没有截到图（场景为空或视口不可用）。\n${measureText}`;
      deps.onStage?.({ type: 'measure', step: steps, count: measures.length });
      if (deps.stopped()) return finish('stopped');
    }

    round = follow({
      applyNote: applyNote || undefined, applyError: applyError || undefined,
      shotList: captured, measureText: measureText || undefined, toolNotes,
    });
  }
}

/** 兼容旧测试 / 外部脚本可能用到的名字 */
export const runSelfCheckLoop = runAgentLoop;
