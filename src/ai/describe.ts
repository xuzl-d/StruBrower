/**
 * AI 只读特征树查询：把项目上下文里被裁剪掉的**原始**特征定义取回来。
 *
 * 项目上下文（server/ai/context.js + budget.js）为了装进模型窗口只列前 48 个特征，
 * 复杂 shape 会退化成描述文字；改一个 loft 截面、核对某个特征的完整参数时就不够用。
 * describe 直接读当前文档里的 primitive.features，不做求值、不改写任何东西，
 * 结果以文字回灌下一轮（和 measure 同一条闭环通道）。
 *
 * 输出里的序号从 1 起，与上下文 features[].index、setDimensions 的 f1/f2 路径一致。
 */
import type { BimElement, ProjectDocument, SolidFeature } from '../bim/types';
import type { AiDescribeRequest } from '../data';

type SolidElement = Extract<BimElement, { category: 'mesh' }>;

const isSolid = (element: BimElement): element is SolidElement =>
  element.category === 'mesh' && element.primitive?.kind === 'solid';

const featuresOf = (element: SolidElement): SolidFeature[] =>
  element.primitive?.kind === 'solid' ? element.primitive.features : [];

/** 单条请求的输出上限：防止一个超长 loft 把整轮上下文挤爆（约 5k token） */
const MAX_REQUEST_CHARS = 20_000;
/**
 * 一轮所有请求的输出总预算。
 * 4 条请求 × 单条 2 万 = 8 万字符，回灌到下一轮时会被 stepPrompt 裁掉大半，
 * 模型就会「以为看全了其实只看了一半」。这里按总预算分配，
 * 让每条结果自带准确的分页提示，而不是事后被硬切一刀。
 */
export const MAX_TOTAL_CHARS = 16_000;
const MIN_REQUEST_CHARS = 1_200;
const MAX_SEARCH_HITS = 40;

const HEADER = '[特征树查询结果] 以下是当前文档里的原始参数化特征定义（只读，未经过项目上下文裁剪）。'
  + '序号 index 从 1 起，与 setDimensions 的 f1/f2 路径、editFeature 的 feature 参数一致；'
  + 'shape 里的字段就是可以直接 patch 的尺寸。';

class Resolution extends Error {}

function resolveElement(document: ProjectDocument, ref: string | number | undefined): SolidElement {
  const solids = document.elements.filter(isSolid);
  if (!solids.length) throw new Resolution('项目里没有造型构件（describe 只能查带特征树的实体）');
  if (ref === undefined) {
    if (solids.length === 1) return solids[0]!;
    throw new Resolution(`有 ${solids.length} 个造型构件，请用 target 指定：${solids.map((item, index) => `${index + 1}.${item.name}`).join('、')}`);
  }
  if (typeof ref === 'number') {
    const element = solids[ref - 1];
    if (!element) throw new Resolution(`构件序号 ${ref} 超出范围（1 ~ ${solids.length}）`);
    return element;
  }
  const text = ref.trim();
  if (/^\d+$/.test(text)) return resolveElement(document, Number(text));
  const exact = solids.filter((item) => item.id === text || item.name === text);
  if (exact.length === 1) return exact[0]!;
  const partial = solids.filter((item) => item.name.includes(text));
  if (partial.length === 1) return partial[0]!;
  throw new Resolution(partial.length
    ? `构件名「${text}」匹配到 ${partial.length} 个，请改用 id 或序号`
    : `找不到造型构件「${text}」，可用：${solids.map((item, index) => `${index + 1}.${item.name}`).join('、')}`);
}

function resolveFeatureIndex(features: SolidFeature[], ref: string | number): number {
  const text = String(ref).trim();
  if (/^\d+$/.test(text)) {
    const index = Number(text) - 1;
    if (!features[index]) throw new Resolution(`特征序号 ${text} 超出范围（1 ~ ${features.length}）`);
    return index;
  }
  const byId = features.findIndex((item) => item.id === text);
  if (byId >= 0) return byId;
  const matches = features
    .map((feature, index) => ({ feature, index }))
    .filter(({ feature }) => (feature.label ?? '').includes(text) || feature.shape?.shape === text);
  if (matches.length === 1) return matches[0]!.index;
  throw new Resolution(matches.length
    ? `「${text}」匹配到 ${matches.length} 个特征，请改用序号或 id`
    : `找不到特征「${text}」（共 ${features.length} 个，可用 search 先查名字）`);
}

function elementHeader(element: SolidElement): string {
  const raw = element as unknown as Record<string, unknown>;
  const bits = [`构件「${element.name}」id=${element.id}`, `共 ${featuresOf(element).length} 个特征`];
  if (Array.isArray(raw.offset)) bits.push(`position=${JSON.stringify(raw.offset.slice(0, 2))}`);
  if (typeof raw.rotation === 'number') bits.push(`rotation=${(raw.rotation * 180 / Math.PI).toFixed(1)}°`);
  if (typeof raw.scale === 'number') bits.push(`scale=${raw.scale}`);
  if (typeof raw.color === 'string') bits.push(`color=${raw.color}`);
  if (raw.constraints) bits.push('有自定义约束');
  return bits.join(' · ');
}

/**
 * 保留原始字段名：模型看到的就是能原样写回 editFeature / setDimensions 的结构。
 * 例外是内联贴图 —— 几百 KB 的 base64 会把整轮上下文挤爆，替换成短标记，
 * 并告诉模型该怎么重新写 map（回灌完整图片既没用也没法原样写回）。
 */
function featureLine(index: number, feature: SolidFeature): string {
  const material = feature.material;
  const longMap = typeof material?.map === 'string' && material.map.length > 512;
  const longBump = typeof material?.bumpMap === 'string' && material.bumpMap.length > 512;
  if (material && typeof material === 'object' && (longMap || longBump)) {
    const view = {
      ...feature,
      material: {
        ...material,
        ...(longMap ? {
          map: `<内联贴图 ${Math.round(material.map!.length / 1024)} KB；完整图片不回灌，要换贴图写 map:"ai:<提示词>">`,
        } : {}),
        ...(longBump ? {
          bumpMap: `<凹凸贴图 ${Math.round(material.bumpMap!.length / 1024)} KB；与颜色图配套，写 bumpMap:"auto" 即可>`,
        } : {}),
      },
    };
    return `   ${index + 1}) ${JSON.stringify(view)}`;
  }
  return `   ${index + 1}) ${JSON.stringify(feature)}`;
}

function describeElement(document: ProjectDocument, request: Extract<AiDescribeRequest, { type: 'element' }>, budget: number): string {
  const element = resolveElement(document, request.target);
  const features = featuresOf(element);
  const from = Math.max(1, Math.min(features.length || 1, Math.floor(request.from)));
  const count = Math.max(1, Math.floor(request.count));
  const end = Math.min(features.length, from + count - 1);
  const limit = Math.max(MIN_REQUEST_CHARS, Math.min(MAX_REQUEST_CHARS, budget));
  const lines = [elementHeader(element), `   本次列出 ${from}–${end}（共 ${features.length} 个），以下是完整定义：`];
  if (!features.length) return [...lines, '   （这个构件没有特征）'].join('\n');
  for (let index = from - 1; index < end; index += 1) {
    const line = featureLine(index, features[index]!);
    if (lines.join('\n').length + line.length > limit && index > from - 1) {
      lines.push(`   …受单轮输出长度限制，${index + 1}–${end} 未列出；用 { "type":"element", "target":"${element.name}", "from":${index + 1}, "count":${count} } 继续查。`);
      break;
    }
    lines.push(line);
  }
  if (end < features.length) {
    lines.push(`   还有 ${features.length - end} 个特征未列出，用 from=${end + 1} 继续查；只看某一个用 { "type":"feature", "feature":序号或名称 }。`);
  }
  return lines.join('\n');
}

function describeFeature(document: ProjectDocument, request: Extract<AiDescribeRequest, { type: 'feature' }>): string {
  const element = resolveElement(document, request.target);
  const features = featuresOf(element);
  const index = resolveFeatureIndex(features, request.feature);
  return [elementHeader(element), `   特征 ${index + 1} 的完整定义：`, featureLine(index, features[index]!)].join('\n');
}

function describeSearch(document: ProjectDocument, request: Extract<AiDescribeRequest, { type: 'search' }>): string {
  const query = request.query.toLowerCase();
  const lines = [`检索「${request.query}」：`];
  let hits = 0;
  const scope = request.target === undefined ? document.elements : [resolveElement(document, request.target)];
  for (const element of scope) {
    if (hits >= MAX_SEARCH_HITS) break;
    const nameHit = element.name.toLowerCase().includes(query)
      || element.id.toLowerCase().includes(query)
      || element.category.toLowerCase().includes(query);
    const features = isSolid(element) ? featuresOf(element) : [];
    const featureHits = features
      .map((feature, index) => ({ feature, index }))
      .filter(({ feature }) => (feature.label ?? '').toLowerCase().includes(query)
        || String(feature.id ?? '').toLowerCase().includes(query)
        || String(feature.shape?.shape ?? '').toLowerCase().includes(query));
    if (!nameHit && !featureHits.length) continue;
    if (nameHit) {
      lines.push(`   构件 ${element.name}（id=${element.id}，category=${element.category}${features.length ? `，${features.length} 个特征` : ''}）`);
      hits += 1;
    }
    for (const { feature, index } of featureHits.slice(0, Math.max(0, MAX_SEARCH_HITS - hits))) {
      lines.push(`   ${element.name} 的特征 ${index + 1}：${feature.label ?? feature.shape?.shape ?? '(未命名)'}（id=${feature.id ?? '无'}，shape=${feature.shape?.shape ?? '未知'}${feature.mode && feature.mode !== 'add' ? `，mode=${feature.mode}` : ''}）`);
      hits += 1;
    }
  }
  if (hits === 0) return `检索「${request.query}」：没有匹配的构件或特征。可以用 { "type":"element" } 列出构件后再按序号查。`;
  if (hits >= MAX_SEARCH_HITS) lines.push(`   …最多显示 ${MAX_SEARCH_HITS} 条，请缩小关键词。`);
  lines.push('   找到目标后用 { "type":"feature", "feature":序号 } 取完整定义，或按序号写 editFeature / setDimensions。');
  return lines.join('\n');
}

function runOne(document: ProjectDocument, request: AiDescribeRequest, budget: number): string {
  if (request.type === 'element') return describeElement(document, request, budget);
  if (request.type === 'feature') return describeFeature(document, request);
  return describeSearch(document, request);
}

export function runDescribe(document: ProjectDocument, requests: AiDescribeRequest[]): string {
  const lines = [HEADER];
  let used = HEADER.length;
  requests.forEach((request, index) => {
    const remaining = MAX_TOTAL_CHARS - used;
    if (remaining < MIN_REQUEST_CHARS) {
      // 前面的请求已经把预算吃掉了：明说「这条没查」，别让模型以为结果就是空的
      lines.push(`${index + 1}. 本轮工具输出已达 ${MAX_TOTAL_CHARS} 字上限，这条请求没有执行；下一轮单独查它，或用更小的 count / 更准的关键词。`);
      return;
    }
    try {
      const text = `${index + 1}. ${runOne(document, request, remaining)}`;
      lines.push(text);
      used += text.length + 1;
    } catch (error) {
      lines.push(`${index + 1}. 无法查询：${error instanceof Error ? error.message : String(error)}`);
    }
  });
  return lines.join('\n');
}
