import { migrateDocument, summarize } from '../bim/document';
import type { ProjectDocument } from '../bim/types';
import type { ProjectRepository, SaveOptions, SaveResult } from './repository';
import type { ProjectSummary } from '../bim/document';

const DATABASE_NAME = 'strubrowser.bim';
const DATABASE_VERSION = 1;
const PROJECTS_STORE = 'projects';
const LAST_OPENED_KEY = 'strubrowser.bim.lastOpened';
const LEGACY_DATABASE = 'strubrowser';
const LEGACY_STORE = 'workspace';
const LEGACY_RECORD = 'documents';
const LEGACY_LOCAL_KEY = 'strubrowser.documents.v1';

function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('本地数据库操作失败。'));
  });
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(PROJECTS_STORE)) {
        database.createObjectStore(PROJECTS_STORE, { keyPath: 'id' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('无法打开本地项目数据库。'));
  });
}

async function readAll(database: IDBDatabase): Promise<ProjectDocument[]> {
  const transaction = database.transaction(PROJECTS_STORE, 'readonly');
  const records = await requestToPromise(transaction.objectStore(PROJECTS_STORE).getAll());
  return records as ProjectDocument[];
}

async function putAll(database: IDBDatabase, projects: ProjectDocument[]): Promise<void> {
  const transaction = database.transaction(PROJECTS_STORE, 'readwrite');
  const store = transaction.objectStore(PROJECTS_STORE);
  for (const project of projects) store.put(project);
  await new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error('写入本地项目数据库失败。'));
    transaction.onabort = () => reject(transaction.error ?? new Error('本地项目写入被中止。'));
  });
}

/** 把 v1（网格原型）的旧数据迁移到 v2 项目库，成功后清空旧记录。 */
async function migrateLegacyProjects(database: IDBDatabase): Promise<void> {
  const legacy: unknown[] = [];
  const localRaw = localStorage.getItem(LEGACY_LOCAL_KEY);
  if (localRaw) {
    try {
      const parsed: unknown = JSON.parse(localRaw);
      if (Array.isArray(parsed)) legacy.push(...parsed);
    } catch {
      // 忽略损坏的旧数据
    }
  }
  try {
    const oldDatabase = await new Promise<IDBDatabase | null>((resolve) => {
      const request = indexedDB.open(LEGACY_DATABASE, 1);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => resolve(null);
      request.onupgradeneeded = () => {
        // 旧库不存在内容，忽略
      };
    });
    if (oldDatabase) {
      if (oldDatabase.objectStoreNames.contains(LEGACY_STORE)) {
        const transaction = oldDatabase.transaction(LEGACY_STORE, 'readonly');
        const record: unknown = await requestToPromise(transaction.objectStore(LEGACY_STORE).get(LEGACY_RECORD));
        const value = (record as { value?: unknown } | undefined)?.value;
        if (Array.isArray(value)) legacy.push(...value);
      }
      oldDatabase.close();
    }
  } catch {
    // 旧库不可读时跳过迁移
  }
  if (!legacy.length) return;
  const projects = legacy.map((item) => migrateDocument(item));
  await putAll(database, projects);
  localStorage.removeItem(LEGACY_LOCAL_KEY);
}

let migrationDone = false;

async function withDatabase<T>(operation: (database: IDBDatabase) => Promise<T>): Promise<T> {
  const database = await openDatabase();
  try {
    if (!migrationDone) {
      migrationDone = true;
      const existing = await readAll(database);
      if (!existing.length) await migrateLegacyProjects(database);
    }
    return await operation(database);
  } finally {
    database.close();
  }
}

export class LocalProjectRepository implements ProjectRepository {
  readonly kind = 'local' as const;

  async list(): Promise<ProjectSummary[]> {
    return withDatabase(async (database) => {
      const projects = await readAll(database);
      return projects.map(summarize).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    });
  }

  async load(id: string): Promise<ProjectDocument | null> {
    return withDatabase(async (database) => {
      const transaction = database.transaction(PROJECTS_STORE, 'readonly');
      const record: unknown = await requestToPromise(transaction.objectStore(PROJECTS_STORE).get(id));
      if (!record) return null;
      return migrateDocument(record);
    });
  }

  async save(project: ProjectDocument, _options?: SaveOptions): Promise<SaveResult> {
    await withDatabase(async (database) => {
      await putAll(database, [project]);
    });
    return {};
  }

  async remove(id: string): Promise<void> {
    await withDatabase(async (database) => {
      const transaction = database.transaction(PROJECTS_STORE, 'readwrite');
      transaction.objectStore(PROJECTS_STORE).delete(id);
      await new Promise<void>((resolve, reject) => {
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error ?? new Error('删除项目失败。'));
      });
    });
  }

  async loadLastOpenedId(): Promise<string | null> {
    return localStorage.getItem(LAST_OPENED_KEY);
  }

  async saveLastOpenedId(id: string): Promise<void> {
    localStorage.setItem(LAST_OPENED_KEY, id);
  }
}

export const projectRepository: ProjectRepository = new LocalProjectRepository();
