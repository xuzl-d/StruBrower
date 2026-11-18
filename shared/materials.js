/**
 * 造型材质库（服务端校验、前端渲染、界面预设共用同一份定义）。
 *
 * 造型实体的每个特征可以带 material（颜色 + PBR 参数），求值时按材质的**取值**分组，
 * 用 geometry.groups 做多材质渲染。这里同时提供「常见工业材质」预设，让 AI 一句
 * `"material": "aluminum"` 就能拿到一套自洽的颜色/粗糙度/金属度，而不用自己编数字。
 *
 * 色值统一 #rrggbb（小写）；opacity 与文档里的 Material 一致，0–100。
 * 贴图（map）是特征级材质的一段内联 data URL，或 `ai:<提示词>` 生成占位；
 * 后者在服务端 /ai/plan 返回前被换成真实图片，前端拿到的永远是前者。
 */

/** 预设材质：键是 AI 可以填的 preset 名，值是完整的材质参数 */
export const SOLID_MATERIAL_PRESETS = {
  aluminum: { name: '阳极氧化铝', color: '#b9c2cb', roughness: 0.28, metalness: 0.92 },
  steel: { name: '不锈钢', color: '#cfd6dd', roughness: 0.22, metalness: 0.96 },
  carbon: { name: '碳纤维', color: '#24282e', roughness: 0.38, metalness: 0.18 },
  plastic: { name: '工程塑料', color: '#dfe4ea', roughness: 0.55, metalness: 0.02 },
  plasticDark: { name: '深灰塑料', color: '#30343a', roughness: 0.5, metalness: 0.03 },
  rubber: { name: '橡胶', color: '#1b1e22', roughness: 0.92, metalness: 0 },
  glass: { name: '玻璃', color: '#cfe2ef', roughness: 0.06, metalness: 0.05, opacity: 32 },
  copper: { name: '紫铜', color: '#b87333', roughness: 0.3, metalness: 1 },
  brass: { name: '黄铜', color: '#c9a227', roughness: 0.3, metalness: 0.95 },
  gold: { name: '金色镀层', color: '#d8b24a', roughness: 0.2, metalness: 1 },
  paintWhite: { name: '白色烤漆', color: '#eef2f5', roughness: 0.32, metalness: 0.04 },
  paintOrange: { name: '橙色烤漆', color: '#e2622a', roughness: 0.35, metalness: 0.05 },
  ceramic: { name: '陶瓷', color: '#f3f1ec', roughness: 0.18, metalness: 0.02 },
  wood: { name: '木材', color: '#a9793f', roughness: 0.7, metalness: 0 },
  // 程序化迷彩：pattern 按表面三维坐标生成斑块，不依赖 UV，斜面上也不会翘起。
  camoJungle: { name: '丛林迷彩', color: '#4d5a36', roughness: 0.85, metalness: 0.04, pattern: 'jungle' },
  camoDesert: { name: '沙漠迷彩', color: '#a18e5d', roughness: 0.85, metalness: 0.04, pattern: 'desert' },
};

export const SOLID_MATERIAL_KEYS = Object.keys(SOLID_MATERIAL_PRESETS);

/** 内置迷彩配色（底色 + 斑块色），渲染端按表面坐标分层取样 */
export const SOLID_PATTERNS = {
  jungle: { scale: 1.7, colors: ['#4d5a36', '#6b6f45', '#a18e5d', '#3c3528'] },
  desert: { scale: 1.7, colors: ['#a18e5d', '#c2ad7d', '#8a7650', '#5c5038'] },
};

/** 默认材质参数（特征没写材质时，跟随构件材质，不用这些值） */
export const SOLID_MATERIAL_DEFAULTS = { roughness: 0.62, metalness: 0.04, opacity: 100 };

/** 内联贴图允许的最大字符数（约 450 KB 图片），防止把整个项目文档变成一段 base64 */
export const SOLID_MAP_MAX_CHARS = 600_000;
/** 贴图生成占位符的提示词长度上限 */
export const SOLID_MAP_PROMPT_MAX = 300;
/** UV 投影方式：绕 Z 柱面（回转体）/ 球面 / XY 平面 */
export const SOLID_MAP_MODES = ['cylindrical', 'spherical', 'planar'];
/** 凹凸幅度（世界单位，米）：皮革缝 0.002~0.006 就够，再大会出现假浮雕 */
export const SOLID_BUMP_SCALE_MAX = 0.05;
const MAP_DATA_URL = /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/i;

/** #abc / #aabbcc → #aabbcc；非法返回 null */
export function normalizeHexColor(value) {
  if (typeof value !== 'string') return null;
  const text = value.trim().replace(/^0x/i, '');
  const hex = text.startsWith('#') ? text.slice(1) : text;
  if (/^[0-9a-f]{3}$/i.test(hex)) {
    return `#${hex[0]}${hex[0]}${hex[1]}${hex[1]}${hex[2]}${hex[2]}`.toLowerCase();
  }
  if (/^[0-9a-f]{6}$/i.test(hex)) return `#${hex}`.toLowerCase();
  return null;
}

/**
 * 凹凸图字段：内联 data URL，或 'auto'（服务端按同一提示词生成配套高度图）。
 * 不允许 `ai:` 前缀——凹凸图必须是与颜色图严格对齐的灰度图，让模型自由描述会错位。
 */
export function normalizeSolidBumpMap(value) {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (text === 'auto') return 'auto';
  const clean = text.replace(/\s+/g, '');
  if (clean.length > SOLID_MAP_MAX_CHARS || !MAP_DATA_URL.test(clean)) return null;
  return clean;
}

function unit(value) {
  // 越界直接当非法值：悄悄夹到 0–1 会让模型以为写对了，下次还错
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1 ? value : undefined;
}

/** 贴图字段归一化：内联 data URL、AI 生成占位符，其余一律判非法（返回 null） */
export function normalizeSolidMap(value) {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (text.startsWith('ai:')) {
    const prompt = text.slice(3).trim();
    return prompt && prompt.length <= SOLID_MAP_PROMPT_MAX ? `ai:${prompt}` : null;
  }
  const clean = text.replace(/\s+/g, '');
  if (clean.length > SOLID_MAP_MAX_CHARS || !MAP_DATA_URL.test(clean)) return null;
  return clean;
}

/** 贴图可能是几百 KB 的 base64：分组 key 里只放短哈希，别拿整段字符串当 Map 键 */
function shortHash(text) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return `${(hash >>> 0).toString(16)}:${text.length}`;
}

/**
 * 归一化一个材质描述。接受两种写法：
 * - 字符串预设名：'aluminum'
 * - 对象：{ preset?, name?, color?, roughness?, metalness?, opacity? }（preset 作为底，其余字段覆盖）
 *
 * 不做抛错：返回 { material, errors }，服务端拿 errors 拼报错，前端直接忽略坏字段。
 */
export function resolveSolidMaterial(spec) {
  const errors = [];
  if (spec === undefined || spec === null) return { material: null, errors };

  let source = spec;
  if (typeof spec === 'string') {
    source = { preset: spec };
  } else if (typeof spec !== 'object' || Array.isArray(spec)) {
    errors.push('material 必须是预设名或 { color, roughness, metalness, opacity } 对象');
    return { material: null, errors };
  }

  const material = {};
  if (source.preset !== undefined && source.preset !== null && source.preset !== '') {
    const preset = SOLID_MATERIAL_PRESETS[String(source.preset)];
    if (!preset) {
      errors.push(`material.preset 不支持「${source.preset}」，可用：${SOLID_MATERIAL_KEYS.join(', ')}`);
    } else {
      Object.assign(material, preset);
    }
  }

  if (source.name !== undefined) {
    if (typeof source.name !== 'string' || !source.name.trim()) errors.push('material.name 必须是非空字符串');
    else material.name = source.name.trim().slice(0, 40);
  }

  if (source.color !== undefined) {
    const color = normalizeHexColor(source.color);
    if (!color) errors.push(`material.color 必须是 #rrggbb 十六进制颜色（收到「${source.color}」）`);
    else material.color = color;
  }

  for (const [key, label] of [['roughness', '粗糙度'], ['metalness', '金属度']]) {
    if (source[key] === undefined) continue;
    const value = unit(source[key]);
    if (value === undefined) errors.push(`material.${key}（${label}）必须是 0 ~ 1 的数字`);
    else material[key] = value;
  }

  if (source.opacity !== undefined) {
    if (typeof source.opacity !== 'number' || !Number.isFinite(source.opacity) || source.opacity <= 0 || source.opacity > 100) {
      errors.push('material.opacity（不透明度）必须是 0 ~ 100 的数字（100 = 完全不透明）');
    } else {
      material.opacity = Math.round(source.opacity * 10) / 10;
    }
  }

  if (source.pattern !== undefined) {
    if (typeof source.pattern === 'string') {
      if (!SOLID_PATTERNS[source.pattern]) {
        errors.push(`material.pattern 不支持「${source.pattern}」，可用：${Object.keys(SOLID_PATTERNS).join(', ')}`);
      } else {
        material.pattern = source.pattern;
      }
    } else if (source.pattern && typeof source.pattern === 'object' && !Array.isArray(source.pattern)) {
      const colors = source.pattern.colors;
      if (!Array.isArray(colors) || colors.length < 2 || colors.some((c) => !normalizeHexColor(c))) {
        errors.push('material.pattern.colors 至少需要 2 个 #rrggbb 颜色');
      } else {
        const scale = source.pattern.scale;
        material.pattern = {
          colors: colors.map((c) => normalizeHexColor(c)),
          ...(typeof scale === 'number' && Number.isFinite(scale) && scale > 0 ? { scale } : {}),
        };
      }
    } else {
      errors.push('material.pattern 必须是图案名或 { colors: string[], scale?: number }');
    }
  }

  // 只有 opacity 没有颜色也能用：透明是独立效果

  if (source.map !== undefined) {
    const map = normalizeSolidMap(source.map);
    if (!map) {
      errors.push(`material.map 必须是 data:image/png|jpeg|webp;base64,…（≤ ${SOLID_MAP_MAX_CHARS} 字符）`
        + ` 或 ai:<提示词>（≤ ${SOLID_MAP_PROMPT_MAX} 字，由服务端生成图片）`);
    } else {
      material.map = map;
    }
  }

  if (source.mapMode !== undefined) {
    if (!SOLID_MAP_MODES.includes(source.mapMode)) {
      errors.push(`material.mapMode 只支持 ${SOLID_MAP_MODES.join(' / ')}`);
    } else {
      material.mapMode = source.mapMode;
    }
  }

  if (source.mapRepeat !== undefined) {
    const repeat = source.mapRepeat;
    const valid = Array.isArray(repeat) && repeat.length === 2
      && repeat.every((v) => typeof v === 'number' && Number.isFinite(v) && v > 0 && v <= 32);
    if (!valid) errors.push('material.mapRepeat 必须是 [u, v] 两个 0 ~ 32 的正数');
    else material.mapRepeat = [repeat[0], repeat[1]];
  }

  if (source.bumpMap !== undefined) {
    const bumpMap = normalizeSolidBumpMap(source.bumpMap);
    if (!bumpMap) {
      errors.push(`material.bumpMap 必须是 data:image/png|jpeg|webp;base64,…（≤ ${SOLID_MAP_MAX_CHARS} 字符）或 "auto"`);
    } else {
      material.bumpMap = bumpMap;
    }
  }

  if (source.bumpScale !== undefined) {
    const scale = Number(source.bumpScale);
    if (!Number.isFinite(scale) || scale < 0 || scale > SOLID_BUMP_SCALE_MAX) {
      errors.push(`material.bumpScale（凹凸幅度）必须是 0 ~ ${SOLID_BUMP_SCALE_MAX} 的数字`);
    } else {
      material.bumpScale = scale;
    }
  }

  // 只有 opacity / 只有 map 也能用：透明与贴图都是独立效果
  if (!Object.keys(material).length && !errors.length) {
    return { material: null, errors };
  }
  return { material: errors.length ? null : material, errors };
}

/** 分组 key：取值相同的材质共用一个材质槽 */
export function solidMaterialKey(material) {
  if (!material) return '';
  const order = ['name', 'color', 'roughness', 'metalness', 'opacity', 'mapMode', 'mapRepeat', 'map', 'bumpMap', 'bumpScale'];
  const parts = order
    .filter((key) => material[key] !== undefined)
    .map((key) => {
      const value = material[key];
      if (key === 'map' || key === 'bumpMap') return `${key}:${shortHash(String(value))}`;
      return `${key}:${Array.isArray(value) ? value.join(',') : value}`;
    });
  // pattern 可能是对象，单独稳定序列化，保证不同色板不会合并到同一材质槽
  if (material.pattern !== undefined) parts.push(`pattern:${JSON.stringify(material.pattern)}`);
  return parts.join('|');
}

/** 界面显示名：有名字用名字，其次贴图，最后退回色值 */
export function solidMaterialLabel(material) {
  if (!material) return '跟随构件材质';
  if (material.name) return material.name;
  if (material.map) return material.map.startsWith('ai:') ? 'AI 生成贴图' : '纹理贴图';
  return material.color ? material.color.toUpperCase() : '自定义材质';
}

/** 预设反查：界面下拉框按「颜色 + 参数全等」判断当前用的是哪个预设 */
export function solidMaterialPresetOf(material) {
  if (!material) return '';
  const key = solidMaterialKey(material);
  for (const name of SOLID_MATERIAL_KEYS) {
    if (solidMaterialKey(SOLID_MATERIAL_PRESETS[name]) === key) return name;
  }
  return '';
}
