/**
 * 零件合并 CLI：零件 Agent 的 manifest + 拼接 Agent 的 placements → 唯一 addSolid。
 *
 * 用法（npm script 会先用 esbuild 打包）：
 *   node .tmp/merge-parts.mjs <assembly.json> [输出.ops.json]
 *
 * 不给输出路径时只做校验并打印报告（不落盘），适合拼接 Agent 先试算再决定。
 * 输出是长度为 1 的 ops 数组，可直接 POST /api/projects/:id/ai/apply，
 * 也可以交给 model-query 做摆放后的表面/接触复核。
 */
import fs from 'node:fs';
import path from 'node:path';
import { AssemblyError, formatReport, mergeAssembly, type AssemblySpec } from './lib/assembly';

const args = process.argv.slice(2);
if (!args[0]) {
  console.error('用法：node .tmp/merge-parts.mjs <assembly.json> [输出.ops.json]');
  process.exit(2);
}
const specPath = path.resolve(args[0]);
if (!fs.existsSync(specPath)) {
  console.error(`装配说明不存在：${specPath}`);
  process.exit(2);
}

try {
  const spec = JSON.parse(fs.readFileSync(specPath, 'utf8')) as AssemblySpec;
  const { ops, report } = mergeAssembly(spec);
  console.log(formatReport(report));
  if (args[1]) {
    const out = path.resolve(args[1]);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, JSON.stringify(ops, null, 2), 'utf8');
    console.log(`已写出 ${out}（1 条 addSolid）`);
  } else {
    console.log('（未给输出路径，只做校验；加第二个参数即可落盘）');
  }
} catch (error) {
  if (error instanceof AssemblyError) {
    console.error(`装配校验失败：${error.message}`);
    if (error.detail.hint) console.error(`  建议：${error.detail.hint}`);
    if (error.detail.part) console.error(`  零件：${error.detail.part}`);
  } else {
    console.error(`合并失败：${error instanceof Error ? error.message : String(error)}`);
  }
  process.exit(1);
}
