/**
 * 只读几何查询 CLI —— 给拼接 Agent / 贴合件 Agent 用的「尺子」。
 *
 * 用法（先由 npm script 用 esbuild 打成 .tmp/model-query.mjs）：
 *   node .tmp/model-query.mjs <模型文件> <请求 JSON 或请求文件> [输出文件]
 *
 * 模型文件可以是：ops.json（addSolid 指令数组）、装配说明（{parts,placements}）、
 * 模型库文档（{features}）或裸特征树数组。请求是一个数组，最多建议 6 条：
 *
 *   [
 *     { "type": "parts" },
 *     { "type": "bounds", "part": "车身主体" },
 *     { "type": "ray", "origin": [2, 0.8, 1.2], "direction": [0, -1, 0] },
 *     { "type": "surface", "axis": "z", "at": [1.2, 0.6] },
 *     { "type": "gap", "a": "后视镜支座", "b": "车身主体" },
 *     { "type": "sample", "axis": "z", "grid": { "a": [-2, 2, 9], "b": [-0.8, 0.8, 5] } }
 *   ]
 *
 * 不指定请求文件时会输出零件清单 + 整体包围盒。全程只读，不改任何模型文件。
 */
import fs from 'node:fs';
import path from 'node:path';
import { runQueries, type QueryRequest } from './lib/query';

function usage(): never {
  console.error('用法：node .tmp/model-query.mjs <模型.json> [请求.json | 请求JSON字符串] [输出.json]');
  process.exit(2);
}

const args = process.argv.slice(2);
if (!args[0]) usage();
const modelPath = path.resolve(args[0]);
if (!fs.existsSync(modelPath)) {
  console.error(`模型文件不存在：${modelPath}`);
  process.exit(2);
}
const input: unknown = JSON.parse(fs.readFileSync(modelPath, 'utf8'));

let requests: QueryRequest[] = [{ type: 'parts' }, { type: 'bounds' }];
let outputPath: string | undefined;
if (args[1]) {
  const raw = args[1].trim();
  const parsed: unknown = raw.startsWith('[') || raw.startsWith('{')
    ? JSON.parse(raw)
    : JSON.parse(fs.readFileSync(path.resolve(raw), 'utf8'));
  const list = Array.isArray(parsed) ? parsed : [parsed];
  requests = list as QueryRequest[];
  outputPath = args[2] ? path.resolve(args[2]) : undefined;
}

try {
  const result = runQueries(input, requests);
  const json = JSON.stringify(result, null, 2);
  if (outputPath) {
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, json, 'utf8');
    console.log(`已写出 ${outputPath}（${requests.length} 条查询，只读）`);
  } else {
    console.log(json);
  }
} catch (error) {
  console.error(`查询失败：${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
