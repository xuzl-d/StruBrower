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

export interface AiSettingsView {
  provider: 'mock' | 'openai';
  baseUrl: string;
  model: string;
  timeoutMs: number;
  hasKey: boolean;
  keyHint: string;
  ready: boolean;
  source: Record<string, string>;
}

export interface AiSettingsPayload {
  provider?: 'mock' | 'openai';
  baseUrl?: string;
  model?: string;
  timeoutMs?: number;
  apiKey?: string;
  clearKey?: boolean;
}

export interface AiStatus {
  provider: string;
  model: string;
  ready: boolean;
  mock: boolean;
  ops: string[];
}

export interface AiPlan {
  reply: string;
  ops: Array<Record<string, unknown>>;
  summary: Record<string, number>;
  provider: string;
  model: string;
  mock: boolean;
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
      return request<{ ok: boolean; provider: string; model?: string; reply?: string; error?: string }>(
        baseUrl,
        '/api/admin/settings/ai/test',
        { method: 'POST' },
      );
    },
  };
}

export function createAiApi(baseUrl = '') {
  return {
    async status() {
      return request<AiStatus>(baseUrl, '/api/ai/status');
    },
    async plan(projectId: string, message: string, selectedIds: string[], history: Array<{ role: string; content: string }>) {
      return request<AiPlan>(baseUrl, `/api/projects/${projectId}/ai/plan`, {
        method: 'POST',
        body: { message, selectedIds, history },
      });
    },
    async apply(projectId: string, ops: Array<Record<string, unknown>>, message: string) {
      return request<AiApplyResult>(baseUrl, `/api/projects/${projectId}/ai/apply`, {
        method: 'POST',
        body: { ops, message },
      });
    },
  };
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
