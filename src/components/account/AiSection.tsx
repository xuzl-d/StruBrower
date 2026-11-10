import { useEffect, useState } from 'react';
import { adminApi, ApiError } from '../../data';
import type { AiSettingsView } from '../../data';

interface AiSectionProps {
  onToast: (message: string) => void;
}

/** AI 设置（系统管理员）：提供方、接口地址、模型、Key 与连通性测试 */
export default function AiSection({ onToast }: AiSectionProps) {
  const [ai, setAi] = useState<AiSettingsView | null>(null);
  const [provider, setProvider] = useState<'mock' | 'openai'>('mock');
  const [baseUrl, setBaseUrl] = useState('');
  const [model, setModel] = useState('');
  const [reasoningEffort, setReasoningEffort] = useState<AiSettingsView['reasoningEffort']>('');
  /** 独立视觉模型：默认不勾选，只有主模型不能读图时才用得上 */
  const [visionEnabled, setVisionEnabled] = useState(false);
  const [visionModel, setVisionModel] = useState('');
  const [visionBaseUrl, setVisionBaseUrl] = useState('');
  const [visionApiKey, setVisionApiKey] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [timeoutMs, setTimeoutMs] = useState(60000);
  /** 0 = 按模型名自动推断（见 server/ai/budget.js） */
  const [contextTokens, setContextTokens] = useState(0);
  const [testResult, setTestResult] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [models, setModels] = useState<Array<{ id: string; image: boolean | null }>>([]);
  const [modelsBaseUrl, setModelsBaseUrl] = useState('');
  const [modelsLoading, setModelsLoading] = useState(false);
  const [modelsError, setModelsError] = useState('');

  const loadModels = async (settings: AiSettingsView) => {
    if (settings.provider !== 'openai' || !settings.hasKey) {
      setModels([]);
      setModelsBaseUrl('');
      setModelsError('');
      return;
    }
    setModelsLoading(true);
    setModelsError('');
    try {
      const result = await adminApi.aiModels();
      setModels(result.models);
      setModelsBaseUrl(settings.baseUrl.replace(/\/+$/, ''));
    } catch (caught) {
      setModels([]);
      setModelsBaseUrl('');
      setModelsError(caught instanceof ApiError ? caught.message : '获取模型列表失败');
    } finally {
      setModelsLoading(false);
    }
  };

  const load = async () => {
    try {
      const data = await adminApi.aiSettings();
      setAi(data);
      setProvider(data.provider);
      setBaseUrl(data.baseUrl);
      setModel(data.model);
      setReasoningEffort(data.reasoningEffort ?? '');
      setVisionEnabled(Boolean(data.visionEnabled));
      setVisionModel(data.visionModel ?? '');
      setVisionBaseUrl(data.visionBaseUrl ?? '');
      setTimeoutMs(data.timeoutMs);
      setContextTokens(data.contextTokens ?? 0);
      setApiKey('');
      setVisionApiKey('');
      setError('');
      void loadModels(data);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : '读取 AI 设置失败');
    }
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const run = async (action: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      await action();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : '操作失败');
    } finally {
      setBusy(false);
    }
  };

  const save = () => run(async () => {
    const result = await adminApi.saveAiSettings({
      provider,
      baseUrl: baseUrl.trim(),
      model: model.trim(),
      reasoningEffort,
      visionEnabled,
      visionModel: visionEnabled ? visionModel.trim() : '',
      visionBaseUrl: visionEnabled ? visionBaseUrl.trim() : '',
      timeoutMs,
      contextTokens,
      ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
      ...(visionEnabled && visionApiKey.trim() ? { visionApiKey: visionApiKey.trim() } : {}),
    });
    setAi(result);
    setApiKey('');
    setVisionApiKey('');
    onToast(result.ready ? 'AI 设置已保存' : '已保存，但还缺少 API key');
    void loadModels(result);
  });

  const test = () => run(async () => {
    const result = await adminApi.testAi();
    const suffix = result.degraded ? ' · 已降级为 JSON 输出（该模型不支持工具调用）' : '';
    setTestResult({
      ok: result.ok,
      text: result.ok
        ? `连接成功（${result.provider}${result.model ? ` · ${result.model}` : ''}${suffix}）`
        : `连接失败：${result.error ?? '未知错误'}`,
    });
  });

  const clearVisionKey = () => run(async () => {
    const result = await adminApi.saveAiSettings({ clearVisionKey: true });
    setAi(result);
    onToast('已清除视觉模型的 API Key');
  });

  const clearKey = () => run(async () => {
    const result = await adminApi.saveAiSettings({ clearKey: true });
    setAi(result);
    onToast('已清除已保存的 API key');
  });

  const sourceLabel = (key: string): string => {
    const source = ai?.source?.[key];
    return source === 'db' ? '数据库' : source === 'env' ? '环境变量' : '未设置';
  };

  return (
    <div className="account-cards">
      <section className="account-card">
        <header className="account-card-head">
          <div>
            <strong>建模助手</strong>
            <span>配置对所有成员生效；API Key 加密存储，只显示掩码</span>
          </div>
          <span className={`account-status ${ai?.ready ? 'ok' : 'warn'}`}>
            {ai ? (ai.ready ? '就绪' : '未就绪（缺少 API Key）') : '读取中…'}
          </span>
        </header>

        <div className="account-form">
          <label className="account-field">
            <span>提供方</span>
            <select value={provider} onChange={(event) => setProvider(event.target.value as 'mock' | 'openai')}>
              <option value="mock">Mock（本地模拟，无需 Key）</option>
              <option value="openai">OpenAI 兼容接口（DeepSeek / 通义 / Ollama…）</option>
            </select>
          </label>

          <label className="account-field">
            <span>接口地址</span>
            <input
              value={baseUrl}
              placeholder="https://api.deepseek.com/v1"
              onChange={(event) => setBaseUrl(event.target.value)}
              disabled={provider === 'mock'}
            />
            <em>来源：{sourceLabel('baseUrl')}</em>
          </label>

          <div className="account-field">
            <label htmlFor="ai-model">模型</label>
            <div className="account-field-inline">
              <input
                id="ai-model"
                list="ai-model-list"
                value={model}
                placeholder="搜索或输入模型名称"
                onChange={(event) => setModel(event.target.value)}
                disabled={provider === 'mock'}
              />
              <datalist id="ai-model-list">
                {provider === 'openai' && modelsBaseUrl === baseUrl.trim().replace(/\/+$/, '') && !apiKey.trim()
                  ? models.map((item) => <option key={item.id} value={item.id}>{item.image === true ? '支持图片' : item.image === false ? '不支持图片' : ''}</option>)
                  : null}
              </datalist>
              <button type="button" disabled={provider === 'mock' || modelsLoading || busy || !ai || baseUrl.trim().replace(/\/+$/, '') !== ai.baseUrl.replace(/\/+$/, '') || Boolean(apiKey.trim())} onClick={() => { if (ai) void loadModels(ai); }}>
                {modelsLoading ? '获取中…' : '刷新列表'}
              </button>
            </div>
            {provider === 'openai' && modelsBaseUrl === baseUrl.trim().replace(/\/+$/, '') && !apiKey.trim() && models.length > 0 ? (
              <select aria-label="选择已获取的模型" value={model} onChange={(event) => setModel(event.target.value)}>
                {!models.some((item) => item.id === model) ? <option value={model}>{model || '选择模型'}</option> : null}
                {models.map((item) => <option key={item.id} value={item.id}>{item.id}{item.image === true ? '（支持图片）' : ''}</option>)}
              </select>
            ) : null}
            <em>{modelsError || (modelsBaseUrl === baseUrl.trim().replace(/\/+$/, '') && !apiKey.trim() ? `已获取 ${models.length} 个模型，可搜索或手动输入` : '保存接口地址和 Key 后获取模型列表')}</em>
          </div>

          <label className="account-field">
            <span>API Key</span>
            <input
              type="password"
              value={apiKey}
              placeholder={ai?.hasKey ? `已保存 ${ai.keyHint}（留空则不修改）` : 'sk-...'}
              onChange={(event) => setApiKey(event.target.value)}
              disabled={provider === 'mock'}
              autoComplete="off"
            />
            <em>来源：{sourceLabel('apiKey')} · 加密存储，不会回传给浏览器</em>
          </label>

          <label className="account-field">
            <span>思考强度</span>
            <select value={reasoningEffort} onChange={(event) => setReasoningEffort(event.target.value as AiSettingsView['reasoningEffort'])} disabled={provider === 'mock'}>
              <option value="">不指定</option>
              <option value="low">低</option>
              <option value="medium">中</option>
              <option value="high">高</option>
            </select>
            <em>仅支持 reasoning_effort 的模型使用；思考可能增加耗时和费用。</em>
          </label>

          <div className="account-field account-field-wide">
            <label className="account-check">
              <input
                type="checkbox"
                checked={visionEnabled}
                onChange={(event) => setVisionEnabled(event.target.checked)}
                disabled={provider === 'mock'}
              />
              <span>启用独立视觉模型（主模型不支持读图时使用）</span>
            </label>
            <em>
              默认不启用：上传图片时会先看主模型能否读图，能就直接用主模型；不能才用它读图并转成结构化规格。
              这里不做自动挑选，模型名必须自己填。
            </em>
          </div>

          {visionEnabled ? (
            <>
              <label className="account-field">
                <span>视觉模型</span>
                <input
                  value={visionModel}
                  placeholder="填支持读图的模型名，例如 qwen-vl-max"
                  onChange={(event) => setVisionModel(event.target.value)}
                />
                <em>来源：{sourceLabel('visionModel')}</em>
              </label>

              <label className="account-field">
                <span>视觉接口地址</span>
                <input
                  value={visionBaseUrl}
                  placeholder="留空则与主模型相同"
                  onChange={(event) => setVisionBaseUrl(event.target.value)}
                />
                <em>来源：{sourceLabel('visionBaseUrl')} · 与主模型不同厂商时填写</em>
              </label>

              <label className="account-field">
                <span>视觉 API Key</span>
                <input
                  type="password"
                  value={visionApiKey}
                  placeholder={ai?.hasVisionKey ? `已保存 ${ai.visionKeyHint}（留空则不修改）` : 'sk-...'}
                  onChange={(event) => setVisionApiKey(event.target.value)}
                  autoComplete="off"
                />
                <em>来源：{sourceLabel('visionApiKey')} · 留空则复用主模型 Key（同厂商时可以直接留空）</em>
              </label>
            </>
          ) : null}

          <label className="account-field">
            <span>超时（毫秒）</span>
            <input
              type="number"
              value={timeoutMs}
              min={1000}
              max={300000}
              step={1000}
              onChange={(event) => setTimeoutMs(Number(event.target.value))}
            />
          </label>
          <label className="account-field">
            <span>上下文窗口（tokens）</span>
            <input
              type="number"
              value={contextTokens}
              min={0}
              max={2000000}
              step={8000}
              placeholder="0 = 按模型名自动推断"
              onChange={(event) => setContextTokens(Number(event.target.value))}
            />
            <em>
              填 0 时按模型名推断（当前生效 {ai?.contextWindow ? `${Math.round(ai.contextWindow / 1000)}k` : '—'}）。
              填小了会提前压缩、问答更省；填大了容易撞到网关的长度上限。
            </em>
          </label>
        </div>

        {error ? <div className="account-error">{error}</div> : null}

        <div className="account-actions">
          <button className="primary" onClick={() => void save()} disabled={busy}>保存设置</button>
          <button onClick={() => void test()} disabled={busy}>测试连接</button>
          {ai?.hasKey ? <button className="danger" onClick={() => void clearKey()} disabled={busy}>清除已保存的 Key</button> : null}
          {visionEnabled && ai?.hasVisionKey ? <button className="danger" onClick={() => void clearVisionKey()} disabled={busy}>清除视觉 Key</button> : null}
          <span className="account-hint">
            当前：{ai ? `${ai.provider}${ai.provider === 'mock' ? '' : ` · ${ai.model}`}` : '—'}
          </span>
        </div>

        {testResult ? (
          <div className={`account-note ${testResult.ok ? 'ok' : 'bad'}`}>{testResult.text}</div>
        ) : null}

        <div className="account-note">
          环境变量同样可配置（优先级更低）：STRU_AI_PROVIDER / STRU_AI_BASE_URL / STRU_AI_MODEL / STRU_AI_VISION_MODEL / STRU_AI_API_KEY。
          这里保存的设置优先级更高，保存后立即生效，无需重启服务端。
        </div>
      </section>
    </div>
  );
}
