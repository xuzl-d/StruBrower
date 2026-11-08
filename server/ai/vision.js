/**
 * 看图建模：把用户上传的图片变成「结构化建模规格」。
 *
 * 为什么不直接把图片塞给建模模型：
 * 建模主力模型（如 deepseek-v4-pro）往往只支持文本，收到 image_url 会当成
 * [Unsupported Image] 静默忽略，用户只会看到「模型没理我的图」。所以流程是：
 *   1) 先判断主模型能不能读图（网关 /models 的 input_modalities）：
 *      能 → 图片直接内联进建模请求（一次调用，保真度最高）
 *   2) 不能 → 用用户在 AI 设置里**单独启用**的视觉模型读图，产出结构化规格
 *      （独立接口地址 + 独立 API Key，默认不启用，也不做任何自动挑选）
 *   3) 建模模型拿着规格 + 提示词 → 特征树
 */

/** 图片数量与体积上限：4 张、单张 4 MB、合计 10 MB（base64 解码后的原始字节） */
export const IMAGE_LIMITS = { count: 4, perImage: 4 * 1024 * 1024, total: 10 * 1024 * 1024 };

const DATA_URL = /^data:(image\/(?:png|jpe?g|webp|gif));base64,([A-Za-z0-9+/=\s]+)$/i;

/** 输入不合法（用户能自己修的问题）→ HTTP 400 */
export class ImageInputError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ImageInputError';
  }
}

function base64Bytes(base64) {
  const clean = base64.replace(/\s+/g, '');
  const padding = clean.endsWith('==') ? 2 : clean.endsWith('=') ? 1 : 0;
  return Math.floor((clean.length * 3) / 4) - padding;
}

/**
 * 校验并归一化前端传来的图片。接受 `[{ dataUrl }]`、`[{ data }]` 或纯 dataURL 字符串。
 * @returns {{ mime: string, base64: string, dataUrl: string, bytes: number }[]}
 */
export function normalizeImages(input) {
  if (input === undefined || input === null) return [];
  if (!Array.isArray(input)) throw new ImageInputError('images 必须是数组');
  if (input.length > IMAGE_LIMITS.count) {
    throw new ImageInputError(`一次最多上传 ${IMAGE_LIMITS.count} 张图片`);
  }

  const list = [];
  let total = 0;
  for (const [index, raw] of input.entries()) {
    const dataUrl = typeof raw === 'string' ? raw : typeof raw?.dataUrl === 'string' ? raw.dataUrl : '';
    const match = dataUrl.trim().match(DATA_URL);
    if (!match) {
      throw new ImageInputError(`第 ${index + 1} 张图片格式不支持：只接受 png / jpeg / webp / gif 的 dataURL`);
    }
    const mime = match[1].toLowerCase().replace('image/jpg', 'image/jpeg');
    const base64 = match[2].replace(/\s+/g, '');
    const bytes = base64Bytes(base64);
    if (bytes <= 0) throw new ImageInputError(`第 ${index + 1} 张图片内容为空`);
    if (bytes > IMAGE_LIMITS.perImage) {
      throw new ImageInputError(`第 ${index + 1} 张图片 ${(bytes / 1024 / 1024).toFixed(1)} MB，超过单张 ${IMAGE_LIMITS.perImage / 1024 / 1024} MB 上限`);
    }
    total += bytes;
    if (total > IMAGE_LIMITS.total) {
      throw new ImageInputError(`图片合计超过 ${IMAGE_LIMITS.total / 1024 / 1024} MB，请减少张数或压缩后再试`);
    }
    list.push({ mime, base64, dataUrl: `data:${mime};base64,${base64}`, bytes });
  }
  return list;
}

/* ---------- 主模型是否支持图片 ---------- */

const modelCache = new Map(); // baseUrl -> { at: number, models: Array|null }
const MODEL_CACHE_TTL = 5 * 60_000;

function normalizeModel(entry) {
  if (!entry || typeof entry.id !== 'string') return null;
  const declared = [
    ...(Array.isArray(entry.input_modalities) ? entry.input_modalities : []),
    ...(Array.isArray(entry.modalities) ? entry.modalities : []),
    ...(Array.isArray(entry.capabilities?.input) ? entry.capabilities.input : []),
  ];
  const modalities = declared.map((item) => String(item).toLowerCase());
  // 网关是否**说过**能力：有的网关（cc.yjk.cn 等）只回 id/object/owned_by，一个字都不提模态。
  // 这时必须判成 null「不知道」，不能判成 false「不支持」——否则多模态主模型会被误判成纯文本，
  // 用户传图就得到「主模型不支持图片输入」，而去配独立视觉模型也白配。
  const speaks = modalities.length > 0 || typeof entry.capabilities?.vision === 'boolean';
  // 只看接口自报的能力，不靠模型名猜（不凭 id 里有没有 vl 下结论）
  const image = !speaks
    ? null
    : modalities.includes('image')
      || modalities.includes('vision')
      || entry.capabilities?.vision === true;
  return { id: entry.id, image };
}

/**
 * 拉取网关的模型清单（带 5 分钟缓存）。拿不到返回 null —— 代表「无法判断」，不是「不支持」。
 * 只用于判断主模型能力，不会自动挑选别的模型。
 */
export async function listModels(config, { force = false } = {}) {
  const key = config.baseUrl;
  const hit = modelCache.get(key);
  if (!force && hit && Date.now() - hit.at < MODEL_CACHE_TTL) return hit.models;
  try {
    const response = await fetch(`${key}/models`, {
      headers: { Authorization: `Bearer ${config.apiKey}` },
      signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    const raw = Array.isArray(data?.data) ? data.data : Array.isArray(data?.models) ? data.models : [];
    const models = raw.map(normalizeModel).filter(Boolean);
    modelCache.set(key, { at: Date.now(), models });
    return models;
  } catch {
    modelCache.set(key, { at: Date.now(), models: null });
    return null;
  }
}

/**
 * 主模型能否读图：true / false / null（不知道）。
 * 两种「不知道」：清单里没有这个模型名（自建别名、代理改名、私有部署）；
 * 或者清单里压根没有模态字段（cc.yjk.cn 这类只回 id/owned_by 的网关）。
 * 不知道时按能读图内联试一次，模型真读不了再由 rejectBlindReply 兜底。
 */
export async function mainSupportsImages(config) {
  const models = await listModels(config);
  if (!models) return null;
  const main = models.find((item) => item.id === config.model);
  if (!main) return null;
  return main.image;
}

/**
 * 打开 AI 面板时用的快速判断：最多等 timeoutMs。
 * 网关慢不该让面板卡住——超时就当「无法判断」（后续真的带图时还会再判一次）。
 */
export async function quickMainSupportsImages(config, timeoutMs = 1500) {
  let timer = null;
  try {
    return await Promise.race([
      mainSupportsImages(config).catch(() => null),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve(null), timeoutMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * 决定这次请求的读图方式：
 * - 主模型支持（或无法判断）：内联直传，不额外调用
 * - 主模型不支持且用户启用了独立视觉模型：用用户填的模型 + 自己的地址/Key
 * - 否则报错，明确告诉用户去哪儿配，**不做任何自动挑选**
 */
export async function resolveVision(config) {
  const main = await mainSupportsImages(config);
  if (main !== false) {
    return {
      model: config.model,
      baseUrl: config.baseUrl,
      apiKey: config.apiKey,
      inline: true,
      source: main === true ? 'main' : 'main-assumed',
    };
  }

  const vision = config.vision ?? {};
  if (!vision.enabled || !vision.model) {
    throw new Error(
      `主模型「${config.model}」不支持图片输入。`
      + '请到「用户与系统 → AI 设置」勾选「独立视觉模型」，填入支持读图的模型、接口地址与独立 API Key；'
      + '或直接把主模型换成多模态模型。',
    );
  }

  const baseUrl = String(vision.baseUrl || config.baseUrl).replace(/\/+$/, '');
  const apiKey = vision.apiKey || config.apiKey;
  if (!apiKey) {
    throw new Error(`视觉模型「${vision.model}」缺少 API Key：请在 AI 设置的「独立视觉模型」里填写它自己的 Key。`);
  }
  return { model: vision.model, baseUrl, apiKey, inline: false, source: 'vision' };
}

/* ---------- 读图 → 结构化规格 ---------- */

const SHAPES = 'box / roundedBox / cylinder / tube / sphere / ellipsoid / capsule / cone / torus / prism / revolve / loft / sweep / hull';

const VISION_SYSTEM = `你是资深工业设计师 + 机械制图读图员。用户会给你一张（或几张）产品照片、截图或手绘草图，
你要把它转成「可以直接参数化建模的结构化规格」。

要求：
1. 只描述看得见的东西，看不清就留空并在 uncertain 里说明，不要编造细节。
2. 尺寸用毫米。用户给了尺寸就以用户为准；有标注就按标注；否则先按比例估算整体包围盒，
   再用各部件的像素占比推算其余尺寸（宁可给整数，也不要写「大约 1.2 倍」这种相对值）。
3. 零件要拆开列：一个零件 = 一个可以独立建模的形状。相邻零件要能看出是怎么连的（同轴、贴合、嵌入）。
4. shape 只能从这几个里选：${SHAPES}。
5. 材质尽量从这些预设里选：aluminum / steel / carbon / plastic / plasticDark / rubber / glass / copper / brass / gold / paintWhite / paintOrange / ceramic / wood；
   不合适再用自定义色，color 写 #rrggbb，同时给出 roughness / metalness（0–1）。
6. 显著特征（孔、槽、棱、倒角、阵列数量、分模线）写进 details，这些是让模型“像”的关键。
7. 多张图是同一物体的不同视角时，合并成一份规格，不要重复列零件。

只输出一个 JSON 对象，不要任何解释文字，结构：
{
  "object": "物体名称，例如 充电式电动螺丝刀",
  "orientation": "轴朝向与摆放，例如 长轴沿 X，握把朝 -Z 后倾",
  "bbox_mm": { "length": 220, "width": 62, "height": 190 },
  "parts": [
    {
      "name": "机身外壳",
      "shape": "roundedBox",
      "size_mm": { "width": 62, "depth": 48, "height": 210, "radius": 10 },
      "position": "沿 X 居中，轴线高度 z=30，与握把根部重叠 5mm",
      "count": 1,
      "material": "paintWhite",
      "color": "#EEF2F5",
      "detail": "侧面 6 条竖向散热槽，尾部一圈分模线"
    }
  ],
  "details": ["夹头为三瓣分体，120° 均布"],
  "uncertain": ["握把长度只能按比例估，误差约 ±15%"]
}`;

/** 宽松解析：模型常把 JSON 包在 ```json 里，或在前后加一句解释 */
function parseJsonLoose(text) {
  if (!text) return null;
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = (fenced ? fenced[1] : text).trim();
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(candidate.slice(start, end + 1));
  } catch {
    return null;
  }
}

function num(value) {
  const parsed = typeof value === 'number' ? value : Number.parseFloat(String(value ?? ''));
  return Number.isFinite(parsed) ? parsed : null;
}

function sizeText(size) {
  if (!size) return '';
  if (typeof size === 'string') return size;
  return Object.entries(size)
    .map(([key, value]) => `${key} ${num(value) ?? value}`)
    .filter((item) => !/ undefined$/.test(item))
    .join(' × ');
}

/** 把 JSON 规格压成一段建模模型能直接吃的文本（比原样塞 JSON 更省 token，也更难被忽略） */
export function formatAnalysis(spec, { model = '', images = 1 } = {}) {
  if (!spec || typeof spec !== 'object') return '';
  const lines = [];
  const bbox = spec.bbox_mm ?? {};
  lines.push(`【参考图片的视觉分析】${model ? `（由 ${model} 读取 ${images} 张图）` : ''}`);
  if (spec.object) lines.push(`物体：${spec.object}`);
  if (spec.orientation) lines.push(`朝向与轴向：${spec.orientation}`);
  const box = [num(bbox.length), num(bbox.width), num(bbox.height)];
  if (box.every((item) => item !== null)) lines.push(`整体包围盒（mm）：长 ${box[0]} × 宽 ${box[1]} × 高 ${box[2]}`);

  const parts = Array.isArray(spec.parts) ? spec.parts : [];
  if (parts.length) {
    lines.push(`零件清单（${parts.length} 项，尺寸单位 mm）：`);
    parts.forEach((part, index) => {
      const bits = [
        `形状 ${part?.shape ?? '未标注'}`,
        sizeText(part?.size_mm) ? `尺寸 ${sizeText(part.size_mm)}` : '',
        part?.position ? `位置 ${part.position}` : '',
        num(part?.count) && num(part.count) > 1 ? `数量 ${num(part.count)}` : '',
        part?.material ? `材质 ${part.material}` : '',
        part?.color ? `颜色 ${part.color}` : '',
        part?.detail ? `细节 ${part.detail}` : '',
      ].filter(Boolean);
      lines.push(`${index + 1}. ${part?.name ?? '未命名'}｜${bits.join('｜')}`);
    });
  }

  const details = Array.isArray(spec.details) ? spec.details.filter(Boolean) : [];
  if (details.length) lines.push(`显著细节：${details.join('；')}`);
  const uncertain = Array.isArray(spec.uncertain) ? spec.uncertain.filter(Boolean) : [];
  if (uncertain.length) lines.push(`图上不确定的地方（可以按比例估，不要因此停下）：${uncertain.join('；')}`);
  return lines.join('\n');
}

/**
 * 调视觉模型读图，返回 { model, spec, text, object, parts }。
 * 视觉调用失败会抛出可读错误——静默忽略图片会让用户以为模型没理他。
 */
export async function describeImages(config, images, { message = '', signal = null, resolved = null } = {}) {
  const target = resolved ?? await resolveVision(config);
  const timeoutMs = Math.min(config.timeoutMs ?? 120000, 150000);
  const instruction = [
    message.trim() ? `用户的建模需求：${message.trim()}` : '用户只上传了图片，请按图片建模。',
    `共 ${images.length} 张图${images.length > 1 ? '（同一物体的不同视角）' : ''}。`,
    '请输出结构化规格 JSON。',
  ].join('\n');

  let response;
  try {
    response = await fetch(`${target.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${target.apiKey}`,
        Accept: 'application/json',
      },
      body: JSON.stringify({
        model: target.model,
        stream: false,
        temperature: 0.1,
        messages: [
          { role: 'system', content: VISION_SYSTEM },
          {
            role: 'user',
            content: [
              ...images.map((image) => ({ type: 'image_url', image_url: { url: image.dataUrl } })),
              { type: 'text', text: instruction },
            ],
          },
        ],
      }),
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    if (error?.name === 'AbortError' || error?.name === 'TimeoutError') {
      throw new Error(`读图超时（模型 ${target.model} 超过 ${Math.round(timeoutMs / 1000)} 秒没返回）`);
    }
    throw new Error(`读图请求失败：${error?.cause?.code ?? error?.message ?? '网络错误'}（模型 ${target.model}）`);
  }

  const text = await response.text().catch(() => '');
  if (!response.ok) {
    const hint = response.status === 400 && /image|vision|modal/i.test(text)
      ? `（模型 ${target.model} 可能不支持图片输入，请检查 AI 设置里的视觉模型）`
      : '';
    throw new Error(`读图失败 HTTP ${response.status}${hint}：${text.slice(0, 300) || '（响应体为空）'}`);
  }

  let content = '';
  try {
    content = JSON.parse(text)?.choices?.[0]?.message?.content ?? '';
  } catch {
    throw new Error(`读图返回了非 JSON 响应：${text.slice(0, 200) || '（响应体为空）'}`);
  }
  if (Array.isArray(content)) {
    // 部分实现把 content 拆成 [{ type: 'text', text }]
    content = content.map((item) => (typeof item === 'string' ? item : item?.text ?? '')).join('');
  }

  const spec = parseJsonLoose(content);
  if (!spec) {
    // 没按 JSON 回也能用：把原文当描述，至少能建模
    return {
      model: target.model,
      spec: null,
      text: `【参考图片的视觉分析】（由 ${target.model} 读取 ${images.length} 张图，未按结构返回）\n${String(content).slice(0, 4000)}`,
      object: '',
      parts: 0,
    };
  }

  return {
    model: target.model,
    spec,
    text: formatAnalysis(spec, { model: target.model, images: images.length }),
    object: String(spec.object ?? '').slice(0, 120),
    parts: Array.isArray(spec.parts) ? spec.parts.length : 0,
  };
}
