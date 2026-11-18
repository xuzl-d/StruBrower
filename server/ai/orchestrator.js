/**
 * 应用内 AI 的「多角色分工建模」编排。
 *
 * 一次用户请求拆成若干只读子任务，全部由服务端调用同一个上游模型完成，
 * 最后收口成**唯一一条 addSolid**（和普通 plan 返回同构，前端不用改应用逻辑）：
 *
 *  1. 规划 Agent：拆零件、定统一命名/材质约定、分配特征配额（顶层 96、group 最多 2 层）；
 *  2. 零件 Agent：只写自己局部坐标系里的 features / 连接点，不知道整车位置；
 *  3. 几何内核：对主体做射线采样，把曲面点 + 法线交给贴合件 Agent（灯罩、镜座这类件）；
 *  4. 拼接 Agent：只看包围盒 / 射线 / 接触关系，决定 translate / rotate / scale / mirror / array；
 *  5. 合并器：校验预算、包 group、套变换、排切除，输出唯一 addSolid，再 dry-run 一次。
 *
 * 关键点：位置与接缝只由拼接 Agent 决定；零件内部几何只由零件 Agent 决定。
 * 几何能力来自 scripts/lib/{query,assembly}.ts（server/ai/kernel.js 按需打包），
 * 与离线 CLI、浏览器渲染用的是同一套内核，不另写一份估算逻辑。
 */
import { normalizeInspect } from './inspect.js';
import { buildRoleContext } from './role-context.js';
import { loadGeometryKernel } from './kernel.js';
import { applyOps, OpsError } from './ops.js';
import { callRoleJson, prepareRoleImages } from './provider.js';

const DEFAULT_OPTIONS = {
  maxParts: 6,
  budgetTotal: 84,
  concurrency: 3,
  refinements: 1,
};

const MATERIALS = 'aluminum / steel / carbon / plastic / plasticDark / rubber / glass / copper / brass / gold / paintWhite / paintOrange / ceramic / wood';

/** 子 Agent 的特征速查表：与 server/ai/solid.js 的白名单对齐，不重复整套 SYSTEM_PROMPT */
const FEATURE_GUIDE = `【特征写法】（单位米，Z-up，局部坐标；XY 以原点为中心，z=0 是高度方向中心）
特征 = { shape:'形状名', ...尺寸字段, translate?:[x,y,z], rotate?:[rx,ry,rz](度), scale?, mode?:'add'|'cut'|'intersect', pattern?, fillet?, shell?, offset?, material? }
形状与必填尺寸：
- box: width, depth, height
- roundedBox: width, depth, height, radius（radius ≤ min(width,depth)/2，height 不受限）
- cylinder: radius, height, segments?
- tube: radius(外), thickness, height
- capsule: radius, height(总高)
- sphere: radius
- ellipsoid: rx, ry, rz
- cone: radius, topRadius, height
- torus: radius, tube
- prism: profile:[[x,y]...], height, twist?, taper?
- revolve: profile:[[半径,高度]...], segments?, angle?
- loft: sections:[{z, profile:[[x,y]...]} | {z, ellipse:{rx,ry,power?}} | {z, airfoil:{chord,thickness,...}}...]（≥2 个截面）
- sweep: profile:[[x,y]...], path:[[x,y,z]...], taper?
- hull: points:[[x,y,z]...]
- group: features:[特征...]（子装配，可整体阵列）
segments / tubeSegments / fillet.segments 只影响曲面圆滑程度，合法范围 6~64 的整数；花瓶、瓶体、轮毂这类回转体写 32~48 足够，不要写 96 / 128，也不要写 3~5。
pattern: {type:'linear',count,step:[x,y,z]} / {type:'circular',count,axis?,angle?,center?} / {type:'mirror',axis:'x'|'y'|'z',center:[x,y,z]}
阵列实例不额外占特征数，优先用阵列表达重复结构。材质可用预设名：${MATERIALS}。
不要写 id / label：合并器会按零件 id 生成全局唯一的名字，自己写只会撞名。`;

const PLANNER_SYSTEM = `你是「拆件规划 Agent」。把用户的建模需求拆成一组零件，交给其它 Agent 分别建模。你**不写几何**，只输出拆件计划 JSON。

输出格式（只输出一个 JSON 对象，不要 Markdown 代码块、不要解释）：
{"name":"模型名","color":"#rrggbb","axes":"整车坐标系约定，例如 车头 +X、左 +Y、上 +Z","materialRule":"各零件材质约定","parts":[{"id":"body","name":"车身主轮廓","kind":"body","brief":"给零件 Agent 的一句话规格（比例、尺寸、曲面走向）","quota":18,"material":"paintOrange"},{"id":"wheel","name":"四轮总成","kind":"independent","brief":"…","quota":8,"material":"rubber"},{"id":"mirror","name":"后视镜","kind":"conforming","brief":"…","quota":6,"material":"glass","attachTo":"body"}]}

规则：
1. 2～8 个零件；第一个必须是 kind:"body"（车身/机身/主体），它决定整体比例。
2. kind 三选一：body（主体）、independent（轮子、机翼等独立件，位置由拼接 Agent 定）、conforming（灯罩、镜座、整流罩等必须贴合主体曲面的件，必须写 attachTo）。
3. id 用字母开头的英文 slug（body / wheel-front / mirror-left），全表唯一；name 用简短中文且全表唯一。
4. quota 是**该零件最多能用的特征数**（不含合并器包的 group 外壳）。所有 quota 加起来要留余量，顶层总上限 96；主体多分，附属件少分。
5. 切除类零件（要切到别的零件的孔/槽）不要单列成零件，写进 brief 里由合并器的顶层 cuts 处理。
6. group 最多嵌套 2 层，合并器会为每个零件包一层，因此零件内部最多再嵌一层 group。
7. 贴合件不要试图靠"先做个方块再挪过去"解决：它会在第二阶段拿到主体曲面采样点后单独生成。
8. 材质名只能从预设里选：${MATERIALS}。`;

const PART_SYSTEM = `你是「零件 Agent」。只负责**一个零件**在**自己局部坐标系**里的几何，输出一个 JSON 对象。你不知道、也不要猜整车位置。

输出格式：
{"features":[特征...],"anchors":[{"name":"根部","at":[x,y,z],"normal":[x,y,z]}],"bbox":{"min":[x,y,z],"max":[x,y,z]},"note":"…"}
- features 必填且第一个必须是 add；只用分配的 quota，超了会被拒绝。
- anchors 是声明的连接点（零件局部坐标），拼接 Agent 会用它对着主体表面定位；normal 可选。
- 不要写整车的平移量：所有 translate 都是零件内部相对位置。零件原点建议取自己的几何中心或安装面中心。
- 不要写 id / label / 整车坐标；合并器统一命名、统一摆放。
${FEATURE_GUIDE}

只输出 JSON 对象。`;

const CONFORM_SYSTEM = `你是「贴合件 Agent」。负责一个必须贴合主体曲面的零件（灯罩、后视镜座、进气口等）。
你会拿到主体表面的射线采样结果：每个采样点有 at（射线落点参数）、hit.point（曲面点，root 局部坐标）和 hit.normal（外法向）。
**必须按这些点和法线生成几何**：用 loft / prism / sweep / hull 顺着曲面走向，或把零件原点定在采样点附近并按法线倾斜；不要生成一个与曲面无关的方块。

输出格式与零件 Agent 相同：
{"features":[特征...],"anchors":[{"name":"贴合面","at":[x,y,z],"normal":[x,y,z]}],"bbox":{...},"note":"…"}
注意：坐标是 root（整车特征树）局部坐标；anchors.at 写安装面中心，拼接 Agent 还会微调 translate。
${FEATURE_GUIDE}

只输出 JSON 对象。`;

const PLACEMENT_SYSTEM = `你是「拼接 Agent」。只决定每个零件的**摆放变换**，绝不修改零件内部几何。

输出格式：
{"placements":[{"part":"body"},{"part":"wheel","translate":[x,y,z],"rotate":[rx,ry,rz],"scale":1,"mirror":{"axis":"y","center":[0,0,0]}}],"cuts":[],"note":"…"}
字段说明：
- part 必填，必须是清单里的 id；不写 translate 就是单位变换（主体通常保持不动）。
- rotate 是度，顺序 X→Y→Z；scale 是正数或三个正数。
- mirror 与 array 互斥（group 只有一条 pattern），二选一：
  mirror:{axis:'x'|'y'|'z',center:[x,y,z]}（保留原件 + 镜像件，适合左右对称件）；
  array:{type:'linear'|'circular',count,step?:[x,y,z],axis?:'x'|'y'|'z',angle?,center?}。
- cuts 可选：要切到多个零件的顶层共享切除，坐标是整车 root，元素必须是 mode:'cut' 或 'intersect' 的特征；一般留空。

判据：贴合件与主体应为 contact / intersect（接缝贴合，轻微嵌入可接受），不能是明显 gap；
独立件（轮子）应贴到主体外侧而非悬浮或整体埋入。parts 查询给的是各零件当前包围盒，
gap 查询给的是 relation（gap / contact / intersect）与最近距离（米）。

只输出 JSON 对象，不要输出 features。`;

/* ------------------------------ 小工具 ------------------------------ */

function clampInt(value, low, high, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.min(high, Math.max(low, Math.round(parsed))) : fallback;
}

function optionsFrom(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  return {
    maxParts: clampInt(source.maxParts, 2, 8, DEFAULT_OPTIONS.maxParts),
    budgetTotal: clampInt(source.budgetTotal, 24, 96, DEFAULT_OPTIONS.budgetTotal),
    concurrency: clampInt(source.concurrency, 1, 6, DEFAULT_OPTIONS.concurrency),
    refinements: clampInt(source.refinements, 0, 2, DEFAULT_OPTIONS.refinements),
  };
}

function clip(text, limit) {
  const value = String(text ?? '');
  return value.length > limit ? `${value.slice(0, limit)}…（已截断）` : value;
}

function vec3(value) {
  return Array.isArray(value) && value.length === 3 && value.every((n) => typeof n === 'number' && Number.isFinite(n))
    ? value.slice(0, 3)
    : null;
}

/** 清掉子 Agent 自己写的 id/label：命名由合并器统一生成，避免跨零件撞名 */
function stripIdentity(features) {
  if (!Array.isArray(features)) return features;
  return features.map((feature) => {
    if (!feature || typeof feature !== 'object' || Array.isArray(feature)) return feature;
    const copy = { ...feature };
    delete copy.id;
    delete copy.label;
    if (Array.isArray(copy.features)) copy.features = stripIdentity(copy.features);
    else if (copy.shape && typeof copy.shape === 'object' && Array.isArray(copy.shape.features)) {
      copy.shape = { ...copy.shape, features: stripIdentity(copy.shape.features) };
    }
    return copy;
  });
}

/** 规划 Agent 的产物一律重新洗一遍：id、配额、类型都不信模型 */
function normalizePlan(raw, opt) {
  const list = Array.isArray(raw?.parts) ? raw.parts.slice(0, opt.maxParts) : [];
  const seen = new Set();
  const parts = [];
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    let id = String(item.id ?? '').trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+/, '');
    if (!id || !/^[a-z]/.test(id) || id.length > 32 || seen.has(id)) continue;
    seen.add(id);
    const kind = ['body', 'independent', 'conforming'].includes(item.kind) ? item.kind : 'independent';
    const name = String(item.name ?? id).trim().slice(0, 40) || id;
    parts.push({
      id,
      name,
      kind,
      brief: clip(item.brief ?? '', 300),
      quota: clampInt(item.quota, 1, 32, 8),
      material: typeof item.material === 'string' && item.material.trim() ? item.material.trim().slice(0, 40) : undefined,
      attachTo: typeof item.attachTo === 'string' ? item.attachTo.trim() : undefined,
    });
  }
  if (!parts.length) throw new Error('规划 Agent 没给出可用的零件清单');
  parts[0].kind = 'body';
  parts[0].attachTo = undefined;
  for (const part of parts.slice(1)) {
    if (part.kind === 'body') part.kind = 'independent';
    if (part.kind === 'conforming' && (!part.attachTo || !seen.has(part.attachTo))) part.attachTo = parts[0].id;
  }
  // 预算：quota 之和 + 每个零件的 group 外壳 ≤ budgetTotal，超了按比例收紧
  const room = Math.max(8, opt.budgetTotal - parts.length);
  let sum = parts.reduce((total, part) => total + part.quota, 0);
  if (sum > room) {
    const ratio = room / sum;
    parts.forEach((part) => { part.quota = Math.max(1, Math.floor(part.quota * ratio)); });
    sum = parts.reduce((total, part) => total + part.quota, 0);
  }
  void sum;
  return {
    name: clip(raw?.name ?? '分工装配模型', 60) || '分工装配模型',
    color: /^#[0-9a-f]{6}$/i.test(String(raw?.color ?? '')) ? String(raw.color) : undefined,
    axes: clip(raw?.axes ?? 'X 前后、Y 左右、Z 上', 200),
    materialRule: clip(raw?.materialRule ?? '', 200),
    parts,
  };
}

function manifestFrom(raw, planPart, contextPlan) {
  const features = stripIdentity(Array.isArray(raw?.features) ? raw.features : null);
  if (!Array.isArray(features) || !features.length) throw new Error('缺少 features（至少要有一个 add 特征）');
  const manifest = {
    id: planPart.id,
    name: planPart.name,
    material: raw?.material ?? planPart.material ?? contextPlan.materialRule,
    features,
    quota: planPart.quota,
  };
  if (Array.isArray(raw?.anchors)) {
    manifest.anchors = raw.anchors.slice(0, 8).map((anchor) => ({
      name: String(anchor?.name ?? '连接点').trim().slice(0, 40) || '连接点',
      at: vec3(anchor?.at) ?? [0, 0, 0],
      ...(vec3(anchor?.normal) ? { normal: vec3(anchor.normal) } : {}),
    }));
  }
  if (raw?.bbox && vec3(raw.bbox.min) && vec3(raw.bbox.max)) {
    manifest.bbox = { min: vec3(raw.bbox.min), max: vec3(raw.bbox.max) };
  }
  if (typeof raw?.note === 'string') manifest.note = clip(raw.note, 200);
  return manifest;
}

function normalizePlacements(raw, ids) {
  const list = Array.isArray(raw?.placements) ? raw.placements : [];
  const placements = [];
  const seen = new Set();
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const part = String(item.part ?? '').trim();
    if (!ids.has(part) || seen.has(part)) continue;
    const placement = { part };
    const translate = vec3(item.translate);
    const rotate = vec3(item.rotate);
    if (translate) placement.translate = translate;
    if (rotate) placement.rotate = rotate;
    if (typeof item.scale === 'number' && Number.isFinite(item.scale) && item.scale > 0) placement.scale = item.scale;
    else if (vec3(item.scale) && item.scale.every((n) => n > 0)) placement.scale = vec3(item.scale);
    if (item.mirror && typeof item.mirror === 'object') {
      const axis = ['x', 'y', 'z'].includes(item.mirror.axis) ? item.mirror.axis : 'y';
      placement.mirror = { axis, ...(vec3(item.mirror.center) ? { center: vec3(item.mirror.center) } : {}) };
    }
    if (!placement.mirror && item.array && typeof item.array === 'object') {
      const array = item.array;
      const type = array.type === 'circular' ? 'circular' : array.type === 'linear' ? 'linear' : null;
      const count = clampInt(array.count, 1, 192, 1);
      if (type === 'linear' && vec3(array.step)) {
        placement.array = { type, count, step: vec3(array.step) };
      } else if (type === 'circular') {
        placement.array = {
          type, count,
          ...(['x', 'y', 'z'].includes(array.axis) ? { axis: array.axis } : {}),
          ...(typeof array.angle === 'number' && Number.isFinite(array.angle) ? { angle: array.angle } : {}),
          ...(vec3(array.center) ? { center: vec3(array.center) } : {}),
        };
      }
    }
    seen.add(part);
    placements.push(placement);
  }
  const cuts = Array.isArray(raw?.cuts)
    ? raw.cuts.filter((cut) => cut && typeof cut === 'object' && ['cut', 'intersect'].includes(cut.mode)).slice(0, 6)
    : [];
  return { placements, cuts, note: clip(raw?.note ?? '', 200) };
}

/** 有限并发，避免一次拉起十几个上游请求把网关打爆 */
async function mapLimit(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(runners);
  return results;
}

function errorText(error) {
  if (!error) return '未知错误';
  const detail = error.detail && typeof error.detail === 'object'
    ? `（${Object.entries(error.detail).map(([key, value]) => `${key}: ${value}`).join('，')}）`
    : '';
  return `${error instanceof Error ? error.message : String(error)}${detail}`.slice(0, 600);
}

/**
 * 预算/嵌套冲突的最后一道兜底：按「后加的附属件优先牺牲」逐个移除，直到能合并。
 * 规划 Agent 分的 quota 只是建议，真超了不能让整轮请求失败。
 */
function fitSpec(spec, mergeAssembly, warnings) {
  const parts = spec.parts.slice();
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const candidate = { ...spec, parts };
    try {
      return { spec: candidate, merged: mergeAssembly(candidate) };
    } catch (error) {
      if (parts.length <= 1) throw error;
      const dropped = parts.pop();
      warnings.push(`特征预算/嵌套冲突，已移除零件「${dropped.name}」：${clip(errorText(error), 120)}`);
    }
  }
  throw new Error('零件合并反复失败，请减少零件数或降低 maxParts');
}

/* ------------------------------ 角色脚本（mock / 离线测试） ------------------------------ */

const MOCK_FEATURES = {
  body: () => [
    { shape: 'roundedBox', width: 4.2, depth: 1.8, height: 0.6, radius: 0.28, translate: [0, 0, 0.62] },
    { shape: 'roundedBox', width: 2.1, depth: 1.6, height: 0.5, radius: 0.22, translate: [-0.15, 0, 1.08] },
  ],
  wheel: () => [
    {
      shape: 'cylinder', radius: 0.34, height: 0.2, rotate: [90, 0, 0], translate: [0, 0.82, 0],
      pattern: { type: 'mirror', axis: 'y', center: [0, 0, 0] },
    },
  ],
  mirror: () => [
    { shape: 'roundedBox', width: 0.22, depth: 0.14, height: 0.1, radius: 0.04 },
    { shape: 'sphere', radius: 0.07, translate: [0, 0.09, 0.02] },
  ],
};

function mockPlan() {
  return {
    name: '分工装配样车',
    color: '#e2a32c',
    axes: '车头 +X、左 +Y、上 +Z，单位米',
    materialRule: '车身烤漆、轮胎橡胶、镜面玻璃',
    parts: [
      { id: 'body', name: '车身主轮廓', kind: 'body', brief: '4.2×1.8 流线车体 + 座舱', quota: 6, material: 'paintOrange' },
      { id: 'wheel-front', name: '前轮总成', kind: 'independent', brief: '左右一对轮胎', quota: 3, material: 'rubber' },
      { id: 'wheel-rear', name: '后轮总成', kind: 'independent', brief: '左右一对轮胎', quota: 3, material: 'rubber' },
      { id: 'mirror', name: '后视镜', kind: 'conforming', brief: '贴合座舱侧面曲面', quota: 4, material: 'glass', attachTo: 'body' },
    ],
  };
}

function mockRole(role, { user }) {
  if (role === 'planner') return mockPlan();
  if (role === 'part' || role === 'conform') {
    const id = String(user).match(/【零件 id: ([a-zA-Z0-9_-]+)】/)?.[1] ?? 'body';
    const make = id.startsWith('wheel') ? MOCK_FEATURES.wheel : id === 'mirror' ? MOCK_FEATURES.mirror : MOCK_FEATURES.body;
    const features = make();
    return {
      features,
      anchors: [{ name: '安装面', at: [0, 0, 0], normal: [0, 0, 1] }],
      note: 'mock 角色脚本产物',
    };
  }
  if (role === 'placement') {
    return {
      placements: [
        { part: 'body' },
        { part: 'wheel-front', translate: [1.3, 0, 0.34] },
        { part: 'wheel-rear', translate: [-1.3, 0, 0.34] },
        { part: 'mirror', translate: [0.72, 0.78, 1.02], rotate: [0, 0, 12] },
      ],
      cuts: [],
      note: '按包围盒把轮子贴到车侧、镜座贴到座舱侧面',
    };
  }
  throw new Error(`mock 没有「${role}」角色`);
}

/* ------------------------------ 主流程 ------------------------------ */

/**
 * 与 provider.plan / planStream 返回同构，可直接塞给 planWithRepair 当 run。
 * @returns {Promise<{reply:string, ops:Array, inspect:Array, measure:Array, done:boolean, model:string, vision:object|null, assembly:object}>}
 */
export async function planAssembly({
  config, message, context, history = [], memory = '', images = [],
  document = null, options = null, onEvent = null, signal = null,
}) {
  // 子角色只需要 config（同一套上游、Key、超时、思考强度），不复用 provider 的 apply_bim_ops 工具链
  const opt = optionsFrom(options);
  const kernel = await loadGeometryKernel();
  const { mergeAssembly, runQueries } = kernel;
  const stages = [];
  const warnings = [];
  const emit = (text) => onEvent?.({ type: 'status', text });
  const stage = (name, text) => {
    stages.push({ name, text });
    emit(text);
  };
  const checkStop = () => {
    if (signal?.aborted) throw new Error('已停止生成');
  };

  const prepared = await prepareRoleImages(config, String(message ?? ''), images, { onEvent, signal });
  // 项目上下文走结构化构造：从原始 document 取选中构件的完整特征树，按 token 预算降档，
  // 不再用 clip(JSON.stringify(context), 2500) 那种会切在半个括号上、且根本看不到特征树的写法。
  const roleContext = buildRoleContext({ document, context });
  const common = [
    `【用户需求】${prepared.message}`,
    memory ? `【长期摘要】${clip(memory, 800)}` : '',
    history?.length ? `【最近对话】${clip(history.slice(-3).map((item) => `${item.role}: ${item.content}`).join('\n'), 1200)}` : '',
  ];
  const brief = [...common, roleContext.brief].filter(Boolean).join('\n\n');
  // 规划角色多花一点预算看完整 shape（拆件、定比例、定命名都要用它），其余角色只拿骨架
  const plannerBrief = [...common, roleContext.detailed].filter(Boolean).join('\n\n');

  const ask = (role, system, user, roleImages = []) => callRoleJson(config, {
    role, system, user, images: roleImages, signal,
    mock: (name, args) => mockRole(name, args),
  });

  /** 角色产物必须过校验；不合法就把错误原文回灌，让同一个角色重出一版完整的 JSON */
  const askChecked = async (role, system, user, validate, roleImages = []) => {
    let problem = '';
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      checkStop();
      const prompt = problem
        ? `${user}\n\n【上一次产物被拒绝】${problem}\n请输出**完整修正后**的 JSON 对象（不要只写差异，不要解释）。`
        : user;
      let raw;
      try {
        raw = await ask(role, system, prompt, attempt === 1 ? roleImages : []);
      } catch (error) {
        problem = errorText(error);
        if (attempt === 3) throw new Error(`「${role}」角色连续 3 次调用失败：${problem}`);
        continue;
      }
      try {
        return validate(raw);
      } catch (error) {
        problem = errorText(error);
        if (attempt === 3) throw new Error(`「${role}」角色产物 3 次都没通过校验：${problem}`);
      }
    }
    throw new Error(`「${role}」角色没有可用产物`);
  };

  /* 1. 拆件 + 分预算 */
  stage('plan', '正在拆分零件、约定命名与材质、分配特征预算…');
  const plan = normalizePlan(await ask('planner', PLANNER_SYSTEM, [
    plannerBrief,
    `【约束】最多 ${opt.maxParts} 个零件；顶层特征预算 ${opt.budgetTotal}/96（每个零件另占 1 个 group 外壳）。`,
    '只输出拆件计划 JSON。',
  ].join('\n\n'), prepared.images), opt);
  const planText = JSON.stringify(plan);
  const conforming = plan.parts.filter((part) => part.kind === 'conforming');
  emit(`拆成 ${plan.parts.length} 个零件（贴合件 ${conforming.length} 个），开始分工建模…`);

  const manifestValidator = (planPart) => (raw) => {
    const manifest = manifestFrom(raw, planPart, plan);
    // 用合并器干跑一遍：形状白名单、尺寸、配额、group 深度、命名都在这里挡住
    mergeAssembly({ name: '零件校验', parts: [manifest], budget: { total: 96 } });
    return manifest;
  };

  /* 2. 主体 + 独立件：只在自己的局部坐标系里建模 */
  const basePlan = plan.parts.filter((part) => part.kind !== 'conforming');
  stage('parts', `零件 Agent 正在并行建模（${basePlan.length} 个）…`);
  const baseManifests = (await mapLimit(basePlan, opt.concurrency, async (planPart) => {
    emit(`零件 Agent：${planPart.name}…`);
    return askChecked('part', PART_SYSTEM, [
      brief,
      `【拆件计划】${planText}`,
      `【你负责的零件】id=${planPart.id}，名称=${planPart.name}，类型=${planPart.kind}，特征配额=${planPart.quota}，材质=${planPart.material ?? '跟随构件'}`,
      `【规格】${planPart.brief}`,
      '【零件 id: ' + planPart.id + '】',
      '只写这个零件的局部几何 + 连接点，不要写整车位置。',
    ].join('\n\n'), manifestValidator(planPart), prepared.images);
  })).filter(Boolean);
  if (!baseManifests.length) throw new Error('没有零件 Agent 产出可用几何');

  /* 3. 曲面采样：把主体表面交给贴合件 Agent，而不是让它先猜一个方块 */
  let samples = [];
  if (conforming.length) {
    stage('surface', '正在对主体曲面做射线采样，供贴合件按曲面生成…');
    const bodyId = `part-${baseManifests[0].id}`;
    const surveyOps = mergeAssembly({ name: plan.name, parts: baseManifests, budget: { total: 96 } }).ops;
    const listing = runQueries(surveyOps, [{ type: 'parts', frame: 'root' }]).results[0];
    const bodyBox = listing?.ok
      ? (listing.parts ?? []).find((item) => item.id === bodyId) ?? (listing.parts ?? [])[0]
      : null;
    if (bodyBox) {
      const pad = Math.max(0.02, (bodyBox.size?.[0] ?? 1) * 0.02);
      const span = (from, to) => [from + pad, to - pad];
      const requests = [
        { type: 'sample', frame: 'root', part: bodyId, axis: 'z', grid: { a: [...span(bodyBox.min[0], bodyBox.max[0]), 5], b: [...span(bodyBox.min[1], bodyBox.max[1]), 5] } },
        { type: 'sample', frame: 'root', part: bodyId, axis: 'y', grid: { a: [...span(bodyBox.min[0], bodyBox.max[0]), 5], b: [...span(bodyBox.min[2], bodyBox.max[2]), 3] } },
        { type: 'sample', frame: 'root', part: bodyId, axis: 'x', grid: { a: [...span(bodyBox.min[1], bodyBox.max[1]), 3], b: [...span(bodyBox.min[2], bodyBox.max[2]), 3] } },
      ];
      samples = runQueries(surveyOps, requests).results;
    } else {
      warnings.push('主体包围盒查询失败，贴合件退回按拆件计划生成（可能无法贴合曲面）');
    }
  }
  const sampleText = samples.length ? clip(JSON.stringify(samples), 9000) : '（无采样数据）';

  stage('conform', conforming.length ? `贴合件 Agent 正在按曲面生成（${conforming.length} 个）…` : '没有贴合件，跳过曲面阶段');
  const conformManifests = conforming.length
    ? (await mapLimit(conforming, opt.concurrency, async (planPart) => {
      emit(`贴合件 Agent：${planPart.name}…`);
      return askChecked('conform', CONFORM_SYSTEM, [
        brief,
        `【拆件计划】${planText}`,
        `【你负责的贴合件】id=${planPart.id}，名称=${planPart.name}，特征配额=${planPart.quota}，贴合目标=${planPart.attachTo}`,
        `【规格】${planPart.brief}`,
        '【零件 id: ' + planPart.id + '】',
        `【主体曲面采样（root 局部坐标，米）】${sampleText}`,
        '按采样点与法线生成外形，坐标写 root 局部坐标；连接点 at 写安装面中心。',
      ].join('\n\n'), manifestValidator(planPart), prepared.images);
    })).filter(Boolean)
    : [];

  const fitted = fitSpec({
    name: plan.name,
    ...(plan.color ? { color: plan.color } : {}),
    parts: [...baseManifests, ...conformManifests],
    budget: { total: opt.budgetTotal, reserved: 0 },
  }, mergeAssembly, warnings);
  const spec = fitted.spec;
  const parts = spec.parts;
  const ids = new Set(parts.map((part) => part.id));

  /* 4. 拼接 Agent：只看几何查询，不碰零件内部特征 */
  stage('placement', '正在查询零件包围盒与接缝，交给拼接 Agent 定位置…');
  const identityOps = fitted.merged.ops;
  const gapRequests = parts.slice(1).slice(0, 6).map((part) => ({
    type: 'gap', frame: 'root', a: `part-${parts[0].id}`, b: `part-${part.id}`,
  }));
  const placementQueries = runQueries(identityOps, [
    { type: 'parts', frame: 'root' },
    { type: 'bounds', frame: 'root' },
    ...gapRequests,
  ]).results;
  // 每次成功校验都会刷新最终合并结果，最后的报告就取它
  let merged = fitted.merged;
  const placementValidator = (raw) => {
    const normalized = normalizePlacements(raw, ids);
    merged = mergeAssembly({ ...spec, placements: normalized.placements, cuts: normalized.cuts });
    return normalized;
  };
  const placementInput = [
    brief,
    `【拆件计划】${planText}`,
    `【零件清单与连接点】${clip(JSON.stringify(parts.map((part) => ({ id: part.id, name: part.name, kind: plan.parts.find((item) => item.id === part.id)?.kind, anchors: part.anchors ?? [], note: part.note ?? '' }))), 4000)}`,
    `【几何查询（单位米，frame=root）】${clip(JSON.stringify(placementQueries), 8000)}`,
    '只输出 placements JSON；零件内部几何已定稿，不能修改。',
  ].join('\n\n');
  let placement = await askChecked('placement', PLACEMENT_SYSTEM, placementInput, placementValidator);
  let ops = merged.ops;

  /* 5. 接缝复核：明显的悬浮再让拼接 Agent 修一轮 */
  let seamChecks = [];
  for (let round = 0; round < opt.refinements; round += 1) {
    checkStop();
    seamChecks = runQueries(ops, gapRequests).results;
    const floating = seamChecks.filter((item) => item.ok && item.relation === 'gap'
      && typeof item.distance === 'number' && Number.isFinite(item.distance) && item.distance > 0.05);
    if (!floating.length) break;
    emit(`发现 ${floating.length} 处接缝悬浮，正在让拼接 Agent 复核位置…`);
    placement = await askChecked('placement', PLACEMENT_SYSTEM, [
      placementInput,
      `【当前摆放】${JSON.stringify(placement.placements)}`,
      `【接缝复核】${clip(JSON.stringify(floating), 2500)}`,
      '只调整相关零件的 translate / rotate / scale，其余保持原值；输出完整 placements JSON。',
    ].join('\n\n'), placementValidator);
    ops = merged.ops;
  }
  if (!seamChecks.length) seamChecks = runQueries(ops, gapRequests).results;

  /* 6. 唯一 addSolid + 服务端 dry-run */
  stage('merge', '正在校验并合并成唯一一条 addSolid…');
  if (document) {
    try {
      applyOps(document, ops);
    } catch (error) {
      if (error instanceof OpsError) throw new Error(`合并结果没通过服务端校验：${error.message}`);
      throw error;
    }
  }
  const report = merged.report;
  warnings.push(...(report.warnings ?? []));

  const seams = seamChecks
    .filter((item) => item.ok)
    .map((item) => `${item.b}: ${item.relation}${Number.isFinite(item.distance) ? `（${item.distance} m）` : ''}`);
  const reply = [
    `已按「分零件建模」完成：${parts.length} 个零件各自建模，用几何查询定接缝后合并成 1 个造型构件。`,
    `特征 ${report.featureCount}/${report.limit}，零件：${report.parts.map((item) => item.name).join('、')}。`,
    seams.length ? `接缝复核：${seams.join('；')}。` : '',
    warnings.length ? `提示：${warnings.slice(0, 3).join('；')}` : '',
  ].filter(Boolean).join('\n');

  return {
    reply,
    ops,
    inspect: normalizeInspect(['front', 'right', 'iso']),
    measure: [],
    describe: [],
    done: false,
    model: config.model,
    vision: prepared.vision ?? null,
    context: null,
    assembly: {
      name: report.name,
      report,
      stages,
      warnings,
      placements: placement.placements,
      seams: seamChecks.filter((item) => item.ok).map((item) => ({ a: item.a, b: item.b, relation: item.relation, distance: item.distance })),
      samplePoints: samples.reduce((total, item) => total + (item.results?.length ?? 0), 0),
      roleContext: roleContext.stats,
      mock: config.provider === 'mock',
    },
  };
}
