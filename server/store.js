import crypto from 'node:crypto';
import { openDatabase } from './db.js';
import { applyDocumentDiff, validateDocument } from './validate.js';

const newId = () => crypto.randomUUID();
const nowIso = () => new Date().toISOString();

function mapUser(row) {
  if (!row) return null;
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    isAdmin: Boolean(row.is_admin),
    createdAt: row.created_at,
  };
}

/**
 * 数据访问层（SQLite）。所有写操作都是同步的（node:sqlite 同步 API），
 * HTTP 层直接调用即可；后续换 PostgreSQL 时保持这些函数签名不变。
 */
export function createStore(file) {
  const db = openDatabase(file);

  const audit = (projectId, userId, action, detail) => {
    db.prepare('insert into audit_log (project_id, user_id, action, detail, created_at) values (?, ?, ?, ?, ?)')
      .run(projectId ?? null, userId ?? null, action, detail ? JSON.stringify(detail) : null, nowIso());
  };

  return {
    db,
    audit,

    /* ---------- 用户 ---------- */

    createUser({ email, name, passwordHash, isAdmin }) {
      const user = { id: newId(), email: email.toLowerCase(), name, passwordHash, createdAt: nowIso() };
      const admin = isAdmin === true || (isAdmin === undefined && this.countUsers() === 0);
      db.prepare('insert into users (id, email, name, password_hash, is_admin, created_at) values (?, ?, ?, ?, ?, ?)')
        .run(user.id, user.email, user.name, user.passwordHash, admin ? 1 : 0, user.createdAt);
      return mapUser({
        id: user.id, email: user.email, name: user.name, is_admin: admin ? 1 : 0, created_at: user.createdAt,
      });
    },

    listAllUsers() {
      const rows = db.prepare(`
        select u.id, u.email, u.name, u.is_admin, u.created_at,
          (select count(*) from projects p where p.created_by = u.id) as owned_projects,
          (select count(*) from project_members m where m.user_id = u.id) as memberships
        from users u order by u.created_at asc
      `).all();
      return rows.map((row) => ({
        ...mapUser(row),
        ownedProjects: row.owned_projects,
        memberships: row.memberships,
      }));
    },

    countSystemAdmins() {
      return db.prepare('select count(*) as total from users where is_admin = 1').get().total;
    },

    updateUser(id, patch) {
      if (patch.name !== undefined) {
        db.prepare('update users set name = ? where id = ?').run(patch.name, id);
      }
      if (patch.passwordHash !== undefined) {
        db.prepare('update users set password_hash = ? where id = ?').run(patch.passwordHash, id);
      }
      if (patch.isAdmin !== undefined) {
        db.prepare('update users set is_admin = ? where id = ?').run(patch.isAdmin ? 1 : 0, id);
      }
    },

    deleteUser(id) {
      const owned = db.prepare('select count(*) as total from projects where created_by = ?').get(id).total;
      if (owned > 0) return { error: 'USER_OWNS_PROJECTS', owned };
      db.prepare('delete from users where id = ?').run(id);
      return { ok: true };
    },

    /* ---------- 系统设置 ---------- */

    getSetting(key) {
      const row = db.prepare('select value from app_settings where key = ?').get(key);
      return row?.value ?? null;
    },

    listSettings() {
      const rows = db.prepare('select key, value from app_settings').all();
      return Object.fromEntries(rows.map((row) => [row.key, row.value]));
    },

    setSetting(key, value, userId) {
      db.prepare(`insert into app_settings (key, value, updated_at, updated_by) values (?, ?, ?, ?)
                  on conflict (key) do update set value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by`)
        .run(key, value, nowIso(), userId ?? null);
    },

    deleteSetting(key) {
      db.prepare('delete from app_settings where key = ?').run(key);
    },

    findUserByEmail(email) {
      const row = db.prepare('select * from users where email = ?').get(String(email).toLowerCase());
      if (!row) return null;
      return { ...mapUser(row), passwordHash: row.password_hash };
    },

    userById(id) {
      return mapUser(db.prepare('select * from users where id = ?').get(id));
    },

    countUsers() {
      return db.prepare('select count(*) as total from users').get().total;
    },

    /* ---------- 项目 ---------- */

    listProjects(userId) {
      const rows = db.prepare(`
        select p.id, p.name, p.updated_at, p.created_at, m.role,
               coalesce(d.element_count, 0) as element_count,
               coalesce(d.rev, 0) as rev
        from projects p
        join project_members m on m.project_id = p.id
        left join documents d on d.project_id = p.id
        where m.user_id = ? and p.archived = 0
        order by p.updated_at desc
      `).all(userId);
      return rows.map((row) => ({
        id: row.id,
        name: row.name,
        updatedAt: row.updated_at,
        createdAt: row.created_at,
        elementCount: row.element_count,
        rev: row.rev,
        role: row.role,
      }));
    },

    getMembership(projectId, userId) {
      const row = db.prepare('select role from project_members where project_id = ? and user_id = ?')
        .get(projectId, userId);
      return row?.role ?? null;
    },

    getProject(projectId) {
      const row = db.prepare('select * from projects where id = ?').get(projectId);
      if (!row) return null;
      return { id: row.id, name: row.name, createdBy: row.created_by, createdAt: row.created_at, updatedAt: row.updated_at };
    },

    createProject({ name, ownerId, document, projectId: requestedId }) {
      const projectId = requestedId ?? newId();
      const timestamp = nowIso();
      db.exec('BEGIN');
      try {
        db.prepare('insert into projects (id, name, created_by, created_at, updated_at) values (?, ?, ?, ?, ?)')
          .run(projectId, name, ownerId, timestamp, timestamp);
        db.prepare('insert into project_members (project_id, user_id, role, created_at) values (?, ?, ?, ?)')
          .run(projectId, ownerId, 'admin', timestamp);
        db.prepare(`insert into documents (project_id, rev, schema_version, element_count, payload, updated_by, updated_at)
                    values (?, 1, ?, ?, ?, ?, ?)`)
          .run(
            projectId,
            document.schemaVersion ?? 2,
            document.elements?.length ?? 0,
            JSON.stringify(document),
            ownerId,
            timestamp,
          );
        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
      audit(projectId, ownerId, 'project.create', { name });
      return this.getProject(projectId);
    },

    renameProject(projectId, name, userId) {
      db.prepare('update projects set name = ?, updated_at = ? where id = ?').run(name, nowIso(), projectId);
      audit(projectId, userId, 'project.rename', { name });
    },

    deleteProject(projectId, userId) {
      audit(projectId, userId, 'project.delete', null);
      db.prepare('delete from projects where id = ?').run(projectId);
    },

    touchProject(projectId) {
      db.prepare('update projects set updated_at = ? where id = ?').run(nowIso(), projectId);
    },

    /* ---------- 成员 ---------- */

    listMembers(projectId) {
      const rows = db.prepare(`
        select u.id, u.email, u.name, m.role, m.created_at
        from project_members m join users u on u.id = m.user_id
        where m.project_id = ?
        order by m.created_at asc
      `).all(projectId);
      return rows.map((row) => ({ id: row.id, email: row.email, name: row.name, role: row.role, addedAt: row.created_at }));
    },

    addMember(projectId, userId, role) {
      db.prepare(`insert into project_members (project_id, user_id, role, created_at) values (?, ?, ?, ?)
                  on conflict (project_id, user_id) do update set role = excluded.role`)
        .run(projectId, userId, role, nowIso());
    },

    updateMemberRole(projectId, userId, role) {
      db.prepare('update project_members set role = ? where project_id = ? and user_id = ?')
        .run(role, projectId, userId);
    },

    removeMember(projectId, userId) {
      db.prepare('delete from project_members where project_id = ? and user_id = ?').run(projectId, userId);
    },

    countAdmins(projectId) {
      return db.prepare("select count(*) as total from project_members where project_id = ? and role = 'admin'")
        .get(projectId).total;
    },

    /* ---------- 文档 ---------- */

    getDocument(projectId) {
      const row = db.prepare('select * from documents where project_id = ?').get(projectId);
      if (!row) return null;
      return {
        rev: row.rev,
        schemaVersion: row.schema_version,
        updatedAt: row.updated_at,
        updatedBy: row.updated_by,
        document: JSON.parse(row.payload),
      };
    },

    /** 保存文档；baseRev 不匹配且未 force 时返回冲突信息，不写库。 */
    saveDocument({ projectId, document, userId, baseRev, force }) {
      const current = db.prepare('select rev from documents where project_id = ?').get(projectId);
      if (!current) return { missing: true };
      if (!force && Number(baseRev) !== current.rev) {
        return { conflict: true, rev: current.rev };
      }
      const nextRev = current.rev + 1;
      const timestamp = nowIso();
      db.prepare(`update documents set rev = ?, schema_version = ?, element_count = ?, payload = ?, updated_by = ?, updated_at = ?
                  where project_id = ?`)
        .run(nextRev, document.schemaVersion ?? 2, document.elements?.length ?? 0, JSON.stringify(document), userId, timestamp, projectId);
      const name = typeof document.name === 'string' && document.name.trim() ? document.name.trim() : null;
      if (name) db.prepare('update projects set name = ?, updated_at = ? where id = ?').run(name, timestamp, projectId);
      else db.prepare('update projects set updated_at = ? where id = ?').run(timestamp, projectId);
      audit(projectId, userId, 'document.save', { rev: nextRev, elements: document.elements?.length ?? 0 });
      return { rev: nextRev };
    },

    /** 协作补丁：按构件 id 合并后落库，返回新 rev 与合并后的文档。 */
    applyPatch({ projectId, diff, userId }) {
      const row = db.prepare('select rev, payload from documents where project_id = ?').get(projectId);
      if (!row) return null;
      const document = JSON.parse(row.payload);
      const next = applyDocumentDiff(document, diff);
      const error = validateDocument(next);
      if (error) return { error };
      const timestamp = nowIso();
      next.updatedAt = timestamp;
      const nextRev = row.rev + 1;
      db.prepare(`update documents set rev = ?, schema_version = ?, element_count = ?, payload = ?, updated_by = ?, updated_at = ?
                  where project_id = ?`)
        .run(nextRev, next.schemaVersion ?? 2, next.elements.length, JSON.stringify(next), userId, timestamp, projectId);
      const name = typeof next.name === 'string' && next.name.trim() ? next.name.trim() : null;
      if (name) db.prepare('update projects set name = ?, updated_at = ? where id = ?').run(name, timestamp, projectId);
      else db.prepare('update projects set updated_at = ? where id = ?').run(timestamp, projectId);
      audit(projectId, userId, 'document.patch', {
        rev: nextRev,
        put: diff.elements?.put?.length ?? 0,
        remove: diff.elements?.remove?.length ?? 0,
      });
      return { rev: nextRev, document: next };
    },

    /* ---------- 版本 ---------- */

    listVersions(projectId) {
      const rows = db.prepare(`
        select v.version, v.label, v.created_at, u.name as author
        from document_versions v left join users u on u.id = v.created_by
        where v.project_id = ?
        order by v.version desc
      `).all(projectId);
      return rows.map((row) => ({ version: row.version, label: row.label, createdAt: row.created_at, author: row.author }));
    },

    createVersion({ projectId, label, userId }) {
      const latest = db.prepare('select coalesce(max(version), 0) as version from document_versions where project_id = ?')
        .get(projectId).version;
      const document = db.prepare('select payload from documents where project_id = ?').get(projectId);
      if (!document) return null;
      const version = latest + 1;
      db.prepare(`insert into document_versions (project_id, version, label, payload, created_by, created_at)
                  values (?, ?, ?, ?, ?, ?)`)
        .run(projectId, version, label ?? null, document.payload, userId, nowIso());
      audit(projectId, userId, 'version.create', { version, label: label ?? null });
      return { version, createdAt: nowIso() };
    },

    getVersion(projectId, version) {
      const row = db.prepare('select * from document_versions where project_id = ? and version = ?')
        .get(projectId, version);
      if (!row) return null;
      return {
        version: row.version,
        label: row.label,
        createdAt: row.created_at,
        document: JSON.parse(row.payload),
      };
    },

    /** 把历史版本写回当前文档（产生新的 rev，历史不可变）。 */
    restoreVersion({ projectId, version, userId }) {
      const row = db.prepare('select payload from document_versions where project_id = ? and version = ?')
        .get(projectId, version);
      if (!row) return null;
      const document = JSON.parse(row.payload);
      const current = db.prepare('select rev from documents where project_id = ?').get(projectId);
      if (!current) return null;
      const nextRev = current.rev + 1;
      const timestamp = nowIso();
      db.prepare(`update documents set rev = ?, schema_version = ?, element_count = ?, payload = ?, updated_by = ?, updated_at = ?
                  where project_id = ?`)
        .run(nextRev, document.schemaVersion ?? 2, document.elements?.length ?? 0, JSON.stringify(document), userId, timestamp, projectId);
      const restoredName = typeof document.name === 'string' && document.name.trim() ? document.name.trim() : null;
      if (restoredName) db.prepare('update projects set name = ?, updated_at = ? where id = ?').run(restoredName, timestamp, projectId);
      else db.prepare('update projects set updated_at = ? where id = ?').run(timestamp, projectId);
      audit(projectId, userId, 'version.restore', { version, rev: nextRev });
      return { rev: nextRev, document };
    },
  };
}
