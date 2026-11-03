import { useEffect, useRef, useState } from 'react';
import { aiApi, ApiError } from '../data';
import type { AiStatus } from '../data';
import type { ProjectDocument } from '../bim/types';

interface AiPanelProps {
  projectId: string;
  projectName: string;
  canEdit: boolean;
  selectedIds: string[];
  currentDocument: ProjectDocument;
  onClose: () => void;
  onApplied: (document: ProjectDocument, rev: number, previous: ProjectDocument) => void;
}

interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  text: string;
  ops?: Array<Record<string, unknown>>;
  summary?: Record<string, number>;
  applied?: boolean;
  mock?: boolean;
}

const SUGGESTIONS = [
  '建一个 6×4 米、层高 3 米的房间',
  '加一面 5 米长的墙',
  '加一根柱',
  '把墙加厚到 300',
  '删除墙 1',
];

function newId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `msg-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export default function AiPanel({
  projectId,
  projectName,
  canEdit,
  selectedIds,
  currentDocument,
  onClose,
  onApplied,
}: AiPanelProps) {
  const [status, setStatus] = useState<AiStatus | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [statusError, setStatusError] = useState('');
  const listRef = useRef<HTMLDivElement>(null);

  const loadStatus = async () => {
    try {
      const next = await aiApi.status();
      setStatus(next);
      setStatusError('');
    } catch (caught) {
      const message = caught instanceof ApiError ? caught.message : '读取 AI 状态失败';
      setStatusError(/HTTP 500|HTTP 404|无法连接服务端/.test(message)
        ? `${message}`
        : message);
    }
  };

  useEffect(() => {
    void loadStatus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const list = listRef.current;
    if (list) list.scrollTop = list.scrollHeight;
  }, [messages, busy]);

  const send = async (text?: string) => {
    const content = (text ?? input).trim();
    if (!content || busy) return;
    setInput('');
    setError('');
    const userMessage: ChatMessage = { id: newId(), role: 'user', text: content };
    setMessages((current) => [...current, userMessage]);
    setBusy(true);
    try {
      const history = [...messages, userMessage]
        .filter((message) => message.role !== 'system')
        .slice(-6)
        .map((message) => ({ role: message.role, content: message.text }));
      const plan = await aiApi.plan(projectId, content, selectedIds, history);
      setMessages((current) => [...current, {
        id: newId(),
        role: 'assistant',
        text: plan.reply || '（模型没有给出说明）',
        ops: plan.ops,
        summary: plan.summary,
        mock: plan.mock,
      }]);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'AI 调用失败');
    } finally {
      setBusy(false);
    }
  };

  const apply = async (message: ChatMessage) => {
    if (!message.ops?.length || busy) return;
    setBusy(true);
    setError('');
    try {
      const result = await aiApi.apply(projectId, message.ops, message.text);
      onApplied(result.document, result.rev, currentDocument);
      setMessages((current) => current.map((item) => (
        item.id === message.id ? { ...item, applied: true } : item
      )).concat({
        id: newId(),
        role: 'system',
        text: `已应用 ${result.applied.length} 条指令，生成 rev ${result.rev}。可以用 Ctrl/Cmd+Z 撤销。`,
      }));
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : '应用失败');
    } finally {
      setBusy(false);
    }
  };

  const discard = (id: string) => {
    setMessages((current) => current.filter((message) => message.id !== id));
  };

  const statusText = !status
    ? '连接中…'
    : status.mock
      ? 'Mock 模式（本地模拟，无需 key）'
      : status.ready
        ? `模型 ${status.model}`
        : '未配置（设置 STRU_AI_API_KEY）';

  return (
    <aside className="ai-panel" aria-label="AI 助手">
      <header className="ai-head">
        <div>
          <strong>AI 助手</strong>
          <span>{projectName} · {statusText}</span>
        </div>
        <button className="ai-close" onClick={onClose} aria-label="关闭 AI 助手">✕</button>
      </header>

      {statusError ? (
        <div className="ai-status-error">
          <span>{statusError}</span>
          <button onClick={() => void loadStatus()}>重试</button>
        </div>
      ) : null}

      <div className="ai-messages" ref={listRef}>
        {messages.length === 0 ? (
          <div className="ai-empty">
            <div className="ai-empty-glyph">✦</div>
            <strong>用一句话描述你要的模型</strong>
            <span>AI 会先生成结构化建模指令（标高/墙/板/柱），确认后才会写入项目。</span>
            <div className="ai-suggestions">
              {SUGGESTIONS.map((suggestion) => (
                <button key={suggestion} onClick={() => void send(suggestion)} disabled={busy}>
                  {suggestion}
                </button>
              ))}
            </div>
          </div>
        ) : null}

        {messages.map((message) => (
          <div className={`ai-message ${message.role}`} key={message.id}>
            <div className="ai-bubble">
              <p>{message.text}</p>
              {message.ops?.length ? (
                <div className="ai-ops">
                  <div className="ai-op-summary">
                    {Object.entries(message.summary ?? {}).map(([label, count]) => (
                      <span key={label}>{label} × {count}</span>
                    ))}
                    {message.mock ? <em>Mock</em> : null}
                  </div>
                  <details>
                    <summary>查看 {message.ops.length} 条指令</summary>
                    <pre>{JSON.stringify(message.ops, null, 2).slice(0, 4000)}</pre>
                  </details>
                  {message.applied ? (
                    <div className="ai-applied">已应用到模型</div>
                  ) : (
                    <div className="ai-op-actions">
                      <button
                        className="primary"
                        disabled={!canEdit || busy}
                        title={canEdit ? '写入模型（可撤销）' : '查看者不能修改模型'}
                        onClick={() => void apply(message)}
                      >
                        应用到模型
                      </button>
                      <button disabled={busy} onClick={() => discard(message.id)}>放弃</button>
                    </div>
                  )}
                </div>
              ) : null}
            </div>
          </div>
        ))}

        {busy ? <div className="ai-typing">AI 正在思考…</div> : null}
      </div>

      {error ? <div className="ai-error">{error}</div> : null}

      <form
        className="ai-input"
        onSubmit={(event) => {
          event.preventDefault();
          void send();
        }}
      >
        <textarea
          value={input}
          rows={2}
          placeholder="例如：建一个 6×4 米的房间，墙厚 200mm；再把西墙加厚到 300"
          onChange={(event) => setInput(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault();
              void send();
            }
          }}
        />
        <button type="submit" disabled={busy || !input.trim()}>发送</button>
      </form>

      <div className="ai-foot">
        AI 只输出结构化建模指令，服务端校验后才会落库；所有修改都进版本历史，可撤销。
      </div>
    </aside>
  );
}
