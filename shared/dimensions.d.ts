/** 尺寸寻址层（shared/dimensions.js）的类型声明。 */

import type { ParameterUnit } from '../src/bim/types';

export interface DimensionSpec {
  /** 唯一路径，例如 f3.height / f2.translate.1 / param.height */
  path: string;
  /** 与 path 相同，供参数表面板按 key 索引 */
  key: string;
  label: string;
  unit: ParameterUnit;
  min: number;
  max: number;
  integer?: boolean;
  value: number;
  /** 面板分组路径，例如 ['特征 3（机身）'] */
  group: string[];
  kind: 'shape' | 'section' | 'taper' | 'modifier' | 'translate' | 'rotate' | 'scale' | 'pattern' | 'param' | 'primitive';
}

export declare function splitPath(path: string): string[];
export declare function listDimensions(element: unknown): DimensionSpec[];
export declare function dimensionSpec(element: unknown, path: string): DimensionSpec | null;
export declare function readDimension(element: unknown, path: string): number | null;
export declare function writeDimension<T>(element: T, path: string, value: number): T;
export declare function clampDimension(spec: DimensionSpec | null, value: number): number | null;
export declare function remapFeaturePath(path: string, remap: Record<number, number>): string | null;
