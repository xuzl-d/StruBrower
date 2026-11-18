/**
 * Node 侧几何内核的统一入口。
 *
 * server/index.js 是纯 ESM JS、不经过打包，没法直接 import 这些 .ts 模块；
 * server/ai/kernel.js 会在首次用到时用 esbuild 把本文件打成一个自包含的 .mjs，
 * 让「应用内 AI 编排」和普通 CLI / 测试共用同一套合并器与查询内核。
 *
 * 这里只做 re-export，不放逻辑：避免出现两份实现。
 */
export {
  AssemblyError,
  assemblyFromOps,
  formatReport,
  mergeAssembly,
  tidy,
  validateAssembly,
} from './assembly';
export type {
  AssemblyReport,
  AssemblySpec,
  MergeResult,
  PartManifest,
  Placement,
} from './assembly';
export { QueryError, loadQueryModels, runQueries } from './query';
export type { QueryModel, QueryRequest } from './query';
