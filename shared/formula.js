/**
 * 公式内核：词法分析 + 递归下降求值，**全程不使用 eval / new Function**。
 *
 * 为什么单独抽到 shared：
 *   - 前端用它做参数联动（recomputeParameters）与公式预览；
 *   - 服务端用它校验 AI 写下的约束表达式（语法错、引用不存在、成环）。
 * 两边必须同一份实现，否则会出现「AI 说能算、浏览器算不出来」。
 *
 * 约定：
 *   - 一切数值以「米 / 弧度 / 无量纲」存储，单位只做字面量换算（200mm → 0.2）；
 *   - 表达式里可引用中文标识符（参数名、尺寸别名），因此标识符允许 \u4e00-\u9fff；
 *   - 求值失败返回 { ok:false, error }，不抛异常——调用方按「保留原值 + 记一条问题」处理。
 */

export const FORMULA_FUNCTIONS = ['abs', 'min', 'max', 'round', 'floor', 'ceil', 'trunc', 'sign', 'sqrt', 'pow', 'exp', 'log', 'ln', 'sin', 'cos', 'tan', 'asin', 'acos', 'atan', 'clamp', 'if', 'mod'];

const UNIT_FACTORS = /** @type {Record<string, number>} */ ({
  mm: 0.001, cm: 0.01, dm: 0.1, m: 1, km: 1000,
  deg: Math.PI / 180, rad: 1, '%': 0.01,
});

const CONSTANTS = /** @type {Record<string, number>} */ ({ PI: Math.PI, pi: Math.PI, E: Math.E, e: Math.E });
const FUNCTION_NAMES = new Set(FORMULA_FUNCTIONS);

/** 词法分析：数字（可带单位字面量）、标识符（支持中文）、运算符。 */
export function tokenizeFormula(source) {
  /** @type {Array<{type:'number'|'ident'|'op'|'eof', text:string, value?:number}>} */
  const tokens = [];
  let index = 0;
  const text = String(source ?? '');
  while (index < text.length) {
    const char = text[index];
    if (/\s/.test(char)) { index += 1; continue; }
    if (/[0-9.]/.test(char)) {
      const match = /^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/.exec(text.slice(index));
      if (!match) throw new Error(`无法识别的数字：${text.slice(index, index + 8)}`);
      let value = Number(match[0]);
      index += match[0].length;
      // 仅在单位后缀后面不是字母/数字时才当作单位，避免把 2*min(...) 误判成 2m
      const unit = /^(mm|cm|dm|km|m|deg|rad|%)(?![A-Za-z0-9_])/i.exec(text.slice(index));
      if (unit) {
        const factor = UNIT_FACTORS[unit[1].toLowerCase()] ?? UNIT_FACTORS[unit[1]];
        if (factor !== undefined) {
          value *= factor;
          index += unit[0].length;
        }
      }
      tokens.push({ type: 'number', text: match[0], value });
      continue;
    }
    if (/[A-Za-z_$\u4e00-\u9fff]/.test(char)) {
      const match = /^[A-Za-z_$\u4e00-\u9fff][A-Za-z0-9_$.\u4e00-\u9fff]*/.exec(text.slice(index));
      const name = match ? match[0] : char;
      tokens.push({ type: 'ident', text: name });
      index += name.length;
      continue;
    }
    const two = text.slice(index, index + 2);
    if (['>=', '<=', '==', '!=', '&&', '||'].includes(two)) {
      tokens.push({ type: 'op', text: two });
      index += 2;
      continue;
    }
    if ('+-*/^%(),><!?:'.includes(char)) {
      tokens.push({ type: 'op', text: char });
      index += 1;
      continue;
    }
    throw new Error(`无法识别的字符：${char}`);
  }
  tokens.push({ type: 'eof', text: '' });
  return tokens;
}

/** 公式中引用到的标识符（排除函数与常量），用于依赖图与循环检测。 */
export function formulaReferences(expression) {
  if (!expression || !String(expression).trim()) return [];
  const found = new Set();
  try {
    for (const token of tokenizeFormula(expression)) {
      if (token.type === 'ident' && !FUNCTION_NAMES.has(token.text) && !(token.text in CONSTANTS)) {
        found.add(token.text);
      }
    }
  } catch {
    // 语法错误由 evaluateFormula 报告
  }
  return [...found];
}

/**
 * 重写表达式里的特征路径序号（特征增删后约束要跟着搬家）。
 * 只处理 `f<序号>.<字段>` 这一种写法；映射缺失表示该特征已被删除，原样保留（求值时会报找不到尺寸）。
 */
export function remapIdentifiers(expression, remap) {
  return String(expression ?? '').replace(
    /(?<![A-Za-z0-9_$.\u4e00-\u9fff])f(\d+)(?=\.)/g,
    (match, digits) => {
      const next = remap[Number(digits)];
      return next === undefined ? match : `f${next}`;
    },
  );
}

const FUNCTIONS = /** @type {Record<string, (args:number[]) => number>} */ ({
  abs: ([a]) => Math.abs(a ?? 0),
  min: (args) => Math.min(...args),
  max: (args) => Math.max(...args),
  round: ([a, b]) => { const f = 10 ** (b ?? 0); return Math.round((a ?? 0) * f) / f; },
  floor: ([a]) => Math.floor(a ?? 0),
  ceil: ([a]) => Math.ceil(a ?? 0),
  trunc: ([a]) => Math.trunc(a ?? 0),
  sign: ([a]) => Math.sign(a ?? 0),
  sqrt: ([a]) => Math.sqrt(a ?? 0),
  pow: ([a, b]) => (a ?? 0) ** (b ?? 1),
  exp: ([a]) => Math.exp(a ?? 0),
  log: ([a]) => Math.log(a ?? 1),
  ln: ([a]) => Math.log(a ?? 1),
  sin: ([a]) => Math.sin(a ?? 0),
  cos: ([a]) => Math.cos(a ?? 0),
  tan: ([a]) => Math.tan(a ?? 0),
  asin: ([a]) => Math.asin(a ?? 0),
  acos: ([a]) => Math.acos(a ?? 0),
  atan: ([a]) => Math.atan(a ?? 0),
  clamp: ([a, lo, hi]) => Math.min(Math.max(a ?? 0, lo ?? 0), hi ?? 1),
  mod: ([a, b]) => (a ?? 0) % (b ?? 1),
  if: ([condition, yes, no]) => (condition ? (yes ?? 0) : (no ?? 0)),
});

const PRECEDENCE = /** @type {Record<string, number>} */ ({
  '||': 1, '&&': 2,
  '>': 3, '<': 3, '>=': 3, '<=': 3, '==': 3, '!=': 3,
  '+': 4, '-': 4,
  '*': 5, '/': 5, '%': 5,
  '^': 6,
});

/** 安全求值：只识别上面的常量、函数与变量表，任何宿主代码都不可能被执行。 */
export function evaluateFormula(expression, variables = {}) {
  /** @type {string[]} */
  const references = [];
  try {
    const tokens = tokenizeFormula(expression);
    let cursor = 0;
    const peek = () => tokens[cursor];
    const next = () => tokens[cursor++];
    const expect = (want) => {
      const token = next();
      if (token.text !== want) throw new Error(`缺少 ${want}`);
    };

    const resolve = (name) => {
      if (name in variables) {
        if (!references.includes(name)) references.push(name);
        return variables[name];
      }
      if (name in CONSTANTS) return CONSTANTS[name];
      throw new Error(`未知参数「${name}」`);
    };

    const apply = (op, left, right) => {
      switch (op) {
        case '+': return left + right;
        case '-': return left - right;
        case '*': return left * right;
        case '/': return left / right;
        case '%': return left % right;
        case '^': return left ** right;
        case '>': return left > right ? 1 : 0;
        case '<': return left < right ? 1 : 0;
        case '>=': return left >= right ? 1 : 0;
        case '<=': return left <= right ? 1 : 0;
        case '==': return Math.abs(left - right) < 1e-9 ? 1 : 0;
        case '!=': return Math.abs(left - right) < 1e-9 ? 0 : 1;
        case '&&': return left !== 0 && right !== 0 ? 1 : 0;
        case '||': return left !== 0 || right !== 0 ? 1 : 0;
        default: throw new Error(`未知运算符 ${op}`);
      }
    };

    function parseExpression(minPrecedence) {
      let left = parsePrimary();
      while (peek().type === 'op' && (PRECEDENCE[peek().text] ?? -1) >= minPrecedence) {
        const op = next().text;
        const precedence = PRECEDENCE[op];
        // ^ 右结合；其余左结合
        const right = parseExpression(precedence + (op === '^' ? 0 : 1));
        left = apply(op, left, right);
      }
      return left;
    }

    const parsePrimary = () => {
      const token = next();
      if (token.type === 'number') return token.value;
      if (token.text === '-') return -parsePrimary();
      if (token.text === '+') return parsePrimary();
      if (token.text === '!') return parsePrimary() === 0 ? 1 : 0;
      if (token.text === '(') {
        const value = parseExpression(0);
        expect(')');
        return value;
      }
      if (token.type === 'ident') {
        if (peek().text === '(') {
          expect('(');
          const args = [];
          if (peek().text !== ')') {
            do { args.push(parseExpression(0)); } while (peek().text === ',' && (expect(','), true));
          }
          expect(')');
          const fn = FUNCTIONS[token.text];
          if (!fn) throw new Error(`未知函数「${token.text}」`);
          return fn(args);
        }
        return resolve(token.text);
      }
      throw new Error(`意外的符号「${token.text || '结尾'}」`);
    };

    const value = parseExpression(0);
    if (peek().type !== 'eof') throw new Error(`多余的符号「${peek().text}」`);
    if (!Number.isFinite(value)) throw new Error('计算结果不是有限数值（检查除零或开方）');
    return { ok: true, value, references };
  } catch (error) {
    return { ok: false, value: 0, error: error instanceof Error ? error.message : '公式无效', references };
  }
}
