/**
 * AI 生成贴图 → 特征材质。
 *
 * 契约：模型在 `material.map` 里写 `ai:<提示词>`（短占位符，不会把 base64 塞进
 * LLM 输出）；本模块在 /ai/plan 返回、前端 apply 之前，把占位符换成真正的
 * `data:image/png;base64,…`。这样：
 *   - 模型的输出体积不受图片影响，预校验（dryRun）也不会被大字符串拖慢；
 *   - 图片只在「服务端 → 前端 → /ai/apply」这一段走一次；
 *   - 没配图像模型 / 上游失败时，用内置程序化青花纹理兜底，整轮建模不会失败。
 */
import { normalizeSolidMap, SOLID_MAP_MAX_CHARS } from '../../shared/materials.js';
import { generateProceduralTexture } from './texture-pattern.js';

const STYLE_HINT = '无缝柱面 UV 展开贴图，平涂图案，白底，无透视、无阴影、无边框、无文字、无模型照片。'
  + ' Seamless cylindrical UV texture, flat pattern, no perspective, no shading, no border, no text.';

/**
 * 会话历史里图片本体被裁掉后留下的标记。
 *
 * 早期版本写成 `ai:贴图已生成（历史记录省略图片数据）`，模型会把它当成新提示词照抄回 ops，
 * 于是每一轮都重新生成一张（没配图像模型时永远是青花）——「改了五轮还是青花」就是这个原因。
 * 现在改成不以 ai: 开头的纯说明，并在 resolveTextureOps 里显式识别、不覆盖已有贴图。
 */
export const HISTORY_MAP_MARKER = '[贴图已生成·历史省略，不换纹理时不要写 map]';
const HISTORY_MAP_RE = /历史记录省略图片数据|历史省略|^\[贴图已生成/;

export function isHistoryMapMarker(value) {
  return typeof value === 'string' && HISTORY_MAP_RE.test(value);
}

/** 图像生成配置：默认复用主模型的 baseUrl / apiKey，只多一个模型名 */
export function imageConfigOf(config) {
  const image = config?.image ?? {};
  const model = typeof image.model === 'string' ? image.model.trim() : '';
  const baseUrl = String(image.baseUrl || config?.baseUrl || '').replace(/\/+$/, '');
  const apiKey = String(image.apiKey || config?.apiKey || '');
  const timeoutMs = Number(image.timeoutMs || config?.timeoutMs || 120000);
  return {
    enabled: Boolean(model && apiKey && baseUrl),
    model,
    baseUrl,
    apiKey,
    size: String(image.size || '1024x1024'),
    timeoutMs: Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 120000,
  };
}

function signalWithTimeout(signal, timeoutMs) {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

async function urlToDataUrl(url, signal) {
  const response = await fetch(url, { signal });
  if (!response.ok) throw new Error(`下载生图结果失败：HTTP ${response.status}`);
  const type = (response.headers.get('content-type') || 'image/png').split(';')[0].trim().toLowerCase();
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(type)) throw new Error(`不支持的图片格式：${type}`);
  const buffer = Buffer.from(await response.arrayBuffer());
  return `data:${type};base64,${buffer.toString('base64')}`;
}

/** 调 OpenAI-compatible /images/generations；返回 null 表示不可用（调用方降级） */
async function callImageApi(image, prompt, signal) {
  const body = {
    model: image.model,
    prompt: `${prompt}\n${STYLE_HINT}`,
    n: 1,
    size: image.size,
    response_format: 'b64_json',
  };
  const response = await fetch(`${image.baseUrl}/images/generations`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${image.apiKey}`,
      Accept: 'application/json',
    },
    body: JSON.stringify(body),
    signal: signalWithTimeout(signal, image.timeoutMs),
  });
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 300);
    throw new Error(`图像模型 HTTP ${response.status}：${detail}`);
  }
  const data = await response.json();
  const first = data?.data?.[0] ?? data;
  let raw = null;
  if (typeof first?.b64_json === 'string' && first.b64_json) {
    const mime = typeof first.mime === 'string' && /^image\/(png|jpeg|webp)$/.test(first.mime) ? first.mime : 'image/png';
    raw = `data:${mime};base64,${first.b64_json.replace(/\s+/g, '')}`;
  } else if (typeof first?.url === 'string' && first.url) {
    raw = await urlToDataUrl(first.url, signalWithTimeout(signal, image.timeoutMs));
  } else if (typeof data?.b64_json === 'string') {
    raw = `data:image/png;base64,${data.b64_json.replace(/\s+/g, '')}`;
  }
  if (!raw) throw new Error('图像模型返回里没有 b64_json / url');
  const dataUrl = normalizeSolidMap(raw);
  if (!dataUrl) throw new Error(`图像模型返回的图片不合规或超过 ${SOLID_MAP_MAX_CHARS} 字符上限`);
  return { dataUrl, width: 0, height: 0, bytes: Buffer.byteLength(dataUrl, 'utf8') };
}

/**
 * 生成一张贴图。优先调外部图像模型；没配置、超时、返回不合规时自动降级为
 * 内置程序化纹理（确定性强，mock / 离线环境也能跑通全链路）。
 * 程序化足球会额外返回 `bumpDataUrl`：与颜色图严格对齐的灰度高度图，
 * 由 resolveTextureOps 自动写进材质，让拼缝在光照下真的凹下去。
 */
export async function generateTexture(config, prompt, { signal } = {}) {
  const image = imageConfigOf(config);
  if (image.enabled) {
    try {
      const result = await callImageApi(image, prompt, signal);
      return { ...result, source: 'model', model: image.model, prompt };
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      console.warn(`[ai] 生图降级为程序化纹理（${image.model}）：${detail.slice(0, 300)}`);
      const fallback = generateProceduralTexture(prompt);
      return {
        ...fallback,
        source: 'procedural-fallback',
        model: image.model,
        prompt,
        warning: `${detail.slice(0, 160)}；已降级为内置程序化图案（${fallback.pattern === 'football' ? '黑白足球' : '青花缠枝莲'}）`,
      };
    }
  }
  const fallback = generateProceduralTexture(prompt);
  // 没配图像模型时，除足球外一律是青花占位图。把这个事实写进报告，
  // 否则模型会以为「提示词没写准」，在自检里一遍遍改提示词、一遍遍拿到同一张青花。
  const isPorcelainPlaceholder = fallback.pattern === 'porcelain'
    && !/青花|缠枝莲|瓷|vase|porcelain|texture|贴图/i.test(prompt);
  return {
    ...fallback,
    source: 'procedural',
    prompt,
    ...(isPorcelainPlaceholder ? {
      warning: `未配置图像模型：提示词「${prompt.slice(0, 40)}」被内置青花占位纹理代替。`
        + '程序化图案目前只有「青花」与「黑白足球」，反复换提示词不会改变结果；要任意图案请在 AI 设置里配置图像模型。',
    } : {}),
  };
}

function visitMaterials(value, visit) {
  if (Array.isArray(value)) {
    for (const item of value) visitMaterials(item, visit);
    return;
  }
  if (!value || typeof value !== 'object') return;
  // 第二个参数是 material 的持有者，清理空材质时要把它从父对象上摘掉
  if (value.material && typeof value.material === 'object') visit(value.material, value);
  for (const [key, child] of Object.entries(value)) {
    if (key === 'material') continue;
    visitMaterials(child, visit);
  }
}

/**
 * 把 ops 里所有 `material.map: "ai:<提示词>"` 换成真实图片。
 * 相同提示词只生成一次；返回生成报告（不含图片本体），供前端气泡展示。
 */
export async function resolveTextureOps(ops, config, { onEvent, signal } = {}) {
  if (!Array.isArray(ops)) return { ops: [], textures: [] };
  const requests = [];
  const stale = [];
  visitMaterials(ops, (material, owner) => {
    if (typeof material.map !== 'string') return;
    // 兼容旧会话里已经落库的 `ai:贴图已生成（历史记录省略图片数据）`
    if (isHistoryMapMarker(material.map)) {
      stale.push({ material, owner });
      return;
    }
    if (material.map.startsWith('ai:')) {
      requests.push({ material, prompt: material.map.slice(3).trim() || '青花缠枝莲纹' });
    }
  });
  // 'auto' 必须配一张 ai: 颜色图才有意义；孤立出现时直接删掉，别让 dry-run 判成非法材质
  visitMaterials(ops, (material) => {
    if (material.bumpMap === 'auto' && !(typeof material.map === 'string' && material.map.startsWith('ai:'))) {
      delete material.bumpMap;
    }
  });

  // 历史标记不是提示词：模型的意思是「沿用已有贴图」。删掉 map 别覆盖现有材质，
  // 也别再生成一张新图；顺手清掉因此变空的 material / patch / op，免得 dry-run 报「没有要修改的字段」。
  for (const { material, owner } of stale) {
    delete material.map;
    // 凹凸图与颜色图配套，沿用旧贴图时不该拿旧 bump 覆盖或重设
    delete material.bumpMap;
    if (Object.keys(material).length === 0) {
      for (const [key, child] of Object.entries(owner ?? {})) {
        if (child === material) delete owner[key];
      }
    }
  }
  const cleaned = stale.length
    ? ops.filter((op) => {
        if (!op || typeof op !== 'object' || op.op !== 'editFeature') return true;
        const patch = op.patch && typeof op.patch === 'object' ? op.patch : null;
        const hasTopLevelPatch = Object.keys(op).some((key) => !['op', 'target', 'feature', 'patch'].includes(key));
        return hasTopLevelPatch || (patch !== null && Object.keys(patch).length > 0);
      })
    : ops;
  if (stale.length) {
    onEvent?.({ type: 'status', text: `沿用已有贴图，跳过 ${stale.length} 个历史标记（未重复生成）` });
  }
  if (!requests.length) return { ops: cleaned, textures: [] };

  const cache = new Map();
  const textures = [];
  for (const request of requests) {
    let generated = cache.get(request.prompt);
    if (!generated) {
      onEvent?.({ type: 'status', text: `正在生成贴图：${request.prompt.slice(0, 40)}…` });
      generated = await generateTexture(config, request.prompt, { signal });
      cache.set(request.prompt, generated);
      textures.push({
        prompt: request.prompt,
        source: generated.source,
        model: generated.model ?? '',
        width: generated.width,
        height: generated.height,
        bytes: generated.bytes,
        chars: generated.dataUrl.length,
        bumpChars: generated.bumpDataUrl?.length ?? 0,
        pattern: generated.pattern ?? '',
        layout: generated.layout ?? '',
        ...(generated.warning ? { warning: generated.warning } : {}),
      });
    }
    request.material.map = generated.dataUrl;
    if (generated.bumpDataUrl) {
      // 模型没写或写了 'auto' 就自动配套高度图；显式给了图片时不覆盖
      if (!request.material.bumpMap || request.material.bumpMap === 'auto') {
        request.material.bumpMap = generated.bumpDataUrl;
        if (request.material.bumpScale === undefined) request.material.bumpScale = 0.004;
      }
    } else if (request.material.bumpMap === 'auto') {
      delete request.material.bumpMap;
    }
  }
  return { ops: cleaned, textures };
}

/**
 * 会话历史里不存图片本体：把内联 data URL 换成短占位符。
 * 返回深拷贝，不影响这一轮要发给前端 / 要落项目文档的 ops。
 */
export function slimOpsForHistory(ops) {
  if (!Array.isArray(ops)) return ops;
  let hasInline = false;
  visitMaterials(ops, (material) => {
    if (typeof material.map === 'string' && material.map.startsWith('data:image/')) hasInline = true;
    if (typeof material.bumpMap === 'string' && material.bumpMap.startsWith('data:image/')) hasInline = true;
  });
  if (!hasInline) return ops;
  const clone = JSON.parse(JSON.stringify(ops));
  visitMaterials(clone, (material) => {
    if (typeof material.map === 'string' && material.map.startsWith('data:image/')) {
      material.map = HISTORY_MAP_MARKER;
    }
    // 凹凸图永远跟着颜色图走：历史里直接删掉，模型不需要（也不该）把它写回 ops
    delete material.bumpMap;
  });
  return clone;
}
