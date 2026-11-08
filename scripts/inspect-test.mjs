/**
 * 巡检视角解析测试：AI 说「转到右视，凑近看夹头」，这里断言那句话会被翻成什么。
 * 这是「AI 自己决定看哪里、看多近」的入口——解析错了，截图就拍错地方。
 */
import { MAX_INSPECT_VIEWS, normalizeInspect } from '../server/ai/inspect.js';

let failed = 0;
function check(name, ok, detail) {
  if (ok) console.log('  ✓', name);
  else {
    failed += 1;
    console.log('  ✗', name, detail ?? '');
  }
}

console.log('基本视角');
{
  const list = normalizeInspect(['front', 'right', 'iso']);
  check('字符串写法认得出', list.map((item) => item.view).join('/') === 'front/right/iso', list);
  check('带中文名', list.map((item) => item.label).join('/') === '前视/右视/等轴测', list);
  check('没给 focus / zoom 就不写这两个字段', list.every((item) => !('focus' in item) && !('zoom' in item)), list);

  const single = normalizeInspect('top');
  check('单个字符串也收', single.length === 1 && single[0].view === 'top', single);
  check('大写与空格宽容处理', normalizeInspect('  BACK ')[0]?.view === 'back', normalizeInspect('  BACK '));
}

console.log('看细节：focus + zoom');
{
  const [view] = normalizeInspect([{ view: 'right', focus: '夹头', zoom: 2.5 }]);
  check('focus 原样保留', view.focus === '夹头', view);
  check('zoom 保留', view.zoom === 2.5, view);
  check('label 说清「聚焦谁、放大几倍」', view.label === '右视 · 聚焦「夹头」 × 2.5', view.label);

  const [plain] = normalizeInspect([{ view: 'iso', zoom: 1 }]);
  check('zoom=1 不写进 payload（前端据此判断要不要特写）', !('zoom' in plain), plain);
  check('zoom=1 时 label 干净', plain.label === '等轴测', plain.label);

  const [alias] = normalizeInspect([{ view: 'front', scale: 2 }]);
  check('scale 是 zoom 的别名', alias.zoom === 2, alias);

  const [rounded] = normalizeInspect([{ view: 'front', zoom: 2.46 }]);
  check('zoom 保留一位小数', rounded.zoom === 2.5, rounded);

  const [far] = normalizeInspect([{ view: 'iso', zoom: 0.5 }]);
  check('zoom<1 表示退远（看整体关系）', far.zoom === 0.5 && far.label === '等轴测 · × 0.5', far);

  const [clampedHigh] = normalizeInspect([{ view: 'iso', zoom: 99 }]);
  check('zoom 上限夹到 4', clampedHigh.zoom === 4, clampedHigh);
  const [clampedLow] = normalizeInspect([{ view: 'iso', zoom: 0.01 }]);
  check('zoom 下限夹到 0.4', clampedLow.zoom === 0.4, clampedLow);
  const [bad] = normalizeInspect([{ view: 'iso', zoom: 'big' }]);
  check('zoom 不是数字就当没给', !('zoom' in bad) && bad.label === '等轴测', bad);

  const [blank] = normalizeInspect([{ view: 'front', focus: '   ' }]);
  check('空白 focus 当没给', !('focus' in blank) && blank.label === '前视', blank);

  const longFocus = '夹'.repeat(80);
  const [trimmed] = normalizeInspect([{ view: 'front', focus: longFocus }]);
  check('focus 截到 40 字（提示词里塞不进更长的名字）', trimmed.focus.length === 40, trimmed.focus.length);

  const [angle] = normalizeInspect([{ azimuth: 45, elevation: 20, focus: '握把', zoom: 1.6 }]);
  check('自定义角度也能带 focus', angle.focus === '握把' && angle.zoom === 1.6, angle);
  check('角度 label 与取景说明拼在一起', angle.label === '方位 45° / 仰角 20° · 聚焦「握把」 × 1.6', angle.label);
}

console.log('防护与边界');
{
  check(`最多 ${MAX_INSPECT_VIEWS} 个视角`, normalizeInspect(['front', 'back', 'left', 'right', 'top', 'iso']).length === 4);
  check('认不出的视角丢弃（不让整轮生成失败）', normalizeInspect(['front', 'sideways', null, 42]).length === 1);
  check('只给 focus 没给角度 → 丢弃', normalizeInspect([{ focus: '夹头', zoom: 2 }]).length === 0);
  check('空数组安全', normalizeInspect([]).length === 0);
  check('undefined 安全', normalizeInspect(undefined).length === 0);
  check('对象不是数组时安全', normalizeInspect({ view: 'front' }).length === 0);

  const [high] = normalizeInspect([{ azimuth: 400, elevation: 120 }]);
  check('方位角归一到 0–360', high.azimuth === 40, high);
  check('仰角夹到 ±88°（±90° 时 lookAt 退化）', high.elevation === 88, high);

  const [weird] = normalizeInspect([{ azimuth: '45', elevation: '20' }]);
  check('数字字符串也能解析', weird.azimuth === 45 && weird.elevation === 20, weird);
}

console.log('focus 不应该影响别的视角');
{
  // 混着来：一张整机、一张特写——这是提示词推荐的组合
  const list = normalizeInspect([
    { view: 'front' },
    { view: 'right', focus: '夹头', zoom: 2.5 },
  ]);
  check('第一张是整机（无 focus/zoom）', !list[0].focus && !list[0].zoom, list[0]);
  check('第二张是特写', list[1].focus === '夹头' && list[1].zoom === 2.5, list[1]);
  check('两张都带可读 label', list[0].label === '前视' && list[1].label.includes('夹头'), list.map((item) => item.label));
}

if (failed) {
  console.log(`\n${failed} 项巡检解析测试失败`);
  process.exit(1);
}
console.log('\n巡检视角测试通过（AI 能自己决定看哪、看多近）');
