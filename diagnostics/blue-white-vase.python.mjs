/**
 * 「AI 写 Python 生成贴图 → 服务端沙箱执行 → 产出 addSolid」端到端示例。
 *
 * 与之前 JS 程序化纹理的区别：这张图完全由 Pillow 在 Python 沙箱里画出来，
 * 并通过 emit({'images': …, 'ops': …}) 直接产出可落库的特征树；
 * python:1 占位符由 python-runner.js 在 dry-run 之前换成内联 PNG。
 *
 * 运行：node diagnostics/blue-white-vase.python.mjs
 * 产出：diagnostics/blue-white-vase.python.ops.json
 *      diagnostics/blue-white-vase/python-texture.png（贴图本体，便于单独检查）
 */
import fs from 'node:fs';
import path from 'node:path';
import { runPythonTool } from '../server/ai/python-runner.js';

const ROOT = process.cwd();
const SOURCE = path.join(ROOT, 'diagnostics/blue-white-vase.textured.ops.json');
const OUT_OPS = path.join(ROOT, 'diagnostics/blue-white-vase.python.ops.json');
const OUT_PNG = path.join(ROOT, 'diagnostics/blue-white-vase/python-texture.png');

const source = JSON.parse(fs.readFileSync(SOURCE, 'utf8'));
const solid = JSON.parse(JSON.stringify(source[0]));
solid.name = 'Python 贴图青花瓷瓶';
solid.features[0].label = '薄壁瓶胎·Python 生成青花贴图';
solid.features[0].material.map = 'python:1';
const encodedOps = Buffer.from(JSON.stringify([solid]), 'utf8').toString('base64');

const code = `
from PIL import Image, ImageDraw, ImageFilter
import math, io, base64, json

W, H = 1024, 640
WHITE = (243, 241, 236)
INK = (18, 53, 110)
MID = (43, 98, 173)
PALE = (124, 175, 220)
SOFT = (198, 220, 240)

base = Image.new('RGB', (W, H), WHITE)
glow = Image.new('RGB', (W, H), WHITE)
d = ImageDraw.Draw(base)
gd = ImageDraw.Draw(glow)

def line(points, color, width=3):
    d.line(points, fill=color, width=width)
    if width > 3:
        gd.line(points, fill=SOFT, width=width * 4)

def poly(points, color, outline=INK):
    d.polygon(points, fill=color)
    d.line(list(points) + [points[0]], fill=outline, width=2)
    gd.polygon(points, fill=SOFT)

# 口沿 / 颈根 / 腹下 / 圈足的青花弦纹
for y, w, c in [(30, 4, INK), (44, 2, MID), (104, 4, INK), (116, 2, MID),
                (538, 3, INK), (550, 2, MID), (600, 4, INK), (612, 2, MID)]:
    line([(0, y), (W, y)], c, w)

# 颈部回纹带：连续方折，横向按周期重复，左右边缘可无缝拼接
unit = W / 24
for k in range(24):
    x = k * unit
    pts = [(x + 5, 98), (x + 5, 56), (x + unit - 11, 56),
           (x + unit - 11, 88), (x + 16, 88), (x + 16, 68), (x + unit - 22, 68)]
    line(pts, MID, 3)

# 腹部缠枝：三条正弦藤蔓 + 沿藤的尖叶
for phase, amp, width, color in [(0.0, 62, 5, INK), (1.9, 44, 4, MID), (3.6, 30, 3, PALE)]:
    vine = []
    for x in range(0, W + 1, 6):
        t = x / W * 2 * math.pi * 3 + phase
        y = 310 + amp * math.sin(t) + 18 * math.sin(2 * t + 0.6)
        vine.append((x, y))
    line(vine, color, width)

for k in range(30):
    x = (k + 0.5) * W / 30
    t = x / W * 2 * math.pi * 3
    y = 310 + 62 * math.sin(t) + 18 * math.sin(2 * t + 0.6)
    direction = 1 if k % 2 else -1
    tip = (x + direction * 22, y - 26)
    for shift in (-W, 0, W):
        poly([(x + shift, y), (x - 12 + shift, y - 10), (tip[0] + shift, tip[1]), (x + 12 + shift, y - 8)], MID)

# 主花：四朵八瓣莲，深浅交替；中心留白点蕊
def flower(cx, cy, r, color):
    for p in range(8):
        a = 2 * math.pi * p / 8
        tip = (cx + r * math.cos(a), cy + r * 0.86 * math.sin(a))
        left = (cx + r * 0.4 * math.cos(a - 0.44), cy + r * 0.4 * 0.86 * math.sin(a - 0.44))
        right = (cx + r * 0.4 * math.cos(a + 0.44), cy + r * 0.4 * 0.86 * math.sin(a + 0.44))
        poly([(cx, cy), left, tip, right], color)
        gd.ellipse([tip[0] - r * 0.3, tip[1] - r * 0.3,
                    tip[0] + r * 0.3, tip[1] + r * 0.3], fill=SOFT)
    d.ellipse([cx - r * 0.2, cy - r * 0.2, cx + r * 0.2, cy + r * 0.2],
              fill=WHITE, outline=INK, width=3)
    for p in range(6):
        a = 2 * math.pi * p / 6
        sx, sy = cx + r * 0.13 * math.cos(a), cy + r * 0.13 * math.sin(a)
        d.ellipse([sx - 2, sy - 2, sx + 2, sy + 2], fill=INK)

for i in range(4):
    cx = (i + 0.5) * W / 4
    cy = 250 if i % 2 == 0 else 390
    r = 60 if i % 2 == 0 else 46
    for shift in (-W, 0, W):
        flower(cx + shift, cy, r, INK if i % 2 == 0 else MID)

# 下腹仰莲瓣：尖朝上，底边贴弦纹
for k in range(16):
    cx = (k + 0.5) * W / 16
    for shift in (-W, 0, W):
        poly([(cx - 22 + shift, 596), (cx + 22 + shift, 596), (cx + shift, 556)], MID)

# 轻微晕染：模糊层与清晰层混合，模拟钴料在釉下的渗开
glow = glow.filter(ImageFilter.GaussianBlur(9))
im = Image.blend(glow, base, 0.76)

buf = io.BytesIO()
im.save(buf, format='PNG', optimize=True)
ops = json.loads(base64.b64decode('${encodedOps}').decode())
emit({
    'result': {'size': [W, H], 'bands': 8, 'flowers': 4, 'petals': 32, 'lotus': 16,
               'bytes': len(buf.getvalue())},
    'images': [{'name': 'Python 生成的青花缠枝莲柱面贴图',
                'dataUrl': 'data:image/png;base64,' + base64.b64encode(buf.getvalue()).decode()}],
    'ops': ops,
})
`;

// dry-run 需要一份结构完整的空文档（模型库文档是特征树，不能直接喂 applyOps）
const document = {
  schemaVersion: 2, id: 'python-demo', name: 'Python 贴图示例', units: 'metric',
  levels: [{ id: 'l1', name: '标高 1', elevation: 0 }],
  grids: [], materials: [], types: [], elements: [],
};
const result = await runPythonTool([{ code, note: 'Pillow 生成青花贴图 + 产出 addSolid' }], { document });
console.log('执行报告:', JSON.stringify({
  ok: result.report.ok, failed: result.report.failed, mode: result.report.mode,
  isolated: result.report.isolated, opsCount: result.report.opsCount,
  images: result.report.images, ms: result.report.ms, errors: result.report.errors,
}, null, 2));
if (!result.ops.length) throw new Error('Python 没有产出可用的 ops');
if (result.report.errors.length) console.log('校验提示:', result.report.errors.join('；'));

const map = result.ops[0]?.features?.[0]?.material?.map;
if (typeof map !== 'string' || !map.startsWith('data:image/png;base64,')) {
  throw new Error('python:1 没有被替换成内联图片');
}
fs.writeFileSync(OUT_OPS, `${JSON.stringify(result.ops, null, 2)}\n`);
fs.writeFileSync(OUT_PNG, Buffer.from(map.slice(map.indexOf(',') + 1), 'base64'));
console.log(`已写出 ${path.relative(ROOT, OUT_OPS)}（${fs.statSync(OUT_OPS).size} 字节）`);
console.log(`已写出 ${path.relative(ROOT, OUT_PNG)}（${fs.statSync(OUT_PNG).size} 字节）`);
console.log('脚本结果:', result.text.slice(0, 420).replace(/\n/g, ' | '));
