/** Python 工具：沙箱边界、脚本契约、ops 校验、图片引用、状态报告。 */
import { normalizePython, MAX_PYTHON_SCRIPTS, MAX_SCRIPT_CHARS } from '../server/ai/python.js';
import { pythonStatus, runPythonTool, MAX_PYTHON_TEXT } from '../server/ai/python-runner.js';

let passed = 0;
let failed = 0;
function check(name, ok, detail) {
  if (ok) {
    passed += 1;
    console.log('  ✓', name);
  } else {
    failed += 1;
    console.log('  ✗', name, detail === undefined ? '' : JSON.stringify(detail).slice(0, 300));
  }
}

const doc = {
  schemaVersion: 2,
  id: 'python-test-doc',
  name: 'Python 测试',
  units: 'metric',
  levels: [{ id: 'l1', name: '标高 1', elevation: 0 }],
  grids: [],
  materials: [],
  types: [],
  elements: [],
};
const run = (code, options = {}) => runPythonTool([{ code, note: options.note }], { document: doc, ...options });

console.log('\n请求规范化');
check('字符串脚本也能收', normalizePython('emit({"result":1})')[0]?.code === 'emit({"result":1})');
check('对象带 note', normalizePython([{ code: ' x() ', note: '说明' }])[0]?.note === '说明');
check('空脚本丢掉', normalizePython([{ code: '' }, '  ']).length === 0);
check(`最多 ${MAX_PYTHON_SCRIPTS} 段`, normalizePython(Array.from({ length: 6 }, () => ({ code: 'x' }))).length === MAX_PYTHON_SCRIPTS);
check(`单段截到 ${MAX_SCRIPT_CHARS} 字`, normalizePython([{ code: 'a'.repeat(MAX_SCRIPT_CHARS + 100) }])[0]?.code.length === MAX_SCRIPT_CHARS);
check('非法类型不炸', normalizePython([null, 3, [], {}]).length === 0);

console.log('\n正常计算与依赖');
const calc = await run("import math\npts = [[round(math.cos(i * math.pi / 8), 3), i * 0.02] for i in range(9)]\nemit({'result': {'points': pts, 'count': len(pts)}})");
check('纯 Python 计算成功', calc.report.ok === 1, calc.report.errors);
check('结果回灌含点列', calc.text.includes('"count": 9') && calc.text.includes('0.924'), calc.text.slice(0, 200));
check('报告给出后端与耗时', typeof calc.report.ms === 'number' && typeof calc.report.mode === 'string', calc.report);

const logs = await run("print('计算中')\nemit({'result': 42})");
check('print 输出作为 logs 回灌', logs.text.includes('计算中') && logs.text.includes('42'), logs.text);

const noEmit = await run('x = 1 + 1');
check('没 emit 时明确提示', noEmit.text.includes('emit()'), noEmit.text);

console.log('\n安全边界');
const attacks = [
  ['import os', "import os\nemit({'result': 1})", '不允许导入模块 os'],
  ['subprocess', "import subprocess\nemit({'result': 1})", '不允许导入模块 subprocess'],
  ['socket 网络', "import socket\nemit({'result': 1})", '不允许导入模块 socket'],
  ['文件读取', "emit({'result': open('/etc/passwd').read()})", '不允许调用 open()'],
  ['eval', "emit({'result': eval('1+1')})", '不允许调用 eval()'],
  ['exec', "exec('x=1')\nemit({'result': 1})", '不允许调用 exec()'],
  ['dunder 逃逸', "emit({'result': ().__class__.__mro__})", '不允许访问属性'],
  ['__globals__', "emit({'result': emit.__globals__})", '不允许访问属性'],
  ['global 声明', "global x\nemit({'result': 1})", '不允许 global'],
];
for (const [name, code, expected] of attacks) {
  const result = await run(code, { note: name });
  check(`${name} 被拒`, result.report.failed === 1 && result.report.errors[0]?.includes(expected), result.report.errors);
}

const syntax = await run('def broken(:\n  pass');
check('语法错误变成可回灌文字', syntax.report.failed === 1 && syntax.text.includes('语法错误'), syntax.text);
const runtime = await run("emit({'result': 1 / 0})");
check('运行异常不打断整轮', runtime.report.failed === 1 && runtime.text.includes('ZeroDivisionError'), runtime.text);

console.log('\n资源与输出限额');
const previousTimeout = process.env.STRU_AI_PYTHON_TIMEOUT_MS;
process.env.STRU_AI_PYTHON_TIMEOUT_MS = '1000';
const slow = await run('while True:\n  pass');
check('死循环被超时掐掉', slow.report.failed === 1 && /超时|中止/.test(slow.report.errors[0] ?? ''), slow.report.errors);
process.env.STRU_AI_PYTHON_TIMEOUT_MS = previousTimeout ?? '';
if (previousTimeout === undefined) delete process.env.STRU_AI_PYTHON_TIMEOUT_MS;

const huge = await run("emit({'result': {'text': '" + 'a'.repeat(MAX_PYTHON_TEXT + 5000) + "'}})");
check('超大结果被截断', huge.text.includes('结果超过') || huge.text.includes('已截断'), huge.text.slice(-160));

console.log('\n脚本产出 ops 与图片');
const goodOps = await run("emit({'ops': [{'op': 'addLevel', 'name': 'PY 标高', 'elevation': 1.2}]})");
check('合法 ops 通过 dry-run', goodOps.report.opsCount === 1 && goodOps.ops[0]?.op === 'addLevel', goodOps.report.errors);
const badOps = await run("emit({'ops': [{'op': '不存在的指令'}]})");
check('非法 ops 被校验挡下', badOps.report.opsCount === 0 && badOps.ops.length === 0
  && badOps.text.includes('没有应用'), badOps.text.slice(0, 200));

const imageCode = [
  "from PIL import Image",
  'import io, base64',
  "im = Image.new('RGB', (16, 16), 'white')",
  "b = io.BytesIO(); im.save(b, format='PNG')",
  "url = 'data:image/png;base64,' + base64.b64encode(b.getvalue()).decode()",
  "emit({'images': [{'name': '测试贴图', 'dataUrl': url}], 'ops': [{",
  "  'op': 'addSolid', 'name': '贴图测试', 'level': '标高 1',",
  "  'features': [{'label': '胎', 'shape': {'shape': 'box', 'width': 0.1, 'depth': 0.1, 'height': 0.1},",
  "                'material': {'map': 'python:1'}}]}]})",
].join('\n');
const image = await run(imageCode);
const materialMap = image.ops?.[0]?.features?.[0]?.material?.map;
check('PIL 图片被收录', image.report.images === 1, image.report.errors);
check('python:1 占位符换成内联 PNG', typeof materialMap === 'string' && materialMap.startsWith('data:image/png;base64,'),
  typeof materialMap === 'string' ? materialMap.slice(0, 40) : materialMap);
check('回执里只有引用标记、没有 base64 本体', !image.text.includes('data:image/png;base64,'), image.text.slice(0, 200));

const combined = await runPythonTool([{ code: "emit({'result': 1})" }], { document: doc, ops: [{ op: 'addSolid', name: '模型自己的', features: [{ label: 'x', shape: { shape: 'box', width: 1, depth: 1, height: 1 }, material: { map: 'python:1' } }] }] });
check('ops 参数原样保留', combined.ops.length === 1 && combined.ops[0]?.name === '模型自己的', combined.ops);
const empty = await runPythonTool([], { document: doc, ops: [{ op: 'addLevel', name: 'X', elevation: 0 }] });
check('没有 python 请求时不改 ops', empty.ops.length === 1 && empty.text === '', empty);

console.log('\n第三方库与状态');
const numpyCode = "import numpy as np\nemit({'result': np.linspace(0, 1, 5).tolist()})";
const numpy = await run(numpyCode);
check('numpy 在沙箱内可用（或明确报缺依赖）', numpy.report.ok === 1 || numpy.report.errors[0]?.includes('numpy'), numpy.report.errors);
const ocp = await run("from OCP.Bnd import Bnd_Box\nfrom OCP.gp import gp_Pnt\nb = Bnd_Box(); b.Add(gp_Pnt(1,2,3))\nemit({'result': list(b.Get())})");
check('OCP 在沙箱内可用（或明确报缺依赖）', ocp.report.ok === 1 || ocp.report.errors[0]?.includes('OCP'), ocp.report.errors);

const status = pythonStatus();
check('状态标出后端与隔离级别', typeof status.isolated === 'boolean' && typeof status.mode === 'string', status);
check('非容器模式给出警告', status.isolated || typeof status.warning === 'string', status);

console.log(`\nPython 沙箱测试 ${passed} 项通过${failed ? `，${failed} 项失败` : ''}`);
if (failed) process.exit(1);
