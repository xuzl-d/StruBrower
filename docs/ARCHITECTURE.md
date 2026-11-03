# StruBrowser 架构与路线图（Revit 类 Web BIM）

> 目标：把浏览器端网格原型演进为具备 BIM 语义的 Web 工作台。
> 说明：Revit 是二十年、数千人年的平台，**不做功能对等复刻**，而是复刻其核心工作流：
> 标高/轴网 → 参数化构件 → 视图/图纸 → 明细表 → 格式互操作 → 协作。

## 1. 现状（v0.7 · BIM 内核 + 服务端 + 实时协作 + STEP 颜色 + AI 建模 + 系统管理）

```
src/
  bim/             BIM 内核（与 UI 无关，可在服务端复用）
    types.ts       文档 schema v2：Level / Grid / Material / FamilyType / 墙柱板 / MeshInstance
    document.ts    派生查询（标高、顶部、尺寸、材质色）、v1→v2 迁移、汇总
    geometry.ts    参数化构件 → BufferGeometry；导入归一化；布尔；OBJ 导出
    template.ts    项目模板、示例项目、自动命名
  data/            数据访问层
    repository.ts   ProjectRepository 接口（kind / list / load / save / remove）
    localRepository.ts  IndexedDB 实现（本地模式、离线演示）
    http.ts        HttpProjectRepository + 认证/版本/成员 API + rev 冲突错误
    index.ts       本地/服务端模式探测与选择
  components/      Ribbon / ProjectBrowser / PropertiesPanel / Fields / AuthGate / VersionsDialog / MembersDialog
  ModelViewport    三维 & 平面视图、绘制工具、预览、选择
  App              编辑状态、命令栈（撤销/重做）、自动保存、会话、冲突处理、文件交换
server/
  index.js        HTTP 服务：REST 路由、鉴权、静态资源、SPA 回退
  store.js        SQLite 数据访问（用户/项目/成员/文档/版本/审计）
  db.js           建库与表结构
  auth.js         scrypt 密码、HMAC token、角色判定
  collab/
    diff.ts        文档差分（与服务端同一语义）
    client.ts      协作 WebSocket 客户端（重连、在线状态、补丁）
  ...
server/
  ws.js           协作 WebSocket 服务（房间、在线状态、补丁落库与广播）
  validate.js     文档/补丁校验与差分应用（服务端权威实现）
  convert/        STEP → 带面颜色网格（Python + OCP）与测试夹具
  ai/             AI 网关：BIM 指令（ops.js）、项目上下文（context.js）、Mock/OpenAI provider
  crypto.js       敏感配置加密（AES-256-GCM，密钥由 STRU_SECRET 派生）
scripts/dev.mjs   同时启动 API 与 Vite 的开发脚本
scripts/test.mjs  一键验证：接口 + 客户端数据层 + 协作 + 差分
```

已具备的 BIM 语义：

| 能力 | 实现 |
| --- | --- |
| 标高 | 任意增删改名改高程；构件以标高 + 偏移定位；改标高全模型联动 |
| 轴网 | 绘制、命名、删除；标签列表 |
| 参数化构件 | 墙（基线 + 类型厚度 + 顶部标高）、柱（定位 + 截面类型 + 顶部标高）、楼板（轮廓草图 + 类型厚度） |
| 类型 / 实例 | 类型持有尺寸与材质（`FamilyType`），实例持有位置、标高约束；改类型更新全部实例并在属性面板提示数量 |
| 撤销 / 重做 | 不可变文档快照栈（50 步），Ctrl/Cmd+Z、Shift+Ctrl/Cmd+Z |
| 视图 | 三维（透视/平行）、每个标高一张平面视图；平面视图锁定旋转 |
| 选择 | 点选、框选（单击→移动→单击；window 完全包含 / crossing 相交，按投影包围盒判定，1.5px 容差）、Shift 加选、右键菜单（全选/同类型）、Esc 取消 |
| 通用编辑 | 独立「修改」页签：平移、复制、旋转（绕基点）、镜像（水平/垂直，可保留原件）、阵列（线性/环形）、剪贴板、布尔/删除；导入网格用 offset+rotation 表示变换，不重写顶点 |
| 界面 | 页面级全屏（Keyboard Lock 锁定 Esc，使 Esc 只取消选择）、项目浏览器/属性面板可收起为侧边竖条（状态记忆） |
| 交换 | OBJ 导入导出；STEP/STP 导入（网格 + 面颜色，见 `diagnostics/FINDINGS.md`） |
| 持久化 | 本地模式：IndexedDB；服务端模式：Node + SQLite，文档 rev 号 + 版本快照 |
| 账号与权限 | 注册/登录（scrypt + HMAC token）、项目成员角色（viewer/editor/admin）、只读 UI |
| 版本与冲突 | 不可变版本快照 + 恢复；rev 乐观并发，冲突时前端提示“加载最新 / 覆盖保存” |
| 审计 | 项目创建/改名/保存/版本/成员操作写入 audit_log，管理员可查 |
| 实时协作 | WebSocket 房间、在线状态、按构件 id 的差分广播与落库、实时角色校验、断线重连与 HTTP 降级 |
| STEP 面颜色 | 服务端 OCP/XCAF 转换器取回逐面颜色（浏览器导入器会丢），前端优先使用、失败回退 |
| AI 建模 | 文本 → 结构化 BIM 指令（Mock/OpenAI 兼容），服务端校验 + rev + 审计 + 撤销 + 协作广播 |
| 系统管理 | 首个用户/STRU_ADMIN_EMAILS 为系统管理员；用户 CRUD、重置密码、角色；AI 设置（key AES-GCM 加密、掩码返回、界面即改即生效） |
| 软件设置 | localStorage 持久化：高亮/背景/轴网/气泡颜色、网格与统计开关、坐标轴、吸附步长；本地模式可用 |

坐标约定：**世界 Z-up，单位米**，标高即世界 Z。导入几何会居中、贴地，作为独立 `mesh` 构件参与渲染与布尔。

## 2. 目标架构（完整前后端）

```
┌──────────────── 浏览器（React + three.js） ────────────────┐
│ Editor State（文档 + 命令栈 + 选择 + 视图状态）              │
│  ├─ bim/ 内核（纯函数：几何、派生、迁移）                    │
│  ├─ Viewport（3D / 平面 / 预览 / 拾取）                      │
│  ├─ Repository 接口 ← HttpRepository / LocalRepository      │
│  └─ 协作适配器（WebSocket，元素级补丁）                      │
└───────────────┬─────────────────────────────────────────────┘
                │ HTTPS REST + WebSocket
┌───────────────▼────────────── 服务端（Node） ───────────────┐
│ API 层（Fastify/Express）：项目、文档、版本、权限、评论      │
│ 鉴权：OIDC / 邮箱 + JWT；组织 / 项目成员 / 角色              │
│ 文档服务：乐观并发（rev 号）、不可变版本、审计日志           │
│ 协作服务：房间广播、元素级 op、断线重连补齐                 │
│ 转换服务（子进程）：OCP/pythonOCC 处理 STEP/IFC → 网格+颜色 │
│ 存储：PostgreSQL（元数据/版本/权限）+ 对象存储（大网格）     │
└──────────────────────────────────────────────────────────────┘
```

关键决策：

1. **几何双轨**：`bim/geometry.ts` 用 three.js 生成可视化几何（快、可离线）；精确布尔、STEP/IFC 解析放到服务端 OCCT，
   因为浏览器端 `occt-import-js` 存在面颜色/装配实例缺陷（见 diagnostics），且大模型内存受限。
2. **文档即值**：每次编辑产生新文档对象，命令栈天然支持撤销/重做与协同补丁；
   服务端以 `rev` 做乐观并发，冲突时按元素合并或提示。
3. **内核与 UI 解耦**：`src/bim/*` 不依赖 React/three 渲染层（几何除外），服务端可直接复用做校验与转换。

## 3. 服务端接口草案

```
POST   /api/auth/login                { email, password } → { token, user }
GET    /api/me                        → 用户与组织
GET    /api/projects                  → 项目列表（分页、搜索）
POST   /api/projects                  { name, template } → project
GET    /api/projects/:id              → { project, rev, role }
PATCH  /api/projects/:id              { name?, archived? } （owner/admin）
DELETE /api/projects/:id              （owner）

GET    /api/projects/:id/document     → { document, rev }
PUT    /api/projects/:id/document     { document, baseRev } → { rev } | 409 冲突
GET    /api/projects/:id/versions     → 版本列表
POST   /api/projects/:id/versions     { label } → 快照
GET    /api/projects/:id/versions/:v  → 历史文档
POST   /api/projects/:id/restore      { version }

GET    /api/projects/:id/members      → 成员与角色（viewer/editor/admin）
POST   /api/projects/:id/members      { email, role }
PATCH  /api/projects/:id/members/:uid { role }
DELETE /api/projects/:id/members/:uid

POST   /api/projects/:id/convert      { format: 'step'|'ifc', uploadId } → job
GET    /api/jobs/:id                  → { status, progress, resultKey }
WS     /ws/projects/:id               ← { rev, ops[], actorId }（协作与在线状态）
```

## 4. 数据模型（PostgreSQL 草案）

```sql
create table users (id uuid primary key, email citext unique, name text, password_hash text, created_at timestamptz);
create table orgs  (id uuid primary key, name text, created_at timestamptz);
create table projects (
  id uuid primary key, org_id uuid references orgs, name text,
  created_by uuid references users, created_at timestamptz, updated_at timestamptz,
  archived boolean default false
);
create table project_members (
  project_id uuid references projects, user_id uuid references users,
  role text check (role in ('viewer','editor','admin')), primary key (project_id, user_id)
);
-- 当前文档（热数据），rev 用于乐观并发
create table documents (
  project_id uuid primary key references projects,
  rev bigint not null default 1,
  schema_version int not null,
  payload jsonb not null,           -- ProjectDocument（大网格另存对象存储，payload 里放 key）
  updated_by uuid references users, updated_at timestamptz
);
-- 不可变版本（冷数据，可选压缩）
create table document_versions (
  project_id uuid references projects, version int, label text,
  payload jsonb not null, created_by uuid, created_at timestamptz,
  primary key (project_id, version)
);
create table audit_log (
  id bigserial primary key, project_id uuid, user_id uuid,
  action text, detail jsonb, created_at timestamptz
);
```

> 大网格（STEP 导入的百万级三角面）不进 `payload`，写对象存储，文档里只保留 `{ storageKey, size, checksum }`。

## 5. 路线图

| 里程碑 | 内容 | 验收标准 |
| --- | --- | --- |
| **M1 BIM 内核**（已完成） | 标高/轴网、参数化墙柱板、类型与实例参数、撤销重做、平面/三维视图、v1→v2 迁移、Repository 抽象 | 可绘制/编辑/保存/重开项目；改标高或类型参数全模型联动；`npm run build` 通过 |
| **M2 完整前后端（本次完成）** | Node 服务（node:http + node:sqlite）、注册/登录、项目成员角色、文档 rev 乐观并发、版本快照/恢复、审计、HttpRepository 切换、登录页/版本/成员弹窗、只读模式、单端口静态托管 | 32 项 HTTP 接口测试 + 21 项客户端数据层测试通过；两会话保存产生 409 冲突并可覆盖/重载；版本恢复生成新 rev；viewer 不可写、非 admin 不可改成员 |
| M3 构件与约束 | 门窗洞口、墙连接/剪切、柱梁板连接、草图模式 + 尺寸约束、类型管理器（复制/新建类型） | 墙上开洞随墙移动；改墙高洞口跟随；类型管理器可新建类型 |
| M4 视图与出图 | 平面剖切（视图范围、剖切面）、尺寸标注/标高标注/文字、图纸布局 + 视口、PDF/PNG 导出 | 从模型生成带标注的平面图并导出 PDF |
| **M5a STEP 转换（已完成）** | 服务端 Python + OCP 转换器：XCAF 样式表取逐面颜色、二进制网格协议、前端优先/回退、测试夹具与接口测试 | 吊车 STEP：21,178/21,394 面带色；`npm test` 95 项通过；转换器缺失时自动回退浏览器解析 |
| M5b 明细表与 IFC | 构件明细表（材质/面积/体积统计，可导出 CSV）、IFC 导入导出（web-ifc） | IFC 导出可被 Revit/BlenderBIM 打开；IFC 导入保留构件类别与标高 |
| **M7 AI 建模（本次完成）** | 文本 → 结构化 BIM 指令、Mock/OpenAI 兼容 provider、服务端校验 + rev + 审计 + 撤销、协作广播、AI 面板 | 无 key 也能演示；配置 key 后真实模型可用；135 项测试通过；非法指令不落库、viewer 被拒 |
| M8 AI 深化（后续） | 平面图 → 墙线/房间、图片 → 体量、图生 3D 网格、流式对话、模型自纠错重试、项目检索 | 上传户型图生成可编辑墙板；家具类图生模型作为导入几何 |
| **M6 实时协作基础（本次完成）** | WebSocket 房间、在线状态、按构件 id 的差分广播与落库、实时角色校验、断线重连与 HTTP 降级 | 两人同时编辑不同构件互不覆盖；viewer 实时被拒；断线自动重连；`npm test` 覆盖 11 项协作用例 |
| M6+ 协作深化（后续） | 光标/选区共享、评论与标记、离线编辑合并（CRDT/OT）、大网格外置 | 同一构件并发编辑可合并；评论可定位到构件 |

## 6. 实时协作机制

传输：原生 WebSocket（服务端为 RFC6455 最小实现，零第三方依赖），端点 `/ws/projects/:id?token=...`；
Vite 开发服务器已代理 `/ws`。加入房间时服务端下发 `hello`（rev + 文档快照 + 在线用户），
客户端在无本地未保存修改时采用该快照。

| 方向 | 消息 | 说明 |
| --- | --- | --- |
| S→C | `hello` | rev、文档快照、在线用户、角色 |
| S→C | `presence` | 在线用户变化 |
| C→S | `patch` | 文档差分（按构件 id 合并） |
| S→C | `patch` | 落库后的 rev + 同一差分（广播给房间内所有人，含发送者） |
| C→S | `sync` | 请求当前文档快照 |
| S→C | `error` | 权限/校验错误 |

差分语义（`src/collab/diff.ts` 与 `server/validate.js` 同一套）：构件按 id LWW 合并
（先 remove 再 put，新构件追加到末尾）；标高/轴网/类型/材质整包替换；未变化对象按引用跳过，
避免对大网格做 JSON 序列化。

权限与一致性：角色以数据库为准，降级/移除立即对已有连接生效；`viewer` 的 patch 被拒绝且不落库；
服务端是唯一 rev 来源，每次 patch 落库并写审计（`document.patch`），客户端用 `adoptRevision` 同步 rev。
可用性：WebSocket 断开后自动重连（1s→8s 退避）；断线期间回退 HTTP 自动保存 + rev 冲突提示。

已知限制：未实现 CRDT/OT、光标与评论、离线编辑合并（断线期间的编辑走 HTTP，重连后按 id 覆盖）；
STEP 导入的大网格构件在 patch 中仍传输整块几何，后续应外置到对象存储。

## 7. STEP 颜色与转换器

浏览器端 `occt-import-js` 0.0.23 在「装配实例 + 面着色」的 STEP 上会丢面颜色（上游 #68），
项目提供可选的服务端转换器（Python + `cadquery-ocp`）：

- `POST /api/convert/step`：原始 STEP 字节（≤ `STRU_MAX_STEP_BYTES`，默认 256 MB），流式落盘后调用
  `server/convert/step_to_mesh.py`，返回二进制网格；需要登录，操作写审计。
- 二进制协议：`STRUMESH` + version + header JSON（4 字节对齐）+ Float32 positions + Float32 colors（线性 RGB）。
- 颜色来源：`XCAFPrs::CollectStyleSettings`（面优先，实体样式兜底，最后默认灰）。单位按 STEP 文本里的
  `SI_UNIT`/`CONVERSION_BASED_UNIT` 换算到米，识别不到时按包围盒启发式推断。
- 前端：服务端模式优先调用转换器（`src/step/convert.ts`），不可用/失败自动回退浏览器解析。
- 可用性：服务端启动时探测 `import OCP`，结果见 `GET /api/convert/step/status` 与启动日志。
- 性能参考：121 MB 吊车 → 264,276 三角面 / 18 MB 网格 / 约 2.5 分钟（XCAF 26 s + 三角化 2 s + 导出遍历约 2 分钟）。

## 8. AI 建模网关

原则：**AI 不直接改文档，只产出结构化建模指令**，由服务端校验后写入。这样可校验、可预览、可撤销、可协作。

```
AI 面板 → POST /ai/plan（读权限）→ provider（Mock / OpenAI 兼容）
        → {reply, ops} → 面板展示 → 用户确认
        → POST /ai/apply（写权限）→ ops.js 校验 + 应用 → 新 rev + 审计
        → collab.broadcastDocument 广播整份文档 → 其他成员同步
```

- 指令集与字段见 `docs/AI.md`；实现 `server/ai/ops.js`（形状/坐标/标高/类型/构件解析与不可变应用）。
- 上下文 `server/ai/context.js` 只发送项目摘要（标高/类型/前 120 个构件/选中构件），不发送几何。
- Provider `server/ai/provider.js`：`mock`（关键词，无 key）与 `openai`（`/chat/completions` + 工具调用）。
- 安全：key 只在服务端；`plan` 需读、`apply` 需写（viewer 403）；应用后跑 `validateDocument`；
  审计 `ai.plan` / `ai.apply`；失败不写库。
- 前端 `src/components/AiPanel.tsx`：消息流、指令数量摘要、JSON 预览、应用/放弃；应用前把旧文档压入撤销栈。
- 系统管理：`users.is_admin`（首个用户自动为管理员，或 `STRU_ADMIN_EMAILS`）；`app_settings` 保存 AI 配置，
  `ai.apiKey` 用 AES-256-GCM 加密（`server/crypto.js`），接口只返回掩码；`PUT /api/admin/settings/ai` 后立即重建 provider。
  保护规则：至少一名管理员、不能删除自己、拥有项目的用户不可删除、删除用户级联成员关系。
升级旧库时（`users.is_admin` 全为 0）启动会自动把最早注册的用户提升为管理员，避免出现“无人可管理”的死锁。

## 9. 风险与技术决策记录

- **STEP 面颜色**：occt-import-js 0.0.23 在“装配实例 + 面着色”场景丢面颜色（上游 #68 / PR #69）。M5 起改由服务端 OCP
  解析并输出带 `COLOR_0` 的网格；浏览器端仅做渲染。详见 `diagnostics/FINDINGS.md`。
- **大模型性能**：单文档内几何目前随修改整体重建。M2 起把导入网格移出文档（对象存储 + 按需加载），
  并为参数化构件引入几何缓存（元素 id + 类型版本）。
- **平面视图**：当前为俯视正交投影，不是真正的“剖切平面”。M4 实现按视图范围的剖切 + 填充。
- **协作模型**：先做“元素级补丁 + rev”，避免过早引入 CRDT；同一元素并发时以服务端 rev 仲裁并提示重载。

## 10. 服务端运行与配置

```bash
npm install
npm run dev:all     # 同时启动 API(8787) + Vite(5173)，/api 由 Vite 代理
npm run server      # 只启动 API
npm run dev         # 只启动前端（探测不到 API 时自动回退本地 IndexedDB）
npm run build && npm run server   # 单端口生产模式：http://127.0.0.1:8787
```

| 环境变量 | 默认 | 说明 |
| --- | --- | --- |
| `PORT` | `8787` | API 端口 |
| `STRU_DATA_DIR` | `server/data` | SQLite 与密钥目录 |
| `STRU_DB` | `<data>/strubrowser.db` | 数据库文件 |
| `STRU_SECRET` | 自动生成并持久化 | token HMAC 密钥 |
| `STRU_WEB_ORIGIN` | `http://localhost:5173,http://127.0.0.1:5173` | 允许的 CORS 来源（逗号分隔） |
| `STRU_ALLOW_REGISTER` | `1` | 设为 `0` 关闭开放注册 |
| `STRU_MAX_DOCUMENT_BYTES` | `167772160` | 单次文档请求上限（160 MB，STEP 网格较大） |
| `STRU_MAX_STEP_BYTES` | `268435456` | STEP 上传上限（256 MB） |
| `STRU_CONVERT_TIMEOUT_MS` | `900000` | STEP 转换超时（15 分钟） |
| `STRU_PYTHON` | 自动选择 `server/convert/.venv` 或 `python3` | STEP 转换器解释器 |
| `STRU_AI_PROVIDER` | `mock` | AI 提供方：`mock` / `openai` |
| `STRU_AI_BASE_URL` | `https://api.openai.com/v1` | OpenAI 兼容地址 |
| `STRU_AI_MODEL` | `gpt-4o-mini` | 模型名 |
| `STRU_AI_API_KEY` | 空 | 仅服务端使用（也可用 `OPENAI_API_KEY`） |
| `STRU_AI_TIMEOUT_MS` | `60000` | AI 请求超时（界面设置优先） |
| `STRU_ADMIN_EMAILS` | 空 | 逗号分隔的邮箱，注册即成为系统管理员 |
| `HOST` | `0.0.0.0` | 监听地址；`127.0.0.1` 表示仅本机 |
| `PORT` | `8787` | 单端口（页面 + API + WebSocket） |
| `STRU_DATA_DIR` | `server/data` | SQLite 与 secret 的持久化目录 |
| `STRU_ALLOW_REGISTER` | `1` | `0` 关闭开放注册（空库时仍允许创建第一个管理员） |
| `STRU_AUTH_RATE_LIMIT` | `60` | 登录/注册限流（次 / 5 分钟 / IP），`0` 关闭 |
| `STRU_TRUST_PROXY` | 关闭 | 在 Nginx/Caddy 后设 `1`，按 `X-Forwarded-For` 识别真实 IP |
| `VITE_STRU_MODE` | 自动探测 | `local` / `server` 强制模式 |

安全边界（当前阶段）：

- 密码 `scrypt(N=16384,r=8,p=1)` 加盐存储，登录下发 HMAC-SHA256 token（7 天，无吊销；
  正式部署需接入 OIDC/SSO 并加 token 版本号）。
- 角色矩阵：`viewer` 只读；`editor` 可保存文档/创建版本；`admin` 可改名、删项目、管理成员、查审计。
- 项目删除级联删除成员/文档/版本；审计日志保留。
- 文档以 JSONB/TEXT 存整包，大网格（STEP 导入）尚未外置到对象存储 —— 见 M3 风险项。

### 接口与数据模型

见上文第 3、4 节（`/api/auth/*`、`/api/projects`、`/document`、`/versions`、`/restore`、`/members`、`/audit`）；
实现中 `documents.payload` 为 TEXT（SQLite），迁移到 PostgreSQL 时改为 `jsonb`；`projects.name` 会随文档名同步。

## 11. 本地开发与验证

```bash
npm run build              # 类型检查 + 生产构建
npm run server             # 启动 API（默认 8787）
```

`npm test` 会自动拉起临时数据库的服务端并依次运行（退出即清理）：

- 32 项 HTTP 接口测试（注册/登录/rev 冲突/force/版本/恢复/角色/审计/删除）
- 11 项协作测试（房间、hello/presence、补丁广播与落库、viewer 实时拒绝、断开 presence、非法 token）
- 8 项 STEP 转换接口测试（状态、鉴权、二进制协议、面带色、单位换算）+ 7 项客户端解码测试
- 21 项客户端数据层测试（双会话冲突、版本恢复、成员权限）
- 11 项差分测试（补丁形状、按引用跳过未变构件、apply 与原文档一致、不修改入参）
- 15 项 AI 集成测试（方案生成不落库、应用 rev、对话改厚度/删除、非法指令、viewer 权限、审计、doc 广播）
- 8 项 AI provider 测试（配置、工具调用解析、content 兜底、错误处理）
- 26 项系统管理测试（管理员引导、用户 CRUD、密码重置、管理员保护、删除限制、AI 设置加密/掩码/清除、权限）

另有 SSR 渲染冒烟（主界面/登录页/版本弹窗/成员弹窗/只读属性面板）与 Vite `/api`、`/ws` 代理验证。
