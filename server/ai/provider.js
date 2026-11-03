/**
 * AI 提供方：
 * - mock：本地确定性生成（默认），用于开发、演示和测试，不需要 key
 * - openai：任何 OpenAI 兼容的 /chat/completions（OpenAI、DeepSeek、通义、Ollama 等）
 * 只允许模型通过工具调用返回结构化 BIM 指令，服务端再做校验。
 */

export function resolveAiConfig(env = process.env) {
  const provider = (env.STRU_AI_PROVIDER ?? 'mock').toLowerCase();
  const baseUrl = (env.STRU_AI_BASE_URL ?? 'https://api.openai.com/v1').replace(/\/+$/, '');
  const model = env.STRU_AI_MODEL ?? (provider === 'mock' ? 'mock' : 'gpt-4o-mini');
  const apiKey = env.STRU_AI_API_KEY ?? env.OPENAI_API_KEY ?? '';
  const timeoutMs = Number(env.STRU_AI_TIMEOUT_MS ?? 60000);
  return {
    provider: provider === 'openai' ? 'openai' : 'mock',
    baseUrl,
    model,
    apiKey,
    timeoutMs,
    // mock 永远可用；真实提供方需要 key
    ready: provider === 'mock' || Boolean(apiKey),
  };
}

const TOOL = {
  type: 'function',
  function: {
    name: 'apply_bim_ops',
    description: '提交对当前 BIM 项目的建模指令（单位米，Z-up，平面坐标 [x, y]）',
    parameters: {
      type: 'object',
      properties: {
        reply: { type: 'string', description: '给用户的简短中文说明；信息不足时在这里提问' },
        ops: {
          type: 'array',
          description: '建模指令列表；不需要修改模型时返回空数组',
          items: { type: 'object', additionalProperties: true },
        },
      },
      required: ['reply', 'ops'],
    },
  },
};

const SYSTEM_PROMPT = `你是 StruBrowser 的 BIM 建模助手。用户用自然语言描述需求，你只能通过 apply_bim_ops 工具返回结构化指令，不要输出其它格式。

单位：米；坐标系：Z-up；平面点是 [x, y]。
可用指令（op 字段）：
- addLevel { name, elevation }
- addGrid { name?, start:[x,y], end:[x,y] }
- addWall { level, start:[x,y], end:[x,y], type?, thickness?, topLevel?, topOffset?, baseOffset?, height?, name? }
- addColumn { level, position:[x,y], type?, width?, depth?, rotation?, topLevel?, height?, name? }
- addSlab { level, points?:[[x,y]...], rect?:{x,y,width,depth}, type?, thickness?, baseOffset?, name? }
- updateElement { target: id 或名称, start?, end?, baseOffset?, topOffset?, level?, topLevel?, name?, visible? }
- setTypeProperty { type, thickness?, width?, depth?, name? }  // 类型级修改，会影响该类型全部实例
- deleteElement { target: id 或名称 }

规则：
1. 优先使用上下文中已有的标高名与类型名；只有确实需要时才 addLevel。
2. 默认墙/柱高度到上一层标高；没有上一层时用 height: 3。
3. 不要发明不存在的构件名称；修改/删除前先在上下文中确认目标。
4. 需求含糊时，reply 里提一个简短的问题，ops 返回空数组。
5. 一次请求尽量用最少的指令完成，坐标要合理（避免重叠墙）。
6. 不要编造尺寸单位：用户说 300 厚通常指 300mm，应传 thickness: 0.3。`;

function parseToolArguments(message) {
  const call = message?.tool_calls?.[0];
  if (call?.function?.arguments) {
    try {
      const parsed = JSON.parse(call.function.arguments);
      return {
        reply: typeof parsed.reply === 'string' ? parsed.reply : '',
        ops: Array.isArray(parsed.ops) ? parsed.ops : [],
      };
    } catch {
      return null;
    }
  }
  if (typeof message?.content === 'string') {
    const match = message.content.match(/\{[\s\S]*\}/);
    if (match) {
      try {
        const parsed = JSON.parse(match[0]);
        return {
          reply: typeof parsed.reply === 'string' ? parsed.reply : '',
          ops: Array.isArray(parsed.ops) ? parsed.ops : [],
        };
      } catch {
        // 忽略
      }
    }
    return { reply: message.content, ops: [] };
  }
  return null;
}

function createOpenAiProvider(config) {
  return {
    id: config.provider,
    async plan({ message, context, history = [] }) {
      const messages = [
        { role: 'system', content: SYSTEM_PROMPT },
        {
          role: 'system',
          content: `当前项目上下文（JSON）：\n${JSON.stringify(context).slice(0, 12000)}`,
        },
        ...history
          .filter((item) => item && (item.role === 'user' || item.role === 'assistant') && typeof item.content === 'string')
          .slice(-6)
          .map((item) => ({ role: item.role, content: item.content.slice(0, 2000) })),
        { role: 'user', content: String(message) },
      ];

      const response = await fetch(`${config.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${config.apiKey}`,
        },
        body: JSON.stringify({
          model: config.model,
          messages,
          tools: [TOOL],
          tool_choice: { type: 'function', function: { name: 'apply_bim_ops' } },
          temperature: 0.2,
        }),
        signal: AbortSignal.timeout(config.timeoutMs),
      });

      if (!response.ok) {
        const detail = await response.text().catch(() => '');
        throw new Error(`AI 服务返回 ${response.status}：${detail.slice(0, 300)}`);
      }
      const data = await response.json();
      const parsed = parseToolArguments(data?.choices?.[0]?.message);
      if (!parsed) throw new Error('AI 返回内容无法解析为建模指令');
      return { ...parsed, model: config.model };
    },
  };
}

/** 本地 Mock：按关键词生成确定性的建模指令，便于无 key 体验与自动化测试。 */
function createMockProvider() {
  return {
    id: 'mock',
    async plan({ message, context }) {
      const text = String(message ?? '').trim();
      const ops = [];
      const notes = [];
      const level = context.levels?.[0]?.name ?? '标高 1';
      const wallType = context.types?.find((type) => type.category === 'wall')?.name;
      const slabType = context.types?.find((type) => type.category === 'slab')?.name;
      const columnType = context.types?.find((type) => type.category === 'column')?.name;
      const numbers = [...text.matchAll(/(\d+(?:\.\d+)?)\s*(mm|毫米|m|米)?/gi)]
        .map((match) => ({ value: Number(match[1]), unit: (match[2] ?? '').toLowerCase() }));
      const size = text.match(/(\d+(?:\.\d+)?)\s*[x×*]\s*(\d+(?:\.\d+)?)/i);
      const width = size ? Number(size[1]) : numbers[0]?.value ?? 6;
      const depth = size ? Number(size[2]) : numbers[1]?.value ?? 4;

      const wantsDelete = /删除|移除|去掉/.test(text);
      const wantsThickness = /加厚|改厚|厚度|变厚/.test(text);

      if (wantsDelete) {
        const target = text.match(/(?:删除|移除|去掉)\s*([^\s，,。；;]+(?:\s*\d+)?)/)?.[1]?.trim();
        if (target) {
          ops.push({ op: 'deleteElement', target });
          notes.push(`删除构件「${target}」`);
        } else {
          return { reply: '请告诉我要删除哪个构件（用名称或 ID）。', ops: [], mock: true };
        }
      }

      if (!wantsDelete && /房间|小屋|房子|room|house|户型/.test(text)) {
        const w = Math.min(Math.max(width, 1), 50);
        const d = Math.min(Math.max(depth, 1), 50);
        const corners = [[0, 0], [w, 0], [w, d], [0, d]];
        for (let index = 0; index < 4; index += 1) {
          ops.push({
            op: 'addWall',
            level,
            start: corners[index],
            end: corners[(index + 1) % 4],
            ...(wallType ? { type: wallType } : {}),
          });
        }
        if (slabType) {
          ops.push({ op: 'addSlab', level, rect: { x: 0, y: 0, width: w, depth: d }, type: slabType });
        }
        notes.push(`在「${level}」上建 ${w} × ${d} m 的房间（4 面墙${slabType ? ' + 楼板' : ''}）`);
      } else if (!wantsDelete && /墙|wall/i.test(text) && !wantsThickness) {
        const length = Math.min(Math.max(numbers[0]?.value ?? 5, 0.5), 100);
        ops.push({
          op: 'addWall',
          level,
          start: [0, 0],
          end: [length, 0],
          ...(wallType ? { type: wallType } : {}),
        });
        notes.push(`新增一段 ${length} m 长的墙`);
      }

      if (!wantsDelete && /柱|column/i.test(text)) {
        const positions = size ? [[0, 0], [width, 0], [width, depth], [0, depth]] : [[0, 0]];
        for (const position of positions) {
          ops.push({
            op: 'addColumn',
            level,
            position,
            ...(columnType ? { type: columnType } : {}),
          });
        }
        notes.push(`新增 ${positions.length} 根柱`);
      }

      if (!wantsDelete && wantsThickness && wallType) {
        const raw = numbers.find((item) => item.value > 0)?.value;
        if (raw) {
          const unit = numbers.find((item) => item.value === raw)?.unit;
          const thickness = unit === 'mm' || unit === '毫米' || raw > 5 ? raw / 1000 : raw;
          ops.push({ op: 'setTypeProperty', type: wallType, thickness: Number(thickness.toFixed(3)) });
          notes.push(`把墙类型「${wallType}」的厚度改为 ${(thickness * 1000).toFixed(0)} mm`);
        }
      }

      if (!ops.length) {
        return {
          reply: '（Mock 模式）我能按“建一个 6×4 的房间 / 加一面 5 米的墙 / 加一根柱 / 把墙加厚到 300 / 删除墙 1”这类说法生成建模指令。你可以换个说法试试。',
          ops: [],
          mock: true,
        };
      }

      return {
        reply: `（Mock 模式）${notes.join('；')}。确认后点“应用到模型”，可随时撤销。`,
        ops,
        mock: true,
      };
    },
  };
}

export function createProvider(config) {
  if (config.provider === 'mock') return createMockProvider();
  return createOpenAiProvider(config);
}
