# 多并发与多实例部署

当前版本是**单实例**架构：一个 Node 进程 + 一个 SQLite 文件 + 内存里的 WebSocket 房间。
单实例能支撑几十人同时在线、十几人同时编辑；再往上（多机、数百并发、跨区域）就需要多实例。

## 1. 为什么不能直接起多个进程/容器

| 组件 | 现状 | 多实例下的问题 |
| --- | --- | --- |
| 文档存储 | SQLite（`node:sqlite`，**同步 API**） | 跨主机共享 SQLite 文件不安全（WAL + 网络盘）；同步 API 让「换成 Postgres」不是改连接串那么简单 |
| 协作广播 | 内存 `Map<projectId, room>` | 两个实例的客户端互相收不到 patch/doc/presence |
| 在线状态 | 内存计数 | 每个实例只看到自己的一部分用户 |
| 登录限流 / AI、STEP 限流 | 内存计数 | 每个实例各自计数，实际配额放大 N 倍 |
| AI 配置 | 启动时读 DB 并缓存在进程内 | 管理后台改配置后，其它实例仍是旧配置 |
| 草稿/临时文件 | 本地临时目录 | 只影响本实例请求，问题不大 |

所以「多实例」不是把 `docker compose up --scale app=3` 打开就行，需要**共享存储 + 共享消息总线 + 无状态化**。

## 2. 目标架构

```
                    ┌────────────────────────────┐
  用户 ──HTTPS──▶   │ 负载均衡 Nginx/Caddy/云 LB │
                    │  - /api/health 存活检查     │
                    │  - /api/ready 就绪检查      │
                    │  - WebSocket 会话保持       │
                    └──────────┬─────────────────┘
                               │
              ┌────────────────┼────────────────┐
              ▼                ▼                ▼
        app 实例 A        app 实例 B        app 实例 C
              │                │                │
              └────────┬───────┴────────┬───────┘
                       ▼                ▼
                 Postgres           Redis
             （项目/文档/版本/       （patch/doc/presence
               用户/审计/设置）        发布订阅、共享限流）
                       │
                       ▼
              （可选）对象存储：大网格/附件
```

关键改造：

1. **存储层异步化 + Postgres**
   - 把 `server/store.js` 的同步方法改成 async 接口，新增 `server/store-pg.js`（或统一 SQL 层）。
   - 文档保存用事务 + `select ... for update`/advisory lock，`rev` 做 CAS（乐观锁），冲突重试。
   - 数据库迁移脚本（users/projects/documents/versions/audit/settings）。
2. **协作总线**
   - `ws.js` 的 `broadcast` 改为「本地扇出 + 发布到 Redis channel `project:<id>`」。
   - 各实例订阅 channel，把消息转发给本实例的连接；presence 用 Redis Hash + TTL 聚合。
   - patch 增加 `clientSeq` 去重，避免断线重连重复应用。
3. **共享限流与配置**
   - 登录/注册、AI、STEP 的计数改为 Redis（`INCR` + `EXPIRE`）。
   - AI 设置变更后通过 Redis 广播失效，实例重新加载。
4. **会话与粘性**
   - 登录 token 是无状态 JWT（共享 `STRU_SECRET`），HTTP 不需要粘性。
   - WebSocket 连接有本地房间状态，**需要粘性会话**（Nginx `ip_hash`，或按 cookie/路径分流），否则同一个客户端的 WS 会落到不同实例。
   - 若不使用粘性，需要把房间状态完全外置（pub/sub + 每连接订阅），复杂度更高。
5. **重任务隔离**
   - STEP 转换是 CPU/内存密集型，建议单独 worker 池或独立服务，避免拖慢 API。
   - AI 调用是 IO 型，可留在 API 实例，但要有超时、并发上限与队列。

## 3. 部署形态

### 3.1 单机多实例（不推荐）

同一台机器起多个 Node 进程共享 SQLite：WAL + `busy_timeout` 能工作，但写入串行、进程间广播仍需额外总线，
且无法跨机。只适合临时压测，不建议生产。

### 3.2 多机 + 共享 Postgres/Redis（推荐）

```yaml
# 概念示例
services:
  app:
    image: strubrowser:latest
    deploy: { replicas: 3 }
    environment:
      STRU_SECRET: ${STRU_SECRET}
      STRU_INSTANCE_ID: ${HOSTNAME}
      DATABASE_URL: postgres://...
      REDIS_URL: redis://...
  postgres: { image: postgres:16, volumes: [pgdata:/var/lib/postgresql/data] }
  redis: { image: redis:7 }
  lb: { image: caddy, ports: ["443:443"] }
```

Nginx 关键配置：

```nginx
upstream strubrowser {
    ip_hash;                 # WebSocket 粘性（同一 IP 落到同一实例）
    server 10.0.0.11:8787;
    server 10.0.0.12:8787;
    server 10.0.0.13:8787;
}
server {
    location / {
        proxy_pass http://strubrowser;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_read_timeout 300s;
    }
    location = /api/health { proxy_pass http://strubrowser; access_log off; }
    location = /api/ready  { proxy_pass http://strubrowser; access_log off; }
}
```

滚动发布：实例收到 `SIGTERM` 后会停止接收新连接、关闭协作 WS（1001）、最多等 8 秒退出，
所以 LB 先摘流量再发 SIGTERM 即可平滑重启。

## 4. 分阶段实施计划

| 阶段 | 内容 | 预估 |
| --- | --- | --- |
| P0（已完成） | 实例标识、`/api/ready`、优雅退出、WS 背压/消息限流、重接口限流、压测脚本、多实例文档 | — |
| P1 | store 异步化 + Postgres 适配 + schema/迁移 + 事务/CAS + 现有测试跑通 | 2–3 天 |
| P2 | Redis pub/sub 协作总线 + 跨实例 presence + patch 去重 | 1–2 天 |
| P3 | 共享限流/配置失效、AI/STEP 并发上限 | 1 天 |
| P4 | 多实例部署（compose/Helm）、压测、故障演练（实例宕机/网络分区） | 1–2 天 |

> P1 是最大的一块：当前 store 是**同步**的，改成 Postgres 意味着所有调用点（HTTP 路由、WS 处理、AI/版本恢复）都要 `await`，
> 属于架构级改动，需要单独一轮完成并配合集成测试（本地 Postgres 或 PGlite）。

## 5. 当前可用的并发保障

- **WS 背压**：单连接发送缓冲超过 4 MB 直接断开（1013），避免慢客户端拖垮实例。
- **消息限流**：单连接 10 秒内超过 500 条消息断开（1008）。
- **重接口限流**：STEP `STRU_STEP_RATE_LIMIT`（默认 6 次/分钟/用户）、AI `STRU_AI_RATE_LIMIT`（默认 30 次/分钟/用户），超限 429。
- **优雅退出**：`SIGTERM` 排空连接，适合滚动发布。
- **压测**：`BASE=http://127.0.0.1:8787 USERS=20 ROUNDS=20 npm run load-test`。

## 6. 扩容前的建议

- 先压测单实例，确认瓶颈在 CPU、SQLite 写入还是带宽；单实例通常能撑到几十人协同。
- 大文档（STEP 导入）是主要存储/带宽成本：考虑网格压缩、按需加载或对象存储。
- 多实例前先把「大文档 + 版本快照」的体积控制住，否则 Postgres 也会被拖慢。
