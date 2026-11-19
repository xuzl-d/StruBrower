/**
 * 工具注册表：agent 能做的一切事都在这里登记，一处定义、多处使用。
 *
 * 设计目标（对应「通用 agent + 我只提供接口」）：
 * - 模型看到的工具清单、function calling 的 JSON Schema、提示词里的工具说明，
 *   全部从这里生成——加一个工具 = 加一条注册 + 一个 run，不用改提示词、不用改解析。
 * - 每个工具唯一标识 run 在哪里执行：
 *     server  只读工具（查配方 / 查模板 / 查特征树），在服务端执行，不落库、不广播、不生成 rev；
 *     client  副作用工具（改模型 / 转视角 / 量几何），必须由前端持有 WebGL 视口与文档才能做。
 * - 工具 A 的结果可以喂给工具 B（模型自己决定顺序）：registry.run() 统一返回字符串结果，
 *   由 agentLoop 回灌给模型，形成「查 → 改 → 看 → 再查」的多工具链。
 */
import { searchKnowledge, formatKnowledge } from './knowledge.js';
import { modelDocument, modelParamSpecs, libraryModelIds } from '../../shared/library.js';
import { runPythonTool } from './python-runner.js';
import { normalizePython } from './python.js';

/** 工具执行位置：server=服务端只读，client=前端副作用 */
export const SERVER_SIDE = 'server';
export const CLIENT_SIDE = 'client';

/**
 * 注册表本身。每项：
 *   name        工具名（function calling 的 function.name）
 *   title       中文短名（进度卡片显示）
 *   side        server / client
 *   description 给模型看的说明
 *   schema      参数 JSON Schema（JSON Only 兜底时也会_inline 说明）
 *   run         仅 server 工具：async ({args, context, document}) => string
 *   dependOnWrite 仅 client 工具：是否必须等本轮 ops 落地后再执行（inspect/measure=true）
 */
const REGISTRY = [
  {
    name: 'apply_bim_ops',
    title: '修改模型',
    side: CLIENT_SIDE,
    description: '提交对当前 BIM 项目的建模指令：建筑构件（墙/柱/板）与任意造型实体（特征树），单位米，Z-up。前端会立刻应用，不需要用户确认。',
    schema: {
      type: 'object',
      properties: {
        reply: { type: 'string', description: '给用户的简短中文说明；信息不足时在这里提问' },
        ops: {
          type: 'array',
          description: '建模指令列表；不需要改模型时返回空数组。每条带 op 字段（如 addSolid / editFeature）。',
          items: { type: 'object', additionalProperties: true },
        },
        done: {
          type: 'boolean',
          description: '已满足需求、不用再改也不用再看时设 true；设 true 时本工具不要再带 ops。',
        },
        criteria: {
          type: 'array',
          description: '从用户原话拆出的验收清单（最多 8 条，每条一句可核对的话）。首轮给出一次即可，例如「前后护网为带弧度的罩子并包住叶片」。后续每轮会逐项回灌给你核对。',
          items: { type: 'string' },
        },
      },
      required: ['reply', 'ops'],
    },
  },
  {
    name: 'inspect',
    title: '查看视角',
    side: CLIENT_SIDE,
    dependOnWrite: true,
    description: '把三维视图转到指定角度并截图发回给你，让你自己判断改得对不对。前端会先把同一轮的 apply_bim_ops 落地，再截图。最多 4 个视角。',
    schema: {
      type: 'object',
      properties: {
        views: {
          type: 'array',
          description: '视角数组。元素写法：{ "view": "front"|"back"|"left"|"right"|"top"|"bottom"|"iso" } 或 { "azimuth": 45, "elevation": 20 }。看细节加 focus（构件名/id）与 zoom（0.4~4）。',
          items: { type: 'object', additionalProperties: true },
        },
      },
      required: ['views'],
    },
  },
  {
    name: 'measure',
    title: '测量几何',
    side: CLIENT_SIDE,
    dependOnWrite: true,
    description: '对当前特征树做几何求值并把结果文字发回给你。前端会先把同一轮的 apply_bim_ops 落地再测。最多 6 条。改完先用 {type:"anomalies"} 查离群零件；核对「罩子包住叶片」这类关系用 {type:"enclosure",outer:"前罩",inner:"叶片",axis:"y"}；核对「带弧度/收口」用 {type:"axialProfile",feature:"前罩",axis:"y"}；核对「护条/筋条是否戳出罩体、阵列中心是否偏心」用 {type:"alignment",base:"前罩外圈",compare:"前罩弯曲护条",axis:"y"}；核对「防护网/罩子是不是实心的、挡不挡视线」用 {type:"solidCover",feature:"前罩",axis:"y"}——填充率≥60% 说明被做成了实心锅盖，必须改成镂空网架。改完的防护网务必复核 solidCover 与 alignment 两项。',
    schema: {
      type: 'object',
      properties: {
        requests: {
          type: 'array',
          description: '测量请求：{type:"anomalies"} 离群体检 / {type:"enclosure",outer,inner,axis?,margin?} 包覆关系 / {type:"axialProfile",feature,axis} 轴向收口 / {type:"alignment",base,compare,axis?,margin?} 中心偏移与伸出量 / {type:"solidCover",feature,axis,grid?} 实心面填充率（抓防护网被做成锅盖） / {type:"surface",feature?,axis,at} 表面交点 / {type:"bounds",feature?} 包围盒 / {type:"gap",a,b} 最近距离。坐标是造型构件局部坐标（米）。',
          items: { type: 'object', additionalProperties: true },
        },
      },
      required: ['requests'],
    },
  },
  {
    name: 'search_recipes',
    title: '检索建模配方',
    side: SERVER_SIDE,
    description: '遇到不熟悉的物体（履带 / 古建 / 飞机 / 复杂曲面）或不确定怎么做时，先用这个工具查配方和可复用模型。关键词越具体越好，例如「坦克履带轮子」。查到模型后用 apply_bim_ops 的 addSolid {library: id} 取整棵特征树再改。',
    schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '要查的物体或做法，例如「坦克履带」「古建瓦顶」' },
      },
      required: ['query'],
    },
    run: async ({ args }) => {
      const query = String(args?.query ?? '').trim();
      if (!query) return '检索关键词为空。';
      const text = formatKnowledge(query, { recipeLimit: 1, modelLimit: 3, maxChars: 3200 });
      return text || `没有检索到与「${query}」相关的配方或模型。可用 addSolid 从零建模，或换个关键词再查。`;
    },
  },
  {
    name: 'describe_model',
    title: '查看模型模板',
    side: SERVER_SIDE,
    description: '查看模型库里某个模型的完整特征清单（每个特征的序号/名称/形状/关键尺寸），在决定 library 取整棵之前先看清楚它由什么组成。模型 id 可从 search_recipes 或上下文的模型库清单里拿。',
    schema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '模型 id，例如 crawler-crane / pavilion-hex' },
      },
      required: ['id'],
    },
    run: async ({ args }) => {
      const id = String(args?.id ?? '').trim();
      const doc = modelDocument(id);
      if (!doc) return `未知模型「${id}」。可用 id：${libraryModelIds().join(' / ')}`;
      const features = doc.features ?? [];
      const lines = features.slice(0, 60).map((feature, index) => {
        const shape = feature.shape ?? {};
        const dims = ['width', 'depth', 'height', 'radius', 'thickness', 'rx', 'ry', 'rz', 'count', 'tube']
          .filter((key) => shape[key] !== undefined)
          .map((key) => `${key}=${shape[key]}`)
          .join(' ');
        return `${index + 1}. ${feature.label ?? shape.shape ?? '特征'} [${shape.shape ?? 'group'}] ${dims}${feature.mode ? ` mode=${feature.mode}` : ''}`;
      });
      const params = modelParamSpecs(id).map((spec) => `${spec.key}(${spec.min}~${spec.max}, 默认 ${spec.default})`).join('、');
      return [
        `模型 ${id}（${doc.name}）：${doc.summary ?? ''}`,
        `共 ${features.length} 个顶层特征${features.length > 60 ? '（下面列前 60 个）' : ''}：`,
        ...lines,
        params ? `\n可驱动参数：${params}。取整棵后可用 setParams 一次改一组。` : '\n静态特征树：改尺寸用 editFeature / setDimensions。',
      ].join('\n');
    },
  },
  {
    name: 'inspect_tree',
    title: '检查特征树',
    side: SERVER_SIDE,
    description: '列出当前项目里某个构件的完整特征树（序号/id/名称/形状/变换/材质），确认要改的特征到底在哪一层。target 省略时列出所有造型构件。用于改之前核对目标，避免改错构件或特征。',
    schema: {
      type: 'object',
      properties: {
        target: { type: 'string', description: '构件名或 id；省略则列出所有造型构件' },
      },
    },
    run: async ({ args, context, document }) => {
      const target = String(args?.target ?? '').trim();
      const source = document?.elements ?? context?.elements ?? [];
      const solids = source.filter((element) => element?.primitive?.kind === 'solid' || element?.solid);
      if (!solids.length) return '当前项目没有造型构件（solid）。';
      const matches = target
        ? solids.filter((element) => element.id === target || element.name === target)
        : solids;
      if (!matches.length) return `找不到构件「${target}」。当前造型构件：${solids.map((e) => e.name ?? e.id).join(' / ')}`;
      const blocks = matches.slice(0, 3).map((element) => {
        const solid = element.primitive?.kind === 'solid' ? element.primitive : (element.solid ?? element.primitive);
        const features = solid?.features ?? [];
        const lines = features.slice(0, 60).map((feature, index) => {
          const shape = feature.shape ?? {};
          return `${feature.index ?? index + 1}. ${feature.label ?? shape.shape ?? '特征'} id=${feature.id ?? '-'} [${shape.shape ?? 'group'}] translate=${JSON.stringify(feature.translate ?? [0, 0, 0])}${feature.material ? ` material=${typeof feature.material === 'string' ? feature.material : feature.material.name}` : ''}`;
        });
        return `构件 ${element.name ?? element.id}（id=${element.id}）：${features.length} 个特征\n${lines.join('\n')}${features.length > 60 ? '\n…（更多特征见上下文的 elements）' : ''}`;
      });
      const text = blocks.join('\n\n');
      // 工具结果会被前端原样拼进下一轮 message；不设上限既白烧 token，
      // 又会把自检回执顶过服务端长度限制（报「需求描述过长」）。
      const MAX_INSPECT_CHARS = 12000;
      return text.length > MAX_INSPECT_CHARS
        ? `${text.slice(0, MAX_INSPECT_CHARS)}\n…（特征树过长已截断；完整特征见上下文 elements，可用 inspect_tree 指定单个构件再看）`
        : text;
    },
  },
  {
    name: 'run_python',
    title: '运行 Python 脚本',
    side: SERVER_SIDE,
    description: '在受限沙箱里执行你写的 Python 脚本。用途：精确计算阵列点位 / 三角函数 / 曲线采样，把结果回传给你自己看，或让脚本直接 emit 建模 ops 与程序化贴图。需要多次重复、精确坐标或画贴图时用它，不要手算或硬拼几十个数字。脚本用 emit({"result":...}) 提交结果、emit({"ops":[...]}) 提交建模指令、emit({"images":[{name,dataUrl}]}) 提交贴图（之后在 apply_bim_ops 的 material.map 里写 "python:1" 引用）。造型优先用现成图元或 parametric 写方程（前端实时采样、面板能改参数）；只有方程也写不出的形体才考虑 mesh 网格兜底（死网格、改不了参数），且当前沙箱默认不含 OCP，需要三角化请先确认环境。只允许 math / numpy / PIL / scipy 等白名单库，禁止文件与网络。',
    schema: {
      type: 'object',
      properties: {
        scripts: {
          type: 'array',
          description: '要执行的脚本列表，每项 { "code": "Python 源码", "note": "这段在做什么" }。最多 2 段；不写 note 也可以直接给字符串。',
          items: { type: 'object', additionalProperties: true },
        },
        reply: { type: 'string', description: '给用户的简短说明（可选）' },
      },
    },
    run: async ({ args, document, pythonSink, onEvent, signal }) => {
      const requests = normalizePython(args?.scripts ?? args?.code ?? args);
      if (!requests.length) return '没有可执行的 Python 脚本：请在 scripts 里写 code，用 emit({"result":...}) 提交结果。';
      // 真正执行放在这里（服务端工具循环内），结果回灌给模型；产出的 ops / 图片
      // 写进 sink，等这一轮全部结束再统一 dry-run 并合并，避免脚本跑两遍。
      const result = await runPythonTool(requests, { document, ops: [], onEvent, signal });
      if (pythonSink) {
        pythonSink.push({
          requests,
          text: result.text,
          ops: result.ops,
          images: result.images,
          report: result.report,
        });
      }
      return result.text || '脚本执行完毕，但没有 emit 任何结果；用 emit({"result": ...}) 提交点列或数值。';
    },
  },
  {
    name: 'finish',
    title: '完成',
    side: CLIENT_SIDE,
    description: '确认已满足用户需求、收工。调用前应先看过视角截图或确认改动从特征树即可核对；第一次生成不要直接 finish。',
    schema: {
      type: 'object',
      properties: {
        note: { type: 'string', description: '一句话说明你在图里或特征树里核对到了什么' },
      },
    },
  },
];

const BY_NAME = new Map(REGISTRY.map((tool) => [tool.name, tool]));

/** 给模型的 function calling tools 数组（模型可自由挑选、一次调多个） */
export function toolDefinitions() {
  return REGISTRY.map((tool) => ({
    type: 'function',
    function: { name: tool.name, description: tool.description, parameters: tool.schema },
  }));
}

/** 给纯 JSON 兜底提示用的工具清单文本（模型不支持 function calling 时） */
export function toolPromptText() {
  const lines = REGISTRY.map((tool) => `- ${tool.name}(${Object.keys(tool.schema.properties ?? {}).join(', ')}): ${tool.description}`);
  return `【可用工具】你可以一次调用多个工具（tool_calls），按需要自己决定顺序和组合：\n${lines.join('\n')}`;
}

export function getTool(name) {
  return BY_NAME.get(String(name ?? '')) ?? null;
}

export function toolNames() {
  return REGISTRY.map((tool) => tool.name);
}

export function serverToolNames() {
  return REGISTRY.filter((tool) => tool.side === SERVER_SIDE).map((tool) => tool.name);
}

/** 在服务端执行一个只读工具；未知工具或客户端工具返回 null（交由前端处理） */
export async function runServerTool(name, args, env) {
  const tool = getTool(name);
  if (!tool || tool.side !== SERVER_SIDE || typeof tool.run !== 'function') return null;
  try {
    const text = await tool.run({ args: args ?? {}, ...(env ?? {}) });
    return { name, ok: true, text: String(text ?? '') };
  } catch (error) {
    return { name, ok: false, text: `工具 ${name} 执行失败：${error instanceof Error ? error.message : String(error)}` };
  }
}
