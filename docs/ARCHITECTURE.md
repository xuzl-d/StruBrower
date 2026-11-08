# StruBrowser 架构与路线图（Revit 类 Web BIM）

> 目标：把浏览器端网格原型演进为具备 BIM 语义的 Web 工作台。
> 说明：Revit 是二十年、数千人年的平台，**不做功能对等复刻**，而是复刻其核心工作流：
> 标高/轴网 → 参数化构件 → 视图/图纸 → 明细表 → 格式互操作 → 协作。

## 1. 现状（v0.9 · Revit 式通用编辑 + 图层/材质 + 参数关联 + 明细表/IFC4 + 服务端协作）

```
src/
  bim/             BIM 内核（与 UI 无关，可在服务端复用）
    types.ts       文档 schema v2：Level / Grid / Material / Layer / CategoryOverride / ProjectParameter / FamilyType / 墙柱板 / MeshInstance
    document.ts    派生查询（标高、顶部、尺寸、颜色）、v1→v2 迁移（含图层/参数补齐）、汇总
    geometry.ts    参数化构件 → BufferGeometry；导入归一化；布尔；OBJ 导出
    primitives.ts  参数化基本体（拉伸/旋转/长方体/圆柱/球/棱锥）
    modify.ts      Revit 式修改命令状态机：取点、变换、临时尺寸、幽灵预览、提交
    layers.ts      图层 / 材质内核：可见性优先级、颜色替换、透明度、锁定、增删改指派
    parameters.ts  参数与公式内核：安全表达式求值、依赖图拓扑序、联动重算、问题诊断
    ifc.ts         IFC4 STEP 导出（含材质关联与图层分配）
    schedule.ts    构件明细表与 CSV
    template.ts    项目模板、示例项目、自动命名
  data/            数据访问层
    repository.ts   ProjectRepository 接口（kind / list / load / save / remove）
    localRepository.ts  IndexedDB 实现（本地模式、离线演示）
    http.ts        HttpProjectRepository + 认证/版本/成员 API + rev 冲突错误
    index.ts       本地/服务端模式探测与选择
  components/      Ribbon / ProjectBrowser / PropertiesPanel / Fields / ModifyOptionsBar / DrawCoordinateBar /
                  LayersDialog / MaterialsDialog / ParametersDialog / ScheduleDialog /
                  ManagerFields / ParameterBinding / AuthGate / VersionsDialog / MembersDialog / AiPanel /
                  ModalShell（模态弹窗外壳：遮罩吞掉指针事件、点击空白不关闭、焦点陷阱与归还）
  components/account/  AccountCenter（账户中心外壳 + 左导航 + 权限分组）、ProfileSection、SecuritySection、
                  ProjectsSection（历史项目：打开/重命名/删除）、PreferencesSection（本机视图偏好）、
                  UsersSection（超管：用户 CRUD/重置密码/角色）、AiSection（超管：模型与 Key）、
                  SystemSection（超管：概览/全部项目/审计）
  ModelViewport    三维 & 平面视图、绘制工具、幽灵预览、临时尺寸、取点、选择
  App              编辑状态、命令栈（撤销/重做）、图层/材质/参数弹窗、自动保存、会话、冲突处理、文件交换
  collab/          协作差分（diff.ts，与服务端同一语义）与 WebSocket 客户端（client.ts：重连、在线状态、补丁）
  step/convert.ts  服务端 STEP 网格解码（magic / header / positions / colors）
server/
  index.js        HTTP 服务：REST 路由、鉴权、静态资源、SPA 回退
  store.js        SQLite 数据访问（用户/项目/成员/文档/版本/审计）
  db.js           建库与表结构
  auth.js         scrypt 密码、HMAC token、角色判定
  ws.js           协作 WebSocket 服务（房间、在线状态、补丁落库与广播）
  validate.js     文档/补丁校验与差分应用（服务端权威实现）
  convert/        STEP → 带面颜色网格（Python + OCP）与测试夹具
  ai/             AI 网关：BIM/造型指令（ops.js）、造型特征校验（solid.js）、上下文（context.js）、
                  上下文预算（budget.js）、长对话记忆（memory.js）、文本附件（attachments.js）、
                  视角巡检（inspect.js）、Mock/OpenAI provider
  src/ai/         自检闭环编排（agentLoop.ts，纯逻辑可单测）
  crypto.js       敏感配置加密（AES-256-GCM，密钥由 STRU_SECRET 派生）
scripts/dev.mjs   同时启动 API 与 Vite 的开发脚本
scripts/test.mjs  一键验证：接口 + 客户端数据层 + 协作 + 差分 + 内核测试
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
| 通用编辑 | Revit 式命令状态机（`bim/modify.ts`）+ 上下文选项栏：选择 → 命令 → 视口取点 → 幽灵预览/临时尺寸 → Enter/单击完成，Esc 逐级退出；移动/复制/旋转/双镜像/双阵列/对齐/偏移/缩放/修剪/拆分/测量/锁定/删除、拖移与 Ctrl 拖拽复制 |
| 图层 / 类别可见性 | 项目级 `layers` 表 + `categoryOverrides`；显示/锁定/颜色替换/透明度/当前图层/指派选中；VV 打开图层管理器，浏览器树可直接切换 |
| 材质 | 颜色 + 不透明度 + 粗糙度 + 金属度 + 说明；类型材质与图元覆盖两级；MA 打开材质浏览器，可应用到选中构件或族类型 |
| 参数关联 | 项目全局参数 + 安全公式（无 eval）；类型尺寸与实例几何参数可 `fx` 绑定；依赖图拓扑序重算，改驱动参数 → 几何/明细表/IFC/协作全部跟随；GP 打开管理器，循环依赖报错并保持原值 |
| 参数化体量 | 拉伸体/旋转体/长方体/圆柱/球/棱锥，属性面板改参数后几何实时重建 |
| 界面 | 页面级全屏（Keyboard Lock 锁定 Esc）、项目浏览器/属性面板可收起为侧边竖条（状态记忆）、状态栏坐标与统计；左键拖拽即时旋转、轻点两下框选、中键平移；右上角无边框视角立方体（拖拽即旋转；点面切到顶/底/前/后/左/右，四元数补间；双击回轴测）；绘制时左上角坐标条（X/Y 或长度+角度，`3600mm` 等写法，⌖ 取光标）；常用快捷键 Ctrl+S/A/X、F2、VV/VG、MA、GP、HH/HR、ZF/ZE、PP/PB、WA/CL/SB/GR |
| 交换 | OBJ 导入导出、IFC4 导出（三角网格 + IfcMaterial + IfcPresentationLayerAssignment）、构件明细表与 CSV；STEP/STP 导入（网格 + 面颜色，见 `diagnostics/FINDINGS.md`） |
| 持久化 | 本地模式：IndexedDB；服务端模式：Node + SQLite，文档 rev 号 + 版本快照 |
| 账号与权限 | 注册/登录（scrypt + HMAC token）、项目成员角色（viewer/editor/admin）、只读 UI |
| 版本与冲突 | 不可变版本快照 + 恢复；rev 乐观并发，冲突时前端提示“加载最新 / 覆盖保存” |
| 审计 | 项目创建/改名/保存/版本/成员操作写入 audit_log，管理员可查 |
| 实时协作 | WebSocket 房间、在线状态、按构件 id 的差分广播与落库、实时角色校验、断线重连与 HTTP 降级 |
| STEP 面颜色 | 服务端 OCP/XCAF 转换器取回逐面颜色（浏览器导入器会丢），前端优先使用、失败回退 |
| AI 建模 | 文本 → 结构化 BIM 指令（Mock/OpenAI 兼容），服务端校验 + rev + 审计 + 撤销 + 协作广播 |
| 账户中心 | 右上角用户名进入的**整页**（左品牌+导航、右面包屑+页头+内容，Esc/「返回工作台」退出，工作台仅隐藏不卸载）：个人资料（改名）、登录与安全（自助改密码，需旧密码）、我的项目（历史项目打开/重命名/删除）、软件设置；普通成员看不到管理组；地址栏同步 `?account=xxx` |
| 系统管理 | 首个用户/STRU_ADMIN_EMAILS 为系统管理员；用户 CRUD、重置密码、角色；AI 设置（key AES-GCM 加密、掩码返回、界面即改即生效）；`npm run reset-password` 兜底 |
| 系统与审计 | 账户中心内：概览（用户/项目/存储/协作/运行状态）、全部项目（搜索/删除）、系统级审计（过滤/分页），仅系统管理员；旧 `/admin` 路由重定向到此 |
| 软件设置 | localStorage 持久化：高亮/背景/轴网/气泡颜色、网格与统计开关、坐标轴、吸附步长；本地模式可用 |

坐标约定：**世界 Z-up，单位米**，标高即世界 Z。导入几何会居中、贴地，作为独立 `mesh` 构件参与渲染与布尔。

### 1.1 图层与材质模型

```
ProjectDocument
  ├─ layers?: Layer[]                         // 6 个默认图层，0 号不可删
  │    { id, name, color, visible, locked, colorOverride?, transparency? }
  ├─ categoryOverrides?: Record<Category, CategoryOverride>
  │    { visible, color?, transparency? }     // Revit VV「模型类别」页
  ├─ materials: Material[]
  │    { id, name, color, opacity?, roughness?, metalness?, description? }
  └─ elements: BimElement[]
       { ..., visible, pinned?, layerId?, materialId? }
```

派生规则集中在 `src/bim/layers.ts`（纯函数，UI、IFC、明细表、协作共用同一套语义）：

| 规则 | 优先级 / 语义 |
| --- | --- |
| 可见性 | `element.visible ∧ layer.visible ∧ categoryOverride.visible`；视口、三角面统计均使用 `isElementVisible` |
| 锁定 | `element.pinned ∨ layer.locked`；修改命令引擎 `movable()`、删除、拖移、微移、属性面板都调用 `isElementLocked` |
| 颜色 | 图层颜色替换 > 类别颜色替换 > 图元材质 > 类型材质 > mesh 自身色；特征实体内部再按零件的 `material` 着色（替换色仍优先） |
| 透明度 | 材质不透明度 × (1 − 图层透明度) × (1 − 类别透明度) × 零件不透明度，<1 时启用透明渲染且关闭 depthWrite |
| 材质解析 | 图元 `materialId` 优先，其次 `type.materialId`；mesh 未指定时用自身颜色 |
| 迁移 | `ensureDocumentLayers` 幂等补齐图层表与构件 `layerId`（按类别），`migrateDocument` 与 `commit` 都会调用 |
| 当前图层 | 新绘制/导入构件归入当前图层；复制/阵列的新构件继承源构件图层 |

图层与类别替换作为小集合整包替换进入协作差分（`DocumentDiff.layers` / `categoryOverrides`），
服务端 `validateDiff` 白名单、形状校验与 `applyDocumentDiff` 同步支持；IFC4 导出用
`IFCPRESENTATIONLAYERASSIGNMENT` 表达图层、`IFCRELASSOCIATESMATERIAL` 表达材质关联。

### 1.2 参数与公式模型（Revit 项目参数 / 类型公式 / 关联约束）

```
ProjectDocument
  ├─ parameters?: ProjectParameter[]
  │    { id, name, value, unit, formula?, description?, group? }
  ├─ types: FamilyType[]
  │    { ..., thickness / width / depth, formulas?: { [key]: string } }
  └─ elements: BimElement[]
       { ..., dims/params, formulas?: { [key]: string } }
```

内核集中在 `src/bim/parameters.ts`（纯函数，无 React/three 依赖）：

| 关注点 | 实现 |
| --- | --- |
| 单位 | 值统一按 **m / m² / m³ / rad / 无量纲** 存储；`mm/cm/dm/m/km/deg/rad/%` 只作为字面量换算与显示后缀（`200mm → 0.2`）|
| 表达式 | 自带词法分析 + 递归下降求值器，**不使用 `eval` / `new Function`**；支持 `+ - * / ^`、括号、19 个函数、单位字面量 |
| 内置变量 | 全局：全部项目参数；实例：`标高`、`顶部标高`、`层高`、`长度`、`面积`、`厚度`、`截面宽`、`截面深`、`底部偏移`、`序号`（随构件与标高实时取值）|
| 依赖图 | `formulaReferences` 提取标识符 → 邻接表 → Kahn 拓扑排序；检出循环、未知变量、非有限值/除零 |
| 重算入口 | `recomputeParameters`：**全局参数（拓扑序）→ 类型参数 → 实例参数**，一次文档变更只跑一遍，不迭代收敛 |
| 幂等 | 无变化时返回原文档引用，避免污染撤销栈与协作差分；有变化时返回 `updates[]` 与 `affectedElements` 供状态栏提示 |
| 迁移 | `ensureDocumentParameters` 幂等补齐 `parameters`；旧文档只补参数表、**不自动绑定公式**，避免历史尺寸被改写 |
| 写入 | 参数增删改 / 改名（`renameParameterReferences` 改写所有引用）/ 类型与实例公式绑定 / 解除绑定，全部经 `App.commit` → 重算 |
| UI | `ParametersDialog` 四页签（全局 / 类型关联 / 实例关联 / 依赖与问题）；属性面板 `ParameterBinding` 的 **fx** 控件 |
| 协作 | `DocumentDiff.parameters` 整包替换；类型/实例的 `formulas` 随元素 put 一并同步，服务端白名单与形状校验已覆盖 |

派生消费方不持有副本：几何生成、属性面板、明细表、IFC4 导出都直接读重算后的文档，因此改一个驱动参数即可让
模型、统计与导出同时更新；锁定图层会拦截实例几何参数与实例公式绑定的写入（全局/类型参数仍可编辑，重算会正常作用到锁定构件）。

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
GET    /api/me                        → 当前用户（含 isAdmin / createdAt）
PATCH  /api/me                        { name } 改自己的显示名称
POST   /api/me/password               { currentPassword, newPassword } 改自己的密码
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
-- AI 会话：消息永不删除，历史可回看；summary 是更早对话压成的滚动摘要
create table ai_conversations (
  id uuid primary key, project_id uuid references projects, created_by uuid,
  title text, summary text, summary_seq int not null default 0,
  created_at timestamptz, updated_at timestamptz, archived boolean not null default false
);
create table ai_messages (
  id uuid primary key, conversation_id uuid references ai_conversations,
  seq int not null, role text not null, content text not null,
  payload jsonb,          -- ops / summary / warning / vision / thumbs / applied
  created_at timestamptz
);
```

> 大网格（STEP 导入的百万级三角面）不进 `payload`，写对象存储，文档里只保留 `{ storageKey, size, checksum }`。

## 5. 路线图

| 里程碑 | 内容 | 验收标准 |
| --- | --- | --- |
| **M1 BIM 内核**（已完成） | 标高/轴网、参数化墙柱板、类型与实例参数、撤销重做、平面/三维视图、v1→v2 迁移、Repository 抽象 | 可绘制/编辑/保存/重开项目；改标高或类型参数全模型联动；`npm run build` 通过 |
| **M2 完整前后端**（已完成） | Node 服务（node:http + node:sqlite）、注册/登录、项目成员角色、文档 rev 乐观并发、版本快照/恢复、审计、HttpRepository 切换、登录页/版本/成员弹窗、只读模式、单端口静态托管 | 32 项 HTTP 接口测试 + 21 项客户端数据层测试通过；两会话保存产生 409 冲突并可覆盖/重载；版本恢复生成新 rev；viewer 不可写、非 admin 不可改成员 |
| M3 构件与约束 | 门窗洞口、墙连接/剪切、柱梁板连接、草图模式 + 尺寸约束、类型管理器（复制/新建类型） | 墙上开洞随墙移动；改墙高洞口跟随；类型管理器可新建类型 |
| M4 视图与出图 | 平面剖切（视图范围、剖切面）、尺寸标注/标高标注/文字、图纸布局 + 视口、PDF/PNG 导出 | 从模型生成带标注的平面图并导出 PDF |
| **M5a STEP 转换**（已完成） | 服务端 Python + OCP 转换器：XCAF 样式表取逐面颜色、二进制网格协议、前端优先/回退、测试夹具与接口测试 | 吊车 STEP：21,178/21,394 面带色；`npm test` 95 项通过；转换器缺失时自动回退浏览器解析 |
| **M5b 明细表与 IFC 导出**（已完成） | 构件明细表（材质/长度/面积/体积/三角面，CSV 带 BOM）、IFC4 STEP 导出（层级 + 三角网格 + 材质 + 图层） | IFC 文本含 IFC4 FILE_SCHEMA、IFCBUILDINGSTOREY、IFCMATERIAL、IFCPRESENTATIONLAYERASSIGNMENT；明细表数值由真实几何计算 |
| **M6 实时协作基础**（已完成） | WebSocket 房间、在线状态、按构件 id 的差分广播与落库、实时角色校验、断线重连与 HTTP 降级 | 两人同时编辑不同构件互不覆盖；viewer 实时被拒；断线自动重连；`npm test` 覆盖 12 项协作用例 |
| M6+ 协作深化（后续） | 光标/选区共享、评论与标记、离线编辑合并（CRDT/OT）、大网格外置 | 同一构件并发编辑可合并；评论可定位到构件 |
| **M7 AI 建模**（已完成） | 文本 → 结构化 BIM 指令、Mock/OpenAI 兼容 provider、服务端校验 + rev + 审计 + 撤销、协作广播、AI 面板 | 无 key 也能演示；配置 key 后真实模型可用；135 项测试通过；非法指令不落库、viewer 被拒 |
| **M11 长对话与视觉自检**（本次完成） | 会话/消息落库（`ai_conversations` / `ai_messages`）、历史会话列表与切换、上下文预算化 + 滚动摘要、视口截图回灌、AI 自主视角巡检（`inspect` → 转视口截图 → 续一轮） | 关掉面板/刷新后能接着聊；28 项会话接口测试 + 19 项记忆单测 + 10 项巡检用例通过；AI 能自己转 4 个角度看完再给 `editFeature` |
| **M11.1 上下文压缩**（本次完成） | `budget.js` 按模型窗口分配预算（模型名分档 + 可配置覆盖）、项目上下文结构化裁剪（不切 JSON）、历史按 token 累积、摘要 6 条/4000 token 保留窗口、结构化摘要模板、手动压缩接口与面板占用指示 | 50 项预算单测 + 42 项记忆单测通过；换到 16k 窗口模型时历史与构件自动收缩、请求不超长；面板显示 `12.4k / 128k` 并可一键压缩 |
| **M11.2 自检闭环（agent）**（本次完成） | `src/ai/agentLoop.ts`：ops+inspect+done 一轮内组合、自动应用、打转/步数护栏、`stopRef` 随时中止；巡检回执标 `internal` 不污染历史 | 52 项闭环单测通过；Mock 全链路可跑；AI 能连续「改→转视角看→再改」直到自报 done |
| M8 AI 深化（后续） | 平面图 → 墙线/房间、图片 → 体量、图生 3D 网格、流式对话、模型自纠错重试、项目检索 | 上传户型图生成可编辑墙板；家具类图生模型作为导入几何 |
| **M9 Revit 式编辑与图层/材质**（已完成） | 命令状态机、选项栏、幽灵预览、临时尺寸、对象捕捉、拖移/拖拽复制、双字母快捷键；图层管理器、类别可见性替换、材质浏览器 | 49 项图层/材质内核断言 + 修改命令/IFC/明细表测试全通过；图层/材质参与撤消与协作同步 |
| **M10 参数关联更新（本次完成）** | 全局参数 + 安全公式求值器（无 eval）、类型/实例参数 `fx` 绑定、依赖图拓扑序重算、循环与非法公式诊断、属性面板与四页签管理器、协作差分 | 参数内核断言（公式/单位/依赖/循环/联动/体积/迁移/差分）全通过；改驱动参数后几何/明细表/IFC/协作端同步更新 |

> IFC **导入**、视图样板、按视图保存的可见性替换、过滤器规则表达式、图层线宽/线型仍属后续工作；
> 参数侧后续补共享参数、族参数/类型目录与迭代收敛约束。

## 6. 实时协作机制

传输：原生 WebSocket（服务端为 RFC6455 最小实现，零第三方依赖），端点 `/ws/projects/:id?token=...`；
Vite 开发服务器已代理 `/ws`。加入房间时服务端下发 `hello`（rev + 文档快照 + 在线用户），
客户端在无本地未保存修改时采用该快照。

| 方向 | 消息 | 说明 |
| --- | --- | --- |
| S→C | `hello` | rev、文档快照、在线用户、角色 |
| S→C | `presence` | 在线用户变化 |
| C→S | `patch` | 文档差分（按构件 id 合并） |
| S→C | `patch` | 落库后的 rev + 同一差分（广播给房间内所有人；发送端按连接 id 识别自己的回显，只同步 rev、不重复应用，避免清空撤销栈） |
| C→S | `sync` | 请求当前文档快照 |
| S→C | `error` | 权限/校验错误 |

差分语义（`src/collab/diff.ts` 与 `server/validate.js` 同一套）：构件按 id LWW 合并
（先 remove 再 put，新构件追加到末尾）；标高/轴网/类型/材质/图层/参数整包替换、类别替换整包替换；
未变化对象按引用跳过，避免对大网格做 JSON 序列化。图层、材质与参数（含类型/实例 `formulas`）的每次编辑都会产生补丁并广播。

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
AI 面板 → POST /ai/plan/stream（读权限，SSE）→ provider（Mock / OpenAI 兼容）
        → 中间事件：status / reasoning / content / tool / plan
        → result：{reply, ops, summary} → 面板展示 → 用户确认
        → POST /ai/apply（写权限）→ ops.js 校验 + 应用 → 新 rev + 审计
        → collab.broadcastDocument 广播整份文档 → 其他成员同步（发起端按本端 rev 跳过回声，保留撤销栈）
```

- 流式通道：`server/index.js` 的 `beginEventStream()` 开 `text/event-stream`（`no-transform` +
  `X-Accel-Buffering: no`，反代不缓冲），provider 的 `planStream()` 解析上游 SSE 并把增量回调出来；
  服务端按 100 ms 合并 token，心跳 15 s，客户端断开时 `AbortController` 一并中止上游请求。
  非流式 `/ai/plan` 保留（脚本 / 旧客户端 / 服务端没有流式路由时的前端回退）。

- 指令集与字段见 `docs/AI.md`；实现 `server/ai/ops.js`（形状/坐标/标高/类型/构件解析与不可变应用）。
- 任意造型：`addSolid` 直接携带特征树 JSON（不写代码、无二次编译），`server/ai/solid.js` 归一化
  （形状白名单、尺寸/点数/阵列上限、布尔模式、材质预设/色值）后原样存进文档，`src/bim/solid.ts`
  在渲染时求值；`addFeature` / `editFeature` / `deleteFeature` 只改单个特征。材质预设库在
  `shared/materials.js`。
- **模型库 = 数据**：十份案例模型是 `shared/models/*.json` 里的特征树文档（与 `addSolid.features`
  同构），`shared/library.js` 负责结构校验、冻结、深拷贝，以及可选的 `params` + `bindings` 参数层；
  `src/bim/solidTemplates.ts` 只把它们翻成界面清单，`addSolid { library }` 按 id 取用。
  **源码里没有模型生成器**——新增模型是加一份 JSON，不是加一段 TypeScript。Mock provider、
  前端「模型库」卡片、离线出图脚本（`npm run pavilion` / `aircraft` / `crane`）读同一份文件。
- 造型材质：求值时零件按材质取值分组 → 每个材质槽合并成一块几何 → `mergeGeometries(useGroups)`
  拼成带 `geometry.groups` 的实体，视口为每个槽建一个 `MeshStandardMaterial`；
  环境光照用 `RoomEnvironment` + PMREM + ACES 色调映射（金属没有环境反射会渲染成死黑）。
- 上下文 `server/ai/context.js` 只发送项目摘要（标高/类型/前 160 个构件/选中构件/造型实体特征树，
  造型实体排在前面避免被截断），不发送几何。
- 上下文预算 `server/ai/budget.js`：按模型窗口分配而非切字符串——窗口按模型名分档（可配
  `ai.contextTokens` / `STRU_AI_CONTEXT_TOKENS` 覆盖），扣除输出预留与系统提示后按 12% / 42% / 剩余
  分给滚动摘要、项目上下文、历史原文；项目上下文是**结构化裁剪**（降特征数 48→24→12→6 → 少列构件，
  省略量写进 `omitted`），历史从最新往前按 token 累积（单条 ≤1500）；`buildPrompt` 返回 `usage`，
  随 plan 结果回给前端显示占用并提示压缩。
- 长对话 `server/ai/memory.js`：未压缩消息 ≥18 条或 ≥6000 token 时把更早部分压成结构化备忘
  （【目标】【关键参数】【已完成的修改】【未决问题】【偏好】，≤1800 字）写回 `ai_conversations.summary`，
  只回灌 `summary_seq` 之后的消息；保留窗口 6 条 / 4000 token（长消息时按 token 收缩）；
  `compactConversation` 供面板手动压缩（成块、最多 2 块、失败抛给用户）。
- 视觉自检：`GET /api/ai/status` 返回 `canSeeImages`（主模型读图或已启用独立视觉模型，1.5s 快速判断）；
  前端在发送前把当前视口截图（长边 1024 JPEG）附在参考图之后，模型因此能对着自己的成品继续改。
  空场景（还没有构件）不截；截到整张纯色（48×48 采样亮度极差过小）也当没截——既省 token，也不会在气泡里挂黑图。
- 文本附件 `server/ai/attachments.js`：`plan` / `plan/stream` 的 `attachments: [{name, text}]`
  校验后（3 个 / 单个 1.2 万字 / 合计 2.4 万字）拼成 `[[附件 n/m：名字]] … [[/附件]]` 块接在需求后面，
  随用户消息一起落库；用户正文仍限 4000 字，附件不吃这个额度。前端按同一块头规则把历史里的附件折成文件条。
- 视角巡检 `server/ai/inspect.js`：模型可在工具参数里带 `inspect`（预设视角或 `{azimuth, elevation}`，最多 4 个，
  归一化 + 仰角夹到 ±88°）。可与 `ops` 同轮出现（先应用再截图），`done: true` 表示它核对完认为已满足需求。
  每一项还能带 `focus`（构件名 / id / 造型特征名）与 `zoom`（0.4–4 取景倍数）：前端 `boxOfFocus` 把取景范围
  换成那个构件的包围盒，`frameCamera` 再按倍数推近——AI 因此能自己决定「看哪个件、看多近」，
  而不是只能在整机图上数像素。命不中 focus 就静默退回整机。
  前端通过 `ModelViewport` 暴露的 `onViewportApi`（`look / capture / camera / fitAll`）真的转动视口、逐张截图。
  摆位用包围球 + 当前投影算距离，截图等两帧（rAF 不跑时 400ms 兜底），平面视图会先切回三维。
- 自检闭环 `src/ai/agentLoop.ts`（纯逻辑、可单测）：`plan → apply → inspect → 下一轮`，直到
  `done` / 用户停止 / 5 步上限 / 打转（连续两轮同指纹视角且无改动）/ 无动作 / 截不到图。
  `apply` 由前端注入：立即调用 `/ai/apply` 落库并等几何重建（两帧 + 260ms）再截图，撤销基线用自更新的 `docRef`。
  闭环代发的巡检回执落库时标 `payload.internal`：仍进上下文，但打开历史不显示成用户发言。
  前端 `cancel()` 先置 `stopRef` 再 `abort()`——只 abort 掐不断已经排到下一轮的循环。
- Provider `server/ai/provider.js`：`mock`（关键词，无 key）与 `openai`（`/chat/completions` + 工具调用）。
- 安全：key 只在服务端；`plan` 需读、`apply` 需写（viewer 403）；应用后跑 `validateDocument`；
  审计 `ai.plan` / `ai.apply`；失败不写库。
- 前端 `src/components/AiPanel.tsx`：消息流、指令数量摘要、JSON 预览、应用/放弃；应用前把旧文档压入撤销栈。
- 系统管理：`users.is_admin`（首个用户自动为管理员，或 `STRU_ADMIN_EMAILS`）；`app_settings` 保存 AI 配置，
  `ai.apiKey` 用 AES-256-GCM 加密（`server/crypto.js`），接口只返回掩码；`PUT /api/admin/settings/ai` 后立即重建 provider。
  保护规则：至少一名管理员、不能删除自己、拥有项目的用户不可删除、删除用户级联成员关系。
- 超管后台接口：`/api/admin/overview`、`/api/admin/projects`（GET/DELETE）、`/api/admin/audit`；
  `audit_log` 记录管理员的关键操作，删除项目会先写审计再级联删除。
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
| `STRU_AI_TIMEOUT_MS` | `180000` | AI 请求超时（界面设置优先） |
| `STRU_ADMIN_EMAILS` | 空 | 逗号分隔的邮箱，注册即成为系统管理员 |
| `HOST` | `0.0.0.0` | 监听地址；`127.0.0.1` 表示仅本机 |
| `PORT` | `8787` | 单端口（页面 + API + WebSocket） |
| `STRU_DATA_DIR` | `server/data` | SQLite 与 secret 的持久化目录 |
| `STRU_ALLOW_REGISTER` | `1` | `0` 关闭开放注册（空库时仍允许创建第一个管理员） |
| `STRU_AUTH_RATE_LIMIT` | `60` | 登录/注册限流（次 / 5 分钟 / IP），`0` 关闭 |
| `STRU_TRUST_PROXY` | 关闭 | 在 Nginx/Caddy 后设 `1`，按 `X-Forwarded-For` 识别真实 IP |
| `STRU_INSTANCE_ID` | `hostname:pid` | 实例标识，出现在 health/系统概览，便于多实例排障 |
| `STRU_STEP_RATE_LIMIT` | `6` | 每用户每分钟 STEP 转换次数（`0` 关闭，进程内计数） |
| `STRU_AI_RATE_LIMIT` | `30` | 每用户每分钟 AI 调用次数（`0` 关闭，进程内计数） |
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
- 12 项协作测试（房间、hello/presence、补丁广播与落库、连接 id 识别自回显、viewer 实时拒绝、断开 presence、非法 token）
- 8 项 STEP 转换接口测试（状态、鉴权、二进制协议、面带色、单位换算）+ 7 项客户端解码测试
- 21 项客户端数据层测试（双会话冲突、版本恢复、成员权限）
- 11 项差分测试（补丁形状、按引用跳过未变构件、apply 与原文档一致、不修改入参）
- 15 项 AI 集成测试（方案生成不落库、应用 rev、对话改厚度/删除、非法指令、viewer 权限、审计、doc 广播）
- 8 项 AI provider 测试（配置、工具调用解析、content 兜底、错误处理）
- 26 项系统管理测试（管理员引导、用户 CRUD、密码重置、管理员保护、删除限制、AI 设置加密/掩码/清除、权限）
- 修改命令 / 吸附 / 框选 / 设置 / IFC / 明细表 / **图层与材质（49 项断言）** / **参数关联（38 项断言：公式求值、单位、依赖拓扑、循环、联动、体积、迁移、差分）** / **撤销栈（12 项断言：连按撤销、重做、分支清理、50 步上限、不可变）** / **坐标输入（26 项断言：mm/cm/m 换算、非法输入、极坐标与轴网方向）** 内核测试

另有 SSR 渲染冒烟（主界面/登录页/版本弹窗/成员弹窗/只读属性面板）与 Vite `/api`、`/ws` 代理验证。
