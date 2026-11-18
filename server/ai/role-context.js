/**
 * 多角色编排用的「现有模型」上下文。
 *
 * 以前直接 `clip(JSON.stringify(context), 2500)`：JSON 的前 2500 字符基本都是
 * project / levels / types / grids，特征树（elements 在后面）根本没进角色提示词，
 * 而且字符串截断会切在半个括号上。这里改成：
 *
 * 1. 从**原始 document** 取选中构件的 primitive.features（不经过 context/budget 的 48 特征裁剪）；
 * 2. 规划角色拿详细版（含完整 shape），其余角色拿精简版（序号 / 名字 / 形状类型）；
 * 3. 按 token 预算逐级降档：去 shape 参数 → 减特征数 → 减构件数 → 减其它构件清单，
 *    每一档都是完整对象再 JSON.stringify，绝不切字符串；
 * 4. 省略量写进 omitted，角色知道「还有没列出来的」，不会凭空推断 id。
 *
 * 这是只读上下文：编排链路产出的是一条新的 addSolid，不是对已有构件做 editFeature。
 */
import { estimateTokens } from './budget.js';
import { describeShape } from './solid.js';

/** 单个 shape 的原始 JSON 超过这个长度就只给摘要，避免一个 loft 吃光整份预算 */
const MAX_SHAPE_CHARS = 4000;
const DETAILED_TOKENS = 4000;
const BRIEF_TOKENS = 700;

function pickSolidElements(document, context) {
  const elements = Array.isArray(document?.elements) ? document.elements : [];
  const byId = new Map(elements.map((element) => [element?.id, element]));
  const selected = Array.isArray(context?.selected) ? context.selected : [];
  const ids = selected.map((item) => item?.id).filter(Boolean);
  if (ids.length) {
    return {
      elements: ids.map((id) => byId.get(id)).filter((element) => element?.primitive?.kind === 'solid'),
      source: 'selected',
      ids,
    };
  }
  // 没选中时别退化成只有骨架：给第一个造型构件，角色至少知道现有模型的比例与坐标系
  const first = elements.find((element) => element?.primitive?.kind === 'solid');
  return { elements: first ? [first] : [], source: 'firstSolid', ids: first ? [first.id] : [] };
}

function featureShape(feature, withData, concise) {
  const shape = feature?.shape;
  if (!shape) return { shape: null };
  const name = typeof shape === 'object' ? String(shape.shape ?? 'unknown') : String(shape);
  // 精简版只要形状类型；详细版里预算不够的特征也保留形状摘要 + 明确标注没给完整数据
  if (!withData) {
    return concise
      ? { shape: name }
      : { shape: name, shapeSummary: describeShape(shape), shapeOmitted: true };
  }
  const raw = JSON.stringify(shape);
  if (raw.length > MAX_SHAPE_CHARS) {
    return { shape: name, shapeSummary: describeShape(shape), shapeOmitted: true, shapeChars: raw.length };
  }
  return { shapeData: shape, shape: name };
}

function featureEntry(feature, index, { detailed, dataLimit }) {
  // rich = 完整原始定义（含 shapeData 与全部变换）；其余特征保留骨架，让整棵树都在场
  const rich = detailed && index < dataLimit;
  const entry = {
    index: index + 1,
    id: feature?.id ?? null,
    label: feature?.label ?? null,
    ...featureShape(feature, rich, !detailed),
  };
  if (feature?.mode && feature.mode !== 'add') entry.mode = feature.mode;
  if (!rich) return entry;
  for (const key of ['translate', 'rotate', 'scale', 'fillet', 'shell', 'offset', 'pattern', 'material']) {
    if (feature?.[key] === undefined) continue;
    // 材质里的 map / bumpMap 是几百 KB 内联图片：只留一个短标记，别把 base64 塞进角色提示词
    if (key === 'material' && feature.material && typeof feature.material === 'object') {
      const { map, bumpMap, ...rest } = feature.material;
      entry.material = {
        ...rest,
        ...(typeof map === 'string'
          ? { map: map.length > 512 ? `<内联贴图 ${Math.round(map.length / 1024)} KB>` : map }
          : {}),
        ...(typeof bumpMap === 'string'
          ? { bumpMap: bumpMap.length > 512 ? '<凹凸贴图（历史省略）>' : bumpMap }
          : {}),
      };
    } else {
      entry[key] = feature[key];
    }
  }
  return entry;
}

function elementEntry(element, { detailed, dataLimit, featureLimit }) {
  const features = Array.isArray(element?.primitive?.features) ? element.primitive.features : [];
  const kept = Math.min(features.length, featureLimit);
  const raw = element;
  const entry = {
    id: element.id,
    name: element.name,
    category: element.category,
    featureCount: features.length,
    features: features.slice(0, kept).map((feature, index) => featureEntry(feature, index, { detailed, dataLimit })),
  };
  if (Array.isArray(raw?.offset)) entry.position = raw.offset.slice(0, 2);
  if (typeof raw?.rotation === 'number') entry.rotationDegrees = Number((raw.rotation * 180 / Math.PI).toFixed(2));
  if (typeof raw?.scale === 'number') entry.scale = raw.scale;
  if (raw?.color) entry.color = raw.color;
  if (raw?.constraints) entry.hasConstraints = true;
  if (kept < features.length) entry.omittedFeatures = features.length - kept;
  return entry;
}

function project(payload, { detailed, dataLimit, featureLimit, keepOthers }) {
  const selected = payload.elements.map((element) => elementEntry(element, { detailed, dataLimit, featureLimit }));
  const out = {
    project: payload.project,
    units: payload.units,
    coordinateSystem: payload.coordinateSystem,
    selection: payload.selection,
    selected,
    ...(keepOthers ? { otherElements: payload.otherElements } : {}),
    readOnly: true,
    note: '以上是当前项目里已有构件的只读特征树，用于对齐坐标系、比例与命名约定。'
      + '本轮任务是生成一条新的 addSolid，不要用 editFeature / setDimensions 修改这些构件。',
  };
  const omittedFeatures = selected.reduce((sum, item) => sum + (item.omittedFeatures ?? 0), 0);
  const omittedShapes = selected.reduce(
    (sum, item) => sum + item.features.filter((feature) => feature.shapeOmitted).length, 0,
  );
  if (omittedFeatures || omittedShapes || !keepOthers || payload.otherElementsOmitted) {
    out.omitted = {
      features: omittedFeatures,
      shapes: omittedShapes,
      elements: (keepOthers ? 0 : payload.otherElements.length) + payload.otherElementsOmitted,
      note: '有内容未列出，不能据此推断其不存在；需要时用 describe 或让用户选中该构件。',
    };
  }
  return out;
}

function fit(payload, { detailed, limitTokens }) {
  const variants = [];
  // 降档顺序：先少给几个完整 shape（骨架仍全列），再少列特征，最后砍其它构件清单。
  // 这样预算紧张时角色至少知道「一共 60 个特征、都叫什么」，而不是只看到前 6 个。
  for (const featureLimit of detailed ? [Infinity, 48, 24, 12, 6] : [12, 6, 0]) {
    for (const dataLimit of detailed ? [Infinity, 24, 12, 6, 0] : [0]) {
      for (const keepOthers of [true, false]) {
        variants.push({ dataLimit, payload: project(payload, { detailed, dataLimit, featureLimit, keepOthers }) });
      }
    }
  }
  // 从最详细的一档开始挑第一个能装下的；实在都超预算就用最后一档并标注
  for (const item of variants) {
    const text = JSON.stringify(item.payload);
    const tokens = estimateTokens(text);
    if (tokens <= limitTokens) return { text, tokens, variant: item.payload, dataLimit: item.dataLimit };
  }
  const last = variants.at(-1);
  return {
    text: JSON.stringify(last.payload),
    tokens: estimateTokens(last.payload),
    variant: last.payload,
    dataLimit: last.dataLimit,
    overBudget: true,
  };
}

/**
 * @param {object} args
 * @param {object} args.document 原始项目文档（含未裁剪的 primitive.features）
 * @param {object} args.context buildProjectContext 的结果（主要用 selected 的 id）
 * @param {number} [args.detailedTokens] 规划角色的预算
 * @param {number} [args.briefTokens] 其余角色的预算
 */
export function buildRoleContext({ document, context, detailedTokens = DETAILED_TOKENS, briefTokens = BRIEF_TOKENS }) {
  if (!document || !Array.isArray(document.elements)) {
    const stats = { available: false, selectedElements: 0, selectedFeatures: 0, detailedTokens: 0, briefTokens: 0, overBudget: false };
    return { detailed: '', brief: '', stats };
  }
  const { elements, source, ids } = pickSolidElements(document, context);
  const all = document.elements;
  const otherElements = all
    .filter((element) => !ids.includes(element?.id))
    .slice(0, 60)
    .map((element) => ({ id: element.id, name: element.name, category: element.category }));
  const payload = {
    project: document.name ?? context?.project ?? '',
    units: 'meter',
    coordinateSystem: 'Z-up',
    selection: {
      source,
      ids,
      note: source === 'selected' ? '用户在视图里选中的构件' : '没有选中构件，退回第一个造型构件作参考',
    },
    elements,
    otherElements,
    otherElementsOmitted: Math.max(0, all.length - ids.length - otherElements.length),
  };
  const detailed = fit(payload, { detailed: true, limitTokens: detailedTokens });
  const brief = fit(payload, { detailed: false, limitTokens: briefTokens });
  const totalFeatures = elements.reduce((sum, element) => sum + (element.primitive?.features?.length ?? 0), 0);
  return {
    detailed: `【当前项目上下文（只读，结构化）】\n${detailed.text}`,
    brief: `【当前项目上下文（只读，结构化）】\n${brief.text}`,
    stats: {
      available: true,
      source,
      selectedElements: elements.length,
      selectedFeatures: totalFeatures,
      detailedTokens: detailed.tokens,
      briefTokens: brief.tokens,
      detailedFeatureLimit: detailed.variant.selected[0]?.features.length ?? 0,
      detailedShapeLimit: Number.isFinite(detailed.dataLimit) ? detailed.dataLimit : totalFeatures,
      briefFeatureLimit: brief.variant.selected[0]?.features.length ?? 0,
      overBudget: Boolean(detailed.overBudget || brief.overBudget),
    },
  };
}
