import type { SolidMaterial } from '../src/bim/types';

/** 预设材质：键是 preset 名（AI 可直接填），值是完整参数 */
export declare const SOLID_MATERIAL_PRESETS: Record<string, SolidMaterial>;

/** 全部预设名 */
export declare const SOLID_MATERIAL_KEYS: string[];

/** 缺省 PBR 参数 */
export declare const SOLID_MATERIAL_DEFAULTS: { roughness: number; metalness: number; opacity: number };

/** #abc / #aabbcc → #aabbcc；非法返回 null */
export declare function normalizeHexColor(value: unknown): string | null;

/** 归一化材质描述（字符串预设或对象），返回 { material, errors } */
export declare function resolveSolidMaterial(spec: unknown): { material: SolidMaterial | null; errors: string[] };

/** 分组 key：取值相同的材质共用一个材质槽 */
export declare function solidMaterialKey(material: SolidMaterial | null | undefined): string;

/** 界面显示名 */
export declare function solidMaterialLabel(material: SolidMaterial | null | undefined): string;

/** 预设反查（界面下拉框用） */
export declare function solidMaterialPresetOf(material: SolidMaterial | null | undefined): string;
