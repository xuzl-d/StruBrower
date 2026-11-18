/**
 * 准备 AI Python 工具的运行环境。
 *
 * 复用 STEP 转换器已有的 venv（server/convert/.venv），只补装缺的科学计算包；
 * 不重建 venv，避免把里面体积很大的 cadquery-ocp 弄丢。
 *
 * 用法：
 *   node scripts/setup-python-sandbox.mjs                 # numpy / Pillow
 *   node scripts/setup-python-sandbox.mjs --with-scipy   # 额外装 scipy（可选）
 *   node scripts/setup-python-sandbox.mjs --with-ocp      # 额外装 OCP + cadquery（很慢、镜像较大）
 *
 * scipy 在 Python 3.9 的 macOS 环境里常常没有可用 wheel、要从源码编译（十几分钟且易卡住），
 * 而 AI 脚本用 math + numpy 就够了：提示词已明确「不要 import scipy」，所以默认不装。
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const VENV = path.join(ROOT, 'server', 'convert', '.venv');
const isWin = process.platform === 'win32';
const PYTHON = path.join(VENV, isWin ? 'Scripts/python.exe' : 'bin/python');
const withOcp = process.argv.includes('--with-ocp');
const withScipy = process.argv.includes('--with-scipy');

function run(command, args, label) {
  console.log(`\n▶ ${label}\n  ${command} ${args.join(' ')}`);
  const result = spawnSync(command, args, { cwd: ROOT, stdio: 'inherit' });
  if (result.error) throw new Error(`${label} 启动失败：${result.error.message}`);
  if (result.status !== 0) throw new Error(`${label} 失败（退出码 ${result.status}）`);
}

if (!fs.existsSync(PYTHON)) {
  console.log('未找到 venv，先创建一个…');
  fs.mkdirSync(path.dirname(VENV), { recursive: true });
  run(isWin ? 'python' : 'python3', ['-m', 'venv', VENV], '创建 venv');
} else {
  console.log('复用已有 venv：', path.relative(ROOT, VENV));
}

const pip = [PYTHON, '-m', 'pip', 'install', '--disable-pip-version-check'];
run(pip[0], [...pip.slice(1), 'numpy', 'Pillow'], '安装 numpy / Pillow');

if (withScipy) {
  run(pip[0], [...pip.slice(1), '--only-binary=:all:', 'scipy<1.14'], '安装 scipy（可选，没有 wheel 会直接失败）');
}

if (withOcp) {
  run(pip[0], [...pip.slice(1), 'cadquery-ocp', 'cadquery'], '安装 OpenCascade 与 cadquery');
}

console.log('\n可用库探测：');
const probe = spawnSync(PYTHON, ['-c', [
  'import importlib.util as u',
  "mods = ['numpy', 'PIL', 'scipy', 'OCP', 'cadquery']",
  "print(', '.join(m + ('=ok' if u.find_spec(m) else '=缺失') for m in mods))",
].join('; ')], { cwd: ROOT, encoding: 'utf8' });
console.log(' ', (probe.stdout || '').trim() || probe.stderr?.trim() || '探测失败');

console.log('\nAI Python 工具配置（环境变量，服务端启动时读取）：');
console.log('  STRU_AI_PYTHON_MODE=auto|container|restricted|off   默认 auto（有容器镜像就走容器）');
console.log('  STRU_AI_PYTHON_TIMEOUT_MS=8000                       单段脚本超时');
console.log('  STRU_AI_PYTHON_IMAGE=stru-python-sandbox:latest      容器镜像名');
console.log('  STRU_PYTHON=<python 路径>                             覆盖解释器（默认用上面的 venv）');
console.log('\n硬隔离（推荐对外服务）：先启动 Docker，然后');
console.log('  docker build -t stru-python-sandbox:latest server/ai/python');
console.log('未启动 Docker 时会降级为「受限进程」模式，不是安全沙箱。');
