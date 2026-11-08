/**
 * 造型材质库（服务端校验、前端渲染、界面预设共用同一份定义）。
 *
 * 造型实体的每个特征可以带 material（颜色 + PBR 参数），求值时按材质的**取值**分组，
 * 用 geometry.groups 做多材质渲染。这里同时提供「常见工业材质」预设，让 AI 一句
 * `"material": "aluminum"` 就能拿到一套自洽的颜色/粗糙度/金属度，而不用自己编数字。
 *
 * 色值统一 #rrggbb（小写）；opacity 与文档里的 Material 一致，0–100。
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
};

export const SOLID_MATERIAL_KEYS = Object.keys(SOLID_MATERIAL_PRESETS);

/** 默认材质参数（特征没写材质时，跟随构件材质，不用这些值） */
export const SOLID_MATERIAL_DEFAULTS = { roughness: 0.62, metalness: 0.04, opacity: 100 };

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

function unit(value) {
  // 越界直接当非法值：悄悄夹到 0–1 会让模型以为写对了，下次还错
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1 ? value : undefined;
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

  // 只有 opacity 没有颜色也能用：透明是独立效果
  if (!Object.keys(material).length && !errors.length) {
    return { material: null, errors };
  }
  return { material: errors.length ? null : material, errors };
}

/** 分组 key：取值相同的材质共用一个材质槽 */
export function solidMaterialKey(material) {
  if (!material) return '';
  const order = ['name', 'color', 'roughness', 'metalness', 'opacity'];
  return order
    .filter((key) => material[key] !== undefined)
    .map((key) => `${key}:${material[key]}`)
    .join('|');
}

/** 界面显示名：有名字用名字，没名字退回色值 */
export function solidMaterialLabel(material) {
  if (!material) return '跟随构件材质';
  return material.name || (material.color ? material.color.toUpperCase() : '自定义材质');
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
