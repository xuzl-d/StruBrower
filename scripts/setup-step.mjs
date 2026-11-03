/** 安装 STEP 服务端转换器依赖（Python + cadquery-ocp）。 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const convertDir = path.join(root, 'server', 'convert');
const venvDir = path.join(convertDir, '.venv');
const basePython = process.env.STRU_PYTHON_BASE ?? (process.platform === 'win32' ? 'python' : 'python3');
const venvPython = path.join(venvDir, process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');

function run(command, args) {
  console.log(`$ ${command} ${args.join(' ')}`);
  const result = spawnSync(command, args, { stdio: 'inherit' });
  if (result.error) {
    console.error(result.error.message);
    process.exit(1);
  }
  if (result.status !== 0) process.exit(result.status ?? 1);
}

if (!fs.existsSync(venvPython)) {
  console.log(`创建虚拟环境：${venvDir}`);
  run(basePython, ['-m', 'venv', venvDir]);
}

console.log('安装 cadquery-ocp（约 650 MB，首次需要几分钟）…');
run(venvPython, ['-m', 'pip', 'install', '--upgrade', 'pip']);
run(venvPython, ['-m', 'pip', 'install', 'cadquery-ocp']);

const check = spawnSync(venvPython, ['-c', 'import OCP; print("OCP ready")'], { stdio: 'inherit' });
if (check.status !== 0) {
  console.error('OCP 安装校验失败');
  process.exit(check.status ?? 1);
}
console.log('\nSTEP 转换器已就绪。重启服务端（npm run server）后生效。');
