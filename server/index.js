import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import {
  canAdmin,
  canRead,
  canWrite,
  createToken,
  hashPassword,
  loadSecret,
  ROLES,
  validateCredentials,
  verifyPassword,
  verifyToken,
} from './auth.js';
import { applyOps, OpsError, summarizeOps } from './ai/ops.js';
import { buildProjectContext } from './ai/context.js';
import { describeOpsBrief, compactConversation, maybeSummarize } from './ai/memory.js';
import { contextWindowOf, describeUsage, estimateTokens } from './ai/budget.js';
import { createProvider, defaultReasoningEffort, resolveAiConfig } from './ai/provider.js';
import { planWithRepair } from './ai/repair.js';
import { ImageInputError, listModels, normalizeImages, quickMainSupportsImages } from './ai/vision.js';
import { applyAttachments, describeAttachments, parseAttachments } from './ai/attachments.js';
import { createSecretBox } from './crypto.js';
import { createRateLimiter } from './limits.js';
import { createStore } from './store.js';
import { validateDocument } from './validate.js';
import { attachCollabServer } from './ws.js';

const ROOT = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const PKG_VERSION = (() => {
  try {
    return JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
  } catch {
    return 'unknown';
  }
})();
const PORT = Number(process.env.PORT ?? 8787);
// 默认监听所有网卡，方便局域网/公网访问；只想本机访问可设 HOST=127.0.0.1
const HOST = process.env.HOST ?? '0.0.0.0';
const TRUST_PROXY = process.env.STRU_TRUST_PROXY === '1';
const AUTH_RATE_LIMIT = Number(process.env.STRU_AUTH_RATE_LIMIT ?? 60);
const AUTH_RATE_WINDOW_MS = 5 * 60 * 1000;
const INSTANCE_ID = process.env.STRU_INSTANCE_ID ?? `${os.hostname()}:${process.pid}`;
const STARTED_AT = new Date().toISOString();
// 重接口限流：进程内计数；多实例需要换成共享计数（见 docs/MULTI_INSTANCE.md）
const stepLimiter = createRateLimiter({ limit: Number(process.env.STRU_STEP_RATE_LIMIT ?? 6) });
const aiLimiter = createRateLimiter({ limit: Number(process.env.STRU_AI_RATE_LIMIT ?? 30) });
const DATA_DIR = process.env.STRU_DATA_DIR ?? path.join(ROOT, 'server', 'data');
const DB_FILE = process.env.STRU_DB ?? path.join(DATA_DIR, 'strubrowser.db');
const SECRET = loadSecret(path.join(DATA_DIR, 'secret'));
const DIST_DIR = path.join(ROOT, 'dist');
const ALLOWED_ORIGINS = (process.env.STRU_WEB_ORIGIN ?? 'http://localhost:5173,http://127.0.0.1:5173')
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean);
const ALLOW_REGISTER = (process.env.STRU_ALLOW_REGISTER ?? '1') !== '0';
const MAX_DOCUMENT_BYTES = Number(process.env.STRU_MAX_DOCUMENT_BYTES ?? 160 * 1024 * 1024);
const MAX_STEP_BYTES = Number(process.env.STRU_MAX_STEP_BYTES ?? 256 * 1024 * 1024);
const CONVERT_TIMEOUT_MS = Number(process.env.STRU_CONVERT_TIMEOUT_MS ?? 15 * 60 * 1000);
const CONVERT_DIR = path.join(ROOT, 'server', 'convert');
const CONVERT_SCRIPT = path.join(CONVERT_DIR, 'step_to_mesh.py');
const VENV_PYTHON = path.join(CONVERT_DIR, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
const PYTHON = process.env.STRU_PYTHON ?? (fs.existsSync(VENV_PYTHON) ? VENV_PYTHON : process.platform === 'win32' ? 'python' : 'python3');

const store = createStore(DB_FILE);
const secretBox = createSecretBox(SECRET);

// 环境变量里指定的邮箱自动提升为系统管理员（注册时也生效）
const ADMIN_EMAILS = new Set(
  (process.env.STRU_ADMIN_EMAILS ?? '')
    .split(',')
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean),
);
for (const email of ADMIN_EMAILS) {
  const user = store.findUserByEmail(email);
  if (user && !user.isAdmin) store.updateUser(user.id, { isAdmin: true });
}
// 兼容旧库：升级前注册的用户都没有 is_admin，把最早注册的用户提升为系统管理员
if (store.countSystemAdmins() === 0) {
  const existing = store.listAllUsers();
  if (existing.length > 0) {
    store.updateUser(existing[0].id, { isAdmin: true });
    console.log(`[admin] 已将最早注册的用户 ${existing[0].email} 提升为系统管理员`);
  }
}

/** AI 配置：数据库设置优先，其次环境变量；apiKey 加密存储、只在服务端解密。 */
const LEGACY_AI_TIMEOUT_MS = 60000;
const DEFAULT_AI_TIMEOUT_MS = 180000;

function loadAiConfig() {
  const envConfig = resolveAiConfig(process.env);
  const provider = store.getSetting('ai.provider') ?? envConfig.provider;
  const baseUrl = store.getSetting('ai.baseUrl') ?? envConfig.baseUrl;
  const model = store.getSetting('ai.model') ?? envConfig.model;
  const storedTimeout = store.getSetting('ai.timeoutMs');
  let timeoutMs = Number(storedTimeout ?? envConfig.timeoutMs);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) timeoutMs = DEFAULT_AI_TIMEOUT_MS;
  // 旧版本默认 60 s：thinking 类模型（deepseek-v4-pro / qwen3 等）出一个精细特征树常要 1–4 分钟，
  // 60 s 会被误判成超时。没手动改过的配置自动放宽到 3 分钟。
  if (timeoutMs === LEGACY_AI_TIMEOUT_MS) timeoutMs = DEFAULT_AI_TIMEOUT_MS;
  const storedKey = store.getSetting('ai.apiKey');
  const apiKey = (storedKey ? secretBox.open(storedKey) : '') || envConfig.apiKey;
  const normalizedProvider = provider === 'openai' ? 'openai' : 'mock';
  // 上下文窗口：留空按模型名推断；代理部署或私有量化模型可显式指定
  const storedContextTokens = Number(store.getSetting('ai.contextTokens') ?? 0);

  // 独立视觉模型：默认关闭，由用户在 AI 设置里显式开启；地址与 Key 都与主模型分开
  const storedVisionEnabled = store.getSetting('ai.visionEnabled');
  const storedVisionKey = store.getSetting('ai.visionApiKey');
  return {
    provider: normalizedProvider,
    baseUrl: String(baseUrl).replace(/\/+$/, ''),
    model,
    reasoningEffort: store.getSetting('ai.reasoningEffort') ?? (process.env.STRU_AI_REASONING_EFFORT !== undefined ? envConfig.reasoningEffort : defaultReasoningEffort(model, baseUrl)),
    apiKey,
    timeoutMs,
    contextTokens: Number.isFinite(storedContextTokens) && storedContextTokens > 0
      ? storedContextTokens
      : envConfig.contextTokens,
    vision: {
      enabled: storedVisionEnabled === null ? envConfig.vision.enabled : storedVisionEnabled === '1',
      model: String(store.getSetting('ai.visionModel') ?? envConfig.vision.model ?? '').trim(),
      baseUrl: String(store.getSetting('ai.visionBaseUrl') ?? envConfig.vision.baseUrl ?? '').trim().replace(/\/+$/, ''),
      apiKey: (storedVisionKey ? secretBox.open(storedVisionKey) : '') || envConfig.vision.apiKey,
    },
    ready: normalizedProvider === 'mock' || Boolean(apiKey),
  };
}

let aiConfig = loadAiConfig();
let aiProvider = createProvider(aiConfig);

function refreshAi() {
  aiConfig = loadAiConfig();
  aiProvider = createProvider(aiConfig);
}

/** STEP -> 网格转换器（Python + OCP）可用性探测，用于保留 occt-import-js 回退路径。 */
const converter = { available: false, checked: false, python: PYTHON, error: '尚未检测' };

function probeConverter() {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    let child;
    try {
      child = spawn(PYTHON, ['-c', 'import OCP; print("ocp-ok")'], { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      finish({ available: false, error: error.message });
      return;
    }
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish({ available: false, error: '检测超时' });
    }, 20000);
    child.on('error', (error) => {
      clearTimeout(timer);
      finish({ available: false, error: error.message });
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      if (code === 0 && stdout.includes('ocp-ok')) finish({ available: true, error: null });
      else finish({ available: false, error: (stderr.trim() || `python 退出码 ${code}`).slice(0, 300) });
    });
  });
}

/** 把上传的 STEP 直接落盘，避免 100MB+ 文件占用内存。 */
function streamBodyToFile(req, limit) {
  return new Promise((resolve, reject) => {
    const file = path.join(os.tmpdir(), `stru-step-${Date.now()}-${Math.random().toString(16).slice(2)}.step`);
    const stream = fs.createWriteStream(file);
    let total = 0;
    let failed = false;
    const fail = (status, message) => {
      if (failed) return;
      failed = true;
      stream.destroy();
      fs.rm(file, { force: true }, () => {});
      reject(new HttpError(status, message));
    };
    req.on('data', (chunk) => {
      if (failed) return;
      total += chunk.length;
      if (total > limit) {
        fail(413, `STEP 文件超过上限（${Math.round(limit / 1024 / 1024)} MB）`);
        req.destroy();
        return;
      }
      if (!stream.write(chunk)) {
        req.pause();
        stream.once('drain', () => req.resume());
      }
    });
    req.on('end', () => {
      if (failed) return;
      stream.end(() => resolve({ file, bytes: total }));
    });
    req.on('error', (error) => {
      fail(400, error.message);
    });
    stream.on('error', (error) => {
      fail(500, `写入临时文件失败：${error.message}`);
    });
  });
}

function runStepConverter(inputFile) {
  const outputFile = `${inputFile}.bin`;
  return new Promise((resolve, reject) => {
    const child = spawn(PYTHON, [CONVERT_SCRIPT, '--input', inputFile, '--output', outputFile], { cwd: ROOT });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new HttpError(504, 'STEP 转换超时'));
    }, CONVERT_TIMEOUT_MS);
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(new HttpError(500, `无法启动转换器：${error.message}`));
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        const detail = (stderr || stdout).split('\n').filter(Boolean).slice(-2).join(' ');
        reject(new HttpError(500, `STEP 转换失败：${detail || `退出码 ${code}`}`));
        return;
      }
      resolve(outputFile);
    });
  });
}

class HttpError extends Error {
  constructor(status, message, extra) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

/* ------------------------------ HTTP 工具 ------------------------------ */

function applyCors(req, res) {
  const origin = req.headers.origin;
  if (origin && ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
  res.setHeader('Access-Control-Max-Age', '600');
}

function acceptsGzip(req) {
  return /\bgzip\b/.test(String(req?.headers['accept-encoding'] ?? ''));
}

function sendJson(res, status, body) {
  const raw = Buffer.from(JSON.stringify(body));
  if (raw.length > 1024 && acceptsGzip(res.req)) {
    const compressed = zlib.gzipSync(raw);
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Encoding': 'gzip',
      'Content-Length': compressed.length,
      'Cache-Control': 'no-store',
      Vary: 'Accept-Encoding',
    });
    res.end(compressed);
    return;
  }
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': raw.length,
    'Cache-Control': 'no-store',
  });
  res.end(raw);
}

/**
 * 打开一个 SSE 流：text/event-stream + 关缓冲，返回发送 / 心跳 / 断开判断三个能力。
 * 用于把 AI 的中间过程（思考、草稿、参数生成）实时推给前端。
 */
function beginEventStream(req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.socket?.setNoDelay?.(true);
  res.flushHeaders?.();

  let closed = false;
  res.on('close', () => { closed = true; });
  req.on('aborted', () => { closed = true; });

  return {
    closed: () => closed,
    send(event) {
      if (closed || res.writableEnded) return;
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    },
    comment(text = 'ping') {
      if (closed || res.writableEnded) return;
      res.write(`: ${text}\n\n`);
    },
    end() {
      if (!res.writableEnded) res.end();
    },
  };
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on('data', (chunk) => {
      total += chunk.length;
      if (total > limit) {
        reject(new HttpError(413, `请求体超过限制（${Math.round(limit / 1024 / 1024)} MB）`));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function readJson(req, limit = 1024 * 1024) {
  const body = await readBody(req, limit);
  if (!body.length) return {};
  try {
    return JSON.parse(body.toString('utf8'));
  } catch {
    throw new HttpError(400, '请求体不是合法 JSON');
  }
}

/** 带图请求的体积上限：图片以 base64 传输，比原始字节多约 1/3 */
const MAX_AI_BODY_BYTES = 14 * 1024 * 1024;

/** 图片校验（数量 / 格式 / 体积），错误转成 400 而不是 500 */
function parseImageBody(body) {
  try {
    return normalizeImages(body?.images);
  } catch (error) {
    if (error instanceof ImageInputError) throw new HttpError(400, error.message);
    throw error;
  }
}

/** 允许「只传图不写字」：此时给一句默认需求，模型照着图建模 */
/** 这次需求的那句话：没写字时按「只发了图 / 只发了文件」补一句，两者都没有才算缺需求 */
function aiMessageOf(body, images, attachments = []) {
  const text = String(body?.message ?? '').trim();
  if (text) return text;
  if (images.length) return '请参照这张图片把这个产品建出来（尺寸按图上比例估算）。';
  if (attachments.length) return '请参考这几个附件里的内容，把模型建出来。';
  throw new HttpError(400, '请输入需求描述，或上传一张参考图片 / 文本文件');
}

/** 会话里的参考图只留缩略图：原图几 MB，历史记录不该被图片撑爆 */
const MAX_THUMB_CHARS = 60000;

function parseThumbs(input) {
  if (!Array.isArray(input)) return [];
  return input
    .filter((item) => typeof item === 'string' && item.startsWith('data:image/') && item.length <= MAX_THUMB_CHARS)
    .slice(0, 4);
}

/**
 * 一次「发送」的幂等键：前端在自动重试时复用同一个值。
 * 服务端据此认出「这是同一条需求的第二次尝试」，不再重复插一条用户消息。
 */
function parseRequestId(body) {
  return typeof body?.requestId === 'string' ? body.requestId.trim().slice(0, 96) : '';
}

/**
 * 打开会话上下文（多轮对话的落点）：
 * - 滚动摘要 → 长期记忆，替代更早的原文
 * - 摘要之后的消息 → 本次请求的 history
 * - 当前这句用户需求立刻落库，即使生成失败也留在历史里
 * conversationId 缺省时返回 null，调用方退回「前端自带 history」的旧行为。
 */
function openConversation({ conversationId, projectId, userId, message, thumbs, shots = 0, internal = false, requestId = '' }) {
  if (typeof conversationId !== 'string' || !conversationId) return null;
  const conversation = store.getConversation(conversationId, { withMessages: false });
  if (!conversation) throw new HttpError(404, '会话不存在');
  if (conversation.projectId !== projectId) throw new HttpError(400, '该会话不属于当前项目');
  requireProjectRole(conversation.projectId, userId, 'read');
  const messages = store.listMessages(conversationId, { afterSeq: conversation.summarySeq, limit: 60 });
  // 前端自动重试：同一 requestId 复用上一轮已经落库的那条用户消息，
  // 否则重试两次历史里就会有两句一模一样的「车身不对」，还会被当成上下文再喂给模型。
  const reused = requestId
    ? messages.findLast((item) => item.role === 'user' && item.requestId === requestId) ?? null
    : null;
  // 重试时，上一轮失败留下的「生成中断」气泡既不该进上下文，也不该在聊天区留两条，标记出来删掉
  const stale = reused
    ? messages.filter((item) => item.seq > reused.seq && item.role === 'assistant' && item.error).map((item) => item.id)
    : [];
  const history = (reused ? messages.filter((item) => item.seq < reused.seq) : messages)
    .filter((item) => item.role === 'user' || item.role === 'assistant')
    .map((item) => {
      // 助手回复只存了自然语言，模型看不到自己上一轮到底改了什么，这里补一行指令标签
      const brief = item.role === 'assistant' ? describeOpsBrief(item.ops) : '';
      return { role: item.role, content: brief ? `${item.content}\n[本轮指令] ${brief}` : item.content };
    });
  // shots 标出末尾哪几张缩略图是「发送时自动附上的视口截图」：前端据此只把用户上传的那几张
  // 画成参考图，自动截图折成一个小提示（旧数据没有这个字段，前端按正文里的标记兜底）。
  const payload = {
    ...(thumbs.length ? { thumbs } : {}),
    ...(shots > 0 ? { shots: Math.min(thumbs.length, Math.trunc(shots)) } : {}),
    // 自检循环里前端代发的「[自检第 n 步] 图给你了」不算用户发言：仍进上下文，但不在聊天区显示
    ...(internal ? { internal: true } : {}),
    ...(requestId ? { requestId } : {}),
  };
  const saved = reused ?? store.appendMessage({
    conversationId,
    role: 'user',
    content: message,
    ...(Object.keys(payload).length ? { payload } : {}),
  });
  return {
    id: conversationId,
    memory: conversation.summary ?? '',
    history,
    userMessageId: saved.id,
    title: saved.title ?? conversation.title ?? null,
    /** 需要清掉的上一轮失败气泡（重试时才有） */
    stale,
  };
}

/** AI 回复落库：带上 ops / 耗时 / 读图信息 / 上下文用量，历史里回看还能知道当时生成了什么 */
function saveAssistantMessage(session, { reply, ops, summary, error, model, ms, repaired, warning, vision, inspect, context }) {
  if (!session) return null;
  return store.appendMessage({
    conversationId: session.id,
    role: 'assistant',
    content: reply ?? '',
    payload: {
      ...(error ? { error: true } : {}),
      ...(Array.isArray(ops) ? { ops } : {}),
      ...(summary ? { summary } : {}),
      ...(model ? { model } : {}),
      ...(Number.isFinite(ms) ? { ms } : {}),
      ...(repaired ? { repaired } : {}),
      ...(warning ? { warning } : {}),
      ...(vision ? { vision } : {}),
      ...(Array.isArray(inspect) && inspect.length ? { inspect } : {}),
      ...(context ? { context } : {}),
    },
  });
}

/**
 * 重试时清掉上一轮失败留下的「生成中断」气泡。
 * 不删的话：聊天区会并排两条一模一样的报错，历史还会把它们当上下文喂回模型。
 */
function dropStaleMessages(session) {
  if (!session?.stale?.length) return;
  for (const id of session.stale) {
    try {
      store.deleteMessage(session.id, id);
    } catch {
      /* 删不掉只是历史里多一条报错，不该影响这次生成 */
    }
  }
}

/**
 * 会话当前的上下文占用（不调模型，纯估算）：
 * 打开历史会话时先给个数字，用户才知道该不该点「压缩」。
 */
function conversationUsage(conversation) {
  if (!conversation?.id) return null;
  const pending = store.listMessages(conversation.id, { afterSeq: conversation.summarySeq ?? 0, limit: 400 })
    .filter((item) => (item.role === 'user' || item.role === 'assistant') && item.content);
  const historyTokens = estimateTokens(pending.map((item) => item.content).join('\n'));
  const memoryTokens = estimateTokens(conversation.summary ?? '');
  return {
    model: aiConfig.model,
    window: contextWindowOf(aiConfig.model, aiConfig.contextTokens),
    tokens: historyTokens + memoryTokens,
    breakdown: { memory: memoryTokens, history: historyTokens },
    historyItems: pending.length,
    compressed: 0,
    // 未压缩的部分能压到多小：简单给个「压完只剩摘要 + 最近 6 条」的估计
    estimatedAfter: memoryTokens + estimateTokens(pending.slice(-6).map((item) => item.content).join('\n')),
    canCompact: pending.length > 6,
  };
}

function userFromRequest(req) {  const header = req.headers.authorization ?? '';
  if (!header.startsWith('Bearer ')) return null;
  const payload = verifyToken(header.slice(7), SECRET);
  if (!payload) return null;
  return store.userById(payload.sub);
}

function requireUser(ctx) {
  if (!ctx.user) throw new HttpError(401, '请先登录');
  return ctx.user;
}

function requireProjectRole(projectId, userId, level = 'read') {
  const role = store.getMembership(projectId, userId);
  if (!role || !canRead(role)) throw new HttpError(404, '项目不存在或无权访问');
  if (level === 'write' && !canWrite(role)) throw new HttpError(403, '需要编辑权限');
  if (level === 'admin' && !canAdmin(role)) throw new HttpError(403, '需要管理权限');
  return role;
}

const authAttempts = new Map();

function clientIp(req) {
  if (TRUST_PROXY) {
    const forwarded = req.headers['x-forwarded-for'];
    if (typeof forwarded === 'string' && forwarded.trim()) {
      return forwarded.split(',')[0].trim();
    }
  }
  return req.socket.remoteAddress ?? 'unknown';
}

/** 登录/注册限流（默认 60 次 / 5 分钟 / IP；设 STRU_AUTH_RATE_LIMIT=0 可关闭） */
function checkAuthRate(req) {
  if (!Number.isFinite(AUTH_RATE_LIMIT) || AUTH_RATE_LIMIT <= 0) return;
  const now = Date.now();
  if (authAttempts.size > 5000) {
    for (const [ip, entry] of authAttempts) {
      if (entry.resetAt <= now) authAttempts.delete(ip);
    }
  }
  const ip = clientIp(req);
  const entry = authAttempts.get(ip);
  if (!entry || entry.resetAt <= now) {
    authAttempts.set(ip, { count: 1, resetAt: now + AUTH_RATE_WINDOW_MS });
    return;
  }
  entry.count += 1;
  if (entry.count > AUTH_RATE_LIMIT) {
    throw new HttpError(429, '登录/注册尝试过于频繁，请稍后再试');
  }
}

function publicUser(user) {
  return user
    ? {
      id: user.id,
      email: user.email,
      name: user.name,
      isAdmin: Boolean(user.isAdmin),
      createdAt: user.createdAt ?? null,
    }
    : null;
}

function enforceLimit(limiter, user, label) {
  const result = limiter.take(user.id);
  if (result.allowed) return;
  const error = new HttpError(429, `${label}调用过于频繁，请 ${result.retryAfterSec} 秒后重试`);
  error.extra = { retryAfterSec: result.retryAfterSec };
  throw error;
}

function requireSystemAdmin(ctx) {
  const user = requireUser(ctx);
  if (!user.isAdmin) throw new HttpError(403, '需要系统管理员权限');
  return user;
}

function aiSettingsView() {
  const stored = store.listSettings();
  return {
    provider: aiConfig.provider,
    baseUrl: aiConfig.baseUrl,
    model: aiConfig.model,
    reasoningEffort: aiConfig.reasoningEffort,
    visionEnabled: Boolean(aiConfig.vision?.enabled),
    visionModel: aiConfig.vision?.model ?? '',
    visionBaseUrl: aiConfig.vision?.baseUrl ?? '',
    hasVisionKey: Boolean(aiConfig.vision?.apiKey),
    visionKeyHint: aiConfig.vision?.apiKey ? `****${aiConfig.vision.apiKey.slice(-4)}` : '',
    timeoutMs: aiConfig.timeoutMs,
    /** 0 表示按模型名自动推断窗口（见 server/ai/budget.js） */
    contextTokens: aiConfig.contextTokens ?? 0,
    /** 实际生效的窗口：前端据此显示「用了多少 / 总共多少」 */
    contextWindow: contextWindowOf(aiConfig.model, aiConfig.contextTokens),
    hasKey: Boolean(aiConfig.apiKey),
    keyHint: aiConfig.apiKey ? `****${aiConfig.apiKey.slice(-4)}` : '',
    ready: aiConfig.ready,
    source: {
      provider: stored['ai.provider'] ? 'db' : 'env',
      baseUrl: stored['ai.baseUrl'] ? 'db' : 'env',
      model: stored['ai.model'] ? 'db' : 'env',
      visionModel: stored['ai.visionModel'] ? 'db' : (process.env.STRU_AI_VISION_MODEL ? 'env' : 'none'),
      visionBaseUrl: stored['ai.visionBaseUrl'] ? 'db' : (process.env.STRU_AI_VISION_BASE_URL ? 'env' : 'none'),
      visionApiKey: stored['ai.visionApiKey'] ? 'db' : (process.env.STRU_AI_VISION_API_KEY ? 'env' : 'none'),
      apiKey: stored['ai.apiKey'] ? 'db' : (process.env.STRU_AI_API_KEY || process.env.OPENAI_API_KEY ? 'env' : 'none'),
    },
  };
}

function roleOf(projectId, userId) {
  return store.getMembership(projectId, userId);
}

/* ------------------------------ 路由 ------------------------------ */

async function handleApi(ctx) {
  const { req, res, url } = ctx;
  const method = req.method;
  const pathname = url.pathname;
  let match;

  if (pathname === '/api/health' && method === 'GET') {
    return sendJson(res, 200, {
      ok: true,
      service: 'strubrowser-server',
      version: 2,
      instance: INSTANCE_ID,
      startedAt: STARTED_AT,
      uptimeSec: Math.round(process.uptime()),
      users: store.countUsers(),
      features: ['ai', 'collab', 'step-convert'],
      collab: collab.stats(),
      converter: { available: converter.available, python: converter.python },
      time: new Date().toISOString(),
    });
  }

  // 供负载均衡/容器编排做就绪检查（数据库可读即视为就绪）
  if (pathname === '/api/ready' && method === 'GET') {
    try {
      const users = store.countUsers();
      return sendJson(res, 200, { ready: true, instance: INSTANCE_ID, users });
    } catch (error) {
      return sendJson(res, 503, {
        ready: false,
        instance: INSTANCE_ID,
        error: error instanceof Error ? error.message : 'database unavailable',
      });
    }
  }

  /* ---------- 认证 ---------- */

  if (pathname === '/api/auth/register' && method === 'POST') {
    checkAuthRate(req);
    // 关闭注册后仍允许“库中还没有用户”时创建第一个管理员，避免锁死
    if (!ALLOW_REGISTER && store.countUsers() > 0) throw new HttpError(403, '服务端已关闭开放注册');
    const body = await readJson(req);
    const error = validateCredentials({ email: body.email, password: body.password, name: body.name });
    if (error) throw new HttpError(400, error);
    if (store.findUserByEmail(body.email)) throw new HttpError(409, '该邮箱已注册');
    const user = store.createUser({
      email: body.email,
      name: String(body.name).trim(),
      passwordHash: hashPassword(body.password),
      isAdmin: ADMIN_EMAILS.has(String(body.email).toLowerCase()) ? true : undefined,
    });
    store.audit(null, user.id, 'auth.register', { email: user.email });
    return sendJson(res, 201, { token: createToken(user, SECRET), user: publicUser(user) });
  }

  if (pathname === '/api/auth/login' && method === 'POST') {
    checkAuthRate(req);
    const body = await readJson(req);
    const record = body.email ? store.findUserByEmail(body.email) : null;
    if (!record || !verifyPassword(String(body.password ?? ''), record.passwordHash)) {
      throw new HttpError(401, '邮箱或密码不正确');
    }
    const user = store.userById(record.id);
    return sendJson(res, 200, { token: createToken(user, SECRET), user: publicUser(user) });
  }

  if (pathname === '/api/me' && method === 'GET') {
    const user = requireUser(ctx);
    return sendJson(res, 200, { user: publicUser(user) });
  }

  // 改自己的显示名称（账号中心 → 个人资料）
  if (pathname === '/api/me' && method === 'PATCH') {
    const user = requireUser(ctx);
    const body = await readJson(req);
    const name = String(body.name ?? '').trim();
    if (!name) throw new HttpError(400, '名称不能为空');
    if (name.length > 40) throw new HttpError(400, '名称最多 40 个字符');
    store.updateUser(user.id, { name });
    store.audit(null, user.id, 'auth.profile.update', { name });
    return sendJson(res, 200, { user: publicUser(store.userById(user.id)) });
  }

  // 改自己的密码（账号中心 → 安全）：必须验旧密码，按登录接口同样限流
  if (pathname === '/api/me/password' && method === 'POST') {
    checkAuthRate(req);
    const user = requireUser(ctx);
    const body = await readJson(req);
    const currentPassword = String(body.currentPassword ?? '');
    const newPassword = String(body.newPassword ?? '');
    if (newPassword.length < 6) throw new HttpError(400, '新密码至少 6 位');
    if (currentPassword === newPassword) throw new HttpError(400, '新密码不能与当前密码相同');
    const record = store.findUserByEmail(user.email);
    if (!record || !verifyPassword(currentPassword, record.passwordHash)) {
      throw new HttpError(400, '当前密码不正确');
    }
    store.updateUser(user.id, { passwordHash: hashPassword(newPassword) });
    store.audit(null, user.id, 'auth.password.change', {});
    return sendJson(res, 200, { ok: true });
  }

  if (pathname === '/api/users/lookup' && method === 'GET') {
    requireUser(ctx);
    const email = url.searchParams.get('email') ?? '';
    const user = store.findUserByEmail(email);
    return sendJson(res, 200, { user: user ? publicUser(user) : null });
  }

  /* ---------- 项目 ---------- */

  if (pathname === '/api/projects' && method === 'GET') {
    const user = requireUser(ctx);
    return sendJson(res, 200, { projects: store.listProjects(user.id) });
  }

  if (pathname === '/api/projects' && method === 'POST') {
    const user = requireUser(ctx);
    const body = await readJson(req, MAX_DOCUMENT_BYTES);
    const name = String(body.name ?? '').trim();
    if (!name) throw new HttpError(400, '项目名称不能为空');
    const document = body.document;
    const documentError = validateDocument(document);
    if (documentError) throw new HttpError(400, documentError);
    const requestedId = body.id === undefined ? undefined : String(body.id);
    if (requestedId !== undefined && !/^[A-Za-z0-9_-]{8,64}$/.test(requestedId)) {
      throw new HttpError(400, '项目 id 格式无效（8-64 位字母、数字、- 或 _）');
    }
    if (requestedId && store.getProject(requestedId)) throw new HttpError(409, '项目 id 已存在');
    const project = store.createProject({ name, ownerId: user.id, document, projectId: requestedId });
    return sendJson(res, 201, { project: { ...project, role: 'admin', rev: 1 } });
  }

  if ((match = pathname.match(/^\/api\/projects\/([^/]+)$/))) {
    const projectId = match[1];
    const user = requireUser(ctx);
    const role = requireProjectRole(projectId, user.id, method === 'GET' ? 'read' : 'admin');
    if (method === 'GET') {
      const project = store.getProject(projectId);
      const document = store.getDocument(projectId);
      return sendJson(res, 200, {
        project: { ...project, role, rev: document?.rev ?? 0, elementCount: document?.document.elements.length ?? 0 },
      });
    }
    if (method === 'PATCH') {
      const body = await readJson(req);
      const name = String(body.name ?? '').trim();
      if (!name) throw new HttpError(400, '项目名称不能为空');
      store.renameProject(projectId, name, user.id);
      return sendJson(res, 200, { project: { ...store.getProject(projectId), role } });
    }
    if (method === 'DELETE') {
      store.deleteProject(projectId, user.id);
      return sendJson(res, 200, { ok: true });
    }
  }

  /* ---------- 文档 ---------- */

  if ((match = pathname.match(/^\/api\/projects\/([^/]+)\/document$/))) {
    const projectId = match[1];
    const user = requireUser(ctx);
    if (method === 'GET') {
      requireProjectRole(projectId, user.id, 'read');
      const document = store.getDocument(projectId);
      if (!document) throw new HttpError(404, '项目文档不存在');
      return sendJson(res, 200, document);
    }
    if (method === 'PUT') {
      requireProjectRole(projectId, user.id, 'write');
      const body = await readJson(req, MAX_DOCUMENT_BYTES);
      const documentError = validateDocument(body.document);
      if (documentError) throw new HttpError(400, documentError);
      const result = store.saveDocument({
        projectId,
        document: body.document,
        userId: user.id,
        baseRev: body.baseRev,
        force: body.force === true,
      });
      if (result.conflict) {
        return sendJson(res, 409, {
          error: '文档已被其他会话修改',
          rev: result.rev,
        });
      }
      if (result.missing) throw new HttpError(404, '项目文档不存在');
      return sendJson(res, 200, { rev: result.rev });
    }
  }

  /* ---------- 版本 ---------- */

  if ((match = pathname.match(/^\/api\/projects\/([^/]+)\/versions$/))) {
    const projectId = match[1];
    const user = requireUser(ctx);
    if (method === 'GET') {
      requireProjectRole(projectId, user.id, 'read');
      return sendJson(res, 200, { versions: store.listVersions(projectId) });
    }
    if (method === 'POST') {
      requireProjectRole(projectId, user.id, 'write');
      const body = await readJson(req);
      const label = body.label ? String(body.label).slice(0, 120) : null;
      const version = store.createVersion({ projectId, label, userId: user.id });
      if (!version) throw new HttpError(404, '项目文档不存在');
      return sendJson(res, 201, version);
    }
  }

  if ((match = pathname.match(/^\/api\/projects\/([^/]+)\/versions\/(\d+)$/))) {
    const projectId = match[1];
    const user = requireUser(ctx);
    requireProjectRole(projectId, user.id, 'read');
    const version = store.getVersion(projectId, Number(match[2]));
    if (!version) throw new HttpError(404, '版本不存在');
    return sendJson(res, 200, version);
  }

  if ((match = pathname.match(/^\/api\/projects\/([^/]+)\/restore$/)) && method === 'POST') {
    const projectId = match[1];
    const user = requireUser(ctx);
    requireProjectRole(projectId, user.id, 'write');
    const body = await readJson(req);
    const restored = store.restoreVersion({ projectId, version: Number(body.version), userId: user.id });
    if (!restored) throw new HttpError(404, '版本不存在');
    return sendJson(res, 200, restored);
  }

  /* ---------- 成员 ---------- */

  if ((match = pathname.match(/^\/api\/projects\/([^/]+)\/members$/))) {
    const projectId = match[1];
    const user = requireUser(ctx);
    if (method === 'GET') {
      requireProjectRole(projectId, user.id, 'read');
      return sendJson(res, 200, { members: store.listMembers(projectId) });
    }
    if (method === 'POST') {
      requireProjectRole(projectId, user.id, 'admin');
      const body = await readJson(req);
      const role = String(body.role ?? 'viewer');
      if (!ROLES.includes(role)) throw new HttpError(400, '角色无效');
      const target = store.findUserByEmail(body.email ?? '');
      if (!target) throw new HttpError(404, '该邮箱尚未注册');
      store.addMember(projectId, target.id, role);
      store.audit(projectId, user.id, 'member.add', { email: target.email, role });
      return sendJson(res, 201, { members: store.listMembers(projectId) });
    }
  }

  if ((match = pathname.match(/^\/api\/projects\/([^/]+)\/members\/([^/]+)$/))) {
    const projectId = match[1];
    const memberId = match[2];
    const user = requireUser(ctx);
    requireProjectRole(projectId, user.id, 'admin');
    if (method === 'PATCH') {
      const body = await readJson(req);
      const role = String(body.role ?? '');
      if (!ROLES.includes(role)) throw new HttpError(400, '角色无效');
      if (role !== 'admin' && store.countAdmins(projectId) <= 1 && store.getMembership(projectId, memberId) === 'admin') {
        throw new HttpError(400, '项目至少需要保留一名管理者');
      }
      store.updateMemberRole(projectId, memberId, role);
      store.audit(projectId, user.id, 'member.update', { memberId, role });
      return sendJson(res, 200, { members: store.listMembers(projectId) });
    }
    if (method === 'DELETE') {
      if (store.getMembership(projectId, memberId) === 'admin' && store.countAdmins(projectId) <= 1) {
        throw new HttpError(400, '项目至少需要保留一名管理者');
      }
      store.removeMember(projectId, memberId);
      store.audit(projectId, user.id, 'member.remove', { memberId });
      return sendJson(res, 200, { members: store.listMembers(projectId) });
    }
  }

  /* ---------- 系统管理（超管后台：概览 / 项目 / 审计 / 用户 / AI） ---------- */

  if (pathname === '/api/admin/login' && method === 'POST') {
    checkAuthRate(req);
    const body = await readJson(req);
    const record = body.email ? store.findUserByEmail(body.email) : null;
    if (!record || !verifyPassword(String(body.password ?? ''), record.passwordHash)) {
      throw new HttpError(401, '邮箱或密码不正确');
    }
    if (!record.isAdmin) throw new HttpError(403, '该账号不是系统管理员');
    store.audit(null, record.id, 'admin.login', { email: record.email });
    return sendJson(res, 200, { token: createToken(record, SECRET), user: publicUser(record) });
  }

  if (pathname === '/api/admin/overview' && method === 'GET') {
    requireSystemAdmin(ctx);
    const stats = store.documentStats();
    let dbBytes = 0;
    try {
      dbBytes = fs.statSync(DB_FILE).size;
    } catch {
      dbBytes = 0;
    }
    return sendJson(res, 200, {
      version: PKG_VERSION,
      node: process.version,
      uptimeSec: Math.round(process.uptime()),
      dataDir: DATA_DIR,
      registrationOpen: ALLOW_REGISTER,
      authRateLimit: AUTH_RATE_LIMIT,
      users: store.countUsers(),
      admins: store.countSystemAdmins(),
      projects: store.countAllProjects(),
      documents: stats.documents,
      documentBytes: stats.bytes,
      dbBytes,
      auditEvents: store.countAudit(),
      instance: INSTANCE_ID,
      pid: process.pid,
      startedAt: STARTED_AT,
      ai: { provider: aiConfig.provider, model: aiConfig.model, ready: aiConfig.ready },
      converter: { available: converter.available, checked: converter.checked },
      collab: collab.stats(),
    });
  }

  if (pathname === '/api/admin/projects' && method === 'GET') {
    requireSystemAdmin(ctx);
    const query = (url.searchParams.get('q') ?? '').trim();
    const limit = Math.min(200, Math.max(1, Number(url.searchParams.get('limit') ?? 50) || 50));
    const offset = Math.max(0, Number(url.searchParams.get('offset') ?? 0) || 0);
    return sendJson(res, 200, {
      total: store.countAllProjects(query),
      projects: store.listAllProjects({ query, limit, offset }),
    });
  }

  if ((match = pathname.match(/^\/api\/admin\/projects\/([^/]+)$/)) && method === 'DELETE') {
    const admin = requireSystemAdmin(ctx);
    const project = store.getProject(match[1]);
    if (!project) throw new HttpError(404, '项目不存在');
    store.audit(null, admin.id, 'admin.project.delete', { projectId: project.id, name: project.name });
    store.deleteProject(project.id, admin.id);
    return sendJson(res, 200, { ok: true });
  }

  if (pathname === '/api/admin/audit' && method === 'GET') {
    requireSystemAdmin(ctx);
    const action = (url.searchParams.get('action') ?? '').trim();
    const projectId = (url.searchParams.get('projectId') ?? '').trim();
    const userId = (url.searchParams.get('userId') ?? '').trim();
    const limit = Math.min(200, Math.max(1, Number(url.searchParams.get('limit') ?? 50) || 50));
    const offset = Math.max(0, Number(url.searchParams.get('offset') ?? 0) || 0);
    return sendJson(res, 200, {
      total: store.countAudit({ action, projectId, userId }),
      events: store.listAudit({ action, projectId, userId, limit, offset }),
    });
  }

  if (pathname === '/api/admin/users' && method === 'GET') {
    requireSystemAdmin(ctx);
    return sendJson(res, 200, { users: store.listAllUsers() });
  }

  if (pathname === '/api/admin/users' && method === 'POST') {
    const admin = requireSystemAdmin(ctx);
    const body = await readJson(req);
    const error = validateCredentials({ email: body.email, password: body.password, name: body.name });
    if (error) throw new HttpError(400, error);
    if (store.findUserByEmail(body.email)) throw new HttpError(409, '该邮箱已注册');
    const user = store.createUser({
      email: body.email,
      name: String(body.name).trim(),
      passwordHash: hashPassword(body.password),
      isAdmin: body.isAdmin === true,
    });
    store.audit(null, admin.id, 'admin.user.create', { email: user.email, isAdmin: Boolean(body.isAdmin) });
    return sendJson(res, 201, { user: publicUser(user) });
  }

  if ((match = pathname.match(/^\/api\/admin\/users\/([^/]+)$/))) {
    const targetId = match[1];
    const admin = requireSystemAdmin(ctx);
    const target = store.userById(targetId);
    if (!target) throw new HttpError(404, '用户不存在');

    if (method === 'PATCH') {
      const body = await readJson(req);
      const patch = {};
      if (body.name !== undefined) {
        const name = String(body.name).trim();
        if (!name) throw new HttpError(400, '名称不能为空');
        patch.name = name;
      }
      if (body.password !== undefined) {
        if (typeof body.password !== 'string' || body.password.length < 6) {
          throw new HttpError(400, '密码至少 6 位');
        }
        patch.passwordHash = hashPassword(body.password);
      }
      if (body.isAdmin !== undefined) {
        if (target.isAdmin && !body.isAdmin && store.countSystemAdmins() <= 1) {
          throw new HttpError(400, '至少需要保留一名系统管理员');
        }
        patch.isAdmin = Boolean(body.isAdmin);
      }
      if (!Object.keys(patch).length) throw new HttpError(400, '没有可更新的字段');
      store.updateUser(targetId, patch);
      store.audit(null, admin.id, 'admin.user.update', {
        userId: targetId,
        fields: Object.keys(patch),
      });
      return sendJson(res, 200, { user: publicUser(store.userById(targetId)) });
    }

    if (method === 'DELETE') {
      if (target.id === admin.id) throw new HttpError(400, '不能删除自己');
      if (target.isAdmin && store.countSystemAdmins() <= 1) {
        throw new HttpError(400, '至少需要保留一名系统管理员');
      }
      const result = store.deleteUser(targetId);
      if (result.error === 'USER_OWNS_PROJECTS') {
        throw new HttpError(400, `该用户名下有 ${result.owned} 个项目，请先转让或删除项目`);
      }
      store.audit(null, admin.id, 'admin.user.delete', { userId: targetId, email: target.email });
      return sendJson(res, 200, { ok: true });
    }
  }

  if (pathname === '/api/admin/settings/ai' && method === 'GET') {
    requireSystemAdmin(ctx);
    return sendJson(res, 200, aiSettingsView());
  }

  if (pathname === '/api/admin/settings/ai' && method === 'PUT') {
    const admin = requireSystemAdmin(ctx);
    const body = await readJson(req);
    if (body.provider !== undefined && !['mock', 'openai'].includes(body.provider)) {
      throw new HttpError(400, 'provider 只能是 mock 或 openai');
    }
    if (body.baseUrl !== undefined && !/^https?:\/\//.test(String(body.baseUrl))) {
      throw new HttpError(400, 'baseUrl 必须以 http:// 或 https:// 开头');
    }
    if (body.model !== undefined && (typeof body.model !== 'string' || !body.model.trim())) {
      throw new HttpError(400, 'model 不能为空');
    }
    if (body.reasoningEffort !== undefined && !['', 'low', 'medium', 'high'].includes(body.reasoningEffort)) {
      throw new HttpError(400, 'reasoningEffort 只能是空值、low、medium 或 high');
    }
    if (body.visionModel !== undefined && typeof body.visionModel !== 'string') {
      throw new HttpError(400, 'visionModel 必须是字符串（留空表示不启用）');
    }
    if (body.visionBaseUrl !== undefined) {
      const value = String(body.visionBaseUrl).trim();
      if (value && !/^https?:\/\//.test(value)) throw new HttpError(400, '视觉模型接口地址必须以 http:// 或 https:// 开头');
    }
    if (body.visionEnabled !== undefined && typeof body.visionEnabled !== 'boolean') {
      throw new HttpError(400, 'visionEnabled 必须是布尔值');
    }
    if (body.timeoutMs !== undefined) {
      const timeout = Number(body.timeoutMs);
      if (!Number.isFinite(timeout) || timeout < 1000 || timeout > 300000) {
        throw new HttpError(400, 'timeoutMs 需在 1000–300000 之间');
      }
    }
    if (body.contextTokens !== undefined) {
      const value = Number(body.contextTokens);
      // 0 表示「按模型名自动推断」，避免用户不知道自己的模型窗口时被逼着填
      if (!Number.isFinite(value) || value < 0 || value > 2000000) {
        throw new HttpError(400, 'contextTokens 需在 0–2000000 之间（0 = 按模型名自动推断）');
      }
    }
    if (body.provider !== undefined) store.setSetting('ai.provider', String(body.provider), admin.id);
    if (body.baseUrl !== undefined) store.setSetting('ai.baseUrl', String(body.baseUrl).replace(/\/+$/, ''), admin.id);
    if (body.model !== undefined) store.setSetting('ai.model', String(body.model).trim(), admin.id);
    if (body.reasoningEffort !== undefined) store.setSetting('ai.reasoningEffort', body.reasoningEffort, admin.id);
    if (body.contextTokens !== undefined) {
      const value = Math.round(Number(body.contextTokens));
      if (value > 0) store.setSetting('ai.contextTokens', String(value), admin.id);
      else store.deleteSetting('ai.contextTokens');
    }
    if (body.visionEnabled !== undefined) store.setSetting('ai.visionEnabled', body.visionEnabled ? '1' : '0', admin.id);
    if (body.visionModel !== undefined) {
      const visionModel = String(body.visionModel).trim();
      if (visionModel) store.setSetting('ai.visionModel', visionModel, admin.id);
      else store.deleteSetting('ai.visionModel');
    }
    if (body.visionBaseUrl !== undefined) {
      const visionBaseUrl = String(body.visionBaseUrl).trim().replace(/\/+$/, '');
      if (visionBaseUrl) store.setSetting('ai.visionBaseUrl', visionBaseUrl, admin.id);
      else store.deleteSetting('ai.visionBaseUrl');
    }
    if (typeof body.visionApiKey === 'string' && body.visionApiKey.trim()) {
      store.setSetting('ai.visionApiKey', secretBox.seal(body.visionApiKey.trim()), admin.id);
    }
    if (body.clearVisionKey === true) store.deleteSetting('ai.visionApiKey');
    if (body.timeoutMs !== undefined) store.setSetting('ai.timeoutMs', String(Math.round(Number(body.timeoutMs))), admin.id);
    if (typeof body.apiKey === 'string' && body.apiKey.trim()) {
      store.setSetting('ai.apiKey', secretBox.seal(body.apiKey.trim()), admin.id);
    }
    if (body.clearKey === true) store.deleteSetting('ai.apiKey');
    refreshAi();
    store.audit(null, admin.id, 'admin.ai.settings', {
      provider: aiConfig.provider,
      model: aiConfig.model,
    });
    return sendJson(res, 200, aiSettingsView());
  }

  if (pathname === '/api/admin/settings/ai/models' && method === 'GET') {
    requireSystemAdmin(ctx);
    if (aiConfig.provider !== 'openai' || !aiConfig.apiKey) {
      throw new HttpError(400, '请先保存 OpenAI 兼容接口和 API Key');
    }
    const models = await listModels(aiConfig, { force: true });
    if (!models) throw new HttpError(502, '无法获取模型列表，请检查已保存的接口地址、API Key 和网关的 /models 接口');
    return sendJson(res, 200, { models });
  }

  if (pathname === '/api/admin/settings/ai/test' && method === 'POST') {
    requireSystemAdmin(ctx);
    try {
      const result = await aiProvider.plan({
        message: '连通性测试：请返回空指令',
        context: { levels: [], types: [], elements: [] },
      });
      return sendJson(res, 200, {
        ok: true,
        provider: aiProvider.id,
        model: aiConfig.model,
        degraded: Boolean(result.degraded),
        reply: String(result.reply ?? '').slice(0, 200),
      });
    } catch (error) {
      return sendJson(res, 200, {
        ok: false,
        provider: aiProvider.id,
        error: error instanceof Error ? error.message : '调用失败',
      });
    }
  }

  /* ---------- AI 会话：历史对话（关掉面板 / 换设备都能接着看、接着改） ---------- */

  // 会话本身不带权限位，归属靠 project_members 判定
  const conversationFor = (conversationId, userId, level = 'read') => {
    const conversation = store.getConversation(conversationId, { withMessages: false });
    if (!conversation) throw new HttpError(404, '会话不存在');
    requireProjectRole(conversation.projectId, userId, level);
    return conversation;
  };

  if ((match = pathname.match(/^\/api\/projects\/([^/]+)\/ai\/conversations$/))) {
    const projectId = match[1];
    const user = requireUser(ctx);
    requireProjectRole(projectId, user.id, 'read');
    if (method === 'GET') {
      return sendJson(res, 200, { conversations: store.listConversations(projectId) });
    }
    if (method === 'POST') {
      const body = await readJson(req, 64 * 1024);
      const title = typeof body.title === 'string' ? body.title.trim().slice(0, 80) : '';
      const conversation = store.createConversation({ projectId, userId: user.id, title: title || null });
      store.audit(projectId, user.id, 'ai.conversation.create', { id: conversation.id });
      return sendJson(res, 201, { conversation });
    }
  }

  if ((match = pathname.match(/^\/api\/ai\/conversations\/([^/]+)$/))) {
    const conversationId = match[1];
    const user = requireUser(ctx);
    if (method === 'GET') {
      conversationFor(conversationId, user.id, 'read');
      const full = store.getConversation(conversationId);
      return sendJson(res, 200, { conversation: { ...full, usage: conversationUsage(full) } });
    }
    if (method === 'PATCH') {
      conversationFor(conversationId, user.id, 'read');
      const body = await readJson(req, 64 * 1024);
      if (typeof body.title === 'string') {
        const title = body.title.trim().slice(0, 80);
        if (title) store.renameConversation(conversationId, title);
      }
      return sendJson(res, 200, { conversation: store.getConversation(conversationId, { withMessages: false }) });
    }
    if (method === 'DELETE') {
      const conversation = conversationFor(conversationId, user.id, 'write');
      store.deleteConversation(conversationId);
      store.audit(conversation.projectId, user.id, 'ai.conversation.delete', { id: conversationId });
      return sendJson(res, 200, { ok: true });
    }
  }

  // 手动压缩上下文：把更早的消息压成备忘（面板上的「压缩」按钮）。
  // 自动压缩要攒到 18 条 / 9k token 才触发，用户想立刻省 token 时得有这条手动通道。
  if ((match = pathname.match(/^\/api\/projects\/([^/]+)\/ai\/conversations\/([^/]+)\/compact$/)) && method === 'POST') {
    const [, projectId, conversationId] = match;
    const user = requireUser(ctx);
    requireProjectRole(projectId, user.id, 'read');
    enforceLimit(aiLimiter, user, 'AI');
    if (aiProvider.id === 'mock') {
      throw new HttpError(400, 'Mock 模式没有可用的摘要模型，压缩需要先在 AI 设置里配置真实模型');
    }
    if (!aiConfig.ready) {
      throw new HttpError(503, 'AI 未配置：设置 STRU_AI_API_KEY（或 STRU_AI_PROVIDER=mock 使用本地模拟）');
    }
    const conversation = store.getConversation(conversationId, { withMessages: false });
    if (!conversation) throw new HttpError(404, '会话不存在');
    if (conversation.projectId !== projectId) throw new HttpError(400, '该会话不属于当前项目');
    try {
      const result = await compactConversation({ store, provider: aiProvider, conversationId });
      store.audit(projectId, user.id, 'ai.conversation.compact', {
        conversationId,
        compacted: result.compacted,
        before: result.before,
        after: result.after,
        remaining: result.remaining,
      });
      return sendJson(res, 200, {
        ...result,
        usage: conversationUsage(store.getConversation(conversationId, { withMessages: false })),
      });
    } catch (error) {
      throw new HttpError(502, error instanceof Error ? error.message : '压缩失败');
    }
  }

  // 回写某条 AI 回复的状态：是否已应用到模型、产生了哪个 rev
  if ((match = pathname.match(/^\/api\/ai\/conversations\/([^/]+)\/messages\/([^/]+)$/)) && method === 'PATCH') {
    const [, conversationId, messageId] = match;
    const user = requireUser(ctx);
    conversationFor(conversationId, user.id, 'read');
    const body = await readJson(req, 256 * 1024);
    const patch = {};
    if (typeof body.applied === 'boolean') patch.applied = body.applied;
    if (Number.isFinite(body.rev)) patch.rev = body.rev;
    const merged = store.updateMessagePayload(conversationId, messageId, patch);
    if (!merged) throw new HttpError(404, '消息不存在');
    return sendJson(res, 200, { message: { id: messageId, ...merged } });
  }

  /* ---------- AI 建模助手 ---------- */

  if (pathname === '/api/ai/status' && method === 'GET') {
    requireUser(ctx);
    // 主模型能不能读图：前端据此决定要不要在发送时附上视口截图（看成品自检）。
    // null 代表网关没给出模态信息，按「能读」试一次；Mock 明确不读图。
    const mainImage = aiProvider.id === 'mock' ? false : await quickMainSupportsImages(aiConfig);
    const canSeeImages = mainImage !== false || Boolean(aiConfig.vision?.enabled);
    return sendJson(res, 200, {
      provider: aiProvider.id,
      model: aiConfig.model,
      vision: { enabled: Boolean(aiConfig.vision?.enabled), model: aiConfig.vision?.model ?? '' },
      canSeeImages,
      /** 上下文窗口（前端显示「已用 / 总量」，超过 70% 变黄提示压缩） */
      contextWindow: contextWindowOf(aiConfig.model, aiConfig.contextTokens),
      ready: aiConfig.ready,
      mock: aiProvider.id === 'mock',
      ops: ['addLevel', 'addGrid', 'addWall', 'addColumn', 'addSlab', 'addSolid', 'addFeature', 'editFeature', 'deleteFeature', 'updateElement', 'setTypeProperty', 'deleteElement'],
    });
  }

  if ((match = pathname.match(/^\/api\/projects\/([^/]+)\/ai\/plan$/)) && method === 'POST') {
    const projectId = match[1];
    const user = requireUser(ctx);
    requireProjectRole(projectId, user.id, 'read');
    enforceLimit(aiLimiter, user, 'AI');
    if (!aiConfig.ready) {
      throw new HttpError(503, 'AI 未配置：设置 STRU_AI_API_KEY（或 STRU_AI_PROVIDER=mock 使用本地模拟）');
    }
    const body = await readJson(req, MAX_AI_BODY_BYTES);
    const images = parseImageBody(body);
    // 文本附件（txt / md / json / csv / 代码…）先解析：只给文件不写字时还要靠它补一句默认需求
    const attachments = parseAttachments(body.attachments);
    const typed = aiMessageOf(body, images, attachments);
    if (typed.length > 4000) throw new HttpError(400, '需求描述过长');
    const message = applyAttachments(typed, attachments);
    const stored = store.getDocument(projectId);
    if (!stored) throw new HttpError(404, '项目文档不存在');
    const context = buildProjectContext(
      stored.document,
      Array.isArray(body.selectedIds) ? body.selectedIds.slice(0, 200) : [],
    );
    // 会话上下文：命中会话就用库里存的摘要 + 未压缩消息，否则退回前端传的 history
    const session = openConversation({
      conversationId: body.conversationId,
      projectId,
      userId: user.id,
      message,
      thumbs: parseThumbs(body.imageThumbs),
      shots: Number(body.imageShots) || 0,
      internal: body.internal === true,
      requestId: parseRequestId(body),
    });
    let result;
    let repaired = 0;
    let warning = '';
    const planStarted = Date.now();
    const history = session ? session.history : Array.isArray(body.history) ? body.history : [];
    const memory = session?.memory ?? '';
    try {
      const planned = await planWithRepair({
        run: (args) => aiProvider.plan(args),
        message,
        context,
        history,
        memory,
        images,
        document: stored.document,
      });
      result = planned.result;
      repaired = planned.repaired ?? 0;
      warning = planned.warning ?? '';
    } catch (error) {
      const detail = error instanceof Error ? error.message : 'AI 调用失败';
      // 失败也留痕：排查「非 JSON / 超时 / 网关错误」时不必再猜（审计表只记成功调用）
      console.warn(`[ai] plan 失败 ${Date.now() - planStarted}ms provider=${aiProvider.id} model=${aiConfig.model} baseUrl=${aiConfig.baseUrl} images=${images.length} :: ${detail.slice(0, 500)}`);
      dropStaleMessages(session);
      saveAssistantMessage(session, { reply: `生成失败：${detail}`, error: true });
      throw new HttpError(502, detail);
    }
    dropStaleMessages(session);
    const ops = Array.isArray(result.ops) ? result.ops : [];
    const inspect = Array.isArray(result.inspect) ? result.inspect : [];
    const measure = Array.isArray(result.measure) ? result.measure : [];
    const summary = summarizeOps(ops);
    const saved = saveAssistantMessage(session, {
      reply: result.reply ?? '',
      ops,
      summary,
      model: aiConfig.model,
      ms: Date.now() - planStarted,
      repaired,
      warning,
      vision: result.vision ?? null,
      inspect,
      context: result.context ?? null,
    });
    // 会话变长后压缩更早的消息（后台跑，不影响这次响应）
    void maybeSummarize({ store, provider: aiProvider, session });
    store.audit(projectId, user.id, 'ai.plan', {
      provider: aiProvider.id,
      message: message.slice(0, 200),
      ms: Date.now() - planStarted,
      degraded: Boolean(result.degraded),
      repaired,
      images: images.length,
      vision: result.vision?.model,
      inspect: inspect.length,
      attachments: describeAttachments(attachments),
      conversationId: session?.id ?? null,
      context: result.context ? describeUsage(result.context) : '',
    });
    return sendJson(res, 200, {
      reply: result.reply ?? '',
      ops,
      inspect,
      measure,
      done: result.done === true,
      summary,
      provider: aiProvider.id,
      model: aiConfig.model,
      mock: aiProvider.id === 'mock',
      ms: Date.now() - planStarted,
      repaired,
      warning,
      vision: result.vision ?? null,
      context: result.context ?? null,
      conversationId: session?.id ?? null,
      messageId: saved?.id ?? null,
      userMessageId: session?.userMessageId ?? null,
    });
  }

  // 流式版：把模型的思考过程、输出草稿、特征树生成进度实时推给前端（SSE）。
  // thinking 模型一次请求要几十秒到几分钟，没有中间过程用户只会以为卡死。
  if ((match = pathname.match(/^\/api\/projects\/([^/]+)\/ai\/plan\/stream$/)) && method === 'POST') {
    const projectId = match[1];
    const user = requireUser(ctx);
    requireProjectRole(projectId, user.id, 'read');
    enforceLimit(aiLimiter, user, 'AI');
    if (!aiConfig.ready) {
      throw new HttpError(503, 'AI 未配置：设置 STRU_AI_API_KEY（或 STRU_AI_PROVIDER=mock 使用本地模拟）');
    }
    const body = await readJson(req, MAX_AI_BODY_BYTES);
    const images = parseImageBody(body);
    // 文本附件（txt / md / json / csv / 代码…）先解析：只给文件不写字时还要靠它补一句默认需求
    const attachments = parseAttachments(body.attachments);
    const typed = aiMessageOf(body, images, attachments);
    if (typed.length > 4000) throw new HttpError(400, '需求描述过长');
    const message = applyAttachments(typed, attachments);
    const stored = store.getDocument(projectId);
    if (!stored) throw new HttpError(404, '项目文档不存在');
    const context = buildProjectContext(
      stored.document,
      Array.isArray(body.selectedIds) ? body.selectedIds.slice(0, 200) : [],
    );
    // 权限/归属校验必须在开 SSE 之前：抛错时还能返回正常 JSON 错误
    const session = openConversation({
      conversationId: body.conversationId,
      projectId,
      userId: user.id,
      message,
      thumbs: parseThumbs(body.imageThumbs),
      shots: Number(body.imageShots) || 0,
      internal: body.internal === true,
      // 前端自动重试时复用同一个 requestId：不重复插用户消息，并清掉上一轮的失败气泡
      requestId: parseRequestId(body),
    });
    const memory = session?.memory ?? '';
    const history = session ? session.history : Array.isArray(body.history) ? body.history : [];

    const stream = beginEventStream(req, res);
    const heartbeat = setInterval(() => stream.comment(), 15000);
    heartbeat.unref?.();
    // 客户端点了「停止」：把上游请求一起掐掉，别白烧 token
    const cancel = new AbortController();
    let finished = false;
    res.on('close', () => {
      if (!finished) cancel.abort();
    });

    const planStarted = Date.now();
    let events = 0;
    stream.send({
      type: 'start',
      provider: aiProvider.id,
      model: aiConfig.model,
      mock: aiProvider.id === 'mock',
      images: images.length,
    });
    // 上游是逐 token 吐的，一个汉字一帧 SSE 太浪费：按 100ms 合并成一批再推
    let pendingReasoning = '';
    let pendingContent = '';
    let lastFlush = 0;
    const flushDeltas = (force = false) => {
      const stamp = Date.now();
      if (!force && stamp - lastFlush < 100 && pendingReasoning.length < 2000 && pendingContent.length < 2000) return;
      lastFlush = stamp;
      if (pendingReasoning) {
        stream.send({ type: 'reasoning', delta: pendingReasoning });
        pendingReasoning = '';
      }
      if (pendingContent) {
        stream.send({ type: 'content', delta: pendingContent });
        pendingContent = '';
      }
    };
    // 上游事件统一入口：增量合帧后推 SSE；自动修正轮复用同一个出口
    const onEvent = (event) => {
      if (event.type === 'reasoning') {
        pendingReasoning += event.delta;
        flushDeltas();
        return;
      }
      if (event.type === 'content') {
        pendingContent += event.delta;
        flushDeltas();
        return;
      }
      events += 1;
      flushDeltas(true);
      if (cancel.signal.aborted) return;
      stream.send(event);
    };
    try {
      const planned = await planWithRepair({
        run: (args) => aiProvider.planStream({ ...args, signal: cancel.signal, onEvent }),
        message,
        context,
        history,
        memory,
        images,
        document: stored.document,
        // 修正轮也要把「在改什么」推给前端，否则用户会以为模型卡住重来了一次
        onEvent,
      });
      const result = planned.result;
      flushDeltas(true);
      const ops = Array.isArray(result.ops) ? result.ops : [];
      const inspect = Array.isArray(result.inspect) ? result.inspect : [];
      const measure = Array.isArray(result.measure) ? result.measure : [];
      const summary = summarizeOps(ops);
      dropStaleMessages(session);
      const saved = saveAssistantMessage(session, {
        reply: result.reply ?? '',
        ops,
        summary,
        model: aiConfig.model,
        ms: Date.now() - planStarted,
        repaired: planned.repaired ?? 0,
        warning: planned.warning ?? '',
        vision: result.vision ?? null,
        inspect,
        context: result.context ?? null,
      });
      void maybeSummarize({ store, provider: aiProvider, session });
      store.audit(projectId, user.id, 'ai.plan', {
        provider: aiProvider.id,
        message: message.slice(0, 200),
        ms: Date.now() - planStarted,
        degraded: Boolean(result.degraded),
        stream: true,
        repaired: planned.repaired ?? 0,
        images: images.length,
        vision: result.vision?.model,
        inspect: inspect.length,
        attachments: describeAttachments(attachments),
        conversationId: session?.id ?? null,
        context: result.context ? describeUsage(result.context) : '',
      });
      stream.send({
        type: 'result',
        reply: result.reply ?? '',
        ops,
        inspect,
        measure,
        done: result.done === true,
        summary,
        provider: aiProvider.id,
        model: aiConfig.model,
        mock: aiProvider.id === 'mock',
        ms: Date.now() - planStarted,
        events,
        repaired: planned.repaired ?? 0,
        warning: planned.warning ?? '',
        vision: result.vision ?? null,
        context: result.context ?? null,
        conversationId: session?.id ?? null,
        messageId: saved?.id ?? null,
        userMessageId: session?.userMessageId ?? null,
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : 'AI 调用失败';
      // 用户点了「停止」/ 关了页面：不算故障，静默收尾
      if (!cancel.signal.aborted) {
        console.warn(`[ai] plan(stream) 失败 ${Date.now() - planStarted}ms provider=${aiProvider.id} model=${aiConfig.model} baseUrl=${aiConfig.baseUrl} images=${images.length} events=${events} :: ${detail.slice(0, 500)}`);
      }
      // 这次是重试：上一轮的错误气泡先清掉，别越积越多
      dropStaleMessages(session);
      saveAssistantMessage(session, { reply: `生成中断：${detail}`, error: true });
      stream.send({ type: 'error', message: detail });
    } finally {
      finished = true;
      clearInterval(heartbeat);
      stream.end();
    }
    return;
  }

  if ((match = pathname.match(/^\/api\/projects\/([^/]+)\/ai\/apply$/)) && method === 'POST') {
    const projectId = match[1];
    const user = requireUser(ctx);
    requireProjectRole(projectId, user.id, 'write');
    enforceLimit(aiLimiter, user, 'AI');
    const body = await readJson(req, MAX_DOCUMENT_BYTES);
    const stored = store.getDocument(projectId);
    if (!stored) throw new HttpError(404, '项目文档不存在');
    let result;
    try {
      result = applyOps(stored.document, body.ops);
    } catch (error) {
      if (error instanceof OpsError) throw new HttpError(400, error.message);
      throw error;
    }
    const documentError = validateDocument(result.document);
    if (documentError) throw new HttpError(400, documentError);
    const saved = store.saveDocument({
      projectId,
      document: result.document,
      userId: user.id,
      force: true,
    });
    if (!saved || !saved.rev) throw new HttpError(400, saved?.error ?? '保存失败');
    store.audit(projectId, user.id, 'ai.apply', { rev: saved.rev, summary: summarizeOps(body.ops) });
    collab.broadcastDocument(projectId, saved.rev, result.document, user.id);
    return sendJson(res, 200, {
      rev: saved.rev,
      document: result.document,
      applied: result.applied,
      summary: summarizeOps(body.ops),
    });
  }

  /* ---------- STEP 转换（服务端 OCCT，保留面颜色） ---------- */

  if (pathname === '/api/convert/step/status' && method === 'GET') {
    return sendJson(res, 200, {
      available: converter.available,
      checked: converter.checked,
      python: converter.python,
      error: converter.error,
    });
  }

  if (pathname === '/api/convert/step' && method === 'POST') {
    const user = requireUser(ctx);
    enforceLimit(stepLimiter, user, 'STEP 转换');
    if (!converter.available) {
      throw new HttpError(
        503,
        `STEP 转换器不可用：${converter.error ?? '未安装'}（python: ${converter.python}；运行 npm run setup:step 安装）`,
      );
    }
    const upload = await streamBodyToFile(req, MAX_STEP_BYTES);
    if (!upload.bytes) {
      fs.rmSync(upload.file, { force: true });
      throw new HttpError(400, 'STEP 内容为空');
    }
    const started = Date.now();
    let outputFile;
    try {
      outputFile = await runStepConverter(upload.file);
      const size = fs.statSync(outputFile).size;
      res.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Content-Length': size,
        'Cache-Control': 'no-store',
        'X-Converter': 'occt-xcaf',
        'X-Convert-Ms': String(Date.now() - started),
      });
      await new Promise((resolve) => {
        const source = fs.createReadStream(outputFile);
        source.on('error', () => {
          res.destroy();
          resolve();
        });
        res.on('finish', resolve);
        source.pipe(res);
      });
      store.audit(null, user.id, 'convert.step', {
        bytes: upload.bytes,
        meshBytes: size,
        ms: Date.now() - started,
      });
    } finally {
      fs.rm(upload.file, { force: true }, () => {});
      if (outputFile) fs.rm(outputFile, { force: true }, () => {});
    }
    return;
  }

  /* ---------- 审计 ---------- */

  if ((match = pathname.match(/^\/api\/projects\/([^/]+)\/audit$/)) && method === 'GET') {
    const projectId = match[1];
    const user = requireUser(ctx);
    requireProjectRole(projectId, user.id, 'admin');
    const rows = store.db
      .prepare('select action, detail, created_at, user_id from audit_log where project_id = ? order by id desc limit 100')
      .all(projectId);
    return sendJson(res, 200, { events: rows });
  }

  throw new HttpError(404, '接口不存在');
}

/* ------------------------------ 静态资源 ------------------------------ */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

function serveStatic(pathname, res) {
  if (!fs.existsSync(DIST_DIR)) {
    return sendJson(res, 404, { error: '前端尚未构建（先运行 npm run build）' });
  }
  const relative = pathname === '/' ? 'index.html' : decodeURIComponent(pathname).replace(/^\/+/, '');
  let filePath = path.resolve(DIST_DIR, relative);
  if (!filePath.startsWith(DIST_DIR)) return sendJson(res, 403, { error: '非法路径' });
  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    if (path.extname(relative)) return sendJson(res, 404, { error: '文件不存在' });
    filePath = path.join(DIST_DIR, 'index.html');
  }
  const type = MIME[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream';
  let content = fs.readFileSync(filePath);
  const compressible = /^(text\/|application\/(javascript|json|xml)|image\/svg)/.test(type);
  const headers = { 'Content-Type': type, 'Cache-Control': 'no-cache' };
  if (compressible && content.length > 2048 && acceptsGzip(res.req)) {
    content = zlib.gzipSync(content);
    headers['Content-Encoding'] = 'gzip';
    headers.Vary = 'Accept-Encoding';
  }
  // Vite 构建产物文件名带 hash，可长期缓存；index.html 保持 no-cache
  if (relative.startsWith('assets/')) headers['Cache-Control'] = 'public, max-age=31536000, immutable';
  headers['Content-Length'] = content.length;
  res.writeHead(200, headers);
  res.end(content);
}

/* ------------------------------ 服务器 ------------------------------ */

const server = http.createServer(async (req, res) => {
  const started = Date.now();
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  applyCors(req, res);

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

  const ctx = { req, res, url, user: null };
  try {
    if (url.pathname.startsWith('/api/')) {
      ctx.user = userFromRequest(req);
      await handleApi(ctx);
    } else {
      serveStatic(url.pathname, res);
    }
  } catch (error) {
    if (res.headersSent) {
      res.end();
    } else if (error instanceof HttpError) {
      sendJson(res, error.status, { error: error.message, ...(error.extra ?? {}) });
    } else {
      console.error('[server] 未处理错误', error);
      sendJson(res, 500, { error: '服务器内部错误' });
    }
  } finally {
    const duration = Date.now() - started;
    if (url.pathname.startsWith('/api/')) {
      console.log(`${req.method} ${url.pathname} ${res.statusCode} ${duration}ms`);
    }
  }
});

const collab = attachCollabServer(server, { store, secret: SECRET });

server.listen(PORT, HOST, () => {
  const urls = [`http://127.0.0.1:${PORT}`];
  if (HOST === '0.0.0.0' || HOST === '::') {
    for (const entries of Object.values(os.networkInterfaces())) {
      for (const entry of entries ?? []) {
        if (entry.family === 'IPv4' && !entry.internal) urls.push(`http://${entry.address}:${PORT}`);
      }
    }
  }
  console.log(`StruBrowser server → ${[...new Set(urls)].join('  ')}`);
  console.log(`db: ${DB_FILE}`);
  console.log(ALLOW_REGISTER ? '注册：开放' : '注册：已关闭（仅管理员可创建用户）');
  if (!fs.existsSync(DIST_DIR)) console.log('提示：dist/ 不存在，仅提供 API（前端请用 Vite dev server 或先 npm run build）');
  console.log(aiConfig.ready
    ? `AI 助手：${aiProvider.id === 'mock' ? 'Mock 模式（无需 key）' : `已连接 ${aiConfig.model}`}`
    : `AI 助手：未配置（设置 STRU_AI_API_KEY，或 STRU_AI_PROVIDER=mock）`);
  void probeConverter().then((result) => {
    converter.checked = true;
    converter.available = result.available;
    converter.error = result.error;
    console.log(result.available
      ? `STEP 转换器：可用（${PYTHON}）`
      : `STEP 转换器：不可用（${result.error}）—— STEP 导入将回退浏览器解析，面颜色可能丢失；运行 npm run setup:step 安装`);
  });
});

let shuttingDown = false;
function shutdown(signal = 'SIGTERM') {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n[${INSTANCE_ID}] 收到 ${signal}，停止接收新连接并关闭协作连接…`);
  collab.closeAll();
  server.close(() => {
    try {
      store.db.close();
    } catch {
      // 忽略关闭错误
    }
    console.log(`[${INSTANCE_ID}] 已退出`);
    process.exit(0);
  });
  // 有长连接/转换任务时最多等 8 秒
  setTimeout(() => {
    console.error(`[${INSTANCE_ID}] 关闭超时，强制退出`);
    process.exit(1);
  }, 8000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
