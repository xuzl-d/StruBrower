/**
 * 自检闭环（agent loop）测试：AI 能不能自己「改 → 落地 → 转视角看 → 再判断」，
 * 以及什么时候必须停下来（用户中止 / 步数上限 / 打转 / 没动作）。
 * 纯逻辑，不需要浏览器也没有 WebGL：模型、应用、截图全是假的。
 */
import { clipGoal, MAX_AGENT_STEPS, runAgentLoop, stepPrompt, viewSignature } from '../src/ai/agentLoop';
import type { AgentDecision, AgentRound, AgentShot } from '../src/ai/agentLoop';

let failed = 0;
function check(name: string, ok: boolean, detail?: unknown) {
  if (ok) console.log('  ✓', name);
  else { failed += 1; console.log('  ✗', name, detail ?? ''); }
}

const front = { view: 'front' as const, label: '前视' };
const right = { view: 'right' as const, label: '右视' };
const iso = { view: 'iso' as const, label: '等轴测' };

const first: AgentRound = { text: '做一个螺丝刀，转一圈确认没问题', images: [], thumbs: [], files: [], shots: 0 };

function shot(label: string): AgentShot {
  return { label, dataUrl: `data:image/jpeg;base64,${label}`, thumb: `thumb:${label}` };
}

/** 按脚本依次返回决策，并记录每轮收到了什么 */
function scripted(decisions: AgentDecision[]) {
  const calls: AgentRound[] = [];
  const plan = async (round: AgentRound) => {
    calls.push({ ...round, images: [...round.images], thumbs: [...round.thumbs] });
    const next = decisions[Math.min(calls.length - 1, decisions.length - 1)];
    if (!next) throw new Error('脚本用完了');
    return next;
  };
  return { plan, calls };
}

// ── 1. 一步收工 ───────────────────────────────────────────────
{
  const { plan, calls } = scripted([{ reply: '已经满足', done: true }]);
  let appliedCount = 0;
  const run = await runAgentLoop(first, {
    goal: first.text,
    plan,
    apply: async () => { appliedCount += 1; return { note: '' }; },
    inspect: async () => [],
    stopped: () => false,
  });
  check('done 立即收工', run.reason === 'done' && run.steps === 1, run);
  check('done 那轮不调 apply', appliedCount === 0);
  check('只请求了一次模型', calls.length === 1);
}

// ── 2. 改了但没说要再看：停下来交给用户，不硬循环 ───────────────
{
  const { plan, calls } = scripted([{ reply: '已生成', ops: [{ op: 'addSolid' }] }]);
  const run = await runAgentLoop(first, {
    goal: first.text,
    plan,
    apply: async () => ({ note: '已应用 1 条指令，新 rev 7' }),
    inspect: async () => [shot('前视')],
    stopped: () => false,
  });
  check('没有 inspect 也没 done → no-action', run.reason === 'no-action' && run.applied === 1, run);
  check('no-action 只跑一轮', calls.length === 1 && run.steps === 1);
  check('统计到一次落地', run.applied === 1);
}

// ── 3. 完整闭环：改 → 看 → 改 → 看 → 确认 ─────────────────────
{
  const { plan, calls } = scripted([
    { reply: '先出初稿，然后自己看一眼', ops: [{ op: 'addSolid' }], inspect: [front, right] },
    { reply: '侧面看握把角度不对，改一下再看', ops: [{ op: 'editFeature' }], inspect: [iso] },
    { reply: '三个视角都核对了，比例与朝向正确', done: true },
  ]);
  const order: string[] = [];
  const run = await runAgentLoop(first, {
    goal: '做一个螺丝刀',
    plan: async (round) => { order.push(`plan:${round.images.length}`); return plan(round); },
    apply: async () => { order.push('apply'); return { note: '已应用 1 条指令，新 rev 8' }; },
    inspect: async (views) => { order.push(`inspect:${views.length}`); return views.map((view) => shot(view.label)); },
    stopped: () => false,
  });
  check('闭环跑到 done', run.reason === 'done', run);
  check('一共 3 轮、落地 2 次、截图 3 张', run.steps === 3 && run.applied === 2 && run.shots === 3, run);
  check('先落地再截图（第一轮 apply 在 inspect 之前）',
    order.slice(0, 3).join('>') === 'plan:0>apply>inspect:2', order);
  check('第二轮把两张图发回给模型', order[3] === 'plan:2', order);
  check('第三轮带着右视那张图', order[6] === 'plan:1', order);
  check('回传给模型的正文带视角顺序',
    calls[1]?.text.includes('1. 前视') && calls[1]?.text.includes('2. 右视'), calls[1]?.text);
  check('回传正文复述用户需求', Boolean(calls[1]?.text.includes('做一个螺丝刀')), calls[1]?.text);
  check('回传正文说明修改已落地', Boolean(calls[1]?.text.includes('已经应用到模型')), calls[1]?.text);
  check('跟进轮不再带附件', (calls[1]?.files ?? []).length === 0);
}

// ── 4. 用户随时终止：停止检查在每轮开始与截图之后 ────────────────
{
  const references = ['reference-1', 'reference-2', 'reference-3', 'reference-4'];
  const { plan, calls } = scripted([
    { ops: [{ op: 'addSolid' }], inspect: [front, right] },
    { done: true },
  ]);
  await runAgentLoop(first, {
    goal: '照图建模',
    referenceImages: references,
    referenceThumbs: references.map((reference) => `thumb:${reference}`),
    plan,
    apply: async () => ({ note: '已应用' }),
    inspect: async () => [shot('前视'), shot('右视')],
    stopped: () => false,
  });
  check('自检保留参考图并给截图留出位置', calls[1]?.images.join('|') === 'reference-1|reference-2|reference-3|data:image/jpeg;base64,前视', calls[1]);
  check('自检区分参考图与截图并标明顺序', calls[1]?.text.includes('前 3 张是用户原始参考图') && calls[1]?.text.includes('4. 前视'), calls[1]?.text);
  check('自检缩略图与截图数量一致', calls[1]?.thumbs.length === 4 && calls[1]?.shots === 1, calls[1]);
}

// ── 4. 用户随时终止：停止检查在每轮开始与截图之后 ────────────────
{
  let stopped = false;
  const { plan, calls } = scripted([
    { reply: '改一下', ops: [{ op: 'addSolid' }], inspect: [front] },
    { reply: '再改', ops: [{ op: 'editFeature' }], inspect: [right] },
    { reply: '还要继续', ops: [] },
  ]);
  const run = await runAgentLoop(first, {
    goal: first.text,
    plan,
    apply: async () => ({ note: 'ok' }),
    inspect: async () => { stopped = true; return [shot('前视')]; },
    stopped: () => stopped,
  });
  check('截图后立刻停（不再进下一轮）', run.reason === 'stopped' && run.steps === 1, run);
  check('停止后没有再请求模型', calls.length === 1, calls.length);
  check('停止时保留已落地的统计', run.applied === 1, run);

  // 一开始就是停止状态：一次模型都不该调
  let planCalls = 0;
  const idleRun = await runAgentLoop(first, {
    goal: first.text,
    plan: async () => { planCalls += 1; return { done: true }; },
    apply: async () => ({ note: '' }),
    inspect: async () => [],
    stopped: () => true,
  });
  check('已停止时一次都不发请求', idleRun.reason === 'stopped' && planCalls === 0, { idleRun, planCalls });
}

// ── 5. 步数上限：一直想看也不放过 ──────────────────────────────
{
  const parade = [front, right, iso, { view: 'top' as const, label: '俯视' }, { view: 'bottom' as const, label: '仰视' }];
  let step = 0;
  const run = await runAgentLoop(first, {
    goal: first.text,
    plan: async () => {
      step += 1;
      return { reply: `第 ${step} 步`, inspect: [parade[Math.min(step - 1, parade.length - 1)]] };
    },
    apply: async () => ({ note: '' }),
    inspect: async () => [shot('视图')],
    stopped: () => false,
  });
  check('跑满步数上限就停', run.reason === 'max-steps' && run.steps === MAX_AGENT_STEPS, run);
  check('模型调用次数等于上限', step === MAX_AGENT_STEPS, step);
}

// ── 6. 打转：反复要同样的视角却什么都不改 ───────────────────────
{
  let step = 0;
  const run = await runAgentLoop(first, {
    goal: first.text,
    plan: async () => { step += 1; return { reply: '我再看一眼', inspect: [front, right] }; },
    apply: async () => ({ note: '' }),
    inspect: async () => [shot('前视'), shot('右视')],
    stopped: () => false,
  });
  check('两次重复视角判定为打转', run.reason === 'repeated', run);
  // 第 1 轮是正常请求，第 2 轮同样视角算第一次可疑，第 3 轮还是同样视角才停
  check('打转在第 3 轮停手', step === 3, step);

  // 换成不同视角就不算打转
  const views = [[front], [right], [iso], [front], [right]];
  let index = 0;
  const varied = await runAgentLoop(first, {
    goal: first.text,
    plan: async () => ({ reply: '换角度看', inspect: views[Math.min(index++, views.length - 1)] }),
    apply: async () => ({ note: '' }),
    inspect: async () => [shot('视图')],
    stopped: () => false,
  });
  check('视角在变就不算打转', varied.reason === 'max-steps', varied);
}

// ── 7. 应用被拒绝：错误回灌给模型自己改 ───────────────────────
{
  const { plan, calls } = scripted([
    { reply: '改参数', ops: [{ op: 'editFeature' }] },
    { reply: '改好了', ops: [{ op: 'editFeature' }], done: true },
  ]);
  let attempt = 0;
  const run = await runAgentLoop(first, {
    goal: first.text,
    plan,
    apply: async () => {
      attempt += 1;
      if (attempt === 1) throw new Error('radius 超出允许范围（最大 0.02）');
      return { note: '已应用 1 条指令' };
    },
    inspect: async () => [],
    stopped: () => false,
  });
  check('应用失败后继续（不是直接失败）', run.reason === 'done' && run.applied === 1, run);
  check('失败那轮不计入落地', run.steps === 2);
  check('把校验错误写进回灌正文', calls[1]?.text.includes('radius 超出允许范围'), calls[1]?.text);
  check('回灌时要求它自己修、不要问用户', Boolean(calls[1]?.text.includes('不要再重复同样的问题')), calls[1]?.text);
}

// ── 8. 一直改不动：不无限重试 ─────────────────────────────────
{
  const { plan } = scripted([
    { ops: [{ op: 'addSolid' }] },
    { reply: '完成', done: true },
  ]);
  const run = await runAgentLoop(first, {
    goal: first.text,
    plan,
    apply: async () => { throw new Error('参数无效'); },
    inspect: async () => [],
    stopped: () => false,
  });
  check('失败后未修复直接宣称完成不能算成功', run.reason === 'apply-failed' && run.applied === 0 && run.error === '参数无效', run);
}

// ── 8. 一直改不动：不无限重试 ─────────────────────────────────
{
  const { plan, calls } = scripted([
    { ops: [{ op: 'addSolid' }], done: true },
    { ops: [{ op: 'addSolid' }], done: true },
  ]);
  let attempts = 0;
  const run = await runAgentLoop(first, {
    goal: first.text,
    plan,
    apply: async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('参数无效');
      return { note: '已应用' };
    },
    inspect: async () => [],
    stopped: () => false,
  });
  check('应用失败时不能因 done 提前结束', run.reason === 'done' && attempts === 2 && calls[1]?.text.includes('参数无效'), run);
}

{
  const { plan, calls } = scripted([
    { ops: [{ op: 'addSolid' }] },
    { done: true },
  ]);
  const run = await runAgentLoop(first, {
    goal: '照图建模',
    referenceImages: ['reference'],
    referenceThumbs: ['thumb:reference'],
    plan,
    apply: async () => ({ note: '已应用' }),
    inspect: async () => [shot('前视')],
    stopped: () => false,
  });
  check('看图建模未主动检查时自动复核', run.reason === 'done' && calls[1]?.images.join('|') === 'reference|data:image/jpeg;base64,前视', run);
  const noLook = await runAgentLoop(first, {
    goal: '照图建模',
    referenceImages: ['reference'],
    ensureFirstLook: false,
    plan: async () => ({ ops: [{ op: 'addSolid' }] }),
    apply: async () => ({ note: '已应用' }),
    inspect: async () => [],
    stopped: () => false,
  });
  check('关闭自动复核时不误报完成', noLook.reason === 'no-action', noLook);
}

// ── 8. 一直改不动：不无限重试 ─────────────────────────────────
{
  let step = 0;
  const run = await runAgentLoop(first, {
    goal: first.text,
    plan: async () => { step += 1; return { reply: '再试', ops: [{ op: 'editFeature' }] }; },
    apply: async () => { throw new Error('参数还是不对'); },
    inspect: async () => [],
    stopped: () => false,
  });
  check('改不动就判定为打转', run.reason === 'repeated', run);
  check('不会无限重试', step === 2, step);
}

// ── 9. 想看图却一张也没截到 ───────────────────────────────────
{
  const run = await runAgentLoop(first, {
    goal: first.text,
    plan: async () => ({ reply: '看一眼', inspect: [front] }),
    apply: async () => ({ note: '' }),
    inspect: async () => [],
    stopped: () => false,
  });
  check('截不到图就停（不空转烧 token）', run.reason === 'inspect-failed' && run.steps === 1, run);
}

// ── 10. done 与 inspect 同轮：先看完再收工 ─────────────────────
{
  const { plan, calls } = scripted([
    { reply: '改完顺便确认一下', ops: [{ op: 'addSolid' }], inspect: [iso], done: true },
    { reply: '确认无误', done: true },
  ]);
  const run = await runAgentLoop(first, {
    goal: first.text,
    plan,
    apply: async () => ({ note: '已应用' }),
    inspect: async () => [shot('等轴测')],
    stopped: () => false,
  });
  check('done 与 inspect 同轮时先看图', run.reason === 'done' && run.steps === 2, run);
  check('确实看了那一轮', calls.length === 2 && calls[1].images.length === 1, calls.length);
}

// ── 11. 阶段回调：前端进度文案靠它 ────────────────────────────
{
  const { plan, calls } = scripted([
    { ops: [{ op: 'addSolid' }], inspect: [front] },
    { ops: [{ op: 'editFeature' }], done: true },
    { done: true },
  ]);
  const run = await runAgentLoop(first, {
    goal: '照图建模',
    referenceImages: ['reference'],
    referenceThumbs: ['thumb:reference'],
    plan,
    apply: async () => ({ note: '已应用' }),
    inspect: async () => [shot('前视')],
    stopped: () => false,
  });
  check('已有截图后又修改并宣称完成，仍需复核最后一次修改', run.reason === 'done' && calls.length === 3 && calls[2]?.images[0] === 'reference', run);
}

{
  const run = await runAgentLoop(first, {
    goal: '照图建模',
    plan: async () => ({ ops: [{ op: 'addSolid' }], done: true }),
    apply: async () => ({ note: '已应用' }),
    inspect: async () => [shot('前视')],
    stopped: () => false,
    maxSteps: 1,
  });
  check('最后一步修改后未复核不能误报完成', run.reason === 'max-steps', run);
}

// ── 11. 阶段回调：前端进度文案靠它 ────────────────────────────
{
  const stages: string[] = [];
  await runAgentLoop(first, {
    goal: first.text,
    plan: async () => ({ reply: '改', ops: [{ op: 'addSolid' }], inspect: [front] }),
    apply: async () => ({ note: 'ok' }),
    inspect: async () => [shot('前视')],
    stopped: () => false,
    maxSteps: 1,
    onStage: (stage) => stages.push(stage.type),
  });
  check('阶段顺序：plan → applied → inspect', stages.join('>') === 'plan>applied>inspect', stages);
}

// ── 12. 提示词文本 ───────────────────────────────────────────
{
  const text = stepPrompt({ step: 3, maxSteps: 5, goal: '做一个 20cm 的螺丝刀', applyNote: '已应用 2 条指令', shots: [front, right] });
  check('带上第几步 / 共几步', text.includes('第 3/5 步'), text);
  check('列出视角序号与名字', text.includes('1. 前视') && text.includes('2. 右视'));
  check('复述原始需求', text.includes('做一个 20cm 的螺丝刀'));
  check('要求自己判断而不是反问', text.includes('不要反问用户'));
  check('优先处理轮廓、比例与连接', text.includes('整体轮廓、比例与位置、连接与间隙'));
  check('没有测量结果不得声称测量', text.includes('不要声称已经测量'));
  const withMeasure = stepPrompt({ step: 2, maxSteps: 5, goal: 'x', shots: [], measureText: '[几何测量结果] 示例' });
  check('测量结果文字被带进提示', withMeasure.includes('[几何测量结果] 示例'), withMeasure);
  const last = stepPrompt({ step: 5, maxSteps: 5, goal: 'x', shots: [] });
  check('最后一步给出收敛提示', last.includes('最后一步'), last);
  check('最后一步不得假装完成', last.includes('明确说明未完成'));
  check('没有附图时不写视角段', !last.includes('按下面的顺序附在'), last);

  const long = '需'.repeat(900);
  const clipped = clipGoal(long);
  check('需求过长会截断', clipped.length === 401 && clipped.endsWith('…'), clipped.length);
  check('短需求原样保留', clipGoal('  做 个 盒子  ') === '做 个 盒子', clipGoal('  做 个 盒子  '));
}

// ── 13. 视角指纹：写法不同但角度相同也要认成同一组 ─────────────
{
  check('预设视角指纹一致', viewSignature([front, right]) === viewSignature([{ view: 'front', label: 'x' }, { view: 'right', label: 'y' }]));
  check('角度写法归一', viewSignature([{ azimuth: 400, elevation: 20, label: 'a' }]) === '40/20', viewSignature([{ azimuth: 400, elevation: 20, label: 'a' }]));
  check('不同视角指纹不同', viewSignature([front]) !== viewSignature([right]));
  check('同角度不同聚焦对象不是重复视角', viewSignature([{ ...front, focus: '车灯' }]) !== viewSignature([{ ...front, focus: '后视镜' }]));
  check('同角度不同缩放不是重复视角', viewSignature([{ ...front, zoom: 2 }]) !== viewSignature([front]));
  check('默认缩放与省略缩放一致', viewSignature([{ ...front, zoom: 1 }]) === viewSignature([front]));
}

// ── 14. 第一轮改完就自称完成：先补拍一眼再放行 ─────────────────
{
  const { plan, calls } = scripted([
    { reply: '做好了，应该没问题', ops: [{ op: 'addSolid' }], done: true },
    { reply: '看过三个视角，确实没问题', done: true },
  ]);
  const asked: string[][] = [];
  const run = await runAgentLoop(first, {
    goal: first.text,
    plan,
    apply: async () => ({ note: '已应用 1 条指令（rev 9）' }),
    inspect: async (views) => { asked.push(views.map((view) => view.label)); return [shot('前视'), shot('右视'), shot('等轴测')]; },
    stopped: () => false,
  });
  check('改完就说完成 → 先补拍默认视角', run.reason === 'done' && run.steps === 2, run);
  check('补拍用的是 前视 / 右视 / 等轴测', asked[0]?.join('/') === '前视/右视/等轴测', asked);
  check('补拍后把图发回给模型复核', calls[1]?.images.length === 3, calls[1]?.images.length);
  check('告诉模型这组图是系统补拍的', Boolean(calls[1]?.text.includes('系统补拍')), calls[1]?.text);
  check('图里已经是改完的样子', Boolean(calls[1]?.text.includes('已应用 1 条指令')), calls[1]?.text);

  // 关掉这个保护就尊重模型的判断
  let inspected = 0;
  const loose = await runAgentLoop(first, {
    goal: first.text,
    plan: async () => ({ reply: '完成', ops: [{ op: 'addSolid' }], done: true }),
    apply: async () => ({ note: 'ok' }),
    inspect: async () => { inspected += 1; return [shot('前视')]; },
    stopped: () => false,
    ensureFirstLook: false,
  });
  check('ensureFirstLook=false 时直接收工', loose.reason === 'done' && inspected === 0, { loose, inspected });

  // 没改东西就 done（纯问答）不该补拍
  const answer = await runAgentLoop(first, {
    goal: first.text,
    plan: async () => ({ reply: '这个模型高 1.2 米', done: true }),
    apply: async () => ({ note: '' }),
    inspect: async () => { inspected += 1; return [shot('前视')]; },
    stopped: () => false,
  });
  check('没改东西的 done 不补拍', answer.reason === 'done' && inspected === 0, { answer, inspected });
}
// ── 15. measure：只测量也是有效动作，结果文字回灌给模型 ──────────
{
  const requests = [{ type: 'bounds' as const }];
  const { plan, calls } = scripted([
    { reply: '先量一下', measure: requests },
    { reply: '量过了，没问题', done: true },
  ]);
  let measured = 0;
  const run = await runAgentLoop(first, {
    goal: first.text,
    plan,
    apply: async () => ({ note: '' }),
    inspect: async () => [],
    measure: async () => { measured += 1; return '[几何测量结果] 1. 包围盒'; },
    stopped: () => false,
  });
  check('只测量不算 no-action', run.reason === 'done' && run.steps === 2 && measured === 1, run);
  check('测量文字进入下一轮', Boolean(calls[1]?.text.includes('[几何测量结果]')), calls[1]?.text);

  const same = await runAgentLoop(first, {
    goal: first.text,
    plan: async () => ({ reply: '再量', measure: requests }),
    apply: async () => ({ note: '' }),
    inspect: async () => [],
    measure: async () => 'x',
    stopped: () => false,
  });
  check('反复同样测量判定为打转', same.reason === 'repeated', same);

  const ignored = await runAgentLoop(first, {
    goal: first.text,
    plan: async () => ({ reply: '量', measure: requests }),
    apply: async () => ({ note: '' }),
    inspect: async () => [],
    stopped: () => false,
  });
  check('没有 measure 依赖时忽略测量请求', ignored.reason === 'no-action', ignored);

  const mixed = scripted([
    { reply: '改+量', ops: [{ op: 'editFeature' }], measure: requests, done: true },
    { reply: '确认', done: true },
  ]);
  const mixedRun = await runAgentLoop(first, {
    goal: first.text,
    plan: mixed.plan,
    apply: async () => ({ note: 'ok' }),
    inspect: async () => [],
    measure: async () => '量结果',
    stopped: () => false,
  });
  check('done 与 measure 同轮：先量完再收工', mixedRun.reason === 'done' && mixedRun.steps === 2, mixedRun);
}

console.log(failed === 0 ? '\n自检闭环测试全部通过' : `\n自检闭环测试失败：${failed} 项`);
process.exit(failed === 0 ? 0 : 1);
