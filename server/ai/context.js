import { describeShape } from './solid.js';
import { listDimensions } from '../../shared/dimensions.js';

/**
 * 约束摘要：AI 要能看见「这个构件已经有哪些名字、哪些数被谁决定、哪些要求没满足」。
 * 已起名的尺寸连值一起给，模型才能判断「调柱高」是改一个数还是改一条公式。
 */
function constraintSummary(element) {
  const constraints = element.constraints ?? {};
  const formulas = Object.fromEntries(
    Object.entries(element.formulas ?? {}).filter(([, expr]) => typeof expr === 'string' && expr.trim()),
  );
  const dims = listDimensions(element);
  const values = new Map(dims.map((spec) => [spec.path, spec.value]));
  const dimensions = (constraints.dimensions ?? []).map((alias) => ({
    name: alias.name,
    path: alias.path,
    value: values.has(alias.path) ? Number(values.get(alias.path).toFixed(4)) : null,
  }));
  const checks = (constraints.checks ?? []).map((check) => ({
    expr: check.expr,
    ...(check.message ? { message: check.message } : {}),
  }));
  if (!dimensions.length && !Object.keys(formulas).length && !checks.length) return null;
  return {
    ...(dimensions.length ? { dimensions } : {}),
    ...(Object.keys(formulas).length ? { formulas } : {}),
    ...(checks.length ? { checks } : {}),
  };
}

/** 造型实体：把特征树压成模型能读懂也能寻址的摘要（序号 / id / 名称 / 形状尺寸） */
function solidSummary(element, maxFeatures = 48) {
  const features = element.primitive?.features ?? [];
  const constraint = constraintSummary(element);
  return {
    featureCount: features.length,
    ...(constraint ? { constraints: constraint } : {}),
    features: features.slice(0, maxFeatures).map((feature, index) => ({
      index: index + 1,
      id: feature.id,
      label: feature.label ?? null,
      shape: describeShape(feature.shape),
      ...(feature.shape && JSON.stringify(feature.shape).length <= 2500 ? { shapeData: feature.shape } : { shapeDataOmitted: true }),
      ...(feature.translate ? { translate: feature.translate } : {}),
      ...(feature.rotate ? { rotate: feature.rotate } : {}),
      ...(feature.scale !== undefined ? { scale: feature.scale } : {}),
      ...(feature.fillet !== undefined ? { fillet: feature.fillet } : {}),
      ...(feature.shell !== undefined ? { shell: feature.shell } : {}),
      ...(feature.offset !== undefined ? { offset: feature.offset } : {}),
      ...(feature.mode && feature.mode !== 'add' ? { mode: feature.mode } : {}),
      ...(feature.pattern ? { pattern: `${feature.pattern.type}×${feature.pattern.count}` } : {}),
      ...(feature.pattern ? { patternData: feature.pattern } : {}),
      // 材质也要进上下文：模型才能「把机身改成红色」而不重建整个实体
      ...(feature.material
        ? {
          material: feature.material.name ?? feature.material.color ?? null,
          color: feature.material.color ?? null,
        }
        : {}),
    })),
    truncated: features.length > maxFeatures,
  };
}

/** 一层里最多列多少构件：造型实体排在前面，保证 AI 正在改的东西不会被截掉 */
const MAX_ELEMENTS = 160;

/** 把项目压缩成 LLM 可读的上下文（不发送网格几何，避免超大 token）。 */
export function buildProjectContext(document, selectedIds = []) {
  const levelName = new Map(document.levels.map((level) => [level.id, level.name]));
  const typeById = new Map(document.types.map((type) => [type.id, type]));

  // 造型实体优先：AI 改的就是它们，被截断就等于瞎猜
  const ordered = [
    ...document.elements.filter((element) => element.primitive?.kind === 'solid'),
    ...document.elements.filter((element) => element.primitive?.kind !== 'solid'),
  ].slice(0, MAX_ELEMENTS);

  const elements = ordered.map((element) => {
    const base = {
      id: element.id,
      name: element.name,
      category: element.category,
      level: levelName.get(element.levelId) ?? null,
      type: typeById.get(element.typeId)?.name ?? null,
    };
    if (element.category === 'wall') return { ...base, start: element.start, end: element.end };
    if (element.category === 'column') return { ...base, position: element.position };
    if (element.category === 'slab') return { ...base, vertices: element.points?.length ?? 0 };
    // 造型实体：给出特征树摘要，AI 才能用 editFeature 精确改某个特征
    if (element.primitive?.kind === 'solid') {
      return {
        ...base,
        position: Array.isArray(element.offset) ? element.offset.slice(0, 2) : null,
        ...(Array.isArray(element.offset) && element.offset.length > 2 ? { baseOffset: element.offset[2] } : {}),
        ...(typeof element.rotation === 'number' ? { rotationDegrees: element.rotation * 180 / Math.PI } : {}),
        ...(typeof element.scale === 'number' ? { scale: element.scale } : {}),
        solid: solidSummary(element),
      };
    }
    return { ...base, primitive: element.primitive?.kind ?? null, source: element.source };
  });

  const counts = document.elements.reduce((acc, element) => {
    acc[element.category] = (acc[element.category] ?? 0) + 1;
    return acc;
  }, {});

  return {
    project: document.name,
    units: 'meter',
    coordinateSystem: 'Z-up',
    levels: document.levels.map((level) => ({ name: level.name, elevation: level.elevation })),
    types: document.types.map((type) => ({
      name: type.name,
      category: type.category,
      ...(type.thickness !== undefined ? { thickness: type.thickness } : {}),
      ...(type.width !== undefined ? { width: type.width, depth: type.depth } : {}),
    })),
    grids: document.grids.map((grid) => ({ name: grid.name, start: grid.start, end: grid.end })),
    counts,
    selected: elements.filter((element) => selectedIds.includes(element.id)),
    elements,
    truncated: document.elements.length > elements.length,
  };
}
