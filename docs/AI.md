# AI 建模助手（文本 → BIM）

用自然语言描述需求，AI 生成**结构化建模指令**，服务端逐条校验后才写入项目。
默认 **Mock 模式**（本地关键词模拟，无需 key），配置环境变量即可接入任意 OpenAI 兼容模型。

## 为什么不是“让 AI 直接吐网格”

Revit 类系统的价值在于**参数化、可编辑、可算量**。所以 LLM 只允许输出 BIM 指令（标高/墙/板/柱/类型），
几何仍由 `src/bim/geometry.ts` 按参数生成。这样：

- 模型输出可以被 JSON Schema + 服务端规则校验，出错不会写坏文档
- 每一步都有 rev、审计、版本快照，可撤销
- 与协作机制（WebSocket 差分/整文档广播）天然兼容

## 交互流程

```
用户在 AI 面板输入 → POST /api/projects/:id/ai/plan（只读）
  → 服务端把项目摘要 + 需求发给模型 → 模型用工具调用返回 {reply, ops}
  → 面板展示“将要执行的指令 + 数量统计”
用户点「应用到模型」→ POST /api/projects/:id/ai/apply（需要写入权限）
  → applyOps 逐条校验并生成新文档 → 保存新 rev + 审计
  → 向协作房间广播 doc 消息（其他在线成员自动同步）
  → 前端把它压入撤销栈，Ctrl/Cmd+Z 可回退
```

## 支持的指令（BIM ops）

单位米，坐标系 Z-up，平面坐标为 `[x, y]`。单次最多 60 条。

| op | 字段 | 说明 |
| --- | --- | --- |
| `addLevel` | `name`, `elevation` | 新增标高 |
| `addGrid` | `name?`, `start`, `end` | 新增轴网 |
| `addWall` | `level`, `start`, `end`, `type?`, `thickness?`, `topLevel?`, `topOffset?`, `baseOffset?`, `height?`, `name?` | 墙；未给 topLevel 时自动连到上方最近标高，没有则用 height（默认 3） |
| `addColumn` | `level`, `position`, `type?`, `width?`, `depth?`, `rotation?`, `topLevel?`, `height?` | 柱 |
| `addSlab` | `level`, `points?` 或 `rect?: {x,y,width,depth}`, `type?`, `thickness?`, `baseOffset?` | 楼板 |
| `updateElement` | `target`(id 或名称), `start?`, `end?`, `baseOffset?`, `topOffset?`, `level?`, `topLevel?`, `name?`, `visible?` | 修改单个实例 |
| `setTypeProperty` | `type`, `thickness?`, `width?`, `depth?`, `name?` | 修改类型（影响该类型全部实例） |
| `deleteElement` | `target` | 删除构件 |

示例（“建一个 6×4 米的房间”）：

```json
[
  { "op": "addWall", "level": "标高 1", "start": [0,0], "end": [6,0] },
  { "op": "addWall", "level": "标高 1", "start": [6,0], "end": [6,4] },
  { "op": "addWall", "level": "标高 1", "start": [6,4], "end": [0,4] },
  { "op": "addWall", "level": "标高 1", "start": [0,4], "end": [0,0] },
  { "op": "addSlab", "level": "标高 1", "rect": { "x": 0, "y": 0, "width": 6, "depth": 4 } }
]
```

## 配置真实模型

### 方式一：界面配置（推荐）

系统管理员登录后点顶部 **⚙ → AI 设置**，填写提供方 / 接口地址 / 模型 / API Key，点“测试连接”，保存即生效。
Key 使用 AES-256-GCM 加密存储在 SQLite（密钥由 `STRU_SECRET` 派生），接口只返回 `****末4位`。

### 方式二：环境变量

默认 `STRU_AI_PROVIDER=mock`。切换为 OpenAI 兼容接口（DeepSeek / OpenAI / 通义 / Ollama 均可）：

```bash
# DeepSeek
export STRU_AI_PROVIDER=openai
export STRU_AI_BASE_URL=https://api.deepseek.com/v1
export STRU_AI_MODEL=deepseek-chat
export STRU_AI_API_KEY=sk-...

# 本地 Ollama（OpenAI 兼容端点）
export STRU_AI_PROVIDER=openai
export STRU_AI_BASE_URL=http://127.0.0.1:11434/v1
export STRU_AI_MODEL=qwen2.5:14b
export STRU_AI_API_KEY=ollama
```

其余变量：

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `STRU_AI_PROVIDER` | `mock` | `mock` / `openai` |
| `STRU_AI_BASE_URL` | `https://api.openai.com/v1` | OpenAI 兼容地址（不要带 `/chat/completions`） |
| `STRU_AI_MODEL` | `gpt-4o-mini` | 模型名 |
| `STRU_AI_API_KEY` | 空 | 仅存服务端；也可以用 `OPENAI_API_KEY` |
| `STRU_AI_TIMEOUT_MS` | `60000` | 单次请求超时 |

> key 只在 Node 服务端使用，浏览器拿不到；`GET /api/ai/status` 只返回 provider/model/ready。
> 界面保存的设置优先于环境变量；环境变量仅作为默认值/兜底。

## 安全与一致性

- **权限**：`plan` 需要项目读权限；`apply` 需要写权限（`viewer` 会被 403 拒绝）。
- **校验**：`server/ai/ops.js` 校验指令形状、坐标范围、标高/类型/构件是否存在、墙长/板轮廓；
  应用后再跑一次 `validateDocument`，任何一步失败都不写库。
- **可追溯**：写入新 `rev`，审计记录 `ai.plan` / `ai.apply`；版本快照可回滚。
- **并发**：AI 应用基于当前最新文档计算并保存为新 rev，同时向协作房间广播，其他成员实时同步。
- **撤销**：前端在应用前把旧文档压入撤销栈，`Ctrl/Cmd+Z` 可回退（协作在线时会作为补丁同步）。

## 测试

```bash
npm test
```

覆盖：

- `scripts/ai-test.mjs`（15 项）：状态/鉴权、方案生成不落库、应用后 rev+1 与构件数量、
  对话式改厚度/删除、非法指令 400 且不落库、viewer 不能应用、审计记录、协作房间收到 doc 广播。
- `scripts/ai-provider-test.mjs`（8 项）：配置解析、OpenAI 工具调用解析、content JSON 兜底、非 2xx 错误。

## 已知限制与下一步

- Mock 仅按关键词匹配（房间/墙/柱/厚度/删除），用于演示与测试；真实理解依赖配置的模型。
- 上下文只发送项目摘要（前 120 个构件），大项目需要更精细的检索/摘要策略。
- 暂无流式输出、图片输入、多轮工具循环（模型修正错误指令重试）。
- 图片路线规划：平面图 → 视觉模型提墙线/房间 → 同一套 ops；单张照片只能做体量近似；
  家具/道具类可接图生 3D 服务，作为“导入几何”构件。
