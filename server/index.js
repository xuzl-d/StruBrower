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
import { createProvider, resolveAiConfig } from './ai/provider.js';
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
function loadAiConfig() {
  const envConfig = resolveAiConfig(process.env);
  const provider = store.getSetting('ai.provider') ?? envConfig.provider;
  const baseUrl = store.getSetting('ai.baseUrl') ?? envConfig.baseUrl;
  const model = store.getSetting('ai.model') ?? envConfig.model;
  const timeoutRaw = Number(store.getSetting('ai.timeoutMs') ?? envConfig.timeoutMs);
  const storedKey = store.getSetting('ai.apiKey');
  const apiKey = (storedKey ? secretBox.open(storedKey) : '') || envConfig.apiKey;
  const normalizedProvider = provider === 'openai' ? 'openai' : 'mock';
  return {
    provider: normalizedProvider,
    baseUrl: String(baseUrl).replace(/\/+$/, ''),
    model,
    apiKey,
    timeoutMs: Number.isFinite(timeoutRaw) ? timeoutRaw : envConfig.timeoutMs,
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

function userFromRequest(req) {
  const header = req.headers.authorization ?? '';
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
  return user ? { id: user.id, email: user.email, name: user.name, isAdmin: Boolean(user.isAdmin) } : null;
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
    timeoutMs: aiConfig.timeoutMs,
    hasKey: Boolean(aiConfig.apiKey),
    keyHint: aiConfig.apiKey ? `****${aiConfig.apiKey.slice(-4)}` : '',
    ready: aiConfig.ready,
    source: {
      provider: stored['ai.provider'] ? 'db' : 'env',
      baseUrl: stored['ai.baseUrl'] ? 'db' : 'env',
      model: stored['ai.model'] ? 'db' : 'env',
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
    if (body.timeoutMs !== undefined) {
      const timeout = Number(body.timeoutMs);
      if (!Number.isFinite(timeout) || timeout < 1000 || timeout > 300000) {
        throw new HttpError(400, 'timeoutMs 需在 1000–300000 之间');
      }
    }
    if (body.provider !== undefined) store.setSetting('ai.provider', String(body.provider), admin.id);
    if (body.baseUrl !== undefined) store.setSetting('ai.baseUrl', String(body.baseUrl).replace(/\/+$/, ''), admin.id);
    if (body.model !== undefined) store.setSetting('ai.model', String(body.model).trim(), admin.id);
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

  /* ---------- AI 建模助手 ---------- */

  if (pathname === '/api/ai/status' && method === 'GET') {
    requireUser(ctx);
    return sendJson(res, 200, {
      provider: aiProvider.id,
      model: aiConfig.model,
      ready: aiConfig.ready,
      mock: aiProvider.id === 'mock',
      ops: ['addLevel', 'addGrid', 'addWall', 'addColumn', 'addSlab', 'updateElement', 'setTypeProperty', 'deleteElement'],
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
    const body = await readJson(req);
    const message = String(body.message ?? '').trim();
    if (!message) throw new HttpError(400, '请输入需求描述');
    if (message.length > 4000) throw new HttpError(400, '需求描述过长');
    const stored = store.getDocument(projectId);
    if (!stored) throw new HttpError(404, '项目文档不存在');
    const context = buildProjectContext(
      stored.document,
      Array.isArray(body.selectedIds) ? body.selectedIds.slice(0, 200) : [],
    );
    let result;
    try {
      result = await aiProvider.plan({
        message,
        context,
        history: Array.isArray(body.history) ? body.history : [],
      });
    } catch (error) {
      throw new HttpError(502, error instanceof Error ? error.message : 'AI 调用失败');
    }
    store.audit(projectId, user.id, 'ai.plan', { provider: aiProvider.id, message: message.slice(0, 200) });
    return sendJson(res, 200, {
      reply: result.reply ?? '',
      ops: Array.isArray(result.ops) ? result.ops : [],
      summary: summarizeOps(result.ops ?? []),
      provider: aiProvider.id,
      model: aiConfig.model,
      mock: aiProvider.id === 'mock',
    });
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
    collab.broadcastDocument(projectId, saved.rev, result.document);
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
