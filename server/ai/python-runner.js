/**
 * AI 的 Python 工具：在受限子进程里跑模型写的脚本，把结果回灌给模型。
 *
 * 两种执行后端：
 * - container：Docker（`--network none`、只读根、非 root、CPU/内存/进程数限额），硬隔离；
 * - restricted：本机 Python 子进程 + bootstrap.py 的 AST / import / rlimit 限制，
 *   **不是硬隔离**，只用于本地开发或信任模型输出的场景。
 *
 * 默认 auto：有可用镜像就走容器，否则降级到 restricted 并在状态里明确 isolated=false。
 * 无论哪种后端，脚本输出都只是一个 JSON 信封；要落库必须再过 applyOps 的 dry-run。
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeSolidMap } from '../../shared/materials.js';
import { applyOps } from './ops.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SANDBOX_DIR = path.join(ROOT, 'server', 'ai', 'python');
const BOOTSTRAP = path.join(SANDBOX_DIR, 'bootstrap.py');
const VENV_PYTHON = path.join(ROOT, 'server', 'convert', '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
const IMAGE = process.env.STRU_AI_PYTHON_IMAGE ?? 'stru-python-sandbox:latest';
const RESULT_PREFIX = '__STRU_RESULT__';

export const MAX_PYTHON_SCRIPTS = 2;
export const MAX_SCRIPT_CHARS = 8000;
export const MAX_PYTHON_TEXT = 12000;
const MAX_STDOUT_BYTES = 256 * 1024;
const MAX_STDERR_BYTES = 32 * 1024;
const DEFAULT_TIMEOUT_MS = 8000;

export function pythonConfig() {
  const mode = String(process.env.STRU_AI_PYTHON_MODE ?? 'auto').toLowerCase();
  const timeoutMs = Number(process.env.STRU_AI_PYTHON_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS);
  return {
    mode: ['auto', 'container', 'restricted', 'off'].includes(mode) ? mode : 'auto',
    timeoutMs: Number.isFinite(timeoutMs) && timeoutMs >= 1000 ? Math.min(60000, Math.round(timeoutMs)) : DEFAULT_TIMEOUT_MS,
    python: process.env.STRU_PYTHON ?? (fs.existsSync(VENV_PYTHON) ? VENV_PYTHON : (process.platform === 'win32' ? 'python' : 'python3')),
    image: IMAGE,
  };
}

let dockerChecked = null;
function dockerReady() {
  if (dockerChecked !== null) return dockerChecked;
  try {
    const probe = spawnSync('docker', ['image', 'inspect', IMAGE], { timeout: 6000, encoding: 'utf8' });
    dockerChecked = probe.status === 0;
  } catch {
    dockerChecked = false;
  }
  return dockerChecked;
}

/** 给状态端点 / 审计用：当前到底跑在哪个后端、是不是硬隔离 */
export function pythonStatus() {
  const config = pythonConfig();
  const pythonOk = fs.existsSync(config.python) || config.python === 'python3' || config.python === 'python';
  const containerReady = dockerReady();
  const mode = config.mode === 'off' ? 'off'
    : config.mode === 'container' ? (containerReady ? 'container' : 'restricted')
      : config.mode === 'restricted' ? 'restricted'
        : (containerReady ? 'container' : 'restricted');
  return {
    enabled: mode !== 'off' && pythonOk,
    mode,
    isolated: mode === 'container',
    containerReady,
    python: config.python,
    pythonOk,
    timeoutMs: config.timeoutMs,
    image: IMAGE,
    warning: mode === 'restricted'
      ? '未启用 Docker 容器：当前是受限进程模式（AST/import/资源限额），不是安全沙箱，不要在对外服务里执行不可信脚本'
      : null,
  };
}

function visitMaterials(value, visit) {
  if (Array.isArray(value)) {
    for (const item of value) visitMaterials(item, visit);
    return;
  }
  if (!value || typeof value !== 'object') return;
  if (value.material && typeof value.material === 'object') visit(value.material);
  for (const [key, child] of Object.entries(value)) {
    if (key === 'material') continue;
    visitMaterials(child, visit);
  }
}

/** emit 出来的图片：只收 data URL，归一化后编号，供本轮 ops 里 `python:N` 引用 */
function collectImages(raw, report) {
  const out = [];
  for (const item of Array.isArray(raw) ? raw : []) {
    if (!item || typeof item !== 'object') continue;
    const dataUrl = normalizeSolidMap(item.dataUrl);
    if (!dataUrl) {
      report.errors.push('脚本产出的图片不是合规的 data:image/... 或超过体积上限，已丢弃');
      continue;
    }
    out.push({ name: String(item.name ?? `脚本图片 ${out.length + 1}`).slice(0, 60), dataUrl });
  }
  return out.slice(0, 4);
}

/** 把本轮 ops 里的 material.map: "python:N" 换成脚本产出的图片 */
function resolvePythonImages(ops, images) {
  if (!images.length || !Array.isArray(ops)) return { ops, used: [] };
  const used = new Set();
  visitMaterials(ops, (material) => {
    // 颜色图与凹凸图都能引用脚本画出来的图片；占位符越界时凹凸图直接删掉，
    // 不能写 'ai:…'（normalizeSolidBumpMap 不接受提示词，会让整轮 ops 被判非法）
    for (const key of ['map', 'bumpMap']) {
      if (typeof material[key] !== 'string') continue;
      const match = /^python:(\d+)$/.exec(material[key].trim());
      if (!match) continue;
      const image = images[Number(match[1]) - 1];
      if (!image) {
        if (key === 'map') material.map = 'ai:占位符越界';
        else delete material.bumpMap;
        continue;
      }
      material[key] = image.dataUrl;
      used.add(image.name);
    }
  });
  return { ops, used: [...used] };
}

function spawnScript(code, { mode, timeoutMs, python }, { signal } = {}) {
  return new Promise((resolve) => {
    const args = mode === 'container'
      ? [
        'run', '--rm', '-i', '--network', 'none', '--read-only',
        '--tmpfs', '/tmp:rw,size=64m', '--pids-limit', '64', '--cpus', '1',
        '--memory', '512m', '--user', '65534:65534',
        // bootstrap.py 已 COPY 进镜像，不再挂载宿主路径（避免 Windows Docker Desktop 文件共享限制）
        IMAGE,
        'python', '-I', '-B', '/sandbox/bootstrap.py',
      ]
      : ['-I', '-B', BOOTSTRAP];
    const command = mode === 'container' ? 'docker' : python;
    const payload = JSON.stringify({ code, timeout: Math.ceil(timeoutMs / 1000), max_result_chars: MAX_PYTHON_TEXT });

    let child;
    try {
      child = spawn(command, args, {
        cwd: mode === 'container' ? ROOT : os.tmpdir(),
        env: mode === 'container'
          ? { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: '/tmp' }
          : { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: os.tmpdir(), MPLCONFIGDIR: os.tmpdir(), PYTHONNOUSERSITE: '1' },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (error) {
      resolve({ ok: false, error: `无法启动 Python 沙箱：${error.message}` });
      return;
    }

    let stdout = '';
    let stderr = '';
    let settled = false;
    let killedBy = '';
    let timer = null;
    let onAbort = null;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (onAbort) signal?.removeEventListener('abort', onAbort);
      resolve(value);
    };
    const kill = (reason) => {
      killedBy = reason;
      try { child.kill('SIGKILL'); } catch { /* 已经退出 */ }
    };
    timer = setTimeout(() => kill('timeout'), timeoutMs + 1500);
    onAbort = () => kill('aborted');
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }

    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      if (Buffer.byteLength(stdout) > MAX_STDOUT_BYTES) kill('stdout overflow');
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
      if (Buffer.byteLength(stderr) > MAX_STDERR_BYTES) kill('stderr overflow');
    });
    child.on('error', (error) => finish({ ok: false, error: `Python 进程出错：${error.message}` }));
    child.on('close', (code) => {
      if (killedBy) {
        finish({ ok: false, error: killedBy === 'timeout' ? `Python 脚本超时（上限 ${timeoutMs}ms）` : `Python 脚本被中止（${killedBy}）` });
        return;
      }
      const line = stdout.split('\n').reverse().find((text) => text.startsWith(RESULT_PREFIX));
      if (!line) {
        const detail = (stderr.trim() || stdout.trim()).split('\n').filter(Boolean).slice(-2).join(' ');
        const reason = code !== 0
          ? `进程被资源限额终止（退出码 ${code}）；通常是 CPU / 内存超限或脚本自己退出`
          : 'Python 沙箱没有返回结果';
        finish({ ok: false, error: `${reason}：${detail.slice(0, 300) || '进程无输出'}`, logs: '' });
        return;
      }
      try {
        finish(JSON.parse(line.slice(RESULT_PREFIX.length)));
      } catch (error) {
        finish({ ok: false, error: `Python 沙箱返回不是 JSON：${error.message}` });
      }
    });

    child.stdin.on('error', () => { /* 进程提前退出时 stdin 会 EPIPE，忽略 */ });
    child.stdin.end(payload);
  });
}

/**
 * 抽出「脚本已执行后的合并阶段」：不在这里 spawn 子进程，只把模型本轮 ops 与
 * 脚本产出的 ops 合在一起，替换 python:N 占位符，再对脚本 ops 走一遍 dry-run。
 * 工具循环里脚本是边执行边回灌的（见 tools.js 的 run_python）；一次 plan 可能
 * 跨多轮、每段脚本都单独跑过，这里把结果汇总成一份供 withPythonTool 落库。
 *
 * @param {{ text?: string, ops?: Array, images?: Array, report?: object, requests?: Array }[]} executed
 *   工具循环里已执行好的每段脚本结果
 * @param {Array} modelOps 模型本轮 apply_bim_ops 写出的 ops
 * @returns {{ text: string, ops: Array, images: Array, report: object, requests: Array }}
 */
export function collectPythonToolResult(executed, modelOps = [], document = null) {
  const list = Array.isArray(executed) ? executed : [];
  const base = Array.isArray(modelOps) ? modelOps : [];
  // 按「先模型、后脚本」拼顺序；多段脚本按执行先后追加。
  const scriptOps = list.flatMap((item) => (Array.isArray(item?.ops) ? item.ops : []));
  const images = list.flatMap((item) => (Array.isArray(item?.images) ? item.images : []));
  const requests = list.flatMap((item) => (Array.isArray(item?.requests) ? item.requests : []));
  const text = list.map((item) => (typeof item?.text === 'string' ? item.text : '')).filter(Boolean).join('\n\n');
  const merged = [...base, ...scriptOps];

  // 脚本 ops 已在各段独立执行时 dry-run 过；这里对合并后的脚本部分复审一次，
  // 失败只摘掉脚本产出的那部分，保留模型自己写的 ops（与 runPythonTool 行为一致）。
  let finalOps = merged;
  const errors = [];
  if (scriptOps.length) {
    const copy = document ? JSON.parse(JSON.stringify(document)) : { levels: [], grids: [], types: [], materials: [], elements: [], name: 'python' };
    try {
      applyOps(copy, scriptOps);
    } catch (error) {
      const message = `脚本产出的 ops 合并后未通过校验：${error instanceof Error ? error.message : String(error)}`.slice(0, 300);
      errors.push(message);
      finalOps = base;
    }
  }

  // 占位符替换要在合并后做一次：模型 ops 里写的 python:N 引用的是本轮任意一段脚本的图片。
  const resolved = resolvePythonImages(finalOps, images);
  const report = {
    mode: 'off', isolated: false, scripts: list.length, ok: 0, failed: 0,
    opsCount: scriptOps.length, images: images.length, ms: 0, errors,
  };
  for (const item of list) {
    const r = item?.report;
    if (!r || typeof r !== 'object') continue;
    report.mode = r.mode && r.mode !== 'off' ? r.mode : report.mode;
    report.isolated = report.isolated || r.isolated === true;
    report.ok += Number(r.ok) || 0;
    report.failed += Number(r.failed) || 0;
    report.ms += Number(r.ms) || 0;
    if (Array.isArray(r.errors)) report.errors.push(...r.errors.map((e) => String(e).slice(0, 300)));
    if (r.warning) report.warning = r.warning;
  }
  return { text, ops: resolved.ops, images, report, requests, used: resolved.used };
}

/**
 * 执行一轮 AI 请求里的所有 python 脚本。
 * @returns {{ text: string, ops: Array, images: Array, report: Object }}
 *   text 回灌给模型；ops 已过 dry-run；images 供 python:N 引用；report 给前端气泡。
 */
export async function runPythonTool(requests, { document, ops, onEvent, signal } = {}) {
  const list = Array.isArray(requests) ? requests : [];
  const modelOps = Array.isArray(ops) ? ops : [];
  const empty = () => ({ text: '', ops: modelOps, images: [], report: { mode: 'off', isolated: false, scripts: 0, ok: 0, failed: 0, opsCount: 0, images: 0, ms: 0, errors: [] } });
  if (!list.length) return empty();
  const status = pythonStatus();
  const report = {
    mode: status.mode,
    isolated: status.isolated,
    scripts: list.length,
    ok: 0,
    failed: 0,
    opsCount: 0,
    images: 0,
    ms: 0,
    errors: [],
    ...(status.warning ? { warning: status.warning } : {}),
  };
  if (!status.enabled) return { ...empty(), report };

  const started = Date.now();
  // 用 pythonStatus 解析后的模式执行：container 显式指定但镜像缺失时会降级为 restricted，
  // spawnScript 必须跟随这个降级结果，否则会去找不存在的镜像而失败。
  const spawnOpts = { ...pythonConfig(), mode: status.mode };
  const chunks = [];
  const allOps = [];
  const allImages = [];

  for (let index = 0; index < list.length; index += 1) {
    const request = list[index];
    onEvent?.({ type: 'status', text: `正在执行 Python 脚本 ${index + 1}/${list.length}（${status.isolated ? '容器隔离' : '受限进程'}）…` });
    const envelope = await spawnScript(request.code, spawnOpts, { signal });
    const label = `【Python ${index + 1}${request.note ? ` · ${request.note}` : ''}】`;
    if (!envelope.ok) {
      report.failed += 1;
      report.errors.push(String(envelope.error ?? '未知错误').slice(0, 300));
      chunks.push(`${label} 执行失败：${envelope.error}\n按错误改脚本后重新调用 python 工具，不要假装已经算出来了。`);
      continue;
    }
    report.ok += 1;
    if (envelope.result !== undefined && envelope.result !== null) {
      chunks.push(`${label} 计算结果：\n${JSON.stringify(envelope.result, null, 2)}`);
    }
    if (envelope.logs) chunks.push(`${label} 输出：\n${String(envelope.logs).slice(0, 2000)}`);
    if (!envelope.result && !envelope.logs && !envelope.ops?.length && !envelope.images?.length) {
      chunks.push(`${label} 脚本执行完毕但没有 emit() 任何结果；用 emit({'result': ...}) 提交结果。`);
    }
    if (Array.isArray(envelope.ops)) allOps.push(...envelope.ops.slice(0, 200));
    const images = collectImages(envelope.images, report);
    for (const image of images) allImages.push(image);
  }

  // 先替换 python:N 再 dry-run：materialSpec 不认占位符，顺序反了会把合法贴图判成非法 map。
  // 模型自己写的 ops 里也可能引用 python:N，所以合并后统一替换。
  const merged = [...modelOps, ...allOps];
  const resolved = resolvePythonImages(merged, allImages);

  // 脚本产出的 ops 必须和模型自己写的 ops 走同一道校验，不能绕过
  if (allOps.length) {
    try {
      const copy = document ? JSON.parse(JSON.stringify(document)) : { levels: [], grids: [], types: [], materials: [], elements: [], name: 'python' };
      applyOps(copy, allOps);
      report.opsCount = allOps.length;
    } catch (error) {
      report.errors.push(`脚本产出的 ops 未通过校验：${error instanceof Error ? error.message : String(error)}`.slice(0, 300));
      chunks.push(`【Python ops 校验失败】${report.errors.at(-1)}\n这些 ops 没有应用，请按提示改脚本，不要重复输出同样的指令。`);
      // 只摘掉脚本产出的那部分，模型自己写的 ops 仍然保留
      resolved.ops = merged.slice(0, modelOps.length);
      report.opsCount = 0;
    }
  }

  report.images = allImages.length;
  report.ms = Date.now() - started;
  let text = chunks.join('\n\n');
  if (allImages.length) {
    text += `\n\n脚本图片（本轮有效）：${allImages.map((image, index) => `python:${index + 1} = ${image.name}`).join('；')}。`
      + '在本轮 ops 的 material.map 里写 "python:N" 即可贴上，跨轮不保留，需要重新生成。';
  }
  if (resolved.used.length) text += `\n已贴图：${resolved.used.join('、')}。`;
  if (text.length > MAX_PYTHON_TEXT) {
    text = `${text.slice(0, MAX_PYTHON_TEXT)}\n…（Python 工具结果共 ${text.length} 字，已截断；请在脚本里只 emit 关键数值）`;
  }
  return { text, ops: resolved.ops, images: allImages, report };
}
