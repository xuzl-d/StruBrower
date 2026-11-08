import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { DragEvent as ReactDragEvent } from 'react';
import { BufferGeometry, Float32BufferAttribute, Vector3 } from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import ModelViewport from './ModelViewport';
import type { Tool, ViewKind, ViewLookRequest, ViewportApi } from './ModelViewport';
import Ribbon from './components/Ribbon';
import type { RibbonTab } from './components/Ribbon';
import ProjectBrowser from './components/ProjectBrowser';
import PropertiesPanel from './components/PropertiesPanel';
import AuthGate from './components/AuthGate';
import VersionsDialog from './components/VersionsDialog';
import MembersDialog from './components/MembersDialog';
import SolidDialog from './components/SolidDialog';
import LibraryDialog from './components/LibraryDialog';
import AiPanel from './components/AiPanel';
import AccountCenter from './components/account/AccountCenter';
import type { AccountSection } from './components/account/AccountCenter';
import PanelResizer from './components/PanelResizer';
import ModifyOptionsBar from './components/ModifyOptionsBar';
import DrawCoordinateBar from './components/DrawCoordinateBar';
import ScheduleDialog from './components/ScheduleDialog';
import ImportDialog from './components/ImportDialog';
import { buildImportGeometry, countImportTriangles, disposeParts, formatForFile, parseModelBuffer, IMPORT_FORMATS } from './import';
import type { ImportedModel, ImportTransform } from './import';
import LayersDialog from './components/LayersDialog';
import MaterialsDialog from './components/MaterialsDialog';
import ParametersDialog from './components/ParametersDialog';
import { countTriangles, levelById } from './bim/document';
import type { ProjectSummary } from './bim/document';
import { booleanElement, exportObj, meshElementFromGeometry } from './bim/geometry';
import { duplicateElements, translateElement } from './bim/edit';
import { exportIfc } from './bim/ifc';
import { DEFAULT_LAYER_ID, ensureDocumentLayers, isElementLocked } from './bim/layers';
import {
  ensureDocumentParameters, recomputeParameters, setElementFormula, setTypeFormula,
} from './bim/parameters';
import {
  IMMEDIATE_COMMANDS, MODIFY_LABELS, MODIFY_SHORTCUTS,
  advanceModify, createModifySession, finishModify, immediateModify, isReady,
  modifyPrompt, stepBack, withSelection,
} from './bim/modify';
import type { ModifyClick, ModifyCommandId, ModifyOptions, ModifyOutcome, ModifySession } from './bim/modify';
import { createPrimitiveElement, defaultPrimitive, PRIMITIVE_LABELS } from './bim/primitives';
import type { PrimitiveKind } from './bim/primitives';
import { createId } from './bim/id';
import { loadViewSettings, saveViewSettings } from './settings';
import type { ViewSettings } from './settings';
import { createDemoProject, createProject, nextElementName } from './bim/template';
import { solidFeaturesOf } from './bim/parametric';
import { SOLID_TEMPLATES } from './bim/solidTemplates';
import type {
  BimElement,
  FamilyType,
  MeshInstance,
  ParametricModel,
  PrimitiveSpec,
  ProjectDocument,
  SlabInstance,
  SolidFeature,
  Vec2,
  WallInstance,
  ColumnInstance,
} from './bim/types';
import {
  ApiError,
  authApi,
  ConflictError,
  getAuthToken,
  pingServer,
  resolveRepository,
  setAuthToken,
} from './data';
import type { AuthUser } from './data';
import type { ProjectRepository } from './data/repository';
import { CollabClient } from './collab/client';
import type { CollabStatus, CollabUser } from './collab/client';
import { applyDocumentDiff, diffDocuments } from './collab/diff';
import { loadStepImporter } from './occtImport';
import { fetchServerStepMesh } from './step/convert';
import {
  emptyHistory, pushHistory as pushHistoryStack, redoHistory, undoHistory,
} from './history';
import type { History } from './history';

const TOOL_LABELS: Record<Tool, string> = {
  select: '选择',
  wall: '墙',
  column: '柱',
  slab: '楼板',
  grid: '轴网',
  primitive: '体量',
};

const TOOL_SHORTCUTS: Record<string, Tool> = {
  WA: 'wall',
  CL: 'column',
  SB: 'slab',
  GR: 'grid',
};

const HISTORY_LIMIT = 50;

function readUiFlag(key: string): boolean {
  try {
    return localStorage.getItem(key) !== '0';
  } catch {
    return true;
  }
}

interface ImportProgress {
  stage: string;
  percent: number | null;
}

function readFileWithProgress(
  file: File,
  mode: 'text' | 'buffer',
  onProgress: (ratio: number) => void,
): Promise<string | ArrayBuffer> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onprogress = (event) => {
      if (event.lengthComputable && event.total > 0) onProgress(event.loaded / event.total);
    };
    reader.onload = () => resolve(reader.result as string | ArrayBuffer);
    reader.onerror = () => reject(reader.error ?? new Error('读取文件失败'));
    if (mode === 'buffer') reader.readAsArrayBuffer(file);
    else reader.readAsText(file);
  });
}

function readStoredWidth(key: string, fallback: number): number {
  try {
    const value = Number(localStorage.getItem(key));
    if (!Number.isFinite(value)) return fallback;
    return Math.min(560, Math.max(200, Math.round(value)));
  } catch {
    return fallback;
  }
}

function downloadFile(filename: string, content: string, mimeType: string) {
  const url = URL.createObjectURL(new Blob([content], { type: mimeType }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** 地址栏别名 → 账户中心分区（兼容旧版 ?settings=users / ?settings=view） */
const ACCOUNT_SECTION_ALIASES: Record<string, AccountSection> = {
  profile: 'profile',
  security: 'security',
  password: 'security',
  projects: 'projects',
  preferences: 'preferences',
  view: 'preferences',
  users: 'users',
  ai: 'ai',
  system: 'system',
  admin: 'system',
};

function readAccountSectionFromUrl(): AccountSection | null {
  const params = new URLSearchParams(window.location.search);
  const key = params.get('account') ?? params.get('settings');
  return key ? ACCOUNT_SECTION_ALIASES[key] ?? null : null;
}

export default function App({ initialAccountSection }: { initialAccountSection?: AccountSection } = {}) {
  /* ---------- 会话与存储 ---------- */
  const [repository, setRepository] = useState<ProjectRepository | null>(null);
  const [mode, setMode] = useState<'local' | 'server' | null>(null);
  const [user, setUser] = useState<AuthUser | null>(null);
  const [authReady, setAuthReady] = useState(false);
  const [bootstrapError, setBootstrapError] = useState('');
  const [conflictRev, setConflictRev] = useState<number | null>(null);
  const [versionsOpen, setVersionsOpen] = useState(false);
  const [membersOpen, setMembersOpen] = useState(false);
  const [collabStatus, setCollabStatus] = useState<CollabStatus>('offline');
  const [collabUsers, setCollabUsers] = useState<CollabUser[]>([]);
  const collabRef = useRef<CollabClient | null>(null);

  /* ---------- 文档与编辑 ---------- */
  const [summaries, setSummaries] = useState<ProjectSummary[]>([]);
  const [project, setProject] = useState<ProjectDocument>(() => createDemoProject());
  const projectRef = useRef(project);
  projectRef.current = project;
  const lastSavedRef = useRef<ProjectDocument | null>(null);
  /** 本端刚刚通过 HTTP 写入的 rev（如 AI 应用）：doc 广播回声按它识别，避免清空撤销栈。 */
  const lastLocalRevRef = useRef<number | null>(null);

  const [hydrated, setHydrated] = useState(false);
  const [selection, setSelection] = useState<string[]>([]);
  const [selectedLevelId, setSelectedLevelId] = useState<string | null>(null);
  const [activeLevelId, setActiveLevelId] = useState<string>(project.levels[0]?.id ?? '');
  const [viewKind, setViewKind] = useState<ViewKind>('3d');
  const [viewLevelId, setViewLevelId] = useState<string | null>(null);
  const [projection, setProjection] = useState<'perspective' | 'parallel'>('perspective');
  const [tool, setTool] = useState<Tool>('select');
  const [draftStart, setDraftStart] = useState<Vec2 | null>(null);
  const [ribbonTab, setRibbonTab] = useState<RibbonTab>('architecture');
  const [message, setMessage] = useState('');
  const [hoverPoint, setHoverPoint] = useState<Vector3 | null>(null);
  const [history, setHistory] = useState<History<ProjectDocument>>(() => emptyHistory());
  // 与 history 同步的 ref：键盘连按 Ctrl+Z 时不会读到上一帧的旧栈
  const historyRef = useRef<History<ProjectDocument>>(emptyHistory());
  const [saveState, setSaveState] = useState<'saved' | 'dirty' | 'saving'>('saved');
  const [zoomAllRequest, setZoomAllRequest] = useState(0);
  /** 特征树编辑器：只对造型实体（primitive.kind === 'solid'）开放 */
  const [solidEdit, setSolidEdit] = useState<{
    id: string;
    name: string;
    features: SolidFeature[];
    position: Vec2;
    rotation: number;
    /** 参数化模型（模板 + 参数）；有它才算「可调尺寸」的构件 */
    parametric?: ParametricModel | null;
  } | null>(null);
  /** 模型库：预置造型的图形化入口（Ribbon 建筑页 → 模型库） */
  const [libraryOpen, setLibraryOpen] = useState(false);
  const [fitElementId, setFitElementId] = useState<string | null>(null);
  const [isImporting, setIsImporting] = useState(false);
  const [importProgress, setImportProgress] = useState<ImportProgress | null>(null);
  /** 解析完成、等待用户确认轴向 / 单位的模型 */
  const [importPending, setImportPending] = useState<{ fileName: string; model: ImportedModel } | null>(null);
  /** 拖文件到窗口时的提示层 */
  const [dragActive, setDragActive] = useState(false);
  const dragDepthRef = useRef(0);
  /** 一次拖入多个模型时排队：确认/取消当前模型后自动解析下一个 */
  const importQueueRef = useRef<Array<{ file: File; resources?: Map<string, string> }>>([]);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [aiOpen, setAiOpen] = useState(false);
  /** AI 助手停靠到右侧固定栏时占用的宽度；工作区据此让出空间，避免遮住属性面板与视口 */
  const [aiDockWidth, setAiDockWidth] = useState(0);
  /** 账户中心（右上角用户名）：账号 / 项目 / 软件设置 + 超管专属管理 */
  const [accountOpen, setAccountOpen] = useState(Boolean(initialAccountSection));
  const [accountSection, setAccountSection] = useState<AccountSection>(initialAccountSection ?? 'profile');
  const [rendererInfo, setRendererInfo] = useState<{ renderer: string; software: boolean } | null>(null);
  const softwareWarnedRef = useRef(false);
  const [apiReachable, setApiReachable] = useState<boolean | null>(null);
  const [latencyMs, setLatencyMs] = useState<number | null>(null);
  const slowWarnedRef = useRef(false);
  const [viewSettings, setViewSettings] = useState<ViewSettings>(() => loadViewSettings());
  const [browserWidth, setBrowserWidth] = useState(() => readStoredWidth('strubrowser.ui.browserWidth', 250));
  const [propertiesWidth, setPropertiesWidth] = useState(() => readStoredWidth('strubrowser.ui.propertiesWidth', 275));
  /* Revit 式修改命令：上下文会话 + 视口取点，取代旧版弹窗填数字 */
  const [modify, setModify] = useState<ModifySession | null>(null);
  const modifyRef = useRef<ModifySession | null>(null);
  modifyRef.current = modify;
  const cursorRef = useRef<Vec2 | null>(null);
  /**
   * 视口控制能力（由 ModelViewport 注册）：AI 应用修改后截图看自己的成品；
   * 也可以按 AI 的请求转动视角，让它「转着看」再改。
   */
  const viewportRef = useRef<ViewportApi | null>(null);
  const viewKindRef = useRef<ViewKind>(viewKind);
  viewKindRef.current = viewKind;

  /**
   * 交给 AI 助手的视口句柄。平面视图会锁死相机，所以要先切回三维再转；
   * 切视图会让 ModelViewport 重建，得等一拍才有新的句柄，因此 look 是异步的。
   */
  const aiViewport = useMemo(() => ({
    capture: () => viewportRef.current?.capture() ?? null,
    camera: () => viewportRef.current?.camera() ?? null,
    fitAll: () => viewportRef.current?.fitAll() ?? false,
    look: (request: ViewLookRequest) => new Promise<boolean>((resolve) => {
      if (!viewportRef.current) {
        resolve(false);
        return;
      }
      if (viewKindRef.current !== 'plan') {
        resolve(viewportRef.current.look(request));
        return;
      }
      setViewKind('3d');
      window.setTimeout(() => resolve(viewportRef.current?.look(request) ?? false), 260);
    }),
  }), []);
  const shortcutRef = useRef({ buffer: '', at: 0 });
  const shiftConstrainRef = useRef(false);
  const [primitiveKind, setPrimitiveKind] = useState<PrimitiveKind | null>(null);
  const [scheduleOpen, setScheduleOpen] = useState(false);
  const [layersOpen, setLayersOpen] = useState(false);
  const [materialsOpen, setMaterialsOpen] = useState(false);
  const [parametersOpen, setParametersOpen] = useState(false);
  /** 当前图层（CAD 语义）：新绘制 / 新导入的构件自动归入此层 */
  const [currentLayerId, setCurrentLayerId] = useState(DEFAULT_LAYER_ID);
  const currentLayerRef = useRef(currentLayerId);
  currentLayerRef.current = currentLayerId;
  const clipboardRef = useRef<BimElement[] | null>(null);
  const pasteCountRef = useRef(1);
  const apiReachableRef = useRef<boolean | null>(null);
  const [browserOpen, setBrowserOpen] = useState(() => readUiFlag('strubrowser.ui.browser'));
  const [propertiesOpen, setPropertiesOpen] = useState(() => readUiFlag('strubrowser.ui.properties'));

  /** 是否有模态弹窗打开：打开时锁定主界面（屏蔽快捷键、点击空白不关闭） */
  const modalOpen = layersOpen || materialsOpen || scheduleOpen || parametersOpen
    || accountOpen || versionsOpen || membersOpen || importPending !== null;
  const modalOpenRef = useRef(false);
  modalOpenRef.current = modalOpen;

  const currentSummary = summaries.find((item) => item.id === project.id);
  /** 本地模式没有登录用户：账户中心退化为「我的项目 + 软件设置」，用一个本机身份占位 */
  const accountUser: AuthUser | null = user
    ?? (mode === 'local'
      ? { id: 'local-device', email: '本机浏览器', name: '本地用户', isAdmin: false }
      : null);
  const role = mode === 'server' ? currentSummary?.role : 'admin';
  const canEdit = mode !== 'server' || role === 'editor' || role === 'admin';
  const isAdmin = mode !== 'server' || role === 'admin';

  const selectedElements = useMemo(
    () => project.elements.filter((element) => selection.includes(element.id)),
    [project.elements, selection],
  );
  const selectedLevel = useMemo(
    () => (selectedLevelId ? levelById(project, selectedLevelId) ?? null : null),
    [project, selectedLevelId],
  );
  const triangles = useMemo(() => countTriangles(project), [project]);
  const activeLevel = levelById(project, activeLevelId) ?? project.levels[0];

  /* 解析存储模式（本地 / 服务端），并恢复登录态 */
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const choice = await resolveRepository();
        if (cancelled) return;
        setRepository(choice.repository);
        setMode(choice.mode);
        if (choice.mode === 'server' && getAuthToken()) {
          try {
            const me = await authApi.me();
            if (!cancelled) setUser(me.user);
          } catch {
            setAuthToken(null);
          }
        }
      } catch (error) {
        if (!cancelled) {
          setBootstrapError(error instanceof Error ? error.message : '无法连接服务端');
        }
      } finally {
        if (!cancelled) setAuthReady(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    saveViewSettings(viewSettings);
  }, [viewSettings]);

  useEffect(() => {
    try {
      localStorage.setItem('strubrowser.ui.browserWidth', String(browserWidth));
    } catch {
      // 忽略存储失败
    }
  }, [browserWidth]);

  useEffect(() => {
    try {
      localStorage.setItem('strubrowser.ui.propertiesWidth', String(propertiesWidth));
    } catch {
      // 忽略存储失败
    }
  }, [propertiesWidth]);

  /* 深链：?account=users / ?settings=ai 直接打开账户中心对应页（兼容旧版 ?settings=users） */
  useEffect(() => {
    const target = readAccountSectionFromUrl();
    if (target) {
      setAccountSection(target);
      setAccountOpen(true);
    }
  }, []);

  /* 账户中心是整页：地址栏跟着走，刷新、分享、后退都能回到同一页 */
  useEffect(() => {
    const url = new URL(window.location.href);
    if (accountOpen) url.searchParams.set('account', accountSection);
    else url.searchParams.delete('account');
    url.searchParams.delete('settings');
    const next = `${url.pathname}${url.search}${url.hash}`;
    const current = `${window.location.pathname}${window.location.search}${window.location.hash}`;
    if (next !== current) window.history.replaceState(window.history.state, '', next);
  }, [accountOpen, accountSection]);

  /* 浏览器前进 / 后退：按地址栏还原 */
  useEffect(() => {
    const onPopState = () => {
      const target = readAccountSectionFromUrl();
      if (target) {
        setAccountSection(target);
        setAccountOpen(true);
      } else {
        setAccountOpen(false);
      }
    };
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  useEffect(() => {
    document.documentElement.style.setProperty('--ui-font-scale', String(viewSettings.uiFontScale));
    document.body.classList.toggle('ui-large', viewSettings.uiFontScale >= 0.9);
  }, [viewSettings.uiFontScale]);

  useEffect(() => {
    if (rendererInfo?.software && !softwareWarnedRef.current) {
      softwareWarnedRef.current = true;
      setMessage('检测到软件渲染（无 GPU 加速）：已自动降低画质，卡顿与网络无关，建议使用有显卡的电脑或开启浏览器硬件加速');
    }
  }, [rendererInfo]);

  /* 服务端连接看门狗：断开时提示，恢复后自动清除 */
  const checkApi = useCallback(async () => {
    if (mode !== 'server') return;
    const started = performance.now();
    const reachable = await pingServer('', 2500);
    const elapsed = Math.round(performance.now() - started);
    if (apiReachableRef.current === false && reachable) setMessage('已重新连接服务端');
    apiReachableRef.current = reachable;
    setApiReachable(reachable);
    setLatencyMs(reachable ? elapsed : null);
    if (reachable && elapsed > 500 && !slowWarnedRef.current) {
      slowWarnedRef.current = true;
      setMessage(`网络延迟较高（${elapsed} ms）：渲染是本地的不受影响，但保存/协同会慢；建议使用离使用者更近的服务器或 Tailscale/局域网`);
    }
  }, [mode]);

  useEffect(() => {
    if (mode !== 'server') {
      apiReachableRef.current = null;
      setApiReachable(null);
      return;
    }
    void checkApi();
    const timer = window.setInterval(() => { void checkApi(); }, 8000);
    const onFocus = () => { void checkApi(); };
    window.addEventListener('focus', onFocus);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('focus', onFocus);
    };
  }, [mode, checkApi]);

  /* 载入项目（登录态或本地模式就绪后） */
  useEffect(() => {
    if (!repository || !authReady) return;
    if (mode === 'server' && !user) return;
    let cancelled = false;
    setHydrated(false);
    void (async () => {
      try {
        const list = await repository.list();
        const lastId = await repository.loadLastOpenedId();
        let loaded = lastId ? await repository.load(lastId) : null;
        if (!loaded && list[0]) loaded = await repository.load(list[0].id);
        if (!loaded) {
          loaded = createDemoProject();
          await repository.save(loaded);
        }
        loaded = normalizeExternal(loaded);
        if (cancelled) return;
        setProject(loaded);
        projectRef.current = loaded;
        lastSavedRef.current = loaded;
    lastLocalRevRef.current = null;
        lastLocalRevRef.current = null;
        setActiveLevelId(loaded.levels[0]?.id ?? '');
        setSelectedLevelId(null);
        setSelection([]);
        resetHistory();
        setViewKind('3d');
        setViewLevelId(null);
        setTool('select');
        setDraftStart(null);
        setConflictRev(null);
        setSaveState('saved');
        setSummaries(await repository.list());
        await repository.saveLastOpenedId(loaded.id);
      } catch (error) {
        if (!cancelled) {
          console.error('读取项目失败。', error);
          setMessage(error instanceof Error ? `读取项目失败：${error.message}` : '读取项目失败。');
        }
      } finally {
        if (!cancelled) setHydrated(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [repository, authReady, mode, user]);

  /* 协作：服务端模式下为当前项目建立 WebSocket（房间广播 + 差分补丁） */
  useEffect(() => {
    const stop = () => {
      collabRef.current?.disconnect();
      collabRef.current = null;
      setCollabStatus('offline');
      setCollabUsers([]);
    };
    if (mode !== 'server' || !user || !hydrated || !repository) {
      stop();
      return;
    }
    const token = getAuthToken();
    if (!token) {
      stop();
      return;
    }
    const client = new CollabClient(project.id, token, {
      onStatus: (status) => setCollabStatus(status),
      onHello: ({ rev, document, users }) => {
        repository.adoptRevision?.(project.id, rev);
        setCollabUsers(users);
        // 本地没有未保存修改时，采用服务端快照，保证加入房间时状态一致
        if (projectRef.current === lastSavedRef.current) {
          const normalized = normalizeExternal(document);
          setProject(normalized);
          projectRef.current = normalized;
          lastSavedRef.current = normalized;
        }
      },
      onPatch: ({ rev, diff, self }) => {
        repository.adoptRevision?.(project.id, rev);
        // 自己发出的补丁服务端也会回显：本地已经应用过，只需同步 rev。
        // 若把回显再应用一遍，会用旧快照覆盖本地后续编辑，并把撤销栈清空（表现为 Ctrl+Z 失效）。
        if (self) {
          setSaveState('saved');
          return;
        }
        setProject((current) => {
          const next = normalizeExternal(applyDocumentDiff(current, diff));
          projectRef.current = next;
          lastSavedRef.current = next;
          return next;
        });
        resetHistory();
        setSaveState('saved');
      },
      onDocument: ({ rev, document }) => {
        repository.adoptRevision?.(project.id, rev);
        // 本端刚写入的 rev（AI 应用等）已经应用到本地，跳过回声以保留撤销栈
        if (lastLocalRevRef.current === rev) {
          setSaveState('saved');
          return;
        }
        if (projectRef.current === lastSavedRef.current) {
          const normalized = normalizeExternal(document);
          setProject(normalized);
          projectRef.current = normalized;
          lastSavedRef.current = normalized;
          resetHistory();
          setSaveState('saved');
          setMessage(`模型已更新（rev ${rev}）`);
        } else {
          setMessage('其他成员修改了模型；本地还有未保存修改，请先保存或重新加载');
        }
      },
      onPresence: setCollabUsers,
      onError: (text) => setMessage(text),
    });
    client.connect();
    collabRef.current = client;
    return () => {
      client.disconnect();
      if (collabRef.current === client) collabRef.current = null;
      setCollabStatus('offline');
      setCollabUsers([]);
    };
  }, [mode, user, hydrated, project.id, repository]);

  /* 自动保存（带 rev 冲突检测；协作在线时由补丁落库，跳过 HTTP 保存） */
  useEffect(() => {
    if (!repository || !hydrated) return;
    if (mode === 'server' && !user) return;
    if (collabRef.current?.online) return;
    if (project === lastSavedRef.current) return;
    setSaveState('dirty');
    const timer = window.setTimeout(() => {
      setSaveState('saving');
      void repository.save(project).then(async () => {
        lastSavedRef.current = project;
        setSaveState('saved');
        setConflictRev(null);
        setSummaries(await repository.list());
      }).catch((error: unknown) => {
        if (error instanceof ConflictError) {
          setConflictRev(error.rev);
          setSaveState('dirty');
          setMessage('服务端文档已被其他会话修改，请选择加载最新或覆盖保存。');
          return;
        }
        console.error('保存项目失败。', error);
        setSaveState('dirty');
        setMessage(error instanceof Error ? `保存失败：${error.message}` : '保存失败。');
      });
    }, 600);
    return () => window.clearTimeout(timer);
  }, [project, repository, hydrated, mode, user]);

  useEffect(() => {
    if (!repository || !hydrated) return;
    void repository.saveLastOpenedId(project.id);
  }, [project.id, repository, hydrated]);

  useEffect(() => {
    if (!message) return;
    const timer = window.setTimeout(() => setMessage(''), 4200);
    return () => window.clearTimeout(timer);
  }, [message]);

  useEffect(() => {
    try {
      localStorage.setItem('strubrowser.ui.browser', browserOpen ? '1' : '0');
    } catch {
      // 忽略存储失败
    }
  }, [browserOpen]);

  useEffect(() => {
    try {
      localStorage.setItem('strubrowser.ui.properties', propertiesOpen ? '1' : '0');
    } catch {
      // 忽略存储失败
    }
  }, [propertiesOpen]);

  useEffect(() => {
    const onChange = () => {
      const active = Boolean(document.fullscreenElement);
      setIsFullscreen(active);
      if (!active) keyboardLock()?.unlock?.();
    };
    document.addEventListener('fullscreenchange', onChange);
    onChange();
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, []);

  type KeyboardLock = { lock?: (keys?: string[]) => Promise<void>; unlock?: () => void };
  const keyboardLock = (): KeyboardLock | undefined =>
    (navigator as Navigator & { keyboard?: KeyboardLock }).keyboard;

  async function toggleFullscreen() {
    try {
      if (document.fullscreenElement) {
        await document.exitFullscreen();
        return;
      }
      await document.documentElement.requestFullscreen();
      // 锁定 Esc：全屏时 Esc 只用于取消选择，不再退出全屏（Chrome/Edge 支持 Keyboard Lock）
      let locked = false;
      const keyboard = keyboardLock();
      if (keyboard?.lock) {
        try {
          await keyboard.lock(['Escape']);
          locked = true;
        } catch {
          locked = false;
        }
      }
      setMessage(locked
        ? '已进入全屏：Esc 取消选择，退出全屏请点右上角 ⤡'
        : '已进入全屏（当前浏览器 Esc 会退出全屏）');
    } catch (error) {
      setMessage(error instanceof Error ? `全屏失败：${error.message}` : '当前浏览器不支持全屏');
    }
  }

  /** 外部载入 / 协作补丁：补齐新字段并按关联公式重算，保证各端一致。 */
  function normalizeExternal(document: ProjectDocument): ProjectDocument {
    return recomputeParameters(ensureDocumentParameters(ensureDocumentLayers(document))).project;
  }

  /* ---------- 撤销栈 ---------- */
  function writeHistory(next: History<ProjectDocument>) {
    historyRef.current = next;
    setHistory(next);
  }

  function resetHistory() {
    writeHistory(emptyHistory());
  }

  function pushHistory(previous: ProjectDocument) {
    writeHistory(pushHistoryStack(historyRef.current, previous, HISTORY_LIMIT));
  }

  function commit(mutator: (document: ProjectDocument) => ProjectDocument, label: string) {
    if (!canEdit) {
      setMessage('当前角色为查看者，无法修改项目。');
      return;
    }
    const current = projectRef.current;
    const next = mutator(current);
    if (next === current) return;
    // 图层规范化：旧文档自动补默认图层，新构件归入「当前图层」（缺省按类别）
    const normalized = ensureDocumentLayers({ ...next, updatedAt: new Date().toISOString() });
    const existing = new Set(current.elements.map((element) => element.id));
    const rawById = new Map(next.elements.map((element) => [element.id, element]));
    // 复制/阵列产生的新构件会继承源构件图层；只有完全没有图层信息的新构件才用当前图层
    const currentLayer = currentLayerRef.current || DEFAULT_LAYER_ID;
    const stamped = {
      ...normalized,
      elements: normalized.elements.map((element) => {
        if (existing.has(element.id)) return element;
        const raw = rawById.get(element.id);
        return raw && !raw.layerId ? { ...element, layerId: currentLayer } : element;
      }),
    };
    // 参数关联更新：任何文档变更都按「全局参数 → 类型 → 实例」依赖顺序重算一次，
    // 几何、派生尺寸、明细表与 IFC 全部读同一份文档，因此自动跟随刷新。
    const { project: linked, report } = recomputeParameters(ensureDocumentParameters(stamped));
    pushHistory(current);
    setProject(linked);
    projectRef.current = linked;
    const client = collabRef.current;
    if (client?.online) {
      const diff = diffDocuments(current, linked);
      if (diff && client.sendPatch(diff)) {
        lastSavedRef.current = linked;
        setSaveState('saved');
      }
    }
    let note = '';
    if (report.updates.length) {
      note += ` · 联动更新 ${report.updates.length} 项参数`;
      if (report.affectedElements) note += `（${report.affectedElements} 个构件）`;
    }
    if (report.issues.length) note += ` · ${report.issues.length} 个公式错误（见参数关联管理器）`;
    setMessage(`${label}${note}`);
  }

  function undo() {
    if (!canEdit) return;
    const result = undoHistory(historyRef.current, projectRef.current, HISTORY_LIMIT);
    if (!result) return;
    const before = projectRef.current;
    const previous = result.value;
    writeHistory(result.history);
    setProject(previous);
    projectRef.current = previous;
    setSelection((current) => current.filter((id) => previous.elements.some((element) => element.id === id)));
    syncLocalChange(before, previous);
    setMessage('已撤销');
  }

  function redo() {
    if (!canEdit) return;
    const result = redoHistory(historyRef.current, projectRef.current, HISTORY_LIMIT);
    if (!result) return;
    const before = projectRef.current;
    const next = result.value;
    writeHistory(result.history);
    setProject(next);
    projectRef.current = next;
    setSelection((current) => current.filter((id) => next.elements.some((element) => element.id === id)));
    syncLocalChange(before, next);
    setMessage('已重做');
  }

  /** 撤销/重做等绕过 commit 的本地改动，在协作在线时也要广播补丁 */
  function syncLocalChange(before: ProjectDocument, after: ProjectDocument) {
    const client = collabRef.current;
    if (!client?.online) return;
    const diff = diffDocuments(before, after);
    if (diff && client.sendPatch(diff)) {
      lastSavedRef.current = after;
      setSaveState('saved');
    }
  }

  function cancelTool() {
    if (tool === 'select' && !draftStart) return;
    setTool('select');
    setDraftStart(null);
    setMessage('已退出工具');
  }

  /** Esc：Revit 逐级退出——先关弹窗，再退回上一个取点，退出命令，最后清空选择 */
  function escape() {
    if (modalOpen) {
      if (importPending) cancelImport();
      setLayersOpen(false);
      setMaterialsOpen(false);
      setScheduleOpen(false);
      setParametersOpen(false);
      setAccountOpen(false);
      setVersionsOpen(false);
      setMembersOpen(false);
      return;
    }
    const current = modifyRef.current;
    if (current && current.status !== 'finished') {
      const next = stepBack(current);
      if (next.status === 'finished') {
        setModify(null);
        modifyRef.current = null;
        setMessage(`已退出${MODIFY_LABELS[current.command]}命令`);
      } else {
        setModify(next);
        modifyRef.current = next;
        setMessage(modifyPrompt(next));
      }
      return;
    }
    const hadSelection = selection.length > 0 || selectedLevelId !== null;
    // 绘制中先退回第一点，再按一次才退出工具（与 Revit 逐级退出一致）
    if (draftStart) {
      setDraftStart(null);
      setMessage('已取消第一点，重新拾取');
      return;
    }
    setTool('select');
    setDraftStart(null);
    setSelection([]);
    setSelectedLevelId(null);
    setModify(null);
    modifyRef.current = null;
    if (hadSelection || tool !== 'select') setMessage('已取消选择');
  }

  function deleteSelection() {
    if (!selection.length || !canEdit) return;
    applyOutcome(immediateModify(projectRef.current, 'delete', selection));
  }

  /* ---------- Revit 式修改命令 ---------- */

  /** 同步更新会话状态，保证同一个事件里连续两次取点读到最新状态。 */
  function updateModify(mutator: (session: ModifySession) => ModifySession): void {
    const current = modifyRef.current;
    if (!current) return;
    const next = mutator(current);
    modifyRef.current = next;
    setModify(next);
  }

  function clearModify(): void {
    setModify(null);
    modifyRef.current = null;
  }

  function applyOutcome(outcome: ModifyOutcome): void {
    if (outcome.error) {
      setMessage(outcome.error);
      return;
    }
    if (outcome.elements !== projectRef.current.elements) {
      commit((document) => ({ ...document, elements: outcome.elements }), outcome.label || '已修改构件');
    } else if (outcome.label) {
      setMessage(outcome.label);
    }
    if (outcome.note) setMessage(`${outcome.label}；${outcome.note}`);
    setSelection(outcome.selection);
  }

  function startModifyCommand(command: ModifyCommandId): void {
    if (!canEdit && command !== 'measure') {
      setMessage('当前角色为查看者，无法修改项目');
      return;
    }
    if (IMMEDIATE_COMMANDS.has(command)) {
      applyOutcome(immediateModify(projectRef.current, command as 'pin' | 'unpin' | 'delete', selection));
      return;
    }
    const session = createModifySession(command, projectRef.current, selection);
    setModify(session);
    modifyRef.current = session;
    setTool('select');
    setDraftStart(null);
    setRibbonTab('modify');
    if (session.status === 'await-selection') {
      setMessage(`${MODIFY_LABELS[command]}：请先选择构件（Shift 加选），选好后按 Enter 或直接开始取点`);
    } else {
      setMessage(modifyPrompt(session));
    }
  }

  function handleModifyClick(click: ModifyClick): void {
    const current = modifyRef.current;
    if (!current || current.status !== 'active') return;
    const next = advanceModify(current, click);
    modifyRef.current = next;
    setModify(next);
    if (!isReady(next, cursorRef.current)) return;
    const outcome = finishModify(projectRef.current, next, cursorRef.current);
    if (outcome.error) {
      // 无效取点（例如距离为 0）：退回上一步，允许用户重新取点
      const retry = stepBack(next);
      modifyRef.current = retry;
      setModify(retry);
      setMessage(outcome.error);
      return;
    }
    applyOutcome(outcome);
    if (outcome.keepSession) {
      modifyRef.current = outcome.keepSession;
      setModify(outcome.keepSession);
    } else {
      clearModify();
    }
  }

  function finishModifyCommand(): void {
    const current = modifyRef.current;
    if (!current) return;
    if (current.status === 'await-selection') {
      if (!selection.length) {
        setMessage('请先选择构件');
        return;
      }
      updateModify((session) => withSelection(session, projectRef.current, selection));
      setMessage(modifyPrompt(modifyRef.current!));
      return;
    }
    const outcome = finishModify(projectRef.current, current, cursorRef.current);
    if (outcome.error) {
      setMessage(outcome.error);
      return;
    }
    applyOutcome(outcome);
    if (outcome.keepSession) {
      modifyRef.current = outcome.keepSession;
      setModify(outcome.keepSession);
    } else {
      clearModify();
    }
  }

  function updateModifyOptions(patch: Partial<ModifyOptions>): void {
    updateModify((session) => ({ ...session, options: { ...session.options, ...patch } }));
  }

  function dragMoveSelection(dx: number, dy: number, copy: boolean, ids: string[]): void {
    if (!canEdit) {
      setMessage('当前角色为查看者，无法修改项目');
      return;
    }
    const picked = projectRef.current.elements.filter(
      (element) => ids.includes(element.id) && !isElementLocked(projectRef.current, element),
    );
    if (!picked.length) {
      setMessage('选中的构件已锁定，请先解锁');
      return;
    }
    const idsSet = new Set(picked.map((element) => element.id));
    if (copy) {
      const copies = duplicateElements(projectRef.current, picked, { dx, dy });
      commit((document) => ({ ...document, elements: [...document.elements, ...copies] }),
        `拖拽复制 ${copies.length} 个构件（${Math.hypot(dx, dy).toFixed(2)} m）`);
      setSelection(copies.map((element) => element.id));
    } else {
      commit(
        (document) => ({
          ...document,
          elements: document.elements.map((element) => (
            idsSet.has(element.id) ? translateElement(element, { dx, dy }) : element
          )),
        }),
        `拖拽移动 ${picked.length} 个构件（${Math.hypot(dx, dy).toFixed(2)} m）`,
      );
      setSelection([...idsSet]);
    }
  }

  const actionsRef = useRef({
    undo, redo, deleteSelection, cancelTool, escape,
    copySelection, pasteSelection,
    duplicateSelection: () => duplicateSelection(),
    nudgeSelection,
    finishModifyCommand,
    startModifyCommand,
    dragMoveSelection,
    saveNow: () => void saveNow(),
    selectAll: selectAllElements,
    cutSelection,
    renameSelection: renameSelectedElement,
    hideSelection,
    showAll: showAllElements,
    zoomFitAll: zoomToFitAll,
    zoomFitSelection: zoomToFitSelection,
    toggleProperties: () => setPropertiesOpen((open) => !open),
    toggleBrowser: () => setBrowserOpen((open) => !open),
    startTool: chooseTool,
  });
  actionsRef.current = {
    undo, redo, deleteSelection, cancelTool, escape,
    copySelection, pasteSelection,
    duplicateSelection: () => duplicateSelection(),
    nudgeSelection,
    finishModifyCommand,
    startModifyCommand,
    dragMoveSelection,
    saveNow: () => void saveNow(),
    selectAll: selectAllElements,
    cutSelection,
    renameSelection: renameSelectedElement,
    hideSelection,
    showAll: showAllElements,
    zoomFitAll: zoomToFitAll,
    zoomFitSelection: zoomToFitSelection,
    toggleProperties: () => setPropertiesOpen((open) => !open),
    toggleBrowser: () => setBrowserOpen((open) => !open),
    startTool: chooseTool,
  };

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const typing = Boolean(target && ['INPUT', 'SELECT', 'TEXTAREA'].includes(target.tagName));
      const mod = event.metaKey || event.ctrlKey;
      // Ctrl/Cmd+S：保存（输入框里也生效，但只保存文档，不打断输入）
      if (mod && event.key.toLowerCase() === 's') {
        event.preventDefault();
        if (!event.repeat) actionsRef.current.saveNow();
        return;
      }
      // 模态弹窗打开时锁定主界面：只响应 Esc 关闭弹窗，其余快捷键交给弹窗自身
      // （不 preventDefault，保留输入框里的原生撤销/重做/全选/粘贴）
      if (modalOpenRef.current) {
        if (event.key === 'Escape') {
          event.preventDefault();
          actionsRef.current.escape();
        }
        return;
      }
      // 输入框内保留浏览器原生的撤销/重做、全选、剪切
      if (typing) return;
      if (mod && event.key.toLowerCase() === 'z') {
        event.preventDefault();
        if (event.shiftKey) actionsRef.current.redo();
        else actionsRef.current.undo();
        return;
      }
      if (mod && event.key.toLowerCase() === 'y') {
        event.preventDefault();
        actionsRef.current.redo();
        return;
      }
      if (mod && event.key.toLowerCase() === 'a') {
        event.preventDefault();
        actionsRef.current.selectAll();
        return;
      }
      if (mod && event.key.toLowerCase() === 'x') {
        event.preventDefault();
        actionsRef.current.cutSelection();
        return;
      }
      if (event.key === 'F2') {
        event.preventDefault();
        actionsRef.current.renameSelection();
        return;
      }
      // Revit：命令进行中按住 Shift 临时约束到水平/垂直（松开恢复）
      if (event.key === 'Shift' && !event.repeat) {
        const session = modifyRef.current;
        if (session?.status === 'active' && !session.options.constrain) {
          shiftConstrainRef.current = true;
          updateModify((current) => ({ ...current, options: { ...current.options, constrain: true } }));
        }
        return;
      }
      if (mod && event.key.toLowerCase() === 'c') {
        event.preventDefault();
        actionsRef.current.copySelection();
        return;
      }
      if (mod && event.key.toLowerCase() === 'v') {
        event.preventDefault();
        actionsRef.current.pasteSelection();
        return;
      }
      if (mod && event.key.toLowerCase() === 'd') {
        event.preventDefault();
        actionsRef.current.duplicateSelection();
        return;
      }
      const arrows: Record<string, [number, number]> = {
        ArrowLeft: [-1, 0],
        ArrowRight: [1, 0],
        ArrowUp: [0, 1],
        ArrowDown: [0, -1],
      };
      const step = arrows[event.key];
      if (step) {
        event.preventDefault();
        const size = event.shiftKey ? 1 : 0.1;
        actionsRef.current.nudgeSelection(step[0] * size, step[1] * size);
        return;
      }
      if (event.key === 'Enter') {
        event.preventDefault();
        actionsRef.current.finishModifyCommand();
        return;
      }
      if (event.key === 'Escape') {
        shortcutRef.current = { buffer: '', at: 0 };
        actionsRef.current.escape();
        return;
      }
      if (event.key === 'Delete' || event.key === 'Backspace') {
        actionsRef.current.deleteSelection();
        return;
      }
      // Revit 双字母快捷键：MV / CO / RO / MM / DM / AR / RA / AL / OF / SZ / TR / SL / DI / PN / UP / DE
      if (/^[a-zA-Z]$/.test(event.key) && !mod && !event.altKey) {
        const now = Date.now();
        const previous = now - shortcutRef.current.at < 1500 ? shortcutRef.current.buffer : '';
        const buffer = `${previous}${event.key.toUpperCase()}`.slice(-2);
        shortcutRef.current = { buffer, at: now };
        const toolShortcut = TOOL_SHORTCUTS[buffer];
        if (toolShortcut) {
          event.preventDefault();
          shortcutRef.current = { buffer: '', at: 0 };
          actionsRef.current.startTool(toolShortcut);
          return;
        }
        // 与 Revit 对齐的双字母快捷键
        const panels: Record<string, () => void> = {
          VV: () => setLayersOpen(true), // 可见性/图形 = 图层管理
          VG: () => setLayersOpen(true),
          MA: () => setMaterialsOpen(true),
          GP: () => setParametersOpen(true),
          PP: () => actionsRef.current.toggleProperties(), // 属性面板
          PB: () => actionsRef.current.toggleBrowser(), // 项目浏览器
          ZF: () => actionsRef.current.zoomFitAll(), // 缩放至全部
          ZE: () => actionsRef.current.zoomFitSelection(), // 缩放至选中
          HH: () => actionsRef.current.hideSelection(), // 隐藏选中
          HR: () => actionsRef.current.showAll(), // 恢复显示
        };
        const panelAction = panels[buffer];
        if (panelAction) {
          event.preventDefault();
          shortcutRef.current = { buffer: '', at: 0 };
          panelAction();
          return;
        }
        const command = MODIFY_SHORTCUTS[buffer];
        if (command) {
          event.preventDefault();
          shortcutRef.current = { buffer: '', at: 0 };
          actionsRef.current.startModifyCommand(command);
        }
      }
    };
    const onKeyUp = (event: KeyboardEvent) => {
      if (event.key !== 'Shift' || !shiftConstrainRef.current) return;
      shiftConstrainRef.current = false;
      const session = modifyRef.current;
      if (session?.status === 'active') {
        updateModify((current) => ({ ...current, options: { ...current.options, constrain: false } }));
      }
    };
    window.addEventListener('keydown', handler);
    window.addEventListener('keyup', onKeyUp);
    return () => {
      window.removeEventListener('keydown', handler);
      window.removeEventListener('keyup', onKeyUp);
    };
  }, []);

  function syncAwaitSelection(ids: string[]): void {
    const session = modifyRef.current;
    if (session?.status !== 'await-selection') return;
    const next = withSelection(session, projectRef.current, ids);
    modifyRef.current = next;
    setModify(next);
    if (next.status === 'active') setMessage(modifyPrompt(next));
  }

  function selectElement(id: string, additive: boolean) {
    setSelectedLevelId(null);
    const next = !additive ? [id]
      : selection.includes(id) ? selection.filter((value) => value !== id) : [...selection, id];
    setSelection(next);
    syncAwaitSelection(next);
  }

  function startBoolean(operation: 'union' | 'subtract' | 'intersect') {
    if (!canEdit) return;
    if (selection.length === 2) runBoolean(operation);
    else setMessage('布尔运算需要先选择 2 个构件（Shift 加选）');
  }

  function nudgeSelection(dx: number, dy: number) {
    if (!canEdit || !selection.length) return;
    const movable = projectRef.current.elements.filter(
      (element) => selection.includes(element.id) && !isElementLocked(projectRef.current, element),
    );
    if (!movable.length) {
      setMessage('选中的构件已锁定，请先解锁');
      return;
    }
    const ids = new Set(movable.map((element) => element.id));
    commit(
      (document) => ({
        ...document,
        elements: document.elements.map((element) => (
          ids.has(element.id) ? translateElement(element, { dx, dy }) : element
        )),
      }),
      `已微移 ${movable.length} 个构件（${Math.hypot(dx, dy).toFixed(2)} m）`,
    );
  }

  function copySelection() {
    if (!selectedElements.length) return;
    clipboardRef.current = selectedElements.map((element) => element);
    pasteCountRef.current = 1;
    setMessage(`已复制 ${selectedElements.length} 个构件到剪贴板`);
  }

  function duplicateSelection(offset = { dx: 1, dy: 0 }) {
    if (!canEdit || !selectedElements.length) return;
    const copies = duplicateElements(project, selectedElements, offset);
    commit(
      (document) => ({ ...document, elements: [...document.elements, ...copies] }),
      `已复制 ${copies.length} 个构件（偏移 ${offset.dx} m）`,
    );
    setSelection(copies.map((element) => element.id));
  }

  function pasteSelection() {
    if (!canEdit || !clipboardRef.current?.length) {
      if (!clipboardRef.current?.length) setMessage('剪贴板为空：先选中构件并按 Ctrl/Cmd+C');
      return;
    }
    const offset = { dx: pasteCountRef.current, dy: 0 };
    pasteCountRef.current += 1;
    duplicateSelection(offset);
  }

  function handleContextAction(
    action: 'select-all' | 'select-same-type' | 'clear' | 'cancel' | 'finish',
    targetId: string | null,
  ) {
    if (action === 'cancel') {
      escape();
      return;
    }
    if (action === 'finish') {
      finishModifyCommand();
      return;
    }
    if (action === 'clear') {
      setSelection([]);
      setSelectedLevelId(null);
      syncAwaitSelection([]);
      return;
    }
    if (action === 'select-all') {
      const ids = project.elements.filter((element) => element.visible).map((element) => element.id);
      setSelectedLevelId(null);
      setSelection(ids);
      syncAwaitSelection(ids);
      setMessage(`已选择全部 ${ids.length} 个可见构件`);
      return;
    }
    const target = project.elements.find((element) => element.id === (targetId ?? selection[0]));
    if (!target) {
      setMessage('请先选择一个构件');
      return;
    }
    const ids = project.elements
      .filter((element) => element.visible && element.category === target.category && element.typeId === target.typeId)
      .map((element) => element.id);
    setSelectedLevelId(null);
    setSelection(ids);
    syncAwaitSelection(ids);
    const typeName = project.types.find((type) => type.id === target.typeId)?.name;
    setMessage(`已选择 ${ids.length} 个同类构件${typeName ? `（${typeName}）` : ''}`);
  }

  function boxSelect(ids: string[], additive: boolean) {
    setSelectedLevelId(null);
    const next = !additive ? ids : [...new Set([...selection, ...ids])];
    setSelection(next);
    syncAwaitSelection(next);
    if (!ids.length) setMessage('框选未命中构件');
    else setMessage(`已框选 ${ids.length} 个构件${additive ? '（已加选）' : ''}`);
  }

  function toggleVisibility(id: string) {
    commit(
      (document) => ({
        ...document,
        elements: document.elements.map((element) => (element.id === id ? { ...element, visible: !element.visible } : element)),
      }),
      '已切换构件可见性',
    );
  }

  function patchElement(id: string, patch: Record<string, unknown>) {
    const element = projectRef.current.elements.find((item) => item.id === id);
    // 图层锁定：仍允许改图层归属、可见性与外观（视图属性），几何/约束参数需先解锁
    const viewKeys = new Set(['layerId', 'materialId', 'color', 'visible', 'pinned', 'name']);
    if (element && isElementLocked(projectRef.current, element)
      && Object.keys(patch).some((key) => !viewKeys.has(key))) {
      setMessage('构件所在图层已锁定，请在「图层管理 (VV)」中解锁后再编辑');
      return;
    }
    commit(
      (document) => ({
        ...document,
        elements: document.elements.map((element) =>
          element.id === id ? ({ ...element, ...patch } as BimElement) : element),
      }),
      '已修改构件参数',
    );
  }

  function patchType(typeId: string, patch: Record<string, unknown>) {
    commit(
      (document) => ({
        ...document,
        types: document.types.map((type) => (type.id === typeId ? ({ ...type, ...patch } as FamilyType) : type)),
      }),
      '已修改类型参数（全部实例联动）',
    );
  }

  function patchTypeFormula(typeId: string, key: string, formula: string | null) {
    commit(
      (document) => setTypeFormula(document, typeId, key, formula),
      formula ? '已建立类型参数关联（全部实例联动）' : '已解除类型参数关联',
    );
  }

  function patchElementFormula(elementId: string, key: string, formula: string | null) {
    const element = projectRef.current.elements.find((item) => item.id === elementId);
    if (element && isElementLocked(projectRef.current, element)) {
      setMessage('构件所在图层已锁定，请在「图层管理 (VV)」中解锁后再建立参数关联');
      return;
    }
    commit(
      (document) => setElementFormula(document, elementId, key, formula),
      formula ? '已建立实例参数关联' : '已解除实例参数关联',
    );
  }

  function patchLevel(levelId: string, patch: { name?: string; elevation?: number }) {
    commit(
      (document) => ({
        ...document,
        levels: document.levels.map((level) => (level.id === levelId ? { ...level, ...patch } : level)),
      }),
      '已修改标高',
    );
  }

  function addLevel() {
    if (!canEdit) {
      setMessage('当前角色为查看者，无法添加标高。');
      return;
    }
    const highest = project.levels.reduce((max, level) => Math.max(max, level.elevation), 0);
    const level = {
      id: createId(),
      name: `标高 ${project.levels.length + 1}`,
      elevation: Math.round((highest + 3) * 100) / 100,
    };
    commit((document) => ({ ...document, levels: [...document.levels, level] }), `已添加 ${level.name}`);
    setSelectedLevelId(level.id);
    setActiveLevelId(level.id);
  }

  function activate3d() {
    setViewKind('3d');
    setViewLevelId(null);
    setTool('select');
    setDraftStart(null);
    setFitElementId(null);
  }

  function activatePlan(levelId: string) {
    setViewKind('plan');
    setViewLevelId(levelId);
    setActiveLevelId(levelId);
    setSelectedLevelId(levelId);
    setDraftStart(null);
    setFitElementId(null);
  }

  function selectLevel(levelId: string) {
    setSelectedLevelId(levelId);
    setActiveLevelId(levelId);
    setSelection([]);
    setFitElementId(null);
    if (viewKind === 'plan') setViewLevelId(levelId);
  }

  function chooseTool(next: Tool) {
    if (!canEdit && next !== 'select') {
      setMessage('当前角色为查看者，无法使用绘制工具。');
      return;
    }
    clearModify();
    setTool(next);
    setDraftStart(null);
    if (next === 'primitive' && !primitiveKind) setPrimitiveKind('extrude');
    if (next !== 'select' && next !== 'primitive') setSelection([]);
  }

  function startPrimitive(kind: PrimitiveKind) {
    if (!canEdit) {
      setMessage('当前角色为查看者，无法创建体量');
      return;
    }
    clearModify();
    setPrimitiveKind(kind);
    setTool('primitive');
    setDraftStart(null);
    setRibbonTab('architecture');
    setMessage(`${PRIMITIVE_LABELS[kind]}：视口单击确定${kind === 'extrude' ? '轮廓第一角' : '中心'}，再单击确定${kind === 'extrude' ? '对角' : '半径'}，Esc 退出`);
  }

  function addPrimitive(start: Vec2, end: Vec2) {
    const kind = primitiveKind ?? 'extrude';
    const levelId = activeLevelId || project.levels[0]?.id;
    if (!levelId) return;
    const radius = Math.max(0.2, Math.hypot(end[0] - start[0], end[1] - start[1]));
    // 拉伸体用两点作轮廓对角，其余基本体第一点即中心、第二点定半径
    const center: Vec2 = kind === 'extrude'
      ? [(start[0] + end[0]) / 2, (start[1] + end[1]) / 2]
      : [start[0], start[1]];
    let spec: PrimitiveSpec | undefined;
    if (kind === 'extrude') {
      const halfX = Math.abs(end[0] - start[0]) / 2;
      const halfY = Math.abs(end[1] - start[1]) / 2;
      if (halfX < 0.05 || halfY < 0.05) {
        setMessage('拉伸体轮廓太小，请拉开一点');
        return;
      }
      spec = { kind: 'extrude', profile: [[-halfX, -halfY], [halfX, -halfY], [halfX, halfY], [-halfX, halfY]], height: 2 };
    }
    const element = createPrimitiveElement({
      project: projectRef.current,
      kind,
      position: center,
      levelId,
      spec: spec ?? defaultPrimitive(kind, radius, 2),
    });
    commit((document) => ({ ...document, elements: [...document.elements, element] }), `已创建 ${element.name}`);
    setSelection([element.id]);
    setTool('select');
    setDraftStart(null);
    setMessage(`${element.name} 已创建；可在属性面板修改尺寸，或用「修改」命令编辑`);
  }

  function topLevelFor(baseLevelId: string): { topLevelId: string; topOffset: number } {
    const base = levelById(project, baseLevelId);
    if (!base) return { topLevelId: baseLevelId, topOffset: 3 };
    const above = project.levels
      .filter((level) => level.elevation > base.elevation)
      .sort((a, b) => a.elevation - b.elevation)[0];
    return above ? { topLevelId: above.id, topOffset: 0 } : { topLevelId: base.id, topOffset: 3 };
  }

  function addWall(start: Vec2, end: Vec2) {
    const length = Math.hypot(end[0] - start[0], end[1] - start[1]);
    if (length < 0.1) {
      setMessage('墙长度小于 0.1 m，已忽略。');
      return;
    }
    const type = project.types.find((item) => item.category === 'wall');
    const levelId = activeLevelId || project.levels[0]?.id;
    if (!type || !levelId) return;
    const top = topLevelFor(levelId);
    const wall: WallInstance = {
      id: createId(),
      name: nextElementName(project, 'wall'),
      category: 'wall',
      typeId: type.id,
      levelId,
      visible: true,
      start,
      end,
      baseOffset: 0,
      topLevelId: top.topLevelId,
      topOffset: top.topOffset,
    };
    commit((document) => ({ ...document, elements: [...document.elements, wall] }), `已创建 ${wall.name}（${length.toFixed(2)} m）`);
    setSelection([wall.id]);
  }

  function addColumn(position: Vec2) {
    const type = project.types.find((item) => item.category === 'column');
    const levelId = activeLevelId || project.levels[0]?.id;
    if (!type || !levelId) return;
    const top = topLevelFor(levelId);
    const column: ColumnInstance = {
      id: createId(),
      name: nextElementName(project, 'column'),
      category: 'column',
      typeId: type.id,
      levelId,
      visible: true,
      position,
      rotation: 0,
      baseOffset: 0,
      topLevelId: top.topLevelId,
      topOffset: top.topOffset,
    };
    commit((document) => ({ ...document, elements: [...document.elements, column] }), `已创建 ${column.name}`);
    setSelection([column.id]);
  }

  function addSlab(start: Vec2, end: Vec2) {
    const width = Math.abs(end[0] - start[0]);
    const depth = Math.abs(end[1] - start[1]);
    if (width < 0.2 || depth < 0.2) {
      setMessage('楼板轮廓小于 0.2 m，已忽略。');
      return;
    }
    const type = project.types.find((item) => item.category === 'slab');
    const levelId = activeLevelId || project.levels[0]?.id;
    if (!type || !levelId) return;
    const minX = Math.min(start[0], end[0]);
    const maxX = Math.max(start[0], end[0]);
    const minY = Math.min(start[1], end[1]);
    const maxY = Math.max(start[1], end[1]);
    const slab: SlabInstance = {
      id: createId(),
      name: nextElementName(project, 'slab'),
      category: 'slab',
      typeId: type.id,
      levelId,
      visible: true,
      points: [[minX, minY], [maxX, minY], [maxX, maxY], [minX, maxY]],
      baseOffset: 0,
    };
    commit((document) => ({ ...document, elements: [...document.elements, slab] }), `已创建 ${slab.name}（${(width * depth).toFixed(1)} m²）`);
    setSelection([slab.id]);
  }

  function addGrid(start: Vec2, end: Vec2) {
    if (Math.hypot(end[0] - start[0], end[1] - start[1]) < 0.2) {
      setMessage('轴网太短，已忽略。');
      return;
    }
    const grid = { id: createId(), name: nextElementName(project, 'grid'), start, end };
    commit((document) => ({ ...document, grids: [...document.grids, grid] }), `已创建轴网 ${grid.name}`);
  }

  function deleteGrid(id: string) {
    commit((document) => ({ ...document, grids: document.grids.filter((grid) => grid.id !== id) }), '已删除轴网');
  }

  function handlePickPoint(point: Vec2) {
    if (tool === 'column') {
      addColumn(point);
      return;
    }
    if (tool === 'select') return;
    if (!draftStart) {
      setDraftStart(point);
      setMessage(`已确定第一点 (${point[0].toFixed(2)}, ${point[1].toFixed(2)})，再点击确定第二点（Esc 取消）`);
      return;
    }
    if (tool === 'wall') addWall(draftStart, point);
    else if (tool === 'slab') addSlab(draftStart, point);
    else if (tool === 'grid') addGrid(draftStart, point);
    else if (tool === 'primitive') addPrimitive(draftStart, point);
    setDraftStart(null);
  }

  function runBoolean(operation: 'union' | 'subtract' | 'intersect') {
    if (!canEdit) {
      setMessage('当前角色为查看者，无法执行布尔运算。');
      return;
    }
    if (selection.length !== 2) {
      setMessage('请先选择 2 个构件（Shift 加选）。');
      return;
    }
    const [first, second] = selection.map((id) => project.elements.find((element) => element.id === id));
    if (!first || !second) return;
    try {
      const result = booleanElement(project, first, second, operation);
      commit(
        (document) => ({
          ...document,
          elements: [
            ...document.elements.filter((element) => element.id !== first.id && element.id !== second.id),
            result,
          ],
        }),
        `已生成 ${result.name}`,
      );
      setSelection([result.id]);
      setFitElementId(result.id);
    } catch (error) {
      console.error('布尔运算失败。', error);
      setMessage(error instanceof Error ? `布尔运算失败：${error.message}` : '布尔运算失败。');
    }
  }

  function exportDocument() {
    if (!project.elements.length) {
      setMessage('当前项目没有可导出的构件。');
      return;
    }
    downloadFile(`${project.name || 'model'}.obj`, exportObj(project), 'text/plain');
    setMessage('已导出 OBJ（Z-up → Y-up）。');
  }

  function exportIfcDocument() {
    if (!project.elements.length) {
      setMessage('当前项目没有可导出的构件。');
      return;
    }
    try {
      downloadFile(`${project.name || 'model'}.ifc`, exportIfc(project), 'application/x-step');
      setMessage('已导出 IFC4（标高 / 构件类别 / 三角面几何），可在 Revit、BlenderBIM 等软件打开。');
    } catch (error) {
      setMessage(error instanceof Error ? `IFC 导出失败：${error.message}` : 'IFC 导出失败');
    }
  }

  function handleModifyOptions(patch: Partial<ModifyOptions>) {
    updateModifyOptions(patch);
  }

  function handleModifyNumeric(value: number | null) {
    updateModify((session) => ({ ...session, numeric: value }));
  }

  function handleModifyCenter() {
    updateModify((session) => ({ ...session, centerPending: true, note: '单击视口放置旋转中心' }));
  }

  /**
   * 从模型库放置一个造型构件：落到当前标高，避开已有构件；
   * 带参数的模型（支架）落完直接打开特征树，宽 / 高当场能调。
   */
  function placeLibraryTemplate(templateId: string) {
    const template = SOLID_TEMPLATES.find((item) => item.id === templateId);
    if (!template) return;
    if (!canEdit) {
      setMessage('当前角色为查看者，无法新增构件。');
      return;
    }
    const levelId = activeLevelId || projectRef.current.levels[0]?.id;
    if (!levelId) return;
    const features = template.build();
    const parametric: ParametricModel | undefined = template.parametric
      ? { template: template.parametric.template, params: { ...template.parametric.params } }
      : undefined;
    // 落点让位：原点 6 m 内已有造型构件时沿 +X 排开，免得新模型直接叠在旧模型身上
    const occupied = projectRef.current.elements
      .filter((element): element is MeshInstance => element.category === 'mesh')
      .map((element) => element.offset ?? [0, 0, 0]);
    let x = 0;
    while (occupied.some((offset) => Math.hypot(offset[0] - x, offset[1]) < 6)) x += 7;
    const element: MeshInstance = {
      id: createId(),
      name: template.name,
      category: 'mesh',
      levelId,
      typeId: '',
      visible: true,
      positions: [],
      indices: [],
      color: '#a3adb8',
      source: `模型库：${template.name}`,
      offset: [x, 0, 0],
      rotation: 0,
      primitive: { kind: 'solid', features },
      ...(parametric ? { parametric } : {}),
    };
    commit(
      (document) => ({ ...document, elements: [...document.elements, element] }),
      `已放置「${template.name}」`,
    );
    setSelection([element.id]);
    setFitElementId(element.id);
    if (parametric) {
      setSolidEdit({
        id: element.id,
        name: element.name,
        features,
        position: [x, 0],
        rotation: 0,
        parametric,
      });
    }
  }

  async function importStepFile(file: File, report: (stage: string, percent: number | null) => void) {
    // 优先走服务端 OCCT：能取回装配实例上的面颜色（浏览器端 occt-import-js 会丢失）
    if (mode === 'server') {
      try {
        report('上传 STEP 到服务端', 5);
        const serverMesh = await fetchServerStepMesh(file, {
          onProgress: ({ phase, loaded, total }) => {
            if (phase === 'upload') {
              report('上传 STEP 到服务端', total > 0 ? 5 + (loaded / total) * 40 : null);
            } else if (phase === 'convert') {
              report('服务端 OCCT 转换（大模型需数分钟）', null);
            } else {
              report('下载网格数据', total > 0 ? 45 + (loaded / total) * 45 : null);
            }
          },
        });
        if (serverMesh) {
          report('构建构件', 95);
          const geometry = new BufferGeometry();
          geometry.setAttribute('position', new Float32BufferAttribute(serverMesh.positions, 3));
          geometry.setAttribute('color', new Float32BufferAttribute(serverMesh.colors, 3));
          try {
            const element = meshElementFromGeometry(geometry, {
              name: file.name.replace(/\.(step|stp)$/i, '') || 'STEP 模型',
              color: '#ffffff',
              levelId: activeLevelId || project.levels[0]!.id,
              source: 'STEP 导入（服务端 OCCT，面颜色）',
            });
            commit((document) => ({ ...document, elements: [...document.elements, element] }), `已导入 ${file.name}`);
            setSelection([element.id]);
            setFitElementId(element.id);
            setMessage(
              `已导入 ${file.name}：服务端 OCCT 解析，`
              + `${serverMesh.stats.coloredFaces.toLocaleString()}/${serverMesh.stats.faces.toLocaleString()} 个面带色，`
              + `${serverMesh.vertexCount.toLocaleString()} 顶点 / ${serverMesh.triangleCount.toLocaleString()} 三角面`,
            );
          } finally {
            geometry.dispose();
          }
          return;
        }
      } catch (error) {
        console.warn('服务端 STEP 转换失败，回退浏览器解析。', error);
        setMessage(`服务端转换失败，改用浏览器解析：${error instanceof Error ? error.message : '未知错误'}`);
      }
    }

    report('读取 STEP 文件', 5);
    const stepBuffer = (await readFileWithProgress(file, 'buffer', (ratio) => {
      report('读取 STEP 文件', 5 + ratio * 25);
    })) as ArrayBuffer;
    report('加载 STEP 内核', null);
    const importer = await loadStepImporter();
    report('解析 STEP', null);
    const result = importer.ReadStepFile(new Uint8Array(stepBuffer), {
      linearUnit: 'meter',
      linearDeflectionType: 'bounding_box_ratio',
      linearDeflection: 0.001,
      angularDeflection: 0.5,
    });
    if (!result.success) throw new Error('STEP 文件无法解析或不包含有效实体。');

    const meshGeometries: Array<{ geometry: BufferGeometry; mesh: (typeof result.meshes)[number] }> = [];
    for (const [index, mesh] of result.meshes.entries()) {
      const positions = mesh.attributes?.position?.array;
      const indices = mesh.index?.array;
      if (!positions?.length || !indices?.length) continue;
      const geometry = new BufferGeometry();
      geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
      geometry.setIndex(indices);
      geometry.name = mesh.name || `构件 ${index + 1}`;
      meshGeometries.push({ geometry, mesh });
    }
    if (!meshGeometries.length) throw new Error('STEP 文件中没有可读取的三角网格。');

    report('合并网格', 85);
    const hasImportedColors = meshGeometries.some(({ mesh }) =>
      Boolean(mesh.color?.length || mesh.brep_faces?.some((face) => face.color?.length)),
    );
    let missingColorTriangles = 0;
    const geometries = meshGeometries.map(({ geometry, mesh }) => {
      const triangleCount = Math.floor((geometry.index?.count ?? 0) / 3);
      if (mesh.color?.length !== 3) {
        const coloredRanges = (mesh.brep_faces ?? [])
          .filter((face) => face.color?.length === 3)
          .map((face) => [Math.max(0, face.first), Math.min(triangleCount - 1, face.last)] as const)
          .filter(([first, last]) => first <= last)
          .sort(([a], [b]) => a - b);
        let next = 0;
        for (const [first, last] of coloredRanges) {
          if (first > next) missingColorTriangles += first - next;
          next = Math.max(next, last + 1);
        }
        missingColorTriangles += Math.max(0, triangleCount - next);
      }
      if (!hasImportedColors) return geometry;
      const nonIndexed = geometry.toNonIndexed();
      geometry.dispose();
      const positions = nonIndexed.getAttribute('position');
      const colors = new Float32Array(positions.count * 3);
      const defaultColor = mesh.color?.length === 3 ? mesh.color : [0.78, 0.79, 0.82];
      for (let vertex = 0; vertex < positions.count; vertex += 1) colors.set(defaultColor, vertex * 3);
      for (const face of mesh.brep_faces ?? []) {
        if (!face.color || face.color.length !== 3) continue;
        const firstVertex = Math.max(0, face.first) * 3;
        const lastVertex = Math.min(Math.floor(positions.count / 3) - 1, face.last) * 3 + 2;
        for (let vertex = firstVertex; vertex <= lastVertex; vertex += 1) colors.set(face.color, vertex * 3);
      }
      nonIndexed.setAttribute('color', new Float32BufferAttribute(colors, 3));
      return nonIndexed;
    });
    const merged = mergeGeometries(geometries, false);
    geometries.forEach((geometry) => geometry.dispose());
    if (!merged) throw new Error('无法合并 STEP 网格。');
    try {
      const element = meshElementFromGeometry(merged, {
        name: file.name.replace(/\.(step|stp)$/i, '') || 'STEP 模型',
        color: hasImportedColors ? '#ffffff' : '#a3adb8',
        levelId: activeLevelId || project.levels[0]!.id,
        source: 'STEP 导入',
      });
      commit((document) => ({ ...document, elements: [...document.elements, element] }), `已导入 ${file.name}`);
      setSelection([element.id]);
      setFitElementId(element.id);
      if (missingColorTriangles) {
        setMessage(`已导入 ${file.name}；导入器未返回 ${missingColorTriangles.toLocaleString('zh-CN')} 个三角面的颜色（见 diagnostics/FINDINGS.md）。`);
      }
    } finally {
      merged.dispose();
    }
  }

  /**
   * 解析一个文件并进入「导入确认」。
   * STEP 仍走 OCCT（能力更强，能取回装配面颜色）；其余格式走统一的 import 管线。
   */
  async function importModel(file: File, resources?: Map<string, string>) {
    if (!canEdit) {
      setMessage('当前角色为查看者，无法导入模型。');
      return;
    }
    const isStep = /\.(step|stp)$/i.test(file.name);
    setIsImporting(true);
    const report = (stage: string, percent: number | null) => {
      setImportProgress({
        stage,
        percent: percent === null ? null : Math.max(0, Math.min(100, percent)),
      });
    };
    report('准备导入', 2);
    try {
      if (isStep) {
        setMessage('正在解析 STEP 文件…');
        await importStepFile(file, report);
      } else {
        setMessage(`正在解析 ${file.name}…`);
        report('读取文件', 5);
        const buffer = (await readFileWithProgress(file, 'buffer', (ratio) => {
          report('读取文件', 5 + ratio * 45);
        })) as ArrayBuffer;
        report('解析模型', null);
        const model = await parseModelBuffer(file.name, buffer, resources);
        setMessage(model.blocked ? '这份文件无法直接读出几何。' : '解析完成，请确认轴向与单位。');
        setImportPending({ fileName: file.name, model });
      }
      report('完成', 100);
      window.setTimeout(() => {
        setImportProgress((current) => (current?.percent === 100 ? null : current));
      }, 700);
    } catch (error) {
      console.error('模型导入失败。', error);
      setImportProgress(null);
      setMessage(error instanceof Error ? `导入失败：${error.message}` : '模型导入失败。');
    } finally {
      setIsImporting(false);
    }
  }

  function cancelImport() {
    const pending = importPending;
    if (pending) disposeParts(pending.model.parts);
    setImportPending(null);
    setMessage(importQueueRef.current.length ? '已跳过这个模型，继续下一个…' : '已取消导入');
    continueImportQueue();
  }

  function confirmImport(transform: ImportTransform) {
    const pending = importPending;
    if (!pending) return;
    const levelId = activeLevelId || projectRef.current.levels[0]?.id;
    if (!levelId) {
      setMessage('当前项目没有标高，无法放置导入模型。');
      return;
    }
    try {
      const geometry = buildImportGeometry(pending.model, transform);
      try {
        const element = meshElementFromGeometry(geometry, {
          name: pending.fileName.replace(/\.[^.]+$/, '') || '导入模型',
          color: '#ffffff',
          levelId,
          source: `${pending.model.formatLabel} 导入`,
        });
        commit(
          (document) => ({ ...document, elements: [...document.elements, element] }),
          `已导入 ${pending.fileName}`,
        );
        setSelection([element.id]);
        setFitElementId(element.id);
        setMessage(
          `已导入 ${pending.fileName}：${pending.model.parts.length.toLocaleString('zh-CN')} 个构件 / `
          + `${countImportTriangles(pending.model).toLocaleString('zh-CN')} 三角面`,
        );
      } finally {
        geometry.dispose();
      }
    } catch (error) {
      console.error('导入写入项目失败。', error);
      setMessage(error instanceof Error ? `导入失败：${error.message}` : '导入失败。');
    } finally {
      disposeParts(pending.model.parts);
      setImportPending(null);
      continueImportQueue();
    }
  }

  /**
   * 拖入 / 多选多个文件：
   * - 模型文件（含 STEP）按顺序排队，每个都走一次「解析 → 确认」；
   * - 其余文件（.bin / 贴图 / .mtl）作为当前模型的附属资源，通过 blob URL 提供给 loader。
   */
  async function importFiles(files: File[]) {
    const usable = files.filter((file) => file.size > 0);
    if (!usable.length) return;
    const isModel = (file: File) => Boolean(formatForFile(file.name)) || /\.(step|stp)$/i.test(file.name);
    const models = usable.filter(isModel);
    const sidecars = usable.filter((file) => !isModel(file));
    const primary = models.length ? models : usable.slice(0, 1);
    if (!models.length) sidecars.length = 0;

    const resources = new Map<string, string>();
    for (const file of sidecars) resources.set(file.name, URL.createObjectURL(file));
    if (resources.size) {
      // 贴图是异步加载的，晚点再回收 blob URL
      window.setTimeout(() => resources.forEach((url) => URL.revokeObjectURL(url)), 30000);
    }

    importQueueRef.current = primary.slice(1).map((file) => ({ file, resources: resources.size ? resources : undefined }));
    if (primary.length > 1) {
      setMessage(`共 ${primary.length} 个模型，将依次导入。`);
    }
    await importModel(primary[0]!, resources.size ? resources : undefined);
  }

  /** 队列里还有模型就接着解析下一个。 */
  function continueImportQueue() {
    const next = importQueueRef.current.shift();
    if (!next) return;
    void importModel(next.file, next.resources);
  }

  function handleDragEnter(event: ReactDragEvent) {
    if (!event.dataTransfer.types.includes('Files')) return;
    dragDepthRef.current += 1;
    setDragActive(true);
  }

  function handleDragLeave(event: ReactDragEvent) {
    if (!event.dataTransfer.types.includes('Files')) return;
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
    if (dragDepthRef.current === 0) setDragActive(false);
  }

  function handleDragOver(event: ReactDragEvent) {
    if (!event.dataTransfer.types.includes('Files')) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
  }

  function handleDrop(event: ReactDragEvent) {
    if (!event.dataTransfer.types.includes('Files')) return;
    event.preventDefault();
    dragDepthRef.current = 0;
    setDragActive(false);
    void importFiles(Array.from(event.dataTransfer.files));
  }

  async function openProject(id: string) {
    if (!repository || id === projectRef.current.id) return;
    const raw = await repository.load(id);
    if (!raw) {
      setMessage('项目不存在或无权访问。');
      return;
    }
    const loaded = normalizeExternal(raw);
    setProject(loaded);
    projectRef.current = loaded;
    lastSavedRef.current = loaded;
    lastLocalRevRef.current = null;
    setActiveLevelId(loaded.levels[0]?.id ?? '');
    setSelectedLevelId(null);
    setSelection([]);
    resetHistory();
    setViewKind('3d');
    setViewLevelId(null);
    setTool('select');
    setDraftStart(null);
    setFitElementId(null);
    setConflictRev(null);
    setSaveState('saved');
    await repository.saveLastOpenedId(loaded.id);
    setMessage(`已打开项目「${loaded.name}」`);
  }

  async function createNewProject() {
    if (!repository) return;
    const name = window.prompt('新项目名称', '未命名项目')?.trim();
    if (!name) return;
    const created = createProject({ name });
    await repository.save(created);
    setSummaries(await repository.list());
    await openProject(created.id);
    setMessage(`已创建项目「${name}」`);
  }

  function renameProject() {
    const name = window.prompt('项目名称', project.name)?.trim();
    if (!name || name === project.name) return;
    commit((document) => ({ ...document, name }), `项目已重命名为「${name}」`);
  }

  /** 重命名任意项目：当前项目走 commit（可撤销），其它项目直接读写服务端文档 */
  async function renameProjectById(id: string, name: string) {
    const trimmed = name.trim();
    if (!trimmed) return;
    if (id === projectRef.current.id) {
      commit((document) => ({ ...document, name: trimmed }), `项目已重命名为「${trimmed}」`);
      return;
    }
    if (!repository) return;
    try {
      const raw = await repository.load(id);
      if (!raw) {
        setMessage('项目不存在或无权访问。');
        return;
      }
      await repository.save({ ...raw, name: trimmed });
      setSummaries(await repository.list());
      setMessage(`项目已重命名为「${trimmed}」`);
    } catch (error) {
      setMessage(error instanceof ApiError ? error.message : '重命名失败');
    }
  }

  /** 删除任意项目（当前项目删除后自动切到下一个） */
  async function deleteProjectById(id: string) {
    if (!repository) return;
    const target = summaries.find((item) => item.id === id);
    const label = target?.name ?? project.name;
    if (!window.confirm(`删除项目「${label}」？该操作不可恢复。`)) return;
    try {
      await repository.remove(id);
      const list = await repository.list();
      setSummaries(list);
      if (id === projectRef.current.id) {
        if (list[0]) {
          await openProject(list[0].id);
        } else {
          const created = createProject({ name: '未命名项目' });
          await repository.save(created);
          setProject(created);
          projectRef.current = created;
          lastSavedRef.current = created;
          setSummaries(await repository.list());
        }
      }
      setMessage(`已删除项目「${label}」`);
    } catch (error) {
      setMessage(error instanceof ApiError ? error.message : '删除项目失败');
    }
  }

  async function deleteCurrentProject() {
    if (!repository || !isAdmin) return;
    await deleteProjectById(project.id);
  }

  async function reloadFromServer() {
    if (!repository) return;
    const raw = await repository.load(project.id);
    if (!raw) return;
    const loaded = normalizeExternal(raw);
    setProject(loaded);
    projectRef.current = loaded;
    lastSavedRef.current = loaded;
    lastLocalRevRef.current = null;
    setConflictRev(null);
    setSaveState('saved');
    setSelection([]);
    resetHistory();
    setMessage('已加载服务端最新文档');
  }

  async function overwriteServer() {
    if (!repository) return;
    try {
      await repository.save(project, { force: true });
      lastSavedRef.current = project;
      setConflictRev(null);
      setSaveState('saved');
      setSummaries(await repository.list());
      setMessage('已覆盖服务端文档');
    } catch (error) {
      setMessage(error instanceof Error ? `覆盖失败：${error.message}` : '覆盖失败');
    }
  }

  /** Ctrl/Cmd+S：立即保存；协作在线时补丁已实时落库，只提示状态。 */
  async function saveNow() {
    if (!repository) return;
    if (collabRef.current?.online) {
      setMessage('协作会话已实时同步，无需手动保存');
      return;
    }
    if (projectRef.current === lastSavedRef.current) {
      setMessage('所有修改已保存');
      return;
    }
    setSaveState('saving');
    try {
      const document = projectRef.current;
      await repository.save(document);
      lastSavedRef.current = document;
      setSaveState('saved');
      setConflictRev(null);
      setSummaries(await repository.list());
      setMessage('已保存');
    } catch (error) {
      if (error instanceof ConflictError) {
        setConflictRev(error.rev);
        setSaveState('dirty');
        setMessage('服务端文档已被其他会话修改，请选择加载最新或覆盖保存。');
        return;
      }
      setSaveState('dirty');
      setMessage(error instanceof Error ? `保存失败：${error.message}` : '保存失败');
    }
  }

  function selectAllElements() {
    const ids = projectRef.current.elements.filter((element) => element.visible).map((element) => element.id);
    setSelectedLevelId(null);
    setSelection(ids);
    syncAwaitSelection(ids);
    setMessage(`已选择全部 ${ids.length} 个可见构件`);
  }

  function cutSelection() {
    if (!canEdit || !selectedElements.length) return;
    copySelection();
    deleteSelection();
  }

  function renameSelectedElement() {
    const target = projectRef.current.elements.find((element) => element.id === selection[0]);
    if (!target || !canEdit) {
      setMessage('请先选择一个构件');
      return;
    }
    const name = window.prompt('重命名构件', target.name)?.trim();
    if (!name || name === target.name) return;
    patchElement(target.id, { name });
  }

  function hideSelection() {
    if (!canEdit || !selection.length) {
      setMessage('请先选择要隐藏的构件');
      return;
    }
    const ids = new Set(selection);
    commit(
      (document) => ({
        ...document,
        elements: document.elements.map((element) => (ids.has(element.id) ? { ...element, visible: false } : element)),
      }),
      `已隐藏 ${selection.length} 个构件（HR 恢复显示）`,
    );
  }

  function showAllElements() {
    if (!canEdit) return;
    const hidden = projectRef.current.elements.filter((element) => !element.visible);
    if (!hidden.length) {
      setMessage('所有构件都已显示');
      return;
    }
    commit(
      (document) => ({
        ...document,
        elements: document.elements.map((element) => (element.visible ? element : { ...element, visible: true })),
      }),
      `已恢复显示 ${hidden.length} 个构件`,
    );
  }

  function zoomToFitAll() {
    setFitElementId(null);
    setZoomAllRequest((request) => request + 1);
  }

  function zoomToFitSelection() {
    if (selection.length === 1) {
      setFitElementId(selection[0]!);
      return;
    }
    if (!selection.length) {
      setMessage('未选择构件：已缩放至全部');
      zoomToFitAll();
      return;
    }
    setMessage('多选时暂按“缩放至全部”处理，可单独选中一个构件再缩放');
    zoomToFitAll();
  }

  function logout() {
    setAuthToken(null);
    setUser(null);
    setSummaries([]);
    setSelection([]);
    resetHistory();
    setHydrated(false);
    lastSavedRef.current = null;
    lastLocalRevRef.current = null;
  }

  const toolHint = modify?.status === 'active'
    ? `${MODIFY_LABELS[modify.command]}：${modifyPrompt(modify)} · Esc 逐级退出 · Enter 完成`
    : viewSettings.mouseScheme === 'revit'
      ? (tool === 'select'
        ? '左键点选 / 拖拽旋转 · 空白轻点两下框选 · Ctrl+拖拽复制 · 中键平移 · 滚轮缩放'
        : `视口取点绘制${TOOL_LABELS[tool]} · 左上角可输入坐标 · 中键平移 · 滚轮缩放 · Esc 退出`)
      : (tool === 'select'
        ? '左键拖拽旋转 · 单击空白开始框选 · 再次单击完成 · 中键平移 · 右键菜单'
        : `左键放置${TOOL_LABELS[tool]} · 左上角可输入坐标 · 左键拖拽旋转 · 中键平移 · Esc 退出`);

  if (mode === 'server' && authReady && !user) {
    return (
      <AuthGate
        onAuthenticated={(nextUser) => {
          setBootstrapError('');
          setUser(nextUser);
        }}
        notice={bootstrapError || undefined}
      />
    );
  }

  const accountPageOpen = Boolean(accountOpen && accountUser);

  return (
    <>
    <main
      className={`app-shell${accountPageOpen ? ' app-shell-hidden' : ''}`}
      aria-hidden={accountPageOpen ? true : undefined}
      onDragEnter={handleDragEnter}
      onDragLeave={handleDragLeave}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
    >
      <header className="topbar">
        <div className="brand-lockup">
          <div className="brand-mark">S</div>
          <div>
            <div className="brand-name">STRU<span>BROWSER</span></div>
            <div className="brand-caption">Web BIM 工作台 · 建筑</div>
          </div>
        </div>

        <div className="document-actions">
          <button className="top-action" onClick={() => void createNewProject()}><span>＋</span> 新建项目</button>
          <label className="top-action open-action">
            <span>▣</span> 打开
            <select
              aria-label="打开项目"
              value={project.id}
              onChange={(event) => void openProject(event.target.value)}
            >
              {summaries.length === 0 ? <option value={project.id}>{project.name}</option> : null}
              {summaries.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}{item.role ? ` · ${item.role === 'viewer' ? '只读' : item.role === 'editor' ? '可编辑' : '管理员'}` : ''}
                </option>
              ))}
            </select>
          </label>
          <button className="top-action" onClick={renameProject} disabled={!canEdit}><span>✎</span> 重命名</button>

          <div className="history-actions">
            <button className="icon-action" title="撤销 (Ctrl/Cmd+Z)" onClick={undo} disabled={!canEdit || !history.past.length}>↶</button>
            <button className="icon-action" title="重做 (Shift+Ctrl/Cmd+Z)" onClick={redo} disabled={!canEdit || !history.future.length}>↷</button>
            <button
              className="icon-action"
              title="软件设置（账户中心 → 软件设置）"
              onClick={() => {
                setAccountSection('preferences');
                setAccountOpen(true);
              }}
            >⚙</button>
            <button
              className={`icon-action ${aiOpen ? 'active' : ''}`}
              title="AI 建模助手（服务端模式）"
              onClick={() => {
                if (mode !== 'server') {
                  setMessage('AI 助手需要服务端模式：用 ./start.sh 启动完整前后端');
                  return;
                }
                setAiOpen((open) => !open);
              }}
            >✦</button>
            <button
              className={`icon-action ${isFullscreen ? 'active' : ''}`}
              title={isFullscreen ? '退出全屏' : '全屏（保留菜单）'}
              onClick={() => void toggleFullscreen()}
            >{isFullscreen ? '⤡' : '⤢'}</button>
          </div>

          <div className="save-state">
            <i className={conflictRev !== null ? 'conflict-dot' : ''} />
            {conflictRev !== null ? '冲突' : saveState === 'saving' ? '保存中…' : saveState === 'dirty' ? '未保存' : '已保存'}
            {mode === 'server' && currentSummary?.rev !== undefined ? ` · rev ${currentSummary.rev}` : ''}
          </div>
        </div>

        <div className="account-chip">
          {collabUsers.length ? (
            <div className="presence-stack" title={`在线：${collabUsers.map((member) => member.name).join('、')}`}>
              {collabUsers.slice(0, 4).map((member, index) => (
                <span key={member.id} className={`presence-avatar tone-${index % 5}`}>
                  {member.name.slice(0, 1)}
                </span>
              ))}
              {collabUsers.length > 4 ? <span className="presence-more">+{collabUsers.length - 4}</span> : null}
            </div>
          ) : null}
          <span className={`mode-badge mode-${mode ?? 'pending'}`}>
            {mode === 'server' ? '服务端' : mode === 'local' ? '本地' : '连接中'}
          </span>
          {user ? (
            <button
              className={`account-trigger ${accountOpen ? 'active' : ''}`}
              onClick={() => {
                setAccountSection('profile');
                setAccountOpen(true);
              }}
              title={`账户中心 · ${user.email}${user.isAdmin ? ' · 系统管理员' : ''}`}
            >
              <span className={`account-trigger-avatar ${user.isAdmin ? 'admin' : ''}`}>
                {(user.name || user.email).slice(0, 1).toUpperCase()}
              </span>
              <span className="chip-name">{user.name}</span>
              {user.isAdmin ? <em className="chip-admin">超管</em> : null}
              <i className="chip-caret" aria-hidden>▾</i>
            </button>
          ) : (
            <button
              className={`account-trigger ${accountOpen ? 'active' : ''}`}
              onClick={() => {
                setAccountSection('preferences');
                setAccountOpen(true);
              }}
              title="本地模式：查看本机项目与软件设置"
            >
              <span className="account-trigger-avatar">本</span>
              <span className="chip-name">本地工作区</span>
              <i className="chip-caret" aria-hidden>▾</i>
            </button>
          )}
        </div>
      </header>

      {apiReachable === false ? (
        <div className="connection-bar">
          <span>⚠ 与服务端的连接已断开：API 可能未启动或进程已退出。</span>
          <div className="connection-actions">
            <button onClick={() => void checkApi()}>重新连接</button>
            <code>./start.sh restart</code>
          </div>
        </div>
      ) : null}

      {conflictRev !== null ? (
        <div className="conflict-bar">
          <span>⚠ 服务端文档已被其他会话修改（rev {conflictRev}）。</span>
          <div className="conflict-actions">
            <button onClick={() => void reloadFromServer()}>加载最新</button>
            <button className="danger" onClick={() => void overwriteServer()}>覆盖保存</button>
          </div>
        </div>
      ) : null}

      <Ribbon
        tab={ribbonTab}
        onTabChange={setRibbonTab}
        tool={tool}
        onTool={chooseTool}
        onBoolean={startBoolean}
        onModify={startModifyCommand}
        onPrimitive={startPrimitive}
        onCopyToClipboard={copySelection}
        onPaste={pasteSelection}
        activeModify={modify?.command ?? null}
        primitiveKind={primitiveKind}
        viewKind={viewKind}
        onViewKind={(kind) => {
          if (kind === 'plan') activatePlan(selectedLevelId ?? activeLevelId);
          else activate3d();
        }}
        projection={projection}
        onProjection={setProjection}
        onZoomAll={() => {
          setFitElementId(null);
          setZoomAllRequest((request) => request + 1);
        }}
        isImporting={isImporting}
        onImport={(files) => void importFiles(files)}
        onExport={exportDocument}
        onExportIfc={exportIfcDocument}
        onOpenSchedule={() => setScheduleOpen(true)}
        onOpenLayers={() => setLayersOpen(true)}
        onOpenMaterials={() => setMaterialsOpen(true)}
        onOpenParameters={() => setParametersOpen(true)}
        onOpenLibrary={() => setLibraryOpen(true)}
        onNewProject={() => void createNewProject()}
        serverMode={mode === 'server'}
        readOnly={!canEdit}
        onOpenVersions={() => setVersionsOpen(true)}
        onOpenMembers={() => setMembersOpen(true)}
        onDeleteProject={() => void deleteCurrentProject()}
        onOpenSettings={() => {
          setAccountSection('preferences');
          setAccountOpen(true);
        }}
        isAdmin={Boolean(user?.isAdmin)}
        onOpenAdmin={() => {
          setAccountSection('system');
          setAccountOpen(true);
        }}
      />

      {modify ? (
        <ModifyOptionsBar
          session={modify}
          canFinish={modify.status === 'await-selection' ? selection.length > 0 : isReady(modify, cursorRef.current)}
          onOptions={handleModifyOptions}
          onNumeric={handleModifyNumeric}
          onCenter={handleModifyCenter}
          onFinish={finishModifyCommand}
          onCancel={() => { clearModify(); setMessage('已取消命令'); }}
        />
      ) : null}

      <section className={`workspace${aiDockWidth ? ' ai-docked' : ''}`} style={aiDockWidth ? { paddingRight: aiDockWidth } : undefined}>
        {browserOpen ? (
        <ProjectBrowser
          width={browserWidth}
          onCollapse={() => setBrowserOpen(false)}
          project={project}
          activeLevelId={activeLevelId}
          viewKind={viewKind}
          viewLevelId={viewLevelId}
          selection={selection}
          selectedLevelId={selectedLevelId}
          onActivate3d={activate3d}
          onActivatePlan={activatePlan}
          onSelectLevel={selectLevel}
          onAddLevel={addLevel}
          onSelectElement={selectElement}
          onToggleVisibility={toggleVisibility}
          onDeleteGrid={deleteGrid}
          onRenameProject={renameProject}
          onOpenLayers={() => setLayersOpen(true)}
          onOpenMaterials={() => setMaterialsOpen(true)}
          onToggleLayer={(id) => {
            const layer = projectRef.current.layers?.find((item) => item.id === id);
            if (!layer) return;
            commit(
              (document) => ({
                ...document,
                layers: (document.layers ?? []).map((item) => (
                  item.id === id ? { ...item, visible: !item.visible } : item
                )),
              }),
              `图层「${layer.name}」已${layer.visible ? '隐藏' : '显示'}`,
            );
          }}
        />
        ) : (
          <button className="panel-rail panel-rail-left" onClick={() => setBrowserOpen(true)} title="展开项目浏览器 (PB)">
            <span className="rail-icon">▤</span>
            <em>项目浏览器</em>
          </button>
        )}

        {browserOpen ? (
          <PanelResizer side="left" width={browserWidth} defaultWidth={250} min={200} max={460} onResize={setBrowserWidth} />
        ) : null}

        <section className="viewport-column">
          <div className="viewport-toolbar">
            <div className="view-title">
              <span className="view-cube">{viewKind === 'plan' ? '▦' : '◈'}</span>
              <strong>{viewKind === 'plan' ? `${activeLevel?.name ?? '标高'} 平面` : '三维视图'}</strong>
              <span className="view-tag">
                {viewKind === 'plan' ? '比例 1:100' : projection === 'parallel' ? '平行投影' : '透视投影'}
              </span>
            </div>
            <div className="view-tools"><span className="tool-hint">{toolHint}</span></div>
            <button
              className="zoom-all-button"
              onClick={() => {
                setFitElementId(null);
                setZoomAllRequest((request) => request + 1);
              }}
              title="缩放至全部构件 (ZF)"
            ><span>⊞</span>缩放至全部</button>
          </div>

          <ModelViewport
            project={project}
            selection={selection}
            activeLevelId={activeLevelId}
            viewKind={viewKind}
            projection={projection}
            tool={tool}
            draftStart={draftStart}
            primitiveKind={primitiveKind}
            settings={viewSettings}
            modify={modify}
            onRendererInfo={setRendererInfo}
            onSelect={selectElement}
            onBoxSelect={boxSelect}
            onContextAction={handleContextAction}
            onHover={(point) => {
              setHoverPoint(point);
              cursorRef.current = point ? [point.x, point.y] as Vec2 : null;
            }}
            onPickPoint={handlePickPoint}
            onModifyClick={handleModifyClick}
            onDragMove={dragMoveSelection}
            fitElementId={fitElementId}
            zoomAllRequest={zoomAllRequest}
            onClickEmpty={() => {
              setSelection([]);
              setSelectedLevelId(null);
              syncAwaitSelection([]);
            }}
            onViewportApi={(api) => {
              viewportRef.current = api;
            }}
          />

          {tool !== 'select' && !modify ? (
            <DrawCoordinateBar
              key={`${tool}-${draftStart ? 'second' : 'first'}`}
              tool={tool}
              draftStart={draftStart}
              cursor={hoverPoint ? [hoverPoint.x, hoverPoint.y] as Vec2 : null}
              levelLabel={`${activeLevel?.name ?? '工作平面'} ${(activeLevel?.elevation ?? 0).toFixed(2)} m`}
              onPick={handlePickPoint}
              onCancel={escape}
            />
          ) : null}

          {modify?.status === 'await-selection' ? (
            <div className="command-hint">
              <strong>{MODIFY_LABELS[modify.command]}</strong>
              <span>请先在视口中选择构件（Shift 加选），选好后按 Enter 继续</span>
              <button className="primary" onClick={finishModifyCommand} disabled={!selection.length}>继续</button>
              <button onClick={() => { clearModify(); setMessage('已取消命令'); }}>取消</button>
            </div>
          ) : null}

          {importProgress ? (
            <div className={`import-progress ${importProgress.percent === null ? 'indeterminate' : ''}`}>
              <div className="import-progress-head">
                <span>{importProgress.stage}</span>
                <b>{importProgress.percent === null ? '处理中…' : `${Math.round(importProgress.percent)}%`}</b>
              </div>
              <div className="import-progress-track">
                <div
                  className="import-progress-bar"
                  style={importProgress.percent === null ? undefined : { width: `${importProgress.percent}%` }}
                />
              </div>
            </div>
          ) : null}

          <label className="view-corner view-mode-control">
            <span className="live-dot" />
            <select
              aria-label="投影方式"
              value={projection}
              onChange={(event) => setProjection(event.target.value === 'parallel' ? 'parallel' : 'perspective')}
            >
              <option value="perspective">透视投影</option>
              <option value="parallel">平行投影</option>
            </select>
            <span className="corner-chevron">⌄</span>
          </label>

          <div className="viewport-toolbar-bottom">
            <span>工作平面：{activeLevel?.name ?? '—'}（{activeLevel ? activeLevel.elevation.toFixed(2) : '0.00'} m）</span>
            <span>单位：米</span>
            {viewKind === 'plan' ? <span className="plan-badge">平面视图 · 旋转已锁定</span> : (
              <span>{viewSettings.mouseScheme === 'revit' ? 'Revit 鼠标方案：左键拖拽旋转 / 轻点两下框选' : '框选：单击 → 移动 → 单击'}</span>
            )}
            {modify ? <span className="modify-badge">{MODIFY_LABELS[modify.command]} · {modify.status === 'await-selection' ? '待选择' : `已取 ${modify.points.length} 点`}</span> : null}
            {draftStart ? <span className="draft-badge">已取第一点 · 再点击确定终点</span> : null}
            {!canEdit ? <span className="readonly-badge">只读</span> : null}
          </div>
        </section>

        {propertiesOpen ? (
          <PanelResizer side="right" width={propertiesWidth} defaultWidth={275} min={220} max={560} onResize={setPropertiesWidth} />
        ) : null}

        {propertiesOpen ? (
        <PropertiesPanel
          width={propertiesWidth}
          onCollapse={() => setPropertiesOpen(false)}
          project={project}
          selection={selectedElements}
          selectedLevel={selectedElements.length ? null : selectedLevel}
          onElementPatch={patchElement}
          onTypePatch={patchType}
          onTypeFormula={patchTypeFormula}
          onElementFormula={patchElementFormula}
          onLevelPatch={patchLevel}
          onDeleteSelection={deleteSelection}
          onBoolean={runBoolean}
          onEditSolid={(element) => {
            if (element.category !== 'mesh') return;
            // 参数化构件也有特征树（快照），两种都能打开编辑器
            if (element.primitive?.kind !== 'solid' && !element.parametric) return;
            const offset = element.offset ?? [0, 0, 0];
            setSolidEdit({
              id: element.id,
              name: element.name,
              // 参数化构件按当前参数重建特征树，对话框里看到的就是视口里的样子
              features: solidFeaturesOf(element),
              position: [offset[0] ?? 0, offset[1] ?? 0],
              rotation: ((element.rotation ?? 0) * 180) / Math.PI,
              parametric: element.parametric ?? null,
            });
          }}
          readOnly={!canEdit}
        />
        ) : (
          <button className="panel-rail panel-rail-right" onClick={() => setPropertiesOpen(true)} title="展开属性面板 (PP)">
            <span className="rail-icon">▥</span>
            <em>属性</em>
          </button>
        )}
      </section>

      <footer className="statusbar">
        <div className="status-left">
          <span className="status-ready"><i />{saveState === 'saving' ? '正在保存' : conflictRev !== null ? '存在冲突' : '就绪'}</span>
          <span className="status-divider" />
          <span>{mode === 'server' ? '服务端项目' : '本地项目'}</span>
          <span className="status-divider" />
          <span>{viewKind === 'plan' ? `${activeLevel?.name ?? ''} 平面` : '三维视图'}</span>
          <span className="status-divider" />
          <span>{role === 'viewer' ? '查看者（只读）' : role === 'editor' ? '编辑者' : role === 'admin' ? '管理者' : '本地用户'}</span>
          <span className="status-divider" />
          <span className={`collab-state ${mode === 'server' ? collabStatus : 'offline'}`}>
            {mode === 'local'
              ? '本地模式'
              : collabStatus === 'online'
                ? `协同在线 · ${collabUsers.length} 人`
                : collabStatus === 'connecting'
                  ? '协同连接中…'
                  : collabStatus === 'error'
                    ? '协同异常'
                    : '协同离线'}
          </span>
          {latencyMs !== null ? (
            <>
              <span className="status-divider" />
              <span className={`latency ${latencyMs > 300 ? 'warn' : ''}`}>延迟 {latencyMs} ms</span>
            </>
          ) : null}
          {selection.length ? <><span className="status-divider" /><span>已选 {selection.length}</span></> : null}
        </div>
        <div className="status-right">
          {viewSettings.showCoordinates ? (
            <>
              <span className="coordinate-label">光标坐标</span>
              {hoverPoint
                ? <span className="coordinate-value">X <b>{hoverPoint.x.toFixed(2)}</b>　Y <b>{hoverPoint.y.toFixed(2)}</b>　Z <b>{hoverPoint.z.toFixed(2)}</b> m</span>
                : <span className="coordinate-value coordinate-placeholder">—　—　—</span>}
            </>
          ) : null}
          {viewSettings.showStats ? (
            <>
              <span className="status-divider" />
              <span>构件 <b>{project.elements.length}</b></span>
              <span className="status-divider" />
              <span className="triangle-icon">△</span><span>三角面 <b>{triangles.toLocaleString()}</b></span>
            </>
          ) : null}
        </div>
      </footer>

      {scheduleOpen ? (
        <ScheduleDialog
          project={project}
          onClose={() => setScheduleOpen(false)}
          onToast={(text) => setMessage(text)}
        />
      ) : null}

      {importPending ? (
        <ImportDialog
          fileName={importPending.fileName}
          model={importPending.model}
          onCancel={cancelImport}
          onConfirm={confirmImport}
        />
      ) : null}

      {layersOpen ? (
        <LayersDialog
          project={project}
          selection={selection}
          currentLayerId={currentLayerId}
          readOnly={!canEdit}
          onUpdate={commit}
          onCurrentLayer={(id) => setCurrentLayerId(id)}
          onClose={() => setLayersOpen(false)}
          onToast={(text) => setMessage(text)}
        />
      ) : null}

      {materialsOpen ? (
        <MaterialsDialog
          project={project}
          selection={selection}
          readOnly={!canEdit}
          onUpdate={commit}
          onClose={() => setMaterialsOpen(false)}
          onToast={(text) => setMessage(text)}
        />
      ) : null}

      {parametersOpen ? (
        <ParametersDialog
          project={project}
          selection={selection}
          readOnly={!canEdit}
          onUpdate={commit}
          onClose={() => setParametersOpen(false)}
          onToast={(text) => setMessage(text)}
        />
      ) : null}

      {aiOpen && mode === 'server' ? (
        <AiPanel
          projectId={project.id}
          projectName={project.name}
          canEdit={canEdit}
          selectedIds={selection}
          onClose={() => setAiOpen(false)}
          currentDocument={project}
          viewport={aiViewport}
          onDockChange={setAiDockWidth}
          onApplied={(document, rev, previous) => {
            pushHistory(previous);
            lastLocalRevRef.current = rev;
            repository?.adoptRevision?.(project.id, rev);
            const normalized = normalizeExternal(document);
            setProject(normalized);
            projectRef.current = normalized;
            lastSavedRef.current = normalized;
            setSaveState('saved');
            void repository?.list().then(setSummaries);
            // AI 常生成 1 m 以内的小零件，默认视角下几乎看不见：应用后自动缩放至全部
            setZoomAllRequest((value) => value + 1);
            setMessage(`AI 已应用修改（rev ${rev}），可用 Ctrl/Cmd+Z 撤销`);
          }}
        />
      ) : null}

      {versionsOpen && mode === 'server' ? (
        <VersionsDialog
          projectId={project.id}
          projectName={project.name}
          canWrite={canEdit}
          onClose={() => setVersionsOpen(false)}
          onRestored={() => { void reloadFromServer(); }}
        />
      ) : null}

      {libraryOpen ? (
        <LibraryDialog
          readOnly={!canEdit}
          onPlace={placeLibraryTemplate}
          onClose={() => setLibraryOpen(false)}
        />
      ) : null}

      {solidEdit ? (
        <SolidDialog
          name={solidEdit.name}
          features={solidEdit.features}
          position={solidEdit.position}
          rotation={solidEdit.rotation}
          parametric={solidEdit.parametric ?? null}
          readOnly={!canEdit}
          onToast={(text) => setMessage(text)}
          onClose={() => setSolidEdit(null)}
          onApply={(payload) => {
            const current = projectRef.current.elements.find((item) => item.id === solidEdit.id);
            const z = current && current.category === 'mesh' && Array.isArray(current.offset)
              ? current.offset[2] ?? 0
              : 0;
            patchElement(solidEdit.id, {
              name: payload.name,
              offset: [payload.position[0], payload.position[1], z],
              rotation: (payload.rotation * Math.PI) / 180,
              primitive: { kind: 'solid', features: payload.features },
              // 传 null 显式断开参数化（patchElement 按字段覆盖，undefined 不会清掉旧值）
              parametric: payload.parametric ?? null,
            });
            setSolidEdit(null);
            setMessage(payload.parametric
              ? `已更新「${payload.name}」的参数（${Object.entries(payload.parametric.params).map(([key, value]) => `${key}=${value}`).join(' ')}）`
              : `已更新「${payload.name}」的特征树（Ctrl/Cmd+Z 可撤销）`);
          }}
        />
      ) : null}

      {membersOpen && mode === 'server' ? (
        <MembersDialog
          projectId={project.id}
          currentUserId={user?.id ?? ''}
          isAdmin={isAdmin}
          onClose={() => setMembersOpen(false)}
        />
      ) : null}
    </main>

    {dragActive ? (
      <div className="drop-overlay" aria-hidden>
        <div className="drop-card">
          <b>松开即可导入</b>
          <span>{IMPORT_FORMATS.map((format) => format.label).join(' · ')} · STEP</span>
          <em>若 .gltf 引用了 .bin 或贴图，请与主文件一起拖入</em>
        </div>
      </div>
    ) : null}

    {/* 账户中心是独立整页：打开时工作台不渲染（状态保留），关闭即回到原场景 */}
    {accountOpen && accountUser ? (
      <AccountCenter
        user={accountUser}
        mode={mode}
        localMode={mode === 'local'}
        initialSection={accountSection}
        summaries={summaries}
        currentProjectId={project.id}
        settings={viewSettings}
        diagnostics={{
          renderer: rendererInfo?.renderer,
          software: rendererInfo?.software,
          elements: project.elements.length,
          triangles,
        }}
        onSettingsChange={setViewSettings}
        onClose={() => setAccountOpen(false)}
        onLogout={logout}
        onToast={(text) => setMessage(text)}
        onUserUpdated={(nextUser) => setUser(nextUser)}
        onOpenProject={async (id) => {
          await openProject(id);
          setAccountOpen(false);
        }}
        onCreateProject={async () => {
          await createNewProject();
          setAccountOpen(false);
        }}
        onRenameProject={renameProjectById}
        onDeleteProject={deleteProjectById}
        onRefreshProjects={async () => {
          if (repository) setSummaries(await repository.list());
        }}
      />
    ) : null}

    {message && <div className="toast-message" role="status">{message}</div>}
    </>
  );
}
