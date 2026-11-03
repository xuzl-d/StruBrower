import { LocalProjectRepository } from './localRepository';
import {
  createAdminApi,
  createAiApi,
  createAuthApi,
  createMembersApi,
  createVersionsApi,
  HttpProjectRepository,
  pingServer,
} from './http';
import type { ProjectRepository } from './repository';

export { ApiError, ConflictError, getAuthToken, pingServer, setAuthToken } from './http';
export type {
  AdminUser,
  AiApplyResult,
  AiPlan,
  AiSettingsPayload,
  AiSettingsView,
  AiStatus,
  AuthUser,
  MemberEntry,
  VersionEntry,
} from './http';

export interface RepositoryChoice {
  repository: ProjectRepository;
  mode: 'local' | 'server';
}

const env = import.meta.env as unknown as Record<string, string | undefined>;

/**
 * 决定使用哪种存储：
 * 1. STRU_MODE=local → 强制本地
 * 2. STRU_MODE=server → 强制服务端（连不上会显示登录页错误）
 * 3. 默认 → 探测 /api/health，可用则服务端，否则本地
 */
export async function resolveRepository(): Promise<RepositoryChoice> {
  const forced = env.VITE_STRU_MODE;
  if (forced === 'local') return { repository: new LocalProjectRepository(), mode: 'local' };
  if (forced === 'server') return { repository: new HttpProjectRepository(), mode: 'server' };
  const available = await pingServer('', 1500);
  return available
    ? { repository: new HttpProjectRepository(), mode: 'server' }
    : { repository: new LocalProjectRepository(), mode: 'local' };
}

export const authApi = createAuthApi();
export const aiApi = createAiApi();
export const adminApi = createAdminApi();
export const versionsApi = createVersionsApi();
export const membersApi = createMembersApi();
