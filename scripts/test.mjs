/**
 * 一键后端验证：启动一个临时数据库的服务端 → 跑 HTTP 接口测试与客户端数据层测试 → 清理。
 * 用法：npm test
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as esbuild from 'esbuild';

const root = process.cwd();
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'strubrowser-test-'));
const port = 8791;
const base = `http://127.0.0.1:${port}`;
const env = {
  ...process.env,
  PORT: String(port),
  STRU_DATA_DIR: dataDir,
  STRU_ADMIN_EMAILS: 'admin-test@example.com',
  // 集成测试会连发几十次 AI 请求（含看图链路的校验用例），默认 30 次/分钟会误伤
  STRU_AI_RATE_LIMIT: '400',
};

const server = spawn(process.execPath, ['--experimental-sqlite', 'server/index.js'], {
  cwd: root,
  env,
  stdio: 'inherit',
});

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForHealth(timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${base}/api/health`);
      if (response.ok) return;
    } catch {
      // 还没起来
    }
    await sleep(200);
  }
  throw new Error('服务端未在超时时间内就绪');
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: root, env: { ...env, BASE: base }, stdio: 'inherit' });
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${command} 退出码 ${code}`))));
    child.on('error', reject);
  });
}

function shutdown() {
  if (!server.killed) server.kill('SIGTERM');
  fs.rmSync(dataDir, { recursive: true, force: true });
}

let exitCode = 0;
try {
  await waitForHealth();
  // 先跑系统管理测试：它依赖“首个注册用户/指定邮箱即系统管理员”的引导规则
  await run(process.execPath, ['scripts/admin-test.mjs']);
  await run(process.execPath, ['scripts/admin-console-test.mjs']);
  await run(process.execPath, ['scripts/deploy-test.mjs']);
  await run(process.execPath, ['scripts/limits-test.mjs']);
  await run(process.execPath, ['scripts/api-test.mjs']);
  await run(process.execPath, ['scripts/collab-test.mjs']);
  await run(process.execPath, ['scripts/ai-test.mjs']);
  await run(process.execPath, ['scripts/ai-conversation-test.mjs']);
  await run(process.execPath, ['scripts/ai-attachments-test.mjs']);
  await run(process.execPath, ['scripts/ai-provider-test.mjs']);
  await run(process.execPath, ['scripts/ai-memory-test.mjs']);
  await run(process.execPath, ['scripts/ai-budget-test.mjs']);
  await run(process.execPath, ['scripts/inspect-test.mjs']);
  await run(process.execPath, ['scripts/step-convert-test.mjs']);

  fs.mkdirSync(path.join(root, '.tmp'), { recursive: true });
  for (const name of ['client-repo-test', 'diff-test', 'step-decode-test', 'import-test', 'box-select-test', 'bim-edit-test', 'settings-test', 'snap-test', 'modify-test', 'ifc-schedule-test', 'layer-material-test', 'parameter-test', 'history-test', 'coordinate-test', 'viewport-test', 'agent-loop-test', 'solid-test', 'template-test', 'parametric-test', 'constraint-test']) {
    const bundle = path.join(root, '.tmp', `${name}.mjs`);
    await esbuild.build({
      entryPoints: [path.join(root, 'scripts', `${name}.ts`)],
      bundle: true,
      platform: 'node',
      format: 'esm',
      outfile: bundle,
      logLevel: 'warning',
    });
    await run(process.execPath, [bundle]);
  }
  // 导入对话框走 React SSR 渲染，需要 automatic JSX + 依赖外部化（react-dom/server 是 CJS）
  await esbuild.build({
    entryPoints: [path.join(root, 'scripts', 'import-ui-test.ts')],
    bundle: true,
    platform: 'node',
    format: 'esm',
    packages: 'external',
    jsx: 'automatic',
    outfile: path.join(root, '.tmp', 'import-ui-test.mjs'),
    logLevel: 'warning',
  });
  await run(process.execPath, [path.join(root, '.tmp', 'import-ui-test.mjs')]);

  console.log('\n全部测试通过 ✅');
} catch (error) {
  console.error('\n测试失败：', error instanceof Error ? error.message : error);
  exitCode = 1;
} finally {
  shutdown();
  process.exit(exitCode);
}
