import type { ProjectSummary } from '../bim/document';
import type { ProjectDocument } from '../bim/types';

export interface SaveOptions {
  /** 忽略版本冲突，强制覆盖服务端文档 */
  force?: boolean;
}

export interface SaveResult {
  rev?: number;
}

/**
 * 数据访问层。
 * - LocalProjectRepository：浏览器 IndexedDB（单机 / 离线演示）
 * - HttpProjectRepository：Node 服务端（用户、权限、版本、rev 冲突检测）
 * 编辑器只依赖这个接口，不感知存储细节。
 */
export interface ProjectRepository {
  readonly kind: 'local' | 'server';
  list(): Promise<ProjectSummary[]>;
  load(id: string): Promise<ProjectDocument | null>;
  save(project: ProjectDocument, options?: SaveOptions): Promise<SaveResult>;
  remove(id: string): Promise<void>;
  loadLastOpenedId(): Promise<string | null>;
  saveLastOpenedId(id: string): Promise<void>;
  /** 协作补丁落库后同步本地 rev，避免断线重连后的 HTTP 保存误判为冲突 */
  adoptRevision?(id: string, rev: number): void;
}
