import type { SolidFeature } from '../src/bim/types';

export type ParamUnit = 'length' | 'area' | 'volume' | 'angle' | 'number' | 'count';

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

export interface ParamTemplate {
  id: string;
  name: string;
  summary: string;
  params: ParamSpec[];
  build: (params: Record<string, number>) => SolidFeature[];
}

export const PARAM_TEMPLATES: ParamTemplate[];

export function paramTemplate(id: string | undefined | null): ParamTemplate | null;
export function paramTemplateIds(): string[];
export function defaultParams(templateId: string): Record<string, number>;
export function coerceParams(
  templateId: string,
  raw: Record<string, number> | undefined,
  options?: { strict?: boolean },
): { params: Record<string, number>; issues: string[] };
export function buildParametricFeatures(model?: { template?: string; params?: Record<string, number> }): SolidFeature[];
export function isParametricModel(value: unknown): value is { template: string; params: Record<string, number> };
