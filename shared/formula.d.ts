/** 公式内核（shared/formula.js）的类型声明。 */

export declare const FORMULA_FUNCTIONS: readonly string[];

export interface EvalResult {
  ok: boolean;
  value: number;
  error?: string;
  references: string[];
}

export interface FormulaToken {
  type: 'number' | 'ident' | 'op' | 'eof';
  text: string;
  value?: number;
}

export declare function tokenizeFormula(source: string): FormulaToken[];
export declare function formulaReferences(expression: string): string[];
export declare function remapIdentifiers(expression: string, remap: Record<number, number>): string;
export declare function evaluateFormula(
  expression: string,
  variables?: Record<string, number>,
): EvalResult;
