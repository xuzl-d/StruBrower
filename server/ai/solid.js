/**
 * 造型特征校验器（服务端权威实现）。
 *
 * 这是 AI 的「通用造型接口」的入口：模型直接返回特征树 JSON（不需要写代码、也不需要二次编译），
 * 服务端在这里把它归一化成前端内核能直接求值的 SolidFeature[]。
 * 与 src/bim/solid.ts 的 SOLID_LIMITS 保持一致；服务端只收紧不放松。
 */
import crypto from 'node:crypto';
import { resolveSolidMaterial, solidMaterialKey, solidMaterialLabel } from '../../shared/materials.js';
import { OpsError } from './errors.js';

export const SOLID_LIMITS = {
  features: 96,
  nestedFeatures: 48,
  segments: 64,
  points: 192,
  hullPoints: 64,
  // 阵列单特征实例上限。原先 64，一排 90 个舷窗得拆成 4 个特征；192 够一整排写完。
  patternCount: 192,
  sections: 24,
};

/** 单位米；单个尺寸上限 500 m，防模型把单位写错（如把 mm 当 m）后生成超大实体 */
const MAX_SIZE = 500;
const MIN_SIZE = 0.001;
const MAX_COORD = 20000;
const MAX_ANGLE = 3600;

const SHAPE_KINDS = new Set([
  'box',
  'roundedBox',
  'cylinder',
  'tube',
  'capsule',
  'sphere',
  'ellipsoid',
  'cone',
  'torus',
  'prism',
  'revolve',
  'loft',
  'sweep',
  'hull',
  'tiles',
  'group',
]);

const SHAPE_LABELS = {
  box: '长方体',
  roundedBox: '圆角盒',
  cylinder: '圆柱',
  tube: '圆管',
  capsule: '胶囊',
  sphere: '球',
  ellipsoid: '椭球',
  cone: '圆锥/圆台',
  torus: '圆环',
  prism: '拉伸轮廓',
  revolve: '旋转体',
  loft: '放样',
  sweep: '扫掠',
  hull: '凸包',
  tiles: '瓦面',
  group: '子特征组',
};

const MODES = new Set(['add', 'cut', 'intersect']);

/** 特征对象自身的键，不属于形状参数 */
const FEATURE_KEYS = new Set([
  'id',
  'label',
  'mode',
  'translate',
  'rotate',
  'scale',
  'pattern',
  'material',
  'fillet',
  'shell',
  'offset',
  'shape',
  'kind',
  'features',
  'type',
]);

const OPEN_FACES = new Set(['x+', 'x-', 'y+', 'y-', 'z+', 'z-']);

const fail = (message) => {
  throw new OpsError(message);
};

/**
 * 取出形状定义。两种写法都接受：
 * - 扁平（推荐，模型最常写）：{ shape:'box', width, depth, height, translate, ... }
 * - 嵌套（文档内部格式）：{ shape:{ shape:'box', width, depth, height }, translate, ... }
 */
function shapeSpecOf(feature, label) {
  const raw = feature.shape;
  if (typeof raw === 'string') {
    const spec = { shape: raw };
    for (const [key, value] of Object.entries(feature)) {
      if (!FEATURE_KEYS.has(key)) spec[key] = value;
    }
    if (Array.isArray(feature.features)) spec.features = feature.features;
    return spec;
  }
  if (raw && typeof raw === 'object') {
    const kind = raw.shape ?? raw.kind ?? raw.type;
    if (typeof kind === 'string') return raw;
    fail(`${label}.shape 缺少形状类型，例如 { "shape": "box", "width": 0.2, ... }`);
  }
  const kind = feature.kind ?? feature.type;
  if (typeof kind === 'string') {
    const spec = { shape: kind };
    for (const [key, value] of Object.entries(feature)) {
      if (!FEATURE_KEYS.has(key)) spec[key] = value;
    }
    if (Array.isArray(feature.features)) spec.features = feature.features;
    return spec;
  }
  return fail(`${label} 缺少 shape，例如 { "shape": "box", "width": 0.2, "depth": 0.2, "height": 0.2 }`);
}

function num(value, label, { min = -MAX_COORD, max = MAX_COORD, integer = false, hint = '' } = {}) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    fail(`${label} 必须是数字`);
  }
  if (value < min || value > max) {
    // 报错信息要能让模型自己改对：除了区间，再给一句「为什么是这个区间」
    fail(`${label} 超出允许范围（${min} ~ ${max}）${hint ? `：${hint}` : ''}`);
  }
  return integer ? Math.round(value) : value;
}

/** 尺寸：必须为正，且不超过 500 m */
function size(value, label) {
  return num(value, label, { min: MIN_SIZE, max: MAX_SIZE });
}

function optionalSize(value, label, fallback) {
  return value === undefined || value === null ? fallback : size(value, label);
}

function vec(value, label, length = 3) {
  if (!Array.isArray(value) || value.length < length) {
    fail(`${label} 必须是 [${Array.from({ length }, (_, index) => 'xyz'[index] ?? 'w').join(', ')}]`);
  }
  const result = [];
  for (let index = 0; index < length; index += 1) {
    result.push(num(value[index], `${label}[${index}]`));
  }
  return result;
}

function optionalVec(value, label, length = 3) {
  return value === undefined || value === null ? undefined : vec(value, label, length);
}

/** 平面轮廓：[[x, y], ...]，自动去掉重复点 */
function profile(value, label, { min = 3, closed = true } = {}) {
  if (!Array.isArray(value)) fail(`${label} 必须是点数组 [[x,y], ...]`);
  if (value.length < min) fail(`${label} 至少需要 ${min} 个点`);
  if (value.length > SOLID_LIMITS.points) fail(`${label} 最多 ${SOLID_LIMITS.points} 个点`);
  const points = [];
  for (let index = 0; index < value.length; index += 1) {
    const point = value[index];
    if (!Array.isArray(point) || point.length < 2) fail(`${label}[${index}] 必须是 [x, y]`);
    const next = [num(point[0], `${label}[${index}][0]`), num(point[1], `${label}[${index}][1]`)];
    const last = points[points.length - 1];
    if (last && Math.hypot(next[0] - last[0], next[1] - last[1]) < 1e-6) continue;
    points.push(next);
  }
  if (closed && points.length > 1) {
    const first = points[0];
    const last = points[points.length - 1];
    if (Math.hypot(first[0] - last[0], first[1] - last[1]) < 1e-6) points.pop();
  }
  if (points.length < min) fail(`${label} 有效点不足 ${min} 个`);
  return points;
}

function segments(value, label, fallback = 24) {
  return value === undefined || value === null
    ? fallback
    : num(value, label, { min: 6, max: SOLID_LIMITS.segments, integer: true });
}

/**
 * 特征材质：接受预设名字符串（'aluminum'）或对象 { preset?, name?, color?, roughness?, metalness?, opacity? }。
 * 预设直接用共享材质库展开成完整参数，模型不必自己编色值；对象写法覆盖预设里的同名字段。
 */
function materialSpec(value, label) {
  if (value === undefined || value === null) return undefined;
  const { material, errors } = resolveSolidMaterial(value);
  if (errors.length) fail(`${label}.material 不合法：${errors.join('；')}`);
  if (!material) return undefined;
  if (!solidMaterialKey(material)) return undefined;
  return material;
}

function normalizePattern(value, label) {
  if (!value || typeof value !== 'object') fail(`${label} 必须是对象`);
  // 镜像：一份原件 + 一份镜像件，不看 count
  if (value.type === 'mirror') {
    const axis = value.axis === undefined ? 'y' : String(value.axis).toLowerCase();
    if (!['x', 'y', 'z'].includes(axis)) fail(`${label}.axis 只能是 x / y / z`);
    const center = optionalVec(value.center, `${label}.center`, 3) ?? [0, 0, 0];
    return { type: 'mirror', axis, center };
  }
  const type = value.type === 'linear' ? 'linear' : value.type === 'circular' ? 'circular' : null;
  if (!type) fail(`${label}.type 只能是 linear / circular / mirror`);
  const count = num(value.count, `${label}.count`, { min: 1, max: SOLID_LIMITS.patternCount, integer: true });
  if (type === 'linear') {
    return { type, count, step: vec(value.step, `${label}.step`, 3) };
  }
  const axis = value.axis === undefined ? 'z' : String(value.axis).toLowerCase();
  if (!['x', 'y', 'z'].includes(axis)) fail(`${label}.axis 只能是 x / y / z`);
  const angle = value.angle === undefined ? 360 : num(value.angle, `${label}.angle`, { min: -MAX_ANGLE, max: MAX_ANGLE });
  const center = optionalVec(value.center, `${label}.center`, 3) ?? [0, 0, 0];
  return { type, count, axis, angle, center };
}

/**
 * 放样截面：手写轮廓（profile）或参数化截面（ellipse / airfoil），二选一。
 *
 * 参数化截面是为了让模型不用自己算三角函数：一个机身 22 个截面若手写轮廓要 1400 个坐标，
 * 写成 `{ z, ellipse: { rx, ry } }` 只要几十个数字，而且不会算歪。
 */
/**
 * 曲面修饰：倒圆 / 抽壳 / 偏移。三种都接受「纯数字」和「对象」两种写法
 * （`fillet: 0.02` 与 `fillet: { radius: 0.02 }` 等价），归一化后统一成对象。
 */
function filletSpec(value, label) {
  if (value === undefined || value === null) return undefined;
  const spec = typeof value === 'number' ? { radius: value } : value;
  if (!spec || typeof spec !== 'object') fail(`${label} 必须是数字或 { radius, segments? }`);
  return {
    radius: num(spec.radius, `${label}.radius`, {
      min: MIN_SIZE,
      max: MAX_SIZE / 2,
      hint: '倒圆半径（米），超出实体最短边一半时内核会自动收到 45%',
    }),
    segments: segments(spec.segments, `${label}.segments`, 24),
  };
}

function shellSpec(value, label) {
  if (value === undefined || value === null) return undefined;
  const spec = typeof value === 'number' ? { thickness: value } : value;
  if (!spec || typeof spec !== 'object') fail(`${label} 必须是数字或 { thickness, open? }`);
  const thickness = num(spec.thickness, `${label}.thickness`, {
    min: MIN_SIZE,
    max: MAX_SIZE / 2,
    hint: '壁厚（米），超出实体最短边 45% 时内核会自动收住',
  });
  const raw = spec.open;
  const result = { thickness };
  if (raw === undefined || raw === null) return result;
  const list = (Array.isArray(raw) ? raw : [raw]).map((item) => String(item).trim().toLowerCase());
  for (const face of list) {
    if (!OPEN_FACES.has(face)) fail(`${label}.open 只能是 x+ / x- / y+ / y- / z+ / z-（开口面），收到「${face}」`);
  }
  result.open = list;
  return result;
}

function offsetSpec(value, label) {
  if (value === undefined || value === null) return undefined;
  const distance = typeof value === 'number' ? value : value.distance;
  return num(distance, `${label}`, {
    min: -MAX_SIZE / 4,
    max: MAX_SIZE / 4,
    hint: '曲面偏移（米）：正数外扩、负数内收',
  });
}

function normalizeSection(section, label) {
  if (!section || typeof section !== 'object') {
    fail(`${label} 必须是 { z, profile } 或 { z, ellipse } / { z, airfoil }`);
  }
  const z = num(section.z, `${label}.z`);
  const result = { z };

  const hasProfile = Array.isArray(section.profile);
  if (hasProfile) {
    result.profile = profile(section.profile, `${label}.profile`);
  } else if (section.ellipse) {
    if (typeof section.ellipse !== 'object') fail(`${label}.ellipse 必须是 { rx, ry, power? }`);
    result.ellipse = {
      rx: size(section.ellipse.rx, `${label}.ellipse.rx`),
      ry: size(section.ellipse.ry, `${label}.ellipse.ry`),
      power: section.ellipse.power === undefined
        ? 2
        : num(section.ellipse.power, `${label}.ellipse.power`, { min: 1, max: 8, hint: '2 是正椭圆，2.2–2.6 接近机身剖面' }),
    };
  } else if (section.airfoil) {
    if (typeof section.airfoil !== 'object') fail(`${label}.airfoil 必须是 { chord, thickness, le?, camber? }`);
    result.airfoil = {
      chord: size(section.airfoil.chord, `${label}.airfoil.chord`),
      thickness: section.airfoil.thickness === undefined
        ? 0.12
        : num(section.airfoil.thickness, `${label}.airfoil.thickness`, { min: 0.01, max: 0.5, hint: '相对厚度，客机机翼 0.09–0.14' }),
      le: section.airfoil.le === undefined ? 0 : num(section.airfoil.le, `${label}.airfoil.le`),
      camber: section.airfoil.camber === undefined ? 0 : num(section.airfoil.camber, `${label}.airfoil.camber`, { min: -0.09, max: 0.09 }),
    };
  } else {
    fail(`${label} 缺少轮廓：写 profile [[x,y],…] 或 ellipse { rx, ry } 或 airfoil { chord, thickness }`);
  }

  if (section.offset !== undefined) result.offset = vec(section.offset, `${label}.offset`, 2);
  if (section.twist !== undefined) {
    result.twist = num(section.twist, `${label}.twist`, { min: -MAX_ANGLE, max: MAX_ANGLE });
  }
  if (section.points !== undefined) {
    result.points = num(section.points, `${label}.points`, { min: 6, max: SOLID_LIMITS.points, integer: true });
  }
  return result;
}

function normalizeShape(shape, label, depth, counter) {
  if (!shape || typeof shape !== 'object') fail(`${label}.shape 必须是对象，例如 { "shape": "box", ... }`);
  const kind = shape.shape ?? shape.kind;
  if (!SHAPE_KINDS.has(kind)) {
    fail(`${label}.shape 不支持「${kind}」，可用：${[...SHAPE_KINDS].join(', ')}`);
  }

  switch (kind) {
    case 'box':
      return {
        shape: 'box',
        width: size(shape.width, `${label}.width`),
        depth: size(shape.depth, `${label}.depth`),
        height: size(shape.height, `${label}.height`),
      };
    case 'roundedBox': {
      const width = size(shape.width, `${label}.width`);
      const depth = size(shape.depth, `${label}.depth`);
      const height = size(shape.height, `${label}.height`);
      // radius 是「平面轮廓上的圆角半径」，只受宽/深约束。
      // 之前按 min(width, depth, height)/2 限制，导致 5 mm 厚的顶盖只能有 2.5 mm 倒圆，
      // 20 mm 圆角的薄板被直接拒掉——这是错的（薄板的圆角本来就大于板厚）。
      const maxRadius = Math.min(width, depth) / 2;
      return {
        shape: 'roundedBox',
        width,
        depth,
        height,
        radius: num(shape.radius, `${label}.radius`, {
          min: MIN_SIZE,
          max: maxRadius,
          hint: `倒圆半径不能超过 min(width, depth)/2（当前 width ${width}、depth ${depth}），与 height 无关，薄板可以取大倒圆`,
        }),
        segments: segments(shape.segments, `${label}.segments`, 32),
      };
    }
    case 'cylinder':
      return {
        shape: 'cylinder',
        radius: size(shape.radius, `${label}.radius`),
        height: size(shape.height, `${label}.height`),
        segments: segments(shape.segments, `${label}.segments`),
      };
    case 'tube': {
      const radius = size(shape.radius, `${label}.radius`);
      return {
        shape: 'tube',
        radius,
        thickness: num(shape.thickness, `${label}.thickness`, { min: MIN_SIZE, max: radius }),
        height: size(shape.height, `${label}.height`),
        segments: segments(shape.segments, `${label}.segments`),
      };
    }
    case 'capsule':
      return {
        shape: 'capsule',
        radius: size(shape.radius, `${label}.radius`),
        height: size(shape.height, `${label}.height`),
        segments: segments(shape.segments, `${label}.segments`),
      };
    case 'sphere':
      return {
        shape: 'sphere',
        radius: size(shape.radius, `${label}.radius`),
        segments: segments(shape.segments, `${label}.segments`),
      };
    case 'ellipsoid':
      return {
        shape: 'ellipsoid',
        rx: size(shape.rx, `${label}.rx`),
        ry: size(shape.ry, `${label}.ry`),
        rz: size(shape.rz, `${label}.rz`),
        segments: segments(shape.segments, `${label}.segments`),
      };
    case 'cone':
      return {
        shape: 'cone',
        radius: size(shape.radius, `${label}.radius`),
        topRadius: shape.topRadius === undefined ? 0 : num(shape.topRadius, `${label}.topRadius`, { min: 0, max: MAX_SIZE }),
        height: size(shape.height, `${label}.height`),
        segments: segments(shape.segments, `${label}.segments`),
      };
    case 'torus':
      return {
        shape: 'torus',
        radius: size(shape.radius, `${label}.radius`),
        tube: size(shape.tube, `${label}.tube`),
        segments: segments(shape.segments, `${label}.segments`),
        tubeSegments: segments(shape.tubeSegments, `${label}.tubeSegments`, 12),
      };
    case 'prism':
      return {
        shape: 'prism',
        profile: profile(shape.profile, `${label}.profile`),
        height: size(shape.height, `${label}.height`),
        twist: shape.twist === undefined ? 0 : num(shape.twist, `${label}.twist`, { min: -MAX_ANGLE, max: MAX_ANGLE }),
        taper: shape.taper === undefined ? 1 : num(shape.taper, `${label}.taper`, { min: 0.02, max: 20 }),
      };
    case 'revolve':
      return {
        shape: 'revolve',
        // 母线是 [半径, 高度]，半径允许为 0（轴心点）
        profile: profile(shape.profile, `${label}.profile`, { min: 2 }).map((point, index) => [
          num(point[0], `${label}.profile[${index}][0]`, { min: 0, max: MAX_SIZE }),
          num(point[1], `${label}.profile[${index}][1]`),
        ]),
        segments: segments(shape.segments, `${label}.segments`, 48),
        angle: shape.angle === undefined ? 360 : num(shape.angle, `${label}.angle`, { min: -MAX_ANGLE, max: MAX_ANGLE }),
      };
    case 'loft': {
      if (!Array.isArray(shape.sections) || shape.sections.length < 2) {
        fail(`${label}.sections 至少需要 2 个截面`);
      }
      if (shape.sections.length > SOLID_LIMITS.sections) fail(`${label}.sections 最多 ${SOLID_LIMITS.sections} 个截面`);
      const sections = shape.sections.map((section, index) => normalizeSection(section, `${label}.sections[${index}]`));
      sections.sort((a, b) => a.z - b.z);
      return { shape: 'loft', sections };
    }
    case 'sweep': {
      if (!Array.isArray(shape.path) || shape.path.length < 2) fail(`${label}.path 至少需要 2 个点`);
      if (shape.path.length > SOLID_LIMITS.points) fail(`${label}.path 最多 ${SOLID_LIMITS.points} 个点`);
      const taper = Array.isArray(shape.taper) && shape.taper.length >= 2
        ? [
          num(shape.taper[0], `${label}.taper[0]`, { min: 0.02, max: 20 }),
          num(shape.taper[1], `${label}.taper[1]`, { min: 0.02, max: 20 }),
        ]
        : undefined;
      // 贴瓦面：路径由屋面曲面生成（翼角处的封檐板 / 戗脊 / 角梁必须跟瓦面同一条曲面）
      const onRoof = shape.onRoof && typeof shape.onRoof === 'object'
        ? (() => {
          const source = shape.onRoof;
          const surface = typeof source.surface === 'string' ? source.surface.trim().slice(0, 64) : '';
          if (!surface) fail(`${label}.onRoof.surface 需要给出参照的瓦面特征 id`);
          const mode = source.mode === 'ring' ? 'ring' : source.mode === 'slope' ? 'slope' : undefined;
          const range = Array.isArray(source.range) && source.range.length >= 2
            ? [
              num(source.range[0], `${label}.onRoof.range[0]`, { min: 0, max: MAX_COORD }),
              num(source.range[1], `${label}.onRoof.range[1]`, { min: 0, max: MAX_COORD }),
            ]
            : undefined;
          return {
            surface,
            ...(mode ? { mode } : {}),
            ...(source.u === undefined ? {} : { u: num(source.u, `${label}.onRoof.u`, { min: -1, max: 1 }) }),
            ...(source.s === undefined ? {} : { s: num(source.s, `${label}.onRoof.s`, { min: 0, max: MAX_COORD }) }),
            ...(range ? { range } : {}),
            ...(source.offset === undefined ? {} : { offset: num(source.offset, `${label}.onRoof.offset`, { min: -2, max: 2 }) }),
            ...(source.samples === undefined ? {} : { samples: num(source.samples, `${label}.onRoof.samples`, { min: 2, max: 240 }) }),
            ...(source.tipLift === undefined ? {} : { tipLift: num(source.tipLift, `${label}.onRoof.tipLift`, { min: 0, max: 1 }) }),
          };
        })()
        : undefined;
      return {
        shape: 'sweep',
        profile: profile(shape.profile, `${label}.profile`),
        path: shape.path.map((point, index) => vec(point, `${label}.path[${index}]`, 3)),
        closed: Boolean(shape.closed),
        ...(taper ? { taper } : {}),
        ...(onRoof ? { onRoof } : {}),
      };
    }
    case 'hull': {
      if (!Array.isArray(shape.points)) fail(`${label}.points 必须是三维点数组 [[x,y,z], ...]`);
      if (shape.points.length < 4) fail(`${label}.points 至少需要 4 个不共面的点`);
      if (shape.points.length > SOLID_LIMITS.hullPoints) fail(`${label}.points 最多 ${SOLID_LIMITS.hullPoints} 个点`);
      return {
        shape: 'hull',
        points: shape.points.map((point, index) => vec(point, `${label}.points[${index}]`, 3)),
      };
    }
    case 'tiles': {
      if (!Array.isArray(shape.rings) || shape.rings.length < 2) {
        fail(`${label}.rings 至少需要 2 站：从檐口到顶点每站给 { z, radius }`);
      }
      if (shape.rings.length > 64) fail(`${label}.rings 最多 64 站`);
      const rings = shape.rings
        .map((ring, index) => {
          if (!ring || typeof ring !== 'object') fail(`${label}.rings[${index}] 必须是 { z, radius }`);
          return {
            z: num(ring.z, `${label}.rings[${index}].z`, { min: -MAX_COORD, max: MAX_COORD }),
            radius: num(ring.radius, `${label}.rings[${index}].radius`, { min: 0.02, max: MAX_COORD }),
          };
        })
        .sort((a, b) => a.z - b.z);
      return {
        shape: 'tiles',
        rings,
        sides: shape.sides === undefined ? 0 : num(shape.sides, `${label}.sides`, { min: 0, max: 24, integer: true }),
        rows: shape.rows === undefined ? 9 : num(shape.rows, `${label}.rows`, { min: 2, max: 24, integer: true }),
        courses: shape.courses === undefined ? 12 : num(shape.courses, `${label}.courses`, { min: 2, max: 40, integer: true }),
        thickness: shape.thickness === undefined ? 0.014 : num(shape.thickness, `${label}.thickness`, { min: 0.002, max: 0.08 }),
        lift: shape.lift === undefined ? 0.012 : num(shape.lift, `${label}.lift`, { min: 0, max: 0.1 }),
        crown: shape.crown === undefined ? 0.05 : num(shape.crown, `${label}.crown`, { min: 0, max: 0.2 }),
        sag: shape.sag === undefined ? 0.012 : num(shape.sag, `${label}.sag`, { min: 0, max: 0.08 }),
        margin: shape.margin === undefined ? 0.04 : num(shape.margin, `${label}.margin`, { min: 0, max: 1 }),
        // 角部起翘（翼角）：缺省 0 = 屋面平着转一圈，和以前完全一致
        cornerLift: shape.cornerLift === undefined ? 0 : num(shape.cornerLift, `${label}.cornerLift`, { min: 0, max: MAX_COORD }),
        cornerOut: shape.cornerOut === undefined ? 0 : num(shape.cornerOut, `${label}.cornerOut`, { min: 0, max: 1 }),
        cornerSpan: shape.cornerSpan === undefined ? 0.3 : num(shape.cornerSpan, `${label}.cornerSpan`, { min: 0.02, max: 0.5 }),
        cornerDepth: shape.cornerDepth === undefined ? 0.32 : num(shape.cornerDepth, `${label}.cornerDepth`, { min: 0.02, max: 1 }),
        // 瓦下衬板（望板）：和瓦片同一个 u 分格、压在瓦底之下，所以 rows 要和参照的瓦面一致
        board: shape.board === undefined ? 0 : num(shape.board, `${label}.board`, { min: 0, max: 0.4 }),
        showTiles: shape.showTiles !== false,
      };
    }
    case 'group': {
      if (depth >= 2) fail(`${label} 子特征组最多嵌套 2 层`);
      const features = normalizeFeatures(shape.features, `${label}.features`, depth + 1, counter);
      return { shape: 'group', features };
    }
    default:
      return fail(`${label}.shape 未实现`);
  }
}

/** 归一化单个特征；counter 用于统计整棵树的总特征数 */
export function normalizeFeature(feature, label = 'feature', depth = 0, counter = { total: 0 }) {
  if (!feature || typeof feature !== 'object') fail(`${label} 必须是对象`);

  counter.total += 1;
  if (counter.total > SOLID_LIMITS.features) fail(`特征总数超过上限 ${SOLID_LIMITS.features}`);

  const name = typeof feature.label === 'string' && feature.label.trim()
    ? feature.label.trim().slice(0, 40)
    : undefined;
  const mode = feature.mode === undefined ? 'add' : String(feature.mode);
  if (!MODES.has(mode)) fail(`${label}.mode 只能是 add / cut / intersect`);

  // 嵌套写法里模型偶尔把 material 写进 shape 对象里，一并认掉（扁平写法下 shape 里不会出现 material）
  const shapeSpec = shapeSpecOf(feature, label);
  const normalize = {
    id: typeof feature.id === 'string' && feature.id ? feature.id.slice(0, 64) : `ft-${crypto.randomUUID()}`,
    mode,
    shape: normalizeShape(shapeSpec, label, depth, counter),
  };  if (name) normalize.label = name;

  const translate = optionalVec(feature.translate, `${label}.translate`, 3);
  if (translate) normalize.translate = translate;
  const rotate = optionalVec(feature.rotate, `${label}.rotate`, 3);
  if (rotate) normalize.rotate = rotate;

  if (feature.scale !== undefined) {
    if (Array.isArray(feature.scale)) {
      normalize.scale = vec(feature.scale, `${label}.scale`, 3).map((value) => num(value, `${label}.scale`, { min: -1000, max: 1000 }));
    } else {
      normalize.scale = num(feature.scale, `${label}.scale`, { min: 0.001, max: 1000 });
    }
  }
  if (feature.pattern) normalize.pattern = normalizePattern(feature.pattern, `${label}.pattern`);
  // 曲面修饰：形状 → 偏移 → 倒圆 → 抽壳 → 变换 → 阵列 → 布尔
  const offset = offsetSpec(feature.offset, `${label}.offset`);
  if (offset) normalize.offset = offset;
  const fillet = filletSpec(feature.fillet, `${label}.fillet`);
  if (fillet) normalize.fillet = fillet;
  const shell = shellSpec(feature.shell, `${label}.shell`);
  if (shell) normalize.shell = shell;
  const material = materialSpec(feature.material ?? shapeSpec.material, label);
  if (material) normalize.material = material;

  return normalize;
}

/** 归一化特征列表（一次建体的完整特征树） */
export function normalizeFeatures(features, label = 'features', depth = 0, counter = { total: 0 }) {
  if (!Array.isArray(features) || !features.length) fail(`${label} 必须是非空数组`);
  if (features.length > SOLID_LIMITS.features) fail(`${label} 最多 ${SOLID_LIMITS.features} 个特征`);
  return features.map((feature, index) => {
    const itemLabel = `${label}[${index}]${feature?.label ? `（${feature.label}）` : ''}`;
    return normalizeFeature(feature, itemLabel, depth, counter);
  });
}

/** 把补丁合并进已有特征后重新校验（editFeature 用）。补丁可写嵌套 shape，也可把尺寸字段平铺 */
export function patchFeature(feature, patch, label = 'feature') {
  if (!patch || typeof patch !== 'object') fail(`${label} 的修改必须是对象`);
  // material: null 表示删掉零件材质（回到跟随构件材质）
  const transformKeys = new Set(['label', 'mode', 'translate', 'rotate', 'scale', 'pattern', 'material', 'fillet', 'shell', 'offset']);
  const next = { ...feature };
  const shapePatch = {};

  for (const [key, value] of Object.entries(patch)) {
    if (key === 'material' && (value === null || value === undefined)) {
      delete next.material;
      continue;
    }
    if (transformKeys.has(key)) {
      next[key] = value;
      continue;
    }
    if (key === 'shape') {
      if (typeof value === 'string') {
        if (value !== feature.shape?.shape) {
          fail(`${label} 不能改形状类型（${feature.shape?.shape} → ${value}）；请新增特征或删除后重建`);
        }
        continue;
      }
      if (!value || typeof value !== 'object') fail(`${label}.shape 必须是对象或形状名`);
      Object.assign(shapePatch, value);
      continue;
    }
    if (key === 'id') continue;
    // 其余键当作形状参数（width / radius / height / profile ...），扁平写法
    shapePatch[key] = value;
  }

  if (shapePatch.shape && shapePatch.shape !== feature.shape?.shape) {
    fail(`${label} 不能改形状类型（${feature.shape?.shape} → ${shapePatch.shape}）；请新增特征或删除后重建`);
  }
  delete shapePatch.shape;

  return normalizeFeature({ ...next, shape: { ...feature.shape, ...shapePatch } }, label);
}

/** 特征树的概览文本：给 AI 上下文和「已应用」摘要用 */
export function describeFeature(feature) {
  const shape = feature?.shape ?? {};
  const name = feature?.label ? `${feature.label}` : SHAPE_LABELS[shape.shape] ?? shape.shape;
  const mode = feature?.mode === 'cut' ? '（切除）' : feature?.mode === 'intersect' ? '（相交）' : '';
  const pattern = feature?.pattern
    ? feature.pattern.type === 'linear'
      ? ` ×${feature.pattern.count} 线性`
      : feature.pattern.type === 'mirror'
        ? ` ⇋ 镜像(${feature.pattern.axis ?? 'y'})`
        : ` ×${feature.pattern.count} 圆周`
    : '';
  // 材质写进概览：模型改色时要先能看见「哪个特征现在是什么材质」
  const material = feature?.material ? ` · ${solidMaterialLabel(feature.material)}` : '';
  // 曲面修饰也写进去：改完看不见就会被「再加一遍」，白花一次请求
  const trim = (value) => (Math.abs(value) >= 0.01 ? value.toFixed(3) : value.toFixed(4));
  const filletRadius = typeof feature?.fillet === 'number' ? feature.fillet : feature?.fillet?.radius;
  const shellThickness = typeof feature?.shell === 'number' ? feature.shell : feature?.shell?.thickness;
  const offsetDistance = typeof feature?.offset === 'number' ? feature.offset : feature?.offset?.distance;
  const modifiers = [
    offsetDistance ? ` 偏移${offsetDistance > 0 ? '+' : ''}${trim(offsetDistance)}` : '',
    filletRadius ? ` 倒圆R${trim(filletRadius)}` : '',
    shellThickness ? ` 抽壳t${trim(shellThickness)}` : '',
  ].join('');
  return `${name}${mode}${pattern}${modifiers}${material}`;
}

/** 形状尺寸摘要，例如 box(0.24×0.16×0.05) */
export function describeShape(shape) {
  const fixed = (value) => (Math.abs(value) >= 0.1 ? value.toFixed(3) : value.toFixed(4));
  switch (shape?.shape) {
    case 'box':
      return `box(${fixed(shape.width)}×${fixed(shape.depth)}×${fixed(shape.height)})`;
    case 'roundedBox':
      return `roundedBox(${fixed(shape.width)}×${fixed(shape.depth)}×${fixed(shape.height)},r${fixed(shape.radius)})`;
    case 'cylinder':
      return `cylinder(r${fixed(shape.radius)},h${fixed(shape.height)})`;
    case 'tube':
      return `tube(r${fixed(shape.radius)},t${fixed(shape.thickness)},h${fixed(shape.height)})`;
    case 'capsule':
      return `capsule(r${fixed(shape.radius)},h${fixed(shape.height)})`;
    case 'sphere':
      return `sphere(r${fixed(shape.radius)})`;
    case 'ellipsoid':
      return `ellipsoid(${fixed(shape.rx)}×${fixed(shape.ry)}×${fixed(shape.rz)})`;
    case 'cone':
      return `cone(r${fixed(shape.radius)}→${fixed(shape.topRadius ?? 0)},h${fixed(shape.height)})`;
    case 'torus':
      return `torus(r${fixed(shape.radius)},tube${fixed(shape.tube)})`;
    case 'prism':
      return `prism(${shape.profile?.length ?? 0}点,h${fixed(shape.height)}${shape.twist ? `,twist${shape.twist}` : ''})`;
    case 'revolve':
      return `revolve(${shape.profile?.length ?? 0}点母线)`;
    case 'loft':
      return `loft(${shape.sections?.length ?? 0}截面)`;
    case 'sweep':
      return `sweep(${shape.path?.length ?? 0}点路径)`;
    case 'hull':
      return `hull(${shape.points?.length ?? 0}点凸包)`;
    case 'tiles':
      return `瓦面(${shape.rings?.length ?? 0}站,每面${shape.rows ?? 9}列×${shape.courses ?? 12}层)`;
    case 'group':
      return `group(${shape.features?.length ?? 0}子特征)`;
    default:
      return String(shape?.shape ?? 'unknown');
  }
}
