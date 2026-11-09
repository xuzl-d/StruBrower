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

    /** 管理员视图：全部项目（带 owner/成员数/文档大小），支持搜索分页。 */
    countAllProjects(query = '') {
      const like = `%${query}%`;
      return db.prepare('select count(*) as total from projects p where (? = \'\' or p.name like ? or p.id like ?)')
        .get(query, like, like).total;
    },

    listAllProjects({ query = '', limit = 50, offset = 0 } = {}) {
      const like = `%${query}%`;
      const rows = db.prepare(`
        select p.id, p.name, p.created_at, p.updated_at,
               u.email as owner_email, u.name as owner_name,
               coalesce(d.element_count, 0) as element_count,
               coalesce(d.rev, 0) as rev,
               coalesce(length(d.payload), 0) as document_bytes,
               (select count(*) from project_members m where m.project_id = p.id) as member_count
        from projects p
        left join users u on u.id = p.created_by
        left join documents d on d.project_id = p.id
        where (? = '' or p.name like ? or p.id like ?)
        order by p.updated_at desc
        limit ? offset ?
      `).all(query, like, like, limit, offset);
      return rows.map((row) => ({
        id: row.id,
        name: row.name,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        ownerEmail: row.owner_email ?? '',
        ownerName: row.owner_name ?? '',
        elementCount: row.element_count,
        rev: row.rev,
        documentBytes: row.document_bytes,
        memberCount: row.member_count,
      }));
    },

    countAudit({ action = '', projectId = '', userId = '' } = {}) {
      return db.prepare(`
        select count(*) as total from audit_log a
        where (? = '' or a.action like ?)
          and (? = '' or a.project_id = ?)
          and (? = '' or a.user_id = ?)
      `).get(action, `%${action}%`, projectId, projectId, userId, userId).total;
    },

    listAudit({ action = '', projectId = '', userId = '', limit = 50, offset = 0 } = {}) {
      const rows = db.prepare(`
        select a.id, a.project_id, a.user_id, a.action, a.detail, a.created_at,
               u.email as user_email, u.name as user_name, p.name as project_name
        from audit_log a
        left join users u on u.id = a.user_id
        left join projects p on p.id = a.project_id
        where (? = '' or a.action like ?)
          and (? = '' or a.project_id = ?)
          and (? = '' or a.user_id = ?)
        order by a.id desc
        limit ? offset ?
      `).all(action, `%${action}%`, projectId, projectId, userId, userId, limit, offset);
      return rows.map((row) => ({
        id: row.id,
        action: row.action,
        projectId: row.project_id,
        projectName: row.project_name ?? null,
        userId: row.user_id,
        userEmail: row.user_email ?? null,
        userName: row.user_name ?? null,
        detail: row.detail ?? null,
        createdAt: row.created_at,
      }));
    },

    documentStats() {
      return db.prepare('select count(*) as documents, coalesce(sum(length(payload)), 0) as bytes from documents').get();
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

    /* ---------- AI 会话（长对话 + 历史查看） ---------- */

    createConversation({ projectId, userId, title }) {
      const id = newId();
      const timestamp = nowIso();
      db.prepare(`insert into ai_conversations (id, project_id, created_by, title, summary, summary_seq, created_at, updated_at, archived)
                  values (?, ?, ?, ?, null, 0, ?, ?, 0)`)
        .run(id, projectId, userId ?? null, title ?? null, timestamp, timestamp);
      return this.getConversation(id);
    },

    /** 项目下的会话列表（按最近活跃排序），带消息条数与最后一句用于列表预览 */
    listConversations(projectId, { limit = 60 } = {}) {
      const rows = db.prepare(`
        select c.id, c.project_id, c.title, c.created_at, c.updated_at,
          (select count(*) from ai_messages m where m.conversation_id = c.id) as message_count,
          (select m.content from ai_messages m where m.conversation_id = c.id order by m.seq desc limit 1) as last_content,
          (select m.role from ai_messages m where m.conversation_id = c.id order by m.seq desc limit 1) as last_role
        from ai_conversations c
        where c.project_id = ? and c.archived = 0
        order by c.updated_at desc
        limit ?
      `).all(projectId, limit);
      return rows.map((row) => ({
        id: row.id,
        projectId: row.project_id,
        title: row.title,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        messageCount: row.message_count,
        preview: typeof row.last_content === 'string' ? row.last_content.slice(0, 80) : '',
        previewRole: row.last_role ?? null,
      }));
    },

    getConversation(conversationId, { withMessages = true } = {}) {
      const row = db.prepare('select * from ai_conversations where id = ?').get(conversationId);
      if (!row) return null;
      const conversation = {
        id: row.id,
        projectId: row.project_id,
        createdBy: row.created_by,
        title: row.title,
        summary: row.summary,
        summarySeq: row.summary_seq,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        archived: Boolean(row.archived),
      };
      if (withMessages) conversation.messages = this.listMessages(conversationId);
      return conversation;
    },

    listMessages(conversationId, { afterSeq = 0, limit = 500 } = {}) {
      const rows = db.prepare(`select * from ai_messages where conversation_id = ? and seq > ? order by seq asc limit ?`)
        .all(conversationId, afterSeq, limit);
      return rows.map((row) => ({
        id: row.id,
        conversationId: row.conversation_id,
        seq: row.seq,
        role: row.role,
        content: row.content,
        ...(row.payload ? safeJson(row.payload) : {}),
        createdAt: row.created_at,
      }));
    },

    renameConversation(conversationId, title) {
      db.prepare('update ai_conversations set title = ?, updated_at = ? where id = ?')
        .run(title, nowIso(), conversationId);
    },

    deleteConversation(conversationId) {
      db.prepare('delete from ai_conversations where id = ?').run(conversationId);
    },

    /** 追加一条消息；seq 由服务端按会话内自增分配，前端不必关心 */
    appendMessage({ conversationId, role, content, payload }) {
      const next = (db.prepare('select coalesce(max(seq), 0) as seq from ai_messages where conversation_id = ?')
        .get(conversationId).seq) + 1;
      const id = newId();
      const timestamp = nowIso();
      db.prepare(`insert into ai_messages (id, conversation_id, seq, role, content, payload, created_at)
                  values (?, ?, ?, ?, ?, ?, ?)`)
        .run(id, conversationId, next, role, String(content ?? ''), payload ? JSON.stringify(payload) : null, timestamp);
      const title = this.maybeTitle(conversationId, role, content);
      db.prepare('update ai_conversations set updated_at = ? where id = ?').run(timestamp, conversationId);
      return { id, seq: next, role, content, createdAt: timestamp, ...(payload ?? {}), ...(title ? { title } : {}) };
    },

    /** 会话还没有标题时，用第一句用户需求当标题（与 ChatGPT 一致的行为） */
    maybeTitle(conversationId, role, content) {
      if (role !== 'user') return null;
      const row = db.prepare('select title from ai_conversations where id = ?').get(conversationId);
      if (!row || (row.title && row.title.trim())) return null;
      const text = String(content ?? '').replace(/\s+/g, ' ').trim();
      if (!text) return null;
      const title = text.length > 24 ? `${text.slice(0, 24)}…` : text;
      db.prepare('update ai_conversations set title = ? where id = ?').run(title, conversationId);
      return title;
    },

    /** 删除一条消息（重试成功后清掉上一轮的错误气泡，seq 留空不影响后续追加） */
    deleteMessage(conversationId, messageId) {
      db.prepare('delete from ai_messages where id = ? and conversation_id = ?').run(messageId, conversationId);
    },

    /** 补写消息的附加信息（例如「已应用到模型」、修正后的 ops） */
    updateMessagePayload(conversationId, messageId, patch) {
      const row = db.prepare('select payload from ai_messages where id = ? and conversation_id = ?')
        .get(messageId, conversationId);
      if (!row) return null;
      const merged = { ...(row.payload ? safeJson(row.payload) : {}), ...patch };
      db.prepare('update ai_messages set payload = ? where id = ?').run(JSON.stringify(merged), messageId);
      return merged;
    },

    /** 滚动摘要：把前若干条压成一段话，只保留在会话记录里，不再回传原文 */
    setConversationSummary(conversationId, summary, seq) {
      db.prepare('update ai_conversations set summary = ?, summary_seq = ? where id = ?')
        .run(summary ?? null, seq ?? 0, conversationId);
    },
  };
}

/** payload 是早期版本写入的非法 JSON 时不要让整个会话打不开 */
function safeJson(text) {
  try {
    const value = JSON.parse(text);
    return value && typeof value === 'object' ? value : {};
  } catch {
    return {};
  }
}
