import { spawn } from 'node:child_process';

const isWindows = process.platform === 'win32';
const npmCmd = isWindows ? 'npm.cmd' : 'npm';

const children = [
  spawn(npmCmd, ['run', 'server'], { stdio: 'inherit', env: process.env }),
  spawn(npmCmd, ['run', 'dev'], { stdio: 'inherit', env: process.env }),
];

let closing = false;
function shutdown(code = 0) {
  if (closing) return;
  closing = true;
  for (const child of children) {
    if (!child.killed) child.kill('SIGTERM');
  }
  setTimeout(() => process.exit(code), 200);
}

for (const child of children) {
  child.on('exit', (code) => {
    if (!closing) shutdown(code ?? 0);
  });
  child.on('error', (error) => {
    console.error(error);
    shutdown(1);
  });
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));
console.log('StruBrowser dev: API http://127.0.0.1:8787 · Web http://localhost:5173');
