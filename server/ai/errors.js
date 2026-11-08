/**
 * AI 指令错误：applyOps 抛出后由 HTTP 层转成 400，不写库。
 * 单独成文件是为了让 solid.js（造型特征校验）与 ops.js 共用同一个类，避免循环依赖。
 */
export class OpsError extends Error {}
