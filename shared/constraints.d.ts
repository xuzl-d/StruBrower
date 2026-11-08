/** 通用约束引擎（shared/constraints.js）的类型声明。 */

import type { DimensionSpec } from './dimensions';

export interface ConstraintViolation {
  kind: 'alias' | 'formula' | 'check';
  target: string;
  message: string;
  severity: 'error' | 'warn';
}

export interface ConstraintUpdate {
  path: string;
  label: string;
  from: number;
  to: number;
}

export interface ResolveOptions {
  globals?: Record<string, number>;
  clamp?: boolean;
  dryRun?: boolean;
}

export interface ResolveResult<T = unknown> {
  element: T;
  updates: ConstraintUpdate[];
  violations: ConstraintViolation[];
  values: Record<string, number>;
}

export interface ConstraintPlan<T = unknown> {
  dimensions: DimensionSpec[];
  specByPath: Map<string, DimensionSpec>;
  values: Map<string, number>;
  pathByAlias: Map<string, string>;
  aliasByPath: Map<string, string>;
  bindings: Array<{ key: string; path: string; expr: string }>;
  bindingByPath: Map<string, { key: string; path: string; expr: string }>;
  deps: Map<string, string[]>;
  errors: ConstraintViolation[];
  warnings: ConstraintViolation[];
  element?: T;
}

export declare const CONSTRAINT_LIMITS: {
  dimensions: number;
  checks: number;
  expression: number;
};

export declare function planConstraints<T = unknown>(element: T): ConstraintPlan<T>;
export declare function resolveConstraints<T = unknown>(element: T, options?: ResolveOptions): ResolveResult<T>;
export declare function rebaseConstraints<T = unknown>(element: T, remap: Record<number, number | undefined>): T;
export declare function summarizeConstraints(
  element: unknown,
  options?: { globals?: Record<string, number> },
): {
  dimensions?: Array<{ name: string; path: string; value: number | null }>;
  formulas?: Record<string, string>;
  checks?: Array<{ expr: string; message?: string; severity?: string }>;
  violations?: string[];
};
