import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const SCHEMA = `
create table if not exists users (
  id text primary key,
  email text not null unique,
  name text not null,
  password_hash text not null,
  created_at text not null
);

create table if not exists projects (
  id text primary key,
  name text not null,
  created_by text not null references users(id),
  created_at text not null,
  updated_at text not null,
  archived integer not null default 0
);

create table if not exists project_members (
  project_id text not null references projects(id) on delete cascade,
  user_id text not null references users(id) on delete cascade,
  role text not null check (role in ('viewer', 'editor', 'admin')),
  created_at text not null,
  primary key (project_id, user_id)
);

create table if not exists documents (
  project_id text primary key references projects(id) on delete cascade,
  rev integer not null default 1,
  schema_version integer not null,
  element_count integer not null default 0,
  payload text not null,
  updated_by text,
  updated_at text not null
);

create table if not exists document_versions (
  project_id text not null references projects(id) on delete cascade,
  version integer not null,
  label text,
  payload text not null,
  created_by text,
  created_at text not null,
  primary key (project_id, version)
);

create table if not exists app_settings (
  key text primary key,
  value text not null,
  updated_at text not null,
  updated_by text
);

create table if not exists audit_log (
  id integer primary key autoincrement,
  project_id text,
  user_id text,
  action text not null,
  detail text,
  created_at text not null
);

create index if not exists idx_members_user on project_members (user_id);
create index if not exists idx_versions_project on document_versions (project_id, version desc);
create index if not exists idx_audit_project on audit_log (project_id, id desc);
`;

/**
 * 打开（并初始化）SQLite 数据库。
 * 使用 Node 内置 node:sqlite，无需原生扩展；启动时需 --experimental-sqlite。
 */
export function openDatabase(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const database = new DatabaseSync(file);
  database.exec('PRAGMA journal_mode = WAL;');
  database.exec('PRAGMA foreign_keys = ON;');
  database.exec(SCHEMA);
  // 兼容旧库：补 users.is_admin 列
  const columns = database.prepare('pragma table_info(users)').all();
  if (!columns.some((column) => column.name === 'is_admin')) {
    database.exec('alter table users add column is_admin integer not null default 0');
  }
  return database;
}
