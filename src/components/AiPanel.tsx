import { useEffect, useRef, useState } from 'react';
import type { CSSProperties, PointerEvent as ReactPointerEvent } from 'react';
import { aiApi, ApiError } from '../data';
import type { AiContextUsage, AiConversationSummary, AiInspectView, AiPlan, AiStatus, AiStoredMessage } from '../data';
import type { ProjectDocument } from '../bim/types';
import type { ViewLookRequest } from '../ModelViewport';
import { MAX_AGENT_STEPS, runAgentLoop } from '../ai/agentLoop';
import type { AgentRound, AgentRun, AgentShot } from '../ai/agentLoop';

/**
 * 视口句柄（App 注入）：AI 的「手」——截图、转到指定视角、读当前相机角度。
 * look 之所以是异步的：平面视图会锁死相机，App 需要先切回三维、等视口重建完再摆位。
 */
export interface AiViewportHandle {
  capture: () => string | null;
  look: (request: ViewLookRequest) => Promise<boolean>;
  camera: () => { azimuth: number; elevation: number; distance: number } | null;
  fitAll: () => boolean;
}

interface AiPanelProps {
  projectId: string;
  projectName: string;
  canEdit: boolean;
  selectedIds: string[];
  currentDocument: ProjectDocument;
  onClose: () => void;
  onApplied: (document: ProjectDocument, rev: number, previous: ProjectDocument) => void;
  /** 停靠到右侧固定栏时回报占位宽度（0 表示浮动），工作区据此让出这一条 */
  onDockChange?: (width: number) => void;
  /** 三维视口的控制能力：应用完截图给模型看，AI 也能要求「转过去看一眼」 */
  viewport?: AiViewportHandle | null;
}

interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  text: string;
  /** 用户这条消息附带的参考图（dataURL） */
  images?: string[];
  /** 用户附带的文本文件：正文已从 text 里抽出来折叠显示 */
  files?: Array<{ name: string; text: string; truncated?: boolean }>;
  /** 发送时自动截的当前视口：只在本机展示，不落库（空场景不截，气泡里就不会挂一张黑图） */
  shot?: string;
  /** 历史消息里的截图痕迹：图没落库，只留一句「当时附过」 */
  shotNote?: boolean;
  /** AI 巡检时截下的视角图（只在本机展示，落库的是 200px 缩略图） */
  views?: Array<{ label: string; dataUrl: string }>;
  ops?: Array<Record<string, unknown>>;
  summary?: Record<string, number>;
  applied?: boolean;
  /** 自检闭环里这是第几步（第 1 步不显示，避免每句话都挂个「第 1 步」） */
  step?: number;
  /** 模型自评已满足需求 */
  done?: boolean;
  /** 自动应用后的版本号（历史「已应用」没有它） */
  appliedRev?: number;
  mock?: boolean;
  ms?: number;
  /** 服务端预校验没过、已自动修正的次数 */
  repaired?: number;
  /** 预校验仍未通过：这些指令不能直接应用 */
  warning?: string;
  /** 这次读图用的模型与识别结果 */
  vision?: { model: string; object: string; parts: number } | null;
  /** 落库后的消息 id：应用成功时用它回写「已应用」 */
  dbId?: string;
}

/** 一条待发送的附件：图片走视觉模型，文本文件拼进需求当参考资料 */
interface Attachment {
  id: string;
  kind: 'image' | 'text';
  /** 图片：压缩后的 dataURL */
  dataUrl?: string;
  /** 图片：长边 200px 的缩略图（随消息存进会话历史，原图不落库） */
  thumb?: string;
  name: string;
  bytes: number;
  /** 文本文件的内容（已截断；图片没有这个字段） */
  text?: string;
  truncated?: boolean;
}

/** 与 server/ai/vision.js 的 IMAGE_LIMITS 保持一致 */
const MAX_IMAGES = 4;
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
/** 长边压到 1280 就够视觉模型看清零件，再大只是白占带宽和 token */
const MAX_IMAGE_EDGE = 1280;
/** 文本附件：与 server/ai/attachments.js 的上限保持一致 */
const MAX_TEXT_FILES = 3;
const MAX_TEXT_BYTES = 2 * 1024 * 1024;
const MAX_TEXT_CHARS = 12_000;
const MAX_TEXT_TOTAL_CHARS = 24_000;
/** 图片 + 文本合计最多挂几个 */
const MAX_ATTACHMENTS = 6;
/** 认作「能按文字读」的扩展名：图片之外只有这些会被当参考资料发给模型 */
const TEXT_EXTENSIONS = [
  'txt', 'text', 'md', 'markdown', 'json', 'jsonl', 'csv', 'tsv', 'log', 'yml', 'yaml', 'xml', 'ini', 'conf', 'toml', 'env',
  'sql', 'py', 'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'java', 'kt', 'c', 'h', 'cc', 'cpp', 'hpp', 'cs', 'go', 'rs',
  'rb', 'php', 'sh', 'bash', 'zsh', 'bat', 'ps1', 'html', 'htm', 'css', 'scss', 'less', 'vue', 'svelte', 'swift', 'm',
  'lua', 'pl', 'r', 'tex', 'ifc', 'gltf', 'obj',
];
/** 发送时自动附视口截图的那句标记：服务端原样存进历史，前端回显时折成一条提示 */
const SHOT_MARKER = '[附：当前模型视图截图]';
/** 附件块首行，与 server/ai/attachments.js 的 attachmentHead 严格对应 */
const ATTACHMENT_HEAD = /^\[\[附件\s*\d+\/\d+：(.+?)(（较长，已截断）)?\]\]$/;
const ATTACHMENT_TAIL = '[[/附件]]';


/**
 * 视口截图是不是「一片空白」：空场景 / 刚打开还没渲染时截出来是一整张纯色，
 * 发给模型只会浪费上千 token 并诱导它瞎猜，显示在气泡里就是一个黑块。
 * 做法：缩到 48×48 采样亮度，极差过小（或整张都很暗）就认为什么都没画。
 */
function isBlankDataUrl(dataUrl: string): Promise<boolean> {
  return new Promise((resolve) => {
    const image = new Image();
    image.onload = () => {
      const size = 48;
      const canvas = document.createElement('canvas');
      canvas.width = size;
      canvas.height = size;
      const context = canvas.getContext('2d', { willReadFrequently: true });
      if (!context) {
        resolve(false);
        return;
      }
      context.drawImage(image, 0, 0, size, size);
      const { data } = context.getImageData(0, 0, size, size);
      let min = 255;
      let max = 0;
      for (let index = 0; index < data.length; index += 4) {
        const luma = data[index] * 0.299 + data[index + 1] * 0.587 + data[index + 2] * 0.114;
        if (luma < min) min = luma;
        if (luma > max) max = luma;
      }
      resolve(max - min < 12 || max < 30);
    };
    image.onerror = () => resolve(true);
    image.src = dataUrl;
  });
}

/** 按 MIME / 扩展名判断能不能当纯文本读 */
function isTextFile(file: File): boolean {
  if (file.type.startsWith('text/')) return true;
  if (file.type === 'application/json' || file.type === 'application/xml' || file.type === 'application/x-yaml') return true;
  const ext = file.name.toLowerCase().split('.').pop() ?? '';
  return Boolean(ext) && TEXT_EXTENSIONS.includes(ext);
}

/**
 * 二进制文件读成文本只有乱码：先看开头有没有 NUL 和成片的控制字符。
 * （.step / .srp 这类虽然也是文本格式，但几十万行照样没有阅读价值，靠体积上限挡掉。）
 */
function looksBinary(text: string): boolean {
  const sample = text.slice(0, 4096);
  if (!sample) return false;
  let bad = 0;
  for (let index = 0; index < sample.length; index += 1) {
    const code = sample.charCodeAt(index);
    if (code === 0) return true;
    if (code < 9 || (code > 13 && code < 32)) bad += 1;
  }
  return bad / sample.length > 0.02;
}

/** 文本文件 → 附件：超过字数上限就截断，并在气泡里标出来 */
async function textToAttachment(file: File): Promise<Attachment> {
  if (file.size > MAX_TEXT_BYTES) {
    throw new Error(`${file.name || '该文件'} 太大（${(file.size / 1024 / 1024).toFixed(1)} MB），文本文件请控制在 2 MB 以内`);
  }
  const raw = await file.text();
  if (looksBinary(raw)) throw new Error(`${file.name || '该文件'} 看起来不是纯文本，只能当图片或文本上传`);
  const text = raw.length > MAX_TEXT_CHARS ? raw.slice(0, MAX_TEXT_CHARS) : raw;
  return {
    id: newId(),
    kind: 'text',
    name: file.name || '附件.txt',
    bytes: file.size,
    text,
    truncated: raw.length > MAX_TEXT_CHARS,
  };
}

/** 附件体积的短写法 */
function formatBytes(bytes: number): string {
  if (!bytes) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * 历史消息 → 气泡内容：把 `[[附件 …]] … [[/附件]]` 块重新折成文件条，
 * 正文只留用户自己写的那几句（附件块是给模型看的，不该把聊天区刷成论文）。
 */
function splitAttachmentBlocks(content: string): { text: string; files: Array<{ name: string; text: string; truncated?: boolean }> } {
  const lines = content.split('\n');
  const kept: string[] = [];
  const files: Array<{ name: string; text: string; truncated?: boolean }> = [];
  for (let index = 0; index < lines.length; index += 1) {
    const head = ATTACHMENT_HEAD.exec(lines[index].trim());
    if (!head) {
      kept.push(lines[index]);
      continue;
    }
    const body: string[] = [];
    let cursor = index + 1;
    for (; cursor < lines.length; cursor += 1) {
      if (lines[cursor].trim() === ATTACHMENT_TAIL) break;
      body.push(lines[cursor]);
    }
    files.push({ name: head[1], text: body.join('\n'), truncated: Boolean(head[2]) });
    index = cursor;
  }
  return { text: kept.join('\n').trim(), files };
}

/**
 * 把任意 dataURL 缩到长边 ≤ maxEdge：缩略图、视口截图压缩都用它
 */
function shrinkDataUrl(dataUrl: string, maxEdge: number, quality = 0.7): Promise<string> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => {
      const scale = Math.min(1, maxEdge / Math.max(image.width, image.height));
      const width = Math.max(1, Math.round(image.width * scale));
      const height = Math.max(1, Math.round(image.height * scale));
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext('2d');
      if (!context) {
        reject(new Error('浏览器不支持 canvas'));
        return;
      }
      // JPEG 没有透明通道，先铺白底，否则线稿会变黑
      context.fillStyle = '#ffffff';
      context.fillRect(0, 0, width, height);
      context.drawImage(image, 0, 0, width, height);
      resolve(canvas.toDataURL('image/jpeg', quality));
    };
    image.onerror = () => reject(new Error('图片解码失败'));
    image.src = dataUrl;
  });
}

/**
 * 把本地图片压成 dataURL：长边 ≤1280，照片转 JPEG。
 * 手机直出照片动辄 4–8 MB，原样上传会顶到服务端上限，读图也慢。
 */
async function fileToAttachment(file: File): Promise<Attachment> {
  if (!file.type.startsWith('image/')) throw new Error(`${file.name || '该文件'} 不是图片`);
  if (file.size > MAX_IMAGE_BYTES * 3) throw new Error(`${file.name || '图片'} 太大（${(file.size / 1024 / 1024).toFixed(1)} MB），请先压缩`);
  const bitmap = await createImageBitmap(file).catch(() => null);
  if (!bitmap) throw new Error(`${file.name || '图片'} 无法读取（格式可能不被浏览器支持，试试 PNG / JPG）`);
  const scale = Math.min(1, MAX_IMAGE_EDGE / Math.max(bitmap.width, bitmap.height));
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (!context) {
    bitmap.close?.();
    throw new Error('浏览器不支持 canvas，无法压缩图片');
  }
  // 先铺白底：JPEG 没有透明通道，线稿转 JPEG 否则会变黑底
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, width, height);
  context.drawImage(bitmap, 0, 0, width, height);
  bitmap.close?.();
  // 线稿 / 截图用 PNG 保边（透明已被白底覆盖，不会再花），照片用 JPEG 省一大半体积
  const isLineArt = file.type === 'image/png' && file.size < 700 * 1024;
  const dataUrl = isLineArt ? canvas.toDataURL('image/png') : canvas.toDataURL('image/jpeg', 0.86);
  const bytes = Math.round((dataUrl.length - dataUrl.indexOf(',') - 1) * 0.75);
  // 会话历史里只存小图：原图几 MB，聊天记录不该被图片撑爆
  const thumb = await shrinkDataUrl(dataUrl, 200, 0.66).catch(() => dataUrl);
  return { id: newId(), kind: 'image', dataUrl, thumb, name: file.name || '参考图', bytes };
}

/** 流式生成中的实时状态：阶段提示 + 思考过程 + 输出草稿 */
interface AiProgress {
  phase: string;
  reasoning: string;
  content: string;
  startedAt: number;
}

/** 只保留尾部 N 个字符：思考内容可能上万字，全留着既卡又没意义 */
function tail(text: string, max: number): string {
  return text.length <= max ? text : text.slice(text.length - max);
}

const SUGGESTIONS = [
  '造一台四翼螺旋桨无人机',
  '把无人机机臂加长到 30cm',
  '做一个带 4 个安装孔的 L 型支架',
  '建一个 6×4 米、层高 3 米的房间',
  '加一面 5 米长的墙',
];

function newId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `msg-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

/** 「自动应用」开关记忆：默认开——AI 自己改完再看，才叫 agent */
const AUTO_APPLY_KEY = 'strubrowser.ai.autoApply';

function readUiBool(key: string, fallback: boolean): boolean {
  try {
    const raw = window.localStorage.getItem(key);
    return raw === null ? fallback : raw === '1';
  } catch {
    return fallback;
  }
}

function writeUiBool(key: string, value: boolean): void {
  try {
    window.localStorage.setItem(key, value ? '1' : '0');
  } catch {
    /* 隐私模式禁用存储时忽略 */
  }
}

/** 每个项目各自记住「上次停在哪个会话」 */
const CONVERSATION_KEY = (projectId: string) => `strubrowser.ai.conversation.${projectId}`;

function readRememberedConversation(projectId: string): string | null {
  try {
    return window.localStorage.getItem(CONVERSATION_KEY(projectId));
  } catch {
    return null;
  }
}

/** 会话列表里的相对时间：刚开过的会话只显示「几分钟前」，老会话显示日期 */
function formatWhen(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const diff = Date.now() - date.getTime();
  if (diff < 60_000) return '刚刚';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  return `${date.getMonth() + 1}/${date.getDate()}`;
}

/** token 数的短写法：128000 → 128k，8200 → 8.2k */
function formatTokens(value?: number | null): string {
  if (!value || value <= 0) return '0';
  if (value >= 1000) return `${Math.round(value / 100) / 10}k`;
  return String(Math.round(value));
}

/** 上下文占用的悬浮说明：分项 + 被裁掉的东西，用户才知道空间去哪了 */
function usageTitle(usage: AiContextUsage): string {
  const b = usage.breakdown ?? {};
  const parts = [
    b.system ? `系统提示 ${formatTokens(b.system)}` : '',
    b.memory ? `更早对话摘要 ${formatTokens(b.memory)}` : '',
    b.project ? `项目上下文 ${formatTokens(b.project)}` : '',
    b.history ? `历史原文 ${formatTokens(b.history)}（${usage.historyItems ?? 0} 条）` : '',
    b.message ? `本次需求 ${formatTokens(b.message)}` : '',
    b.images ? `图片 ${formatTokens(b.images)}` : '',
  ].filter(Boolean);
  const notes = [
    usage.historyDropped ? `有 ${usage.historyDropped} 条更早消息未进上下文（超预算，建议压缩）` : '',
    usage.omittedElements ? `项目上下文省略 ${usage.omittedElements} 个构件` : '',
    usage.omittedFeatures ? `特征被精简 ${usage.omittedFeatures} 个` : '',
  ].filter(Boolean);
  return [
    `上下文占用 ${formatTokens(usage.tokens)} / ${formatTokens(usage.window)} tokens`,
    ...parts,
    ...notes,
  ].join('\n');
}

/**
 * 库里的消息 → 界面气泡（打开历史会话时用）。
 * 用户消息里的附件块、截图标记都折回成附件条与状态提示，正文只留用户写的话。
 */
function toChatMessage(item: AiStoredMessage): ChatMessage {
  const isUser = item.role === 'user';
  const parsed = isUser ? splitAttachmentBlocks(item.content) : { text: item.content, files: [] };
  const thumbs = item.thumbs ?? [];
  // 末尾那几张是发送时自动截的视口图，不算用户的参考图。新数据带 shots 张数；
  // 旧数据没有这个字段，按正文里的标记兜底（那时一次只附一张）。
  const shots = isUser
    ? Math.min(thumbs.length, item.shots ?? (parsed.text.includes(SHOT_MARKER) ? 1 : 0))
    : 0;
  const shotNote = shots > 0 || (isUser && parsed.text.includes(SHOT_MARKER));
  const text = shotNote ? parsed.text.split(SHOT_MARKER).join('').trim() : parsed.text;
  const images = shots > 0 ? thumbs.slice(0, thumbs.length - shots) : thumbs;
  return {
    id: `db-${item.id}`,
    dbId: item.id,
    role: item.role,
    text,
    images: images.length ? images : undefined,
    files: parsed.files.length ? parsed.files : undefined,
    shot: shots > 0 ? thumbs.at(-1) : undefined,
    shotNote: shotNote || undefined,
    ops: item.ops,
    summary: item.summary,
    applied: item.applied,
    repaired: item.repaired,
    warning: item.warning,
    vision: item.vision ?? null,
    ms: item.ms,
  };
}

/**
 * 面板布局：floating 是可随意拖动的浮窗，docked 吸附成右侧固定栏。
 * x/y 为 null 时表示「还没拖过」，继续沿用原来的贴右默认位置（随窗口自适应）。
 */
interface AiLayout {
  mode: 'floating' | 'docked';
  x: number | null;
  y: number | null;
  w: number;
  h: number | null;
  dockWidth: number;
}

const LAYOUT_KEY = 'strubrowser.aiPanel.layout';
const DEFAULT_LAYOUT: AiLayout = { mode: 'floating', x: null, y: null, w: 380, h: null, dockWidth: 400 };
/** 指针离窗口右边缘多近就开始吸附 */
const SNAP_EDGE = 72;
const DOCK_MIN = 320;
const DOCK_MAX = 760;
const DOCK_DEFAULT = 400;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function dockMaxWidth(): number {
  return Math.max(DOCK_MIN, Math.min(DOCK_MAX, Math.round(window.innerWidth * 0.72)));
}

/** 合成事件或部分浏览器没有活动指针时捕获会抛错，这里兜住，不影响拖动本身 */
function capturePointer(element: HTMLElement, pointerId: number): void {
  try {
    element.setPointerCapture(pointerId);
  } catch {
    /* 忽略 */
  }
}

function releasePointer(element: HTMLElement, pointerId: number): void {
  try {
    if (element.hasPointerCapture(pointerId)) element.releasePointerCapture(pointerId);
  } catch {
    /* 忽略 */
  }
}

function loadLayout(): AiLayout {
  try {
    const raw = window.localStorage.getItem(LAYOUT_KEY);
    if (!raw) return DEFAULT_LAYOUT;
    const parsed = JSON.parse(raw) as Partial<AiLayout>;
    return {
      mode: parsed.mode === 'docked' ? 'docked' : 'floating',
      x: typeof parsed.x === 'number' ? parsed.x : null,
      y: typeof parsed.y === 'number' ? parsed.y : null,
      w: typeof parsed.w === 'number' ? clamp(parsed.w, 300, 720) : DEFAULT_LAYOUT.w,
      h: typeof parsed.h === 'number' ? Math.max(260, parsed.h) : null,
      dockWidth: typeof parsed.dockWidth === 'number'
        ? clamp(parsed.dockWidth, DOCK_MIN, DOCK_MAX)
        : DOCK_DEFAULT,
    };
  } catch {
    return DEFAULT_LAYOUT;
  }
}

export default function AiPanel({
  projectId,
  projectName,
  canEdit,
  selectedIds,
  currentDocument,
  onClose,
  onApplied,
  onDockChange,
  viewport,
}: AiPanelProps) {
  const [status, setStatus] = useState<AiStatus | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  /** 出错时用户点「让 AI 修正」要发出去的那句话（只有能靠改参数解决的错误才给这个按钮） */
  const [fixPrompt, setFixPrompt] = useState('');
  const [statusError, setStatusError] = useState('');
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [attachError, setAttachError] = useState('');
  const [dropping, setDropping] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const [progress, setProgress] = useState<AiProgress | null>(null);
  const [now, setNow] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const traceRef = useRef<HTMLPreElement>(null);
  const progressRef = useRef<AiProgress | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  /** 用户点了停止：闭环里每一步都会查它（只 abort 当前请求不够，下一轮还会接着跑） */
  const stopRef = useRef(false);
  /** 最新一版项目文档：闭环会连续 apply，闭包里的 currentDocument 会过期，撤销基线用它 */
  const docRef = useRef(currentDocument);
  docRef.current = currentDocument;
  /** 最近一条助手气泡：自动应用成功后要把它的状态改成「已应用」 */
  const lastPlanRef = useRef<{ id: string; dbId: string | null } | null>(null);

  /* ---------- 会话（历史对话） ---------- */
  const [conversations, setConversations] = useState<AiConversationSummary[]>([]);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameText, setRenameText] = useState('');
  /** 最近一次请求的上下文占用：显示「12.4k / 128k」并按压力变色，提示该压缩了 */
  const [usage, setUsage] = useState<AiContextUsage | null>(null);
  const [compacting, setCompacting] = useState(false);
  /** 主模型能不能读图：能的话每次应用后自动附一张视口截图做视觉自检 */
  const canSeeImages = Boolean(status?.canSeeImages || status?.vision?.enabled);
  /** 同上，但给异步流程用：await 之后拿到的 state 是旧的，读 ref 才是刚刷新的结论 */
  const canSeeRef = useRef(canSeeImages);
  canSeeRef.current = canSeeImages;
  const [showView, setShowView] = useState(true);
  /** 自动应用：AI 改完立刻写进模型，才能自己转视角核对（关掉就只给建议，用户手动应用） */
  const [autoApply, setAutoApply] = useState(() => readUiBool(AUTO_APPLY_KEY, true));
  const conversationRef = useRef<string | null>(null);
  conversationRef.current = conversationId;

  /* ---------- 浮窗拖动 / 右侧停靠 ---------- */
  const panelRef = useRef<HTMLElement>(null);
  const [layout, setLayout] = useState<AiLayout>(loadLayout);
  const [dragging, setDragging] = useState(false);
  const [snapHint, setSnapHint] = useState(false);
  const [dockTop, setDockTop] = useState(62);
  const [dockHeight, setDockHeight] = useState<number | null>(() => Math.max(320, window.innerHeight - 93));
  const snapRef = useRef(false);
  const dragRef = useRef<{
    pointerId: number;
    grabX: number;
    grabY: number;
    width: number;
    height: number;
    fromDocked: boolean;
    startX: number;
  } | null>(null);
  const resizeRef = useRef<{ pointerId: number; startX: number; width: number } | null>(null);

  // 布局记忆：下次打开（含刷新）保持上次拖动/停靠的状态
  useEffect(() => {
    try {
      window.localStorage.setItem(LAYOUT_KEY, JSON.stringify(layout));
    } catch {
      /* 隐私模式禁用存储时忽略 */
    }
  }, [layout]);

  // 停靠时把宽度报给工作区，让视口让出这一条，而不是被面板盖住
  useEffect(() => {
    onDockChange?.(layout.mode === 'docked' ? layout.dockWidth : 0);
    return () => onDockChange?.(0);
  }, [layout.mode, layout.dockWidth, onDockChange]);

  // 停靠栏对齐工作区：顶到功能区下方、底到状态栏上方（改窗口或出现选项栏时跟随）
  useEffect(() => {
    if (layout.mode !== 'docked') return;
    const target = document.querySelector('.workspace');
    const measure = () => {
      if (!target) return;
      const rect = target.getBoundingClientRect();
      if (rect.height < 80) return;
      setDockTop(rect.top);
      setDockHeight(rect.height);
    };
    measure();
    const observer = target ? new ResizeObserver(measure) : null;
    if (target && observer) observer.observe(target);
    window.addEventListener('resize', measure);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, [layout.mode]);

  // 窗口变小后把浮窗拉回可视区
  useEffect(() => {
    const onResize = () => {
      setLayout((current) => {
        if (current.mode !== 'floating' || current.x === null || current.y === null) return current;
        const x = clamp(current.x, 8, Math.max(8, window.innerWidth - current.w - 8));
        const y = clamp(current.y, 8, Math.max(8, window.innerHeight - 80));
        return x === current.x && y === current.y ? current : { ...current, x, y };
      });
    };
    window.addEventListener('resize', onResize);
    onResize();
    return () => window.removeEventListener('resize', onResize);
  }, []);

  const setSnap = (value: boolean) => {
    if (snapRef.current === value) return;
    snapRef.current = value;
    setSnapHint(value);
  };

  const dock = () => {
    setSnap(false);
    setLayout((current) => ({ ...current, mode: 'docked' }));
  };

  /** 脱开固定栏：原地变成浮窗，宽度沿用停靠宽度 */
  const undock = () => {
    const rect = panelRef.current?.getBoundingClientRect();
    const width = layout.dockWidth;
    const height = rect?.height ?? Math.min(680, window.innerHeight - 140);
    setSnap(false);
    setLayout((current) => ({
      ...current,
      mode: 'floating',
      w: width,
      h: height,
      x: clamp(window.innerWidth - width - 96, 24, Math.max(24, window.innerWidth - width - 8)),
      y: clamp(rect?.top ?? 86, 56, Math.max(56, window.innerHeight - 120)),
    }));
  };

  const beginDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    if ((event.target as HTMLElement).closest('button')) return;
    const panel = panelRef.current;
    if (!panel) return;
    const rect = panel.getBoundingClientRect();
    event.preventDefault();
    capturePointer(event.currentTarget, event.pointerId);
    dragRef.current = {
      pointerId: event.pointerId,
      grabX: event.clientX - rect.left,
      grabY: event.clientY - rect.top,
      width: rect.width,
      height: rect.height,
      fromDocked: layout.mode === 'docked',
      startX: event.clientX,
    };
    setDragging(true);
  };

  const moveDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag) return;

    // 停靠状态：按住标题栏往左拉出一段距离，就地变成浮窗（继续跟手）
    if (drag.fromDocked) {
      if (drag.startX - event.clientX < 34) return;
      const rect = panelRef.current?.getBoundingClientRect();
      const grabX = rect ? event.clientX - rect.left : drag.grabX;
      const grabY = rect ? event.clientY - rect.top : drag.grabY;
      drag.fromDocked = false;
      drag.grabX = grabX;
      drag.grabY = grabY;
      if (rect) {
        drag.width = rect.width;
        drag.height = rect.height;
      }
      const width = drag.width;
      const height = drag.height;
      setLayout((current) => ({
        ...current,
        mode: 'floating',
        w: width,
        h: height,
        x: clamp(event.clientX - grabX, 8, Math.max(8, window.innerWidth - width - 8)),
        y: clamp(event.clientY - grabY, 8, Math.max(8, window.innerHeight - 80)),
      }));
      return;
    }

    const x = clamp(event.clientX - drag.grabX, 8, Math.max(8, window.innerWidth - drag.width - 8));
    const y = clamp(event.clientY - drag.grabY, 8, Math.max(8, window.innerHeight - 80));
    setSnap(event.clientX >= window.innerWidth - SNAP_EDGE);
    setLayout((current) => ({ ...current, mode: 'floating', x, y, w: drag.width, h: drag.height }));
  };

  const endDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    releasePointer(event.currentTarget, event.pointerId);
    const drag = dragRef.current;
    dragRef.current = null;
    setDragging(false);
    if (!drag) return;
    if (snapRef.current) dock();
  };

  const cancelDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    releasePointer(event.currentTarget, event.pointerId);
    dragRef.current = null;
    setDragging(false);
    setSnap(false);
  };

  const beginDockResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    capturePointer(event.currentTarget, event.pointerId);
    resizeRef.current = { pointerId: event.pointerId, startX: event.clientX, width: layout.dockWidth };
  };

  const moveDockResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    const start = resizeRef.current;
    if (!start) return;
    const width = clamp(Math.round(start.width + (start.startX - event.clientX)), DOCK_MIN, dockMaxWidth());
    setLayout((current) => (current.dockWidth === width ? current : { ...current, dockWidth: width }));
  };

  const endDockResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    releasePointer(event.currentTarget, event.pointerId);
    resizeRef.current = null;
  };

  const loadStatus = async (): Promise<AiStatus | null> => {
    try {
      const next = await aiApi.status();
      setStatus(next);
      setStatusError('');
      return next;
    } catch (caught) {
      const message = caught instanceof ApiError ? caught.message : '读取 AI 状态失败';
      setStatusError(/HTTP 500|HTTP 404|无法连接服务端/.test(message)
        ? `${message}`
        : message);
      return null;
    }
  };

  /**
   * 真的要用「读图」之前再确认一次能力。
   * status 只在面板挂载时读一次，而能力会变：管理员换了模型、勾了独立视觉模型、
   * 服务端升级后不再误判——页面开着不动就还是旧结论，于是明明能看图却跳过巡检。
   */
  const confirmCanSee = async (): Promise<boolean> => {
    if (canSeeRef.current) return true;
    const next = await loadStatus();
    const canSee = Boolean(next?.canSeeImages || next?.vision?.enabled);
    canSeeRef.current = canSee;
    return canSee;
  };

  useEffect(() => {
    void loadStatus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* ---------- 会话：列表 / 切换 / 新建 / 重命名 / 删除 ---------- */

  const rememberConversation = (id: string | null) => {
    try {
      if (id) window.localStorage.setItem(CONVERSATION_KEY(projectId), id);
      else window.localStorage.removeItem(CONVERSATION_KEY(projectId));
    } catch {
      /* 隐私模式禁用存储时忽略 */
    }
  };

  const openConversation = async (id: string) => {
    // 生成中切走会话，回来的结果会落到另一个会话的消息流里，直接挡住
    if (busy) return;
    try {
      const { conversation } = await aiApi.conversation(id);
      setConversationId(conversation.id);
      rememberConversation(conversation.id);
      setHistoryOpen(false);
      setMessages((conversation.messages ?? []).filter((item) => !item.internal).map(toChatMessage));
      // 打开历史会话时先给一个估算占用（服务端不调模型算的），否则用户不知道该不该压缩
      setUsage(conversation.usage ?? null);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : '读取会话失败');
    }
  };

  const startConversation = async (silent = false) => {
    try {
      const { conversation } = await aiApi.createConversation(projectId);
      setConversationId(conversation.id);
      rememberConversation(conversation.id);
      setMessages([]);
      setUsage(null);
      if (!silent) setHistoryOpen(false);
      setConversations((current) => [{
        id: conversation.id,
        projectId: conversation.projectId,
        title: conversation.title,
        createdAt: conversation.createdAt,
        updatedAt: conversation.updatedAt,
        messageCount: 0,
        preview: '',
        previewRole: null,
      }, ...current]);
    } catch {
      // 服务端没有会话接口（旧版本）：这次对话不落库，聊天本身照常可用
      setConversationId(null);
      rememberConversation(null);
      setMessages([]);
    }
  };

  /** 载入会话列表，并恢复上次停在哪个会话 */
  const loadConversations = async () => {
    setHistoryLoading(true);
    try {
      const { conversations: list } = await aiApi.conversations(projectId);
      setConversations(list);
      const remembered = readRememberedConversation(projectId);
      const target = list.find((item) => item.id === remembered) ?? list[0] ?? null;
      if (target) await openConversation(target.id);
      else await startConversation(true);
    } catch {
      // 旧服务端没有这个接口：chat 仍然可用，只是不落库
      setConversations([]);
    } finally {
      setHistoryLoading(false);
    }
  };

  useEffect(() => {
    void loadConversations();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  const removeConversation = async (id: string) => {
    try {
      await aiApi.deleteConversation(id);
      const rest = conversations.filter((item) => item.id !== id);
      setConversations(rest);
      if (conversationRef.current === id) {
        if (rest.length) await openConversation(rest[0].id);
        else await startConversation(true);
      }
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : '删除会话失败');
    }
  };

  const commitRename = async (id: string) => {
    const title = renameText.trim();
    setRenaming(null);
    if (!title) return;
    try {
      await aiApi.renameConversation(id, title);
      setConversations((current) => current.map((item) => (item.id === id ? { ...item, title } : item)));
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : '重命名失败');
    }
  };

  /**
   * 手动压缩上下文：把更早的消息压成一段备忘。
   * 自动压缩要攒够 18 条 / 6k token 才触发，用户想立刻腾空间就走这里；
   * 最近 6 条始终保留原文，所以「刚才说的」不会被压掉。
   */
  const compact = async () => {
    if (!conversationId || busy || compacting) return;
    setCompacting(true);
    setError('');
    try {
      const result = await aiApi.compactConversation(projectId, conversationId);
      if (result.usage) setUsage(result.usage);
      const note = result.compacted
        ? `已把 ${result.compacted} 条更早的消息压成 ${result.summary.length} 字备忘：`
          + `上下文 ${formatTokens(result.before)} → ${formatTokens(result.after)} tokens。`
          + (result.hasMore ? `还有 ${result.remaining} 条未压缩，可以再点一次。` : '最近几条保留原文。')
        : result.reason === 'too-small'
          ? '这段历史本身还短（不到 1k tokens），压成备忘省不下空间，等多聊几轮再压。'
          : '没有需要压缩的消息（最近几条会一直保留原文）。';
      setMessages((current) => [...current, { id: newId(), role: 'system', text: note }]);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : '压缩失败');
    } finally {
      setCompacting(false);
    }
  };

  useEffect(() => {
    const list = listRef.current;
    if (list) list.scrollTop = list.scrollHeight;
  }, [messages, busy]);

  // 生成计时：每秒刷新一次即可，不必每个 delta 都重渲染
  useEffect(() => {
    if (!busy) return;
    const timer = window.setInterval(() => setNow(Date.now()), 200);
    return () => window.clearInterval(timer);
  }, [busy]);

  // 思考过程自动跟到最新一行
  useEffect(() => {
    const trace = traceRef.current;
    if (trace) trace.scrollTop = trace.scrollHeight;
  }, [progress?.reasoning, progress?.content]);

  /**
   * 终止 AI：先立标记再 abort——abort 只掐掉当前这一轮请求，
   * 闭环的下一步、正在转的视角、还没发出的请求都靠这个标记停住。
   */
  const cancel = () => {
    stopRef.current = true;
    abortRef.current?.abort();
  };

  /**
   * 追加附件：图片走压缩，文本文件读成纯文本。超量 / 格式不支持都只提示，
   * 不打断已经加进去的那些（用户一次拖进来 5 个文件，能用的先收下）。
   */
  const addFiles = async (files: File[]) => {
    if (!files.length || busy) return;
    setAttachError('');
    let imageCount = attachments.filter((item) => item.kind === 'image').length;
    let textCount = attachments.filter((item) => item.kind === 'text').length;
    let textChars = attachments.reduce((sum, item) => sum + (item.text?.length ?? 0), 0);
    let total = attachments.length;
    const next: Attachment[] = [];
    const problems: string[] = [];
    for (const file of files) {
      if (total >= MAX_ATTACHMENTS) {
        problems.push(`一次最多 ${MAX_ATTACHMENTS} 个附件（其中图片 ${MAX_IMAGES} 张、文本 ${MAX_TEXT_FILES} 个）`);
        break;
      }
      try {
        if (file.type.startsWith('image/')) {
          if (imageCount >= MAX_IMAGES) {
            problems.push(`图片最多 ${MAX_IMAGES} 张`);
            continue;
          }
          next.push(await fileToAttachment(file));
          imageCount += 1;
          total += 1;
          continue;
        }
        if (!isTextFile(file)) {
          problems.push(`${file.name || '该文件'}：只能上传图片或文本文件（txt / md / json / csv / 代码…）`);
          continue;
        }
        if (textCount >= MAX_TEXT_FILES) {
          problems.push(`文本文件最多 ${MAX_TEXT_FILES} 个`);
          continue;
        }
        const item = await textToAttachment(file);
        const chars = item.text?.length ?? 0;
        if (textChars + chars > MAX_TEXT_TOTAL_CHARS) {
          problems.push(`文本附件合计最多 ${MAX_TEXT_TOTAL_CHARS / 1000}k 字，${item.name} 会让总量超限`);
          continue;
        }
        textChars += chars;
        textCount += 1;
        total += 1;
        next.push(item);
      } catch (caught) {
        problems.push(caught instanceof Error ? caught.message : '附件处理失败');
      }
    }
    if (next.length) setAttachments((current) => [...current, ...next].slice(0, MAX_ATTACHMENTS));
    if (problems.length) {
      setAttachError(problems[0] + (problems.length > 1 ? `（另有 ${problems.length - 1} 个没能加进来）` : ''));
    }
  };

  const removeAttachment = (id: string) => {
    setAttachments((current) => current.filter((item) => item.id !== id));
  };

  /**
   * 应用之后等一会儿再截图：几何（布尔合并）是在 React 提交后才重建的，
   * 立刻拍会拍到改之前的样子——那正是「改完说没改」的来源。
   */
  const settleAfterApply = () => new Promise<void>((resolve) => {
    window.requestAnimationFrame(() => window.requestAnimationFrame(() => window.setTimeout(resolve, 260)));
  });

  /** 进度卡片上的一句话：自检循环里要让人看出「第几步、在干什么」，而不是一直转圈 */
  const setPhase = (text: string) => {
    const current = progressRef.current;
    if (!current) return;
    current.phase = text;
    setProgress({ ...current });
  };

  /**
   * 一轮请求：首轮需求、自检回执、自动修正都走这里。
   * label 会拼进进度文案，让人知道现在是第几步。
   */
  const runRound = async (
    round: AgentRound,
    history: Array<{ role: string; content: string }>,
    label: string,
    internal = false,
  ) => {
    const startedAt = Date.now();
    const initial: AiProgress = {
      phase: `${label}${round.images.length || round.files.length ? '正在上传附件…' : '正在连接模型…'}`,
      reasoning: '',
      content: '',
      startedAt,
    };
    progressRef.current = initial;
    setProgress(initial);
    setNow(startedAt);
    const controller = new AbortController();
    abortRef.current = controller;
    let lastFlush = 0;
    const flush = (force = false) => {
      const current = progressRef.current;
      if (!current) return;
      const stamp = Date.now();
      if (!force && stamp - lastFlush < 120) return;
      lastFlush = stamp;
      setProgress({ ...current });
    };
    const plan = await aiApi.planStream(projectId, round.text, selectedIds, history, {
      signal: controller.signal,
      onEvent: (event) => {
        const current = progressRef.current;
        if (!current) return;
        switch (event.type) {
          case 'start':
            current.phase = round.images.length
              ? `${label}${event.model || '模型'} 已接收 ${round.images.length} 张图片…`
              : round.files.length
                ? `${label}${event.model || '模型'} 已接收 ${round.files.length} 个附件…`
                : `${label}${event.model || '模型'} 已接收，正在思考…`;
            break;
          case 'status':
            current.phase = `${label}${event.text}`;
            break;
          case 'vision':
            current.phase = `${label}识别到${event.object ? `「${event.object}」` : '图片内容'}（${event.parts} 个零件），正在生成特征树…`;
            break;
          case 'reasoning':
            current.reasoning = tail(current.reasoning + event.delta, 6000);
            break;
          case 'content':
            current.content = tail(current.content + event.delta, 6000);
            break;
          case 'tool':
            current.phase = `${label}正在生成特征树参数…`;
            break;
          case 'plan':
            current.phase = `${label}正在生成特征树参数（已 ${event.chars} 字符）…`;
            break;
          default:
            return;
        }
        flush();
      },
    }, round.images, {
      conversationId: conversationRef.current,
      imageThumbs: round.thumbs,
      imageShots: round.shots,
      attachments: round.files,
      // 自检回执不当作对话框里的用户发言（仍进上下文）
      internal,
    });
    flush(true);
    return plan;
  };

  /** 结果落成气泡，并同步会话列表（服务端可能刚给会话起了标题） */
  const pushPlan = (plan: AiPlan, step = 0) => {
    // 服务端按预算分配后的真实占用：压缩后这里会立刻变小
    if (plan.context) setUsage(plan.context);
    if (plan.conversationId) {
      conversationRef.current = plan.conversationId;
      setConversationId((current) => current ?? plan.conversationId ?? current);
      setConversations((current) => {
        const exists = current.some((item) => item.id === plan.conversationId);
        return exists
          ? current.map((item) => (item.id === plan.conversationId ? { ...item, preview: plan.reply || item.preview } : item))
          : current;
      });
      void aiApi.conversations(projectId)
        .then(({ conversations: list }) => setConversations(list))
        .catch(() => { /* 列表刷新失败不影响对话 */ });
    }
    const id = newId();
    lastPlanRef.current = { id, dbId: plan.messageId ?? null };
    setMessages((current) => [...current, {
      id,
      dbId: plan.messageId ?? undefined,
      role: 'assistant',
      text: plan.reply || '（模型没有给出说明）',
      ops: plan.ops,
      summary: plan.summary,
      mock: plan.mock,
      ms: plan.ms,
      repaired: plan.repaired,
      warning: plan.warning,
      vision: plan.vision ?? null,
      step: step > 1 ? step : undefined,
      done: plan.done,
    }]);
  };

  /** 这一轮的指令已经自己落地了：把气泡从「待应用」改成「已应用」 */
  const markLastApplied = (rev: number) => {
    const last = lastPlanRef.current;
    if (!last) return;
    setMessages((current) => current.map((item) => (
      item.id === last.id ? { ...item, applied: true, appliedRev: rev } : item
    )));
  };

  /**
   * 把指令写进模型（自检闭环与「应用到模型」按钮共用）。
   * 撤销基线用 docRef 而不是闭包里的 currentDocument：闭环里会连续 apply，props 还没跟上。
   */
  const applyOps = async (ops: Array<Record<string, unknown>>, messageId?: string | null) => {
    const previous = docRef.current;
    const result = await aiApi.apply(projectId, ops, 'AI 自检闭环');
    onApplied(result.document, result.rev, previous);
    docRef.current = result.document;
    if (conversationRef.current && messageId) {
      void aiApi.markApplied(conversationRef.current, messageId, result.rev).catch(() => {
        /* 只是历史里的标记，失败不影响这次应用 */
      });
    }
    return { rev: result.rev, count: result.applied.length };
  };

  /**
   * 替 AI 转动视口：按它要的视角逐个切过去、等一帧、截图。
   * 这是「AI 操作软件」的那一半——它能自己换角度看清模型，而不是只凭数字猜。
   * 截完把相机放回用户原来的角度，别让人回来后找不到北。
   */
  const inspectViews = async (views?: AiInspectView[], label = ''): Promise<AgentShot[]> => {
    const list = Array.isArray(views) ? views.slice(0, MAX_IMAGES) : [];
    if (!list.length || !viewport) return [];
    if (!(await confirmCanSee())) {
      setMessages((current) => [...current, {
        id: newId(),
        role: 'system',
        text: 'AI 想先看一眼当前模型，但当前模型不能读图（刚重新确认过）。已跳过视角巡检；'
          + '需要它自己转着看，请在「用户与系统 → AI 设置」启用独立视觉模型（或换一个多模态主模型）。',
      }]);
      return [];
    }
    const before = viewport.camera();
    setPhase(`${label}AI 要转视角看图：${list.map((view) => view.label).join(' / ')}…`);
    const shots: AgentShot[] = [];
    let blankViews = 0;
    for (const view of list) {
      // 每张图之前都看一眼停止标记：用户点了停止就别再转视角了
      if (stopRef.current) break;
      const ok = await viewport.look({
        view: view.view,
        azimuth: view.azimuth,
        elevation: view.elevation,
        focus: view.focus,
        zoom: view.zoom,
      });
      if (!ok) continue;
      // 视角是瞬时摆位的，但画面在下一帧才重绘；后台标签页里 rAF 不跑，加超时兜底
      await new Promise<void>((resolve) => {
        let done = false;
        const finish = () => {
          if (done) return;
          done = true;
          resolve();
        };
        window.requestAnimationFrame(() => window.requestAnimationFrame(finish));
        window.setTimeout(finish, 400);
      });
      const raw = viewport.capture();
      if (!raw) continue;
      try {
        const dataUrl = await shrinkDataUrl(raw, 1024, 0.72);
        // 空场景截出来是一整张纯色：发给模型只会让它瞎猜，直接跳过
        if (await isBlankDataUrl(dataUrl)) {
          blankViews += 1;
          continue;
        }
        const thumb = await shrinkDataUrl(dataUrl, 200, 0.6);
        shots.push({ label: view.label, dataUrl, thumb });
      } catch {
        // 压缩失败就跳过这一张，别让整轮巡检挂掉
      }
    }
    if (before) {
      void viewport.look({ azimuth: before.azimuth, elevation: before.elevation }).catch(() => {
        /* 恢复不了就保持当前角度，不影响后续操作 */
      });
    }
    if (!shots.length && blankViews) {
      setMessages((current) => [...current, {
        id: newId(),
        role: 'system',
        text: '视口里还是空的（或还没渲染出来），没有可看的画面，已跳过这次视角巡检。',
      }]);
    }
    if (shots.length) {
      setMessages((current) => [...current, {
        id: newId(),
        role: 'system',
        text: `第 ${label ? label.replace(/^自检第 /, '').replace(/ 步 · $/, '') : ''}${label ? ' 步：' : ''}AI 自己转了视角并截图：${shots.map((shot) => shot.label).join(' / ')}`
          + `${shots.length < list.length ? `（${list.length - shots.length} 个视角没截到，已跳过）` : ''}`,
        views: shots.map((shot) => ({ label: shot.label, dataUrl: shot.dataUrl })),
      }]);
    }
    return shots;
  };

  /** 闭环怎么结束的：一句话交代清楚，别让用户猜「它是不是停了」 */
  const agentNote = (run: AgentRun): string => {
    const tally = `${run.steps} 步、${run.applied} 次修改${run.shots ? `、${run.shots} 张截图` : ''}`;
    switch (run.reason) {
      case 'done':
        return `✓ 自检完成（${tally}）：AI 看图核对后认为已满足需求。可在视口里自己再转一圈确认。`;
      case 'max-steps':
        return `已跑满 ${run.steps} 步还没收敛，先停在这里。回复「继续」可以接着改。`;
      case 'repeated':
        return `AI 反复要同样的视角却没有新的修改，已停下避免空转（${tally}）。`;
      case 'inspect-failed':
        return '视口里没有可看的画面（还没建构件 / 还没渲染完），这次自检跳过了。';
      case 'stopped':
        return `已停止（第 ${run.steps} 步）。已经应用的修改可以 Ctrl/Cmd+Z 撤销。`;
      default:
        return '';
    }
  };

  const send = async (text?: string) => {
    const typed = (text ?? input).trim();
    const pickedImages = attachments.filter((item) => item.kind === 'image');
    const userImages = pickedImages.map((item) => item.dataUrl).filter((value): value is string => Boolean(value));
    const userThumbs = pickedImages.map((item) => item.thumb).filter((value): value is string => Boolean(value));
    const userFiles = attachments
      .filter((item) => item.kind === 'text' && item.text)
      .map((item) => ({ name: item.name, text: item.text ?? '', truncated: item.truncated }));
    // 允许「只发图 / 只给文件不写字」：服务端会补一句默认需求
    const content = typed
      || (userImages.length ? '请参照这张图片把这个产品建出来（尺寸按图上比例估算）。' : '')
      || (userFiles.length ? '请参考这几个附件里的内容，把模型建出来。' : '');
    if (!content || busy) return;
    setBusy(true);
    stopRef.current = false;

    // 现截当前视口一起发过去：模型能看着自己刚做出来的东西判断「像不像」再改。
    // 项目里一个构件都没有就没什么好看的：直接跳过，省掉一次截图（也省掉气泡里一张黑图）。
    // 截图前再确认一次读图能力：面板挂了一整天，能力可能早就被改过（换模型 / 开视觉模型）。
    const canSee = await confirmCanSee();
    const hasGeometry = Array.isArray(currentDocument?.elements) && currentDocument.elements.length > 0;
    let shot: string | null = null;
    if (showView && canSee && hasGeometry) {
      try {
        const raw = viewport?.capture() ?? null;
        const shrunk = raw ? await shrinkDataUrl(raw, 1024, 0.72) : null;
        shot = shrunk && !(await isBlankDataUrl(shrunk)) ? shrunk : null;
      } catch {
        shot = null;
      }
    }
    // 截图排在用户参考图之后，同样受 4 张上限约束
    const includeShot = Boolean(shot) && userImages.length < MAX_IMAGES;
    const images = includeShot && shot ? [...userImages, shot] : userImages;
    // 缩略图也一起存：历史会话里还能看到「当时它看到的是什么」，只是折成一条小提示
    const shotThumb = includeShot && shot ? await shrinkDataUrl(shot, 200, 0.66).catch(() => null) : null;
    const storedThumbs = shotThumb ? [...userThumbs, shotThumb] : userThumbs;
    // 告诉模型最后那张图不是参考图，而是它自己刚做出来的东西
    const serverMessage = includeShot ? `${content}\n${SHOT_MARKER}` : content;

    setInput('');
    setAttachments([]);
    setAttachError('');
    setError('');
    setFixPrompt('');
    const userMessage: ChatMessage = {
      id: newId(),
      role: 'user',
      text: content,
      images: userImages.length ? userImages : undefined,
      files: userFiles.length ? userFiles : undefined,
      shot: includeShot ? shot ?? undefined : undefined,
    };
    setMessages((current) => [...current, userMessage]);

    // 无会话时退回「前端自带 history」的旧行为；有会话时以库里记录为准
    const history = [...messages, userMessage]
      .filter((message) => message.role !== 'system')
      .slice(-6)
      .map((message) => ({ role: message.role, content: message.text }));
    let roundNo = 0;

    try {
      const firstRound: AgentRound = {
        text: serverMessage,
        images,
        thumbs: storedThumbs,
        files: userFiles,
        shots: shotThumb ? 1 : 0,
      };

      // 关了「自动应用」或没有写权限就退化成单轮建议：只给指令，由用户自己点「应用到模型」
      // （viewer 自动应用会 403，闭环只会把「没权限」当成模型改错了，白跑几轮）
      if (!autoApply || !canEdit) {
        roundNo = 1;
        pushPlan(await runRound(firstRound, history, ''), 0);
        return;
      }

      const run = await runAgentLoop(firstRound, {
        goal: content,
        plan: async (round) => {
          roundNo += 1;
          const label = roundNo > 1 ? `自检第 ${roundNo}/${MAX_AGENT_STEPS} 步 · ` : '';
          const plan = await runRound(round, roundNo === 1 ? history : [], label, roundNo > 1);
          pushPlan(plan, roundNo);
          return plan;
        },
        apply: async (ops) => {
          setPhase(`第 ${roundNo} 步：正在把修改写进模型…`);
          const result = await applyOps(ops, lastPlanRef.current?.dbId);
          markLastApplied(result.rev);
          // 让几何重建完再交回闭环：下一张截图必须反映这次修改
          await settleAfterApply();
          return { note: `已应用 ${result.count} 条指令（rev ${result.rev}）` };
        },
        inspect: (views) => inspectViews(views, `自检第 ${roundNo}/${MAX_AGENT_STEPS} 步 · `),
        stopped: () => stopRef.current,
        onStage: (stage) => {
          if (stage.type === 'apply-failed') {
            setPhase(`第 ${stage.step} 步：参数被服务端拒绝，让 AI 自己改…`);
          } else if (stage.type === 'inspect') {
            setPhase(`第 ${stage.step} 步：截到 ${stage.shots} 张图，正在判断…`);
          }
        },
      });
      const note = agentNote(run);
      if (note) setMessages((current) => [...current, { id: newId(), role: 'system', text: note }]);
    } catch (caught) {
      const message = caught instanceof ApiError ? caught.message : 'AI 调用失败';
      if (message.includes('已停止生成') || stopRef.current) {
        setMessages((current) => [...current, {
          id: newId(),
          role: 'system',
          text: roundNo > 1 ? `已停止（第 ${roundNo} 步）。已经应用的修改可以 Ctrl/Cmd+Z 撤销。` : '已停止生成。',
        }]);
      } else {
        setError(message);
      }
    } finally {
      progressRef.current = null;
      setProgress(null);
      abortRef.current = null;
      stopRef.current = false;
      setBusy(false);
    }
  };

  const apply = async (message: ChatMessage) => {
    if (!message.ops?.length || busy) return;
    setBusy(true);
    setError('');
    try {
      const result = await applyOps(message.ops, message.dbId);
      setMessages((current) => current.map((item) => (
        item.id === message.id ? { ...item, applied: true, appliedRev: result.rev } : item
      )).concat({
        id: newId(),
        role: 'system',
        text: `已应用 ${result.count} 条指令，生成 rev ${result.rev}。可以用 Ctrl/Cmd+Z 撤销。`,
      }));
    } catch (caught) {
      const message2 = caught instanceof ApiError ? caught.message : '应用失败';
      setError(message2);
      // 4xx 是服务端校验拒绝（改参数就能过），让用户一键把它交回模型自己修；
      // 网络/服务端故障则不给，问了也没用。
      if (caught instanceof ApiError && caught.status >= 400) {
        setFixPrompt(`上一次生成的建模指令在应用时被校验拒绝：${message2}\n请修正后重新输出完整的 reply + ops。`);
      }
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
  const currentConversation = conversations.find((item) => item.id === conversationId) ?? null;
  /** 上下文压力：65% 起提示、85% 起告警（这时候该点「压缩」了） */
  const usagePercent = usage && usage.window
    ? Math.min(100, Math.round((usage.tokens / usage.window) * 100))
    : 0;

  const elapsed = progress ? Math.max(0, (now - progress.startedAt) / 1000) : 0;
  const elapsedText = elapsed >= 60
    ? `${Math.floor(elapsed / 60)}:${String(Math.floor(elapsed % 60)).padStart(2, '0')}`
    : `${Math.floor(elapsed)}s`;

  const docked = layout.mode === 'docked';
  const panelStyle: CSSProperties = docked
    ? { top: dockTop, height: dockHeight ?? undefined, width: layout.dockWidth }
    : layout.x !== null && layout.y !== null
      ? { left: layout.x, top: layout.y, width: layout.w, height: layout.h ?? undefined }
      : {};
  const panelClass = [
    'ai-panel',
    docked ? 'docked' : 'floating',
    !docked && layout.x === null ? 'anchored' : '',
    dragging ? 'dragging' : '',
  ].filter(Boolean).join(' ');

  return (
    <>
      {snapHint ? (
        <div className="ai-dock-hint" aria-hidden>
          <span>松开 · 吸附到右侧固定栏</span>
        </div>
      ) : null}
      <aside ref={panelRef} className={panelClass} style={panelStyle} aria-label="AI 助手">
        <header className="ai-head">
          <div
            className="ai-head-drag"
            onPointerDown={beginDrag}
            onPointerMove={moveDrag}
            onPointerUp={endDrag}
            onPointerCancel={cancelDrag}
            onDoubleClick={docked ? undock : dock}
            title={docked ? '向左拖出可恢复为浮动窗口，双击脱离' : '拖动移动，拖到窗口右边缘自动吸附（双击吸附）'}
          >
            <strong>AI 助手</strong>
            <span>{projectName} · {statusText}</span>
          </div>
          <div className="ai-head-actions">
            <button
              type="button"
              className="ai-icon-btn"
              onClick={docked ? undock : dock}
              title={docked ? '脱离为浮动窗口（也可直接向左拖出）' : '吸附到右侧固定栏'}
              aria-label={docked ? '脱离为浮动窗口' : '吸附到右侧固定栏'}
            >
              {docked ? '⇱' : '⇥'}
            </button>
            <button className="ai-close" onClick={onClose} aria-label="关闭 AI 助手">✕</button>
          </div>
        </header>

        {/* 会话条：当前会话 + 历史入口（关掉面板、刷新、换设备都能接着聊） */}
        <div className="ai-session">
          <button
            type="button"
            className={`ai-session-current ${historyOpen ? 'open' : ''}`}
            onClick={() => setHistoryOpen((value) => !value)}
            title="查看历史会话"
          >
            <span className="ai-session-title">{currentConversation?.title || (conversationId ? '新会话' : '本次对话不落库')}</span>
            <em>{conversationId ? `${currentConversation?.messageCount ?? messages.length} 条消息` : '服务端不支持历史'}</em>
            <i aria-hidden>{historyOpen ? '▴' : '▾'}</i>
          </button>
          {/* 上下文占用：超过 65% 变黄、85% 变红，点击等于压缩 */}
          {usage && usage.window ? (
            <button
              type="button"
              className={`ai-usage ${usagePercent >= 85 ? 'danger' : usagePercent >= 65 ? 'warn' : ''}`}
              title={`${usageTitle(usage)}\n\n点击压缩更早的对话（保留最近 6 条原文）`}
              onClick={() => void compact()}
              disabled={!conversationId || busy || compacting || Boolean(status?.mock)}
            >
              {formatTokens(usage.tokens)} / {formatTokens(usage.window)}
            </button>
          ) : null}
          <button
            type="button"
            className="ai-session-new"
            onClick={() => void startConversation()}
            disabled={busy}
            title="新建会话（当前会话保留在历史里）"
            aria-label="新建会话"
          >
            ＋
          </button>
          <button
            type="button"
            className="ai-session-compact"
            onClick={() => void compact()}
            disabled={!conversationId || busy || compacting || Boolean(status?.mock)}
            title={status?.mock
              ? 'Mock 模式没有可用的摘要模型，压缩需要先在 AI 设置里配置真实模型'
              : '把更早的对话压成一段技术备忘：保留目标、关键尺寸、已完成的修改与未决问题，最近 6 条保留原文'}
          >
            {compacting ? '压缩中…' : '压缩'}
          </button>
        </div>

        {historyOpen ? (
          <div className="ai-session-list">
            <div className="ai-session-list-head">
              <span>历史会话</span>
              <button type="button" onClick={() => setHistoryOpen(false)}>收起</button>
            </div>
            {historyLoading ? <div className="ai-session-empty">加载中…</div> : null}
            {!historyLoading && !conversations.length ? <div className="ai-session-empty">还没有历史会话</div> : null}
            {conversations.map((item) => (
              <div className={`ai-session-item ${item.id === conversationId ? 'active' : ''}`} key={item.id}>
                {renaming === item.id ? (
                  <input
                    className="ai-session-rename"
                    autoFocus
                    value={renameText}
                    onChange={(event) => setRenameText(event.target.value)}
                    onBlur={() => void commitRename(item.id)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') {
                        event.preventDefault();
                        void commitRename(item.id);
                      }
                      if (event.key === 'Escape') setRenaming(null);
                    }}
                  />
                ) : (
                  <button
                    type="button"
                    className="ai-session-open"
                    onClick={() => void openConversation(item.id)}
                    title={item.preview || item.title || '新会话'}
                  >
                    <strong>{item.title || '新会话'}</strong>
                    <span>{item.preview || '（还没有消息）'}</span>
                    <em>{formatWhen(item.updatedAt)} · {item.messageCount} 条</em>
                  </button>
                )}
                <div className="ai-session-actions">
                  <button
                    type="button"
                    onClick={() => {
                      setRenaming(item.id);
                      setRenameText(item.title ?? '');
                    }}
                    title="重命名"
                    aria-label="重命名会话"
                  >
                    ✎
                  </button>
                  <button type="button" onClick={() => void removeConversation(item.id)} title="删除会话" aria-label="删除会话">✕</button>
                </div>
              </div>
            ))}
          </div>
        ) : null}

        {docked ? (
          <div
            className="ai-dock-resizer"
            role="separator"
            aria-orientation="vertical"
            aria-label="调整 AI 面板宽度"
            title="拖动调整宽度"
            onPointerDown={beginDockResize}
            onPointerMove={moveDockResize}
            onPointerUp={endDockResize}
            onPointerCancel={endDockResize}
          />
        ) : null}

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
            <span>AI 直接生成结构化指令：建筑构件（墙/板/柱）或任意造型的特征树（拉伸 / 旋转 / 放样 / 扫掠 / 阵列 / 布尔）。确认后才会写入项目。</span>
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
              {message.images?.length ? (
                <div className="ai-bubble-images">
                  {message.images.map((src, index) => (
                    <img
                      key={`${message.id}-img-${index}`}
                      src={src}
                      alt={`参考图 ${index + 1}`}
                      title={`参考图 ${index + 1}`}
                    />
                  ))}
                </div>
              ) : null}
              {message.files?.length ? (
                <div className="ai-bubble-files">
                  {message.files.map((file, index) => (
                    <details className="ai-bubble-file" key={`${message.id}-file-${index}`}>
                      <summary title={file.name}>
                        <span aria-hidden>▤</span>
                        <strong>{file.name}</strong>
                        <em>{file.text.length.toLocaleString()} 字{file.truncated ? '（已截断）' : ''}</em>
                      </summary>
                      <pre>{file.text.slice(0, 4000)}</pre>
                    </details>
                  ))}
                </div>
              ) : null}
              <p>{message.text}</p>
              {message.shot || message.shotNote ? (
                <div className="ai-bubble-shot" title="发送时自动附上的当前视口截图：给模型看它自己刚做出来的东西，不算你的参考图">
                  {message.shot ? <img src={message.shot} alt="当前视图" /> : null}
                  <span>{message.shot ? '已附当前视图' : '当时附了视图截图（未留存）'}</span>
                </div>
              ) : null}
              {message.views?.length ? (
                <div className="ai-bubble-views">
                  {message.views.map((view, index) => (
                    <figure key={`${message.id}-view-${index}`}>
                      <img src={view.dataUrl} alt={view.label} title={view.label} />
                      <figcaption>{view.label}</figcaption>
                    </figure>
                  ))}
                </div>
              ) : null}
              {message.vision?.object || message.vision?.model ? (
                <div className="ai-vision-note">
                  读图：{message.vision?.model ?? '视觉模型'}
                  {message.vision?.object ? ` · 识别为「${message.vision.object}」` : ''}
                  {message.vision?.parts ? ` · ${message.vision.parts} 个零件` : ''}
                </div>
              ) : null}
              {message.ops?.length ? (
                <div className="ai-ops">
                  <div className="ai-op-summary">
                    {Object.entries(message.summary ?? {}).map(([label, count]) => (
                      <span key={label}>{label} × {count}</span>
                    ))}
                    {message.ms ? <span>{(message.ms / 1000).toFixed(1)}s</span> : null}
                    {message.mock ? <em>Mock</em> : null}
                    {message.repaired ? <span title="服务端预校验发现参数越界，已让模型改好">已自动修正参数</span> : null}
                    {message.step ? <em title="自检闭环的第几步">{`自检 ${message.step}`}</em> : null}
                    {message.done ? <span title="AI 看图核对后认为已满足需求">已核对</span> : null}
                  </div>
                  <details>
                    <summary>查看 {message.ops.length} 条指令</summary>
                    <pre>{JSON.stringify(message.ops, null, 2).slice(0, 4000)}</pre>
                  </details>
                  {message.warning ? (
                    <div className="ai-warning">
                      <span>{message.warning}</span>
                      <button
                        disabled={busy}
                        onClick={() => void send(`${message.warning}\n请按上面的提示修正后重新输出完整的 reply + ops。`)}
                      >
                        让 AI 修正
                      </button>
                    </div>
                  ) : null}
                  {message.applied ? (
                    <div className="ai-applied">
                      已应用到模型{message.appliedRev ? `（rev ${message.appliedRev}）` : ''}
                    </div>
                  ) : (
                    <div className="ai-op-actions">
                      <button
                        className="primary"
                        disabled={!canEdit || busy || Boolean(message.warning)}
                        title={message.warning
                          ? '参数未通过校验，先点「让 AI 修正」'
                          : canEdit ? '写入模型（可撤销）' : '查看者不能修改模型'}
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

        {busy ? (
          <div className="ai-progress" role="status" aria-live="polite">
            <div className="ai-progress-head">
              <span className="ai-pulse" aria-hidden />
              <span className="ai-progress-phase">{progress?.phase ?? 'AI 正在思考…'}</span>
              <em className="ai-progress-time">{elapsedText}</em>
              <button type="button" className="ai-cancel" onClick={cancel}>停止</button>
            </div>
            {progress?.reasoning ? (
              <details className="ai-trace" open>
                <summary>思考过程 · {progress.reasoning.length} 字</summary>
                <pre ref={traceRef}>{progress.reasoning}</pre>
              </details>
            ) : null}
            {progress?.content ? (
              <details className="ai-trace" open>
                <summary>输出草稿</summary>
                <pre>{progress.content.slice(-1200)}</pre>
              </details>
            ) : null}
          </div>
        ) : null}
      </div>

      {error ? (
        <div className="ai-error">
          <span>{error}</span>
          {fixPrompt && canEdit ? (
            <button type="button" disabled={busy} onClick={() => void send(fixPrompt)}>让 AI 修正</button>
          ) : null}
          <button type="button" className="ai-error-dismiss" onClick={() => { setError(''); setFixPrompt(''); }} aria-label="关闭提示">✕</button>
        </div>
      ) : null}

      <form
        className={`ai-input ${dropping ? 'dropping' : ''}`}
        onSubmit={(event) => {
          event.preventDefault();
          void send();
        }}
        onDragOver={(event) => {
          if (!event.dataTransfer?.types?.includes('Files')) return;
          event.preventDefault();
          setDropping(true);
        }}
        onDragLeave={(event) => {
          if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
          setDropping(false);
        }}
        onDrop={(event) => {
          event.preventDefault();
          setDropping(false);
          void addFiles(Array.from(event.dataTransfer?.files ?? []));
        }}
      >
        {attachments.length || dropping ? (
          <div className="ai-attach-strip">
            {attachments.map((item) => (item.kind === 'image' ? (
              <div className="ai-attach-item" key={item.id} title={`${item.name} · ${formatBytes(item.bytes)}`}>
                <img src={item.dataUrl} alt={item.name} />
                <button
                  type="button"
                  className="ai-attach-remove"
                  onClick={() => removeAttachment(item.id)}
                  aria-label={`移除 ${item.name}`}
                >
                  ✕
                </button>
              </div>
            ) : (
              <div className="ai-attach-file" key={item.id} title={item.text?.slice(0, 300) ?? ''}>
                <span aria-hidden>▤</span>
                <strong>{item.name}</strong>
                <em>{formatBytes(item.bytes)}{item.truncated ? ' · 已截断' : ''}</em>
                <button
                  type="button"
                  onClick={() => removeAttachment(item.id)}
                  aria-label={`移除 ${item.name}`}
                >
                  ✕
                </button>
              </div>
            )))}
            {dropping ? <div className="ai-attach-hint">松开即可添加图片或文本文件</div> : null}
          </div>
        ) : null}

        <div className="ai-input-row">
          <button
            type="button"
            className="ai-attach-btn"
            disabled={busy || attachments.length >= MAX_ATTACHMENTS}
            title="添加图片或文本文件（也可以直接粘贴、拖进来）。文本文件的内容会作为参考资料一起发给 AI"
            aria-label="添加图片或文本文件"
            onClick={() => fileRef.current?.click()}
          >
            ＋
          </button>
          <textarea
            value={input}
            rows={2}
            placeholder="描述需求，或粘贴 / 拖入图片、文本文件让 AI 照着建模"
            onChange={(event) => setInput(event.target.value)}
            onPaste={(event) => {
              const files = Array.from(event.clipboardData?.files ?? []).filter(
                (file) => file.type.startsWith('image/') || isTextFile(file),
              );
              if (!files.length) return;
              // 粘贴图片时不要把剪贴板里的文件名也塞进输入框
              event.preventDefault();
              void addFiles(files);
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                void send();
              }
            }}
          />
          {busy ? (
            <button type="button" className="ai-send-stop" onClick={cancel} title="停止 AI：当前这一轮和后续自检都会停下">
              停止
            </button>
          ) : (
            <button type="submit" disabled={!input.trim() && !attachments.length}>发送</button>
          )}
        </div>

        {attachError ? <div className="ai-attach-error">{attachError}</div> : null}
        <input
          ref={fileRef}
          type="file"
          accept="image/*,text/*,.md,.markdown,.json,.csv,.tsv,.log,.yml,.yaml,.xml,.ini,.toml,.txt,.sql,.py,.js,.mjs,.ts,.tsx,.jsx,.html,.css,.sh"
          multiple
          hidden
          onChange={(event) => {
            const files = Array.from(event.target.files ?? []);
            event.target.value = '';
            void addFiles(files);
          }}
        />
      </form>

      <div className="ai-foot">
        <div className="ai-foot-toggles">
        <label
          className="ai-see-toggle"
          title="打开后：AI 改完立刻写进模型，然后自己转视角截图核对，不满意继续改，直到它认为满足需求才停（可随时点「停止」）。关掉则只给指令，由你手动应用"
        >
          <input
            type="checkbox"
            checked={autoApply && canEdit}
            disabled={!canEdit}
            onChange={(event) => {
              setAutoApply(event.target.checked);
              writeUiBool(AUTO_APPLY_KEY, event.target.checked);
            }}
          />
          <span>自动改并自检</span>
        </label>
        <label
          className="ai-see-toggle"
          title={canSeeImages
            ? '发送时自动截取当前视口一起发给模型；AI 也可以自己要求换视角（转着看）再改'
            : '当前模型不能读图：到「AI 设置」勾选独立视觉模型后可用'}
        >
          <input
            type="checkbox"
            checked={showView && canSeeImages}
            disabled={!canSeeImages}
            onChange={(event) => setShowView(event.target.checked)}
          />
          <span>让 AI 看当前模型</span>
          {!canSeeImages ? <em>（需要能读图的模型）</em> : null}
        </label>
        </div>
        <button
          type="button"
          className="ai-inspect-btn"
          disabled={busy || !canSeeImages}
          title={canSeeImages
            ? '让 AI 自己把视图转一圈（前视 / 右视 / 等轴测）看一遍，发现问题直接改，改完再换角度复核，直到它认为没问题'
            : '需要能读图的模型'}
          onClick={() => void send('把模型转一圈看看（前视、右视、等轴测），检查比例、朝向、零件是否对齐与穿模；'
            + '有问题自己改，改完再转视角复核，直到满足我的要求再停。')}
        >
          转一圈检查
        </button>
        <span>AI 只输出结构化建模指令，服务端校验通过才落库；每次修改都是一个 rev，可 Ctrl/Cmd+Z 撤销。</span>
      </div>
      </aside>
    </>
  );
}
