import type { SolidFeature } from '../src/bim/types';

export type ParamUnit = 'length' | 'area' | 'volume' | 'angle' | 'number' | 'count';

/** 参数表条目（写在模型 JSON 的 params 里） */
export interface ParamSpec {
  key: string;
  label: string;
  unit: ParamUnit;
  min: number;
  max: number;
  default: number;
  step: number;
  integer?: boolean;
}

/** 一份模型文档：特征树 + 可选参数表与绑定表 */
export interface ModelDocument {
  id: string;
  name: string;
  summary?: string;
  features: SolidFeature[];
  params?: ParamSpec[];
  /** 参数 → 特征字段（例如 `{ "f3.height": "height + 0.2" }`） */
  bindings?: Record<string, string>;
}

export interface LibraryEntry {
  id: string;
  name: string;
  summary: string;
  featureCount: number;
  params: ParamSpec[];
}

export const MODEL_DOCUMENTS: ModelDocument[];
export const LIBRARY_MODELS: LibraryEntry[];

export function modelDocument(id: string | undefined | null): ModelDocument | null;
export function isLibraryModel(id: string | undefined | null): boolean;
export function libraryModelIds(): string[];
export function modelParamSpecs(id: string): ParamSpec[];
export function defaultModelParams(id: string): Record<string, number>;
export function modelHasParams(id: string): boolean;
export function coerceModelParams(
  id: string,
  raw: Record<string, number> | undefined,
  options?: { strict?: boolean },
): { params: Record<string, number>; issues: string[] };
export function applyModelBindings(
  doc: ModelDocument,
  features: SolidFeature[],
  params: Record<string, number>,
): { features: SolidFeature[]; issues: string[] };
export function libraryFeatures(id: string): SolidFeature[];
export function buildModelFeatures(id: string, params?: Record<string, number>): SolidFeature[];
export function checkModelDocument(id: string): string[];
