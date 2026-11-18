/**
 * 让服务端（纯 ESM JS，不经过打包）能用上 scripts/lib/*.ts 里的造型内核。
 *
 * 做法：首次调用时用 esbuild 把 scripts/lib/kernel-entry.ts 连 three / three-bvh-csg /
 * 服务端校验器一起打进 .tmp/ai-kernel.mjs，然后动态 import；一个进程只打一次并缓存。
 *
 * 为什么不提交产物：内核改一行就能立刻生效（重启进程即可），不需要额外构建步骤，
 * 也不会出现「源码改了、服务端还在用旧 bundle」这种最难查的错位。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const ENTRY = path.join(ROOT, 'scripts', 'lib', 'kernel-entry.ts');
const OUT = path.join(ROOT, '.tmp', 'ai-kernel.mjs');

let cached = null;

async function buildKernel() {
  let esbuild;
  try {
    esbuild = await import('esbuild');
  } catch {
    throw new Error('缺少 esbuild：请先运行 npm install（vite 的依赖里自带，也可用 npm i -D esbuild 单独安装）');
  }
  await fs.mkdir(path.dirname(OUT), { recursive: true });
  try {
    await esbuild.build({
      entryPoints: [ENTRY],
      bundle: true,
      platform: 'node',
      format: 'esm',
      target: 'node20',
      outfile: OUT,
      logLevel: 'silent',
      // three 内部有可选的动态依赖，打包时不要去解析不存在的浏览器分支
      mainFields: ['module', 'main'],
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`几何内核打包失败：${detail.slice(0, 400)}`);
  }
  return import(pathToFileURL(OUT).href);
}

/** @returns {Promise<{ mergeAssembly: Function, validateAssembly: Function, runQueries: Function, ... }>} */
export function loadGeometryKernel() {
  if (!cached) {
    cached = buildKernel().catch((error) => {
      // 打一次失败不要永久毒化缓存：装好依赖 / 修好源码后重试还能成功
      cached = null;
      throw error;
    });
  }
  return cached;
}
