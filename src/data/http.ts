import { migrateDocument } from '../bim/document';
import type { ProjectSummary } from '../bim/document';
import type { ProjectDocument } from '../bim/types';
import type { ProjectRepository, SaveOptions, SaveResult } from './repository';

const TOKEN_KEY = 'strubrowser.auth.token';

let memoryToken: string | null = null;

function storage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

export function getAuthToken(): string | null {
  const store = storage();
  if (!store) return memoryToken;
  return store.getItem(TOKEN_KEY);
}

export function setAuthToken(token: string | null): void {
  const store = storage();
  if (!store) {
    memoryToken = token;
    return;
  }
  if (token) store.setItem(TOKEN_KEY, token);
  else store.removeItem(TOKEN_KEY);
}

export class ApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export class ConflictError extends Error {
  readonly rev: number;

  constructor(rev: number) {
    super('文档已被其他会话修改');
    this.rev = rev;
  }
}

/* ---------- 流式请求的自动重试 ---------- */

/** 一次发送最多试 3 次（首轮 + 2 次重试）；间隔递增，别把网关打穿 */
const STREAM_ATTEMPTS = 3;
const STREAM_RETRY_DELAYS = [700, 1800];

function makeRequestId(): string {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  } catch {
    /* 非安全上下文（http 访问）没有 randomUUID */
  }
  return `r-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** 中断原因压成一句人话，塞进「正在自动重试」的进度文案 */
function describeStreamFailure(error: unknown): string {
  const text = error instanceof Error ? error.message : '连接中断';
  if (/没有收到结果/.test(text)) return '响应流提前结束';
  if (/无法连接服务端/.test(text)) return '连不上服务端';
  if (/超时|timeout/i.test(text)) return '等待超时';
  const code = text.match(/HTTP\s*(\d{3})/i);
  if (code) return `HTTP ${code[1]}`;
  return text.length > 40 ? `${text.slice(0, 40)}…` : text;
}

/**
 * 值不值得自动重试：
 * - 用户点了停止 → 绝不重试；
 * - 连不上 / 流被截断 / 429 / 5xx（网关抖动、上游过载）→ 重试；
 * - 400 / 401 / 403 / 404 / 413 这类改配置或改输入才能解决的 → 直接抛给用户。
 */
function shouldRetryStream(error: unknown, attempt: number, signal?: AbortSignal): boolean {
  if (attempt >= STREAM_ATTEMPTS) return false;
  if (signal?.aborted) return false;
  if (!(error instanceof ApiError)) return true;
  const message = error.message;
  if (error.status === 0) return !/已停止生成/.test(message);
  if (error.status === 429) return true;
  if (error.status >= 500) {
    const code = Number(message.match(/\b(?:HTTP\s*)?(429|5\d\d)\b/)?.[1] ?? 0);
    return code === 429 || code >= 500
      || /中断|断开|超时|timeout|ECONN|socket|network|fetch|空响应|没有收到|过载|限流/i.test(message);
  }
  return false;
}

/** 可被「停止」打断的等待 */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) { resolve(); return; }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

interface RequestOptions {
  method?: string;
  body?: unknown;
  token?: string | null;
}

async function request<T>(baseUrl: string, path: string, options: RequestOptions = {}): Promise<T> {
  const headers: Record<string, string> = {};
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';
  const token = options.token === undefined ? getAuthToken() : options.token;
  if (token) headers.Authorization = `Bearer ${token}`;
  let response: Response;
  try {
    response = await fetch(baseUrl + path, {
      method: options.method ?? 'GET',
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : '网络错误';
    throw new ApiError(0, `无法连接服务端（${detail}）：API 可能未启动或已断开，运行 ./start.sh restart 后重试`);
  }
  let payload: unknown = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }
  if (!response.ok) {
    const data = payload as { error?: string; rev?: number } | null;
    if (response.status === 409 && typeof data?.rev === 'number') throw new ConflictError(data.rev);
    throw new ApiError(response.status, data?.error ?? `请求失败（HTTP ${response.status}）`);
  }
  return payload as T;
}

export interface AuthUser {
  id: string;
  email: string;
  name: string;
  isAdmin?: boolean;
  createdAt?: string | null;
}

export interface VersionEntry {
  version: number;
  label: string | null;
  createdAt: string;
  author: string | null;
}

export interface MemberEntry {
  id: string;
  email: string;
  name: string;
  role: 'viewer' | 'editor' | 'admin';
  addedAt: string;
}

export function createAuthApi(baseUrl = '') {
  return {
    async login(email: string, password: string) {
      return request<{ token: string; user: AuthUser }>(baseUrl, '/api/auth/login', {
        method: 'POST',
        body: { email, password },
        token: null,
      });
    },
    async register(email: string, name: string, password: string) {
      return request<{ token: string; user: AuthUser }>(baseUrl, '/api/auth/register', {
        method: 'POST',
        body: { email, name, password },
        token: null,
      });
    },
    async me() {
      return request<{ user: AuthUser }>(baseUrl, '/api/me');
    },
    /** 修改自己的显示名称 */
    async updateProfile(payload: { name: string }) {
      return request<{ user: AuthUser }>(baseUrl, '/api/me', {
        method: 'PATCH',
        body: payload,
      });
    },
    /** 修改自己的密码（需要旧密码） */
    async changePassword(currentPassword: string, newPassword: string) {
      return request<{ ok: boolean }>(baseUrl, '/api/me/password', {
        method: 'POST',
        body: { currentPassword, newPassword },
      });
    },
  };
}

export function createVersionsApi(baseUrl = '') {
  return {
    async list(projectId: string) {
      return request<{ versions: VersionEntry[] }>(baseUrl, `/api/projects/${projectId}/versions`);
    },
    async create(projectId: string, label: string) {
      return request<{ version: number; createdAt: string }>(baseUrl, `/api/projects/${projectId}/versions`, {
        method: 'POST',
        body: { label },
      });
    },
    async restore(projectId: string, version: number) {
      return request<{ rev: number }>(baseUrl, `/api/projects/${projectId}/restore`, {
        method: 'POST',
        body: { version },
      });
    },
    async get(projectId: string, version: number) {
      return request<{ version: number; label: string | null; document: ProjectDocument }>(
        baseUrl,
        `/api/projects/${projectId}/versions/${version}`,
      );
    },
  };
}

export function createMembersApi(baseUrl = '') {
  return {
    async list(projectId: string) {
      return request<{ members: MemberEntry[] }>(baseUrl, `/api/projects/${projectId}/members`);
    },
    async add(projectId: string, email: string, role: string) {
      return request<{ members: MemberEntry[] }>(baseUrl, `/api/projects/${projectId}/members`, {
        method: 'POST',
        body: { email, role },
      });
    },
    async update(projectId: string, memberId: string, role: string) {
      return request<{ members: MemberEntry[] }>(baseUrl, `/api/projects/${projectId}/members/${memberId}`, {
        method: 'PATCH',
        body: { role },
      });
    },
    async remove(projectId: string, memberId: string) {
      return request<{ members: MemberEntry[] }>(baseUrl, `/api/projects/${projectId}/members/${memberId}`, {
        method: 'DELETE',
      });
    },
  };
}

/** 探测服务端是否可用（用于本地/服务端模式自动切换）。 */
export async function pingServer(baseUrl = '', timeoutMs = 1500): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${baseUrl}/api/health`, { signal: controller.signal });
    if (!response.ok) return false;
    const data = (await response.json()) as { service?: string };
    return data.service === 'strubrowser-server';
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

export interface AdminUser {
  id: string;
  email: string;
  name: string;
  isAdmin: boolean;
  createdAt: string;
  ownedProjects: number;
  memberships: number;
}

export interface AdminOverview {
  version: string;
  node: string;
  uptimeSec: number;
  dataDir: string;
  registrationOpen: boolean;
  authRateLimit: number;
  users: number;
  admins: number;
  projects: number;
  documents: number;
  documentBytes: number;
  dbBytes: number;
  auditEvents: number;
  ai: { provider: string; model: string; ready: boolean };
  converter: { available: boolean; checked: boolean };
  collab: { rooms: number; clients: number };
}

export interface AdminProject {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  ownerEmail: string;
  ownerName: string;
  elementCount: number;
  rev: number;
  documentBytes: number;
  memberCount: number;
}

export interface AdminAuditEvent {
  id: number;
  action: string;
  projectId: string | null;
  projectName: string | null;
  userId: string | null;
  userEmail: string | null;
  userName: string | null;
  detail: string | null;
  createdAt: string;
}

export interface AiSettingsView {
  provider: 'mock' | 'openai';
  baseUrl: string;
  model: string;
  /** 独立视觉模型：默认关闭，主模型不支持读图时才会用到 */
  visionEnabled: boolean;
  visionModel: string;
  /** 视觉模型自己的接口地址；留空表示与主模型相同 */
  visionBaseUrl: string;
  hasVisionKey: boolean;
  visionKeyHint: string;
  timeoutMs: number;
  /** 上下文窗口（tokens）；0 表示按模型名自动推断 */
  contextTokens?: number;
  /** 实际生效的窗口：面板显示占用比例用 */
  contextWindow?: number;
  hasKey: boolean;
  keyHint: string;
  ready: boolean;
  source: Record<string, string>;
}

export interface AiSettingsPayload {
  provider?: 'mock' | 'openai';
  baseUrl?: string;
  model?: string;
  visionEnabled?: boolean;
  visionModel?: string;
  visionBaseUrl?: string;
  visionApiKey?: string;
  clearVisionKey?: boolean;
  timeoutMs?: number;
  contextTokens?: number;
  apiKey?: string;
  clearKey?: boolean;
}

export interface AiStatus {
  provider: string;
  model: string;
  /** 独立视觉模型是否启用（主模型本身能读图时用不到） */
  vision?: { enabled: boolean; model: string };
  /** 主模型自己能不能读图：决定发送时能否把视口截图附带过去做视觉自检 */
  canSeeImages?: boolean;
  /** 上下文窗口大小（tokens）：面板显示占用比例 */
  contextWindow?: number;
  ready: boolean;
  mock: boolean;
  ops: string[];
}

/** 历史会话列表项 */
export interface AiConversationSummary {
  id: string;
  projectId: string;
  title: string | null;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
  preview: string;
  previewRole: 'user' | 'assistant' | null;
}

/** 落库的一条消息：附带当时生成的 ops 等信息 */
export interface AiStoredMessage {
  id: string;
  conversationId: string;
  seq: number;
  role: 'user' | 'assistant';
  content: string;
  createdAt: string;
  ops?: Array<Record<string, unknown>>;
  summary?: Record<string, number>;
  /** 用户消息附带的参考图缩略图（只存小图，原图不落库） */
  thumbs?: string[];
  /** 末尾有几张缩略图是「发送时自动附上的视口截图」而不是用户上传的参考图（旧数据没有这个字段） */
  shots?: number;
  applied?: boolean;
  rev?: number;
  error?: boolean;
  model?: string;
  ms?: number;
  repaired?: number;
  warning?: string;
  vision?: AiVisionInfo | null;
  /** 这条回复是「视角巡检」请求（ops 为空，等前端截图回传后再出指令） */
  inspect?: AiInspectView[];
  /** 自检闭环里前端代发的巡检回执：不在聊天区显示（但仍在上下文里） */
  internal?: boolean;
}

export interface AiConversation {
  id: string;
  projectId: string;
  title: string | null;
  summary: string | null;
  createdAt: string;
  updatedAt: string;
  messages?: AiStoredMessage[];
  /** 打开会话时的上下文占用估算（不调模型）：据此提示「要不要压缩」 */
  usage?: AiContextUsage | null;
}

/** 手动压缩结果：压了多少条、从多少降到多少 */
export interface AiCompactResult {
  summary: string;
  compacted: number;
  /** 压完还剩多少条未压缩（保留窗口以内，一般就是最近几条） */
  remaining: number;
  /** 再点一次还能压出东西吗（保留窗口外还有消息，且压得动） */
  hasMore?: boolean;
  /** `too-small`：被压的那段太短，摘要反而更长，没压 */
  reason?: string;
  before: number;
  after: number;
  usage?: AiContextUsage | null;
}

/** 图片被视觉模型读成了什么：object 是识别出的物体，parts 是零件数 */
export interface AiVisionInfo {
  model: string;
  inline: boolean;
  object: string;
  parts: number;
}

/**
 * AI 要求查看的视角：前端会真的把三维视图转过去、截图、再把图发回来。
 * 与 server/ai/inspect.js 的 normalizeInspect 输出结构一致。
 */
export interface AiInspectView {
  /** 预设视角；自定义角度时为 undefined */
  view?: 'iso' | 'front' | 'back' | 'left' | 'right' | 'top' | 'bottom';
  /** 方位角（度，从 +X 沿 +Y 逆时针） */
  azimuth?: number;
  /** 仰角（度，从水平面向上） */
  elevation?: number;
  /** 只框住这个构件（名字或 id），用来放大看细节 */
  focus?: string;
  /** 取景倍数：1 = 整机框满，2 = 推进一倍，0.5 = 退远（缺省视为 1） */
  zoom?: number;
  label: string;
}

/** 上下文用量：服务端按 token 预算分配后的实际占用（前端显示「12.4k / 128k」并提示压缩） */
export interface AiContextUsage {
  model?: string;
  /** 模型窗口 */
  window: number;
  /** 本次请求实际占用 */
  tokens: number;
  /** 分项：系统提示 / 滚动摘要 / 项目上下文 / 历史原文 / 当前消息 / 图片 */
  breakdown?: {
    system?: number;
    memory?: number;
    project?: number;
    history?: number;
    message?: number;
    images?: number;
  };
  /** 还塞进了几条历史原文、因预算被丢掉几条（丢掉=这段已由摘要替代或记忆有断档） */
  historyItems?: number;
  historyDropped?: number;
  compressed?: number;
  /** 项目上下文被裁剪掉的构件 / 特征数（0 表示全量） */
  omittedElements?: number;
  omittedFeatures?: number;
  /** 压缩前的估算大小（打开历史会话时给「压完能到多少」用） */
  estimatedAfter?: number;
  canCompact?: boolean;
}

export interface AiPlan {
  reply: string;
  ops: Array<Record<string, unknown>>;
  /** AI 想看的视角（最多 4 个）：可与 ops 同轮，前端先应用 ops 再切视角截图，自动再来一轮 */
  inspect?: AiInspectView[];
  /** AI 自评：已经满足用户需求，不用再改也不用再看图（自检闭环的收工信号） */
  done?: boolean;
  summary: Record<string, number>;
  provider: string;
  model: string;
  mock: boolean;
  /** 服务端耗时（毫秒），仅流式通道返回 */
  ms?: number;
  /** 服务端预校验没过、已让模型自动修正的次数（0 表示一次通过） */
  repaired?: number;
  /** 预校验仍未通过时的说明：有值时这些指令「应用到模型」必然失败 */
  warning?: string;
  /** 这次是否读了图、用的哪个模型 */
  vision?: AiVisionInfo | null;
  /** 本次请求的上下文占用（预算式压缩后的实际用量） */
  context?: AiContextUsage | null;
  /** 服务端落库后的会话与消息 id（前端据此回写「已应用」） */
  conversationId?: string | null;
  messageId?: string | null;
  userMessageId?: string | null;
}

/** 流式 plan 的中间事件（SSE）：思考过程 / 输出草稿 / 特征树生成进度 */
export type AiPlanEvent =
  | { type: 'start'; provider: string; model: string; mock?: boolean; images?: number }
  | { type: 'status'; text: string }
  | { type: 'vision'; model: string; object: string; parts: number }
  | { type: 'reasoning'; delta: string }
  | { type: 'content'; delta: string }
  | { type: 'tool'; name: string }
  | { type: 'plan'; chars: number }
  /** 连接中断后自动重试：前端据此清掉上一轮的半截草稿，别把两次输出拼在一起 */
  | { type: 'retry'; attempt: number; total: number; delayMs: number; reason: string }
  | { type: 'result'; reply: string; ops: Array<Record<string, unknown>>; inspect?: AiInspectView[]; done?: boolean; summary: Record<string, number>; provider: string; model: string; mock: boolean; ms?: number; events?: number; repaired?: number; warning?: string; vision?: AiVisionInfo | null; context?: AiContextUsage | null; conversationId?: string | null; messageId?: string | null; userMessageId?: string | null }
  | { type: 'error'; message: string };

export interface AiPlanStreamOptions {
  onEvent?: (event: AiPlanEvent) => void;
  signal?: AbortSignal;
  /** 同一次发送的幂等键：自动重试时复用，服务端据此不再重复插一条用户消息 */
  requestId?: string;
}

export interface AiApplyResult {
  rev: number;
  document: ProjectDocument;
  applied: string[];
  summary: Record<string, number>;
}

export function createAdminApi(baseUrl = '') {
  return {
    async users() {
      return request<{ users: AdminUser[] }>(baseUrl, '/api/admin/users');
    },
    async createUser(payload: { email: string; name: string; password: string; isAdmin?: boolean }) {
      return request<{ user: AdminUser & { isAdmin: boolean } }>(baseUrl, '/api/admin/users', {
        method: 'POST',
        body: payload,
      });
    },
    async updateUser(id: string, payload: { name?: string; password?: string; isAdmin?: boolean }) {
      return request<{ user: AdminUser }>(baseUrl, `/api/admin/users/${id}`, {
        method: 'PATCH',
        body: payload,
      });
    },
    async deleteUser(id: string) {
      return request<{ ok: boolean }>(baseUrl, `/api/admin/users/${id}`, { method: 'DELETE' });
    },
    async overview() {
      return request<AdminOverview>(baseUrl, '/api/admin/overview');
    },
    async projects(query = '', offset = 0, limit = 50) {
      const params = new URLSearchParams({ limit: String(limit), offset: String(offset) });
      if (query) params.set('q', query);
      return request<{ total: number; projects: AdminProject[] }>(baseUrl, `/api/admin/projects?${params}`);
    },
    async audit(params: { action?: string; projectId?: string; userId?: string; offset?: number; limit?: number } = {}) {
      const search = new URLSearchParams();
      if (params.action) search.set('action', params.action);
      if (params.projectId) search.set('projectId', params.projectId);
      if (params.userId) search.set('userId', params.userId);
      search.set('offset', String(params.offset ?? 0));
      search.set('limit', String(params.limit ?? 50));
      return request<{ total: number; events: AdminAuditEvent[] }>(baseUrl, `/api/admin/audit?${search}`);
    },
    async deleteProject(id: string) {
      return request<{ ok: boolean }>(baseUrl, `/api/admin/projects/${id}`, { method: 'DELETE' });
    },
    async aiSettings() {
      return request<AiSettingsView>(baseUrl, '/api/admin/settings/ai');
    },
    async saveAiSettings(payload: AiSettingsPayload) {
      return request<AiSettingsView>(baseUrl, '/api/admin/settings/ai', {
        method: 'PUT',
        body: payload,
      });
    },
    async testAi() {
      return request<{ ok: boolean; provider: string; model?: string; reply?: string; error?: string; degraded?: boolean }>(
        baseUrl,
        '/api/admin/settings/ai/test',
        { method: 'POST' },
      );
    },
  };
}

export function createAiApi(baseUrl = '') {
  /** 会话相关字段：conversationId 让服务端把这次往返写进历史，thumbs 是参考图缩略图 */
  interface SessionRef {
    conversationId?: string | null;
    imageThumbs?: string[];
    /** 末尾有几张缩略图是「发送时自动附上的视口截图」，读历史时折成提示而不是参考图 */
    imageShots?: number;
    /** 文本附件（txt / md / json / csv / 代码…）：服务端拼在需求后面，并随消息一起落库 */
    attachments?: Array<{ name: string; text: string }>;
    /** 自检闭环里前端代发的巡检回执：仍进上下文，但不在聊天区当作用户发言显示 */
    internal?: boolean;
  }

  const sessionBody = (session?: SessionRef) => ({
    ...(session?.conversationId ? { conversationId: session.conversationId } : {}),
    ...(session?.imageThumbs?.length ? { imageThumbs: session.imageThumbs } : {}),
    ...(session?.imageShots ? { imageShots: session.imageShots } : {}),
    ...(session?.attachments?.length ? { attachments: session.attachments } : {}),
    ...(session?.internal ? { internal: true } : {}),
  });

  const planOnce = (
    projectId: string,
    message: string,
    selectedIds: string[],
    history: Array<{ role: string; content: string }>,
    images: string[] = [],
    session?: SessionRef,
    requestId?: string,
  ) =>
    request<AiPlan>(baseUrl, `/api/projects/${projectId}/ai/plan`, {
      method: 'POST',
      body: {
        message,
        selectedIds,
        history,
        ...(images.length ? { images } : {}),
        ...(requestId ? { requestId } : {}),
        ...sessionBody(session),
      },
    });

  const api = {
    async status() {
      return request<AiStatus>(baseUrl, '/api/ai/status');
    },
    async plan(projectId: string, message: string, selectedIds: string[], history: Array<{ role: string; content: string }>, images: string[] = [], session?: SessionRef) {
      return planOnce(projectId, message, selectedIds, history, images, session);
    },

    /* ---------- 会话历史 ---------- */

    async conversations(projectId: string) {
      return request<{ conversations: AiConversationSummary[] }>(baseUrl, `/api/projects/${projectId}/ai/conversations`);
    },
    async createConversation(projectId: string, title?: string) {
      return request<{ conversation: AiConversation }>(baseUrl, `/api/projects/${projectId}/ai/conversations`, {
        method: 'POST',
        body: { title: title ?? '' },
      });
    },
    async conversation(conversationId: string) {
      return request<{ conversation: AiConversation }>(baseUrl, `/api/ai/conversations/${conversationId}`);
    },
    async renameConversation(conversationId: string, title: string) {
      return request<{ conversation: AiConversation }>(baseUrl, `/api/ai/conversations/${conversationId}`, {
        method: 'PATCH',
        body: { title },
      });
    },
    async deleteConversation(conversationId: string) {
      return request<{ ok: boolean }>(baseUrl, `/api/ai/conversations/${conversationId}`, { method: 'DELETE' });
    },
    /** 手动压缩上下文：把更早的消息压成一段备忘（自动压缩要攒到 18 条 / 6k token 才触发） */
    async compactConversation(projectId: string, conversationId: string) {
      return request<AiCompactResult>(
        baseUrl,
        `/api/projects/${projectId}/ai/conversations/${conversationId}/compact`,
        { method: 'POST' },
      );
    },
    /** 回写「这条回复已应用到模型」，历史里能看出哪些改了、哪些没改 */
    async markApplied(conversationId: string, messageId: string, rev: number) {
      return request<{ message: AiStoredMessage }>(
        baseUrl,
        `/api/ai/conversations/${conversationId}/messages/${messageId}`,
        { method: 'PATCH', body: { applied: true, rev } },
      );
    },

    /**
     * 流式生成建模指令：服务端用 SSE 推中间过程（思考/草稿/参数进度），
     * 这里按事件回调，最终返回与 plan 同构的结果。
     * images 是 dataURL 数组（服务端会先让视觉模型读图再建模）。
     * 服务端版本过旧（404）时自动退回一次性请求。
     *
     * 连接层中断（隧道/反代掐断长连接、网关抖动、流没收到 result 就结束）会自动重试：
     * 同一次发送复用 requestId，服务端不会重复插一条用户消息；重试前推一个 retry 事件，
     * 前端据此清掉上一轮的半截草稿。
     */
    async planStream(
      projectId: string,
      message: string,
      selectedIds: string[],
      history: Array<{ role: string; content: string }>,
      options: AiPlanStreamOptions = {},
      images: string[] = [],
      session?: SessionRef,
    ): Promise<AiPlan> {
      const requestId = options.requestId ?? makeRequestId();

      const attemptOnce = async (): Promise<AiPlan> => {
        const headers: Record<string, string> = {
          'Content-Type': 'application/json',
          Accept: 'text/event-stream',
        };
        const token = getAuthToken();
        if (token) headers.Authorization = `Bearer ${token}`;

        let response: Response;
        try {
          response = await fetch(baseUrl + `/api/projects/${projectId}/ai/plan/stream`, {
            method: 'POST',
            headers,
            body: JSON.stringify({
              message,
              selectedIds,
              history,
              ...(images.length ? { images } : {}),
              requestId,
              ...sessionBody(session),
            }),
            signal: options.signal,
          });
        } catch (error) {
          if ((error as Error)?.name === 'AbortError') throw new ApiError(0, '已停止生成');
          const detail = error instanceof Error ? error.message : '网络错误';
          throw new ApiError(0, `无法连接服务端（${detail}）：API 可能未启动或已断开，运行 ./start.sh restart 后重试`);
        }

        const contentType = response.headers.get('content-type') ?? '';
        // 旧服务端没有这个路由 / 不支持 SSE：退回一次性请求
        if (response.status === 404 || response.status === 405 || !/text\/event-stream/i.test(contentType)) {
          if (!response.ok) {
            let data: { error?: string } | null = null;
            try { data = await response.json(); } catch { data = null; }
            throw new ApiError(response.status, data?.error ?? `请求失败（HTTP ${response.status}）`);
          }
          const fallback = await planOnce(projectId, message, selectedIds, history, images, session, requestId);
          options.onEvent?.({ type: 'result', ...fallback });
          return fallback;
        }
        if (!response.body) throw new ApiError(502, '服务端没有返回流式响应体');

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let result: AiPlan | null = null;
        let failure = '';

        const handlePayload = (raw: string) => {
          let event: AiPlanEvent;
          try {
            event = JSON.parse(raw) as AiPlanEvent;
          } catch {
            return;
          }
          if (event.type === 'result') {
            result = {
              reply: event.reply ?? '',
              ops: Array.isArray(event.ops) ? event.ops : [],
              inspect: Array.isArray(event.inspect) ? event.inspect : [],
              done: event.done === true,
              summary: event.summary ?? {},
              provider: event.provider ?? '',
              model: event.model ?? '',
              mock: Boolean(event.mock),
              ms: event.ms,
              repaired: event.repaired ?? 0,
              warning: event.warning || undefined,
              vision: event.vision ?? null,
              context: event.context ?? null,
              conversationId: event.conversationId ?? null,
              messageId: event.messageId ?? null,
              userMessageId: event.userMessageId ?? null,
            };
            options.onEvent?.(event);
            return;
          }
          if (event.type === 'error') {
            failure = event.message || 'AI 调用失败';
            return;
          }
          options.onEvent?.(event);
        };

        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            let index;
            while ((index = buffer.indexOf('\n\n')) >= 0) {
              const frame = buffer.slice(0, index);
              buffer = buffer.slice(index + 2);
              for (const line of frame.split('\n')) {
                if (!line.startsWith('data:')) continue; // 注释 / 心跳
                const payload = line.slice(5).trim();
                if (payload) handlePayload(payload);
              }
            }
          }
        } catch (error) {
          if ((error as Error)?.name === 'AbortError') throw new ApiError(0, '已停止生成');
          throw new ApiError(0, error instanceof Error ? error.message : '流式响应中断');
        }

        if (failure) throw new ApiError(502, failure);
        if (!result) throw new ApiError(502, 'AI 流式响应中断（没有收到结果），请重试');
        return result;
      };

      let lastError: unknown = new ApiError(502, 'AI 流式响应中断（没有收到结果），请重试');
      for (let attempt = 1; attempt <= STREAM_ATTEMPTS; attempt += 1) {
        try {
          return await attemptOnce();
        } catch (error) {
          lastError = error;
          // 用户点了「停止」：哪怕这一下失败的形态是「流被截断」，也不能自动重来
          if (options.signal?.aborted) throw new ApiError(0, '已停止生成');
          if (!shouldRetryStream(error, attempt, options.signal)) throw error;
          const delayMs = STREAM_RETRY_DELAYS[attempt - 1] ?? STREAM_RETRY_DELAYS[STREAM_RETRY_DELAYS.length - 1];
          options.onEvent?.({
            type: 'retry',
            attempt: attempt + 1,
            total: STREAM_ATTEMPTS,
            delayMs,
            reason: describeStreamFailure(error),
          });
          await sleep(delayMs, options.signal);
          if (options.signal?.aborted) throw new ApiError(0, '已停止生成');
        }
      }
      throw lastError;
    },

    async apply(projectId: string, ops: Array<Record<string, unknown>>, message: string) {
      return request<AiApplyResult>(baseUrl, `/api/projects/${projectId}/ai/apply`, {
        method: 'POST',
        body: { ops, message },
      });
    },
  };
  return api;
}

export class HttpProjectRepository implements ProjectRepository {
  readonly kind = 'server' as const;

  private revs = new Map<string, number>();

  constructor(private readonly baseUrl = '') {}

  async list(): Promise<ProjectSummary[]> {
    const data = await request<{ projects: ProjectSummary[] }>(this.baseUrl, '/api/projects');
    for (const project of data.projects) {
      if (typeof project.rev === 'number') this.revs.set(project.id, project.rev);
    }
    return data.projects;
  }

  async load(id: string): Promise<ProjectDocument | null> {
    try {
      const data = await request<{ rev: number; document: ProjectDocument }>(
        this.baseUrl,
        `/api/projects/${id}/document`,
      );
      this.revs.set(id, data.rev);
      return migrateDocument(data.document);
    } catch (error) {
      if (error instanceof ApiError && (error.status === 404 || error.status === 403)) return null;
      throw error;
    }
  }

  async save(project: ProjectDocument, options?: SaveOptions): Promise<SaveResult> {
    const baseRev = this.revs.get(project.id);
    if (baseRev === undefined) {
      try {
        const created = await request<{ project: { rev: number } }>(this.baseUrl, '/api/projects', {
          method: 'POST',
          body: { id: project.id, name: project.name, document: project },
        });
        this.revs.set(project.id, created.project.rev);
        return { rev: created.project.rev };
      } catch (error) {
        if (!(error instanceof ConflictError)) throw error;
        // 项目已存在（其他标签页刚创建）：读取最新 rev 后走正常保存
        const fresh = await request<{ rev: number }>(this.baseUrl, `/api/projects/${project.id}/document`);
        this.revs.set(project.id, fresh.rev);
      }
    }
    const result = await request<{ rev: number }>(this.baseUrl, `/api/projects/${project.id}/document`, {
      method: 'PUT',
      body: { document: project, baseRev: this.revs.get(project.id), force: options?.force === true },
    });
    this.revs.set(project.id, result.rev);
    return { rev: result.rev };
  }

  adoptRevision(id: string, rev: number): void {
    this.revs.set(id, rev);
  }

  async remove(id: string): Promise<void> {
    await request(this.baseUrl, `/api/projects/${id}`, { method: 'DELETE' });
    this.revs.delete(id);
  }

  async loadLastOpenedId(): Promise<string | null> {
    return storage()?.getItem('strubrowser.server.lastOpened') ?? null;
  }

  async saveLastOpenedId(id: string): Promise<void> {
    storage()?.setItem('strubrowser.server.lastOpened', id);
  }
}
