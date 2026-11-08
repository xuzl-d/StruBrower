/**
 * 尺寸寻址层：把「任意模型」的每个可驱动数值变成一个稳定的路径名。
 *
 * 这是整套约束能力的地基。没有它就谈不上「AI 给任意模型加约束」——
 * 模型必须先能指着一个字段说「这个数由别的东西决定」。
 *
 * 路径语法（统一、可枚举、可读写）：
 *   param.<key>              模型参数（模型文档 params 里的键，例如 bracket.width）
 *   primitive.<key>          基本体尺寸（box.width / cylinder.radius / pyramid.sides …）
 *   f<序号>.<字段>            第 n 个特征（从 1 起）的形状字段，例如 f3.height
 *   f<序号>.<字段>.<下标>      数组字段，例如 f2.translate.2、f5.sections.0.ellipse.rx
 *   f<序号>.g<序号>.<字段>     子特征组里的第 n 个特征（螺旋桨这类子装配）
 *   f<序号>.fillet | .shell | .offset   曲面修饰的标量（倒圆半径 / 壁厚 / 偏移量）
 *
 * 为什么用「特征序号 + 字段」而不是「边 / 面 / 顶点」：
 *   CAD 里通用约束真正贵的部分是**拓扑命名**（改了尺寸，第 137 号面就找不到了）。
 *   特征字段是稳定对象（特征 id 不变、字段名不变），几何只是它的求值结果。
 *   代价是约束粒度停在「特征尺寸」这一层，换不来「这两条边保持相切」——
 *   后者需要 B-rep 拓扑引用 + 数值求解，是另一个量级的工程。
 *
 * 这一份是纯 JS，服务端（校验 AI 写的约束）与前端（求值/面板）共用。
 */

import { modelParamSpecs } from './library.js';

const MAX_SIZE = 500;
const MIN_SIZE = 0.001;

/** 形状 → 可驱动字段。[字段, 中文标签, 单位, 下限, 上限, 整数?] */
const SHAPE_FIELDS = {
  box: [
    ['width', '宽', 'length', MIN_SIZE, MAX_SIZE],
    ['depth', '深', 'length', MIN_SIZE, MAX_SIZE],
    ['height', '高', 'length', MIN_SIZE, MAX_SIZE],
  ],
  roundedBox: [
    ['width', '宽', 'length', MIN_SIZE, MAX_SIZE],
    ['depth', '深', 'length', MIN_SIZE, MAX_SIZE],
    ['height', '高', 'length', MIN_SIZE, MAX_SIZE],
    ['radius', '倒圆半径', 'length', MIN_SIZE, MAX_SIZE / 2],
  ],
  cylinder: [
    ['radius', '半径', 'length', MIN_SIZE, MAX_SIZE],
    ['height', '高', 'length', MIN_SIZE, MAX_SIZE],
  ],
  tube: [
    ['radius', '外半径', 'length', MIN_SIZE, MAX_SIZE],
    ['thickness', '壁厚', 'length', MIN_SIZE, MAX_SIZE],
    ['height', '高', 'length', MIN_SIZE, MAX_SIZE],
  ],
  capsule: [
    ['radius', '半径', 'length', MIN_SIZE, MAX_SIZE],
    ['height', '总高', 'length', MIN_SIZE, MAX_SIZE],
  ],
  sphere: [['radius', '半径', 'length', MIN_SIZE, MAX_SIZE]],
  ellipsoid: [
    ['rx', 'X 半径', 'length', MIN_SIZE, MAX_SIZE],
    ['ry', 'Y 半径', 'length', MIN_SIZE, MAX_SIZE],
    ['rz', 'Z 半径', 'length', MIN_SIZE, MAX_SIZE],
  ],
  cone: [
    ['radius', '底半径', 'length', MIN_SIZE, MAX_SIZE],
    ['topRadius', '顶半径', 'length', 0, MAX_SIZE],
    ['height', '高', 'length', MIN_SIZE, MAX_SIZE],
  ],
  torus: [
    ['radius', '环半径', 'length', MIN_SIZE, MAX_SIZE],
    ['tube', '管半径', 'length', MIN_SIZE, MAX_SIZE],
  ],
  prism: [
    ['height', '拉伸高', 'length', MIN_SIZE, MAX_SIZE],
    ['twist', '扭转', 'degree', -3600, 3600],
    ['taper', '顶面缩放', 'number', 0.02, 20],
  ],
  revolve: [['angle', '旋转角', 'degree', -3600, 3600]],
  sweep: [],
  hull: [],
  loft: [],
  group: [],
};

/** 所有形状共有的可选字段（缺省时不进列表：没有该修饰就没东西可驱动） */
const MODIFIER_FIELDS = [
  ['fillet', '倒圆半径', 'length', MIN_SIZE, MAX_SIZE / 2],
  ['shell', '抽壳壁厚', 'length', MIN_SIZE, MAX_SIZE / 2],
  ['offset', '曲面偏移', 'length', -MAX_SIZE / 4, MAX_SIZE / 4],
];

/** 基本体字段（非特征树模型） */
const PRIMITIVE_FIELDS = {
  box: [
    ['width', '体量宽', 'length', MIN_SIZE, MAX_SIZE],
    ['depth', '体量深', 'length', MIN_SIZE, MAX_SIZE],
    ['height', '体量高', 'length', MIN_SIZE, MAX_SIZE],
  ],
  cylinder: [
    ['radius', '体量半径', 'length', MIN_SIZE, MAX_SIZE],
    ['height', '体量高', 'length', MIN_SIZE, MAX_SIZE],
    ['segments', '分段数', 'count', 3, 128, true],
  ],
  sphere: [
    ['radius', '体量半径', 'length', MIN_SIZE, MAX_SIZE],
    ['segments', '分段数', 'count', 6, 128, true],
  ],
  extrude: [['height', '拉伸高度', 'length', MIN_SIZE, MAX_SIZE]],
  revolve: [['segments', '旋转分段', 'count', 6, 128, true]],
  pyramid: [
    ['radius', '底面半径', 'length', MIN_SIZE, MAX_SIZE],
    ['height', '体量高', 'length', MIN_SIZE, MAX_SIZE],
    ['sides', '边数', 'count', 3, 64, true],
  ],
  decal: [
    ['width', '贴花宽', 'length', 0.05, 120],
    ['height', '贴花高', 'length', 0.05, 60],
  ],
  solid: [],
};

const makeSpec = (path, label, unit, min, max, integer) => ({
  path, key: path, label, unit, min, max, ...(integer ? { integer: true } : {}),
});

/* ------------------------------ 路径读写 ------------------------------ */

/**
 * 解析路径：`f2.translate.1` → ['f2','translate','1']。
 * 纯数字段一律当数组下标，因此 sections.0.ellipse.rx 这种深层字段不用特判。
 */
export function splitPath(path) {
  return String(path ?? '').split('.').map((part) => part.trim()).filter(Boolean);
}

function readAt(target, parts) {
  let cursor = target;
  for (const part of parts) {
    if (cursor === null || cursor === undefined) return undefined;
    if (typeof cursor !== 'object') return undefined;
    cursor = cursor[part];
  }
  return cursor;
}

/** 逐层浅拷贝写回，不修改入参（文档对象要能安全地进撤销栈） */
function writeAt(target, parts, value) {
  if (!parts.length) return value;
  const [head, ...rest] = parts;
  const next = Array.isArray(target) ? [...target] : { ...(target ?? {}) };
  const index = Array.isArray(next) && /^\d+$/.test(head) ? Number(head) : head;
  next[index] = writeAt(next[index], rest, value);
  return next;
}

/* ------------------------------ 特征字段 ------------------------------ */

/** 修饰字段的标量取值：fillet 可能是数字或 { radius } */
function modifierValue(feature, field) {
  const raw = feature?.[field];
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw === 'number') return raw;
  if (typeof raw === 'object') {
    if (field === 'fillet') return raw.radius;
    if (field === 'shell') return raw.thickness;
    if (field === 'offset') return raw.distance;
  }
  return undefined;
}

/** 写修饰字段：保留对象里的其它键（segments / open） */
function withModifier(feature, field, value) {
  const raw = feature?.[field];
  const next = { ...feature };
  if (value === 0 || !Number.isFinite(value)) {
    // 0 半径 / 0 壁厚没有意义：直接去掉这个修饰，而不是留一个 0 在那儿
    delete next[field];
    return next;
  }
  if (raw && typeof raw === 'object') {
    const key = field === 'fillet' ? 'radius' : field === 'shell' ? 'thickness' : 'distance';
    next[field] = { ...raw, [key]: value };
  } else {
    next[field] = value;
  }
  return next;
}

/**
 * 枚举一棵特征树上的可驱动尺寸。
 * @param {any[]} features
 * @param {string} prefix 'f' 顶层；子特征组传 'f3.g'
 * @param {string[]} groups 累积的分组标签（用于面板归类）
 */
function walkFeatures(features, prefix, groups, out) {
  if (!Array.isArray(features)) return;
  features.forEach((feature, index) => {
    const base = `${prefix}${index + 1}`;
    const shape = feature?.shape ?? {};
    const kind = shape.shape ?? 'box';
    const name = feature?.label ? `${feature.label}` : (SHAPE_LABEL[kind] ?? kind);
    const title = prefix === 'f' ? `特征 ${index + 1}（${name}）` : `子特征 ${index + 1}（${name}）`;
    const group = [...groups, title];

    for (const [field, label, unit, min, max, integer] of SHAPE_FIELDS[kind] ?? []) {
      const value = shape[field];
      if (typeof value !== 'number') continue;
      out.push({ ...makeSpec(`${base}.${field}`, label, unit, min, max, integer), value, group, kind: 'shape' });
    }

    // 放样截面：机身 / 机翼靠它参数化，所以每个截面的椭圆 / 翼型尺寸都要能寻址
    if (kind === 'loft' && Array.isArray(shape.sections)) {
      shape.sections.forEach((section, sectionIndex) => {
        const sectionBase = `${base}.sections.${sectionIndex}`;
        const sectionGroup = [...group, `截面 ${sectionIndex + 1}`];
        if (typeof section?.z === 'number') {
          out.push({ ...makeSpec(`${sectionBase}.z`, '截面 Z', 'length', -MAX_SIZE, MAX_SIZE), value: section.z, group: sectionGroup, kind: 'section' });
        }
        for (const key of ['rx', 'ry']) {
          if (typeof section?.ellipse?.[key] === 'number') {
            out.push({ ...makeSpec(`${sectionBase}.ellipse.${key}`, key === 'rx' ? '椭圆 X 半径' : '椭圆 Y 半径', 'length', MIN_SIZE, MAX_SIZE), value: section.ellipse[key], group: sectionGroup, kind: 'section' });
          }
        }
        if (typeof section?.ellipse?.power === 'number') {
          out.push({ ...makeSpec(`${sectionBase}.ellipse.power`, '超椭圆指数', 'number', 1, 8), value: section.ellipse.power, group: sectionGroup, kind: 'section' });
        }
        if (typeof section?.airfoil?.chord === 'number') {
          out.push({ ...makeSpec(`${sectionBase}.airfoil.chord`, '弦长', 'length', MIN_SIZE, MAX_SIZE), value: section.airfoil.chord, group: sectionGroup, kind: 'section' });
        }
        if (typeof section?.airfoil?.thickness === 'number') {
          out.push({ ...makeSpec(`${sectionBase}.airfoil.thickness`, '相对厚度', 'number', 0.01, 0.5), value: section.airfoil.thickness, group: sectionGroup, kind: 'section' });
        }
      });
    }

    // 扫掠的变截面缩放 [起, 止]
    if (kind === 'sweep' && Array.isArray(shape.taper)) {
      shape.taper.forEach((value, taperIndex) => {
        if (typeof value !== 'number') return;
        out.push({ ...makeSpec(`${base}.taper.${taperIndex}`, taperIndex === 0 ? '起始缩放' : '终止缩放', 'number', 0.02, 20), value, group, kind: 'taper' });
      });
    }

    for (const [field, label, unit, min, max] of MODIFIER_FIELDS) {
      const value = modifierValue(feature, field);
      if (typeof value !== 'number') continue;
      out.push({ ...makeSpec(`${base}.${field}`, label, unit, min, max), value, group, kind: 'modifier' });
    }

    // 变换：平移是定位螺栓，几乎每个约束都会用到
    for (let axis = 0; axis < 3; axis += 1) {
      const value = feature?.translate?.[axis];
      if (typeof value !== 'number') continue;
      out.push({
        ...makeSpec(`${base}.translate.${axis}`, `平移 ${'XYZ'[axis]}`, 'length', -MAX_SIZE, MAX_SIZE),
        value, group, kind: 'translate',
      });
    }
    for (let axis = 0; axis < 3; axis += 1) {
      const value = feature?.rotate?.[axis];
      if (typeof value !== 'number') continue;
      out.push({
        ...makeSpec(`${base}.rotate.${axis}`, `转角 ${'XYZ'[axis]}`, 'degree', -3600, 3600),
        value, group, kind: 'rotate',
      });
    }
    if (typeof feature?.scale === 'number') {
      out.push({ ...makeSpec(`${base}.scale`, '缩放', 'number', 0.001, 1000), value: feature.scale, group, kind: 'scale' });
    }

    // 阵列：踏步数量与步距是最常见的一类「连锁尺寸」
    const pattern = feature?.pattern;
    if (pattern) {
      if (typeof pattern.count === 'number' && pattern.type !== 'mirror') {
        out.push({ ...makeSpec(`${base}.count`, '阵列数量', 'count', 1, 192, true), value: pattern.count, group, kind: 'pattern' });
      }
      if (typeof pattern.angle === 'number') {
        // 注意与「旋转体自身的 angle」区分：阵列的总角叫 patternAngle
        out.push({ ...makeSpec(`${base}.patternAngle`, '阵列总角', 'degree', -3600, 3600), value: pattern.angle, group, kind: 'pattern' });
      }
      for (let axis = 0; axis < 3; axis += 1) {
        const value = pattern.step?.[axis];
        if (typeof value !== 'number') continue;
        out.push({
          ...makeSpec(`${base}.step.${axis}`, `步距 ${'XYZ'[axis]}`, 'length', -MAX_SIZE, MAX_SIZE),
          value, group, kind: 'pattern',
        });
      }
    }

    if (kind === 'group') walkFeatures(shape.features, `${base}.g`, group, out);
  });
}

const SHAPE_LABEL = {
  box: '长方体', roundedBox: '圆角盒', cylinder: '圆柱', tube: '圆管', capsule: '胶囊',
  sphere: '球', ellipsoid: '椭球', cone: '圆锥', torus: '圆环', prism: '拉伸轮廓',
  revolve: '旋转体', loft: '放样', sweep: '扫掠', hull: '凸包', group: '子特征组',
};

/**
 * 列出模型上所有可驱动尺寸。
 * 参数化构件只返回 param.*：它的几何由生成器按参数重建，
 * 直接写特征字段会在下一次重建时被覆盖（和 SolidWorks 里改派生草图一个道理）。
 */
export function listDimensions(element) {
  if (!element || typeof element !== 'object') return [];
  const out = [];
  if (element.parametric && element.parametric.template) {
    const specs = templateSpecs(element.parametric.template);
    for (const spec of specs) {
      out.push({
        ...makeSpec(`param.${spec.key}`, spec.label, spec.unit, spec.min, spec.max, spec.integer),
        value: element.parametric.params?.[spec.key] ?? spec.default ?? 0,
        group: ['模板参数'], kind: 'param',
      });
    }
    return out;
  }
  const primitive = element.primitive;
  if (!primitive || typeof primitive !== 'object') return [];
  if (primitive.kind === 'solid') {
    walkFeatures(primitive.features, 'f', [], out);
    return out;
  }
  for (const [field, label, unit, min, max, integer] of PRIMITIVE_FIELDS[primitive.kind] ?? []) {
    const value = primitive[field];
    if (typeof value !== 'number') continue;
    out.push({ ...makeSpec(`primitive.${field}`, label, unit, min, max, integer), value, group: ['体量参数'], kind: 'primitive' });
  }
  return out;
}

/** 模型参数规格：直接读模型文档（shared/library.js），参数表就在 JSON 里 */
function templateSpecs(modelId) {
  return modelParamSpecs(modelId);
}

/* ------------------------------ 读 / 写 ------------------------------ */

/**
 * 字段名 → 特征对象上的真实位置。
 *
 * 文档里的尺寸是**嵌套**的（`feature.shape.height`、`feature.pattern.count`），
 * 但对外只暴露短路径（`f2.height`、`f2.count`），否则 AI 与用户每写一个公式都要背结构。
 * 这一步就是那层翻译，读写共用，避免「能读不能写」或反过来的错位。
 */
function fieldPath(field, shape) {
  if (field === 'count') return ['pattern', 'count'];
  if (field === 'step') return ['pattern', 'step'];
  if (field === 'patternAngle') return ['pattern', 'angle'];
  if (field === 'translate' || field === 'rotate' || field === 'scale') return [field];
  // 其余当形状字段（含剖面里的 z / rx / ry / power / chord / thickness）
  return shape ? ['shape', field] : [field];
}

function readFeaturePath(feature, parts) {
  if (!feature || !parts.length) return null;
  const [field, ...tail] = parts;
  if (/^g\d+$/.test(field)) {
    const nested = feature.shape?.features?.[Number(field.slice(1)) - 1];
    return readFeaturePath(nested, tail);
  }
  if (MODIFIER_FIELDS.some(([name]) => name === field)) {
    const value = modifierValue(feature, field);
    return typeof value === 'number' ? value : null;
  }
  const value = readAt(feature, [...fieldPath(field, true), ...tail]);
  return typeof value === 'number' ? value : null;
}

function writeFeaturePath(feature, parts, value) {
  if (!feature || !parts.length) return feature;
  const [field, ...tail] = parts;
  if (/^g\d+$/.test(field)) {
    const index = Number(field.slice(1)) - 1;
    const nested = feature.shape?.features?.[index];
    if (!nested) return feature;
    const nextFeatures = feature.shape.features.map((item, itemIndex) => (
      itemIndex === index ? writeFeaturePath(item, tail, value) : item
    ));
    return { ...feature, shape: { ...feature.shape, features: nextFeatures } };
  }
  if (MODIFIER_FIELDS.some(([name]) => name === field)) return withModifier(feature, field, value);
  return writeAt(feature, [...fieldPath(field, true), ...tail], value);
}

export function dimensionSpec(element, path) {
  return listDimensions(element).find((spec) => spec.path === path) ?? null;
}

export function readDimension(element, path) {
  const parts = splitPath(path);
  if (!parts.length) return null;
  const [head, ...rest] = parts;
  if (head === 'param') {
    const key = rest.join('.');
    const value = element?.parametric?.params?.[key];
    return typeof value === 'number' ? value : null;
  }
  if (head === 'primitive') {
    const value = readAt(element?.primitive, rest);
    return typeof value === 'number' ? value : null;
  }
  if (/^f\d+$/.test(head)) {
    const index = Number(head.slice(1)) - 1;
    const features = element?.primitive?.kind === 'solid' ? element.primitive.features : [];
    return readFeaturePath(features?.[index], rest);
  }
  return null;
}

/**
 * 写回尺寸，返回新 element（不改原对象）。
 * 特征字段是「纯数据」：几何在下次求值时重建，所以这里不需要通知渲染层。
 */
export function writeDimension(element, path, value) {
  const parts = splitPath(path);
  if (!parts.length) return element;
  const [head, ...rest] = parts;
  if (head === 'param') {
    const key = rest.join('.');
    if (!element?.parametric) return element;
    return {
      ...element,
      parametric: { ...element.parametric, params: { ...element.parametric.params, [key]: value } },
    };
  }
  if (head === 'primitive') {
    if (!element?.primitive) return element;
    return { ...element, primitive: writeAt(element.primitive, rest, value) };
  }
  if (/^f\d+$/.test(head)) {
    if (element?.primitive?.kind !== 'solid') return element;
    const index = Number(head.slice(1)) - 1;
    const features = element.primitive.features;
    const feature = features?.[index];
    if (!feature) return element;
    const next = writeFeaturePath(feature, rest, value);
    if (next === feature) return element;
    const nextFeatures = features.map((item, itemIndex) => (itemIndex === index ? next : item));
    return { ...element, primitive: { ...element.primitive, features: nextFeatures } };
  }
  return element;
}

/** 按规格夹紧（整数取整）；无规格时只挡非有限数 */
export function clampDimension(spec, value) {
  if (!Number.isFinite(value)) return null;
  if (!spec) return value;
  const clamped = Math.min(Math.max(value, spec.min), spec.max);
  return spec.integer ? Math.round(clamped) : clamped;
}

/**
 * 特征增删后重排路径：`f3.height` 在插入一个特征后应指向原特征（现在是第 4 个）。
 * 只重写 f 前缀的段，其余（param./primitive./别名）原样保留。
 * @param {string} path
 * @param {Record<number, number>} remap 旧序号(1 起) → 新序号(1 起)；缺失表示被删除
 */
export function remapFeaturePath(path, remap) {
  const parts = splitPath(path);
  if (!parts.length) return path;
  const match = /^f(\d+)$/.exec(parts[0]);
  if (!match) return path;
  const next = remap[Number(match[1])];
  return next === undefined ? null : [`f${next}`, ...parts.slice(1)].join('.');
}
