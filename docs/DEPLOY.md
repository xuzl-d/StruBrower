# 部署：让别人访问 StruBrowser

StruBrowser 是「一个 Node 进程 + 一个 SQLite 文件 + 静态前端」，生产模式只占 **一个端口**（默认 8787），
HTTP API、WebSocket 协作、前端页面都走它。下面按「局域网 → 公网 → 临时演示」三种场景说明。

## 0. 选哪种方式

| 场景 | 做法 | 适合 |
| --- | --- | --- |
| 同事在同一局域网 | `./start.sh prod`，别人访问 `http://<你的内网IP>:8787` | 办公室内试用 |
| 公网固定地址 | VPS + Docker，前置 Caddy/Nginx 做 HTTPS | 正式给外部用户 |
| 临时给一个人看 | `cloudflared tunnel --url http://127.0.0.1:8787` | 演示、远程排障 |

> 任何公网部署都建议 HTTPS（`https://`）。浏览器对剪贴板、全屏键盘锁等 API 有安全上下文要求。

## 0.1 一定要自己买“公网服务器”吗？

要让**任意互联网用户**访问，必须有一个**公网可达的入口**，但不一定是你自己买的服务器：

| 方式 | 要不要公网服务器 | 要不要公网 IP | 稳定性 | 适合 |
| --- | --- | --- | --- | --- |
| 隧道（Cloudflare Tunnel / ngrok） | 不要（借用服务商边缘节点） | 不要 | 依赖你的电脑在线 | 演示、临时给外部用户看 |
| 云主机 VPS / PaaS | 要（或平台代管） | 云厂商提供 | 高 | 正式对外 |
| 家庭/公司宽带端口映射 | 不要 | **要**（很多宽带是 CGNAT，没有） | 低 | 有公网 IP 且能改路由器 |

关键点：隧道不是“不需要服务器”，而是把 Cloudflare/ngrok 的公网节点当中转，流量回到你这台电脑；
**电脑关机/休眠/断网就访问不了**，而且临时 URL 每次会变、上传速度受你家宽带上行限制。

### 方式 A：隧道（最快，不用买服务器）

```bash
./start.sh prod                 # 先以生产模式跑起来（单端口 8787）
./scripts/share.sh cloudflared  # 或 npm run share；没装会提示 brew install cloudflared
```

终端会打印形如 `https://xxxx.trycloudflare.com` 的地址，直接发给外部用户。
ngrok 同理：`./scripts/share.sh ngrok`（需先 `ngrok config add-authtoken`）。

固定域名（需要域名托管在 Cloudflare，仍不需要公网 IP/端口映射）：

```bash
cloudflared tunnel login
cloudflared tunnel create strubrowser
cloudflared tunnel route dns strubrowser bim.example.com
# ~/.cloudflared/config.yml
#   tunnel: <tunnel-id>
#   credentials-file: /Users/you/.cloudflared/<tunnel-id>.json
#   ingress:
#     - service: http://127.0.0.1:8787
#     - service: http_status:404
cloudflared tunnel run strubrowser
```

### 方式 B：云主机（长期给别人用，推荐）

$5/月级别的 VPS + Docker + Caddy 即可，见下面第 2 节。优点：不依赖你的电脑、固定域名、HTTPS、可做备份。

PaaS（Fly.io / Railway / Render / Zeabur）也能跑，但要注意：

- 必须挂**持久卷**到 `/data` 并设 `STRU_DATA_DIR=/data`（SQLite 不能放临时盘）；
- 平台要支持 **WebSocket**（协作需要）；
- 健康检查用 `/api/health`，端口用 `PORT`；
- 免费档的休眠/冷启动会断开协作连接。

### 方式 C：宽带端口映射（不推荐）

需要公网 IPv4（很多宽带是 CGNAT，路由器 WAN IP ≠ `curl -4 ifconfig.me` 就不是），
再在路由器把 8787 转发到你的电脑 + DDNS + HTTPS 证书。暴露面大、IP 会变，只适合临时折腾。

### 方式 D：只给一小群人（Tailscale / ZeroTier）

双方装客户端组成虚拟内网，访问 `http://100.x.x.x:8787`。不需要公网服务器，但每个使用者都要装客户端并加入网络。

---

## 1. 局域网访问（最快）

```bash
cd /Users/hoje/Documents/Code/DSH/StruBrowser
./start.sh prod
```

服务端默认监听 `0.0.0.0`，启动日志会打印所有可访问地址，例如：

```
StruBrowser server → http://127.0.0.1:8787  http://192.168.1.23:8787
db: .../server/data/strubrowser.db
注册：开放
```

把 `http://192.168.x.x:8787` 发给同事即可（需要同一 Wi-Fi/局域网）。
如果 8787 上已经有开发版在跑，`prod` 会先停掉它再以生产模式启动（端口不变）。

- **macOS**：首次运行可能弹「是否允许 node 接受传入连接」，选允许；或在「系统设置 → 网络 → 防火墙」放行。
- **Windows**：首次运行弹防火墙提示时勾选「专用网络」。
- 只想本机访问：`HOST=127.0.0.1 ./start.sh prod`。
- 手机/平板同一 Wi-Fi 也能打开（界面按桌面设计，触控可用但未专门适配）。

开发模式（Vite 5173 + API 8787）默认只监听本机；要让别人访问开发模式：

```bash
npm run dev -- --host 0.0.0.0
STRU_WEB_ORIGIN=http://192.168.1.23:5173 npm run server
```

---

## 2. 公网部署（VPS + Docker + HTTPS）

### 2.1 准备

- 一台 Linux VPS（1–2 核 / 2 GB 起；STEP 大模型转换吃内存，建议 4 GB）。
- 域名一条 A 记录指向 VPS（例如 `bim.example.com`）。
- 安全组/防火墙只开放 **80 / 443**；不要把 8787 直接暴露到公网。

### 2.2 启动

```bash
git clone <你的仓库> strubrowser && cd strubrowser

# 必填：token 签名 + AI Key 加密密钥，生成一次并保存好
export STRU_SECRET=$(openssl rand -hex 32)

docker compose up -d --build
curl http://127.0.0.1:8787/api/health
```

数据保存在 Docker volume `strubrowser-data`（挂到容器 `/data`）。

### 2.3 反向代理 + HTTPS

**Caddy（推荐，自动证书）**：把 `deploy/Caddyfile` 里的域名改成你的，然后：

```bash
caddy run --config deploy/Caddyfile
```

Caddy 会自动申请证书并处理 WebSocket 升级。若 Caddy 跑在宿主机上，建议把 compose 的端口改为只绑本机：

```yaml
ports:
  - "127.0.0.1:8787:8787"
```

**Nginx**：参考 `deploy/nginx.conf`（含 WebSocket `Upgrade` 头、300 MB 上传上限、300 s 超时）。

### 2.4 首次使用

1. 打开 `https://bim.example.com`，注册第一个账号 —— **第一个注册用户自动成为系统管理员**。
2. 右上角 **⚙ → 用户管理** 创建同事账号（或先保持开放注册，之后再关）。
3. 关闭开放注册：把 compose 里 `STRU_ALLOW_REGISTER` 设为 `0`，`docker compose up -d` 重启。
   之后只有管理员能在界面创建用户；库中没有任何用户时仍允许注册第一个管理员，避免锁死。
4. **⚙ → AI 设置** 填模型 Key（加密存库）或保持 Mock。

---

## 3. 不用 Docker（systemd）

```bash
sudo useradd -r -s /usr/sbin/nologin strubrowser
sudo mkdir -p /opt/strubrowser /var/lib/strubrowser
sudo chown -R strubrowser: /opt/strubrowser /var/lib/strubrowser

cd /opt/strubrowser
npm ci && npm run build

sudo tee /etc/strubrowser.env >/dev/null <<'ENV'
HOST=0.0.0.0
PORT=8787
STRU_DATA_DIR=/var/lib/strubrowser
STRU_SECRET=请替换为随机长字符串
STRU_ALLOW_REGISTER=1
STRU_AUTH_RATE_LIMIT=60
ENV

sudo cp deploy/strubrowser.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now strubrowser
curl http://127.0.0.1:8787/api/health
```

> 需要 Node.js ≥ 22.5（`node:sqlite` 仍标记 experimental，启动时带 `--experimental-sqlite`）。

---

## 4. 环境变量

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `HOST` | `0.0.0.0` | 监听地址；`127.0.0.1` 表示仅本机 |
| `PORT` | `8787` | 单端口（页面 + API + WebSocket） |
| `STRU_DATA_DIR` | `server/data` | SQLite 与 secret 的目录，务必持久化 |
| `STRU_SECRET` | 自动生成并写入数据目录 | token 签名、AI Key 加密；多实例必须一致 |
| `STRU_ALLOW_REGISTER` | `1` | `0` 关闭开放注册（管理员仍可建用户） |
| `STRU_AUTH_RATE_LIMIT` | `60` | 登录/注册限流（次 / 5 分钟 / IP），`0` 关闭 |
| `STRU_TRUST_PROXY` | 关闭 | 在 Nginx/Caddy 后面设为 `1`，用 `X-Forwarded-For` 识别真实 IP |
| `STRU_WEB_ORIGIN` | `http://localhost:5173,http://127.0.0.1:5173` | 允许的跨域来源（开发模式用；生产同源可不设） |
| `STRU_MAX_DOCUMENT_BYTES` | `167772160`（160 MB） | 单个文档保存上限 |
| `STRU_MAX_STEP_BYTES` | `268435456`（256 MB） | STEP 上传上限 |
| `STRU_AI_PROVIDER` / `STRU_AI_BASE_URL` / `STRU_AI_MODEL` / `STRU_AI_API_KEY` | `mock` / OpenAI / `gpt-4o-mini` / 空 | AI 兜底配置；界面保存的配置优先 |
| `STRU_PYTHON` | 自动 | STEP 转换器 Python 路径 |

---

## 5. 数据、备份与升级

- 数据目录里只有两样关键内容：`strubrowser.db`（用户/项目/版本/设置）与 `secret`（签名密钥）。
- 备份（SQLite 在线备份）：
  ```bash
  sqlite3 server/data/strubrowser.db ".backup '/backup/strubrowser-$(date +%F).db'"
  ```
  或直接快照 Docker volume；**不要只备份 db 而弄丢 secret**，否则所有人需要重新登录、AI Key 无法解密。
- 升级：
  ```bash
  git pull
  npm ci && npm run build     # 或 docker compose up -d --build
  sudo systemctl restart strubrowser
  ```
  数据库结构变更在启动时自动迁移（新增列/表），无需手工操作。

---

## 6. STEP 服务端转换器（可选）

- 浏览器自带 OCCT 导入器可用，但**会丢失面颜色**；服务端转换器能保留颜色。
- 安装：`npm run setup:step`（Python + `cadquery-ocp`，约 650 MB）。
- Docker 镜像默认**不含**它：大模型走浏览器回退（约 7 MB WASM，颜色丢失）。
  需要时在 Dockerfile 里加 `python3` + `pip install cadquery-ocp`，并设置 `STRU_PYTHON`。
- 转换是 CPU/内存密集型，公网部署建议限制上传大小并观察内存；必要时单独拆成 worker。

---

## 7. 安全清单

- [ ] `STRU_SECRET` 使用随机长字符串，且只放在服务端环境变量/EnvironmentFile。
- [ ] 公网必须 HTTPS；只开 80/443，8787 只绑 `127.0.0.1`。
- [ ] 创建管理员后设 `STRU_ALLOW_REGISTER=0`。
- [ ] 反向代理后设 `STRU_TRUST_PROXY=1`，否则限流会把所有请求当成同一个 IP。
- [ ] 数据库目录定期备份，权限只给运行用户。
- [ ] AI Key 通过界面保存（AES-GCM 加密）或环境变量，不要写进前端/仓库。
- [ ] Nginx 的 `client_max_body_size` 与超时覆盖大文档/STEP。

---

## 8. 排障

| 现象 | 原因/处理 |
| --- | --- |
| 页面提示「无法连接服务端（Failed to fetch）」 | 后端没启动/挂了，或代理没转发；看 `docker compose logs` / `.logs/server.log`，`curl /api/health` |
| 登录/注册返回 429 | 触发了 `STRU_AUTH_RATE_LIMIT`，等待或调大 |
| WebSocket 连不上（协同离线） | 代理未转发 `Upgrade`/`Connection`；Caddy 默认支持，Nginx 用 `deploy/nginx.conf` |
| 上传大文件 413 | 调大 Nginx `client_max_body_size` / Caddy 默认无限制但注意超时 |
| 局域网打不开 | 防火墙未放行 Node；确认 `HOST=0.0.0.0` 且用内网 IP 而不是 127.0.0.1 |
| 重启后所有人要重新登录 | `STRU_SECRET` 变了或 `secret` 文件丢了 |

---

## 9. 能扩展到哪里

当前是**单实例**架构（Node + SQLite + 内存里的协作房间），适合几十人以内团队。
要多实例/高可用，需要：共享数据库（Postgres）、协作消息走 Redis pub/sub、WebSocket 负载均衡（sticky），
以及对象存储放导入的大网格。这些不在当前版本范围内，需要另行改造。
