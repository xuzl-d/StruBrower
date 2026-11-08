import crypto from 'node:crypto';
import { OpsError } from './errors.js';
import { describeFeature, normalizeFeature, normalizeFeatures, patchFeature } from './solid.js';
import { buildModelFeatures, libraryModelIds, modelDocument, modelHasParams } from '../../shared/library.js';
import { buildParametricFeatures, coerceParams } from '../../shared/parametric.js';
import { rebaseConstraints } from '../../shared/constraints.js';
import { applyConstraintPatch } from './constraints.js';
export { OpsError };

/**
 * AI 建模指令（BIM ops）：LLM 只能改这些结构化指令，服务端逐条校验后再落库。
 * 好处：可校验、可预览、可撤销、可与协作 rev 合并；模型无法直接写坏文档。
 *
 * 造型（任意实体）也走同一套通道：addSolid 直接携带特征树 JSON，服务端校验后原样存入文档，
 * 前端内核按特征树实时求值——没有「生成代码 → 再编译」这一步。
 */
const OPS = new Set([
  'addLevel',
  'addGrid',
  'addWall',
  'addColumn',
  'addSlab',
  'addSolid',
  'addDecal',
  'setParams',
  'setConstraints',
  'addFeature',
  'editFeature',
  'deleteFeature',
  'updateElement',
  'setTypeProperty',
  'deleteElement',
]);

const CATEGORY_LABELS = { wall: '墙', column: '柱', slab: '楼板', mesh: '造型' };
const MAX_OPS = 60;
const MAX_SOLID_FEATURES = 48;

const newId = (prefix) => `${prefix}-${crypto.randomUUID()}`;

function num(value, label) {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new OpsError(`${label} 必须是数字`);
  if (Math.abs(value) > 20000) throw new OpsError(`${label} 超出允许范围（±20000）`);
  return value;
}

function point(value, label) {
  if (!Array.isArray(value) || value.length !== 2) throw new OpsError(`${label} 必须是 [x, y]`);
  return [num(value[0], `${label}[0]`), num(value[1], `${label}[1]`)];
}

/** 平面位置：模型常顺手写成 [x, y, z]，z 当作相对标高的抬升 */
function placement(value, label) {
  if (!Array.isArray(value) || (value.length !== 2 && value.length !== 3)) {
    throw new OpsError(`${label} 必须是 [x, y] 或 [x, y, z]`);
  }
  return {
    xy: [num(value[0], `${label}[0]`), num(value[1], `${label}[1]`)],
    z: value.length === 3 ? num(value[2], `${label}[2]`) : undefined,
  };
}

function resolveLevel(document, ref) {
  if (!ref) return document.levels[0];
  const found = document.levels.find(
    (level) => level.id === ref || level.name.toLowerCase() === String(ref).toLowerCase(),
  );
  if (!found) throw new OpsError(`找不到标高「${ref}」`);
  return found;
}

function resolveElement(document, target) {
  if (typeof target !== 'string' || !target.trim()) throw new OpsError('target 必须提供构件 id 或名称');
  const byId = document.elements.find((element) => element.id === target);
  if (byId) return byId;
  const matches = document.elements.filter(
    (element) => element.name.toLowerCase() === target.toLowerCase(),
  );
  if (matches.length === 1) return matches[0];
  if (!matches.length) throw new OpsError(`找不到构件「${target}」`);
  throw new OpsError(`构件名称「${target}」匹配到 ${matches.length} 个，请改用 id`);
}

function nextElementName(document, category) {
  const prefix = CATEGORY_LABELS[category] ?? '构件';
  const used = new Set(document.elements.map((element) => element.name));
  for (let index = 1; index < 10000; index += 1) {
    const candidate = `${prefix} ${index}`;
    if (!used.has(candidate)) return candidate;
  }
  return `${prefix} ${Date.now()}`;
}

function defaultMaterialId(document) {
  return document.materials[0]?.id ?? '';
}

function createType(document, category, overrides = {}) {
  if (category === 'wall') {
    const thickness = overrides.thickness ?? 0.2;
    return {
      id: newId('type'),
      category,
      name: overrides.name ?? `墙 ${Math.round(thickness * 1000)}mm`,
      thickness,
      materialId: defaultMaterialId(document),
    };
  }
  if (category === 'column') {
    const width = overrides.width ?? 0.4;
    const depth = overrides.depth ?? 0.4;
    return {
      id: newId('type'),
      category,
      name: overrides.name ?? `柱 ${Math.round(width * 1000)}×${Math.round(depth * 1000)}`,
      width,
      depth,
      materialId: defaultMaterialId(document),
    };
  }
  const thickness = overrides.thickness ?? 0.15;
  return {
    id: newId('type'),
    category,
    name: overrides.name ?? `楼板 ${Math.round(thickness * 1000)}mm`,
    thickness,
    materialId: defaultMaterialId(document),
  };
}

/** 解析类型：按名称/id → 同类别默认 → 按尺寸参数复用或新建。类型会写入 next.types。 */
function resolveType(next, ref, category, overrides = {}) {
  let type = null;
  if (ref) {
    type = next.types.find(
      (item) => item.id === ref || item.name.toLowerCase() === String(ref).toLowerCase(),
    );
    if (type && type.category !== category) {
      throw new OpsError(`类型「${ref}」不是${CATEGORY_LABELS[category]}`);
    }
  }
  if (!type) type = next.types.find((item) => item.category === category);

  const hasOverride = category === 'wall' || category === 'slab'
    ? overrides.thickness !== undefined
    : overrides.width !== undefined || overrides.depth !== undefined;

  if (type && hasOverride) {
    const sameSize = next.types.find((item) => {
      if (item.category !== category) return false;
      if (category === 'wall' || category === 'slab') {
        return Math.abs((item.thickness ?? 0) - (overrides.thickness ?? 0)) < 1e-6;
      }
      return Math.abs((item.width ?? 0) - (overrides.width ?? 0)) < 1e-6
        && Math.abs((item.depth ?? 0) - (overrides.depth ?? 0)) < 1e-6;
    });
    if (sameSize) return sameSize;
    const created = createType(next, category, overrides);
    next.types.push(created);
    return created;
  }

  if (!type) {
    type = createType(next, category, overrides);
    next.types.push(type);
  }
  return type;
}

function nextLevelAbove(document, level) {
  return document.levels
    .filter((item) => item.elevation > level.elevation + 1e-6)
    .sort((a, b) => a.elevation - b.elevation)[0];
}

function rectPoints(rect) {
  if (!rect || typeof rect !== 'object') throw new OpsError('缺少 rect');
  const x = num(rect.x ?? 0, 'rect.x');
  const y = num(rect.y ?? 0, 'rect.y');
  const width = num(rect.width, 'rect.width');
  const depth = num(rect.depth, 'rect.depth');
  if (width < 0.2 || depth < 0.2) throw new OpsError('楼板尺寸至少 0.2 m');
  return [
    [x, y],
    [x + width, y],
    [x + width, y + depth],
    [x, y + depth],
  ];
}

/** 模型偶尔会换个键名或用漏判别字段：先认别名，再按字段签名反推，推不出来才报错 */
const OP_NAME_KEYS = ['op', 'action', 'type', 'kind', 'command'];

function opNameOf(op) {
  for (const key of OP_NAME_KEYS) {
    const value = op[key];
    if (typeof value === 'string' && OPS.has(value)) return value;
  }
  return null;
}

function inferOp(op) {
  const has = (key) => op[key] !== undefined;
  if (Array.isArray(op.features)) return 'addSolid';
  if (has('start') && has('end')) return 'addWall';
  if (has('position') && (has('width') || has('depth'))) return 'addColumn';
  if (has('points') || has('rect')) return 'addSlab';
  if (has('elevation')) return 'addLevel';
  return null;
}

function validateOp(op) {
  if (!op || typeof op !== 'object') throw new OpsError('指令必须是对象');
  if (typeof op.op !== 'string') {
    const name = opNameOf(op) ?? inferOp(op);
    if (!name) throw new OpsError(`指令缺少 op 字段，可用：${[...OPS].join(', ')}`);
    op.op = name;
  }
  if (!OPS.has(op.op)) {
    throw new OpsError(`不支持的指令「${op.op}」，可用：${[...OPS].join(', ')}`);
  }
}

/* ---------- 造型实体：定位与特征寻址 ---------- */

/** 取造型实体；非特征树实体（导入网格 / 普通基本体）给出可操作的提示 */
function resolveSolid(document, target) {
  const element = resolveElement(document, target);
  if (element.category !== 'mesh' || element.primitive?.kind !== 'solid') {
    throw new OpsError(
      `「${element.name}」不是造型实体（${element.category === 'mesh' ? element.primitive?.kind ?? '导入网格' : CATEGORY_LABELS[element.category] ?? element.category}）：只有 addSolid 创建的特征树实体才能增删改特征`,
    );
  }
  return element;
}

/**
 * 参数化构件的特征由生成器算出来，直接增删改特征会被下一次重建覆盖 —— 与其静默丢失，不如明确拒绝。
 * （这和 SolidWorks 里「改参数化零件的草图会重建」是同一件事，只是我们把选择权显式交给用户。）
 */
function assertStaticSolid(element, action) {
  if (element.parametric) {
    throw new OpsError(
      `「${element.name}」是参数化构件（模板 ${element.parametric.template}）：${action}请改用 setParams 调整参数；`
      + '要自由编辑特征，先在造型对话框里点「断开参数化」',
    );
  }
}

/** 特征寻址：1 起始序号 / id / 唯一名称 */
function resolveFeatureIndex(features, ref) {
  const text = typeof ref === 'number' ? String(ref) : String(ref ?? '').trim();
  if (!text) throw new OpsError('请用 feature 指定特征：序号（从 1 开始）、id 或名称');
  if (/^\d+$/.test(text)) {
    const index = Number(text);
    if (index < 1 || index > features.length) {
      throw new OpsError(`特征序号 ${index} 超出范围（1 ~ ${features.length}）`);
    }
    return index - 1;
  }
  const byId = features.findIndex((feature) => feature.id === text);
  if (byId >= 0) return byId;
  const matches = features
    .map((feature, index) => ({ feature, index }))
    .filter((item) => (item.feature.label ?? '') === text);
  if (matches.length === 1) return matches[0].index;
  if (matches.length > 1) {
    throw new OpsError(`特征名称「${text}」匹配到 ${matches.length} 个，请改用序号或 id`);
  }
  const labels = features.map((feature, index) => `${index + 1}.${feature.label ?? feature.shape?.shape}`).join('、');
  throw new OpsError(`找不到特征「${text}」，当前特征：${labels}`);
}

function countFeatures(features) {
  return (Array.isArray(features) ? features : []).reduce(
    (total, feature) => total + 1 + (feature?.shape?.shape === 'group' ? countFeatures(feature.shape.features) : 0),
    0,
  );
}

function hexColor(value, label) {
  if (value === undefined || value === null) return undefined;
  const text = String(value).trim();
  if (!/^#[0-9a-f]{6}$/i.test(text)) throw new OpsError(`${label} 必须是 #rrggbb 形式的颜色`);
  return text.toLowerCase();
}

/** 角度：AI 用「度」，文档存弧度 */
function degrees(value, label) {
  return (num(value, label) * Math.PI) / 180;
}

/**
 * 在当前文档上顺序应用 ops，返回新文档与人类可读的执行摘要。
 * 抛出 OpsError 时调用方应返回 400，不写库。
 */
export function applyOps(document, ops) {
  if (!Array.isArray(ops) || !ops.length) throw new OpsError('没有可执行的指令');
  if (ops.length > MAX_OPS) throw new OpsError(`单次最多 ${MAX_OPS} 条指令`);

  const next = {
    ...document,
    levels: [...document.levels],
    grids: [...document.grids],
    types: [...document.types],
    materials: [...document.materials],
    elements: [...document.elements],
  };
  const applied = [];

  for (const op of ops) {
    validateOp(op);
    switch (op.op) {
      case 'addLevel': {
        const name = String(op.name ?? '').trim();
        if (!name) throw new OpsError('标高名称不能为空');
        if (next.levels.some((level) => level.name.toLowerCase() === name.toLowerCase())) {
          throw new OpsError(`标高「${name}」已存在`);
        }
        const elevation = num(op.elevation, 'elevation');
        next.levels.push({ id: newId('level'), name, elevation });
        next.levels.sort((a, b) => a.elevation - b.elevation);
        applied.push(`新增标高 ${name}（${elevation.toFixed(2)} m）`);
        break;
      }

      case 'addGrid': {
        const start = point(op.start, 'start');
        const end = point(op.end, 'end');
        if (Math.hypot(end[0] - start[0], end[1] - start[1]) < 0.2) throw new OpsError('轴网太短');
        const name = String(op.name ?? next.grids.length + 1);
        next.grids.push({ id: newId('grid'), name, start, end });
        applied.push(`新增轴网 ${name}`);
        break;
      }

      case 'addWall': {
        const level = resolveLevel(next, op.level);
        const start = point(op.start, 'start');
        const end = point(op.end, 'end');
        const length = Math.hypot(end[0] - start[0], end[1] - start[1]);
        if (length < 0.1) throw new OpsError('墙长度至少 0.1 m');
        const type = resolveType(next, op.type, 'wall', { thickness: op.thickness });
        const above = op.topLevel ? resolveLevel(next, op.topLevel) : nextLevelAbove(next, level);
        const height = typeof op.height === 'number' ? num(op.height, 'height') : 3;
        next.elements.push({
          id: newId('wall'),
          name: op.name ? String(op.name) : nextElementName(next, 'wall'),
          category: 'wall',
          typeId: type.id,
          levelId: level.id,
          visible: true,
          start,
          end,
          baseOffset: typeof op.baseOffset === 'number' ? num(op.baseOffset, 'baseOffset') : 0,
          topLevelId: above ? above.id : level.id,
          topOffset: above
            ? (typeof op.topOffset === 'number' ? num(op.topOffset, 'topOffset') : 0)
            : height,
        });
        applied.push(`新增墙（${length.toFixed(2)} m，${type.name}）`);
        break;
      }

      case 'addColumn': {
        const level = resolveLevel(next, op.level);
        const position = point(op.position, 'position');
        const type = resolveType(next, op.type, 'column', { width: op.width, depth: op.depth });
        const above = op.topLevel ? resolveLevel(next, op.topLevel) : nextLevelAbove(next, level);
        const height = typeof op.height === 'number' ? num(op.height, 'height') : 3;
        next.elements.push({
          id: newId('column'),
          name: op.name ? String(op.name) : nextElementName(next, 'column'),
          category: 'column',
          typeId: type.id,
          levelId: level.id,
          visible: true,
          position,
          rotation: typeof op.rotation === 'number' ? num(op.rotation, 'rotation') : 0,
          baseOffset: typeof op.baseOffset === 'number' ? num(op.baseOffset, 'baseOffset') : 0,
          topLevelId: above ? above.id : level.id,
          topOffset: above
            ? (typeof op.topOffset === 'number' ? num(op.topOffset, 'topOffset') : 0)
            : height,
        });
        applied.push(`新增柱（${type.name}）`);
        break;
      }

      case 'addSlab': {
        const level = resolveLevel(next, op.level);
        const points = Array.isArray(op.points) ? op.points.map((item, index) => point(item, `points[${index}]`)) : rectPoints(op.rect);
        if (points.length < 3) throw new OpsError('楼板至少需要 3 个轮廓点');
        const type = resolveType(next, op.type, 'slab', { thickness: op.thickness });
        next.elements.push({
          id: newId('slab'),
          name: op.name ? String(op.name) : nextElementName(next, 'slab'),
          category: 'slab',
          typeId: type.id,
          levelId: level.id,
          visible: true,
          points,
          baseOffset: typeof op.baseOffset === 'number' ? num(op.baseOffset, 'baseOffset') : 0,
        });
        applied.push(`新增楼板（${points.length} 个轮廓点，${type.name}）`);
        break;
      }

      /* ---------- 任意造型：特征树直接进文档，渲染时求值 ---------- */

      case 'addSolid': {
        const level = resolveLevel(next, op.level);
        /**
         * 两种写法：
         *   { library: 'pavilion-hex' }        → 从模型库取一份**特征树文档**（shared/models/*.json）；
         *       带参数表 + 绑定表的模型（如 bracket）可再传 params，整组尺寸联动重建。
         *   { features: [...] }                 → 自己拼的特征树：写完就固定，可后续 editFeature。
         * `template` 是 `library` 的旧名，保留兼容；参数化构件仍会落一份特征树快照，
         * 导出 / 明细 / 只读展示读的都是同一份结构。
         */
        const libraryId = String(op.library ?? op.template ?? '').trim();
        let parametric;
        let features;
        if (libraryId) {
          const doc = modelDocument(libraryId);
          if (!doc) {
            throw new OpsError(`未知模型「${libraryId}」，可用：${libraryModelIds().join(' / ')}（也可以直接给 features 自拼特征树）`);
          }
          const params = op.params ?? undefined;
          if (params && !modelHasParams(libraryId)) {
            throw new OpsError(`「${doc.name}」是静态特征树，没有可驱动参数；要改尺寸请用 editFeature 按特征改`);
          }
          if (modelHasParams(libraryId)) {
            const { params: values, issues } = coerceParams(libraryId, params);
            if (issues.length) throw new OpsError(issues[0]);
            parametric = { template: libraryId, params: values };
          }
          // 快照也走同一套校验：模型库的特征树与自由建模时必须同构
          features = normalizeFeatures(buildModelFeatures(libraryId, parametric?.params), 'features');
        } else {
          features = normalizeFeatures(op.features, 'features');
        }
        if (features[0].mode === 'cut') {
          throw new OpsError('第一个特征必须是 add：实体要先有材料，才能切除');
        }
        const position = op.position === undefined ? { xy: [0, 0], z: undefined } : placement(op.position, 'position');
        const baseOffset = op.baseOffset !== undefined ? num(op.baseOffset, 'baseOffset') : position.z ?? 0;
        const element = {
          id: newId('solid'),
          name: op.name ? String(op.name).slice(0, 80) : nextElementName(next, 'mesh'),
          category: 'mesh',
          typeId: '',
          levelId: level.id,
          visible: true,
          positions: [],
          indices: [],
          color: hexColor(op.color, 'color') ?? '#8fb9e8',
          source: parametric ? '造型（模型库·参数化）' : '造型（特征树）',
          offset: [position.xy[0], position.xy[1], baseOffset],
          primitive: { kind: 'solid', features },
          ...(parametric ? { parametric } : {}),
        };
        if (op.rotation !== undefined) element.rotation = degrees(op.rotation, 'rotation');
        if (op.scale !== undefined) {
          const scale = num(op.scale, 'scale');
          if (scale < 0.01 || scale > 100) throw new OpsError('scale 允许范围 0.01 ~ 100');
          element.scale = scale;
        }
        next.elements.push(element);
        applied.push(parametric
          ? `新增参数化造型「${element.name}」（模型 ${parametric.template}，参数 ${Object.entries(parametric.params).map(([key, value]) => `${key}=${value}`).join(' ')}）`
          : `新增造型「${element.name}」（${countFeatures(features)} 个特征${libraryId ? `，模型库 ${libraryId}` : ''}）`);
        break;
      }

      /* ---------- 参数化：改模板参数，整组尺寸联动重建 ---------- */

      case 'setParams': {
        const element = resolveSolid(next, op.target);
        if (!element.parametric) {
          const doc = modelDocument(op.library ?? op.template);
          throw new OpsError(
            doc && !modelHasParams(doc.id)
              ? `「${element.name}」来自模型库「${doc.name}」，是静态特征树：要改尺寸请用 editFeature 按特征改`
              : `「${element.name}」不是参数化构件：直接用 editFeature 改特征，或 addSolid 时用 library 指定带参数的模型`,
          );
        }
        if (!op.params || typeof op.params !== 'object' || !Object.keys(op.params).length) {
          throw new OpsError('setParams 需要 params，例如 { "height": 3.0 }');
        }
        const index = next.elements.findIndex((item) => item.id === element.id);
        const { params, issues } = coerceParams(element.parametric.template, { ...element.parametric.params, ...op.params });
        if (issues.length) throw new OpsError(issues[0]);
        const parametric = { template: element.parametric.template, params };
        const features = normalizeFeatures(buildParametricFeatures(parametric), 'features');
        next.elements[index] = { ...element, parametric, primitive: { kind: 'solid', features } };
        applied.push(`调整「${element.name}」参数：${Object.entries(op.params).map(([key, value]) => `${key}=${value}`).join(' ')}`);
        break;
      }

      /* ---------- 约束：给任意构件起名 + 写驱动式 / 校验式 ---------- */

      case 'setConstraints': {
        const element = resolveSolid(next, op.target);
        const index = next.elements.findIndex((item) => item.id === element.id);
        const { element: constrained, notes } = applyConstraintPatch(next, element, op);
        next.elements[index] = constrained;
        applied.push(notes.length
          ? `设置「${element.name}」约束：${notes.join('、')}`
          : `设置「${element.name}」约束（空）`);
        break;
      }

      /* ---------- 贴花：涂装 / 文字 / logo，独立构件，贴在一个面上 ---------- */

      case 'addDecal': {
        const level = resolveLevel(next, op.level);
        const width = num(op.width, 'width');
        const height = num(op.height, 'height');
        if (width < 0.05 || width > 120) throw new OpsError('width 允许范围 0.05 ~ 120 米');
        if (height < 0.05 || height > 60) throw new OpsError('height 允许范围 0.05 ~ 60 米');
        const text = op.text === undefined || op.text === null ? undefined : String(op.text).trim().slice(0, 120);
        const image = typeof op.image === 'string' ? op.image : undefined;
        if (!text && !image) throw new OpsError('贴花需要 text（文字）或 image（data URL 图片）');
        if (image && !/^data:image\/(png|jpe?g|webp|svg\+xml);base64,/i.test(image)) {
          throw new OpsError('image 必须是 data:image/png;base64,… 这类内联图片');
        }
        if (image && image.length > 400_000) throw new OpsError('image 太大（上限约 300 KB），请缩小图片');
        const normal = op.normal === undefined ? 'y' : String(op.normal).toLowerCase();
        if (!['x', 'y', 'z', '-x', '-y', '-z'].includes(normal)) {
          throw new OpsError('normal 只能是 x / y / z / -x / -y / -z（贴图朝向）');
        }
        const position = op.position === undefined ? { xy: [0, 0], z: undefined } : placement(op.position, 'position');
        const element = {
          id: newId('decal'),
          name: op.name ? String(op.name).slice(0, 80) : nextElementName(next, 'mesh'),
          category: 'mesh',
          typeId: '',
          levelId: level.id,
          visible: true,
          positions: [],
          indices: [],
          color: hexColor(op.color, 'color') ?? '#ffffff',
          source: '贴花',
          offset: [position.xy[0], position.xy[1], position.z ?? 0],
          primitive: {
            kind: 'decal',
            width,
            height,
            normal,
            ...(text ? { text } : {}),
            ...(image ? { image } : {}),
            color: hexColor(op.color, 'color') ?? '#ffffff',
            ...(op.background ? { background: hexColor(op.background, 'background') } : {}),
            ...(op.font ? { font: String(op.font).slice(0, 80) } : {}),
          },
        };
        if (op.rotation !== undefined) element.rotation = degrees(op.rotation, 'rotation');
        next.elements.push(element);
        applied.push(`新增贴花「${element.name}」（${text ? `文字 ${text.slice(0, 12)}` : '图片'}）`);
        break;
      }

      case 'addFeature': {
        const element = resolveSolid(next, op.target);
        assertStaticSolid(element, '加特征');
        const index = next.elements.findIndex((item) => item.id === element.id);
        const features = [...element.primitive.features];
        const feature = normalizeFeature(op.feature, 'feature');
        if (countFeatures(features) >= MAX_SOLID_FEATURES) {
          throw new OpsError(`特征数量已达上限 ${MAX_SOLID_FEATURES}，请先删除不用的特征`);
        }
        let at = features.length;
        if (op.index !== undefined) {
          // 插入位置用 1 起始序号：1 表示插到最前面，特征数 + 1 表示追加到末尾
          const raw = Math.round(Number(op.index));
          if (!Number.isFinite(raw) || raw < 1 || raw > features.length + 1) {
            throw new OpsError(`插入位置 ${op.index} 超出范围（1 ~ ${features.length + 1}）`);
          }
          at = raw - 1;
        }
        features.splice(at, 0, feature);
        // 插入特征会把后面所有特征的序号顶后一位：约束里的 f3.height 必须跟着搬家，
        // 否则「改柱高」会悄悄改成另一根柱子（这类错最贵，它不报错只是结果不对）。
        const remap = {};
        for (let old = 1; old <= features.length - 1; old += 1) remap[old] = old <= at ? old : old + 1;
        const inserted = rebaseConstraints(
          { ...element, primitive: { ...element.primitive, features } },
          remap,
        );
        next.elements[index] = { ...inserted, primitive: { ...element.primitive, features } };
        applied.push(`给「${element.name}」加特征：${describeFeature(feature)}`);
        break;
      }

      case 'editFeature': {
        const element = resolveSolid(next, op.target);
        assertStaticSolid(element, '改特征');
        const index = next.elements.findIndex((item) => item.id === element.id);
        const features = [...element.primitive.features];
        const target = resolveFeatureIndex(features, op.feature);
        const patch = op.patch && typeof op.patch === 'object'
          ? op.patch
          : Object.fromEntries(Object.entries(op).filter(
            ([key]) => !['op', 'target', 'feature', 'patch'].includes(key),
          ));
        if (!Object.keys(patch).length) throw new OpsError('editFeature 没有任何要修改的字段');
        features[target] = patchFeature(features[target], patch, `特征 ${target + 1}`);
        next.elements[index] = { ...element, primitive: { ...element.primitive, features } };
        applied.push(`修改「${element.name}」的特征 ${target + 1}（${features[target].label ?? features[target].shape?.shape}）`);
        break;
      }

      case 'deleteFeature': {
        const element = resolveSolid(next, op.target);
        assertStaticSolid(element, '删特征');
        const index = next.elements.findIndex((item) => item.id === element.id);
        const features = [...element.primitive.features];
        const target = resolveFeatureIndex(features, op.feature);
        if (features.length === 1) {
          throw new OpsError('至少保留一个特征；要整体删除请用 deleteElement');
        }
        if (target === 0) {
          throw new OpsError('不能删除基础特征（第 1 个）：后面的布尔运算都以它为母体');
        }
        const [removed] = features.splice(target, 1);
        // 被删特征上的约束/公式一并清掉；排在它后面的特征序号前移一位
        const remap = {};
        for (let old = 1; old <= features.length + 1; old += 1) {
          if (old === target + 1) remap[old] = undefined;
          else remap[old] = old <= target ? old : old - 1;
        }
        const rebased = rebaseConstraints(
          { ...element, primitive: { ...element.primitive, features } },
          remap,
        );
        next.elements[index] = { ...rebased, primitive: { ...element.primitive, features } };
        applied.push(`删除「${element.name}」的特征：${describeFeature(removed)}`);
        break;
      }

      case 'updateElement': {
        const element = resolveElement(next, op.target);
        const index = next.elements.findIndex((item) => item.id === element.id);
        const patch = {};
        if (op.name !== undefined) patch.name = String(op.name);
        if (op.start !== undefined) patch.start = point(op.start, 'start');
        if (op.end !== undefined) patch.end = point(op.end, 'end');
        if (op.baseOffset !== undefined) patch.baseOffset = num(op.baseOffset, 'baseOffset');
        if (op.topOffset !== undefined) patch.topOffset = num(op.topOffset, 'topOffset');
        if (op.level !== undefined) patch.levelId = resolveLevel(next, op.level).id;
        if (op.topLevel !== undefined) patch.topLevelId = resolveLevel(next, op.topLevel).id;
        if (op.visible !== undefined) patch.visible = Boolean(op.visible);
        // 造型/导入实体：整体平移（position 写回 offset 的 x/y）、绕 Z 旋转、缩放、颜色
        if (element.category === 'mesh') {
          if (op.position !== undefined) {
            const where = placement(op.position, 'position');
            const z = where.z ?? (Array.isArray(element.offset) ? element.offset[2] ?? 0 : 0);
            patch.offset = [where.xy[0], where.xy[1], z];
          }
          if (op.rotation !== undefined) patch.rotation = degrees(op.rotation, 'rotation');
          if (op.scale !== undefined) {
            const scale = num(op.scale, 'scale');
            if (scale < 0.01 || scale > 100) throw new OpsError('scale 允许范围 0.01 ~ 100');
            patch.scale = scale;
          }
          if (op.color !== undefined) patch.color = hexColor(op.color, 'color');
        }
        if (!Object.keys(patch).length) throw new OpsError('updateElement 没有任何可更新字段');
        next.elements[index] = { ...element, ...patch };
        applied.push(`修改构件 ${element.name}`);
        break;
      }

      case 'setTypeProperty': {
        const type = next.types.find(
          (item) => item.id === op.type || item.name.toLowerCase() === String(op.type ?? '').toLowerCase(),
        );
        if (!type) throw new OpsError(`找不到类型「${op.type}」`);
        const index = next.types.findIndex((item) => item.id === type.id);
        const patch = { ...type };
        if (op.thickness !== undefined) {
          if (type.category === 'column') throw new OpsError('柱类型没有厚度参数');
          patch.thickness = num(op.thickness, 'thickness');
          if (patch.thickness <= 0.01) throw new OpsError('厚度必须大于 0.01 m');
        }
        if (op.width !== undefined) patch.width = num(op.width, 'width');
        if (op.depth !== undefined) patch.depth = num(op.depth, 'depth');
        if (op.name !== undefined) patch.name = String(op.name);
        next.types[index] = patch;
        applied.push(`修改类型 ${type.name}`);
        break;
      }

      case 'deleteElement': {
        const element = resolveElement(next, op.target);
        next.elements = next.elements.filter((item) => item.id !== element.id);
        applied.push(`删除构件 ${element.name}`);
        break;
      }

      default:
        throw new OpsError(`未实现的指令 ${op.op}`);
    }
  }

  return { document: next, applied };
}

/** 给 UI 用的简要统计：{"墙": 4, "楼板": 1} */
export function summarizeOps(ops) {
  const counts = {};
  for (const op of Array.isArray(ops) ? ops : []) {
    const label = {
      addLevel: '标高',
      addGrid: '轴网',
      addWall: '墙',
      addColumn: '柱',
      addSlab: '楼板',
      addSolid: '造型',
      addDecal: '贴花',
      setParams: '改参数',
      setConstraints: '设约束',
      addFeature: '加特征',
      editFeature: '改特征',
      deleteFeature: '删特征',
      updateElement: '修改构件',
      setTypeProperty: '修改类型',
      deleteElement: '删除构件',
    }[op?.op] ?? op?.op ?? '未知';
    counts[label] = (counts[label] ?? 0) + 1;
  }
  return counts;
}
