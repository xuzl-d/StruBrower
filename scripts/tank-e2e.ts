/**
 * 端到端模拟「用户 ↔ AI」对话跑履带式坦克建模。
 * 复用前端真实的 runAgentLoop，deps 走 HTTP 调独立测试服务（8795）。
 * 用法：esbuild 打包后 node 运行，参数：--goal "..." --project <id>
 */
import { runAgentLoop } from '../src/ai/agentLoop';
import { runMeasure } from '../src/ai/measure';

const BASE = process.env.E2E_BASE || 'http://127.0.0.1:8795';
const TOKEN = (await import('node:fs')).readFileSync('.tmp/e2e-data/token.txt', 'utf8').trim();
const PROJECT = process.env.E2E_PROJECT || '';
const GOAL = process.env.E2E_GOAL || '创建一个履带式坦克三维模型：车体、炮塔、炮管，两侧各一组履带和多个负重轮，迷彩配色';
const MAX_STEPS = Number(process.env.E2E_MAX_STEPS || 6);

const H = { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` };
async function api(path, body, method = 'POST') {
  const res = await fetch(BASE + path, { method, headers: H, body: method === 'GET' ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  if (!res.ok) {
    const err = new Error(`HTTP ${res.status} ${path}: ${typeof data === 'string' ? data : (data.error?.message || JSON.stringify(data).slice(0, 300))}`);
    err.status = res.status;
    throw err;
  }
  return data;
}

const log = (...a) => console.log('[E2E]', ...a);

// 取项目文档，统计特征，供 inspect 用文本替代（vision 关闭）
async function getDoc() {
  const r = await api(`/api/projects/${PROJECT}/document`, null, 'GET');
  return r.document || r;
}
function docSummary(doc) {
  const els = doc?.elements || [];
  const solids = els.filter(e => e.primitive?.kind === 'solid' || e.solid);
  const lines = solids.map(e => {
    const solid = e.primitive?.kind === 'solid' ? e.primitive : (e.solid || e.primitive);
    const feats = solid?.features || [];
    return `- ${e.name}(${e.id?.slice(0,6)}): ${feats.length}个特征 [${feats.slice(0,40).map(f => f.label || f.shape?.shape || '?').join('、')}]`;
  });
  return `当前模型共 ${els.length} 个构件，其中 ${solids.length} 个造型体：\n${lines.join('\n') || '(空)'}`;
}

let roundNo = 0;
const deps = {
  goal: GOAL,
  maxSteps: MAX_STEPS,
  ensureFirstLook: true,
  plan: async (round) => {
    roundNo += 1;
    log(`\n===== 第 ${roundNo} 轮 plan（本轮消息 ${round.text.length} 字，附图 ${round.images.length}）=====`);
    log('消息开头:', round.text.slice(0, 160).replace(/\n/g, ' / '));
    const started = Date.now();
    const data = await api(`/api/projects/${PROJECT}/ai/plan`, {
      message: round.text,
      selectedIds: [],
      history: [],
      images: [],
      internal: roundNo > 1,
    });
    log(`plan 返回 ${Date.now() - started}ms: reply="${(data.reply || '').slice(0, 120)}" ops=${data.ops?.length || 0} calls=${data.calls?.length || 0} done=${data.done} notes=${(data.notes || '').length}字`);
    if (data.ops?.length) log('ops:', JSON.stringify(data.ops).slice(0, 500));
    if (data.calls?.length) log('calls:', data.calls.map(c => `${c.name}(${JSON.stringify(c.args || {}).slice(0, 80)})`).join(' | ').slice(0, 600));
    // notes 是服务端只读工具的执行结果，作为 decision.notes 回灌
    return {
      reply: data.reply,
      ops: data.ops,
      inspect: data.inspect,
      measure: data.measure,
      done: data.done,
      calls: data.calls,
      notes: data.notes,
    };
  },
  apply: async (ops) => {
    log(`  → apply ${ops.length} 条 ops`);
    try {
      const r = await api(`/api/projects/${PROJECT}/ai/apply`, { ops });
      log(`  ✓ 落地成功 rev=${r.rev}，summary=${r.summary}`);
      return { note: `已应用 ${ops.length} 条指令，新 rev ${r.rev}。${r.summary || ''}` };
    } catch (e) {
      log(`  ✗ apply 失败: ${e.message}`);
      throw e;
    }
  },
  inspect: async (views) => {
    log(`  → inspect 视角: ${views.map(v => v.label).join('、')}`);
    // vision 关闭：返回文本型伪截图， instruct 模型靠 inspect_tree 文本核对
    const doc = await getDoc();
    const summary = docSummary(doc);
    log(`  ✓ 视图占位（文本特征树）: ${summary.slice(0, 160)}`);
    return views.map((v, i) => ({
      label: v.label,
      dataUrl: `data:text/plain;base64,${Buffer.from(`[${v.label}] ${summary}`).toString('base64')}`,
      thumb: `text:${v.label}`,
    }));
  },
  measure: async (reqs) => {
    log(`  → measure ${reqs.length} 项`);
    try {
      const doc = await getDoc();
      const text = runMeasure(doc, reqs as any);
      log(`  ✓ 真实几何测量: ${text.slice(0, 200).replace(/\n/g, ' / ')}`);
      return text;
    } catch (e) {
      log(`  ✗ measure 失败: ${(e as Error).message}`);
      return `几何测量失败：${(e as Error).message}`;
    }
  },
  callTool: async (name, args) => {
    log(`  → 服务端工具 ${name}(${JSON.stringify(args || {}).slice(0, 120)})`);
    try {
      const r = await api(`/api/projects/${PROJECT}/ai/tool`, { name, args });
      const text = r.text || r.result || JSON.stringify(r);
      log(`  ✓ ${name} 返回 ${text.length} 字`);
      return text;
    } catch (e) {
      log(`  ✗ ${name} 失败: ${e.message}`);
      throw e;
    }
  },
  recall: async (goal) => {
    log('  → recall 召回建模知识');
    try {
      const r = await api(`/api/projects/${PROJECT}/ai/tool`, { name: 'search_recipes', args: { query: `${goal} 履带 坦克 负重轮` } });
      return r.text || '';
    } catch { return ''; }
  },
  stopped: () => false,
  onStage: (s) => { log('  [stage]', s.type, JSON.stringify(s).slice(0, 160)); },
};

log('开始', { PROJECT, GOAL: GOAL.slice(0, 40), MAX_STEPS });
const run = await runAgentLoop(
  { text: GOAL, images: [], thumbs: [], files: [], shots: 0 },
  deps,
);
log('\n===== 结束 =====', JSON.stringify(run));
const doc = await getDoc();
log('最终文档:', docSummary(doc).slice(0, 1200));
