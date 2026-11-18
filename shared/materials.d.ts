import type { SolidMaterial } from '../src/bim/types';

/** 预设材质：键是 preset 名（AI 可直接填），值是完整参数 */
export declare const SOLID_MATERIAL_PRESETS: Record<string, SolidMaterial>;

/** 全部预设名 */
export declare const SOLID_MATERIAL_KEYS: string[];

/** 内置程序化图案（迷彩）配色 */
export declare const SOLID_PATTERNS: Record<string, { scale: number; colors: string[] }>;

/** 缺省 PBR 参数 */
export declare const SOLID_MATERIAL_DEFAULTS: { roughness: number; metalness: number; opacity: number };

/** 内联贴图字符上限 / AI 提示词上限 / 允许的 UV 投影方式 / 凹凸幅度上限 */
export declare const SOLID_MAP_MAX_CHARS: number;
export declare const SOLID_MAP_PROMPT_MAX: number;
export declare const SOLID_MAP_MODES: string[];
export declare const SOLID_BUMP_SCALE_MAX: number;

/** #abc / #aabbcc → #aabbcc；非法返回 null */
export declare function normalizeHexColor(value: unknown): string | null;

/** data URL / ai: 提示词归一化，非法返回 null */
export declare function normalizeSolidMap(value: unknown): string | null;

/** 凹凸图：data URL 或 'auto'，非法返回 null */
export declare function normalizeSolidBumpMap(value: unknown): string | null;

/** 归一化材质描述（字符串预设或对象），返回 { material, errors } */
export declare function resolveSolidMaterial(spec: unknown): { material: SolidMaterial | null; errors: string[] };

/** 分组 key：取值相同的材质共用一个材质槽 */
export declare function solidMaterialKey(material: SolidMaterial | null | undefined): string;

/** 界面显示名 */
export declare function solidMaterialLabel(material: SolidMaterial | null | undefined): string;

/** 预设反查（界面下拉框用） */
export declare function solidMaterialPresetOf(material: SolidMaterial | null | undefined): string;
