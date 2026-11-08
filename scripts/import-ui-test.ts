/**
 * 导入对话框的渲染冒烟测试（react-dom/server，不需要浏览器）。
 *
 * 覆盖两条分支：
 * - 正常模型：统计 / 轴向 / 单位下拉 / 最终尺寸都要渲染出来；
 * - SKP 这类 blocked：原因、步骤、预览图、内部流清单要渲染出来，且不出现「导入」按钮。
 *
 * 运行：npx esbuild scripts/import-ui-test.ts --bundle --platform=node --format=esm \
 *        --outfile=.tmp/import-ui-test.mjs --log-level=warning && node .tmp/import-ui-test.mjs
 */
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import ImportDialog from '../src/components/ImportDialog';
import { parseModelBuffer } from '../src/import';
import type { ImportedModel } from '../src/import';

let failures = 0;
function check(label: string, condition: boolean, detail = ''): void {
  if (condition) {
    console.log(`  ✓ ${label}`);
    return;
  }
  failures += 1;
  console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`);
}

function render(model: ImportedModel, fileName: string): string {
  return renderToString(createElement(ImportDialog, {
    fileName,
    model,
    onCancel: () => {},
    onConfirm: () => {},
  }));
}

function writeObj(): ArrayBuffer {
  const vertices = ['-1 -1 -1', '1 -1 -1', '1 1 -1', '-1 1 -1', '-1 -1 1', '1 -1 1', '1 1 1', '-1 1 1'];
  const faces = ['1 3 2', '1 4 3', '5 6 7', '5 7 8', '1 2 6', '1 6 5', '2 3 7', '2 7 6', '3 4 8', '3 8 7', '4 1 5', '4 5 8'];
  const text = [...vertices.map((vertex) => `v ${vertex}`), ...faces.map((face) => `f ${face}`)].join('\n');
  return new TextEncoder().encode(text).buffer as ArrayBuffer;
}

function writeSkp(): ArrayBuffer {
  // 与 import-test 相同的极简 CFB：root + meta.dat + model.dat + preview.png
  const SECTOR = 512;
  const padTo = (buffer: Buffer, size: number) => {
    const out = Buffer.alloc(size);
    buffer.copy(out, 0);
    return out;
  };
  const meta = padTo(Buffer.from('<meta><version>21.1.0</version><units>Inches</units></meta>'), 4096);
  const model = padTo(Buffer.from('proprietary'), 4096);
  const png = padTo(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), 4096);
  const streams = [['meta.dat', meta], ['model.dat', model], ['preview.png', png]] as const;
  const header = Buffer.alloc(SECTOR);
  Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]).copy(header, 0);
  header.writeUInt16LE(0x003e, 24);
  header.writeUInt16LE(0x0003, 26);
  header.writeUInt16LE(0xfffe, 28);
  header.writeUInt16LE(9, 30);
  header.writeUInt16LE(6, 32);
  header.writeUInt32LE(1, 44);
  header.writeUInt32LE(1, 48);
  header.writeUInt32LE(4096, 56);
  header.writeUInt32LE(0xfffffffe, 60);
  header.writeUInt32LE(0xfffffffe, 68);
  header.writeUInt32LE(0, 76);
  for (let i = 1; i < 109; i += 1) header.writeUInt32LE(0xffffffff, 76 + i * 4);
  const fat = Buffer.alloc(SECTOR, 0xff);
  fat.writeUInt32LE(0xfffffffe, 0);
  fat.writeUInt32LE(0xfffffffe, 4);
  let cursor = 2;
  const starts: number[] = [];
  for (const [, data] of streams) {
    const count = data.length / SECTOR;
    for (let i = 0; i < count; i += 1) {
      fat.writeUInt32LE(i === count - 1 ? 0xfffffffe : cursor + i + 1, (cursor + i) * 4);
    }
    starts.push(cursor);
    cursor += count;
  }
  const directory = Buffer.alloc(SECTOR);
  const writeEntry = (index: number, name: string, type: number, start: number, size: number) => {
    const offset = index * 128;
    Buffer.from(`${name}\0`, 'utf16le').copy(directory, offset);
    directory.writeUInt16LE(name.length * 2 + 2, offset + 64);
    directory.writeUInt8(type, offset + 66);
    directory.writeUInt32LE(0xffffffff, offset + 68);
    directory.writeUInt32LE(0xffffffff, offset + 72);
    directory.writeUInt32LE(0xffffffff, offset + 76);
    directory.writeUInt32LE(start, offset + 116);
    directory.writeUInt32LE(size, offset + 120);
  };
  writeEntry(0, 'Root Entry', 5, 0xfffffffe, 0);
  streams.forEach(([name, data], index) => writeEntry(index + 1, name, 2, starts[index]!, data.length));
  const output = Buffer.concat([header, fat, directory, ...streams.map(([, data]) => data)]);
  return output.buffer.slice(output.byteOffset, output.byteOffset + output.byteLength) as ArrayBuffer;
}

async function main(): Promise<void> {
  console.log('▶ 正常模型');
  const model = await parseModelBuffer('cube.obj', writeObj());
  const html = render(model, 'cube.obj');
  check('渲染出导入标题', html.includes('导入模型'));
  check('显示格式名', html.includes('OBJ'));
  check('显示三角面统计', html.includes('12'));
  check('显示导入后尺寸', /导入后尺寸/.test(html) && /2\.00 × 2\.00 × 2\.00 m/.test(html), html.slice(0, 0));
  // React 19 会在文本节点之间插入 <!-- -->，断言用结构而不是整句匹配
  check('有轴向 / 单位两个下拉', (html.match(/<select/g) ?? []).length === 2 && html.includes('向上轴') && html.includes('单位'));
  check('轴向默认跟随格式', /按格式（(<!-- -->)?Y 向上/.test(html));
  check('单位默认自动判断（米）', /自动判断（(<!-- -->)?米/.test(html));
  check('有导入按钮', html.includes('class="primary"') && /导入/.test(html) && !html.includes('无法直接导入'));

  console.log('\n▶ SKP（不可直接读几何）');
  const skp = await parseModelBuffer('plan.skp', writeSkp());
  const blockedHtml = render(skp, 'plan.skp');
  check('渲染出阻止标题', blockedHtml.includes('无法直接导入'));
  check('给出原因', blockedHtml.includes('专有编码'));
  check('给出转换步骤', blockedHtml.includes('导出') && blockedHtml.includes('COLLADA'));
  check('显示内嵌预览图', blockedHtml.includes('data:image/png'));
  check('列出容器内容', blockedHtml.includes('容器内容'));
  check('没有导入按钮', !/导入（/.test(blockedHtml));

  console.log(`\n${failures === 0 ? '全部通过' : `${failures} 项失败`}`);
  if (failures) process.exitCode = 1;
}

void main();
