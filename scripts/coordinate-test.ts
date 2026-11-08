/**
 * 绘制坐标输入解析单元测试：长度单位、角度、极坐标换算与非法输入。
 * 运行：node scripts/test.mjs（内部用 esbuild 打包后执行）
 */
import { parseAngle, parseLength, polarPoint } from '../src/bim/coordinates';

let failed = 0;
function check(name: string, condition: boolean, detail?: unknown) {
  if (condition) console.log(`  ✓ ${name}`);
  else {
    failed += 1;
    console.error(`  ✗ ${name}`, detail ?? '');
  }
}

/* 1. 纯数字按米 */
check('3.6 → 3.6 m', parseLength('3.6') === 3.6);
check('整数 6 → 6 m', parseLength('6') === 6);
check('.5 → 0.5 m', parseLength('.5') === 0.5);
check('负数 -2.25 → -2.25 m', parseLength('-2.25') === -2.25);
check('前后空格被忽略', parseLength('  12.5  ') === 12.5);

/* 2. 带单位 */
check('3600mm → 3.6 m', parseLength('3600mm') === 3.6);
check('3600 MM 大小写不敏感', parseLength('3600 MM') === 3.6);
check('360cm → 3.6 m', parseLength('360cm') === 3.6);
check('3.6m → 3.6 m', parseLength('3.6m') === 3.6);
check('1,200mm 逗号分隔 → 1.2 m', parseLength('1,200mm') === 1.2);

/* 3. 非法输入 */
check('空串 → null', parseLength('') === null);
check('空格 → null', parseLength('   ') === null);
check('字母 → null', parseLength('abc') === null);
check('单位错误 km → null', parseLength('1km') === null);
check('多个小数点 → null', parseLength('1.2.3') === null);
check('“3.6 米” 中文单位 → null', parseLength('3.6米') === null);

/* 4. 角度 */
check('90 → 90', parseAngle('90') === 90);
check('90° → 90', parseAngle('90°') === 90);
check('-45度 → -45', parseAngle('-45度') === -45);
check('空角度 → null', parseAngle('') === null);
check('角度非法 → null', parseAngle('东') === null);

/* 5. 极坐标：角度自 +X 逆时针 */
const east = polarPoint([1, 2], 6, 0);
check('0° 沿 +X', Math.abs(east[0] - 7) < 1e-9 && Math.abs(east[1] - 2) < 1e-9, east);
const north = polarPoint([0, 0], 5, 90);
check('90° 沿 +Y', Math.abs(north[0]) < 1e-9 && Math.abs(north[1] - 5) < 1e-9, north);
const west = polarPoint([0, 0], 5, 180);
check('180° 沿 -X', Math.abs(west[0] + 5) < 1e-9 && Math.abs(west[1]) < 1e-9, west);
const diag = polarPoint([2, 3], Math.SQRT2, 45);
check('45° 对角线', Math.abs(diag[0] - 3) < 1e-9 && Math.abs(diag[1] - 4) < 1e-9, diag);

/* 6. 轴网常用输入：起点 + 长度/角度 → 终点 */
const gridStart: [number, number] = [2, 2];
const gridEnd = polarPoint(gridStart, 12, 90);
check('轴网：竖直方向 12 m', gridEnd[0] === gridStart[0] && Math.abs(gridEnd[1] - gridStart[1] - 12) < 1e-9, gridEnd);

if (failed > 0) {
  console.error(`坐标输入测试失败 ${failed} 项`);
  process.exit(1);
}
console.log('坐标输入解析测试通过');
