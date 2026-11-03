import crypto from 'node:crypto';

/**
 * API key 等敏感配置在 SQLite 里加密存储（AES-256-GCM），
 * 密钥由服务端 STRU_SECRET 派生；读出后只在服务端内存/调用中使用，接口只返回掩码。
 */
export function createSecretBox(secret) {
  const key = crypto.createHash('sha256').update(String(secret)).digest();

  return {
    seal(plain) {
      const iv = crypto.randomBytes(12);
      const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
      const encrypted = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
      const tag = cipher.getAuthTag();
      return `v1:${iv.toString('base64url')}:${tag.toString('base64url')}:${encrypted.toString('base64url')}`;
    },
    open(payload) {
      try {
        const [version, ivPart, tagPart, dataPart] = String(payload ?? '').split(':');
        if (version !== 'v1' || !ivPart || !tagPart || !dataPart) return '';
        const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivPart, 'base64url'));
        decipher.setAuthTag(Buffer.from(tagPart, 'base64url'));
        return Buffer.concat([
          decipher.update(Buffer.from(dataPart, 'base64url')),
          decipher.final(),
        ]).toString('utf8');
      } catch {
        return '';
      }
    },
  };
}
