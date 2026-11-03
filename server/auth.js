import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const TOKEN_VERSION = 'v1';
const TOKEN_TTL_SECONDS = 60 * 60 * 24 * 7;

const SCRYPT_OPTIONS = { N: 16384, r: 8, p: 1 };
const KEY_LENGTH = 64;

/** 读取或生成 HMAC 密钥，保证服务重启后 token 仍有效。 */
export function loadSecret(file) {
  if (process.env.STRU_SECRET) return process.env.STRU_SECRET;
  try {
    const existing = fs.readFileSync(file, 'utf8').trim();
    if (existing) return existing;
  } catch {
    // 首次启动，生成密钥
  }
  const secret = crypto.randomBytes(32).toString('base64url');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, secret, { mode: 0o600 });
  return secret;
}

export function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, KEY_LENGTH, SCRYPT_OPTIONS);
  return `scrypt$${salt.toString('base64url')}$${hash.toString('base64url')}`;
}

export function verifyPassword(password, stored) {
  const [scheme, saltPart, hashPart] = String(stored ?? '').split('$');
  if (scheme !== 'scrypt' || !saltPart || !hashPart) return false;
  const salt = Buffer.from(saltPart, 'base64url');
  const expected = Buffer.from(hashPart, 'base64url');
  const actual = crypto.scryptSync(password, salt, expected.length, SCRYPT_OPTIONS);
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

function sign(value, secret) {
  return crypto.createHmac('sha256', secret).update(value).digest('base64url');
}

export function createToken(user, secret) {
  const now = Math.floor(Date.now() / 1000);
  const payload = { sub: user.id, email: user.email, iat: now, exp: now + TOKEN_TTL_SECONDS };
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const body = `${TOKEN_VERSION}.${encoded}`;
  return `${body}.${sign(body, secret)}`;
}

export function verifyToken(token, secret) {
  if (typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== TOKEN_VERSION) return null;
  const body = `${parts[0]}.${parts[1]}`;
  const expected = sign(body, secret);
  const actual = parts[2];
  if (expected.length !== actual.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(actual))) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    if (!payload?.sub || typeof payload.exp !== 'number') return null;
    if (payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch {
    return null;
  }
}

export function validateCredentials({ email, password, name }) {
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email))) return '邮箱格式无效';
  if (typeof password !== 'string' || password.length < 6) return '密码至少 6 位';
  if (name !== undefined && (typeof name !== 'string' || !name.trim())) return '名称不能为空';
  return null;
}

export const ROLES = ['viewer', 'editor', 'admin'];
export const ROLE_LABELS = { viewer: '查看者', editor: '编辑者', admin: '管理者' };

export function canRead(role) {
  return role === 'viewer' || role === 'editor' || role === 'admin';
}

export function canWrite(role) {
  return role === 'editor' || role === 'admin';
}

export function canAdmin(role) {
  return role === 'admin';
}
