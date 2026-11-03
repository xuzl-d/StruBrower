import crypto from 'node:crypto';
import { canWrite, verifyToken } from './auth.js';
import { applyDocumentDiff, validateDiff, validateDocument } from './validate.js';

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_FRAME_BYTES = 96 * 1024 * 1024;
const HEARTBEAT_MS = 30000;

function encodeFrame(payload, opcode = 0x1) {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), 'utf8');
  const length = data.length;
  let header;
  if (length < 126) {
    header = Buffer.from([0x80 | opcode, length]);
  } else if (length < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(length), 2);
  }
  return Buffer.concat([header, data]);
}

function closePayload(code = 1000, reason = '') {
  const text = Buffer.from(reason, 'utf8');
  const payload = Buffer.alloc(2 + text.length);
  payload.writeUInt16BE(code, 0);
  text.copy(payload, 2);
  return payload;
}

/** 极简 RFC6455 服务端连接：只支持文本帧、分片、ping/pong 与关闭。 */
class Connection {
  constructor(socket, handlers) {
    this.socket = socket;
    this.handlers = handlers;
    this.chunks = [];
    this.total = 0;
    this.fragments = [];
    this.closed = false;
    socket.on('data', (chunk) => this.push(chunk));
    socket.on('close', () => this.finish());
    socket.on('error', () => this.finish());
  }

  push(chunk) {
    if (this.closed) return;
    this.chunks.push(chunk);
    this.total += chunk.length;
    this.drain();
  }

  ensure(size) {
    while (this.chunks[0] && this.chunks[0].length < size && this.chunks.length > 1) {
      this.chunks[0] = Buffer.concat([this.chunks[0], this.chunks[1]]);
      this.chunks.splice(1, 1);
    }
    return this.chunks[0];
  }

  take(size) {
    const merged = this.chunks.length === 1 ? this.chunks[0] : Buffer.concat(this.chunks);
    const out = Buffer.from(merged.subarray(0, size));
    const rest = merged.subarray(size);
    this.chunks = rest.length ? [rest] : [];
    this.total = rest.length;
    return out;
  }

  drain() {
    while (!this.closed) {
      const head = this.ensure(14);
      if (!head || head.length < 2) return;
      const fin = (head[0] & 0x80) !== 0;
      const opcode = head[0] & 0x0f;
      const masked = (head[1] & 0x80) !== 0;
      let length = head[1] & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (head.length < 4) return;
        length = head.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        if (head.length < 10) return;
        length = Number(head.readBigUInt64BE(2));
        offset = 10;
      }
      if (length > MAX_FRAME_BYTES) {
        this.close(1009, 'frame too large');
        return;
      }
      const maskLength = masked ? 4 : 0;
      const frameLength = offset + maskLength + length;
      if (this.total < frameLength) return;

      const frame = this.take(frameLength);
      const mask = masked ? frame.subarray(offset, offset + 4) : null;
      const payload = Buffer.from(frame.subarray(offset + maskLength));
      if (mask) for (let index = 0; index < payload.length; index += 1) payload[index] ^= mask[index & 3];

      if (opcode === 0x8) {
        this.close(1000, '');
        return;
      }
      if (opcode === 0x9) {
        this.write(encodeFrame(payload, 0xa));
        continue;
      }
      if (opcode === 0xa) {
        this.handlers.onPong?.();
        continue;
      }
      if (opcode === 0x1 || opcode === 0x0) {
        this.fragments.push(payload);
        if (fin) {
          const full = Buffer.concat(this.fragments);
          this.fragments = [];
          try {
            this.handlers.onMessage?.(full.toString('utf8'));
          } catch (error) {
            this.handlers.onError?.(error);
          }
        }
      }
    }
  }

  write(buffer) {
    if (this.closed || this.socket.destroyed) return;
    try {
      this.socket.write(buffer);
    } catch {
      this.finish();
    }
  }

  send(message) {
    this.write(encodeFrame(JSON.stringify(message)));
  }

  ping() {
    this.write(encodeFrame(Buffer.alloc(0), 0x9));
  }

  close(code = 1000, reason = '') {
    if (this.closed) return;
    this.write(encodeFrame(closePayload(code, reason), 0x8));
    this.closed = true;
    try {
      this.socket.end();
    } catch {
      this.socket.destroy();
    }
    this.finish();
  }

  finish() {
    if (this.done) return;
    this.done = true;
    this.closed = true;
    try {
      this.socket.destroy();
    } catch {
      // 忽略
    }
    this.handlers.onClose?.();
  }
}

function rejectUpgrade(socket, status, message) {
  const body = `${message}\n`;
  try {
    socket.write(
      `HTTP/1.1 ${status} ${message}\r\nConnection: close\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`,
    );
  } finally {
    socket.destroy();
  }
}

/**
 * 协作服务：房间广播 + 文档差分合并 + 在线状态。
 * 文档以“按构件 id 的 LWW 差分”合并，服务端是唯一的 rev 来源。
 */
export function attachCollabServer(httpServer, { store, secret, logger = console }) {
  const rooms = new Map();

  const usersOf = (room) => [...room.clients].map((client) => ({
    id: client.id,
    userId: client.user.id,
    name: client.user.name,
    role: client.role,
  }));

  const broadcast = (projectId, message, exceptClientId) => {
    const room = rooms.get(projectId);
    if (!room) return;
    for (const client of room.clients) {
      if (client.id !== exceptClientId) client.connection.send(message);
    }
  };

  const broadcastPresence = (projectId) => {
    const room = rooms.get(projectId);
    if (!room) return;
    broadcast(projectId, { type: 'presence', users: usersOf(room) });
  };

  const removeClient = (client) => {
    const room = rooms.get(client.projectId);
    if (!room) return;
    if (room.clients.delete(client)) {
      if (!room.clients.size) rooms.delete(client.projectId);
      else broadcastPresence(client.projectId);
    }
  };

  const handleMessage = (client, text) => {
    let message;
    try {
      message = JSON.parse(text);
    } catch {
      client.connection.send({ type: 'error', message: '消息不是合法 JSON' });
      return;
    }
    if (!message || typeof message.type !== 'string') return;

    if (message.type === 'sync') {
      if (!store.getMembership(client.projectId, client.user.id)) {
        client.connection.close(1008, 'no access');
        return;
      }
      const document = store.getDocument(client.projectId);
      if (document) {
        client.connection.send({ type: 'doc', rev: document.rev, document: document.document });
      }
      return;
    }

    if (message.type === 'patch') {
      // 角色以数据库为准：成员被降级/移除后，已建立的连接立即生效
      const role = store.getMembership(client.projectId, client.user.id);
      if (!role) {
        client.connection.send({ type: 'error', message: '你已被移出该项目' });
        client.connection.close(1008, 'no access');
        return;
      }
      if (role !== client.role) {
        client.role = role;
        broadcastPresence(client.projectId);
      }
      if (!canWrite(role)) {
        client.connection.send({ type: 'error', message: '只读角色不能修改项目' });
        return;
      }
      const error = validateDiff(message.diff);
      if (error) {
        client.connection.send({ type: 'error', message: error });
        return;
      }
      const result = store.applyPatch({ projectId: client.projectId, diff: message.diff, userId: client.user.id });
      if (!result) {
        client.connection.send({ type: 'error', message: '项目文档不存在' });
        return;
      }
      if (result.error) {
        client.connection.send({ type: 'error', message: result.error });
        return;
      }
      broadcast(client.projectId, {
        type: 'patch',
        rev: result.rev,
        diff: message.diff,
        from: client.id,
        userId: client.user.id,
        name: client.user.name,
      });
      return;
    }

    if (message.type === 'ping') {
      client.connection.send({ type: 'pong', time: Date.now() });
    }
  };

  httpServer.on('upgrade', (request, socket) => {
    let url;
    try {
      url = new URL(request.url ?? '/', 'http://localhost');
    } catch {
      rejectUpgrade(socket, 400, 'Bad Request');
      return;
    }
    const match = url.pathname.match(/^\/ws\/projects\/([^/]+)$/);
    if (!match) {
      rejectUpgrade(socket, 404, 'Not Found');
      return;
    }
    if (String(request.headers.upgrade ?? '').toLowerCase() !== 'websocket') {
      rejectUpgrade(socket, 400, 'Upgrade Required');
      return;
    }
    const key = request.headers['sec-websocket-key'];
    if (!key) {
      rejectUpgrade(socket, 400, 'Bad Request');
      return;
    }
    const projectId = match[1];
    const payload = verifyToken(url.searchParams.get('token') ?? '', secret);
    const user = payload ? store.userById(payload.sub) : null;
    if (!user) {
      rejectUpgrade(socket, 401, 'Unauthorized');
      return;
    }
    const role = store.getMembership(projectId, user.id);
    if (!role) {
      rejectUpgrade(socket, 403, 'Forbidden');
      return;
    }
    const stored = store.getDocument(projectId);
    if (!stored) {
      rejectUpgrade(socket, 404, 'Not Found');
      return;
    }

    const accept = crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
    socket.write([
      'HTTP/1.1 101 Switching Protocols',
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Accept: ${accept}`,
      '',
      '',
    ].join('\r\n'));
    socket.setNoDelay(true);

    const room = rooms.get(projectId) ?? { clients: new Set() };
    rooms.set(projectId, room);

    const client = {
      id: crypto.randomUUID(),
      user,
      role,
      projectId,
      alive: true,
      connection: null,
    };

    const connection = new Connection(socket, {
      onMessage: (text) => handleMessage(client, text),
      onPong: () => { client.alive = true; },
      onClose: () => removeClient(client),
      onError: (error) => logger.error('[ws] 处理消息失败', error),
    });
    client.connection = connection;
    room.clients.add(client);

    const latest = store.getDocument(projectId);
    connection.send({
      type: 'hello',
      clientId: client.id,
      role,
      rev: latest.rev,
      document: latest.document,
      users: usersOf(room),
    });
    broadcastPresence(projectId);
    logger.log(`[ws] ${user.name} 加入项目 ${projectId}（在线 ${room.clients.size}）`);
  });

  const heartbeat = setInterval(() => {
    for (const room of rooms.values()) {
      for (const client of room.clients) {
        if (!store.getMembership(client.projectId, client.user.id)) {
          client.connection.close(1008, 'no access');
          continue;
        }
        if (!client.alive) {
          client.connection.close(1001, 'heartbeat timeout');
          continue;
        }
        client.alive = false;
        client.connection.ping();
      }
    }
  }, HEARTBEAT_MS);
  heartbeat.unref?.();

  return {
    rooms,
    /** AI / 版本恢复等服务端改动：向房间广播整份文档 */
    broadcastDocument(projectId, rev, document) {
      broadcast(projectId, { type: 'doc', rev, document, from: 'server' });
    },
    stats() {
      return { rooms: rooms.size, clients: [...rooms.values()].reduce((sum, room) => sum + room.clients.size, 0) };
    },
    closeAll() {
      clearInterval(heartbeat);
      for (const room of rooms.values()) for (const client of room.clients) client.connection.close(1001, 'server shutdown');
      rooms.clear();
    },
  };
}
